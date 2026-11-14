import { parseEnvText } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { envLine, readEnv, setEnv, unsetEnv } from "./env";

/** What the panel itself reads from the text, the later line winning. */
const panelReads = (text: string) => new Map(parseEnvText(text).map(({ key, value }) => [key, value]));

describe("a value set from the command line", () => {
  it.each([
    "plain",
    "two words",
    " leading and trailing ",
    "a=b=c",
    '"wrapped in quotes"',
    '  "padded quotes"  ',
    'one " quote',
    "#not-a-comment",
    "",
    "$(PROJECT_NAME)",
  ])("comes back exactly from the panel's own parser: %j", (value) => {
    const text = setEnv("", new Map([["NAME", value]]));

    expect(panelReads(text).get("NAME")).toBe(value);
    expect(readEnv(text).get("NAME")).toBe(value);
  });

  it("only gets quotes of its own when it would lose them", () => {
    expect(envLine("A", "x y")).toBe("A=x y");
    expect(envLine("A", '"x"')).toBe('A=""x""');
  });
});

describe("editing a set of variables", () => {
  const before = ["# database", "DB_HOST=db", "", "DB_PORT=5432", "MODE=a", "MODE=b", ""].join("\n");

  it("keeps comments, blank lines and the order, and replaces a name in place", () => {
    const after = setEnv(before, new Map([["DB_PORT", "6543"]]));

    expect(after).toBe(["# database", "DB_HOST=db", "", "DB_PORT=6543", "MODE=a", "MODE=b", ""].join("\n"));
  });

  it("adds a new name at the end, after the last variable", () => {
    const after = setEnv("A=1\n\n\n", new Map([["B", "2"]]));

    expect(after).toBe("A=1\nB=2\n");
  });

  it("leaves one definition of a name it sets, where the first one was", () => {
    const after = setEnv(before, new Map([["MODE", "c"]]));

    expect(after).toContain("DB_PORT=5432\nMODE=c\n");
    expect(after.match(/^MODE=/gm)).toHaveLength(1);
    expect(panelReads(after).get("MODE")).toBe("c");
  });

  it("reads a duplicated name the way the panel does: the later line wins", () => {
    expect(readEnv(before).get("MODE")).toBe(panelReads(before).get("MODE"));
  });

  it("removes every definition of a name, and says which names were there", () => {
    const { text, removed } = unsetEnv(before, new Set(["MODE", "MISSING"]));

    expect(text).toBe(["# database", "DB_HOST=db", "", "DB_PORT=5432", ""].join("\n"));
    expect([...removed]).toEqual(["MODE"]);
  });

  it("is empty once the last variable is gone", () => {
    expect(unsetEnv("A=1\n", new Set(["A"])).text).toBe("");
  });

  it("starts from nothing", () => {
    expect(setEnv("", new Map([["A", "1"]]))).toBe("A=1\n");
    expect(readEnv("").size).toBe(0);
  });
});
