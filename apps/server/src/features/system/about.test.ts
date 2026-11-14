import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemAbout } from "@opsifier/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

const opened: TestContext[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const context of opened.splice(0)) {
    await context.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function panel(env: Record<string, string> = {}) {
  const context = await createTestContext({ env });
  opened.push(context);
  const cookie = await setupAdmin(context.app);
  return { context, cookie };
}

const about = (context: TestContext, cookie?: string) =>
  call<SystemAbout>(context.app, "/api/v1/system/about", { cookie, origin: TEST_ORIGIN });

describe("the About page's facts", () => {
  it("names the license and the source, and lists what the image says it ships", async () => {
    const notices = mkdtempSync(join(tmpdir(), "opsifier-notices-"));
    dirs.push(notices);
    writeFileSync(
      join(notices, "components.json"),
      JSON.stringify([
        {
          name: "restic",
          version: "0.19.1",
          license: "BSD-2-Clause",
          url: "https://restic.net",
          kind: "program",
        },
        { name: "hono", version: "4.9.0", license: "MIT", url: "https://hono.dev", kind: "package" },
      ]),
    );
    const { context, cookie } = await panel({ OPSIFIER_NOTICES_DIR: notices });

    const answer = await about(context, cookie);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      license: "Apache-2.0",
      copyright: "Copyright 2026 Opsifier contributors",
      sourceUrl: "https://github.com/voidagency/opsifier",
      licenseUrl: "https://github.com/voidagency/opsifier/blob/main/LICENSE",
      noticesFile: join(notices, "THIRD-PARTY-NOTICES.txt"),
    });
    expect(answer.body.components.map((component) => component.name)).toEqual(["restic", "hono"]);
  });

  it("says when it runs outside the image, where there is no list", async () => {
    const empty = mkdtempSync(join(tmpdir(), "opsifier-notices-"));
    dirs.push(empty);
    const { context, cookie } = await panel({ OPSIFIER_NOTICES_DIR: empty });

    const answer = await about(context, cookie);
    expect(answer.body.noticesFile).toBeNull();
    expect(answer.body.components).toEqual([]);
    expect(answer.body.version).not.toBe("");
  });

  it("is for every signed-in account, and nobody else", async () => {
    const { context, cookie } = await panel();
    const member = await signInMember(context.app, cookie, "ada@example.com", []);

    expect((await about(context, member)).status).toBe(200);
    expect((await about(context)).status).toBe(401);
  });
});
