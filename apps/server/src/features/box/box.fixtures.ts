import type { BoxModuleId, SaveBoxModulesRequest, SaveBoxProcessesRequest } from "@opsifier/contract";

/** One box per declared module: what it installs, and a process that runs on nothing but that module. */
export interface BoxModuleFixture {
  module: BoxModuleId;
  modules: SaveBoxModulesRequest;
  processes: SaveBoxProcessesRequest["processes"];
  /** A file that only something this module installed could have written. */
  proofFile: string;
  /** What a proof file holds once the module's own process has run. */
  proofContent: string;
}

export const boxModuleFixtures: Record<BoxModuleId, BoxModuleFixture> = {
  node: {
    module: "node",
    modules: { node: { version: "24", extensions: ["pnpm"] } },
    processes: [
      {
        name: "web",
        command:
          "node -e \"require('fs').writeFileSync('node-proof', process.version.split('.')[0]); setInterval(() => {}, 1000)\"",
      },
    ],
    proofFile: "node-proof",
    proofContent: "v24",
  },
  php: {
    module: "php",
    modules: { php: { version: "8.4", extensions: ["gd", "opcache"] } },
    processes: [
      {
        name: "web",
        command:
          "php -r \"file_put_contents('php-proof', PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION); sleep(3600);\"",
      },
    ],
    proofFile: "php-proof",
    proofContent: "8.4",
  },
  python: {
    module: "python",
    modules: { python: { version: "3.14" } },
    processes: [
      {
        name: "web",
        command:
          "python3 -c \"import sys, time; open('python-proof', 'w').write('{}.{}'.format(*sys.version_info[:2])); time.sleep(3600)\"",
      },
    ],
    proofFile: "python-proof",
    proofContent: "3.14",
  },
  ruby: {
    module: "ruby",
    modules: { ruby: { version: "3.4" } },
    processes: [
      {
        name: "web",
        command: "ruby -e \"File.write('ruby-proof', RUBY_VERSION[0, 3]); sleep\"",
      },
    ],
    proofFile: "ruby-proof",
    proofContent: "3.4",
  },
  nginx: {
    module: "nginx",
    modules: { nginx: { documentRoot: "public" } },
    processes: [
      {
        name: "web",
        command:
          "while ! curl -fsS -o nginx-proof http://127.0.0.1:$PORT/hello.txt; do sleep 1; done; exec sleep 3600",
      },
    ],
    proofFile: "nginx-proof",
    proofContent: "served by nginx\n",
  },
};
