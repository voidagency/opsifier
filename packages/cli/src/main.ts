import { runCli } from "./cli";

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
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
  readStdin: () => readAll(process.stdin),
});
