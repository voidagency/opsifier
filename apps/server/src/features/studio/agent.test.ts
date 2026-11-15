import { describe, expect, it } from "vitest";
import { readAnswer } from "./agent";

const lines = (answer: unknown, size: number) => {
  const encoded = Buffer.from(JSON.stringify(answer)).toString("base64");
  return (encoded.match(new RegExp(`.{1,${size}}`, "g")) ?? []).map((piece) => `opsifier-studio ${piece}`);
};

describe("readAnswer", () => {
  it("puts back together an answer longer than a line of Docker's output, whatever else is printed", () => {
    const answer = { keyFound: true, answers: [{ status: 200, text: "x".repeat(200_000) }] };

    const output = ["a warning on stdout", ...lines(answer, 30_000), "opsifier-ok"].join("\n");

    expect(readAnswer(output)).toEqual({ keyFound: true, replies: answer.answers });
  });

  it("gives nothing for an answer that never came, or came broken", () => {
    expect(readAnswer("Traceback (most recent call last):\nopsifier-ok")).toBeNull();
    expect(readAnswer("opsifier-studio not-base64-json")).toBeNull();
  });
});
