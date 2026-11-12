import { describe, expect, it } from "vitest";
import { parseAddresses } from "./addresses";

describe("a pasted list of addresses", () => {
  it("reads one per line, or separated by commas, semicolons or spaces", () => {
    expect(
      parseAddresses("ann@example.com\nbob@example.com, carol@example.com;dan@example.com  eve@example.com"),
    ).toEqual({
      emails: [
        "ann@example.com",
        "bob@example.com",
        "carol@example.com",
        "dan@example.com",
        "eve@example.com",
      ],
      invalid: [],
      repeated: 0,
    });
  });

  it("takes the address from what a mail client copies, and ignores blank lines", () => {
    const pasted =
      '"Ann Example" <Ann@Example.com>, Bob <bob@example.com>\n\n  mailto:carol@example.com \r\n';
    expect(parseAddresses(pasted).emails).toEqual([
      "ann@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
  });

  it("keeps repeats for the server to report, and counts them", () => {
    expect(parseAddresses("ann@example.com ANN@example.com bob@example.com ann@example.com")).toEqual({
      emails: ["ann@example.com", "ann@example.com", "bob@example.com", "ann@example.com"],
      invalid: [],
      repeated: 2,
    });
  });

  it("names what is not an address", () => {
    expect(parseAddresses("ann@example.com, bob@example, carol.example.com")).toEqual({
      emails: ["ann@example.com"],
      invalid: ["bob@example", "carol.example.com"],
      repeated: 0,
    });
    expect(parseAddresses("  \n , ")).toEqual({ emails: [], invalid: [], repeated: 0 });
  });
});
