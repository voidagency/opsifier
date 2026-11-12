import { accountEmail } from "@opsifier/contract";

/** What a pasted list of addresses holds. */
export interface PastedAddresses {
  /** Every address in the order given, in lower case. Repeats stay: the server reports them as such. */
  emails: string[];
  /** Pieces that are not an address, as they were typed. */
  invalid: string[];
  /** How many of `emails` repeat an earlier one. */
  repeated: number;
}

/**
 * Reads addresses one per line, or separated by commas, semicolons or spaces, and also in the
 * `Name <address>` form a mail client copies, where the name is left aside.
 */
export function parseAddresses(text: string): PastedAddresses {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const entry of text.split(/[\n\r,;]+/)) {
    const bracketed = /<([^<>]*)>\s*$/.exec(entry);
    const pieces = bracketed === null ? entry.split(/\s+/) : [bracketed[1] ?? ""];
    for (const piece of pieces) {
      const candidate = piece
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .replace(/^mailto:/i, "");
      if (candidate === "") {
        continue;
      }
      if (accountEmail.safeParse(candidate).success) {
        emails.push(candidate.toLowerCase());
      } else {
        invalid.push(candidate);
      }
    }
  }
  return { emails, invalid, repeated: emails.length - new Set(emails).size };
}
