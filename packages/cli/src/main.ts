import { ClientError } from "@opsifier/client";
import { runCli } from "./cli";

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

/**
 * Asks for a secret at a terminal without echoing it, keys pasted included. Anywhere else, the first line
 * of standard input: `opsifier login https://panel.example.com < key.txt`.
 */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return (await readAll(input)).split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error === undefined) {
        resolve(value);
      } else {
        reject(error);
      }
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return;
        }
        if (char === "\u0003") {
          finish(new ClientError("cancelled", "Interrupted."));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const abort = new AbortController();
let interrupted = false;
// The first Ctrl-C lets a command stop cleanly; a second one ends it at once.
process.on("SIGINT", () => {
  if (interrupted) {
    process.exit(130);
  }
  interrupted = true;
  abort.abort();
});
process.on("SIGTERM", () => abort.abort());
// The reader went away, as with `| head`. Nothing is left to say to it.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stdout.isTTY === true,
  signal: abort.signal,
  cwd: process.cwd(),
  readStdin: () => readAll(process.stdin),
  readSecret,
});
