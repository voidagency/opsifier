import { describe, expect, it } from "vitest";
import { encodeQr } from "./qr";

function finderAt(matrix: boolean[][], left: number, top: number): boolean {
  const expected = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  return expected.every((row, y) => row.every((bit, x) => matrix[top + y]?.[left + x] === (bit === 1)));
}

describe("encodeQr", () => {
  it("draws a square symbol with the three finder patterns", () => {
    const matrix = encodeQr("otpauth://totp/Opsifier:user%40example.test?secret=JBSWY3DP&issuer=Opsifier");

    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect((matrix.length - 17) % 4).toBe(0);
    expect(finderAt(matrix, 0, 0)).toBe(true);
    expect(finderAt(matrix, matrix.length - 7, 0)).toBe(true);
    expect(finderAt(matrix, 0, matrix.length - 7)).toBe(true);
  });

  it("grows the symbol with the amount of data", () => {
    expect(encodeQr("short").length).toBe(21);
    expect(encodeQr("x".repeat(200)).length).toBeGreaterThan(21);
  });

  it("refuses data that cannot fit", () => {
    expect(() => encodeQr("x".repeat(5000))).toThrow(RangeError);
  });
});
