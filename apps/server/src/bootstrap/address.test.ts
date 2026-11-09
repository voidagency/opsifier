import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DatabaseHandle, openDatabase } from "../core/db";
import { createSecrets } from "../core/secrets";
import { ADDRESS_SECRET_CONTEXT, readAddress, saveAddress } from "../features/opsifier-address/repo";
import { getSetting, putSetting } from "../features/system/repo";
import { createSetupAddress } from "./address";

const ID = "bcdfghjk";
const SECRET = "s".repeat(43);
const DOMAIN = `${ID}.opsifier.dev`;
const NAMES = "https://names.test";

let dataDir: string;
let log: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-setup-address-"));
  log = [];
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

function stubRegistration() {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: ID, secret: SECRET, domain: DOMAIN, ip: "93.184.216.34" }), {
        status: 201,
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ensure = (optedOut = false, namesUrl: string | null = NAMES) =>
  createSetupAddress(config(namesUrl)).ensure({ optedOut, log: (line) => log.push(line) });

function withDatabase<T>(work: (handle: DatabaseHandle) => T): T {
  const handle = openDatabase(join(dataDir, "opsifier.db"));
  try {
    return work(handle);
  } finally {
    handle.close();
  }
}

const stored = () => withDatabase(({ db }) => readAddress(db));

describe("registering during setup", () => {
  it("makes the database and the key on a fresh server, and seals the secret", async () => {
    stubRegistration();

    const result = await ensure();

    expect(result).toEqual({
      domain: DOMAIN,
      challenge: { namesUrl: NAMES, id: ID, secretFile: join(dataDir, "traefik", "opsifier-address.secret") },
    });
    const address = stored();
    expect(address).toMatchObject({ status: "registered", id: ID, domain: DOMAIN, health: "ok" });
    expect(JSON.stringify(address)).not.toContain(SECRET);
    const secrets = createSecrets(join(dataDir, "secret.key"), { allowCreate: false });
    if (address?.status === "registered") {
      expect(secrets.unseal(address.sealedSecret, ADDRESS_SECRET_CONTEXT)).toBe(SECRET);
    }
  });

  it("writes Traefik's secret file privately", async () => {
    stubRegistration();

    await ensure();

    const file = join(dataDir, "traefik", "opsifier-address.secret");
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("says what it did in one line, and that this is the only call home", async () => {
    stubRegistration();

    await ensure();

    expect(log).toHaveLength(1);
    expect(log[0]).toContain(DOMAIN);
    expect(log[0]).toContain("only call home");
    expect(log[0]).toContain("--no-opsifier-address");
    expect(log.join("\n")).not.toContain(SECRET);
  });

  it("keeps the address it already has, and doesn't ask the service again", async () => {
    stubRegistration();
    await ensure();
    const spy = stubRegistration();

    const again = await ensure();

    expect(spy).not.toHaveBeenCalled();
    expect(again?.domain).toBe(DOMAIN);
    expect(log.at(-1)).toContain("keeping");
    expect(readFileSync(join(dataDir, "traefik", "opsifier-address.secret"), "utf8")).toBe(SECRET);
  });

  it("does not migrate a database some other panel version owns", async () => {
    withDatabase(({ db }) => db.run("DELETE FROM __drizzle_migrations" as never));
    stubRegistration();

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

  it("falls back on any failure, and says so", async () => {
    for (const fail of [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 429 }),
      () => new Response("not json", { status: 201 }),
      () => new Response(JSON.stringify({ id: "x", domain: "x" }), { status: 201 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => fail()),
      );

      await expect(ensure()).resolves.toBeNull();
      expect(log.at(-1)).toContain("sslip.io");
      expect(readAddress(openDatabase(join(dataDir, "opsifier.db"), null).db)).toBeNull();
    }
  });

  it("keeps the failure's cause in the output, and not the secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );

    await ensure();

    expect(log[0]).toMatch(/could not register \(.*500.*\)/);
  });

  it("does not register when told not to, and remembers", async () => {
    const spy = stubRegistration();

    expect(await ensure(true)).toBeNull();

    expect(spy).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ status: "off" });
    expect(log[0]).toContain("--no-opsifier-address");
  });

  it("stays off after that, without the flag", async () => {
    await ensure(true);
    const spy = stubRegistration();

    expect(await ensure(false)).toBeNull();

    expect(spy).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ status: "off" });
  });

  it("stays off after a release", async () => {
    withDatabase(({ db }) => saveAddress(db, { status: "off", at: new Date().toISOString() }, new Date()));
    const spy = stubRegistration();

    expect(await ensure()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("never calls the service when OPSIFIER_NAMES_URL is off", async () => {
    const spy = stubRegistration();

    expect(await ensure(false, null)).toBeNull();

    expect(spy).not.toHaveBeenCalled();
    expect(log[0]).toContain("OPSIFIER_NAMES_URL");
    // Being off for now is not a decision about the address: a later run may still register.
    expect(stored()).toBeNull();
  });

  it("registers an existing panel that never had an address", async () => {
    withDatabase(({ db }) => putSetting(db, "unrelated", "kept", new Date()));
    stubRegistration();

    const result = await ensure();

    expect(result?.domain).toBe(DOMAIN);
    expect(withDatabase(({ db }) => getSetting(db, "unrelated"))).toBe("kept");
  });

  it("won't replace the key of a panel that already has users", async () => {
    withDatabase(({ db }) => {
      db.run(
        "INSERT INTO users (id, email, password_hash, role, is_owner, created_at, updated_at) VALUES ('u','a@b.example','x','admin',1,0,0)" as never,
      );
    });
    stubRegistration();

    await expect(ensure()).resolves.toBeNull();

    expect(existsSync(join(dataDir, "secret.key"))).toBe(false);
    expect(log[0]).toContain("sslip.io");
  });
});
