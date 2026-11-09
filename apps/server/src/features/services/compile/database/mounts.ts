import { join } from "node:path";
import { type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../../core/docker";
import type { MountFile } from "../mounts";
import { idLabel } from "../names";
import { MYSQL_CONFIG_PATH, supportsConfigFile } from "./engines";

type ContainerMount = NonNullable<SwarmServiceSpec["TaskTemplate"]["ContainerSpec"]["Mounts"]>[number];

export interface DatabaseMountsInput {
  engine: DatabaseEngine;
  volume: string;
  configFile: string;
  project: string;
  service: string;
  dataDir: string;
  /** The service's stable identifier, which outlives the name on the volume. */
  id?: string | null;
}

export interface CompiledDatabaseMounts {
  mounts: ContainerMount[];
  files: MountFile[];
}

/** A database must stay with its data, so its tasks only run on the node that holds the volume. */
export const DATA_NODE_CONSTRAINT = "node.role==manager";

export function compileDatabaseMounts(input: DatabaseMountsInput): CompiledDatabaseMounts {
  const { engine, volume, configFile, project, service, dataDir, id } = input;
  const mounts: ContainerMount[] = [
    {
      Type: "volume",
      Source: volume,
      Target: databaseEngineInfo[engine].dataPath,
      // Docker creates this volume itself when the first task starts, and labels it from here.
      VolumeOptions: {
        Labels: {
          "opsifier.project": project,
          "opsifier.service": service,
          "opsifier.type": engine,
          ...idLabel(id),
        },
      },
    },
  ];
  const files: MountFile[] = [];

  if (supportsConfigFile(engine) && configFile.trim() !== "") {
    const path = join(dataDir, "projects", project, service, "files", "opsifier.cnf");
    files.push({ path, content: configFile, mode: 0o644 });
    mounts.push({ Type: "bind", Source: path, Target: MYSQL_CONFIG_PATH, ReadOnly: true });
  }
  return { mounts, files };
}
