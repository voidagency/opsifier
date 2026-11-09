import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Certificate, CertificateState } from "@opsifier/contract";
import type { ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { conflict, notFound } from "../../core/errors";
import { enqueueProxyRestart } from "../server/proxy";

const EXPIRING_SOON_MS = 14 * 24 * 3600 * 1000;

interface StoredCertificate {
  domain?: { main?: string; sans?: string[] };
  certificate?: string;
  key?: string;
  Store?: string;
}

type AcmeFile = Record<string, { Certificates?: StoredCertificate[] | null } & Record<string, unknown>>;

const acmePath = (deps: AppDeps) => join(deps.config.dataDir, "traefik", "acme.json");

async function readAcme(deps: AppDeps): Promise<AcmeFile> {
  let text: string;
  try {
    text = await readFile(acmePath(deps), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as AcmeFile;
  } catch {
    deps.logger.warn("The proxy's certificate store is not valid JSON");
    return {};
  }
}

const idOf = (resolver: string, domain: string) =>
  createHash("sha256").update(`${resolver}\0${domain}`).digest("hex").slice(0, 32);

function stateOf(notAfter: Date | null, now: number): CertificateState {
  if (notAfter === null) {
    return "unreadable";
  }
  const left = notAfter.getTime() - now;
  if (left <= 0) {
    return "expired";
  }
  return left <= EXPIRING_SOON_MS ? "expiring" : "valid";
}

function describe(resolver: string, stored: StoredCertificate, now: number): Certificate {
  const domain = stored.domain?.main ?? "";
  let issuer: string | null = null;
  let notBefore: Date | null = null;
  let notAfter: Date | null = null;
  try {
    const pem = Buffer.from(stored.certificate ?? "", "base64");
    const certificate = new X509Certificate(pem);
    issuer =
      certificate.issuer
        .split("\n")
        .find((line) => line.startsWith("O=") || line.startsWith("CN="))
        ?.replace(/^(O|CN)=/, "") ?? null;
    notBefore = new Date(certificate.validFrom);
    notAfter = new Date(certificate.validTo);
  } catch {
    notAfter = null;
  }
  return {
    id: idOf(resolver, domain),
    domain,
    sans: stored.domain?.sans ?? [],
    resolver,
    issuer,
    notBefore: notBefore?.toISOString() ?? null,
    notAfter: notAfter?.toISOString() ?? null,
    state: stateOf(notAfter, now),
  };
}

/** What the proxy really holds, read from its own store. A saved TLS option proves nothing. */
export async function listCertificates(deps: AppDeps): Promise<Certificate[]> {
  const file = await readAcme(deps);
  const now = deps.now();
  const certificates: Certificate[] = [];
  for (const [resolver, content] of Object.entries(file)) {
    for (const stored of content.Certificates ?? []) {
      if (stored.domain?.main !== undefined) {
        certificates.push(describe(resolver, stored, now));
      }
    }
  }
  return certificates.sort((a, b) => a.domain.localeCompare(b.domain));
}

async function writeAcme(deps: AppDeps, file: AcmeFile): Promise<void> {
  const path = acmePath(deps);
  const temporary = join(dirname(path), `.acme.${randomBytes(6).toString("hex")}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  const handle = await openFile(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(file, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Traefik only reads its store when it starts, so taking a certificate out needs a restart. */
export async function deleteCertificate(
  deps: AppDeps,
  id: string,
  confirm: string,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const file = await readAcme(deps);
  for (const [resolver, content] of Object.entries(file)) {
    const certificates = content.Certificates ?? [];
    const index = certificates.findIndex((stored) => idOf(resolver, stored.domain?.main ?? "") === id);
    if (index === -1) {
      continue;
    }
    const domain = certificates[index]?.domain?.main ?? "";
    if (confirm !== domain) {
      throw conflict("confirmation_mismatch", "Type the certificate's exact domain to confirm.", {
        confirm: "Does not match the domain",
      });
    }
    certificates.splice(index, 1);
    await writeAcme(deps, file);
    deps.actions.record({
      type: "proxy.certificate",
      title: `Remove the certificate of ${domain}`,
      actorEmail,
    });
    return enqueueProxyRestart(deps, actorEmail, `removing the certificate of ${domain}`);
  }
  throw notFound("This certificate does not exist.");
}
