import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMigrationsFolder, openDatabase } from "./index";

interface Journal {
  entries: Array<{ tag: string }>;
}

let scratch: string;

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The checked-in migrations as a panel had them before the one named. */
function migrationsBefore(tag: string): string {
  const folder = join(scratch, "drizzle");
  cpSync(findMigrationsFolder(), folder, { recursive: true });
  const journalFile = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(index).toBeGreaterThan(0);
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
  return folder;
}

describe("upgrading the database", () => {
  it("signs everyone out when sessions gain their second secret", () => {
    scratch = mkdtempSync(join(tmpdir(), "opsifier-migrations-"));
    const file = join(scratch, "panel.db");

    const before = openDatabase(file, migrationsBefore("0025_session_binding"));
    before.db.$client
      .prepare(
        "INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES ('u1', 'ada@example.com', 'Ada', 'x', 'admin', 0, 0)",
      )
      .run();
    before.db.$client
      .prepare(
        "INSERT INTO sessions (id, token_hash, user_id, persistent, created_at, expires_at) VALUES ('s1', 'h', 'u1', 0, 0, 1)",
      )
      .run();
    before.close();

    const after = openDatabase(file);
    const left = after.db.$client.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
    const users = after.db.$client.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
    after.close();

    expect(left.n).toBe(0);
    expect(users.n).toBe(1);
  });
});
