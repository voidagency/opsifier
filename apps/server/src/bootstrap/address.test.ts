import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DatabaseHandle, openDatabase } from "../core/db";
import { createSecrets } from "../core/secrets";
import { ADDRESS_SECRET_CONTEXT, saveAddress } from "../features/opsifier-address/repo";
import { createSetupAddress } from "./address";

const ID = "bcdfghjk";
const SECRET = "s".repeat(43);
const DOMAIN = `${ID}.opsifier.dev`;
const NAMES = "https://names.test";

let dataDir: string;
let log: string[];
let spy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-setup-address-"));
  log = [];
  spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

const config = (namesUrl: string | null = NAMES) => ({
  namesUrl,
  dataDir,
  databaseFile: join(dataDir, "opsifier.db"),
  secretKeyFile: join(dataDir, "secret.key"),
});

const ensure = (namesUrl: string | null = NAMES) =>
  createSetupAddress(config(namesUrl)).ensure({ log: (line) => log.push(line) });

function withDatabase<T>(work: (handle: DatabaseHandle) => T): T {
  const handle = openDatabase(join(dataDir, "opsifier.db"));
  try {
    return work(handle);
  } finally {
    handle.close();
  }
}

function haveAddress() {
  const secrets = createSecrets(join(dataDir, "secret.key"), { allowCreate: true });
  withDatabase(({ db }) =>
    saveAddress(
      db,
      {
        status: "registered",
        id: ID,
        domain: DOMAIN,
        sealedSecret: secrets.seal(SECRET, ADDRESS_SECRET_CONTEXT),
        ip: "93.184.216.34",
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        health: "ok",
      },
      new Date(),
    ),
  );
}

describe("during setup", () => {
  it("never asks for an address, and says where to", async () => {
    await expect(ensure()).resolves.toBeNull();

    expect(spy).not.toHaveBeenCalled();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("sslip.io");
    expect(log[0]).toContain("Settings");
  });

  it("makes neither a database nor a key on a fresh server", async () => {
    await ensure();

    expect(existsSync(join(dataDir, "opsifier.db"))).toBe(false);
    expect(existsSync(join(dataDir, "secret.key"))).toBe(false);
  });

  it("keeps the address it already has, without calling the service", async () => {
    haveAddress();

    const result = await ensure();

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({
      domain: DOMAIN,
      challenge: { namesUrl: NAMES, id: ID, secretFile: join(dataDir, "traefik", "opsifier-address.secret") },
    });
    expect(log.at(-1)).toContain("keeping");
    expect(log.join("\n")).not.toContain(SECRET);
  });

  it("puts back Traefik's secret file, privately", async () => {
    haveAddress();

    await ensure();

    const file = join(dataDir, "traefik", "opsifier-address.secret");
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not migrate a database some other panel version owns", async () => {
    haveAddress();
    withDatabase(({ db }) => db.run("DELETE FROM __drizzle_migrations" as never));

    const result = await ensure();

    expect(result?.domain).toBe(DOMAIN);
    const handle = openDatabase(join(dataDir, "opsifier.db"), null);
    try {
      const rows = handle.db.all("SELECT COUNT(*) AS n FROM __drizzle_migrations" as never) as Array<{
        n: number;
      }>;
      expect(rows[0]?.n).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("settles for sslip.io when the stored address can't be used", async () => {
    haveAddress();
    rmSync(join(dataDir, "secret.key"));

    await expect(ensure()).resolves.toBeNull();

    expect(log.at(-1)).toContain("sslip.io");
  });

  it("does nothing with a request that is still waiting", async () => {
    withDatabase(({ db }) =>
      saveAddress(
        db,
        {
          status: "requested",
          id: ID,
          domain: DOMAIN,
          sealedSecret: "x",
          requestedAt: new Date().toISOString(),
        },
        new Date(),
      ),
    );

    await expect(ensure()).resolves.toBeNull();

    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves a released address released", async () => {
    withDatabase(({ db }) => saveAddress(db, { status: "off", at: new Date().toISOString() }, new Date()));

    await expect(ensure()).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("uses sslip.io when OPSIFIER_NAMES_URL is off, even with an address stored", async () => {
    haveAddress();

    await expect(ensure(null)).resolves.toBeNull();

    expect(spy).not.toHaveBeenCalled();
  });
});
