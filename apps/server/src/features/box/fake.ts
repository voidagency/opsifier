import type { AppDeps } from "../../core/context";
import { FakeDriver } from "../../core/docker";
import { findService } from "../services/repo";
import { BOX_CONTROL_PATH } from "./supervisor";

/**
 * `OPSIFIER_DRIVER=fake` has no container to run the supervisor in, so what it would answer is
 * answered here, from the box's saved processes. Tests and the local preview both see real rows.
 */
export function installBoxSimulation(deps: AppDeps): void {
  if (!(deps.docker instanceof FakeDriver)) {
    return;
  }
  const { docker } = deps;
  const startedAt = Math.floor(deps.now() / 1000);

  docker.execHandler = (options) => {
    const [program, verb] = options.command;
    if (program !== BOX_CONTROL_PATH) {
      return undefined;
    }
    // Project names have no underscore, so the first one is where the project name ends.
    const separator = options.service.indexOf("_");
    const box = findService(
      deps.db,
      options.service.slice(0, separator),
      options.service.slice(separator + 1),
    )?.spec.box;
    if (box === undefined || box === null) {
      return undefined;
    }
    if (verb === "restart") {
      return { output: "opsifier-ok\n", exitCode: 0 };
    }
    const running = box.processes.filter(({ enabled }) => enabled).map(({ name: process }) => process);
    const system = [
      ...(box.modules.nginx === null ? [] : ["nginx"]),
      ...(box.modules.nginx !== null && box.modules.php !== null ? ["php-fpm"] : []),
    ];
    const rows = [...system, ...running].map(
      (process, index) => `${process}\trunning\t${index + 100}\t0\t-\t${startedAt}`,
    );
    return { output: `${[...rows, "opsifier-ok"].join("\n")}\n`, exitCode: 0 };
  };
}
