import { createHash } from "node:crypto";
import { type CompanionTool, type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../../core/docker";
import { assertHostname } from "../../../../core/proxy";
import { qualifiedName, routedNetworks } from "../names";
import { type ConnectionTarget, connectionUrl } from "./connection";

export interface CompanionCompileInput {
  project: string;
  service: string;
  tool: CompanionTool;
  engine: DatabaseEngine;
  user: string;
  databaseName: string | null;
  password: string;
  rootPassword: string | null;
  /** The companion's own public hostname. */
  host: string;
  /** The sign-in the proxy asks for in front of the tool. */
  username: string;
  token: string;
}

/** What a database's web tool becomes: one Swarm service and one routing file, like any workload. */
export interface CompiledCompanion {
  /** `<service>-<tool>`, used as the routing file's name. */
  routeName: string;
  swarmSpec: SwarmServiceSpec;
  proxyConfig: { http: Record<string, unknown> };
}

interface CompanionDefinition {
  image: string;
  port: number;
  env(input: CompanionCompileInput & { connection: ConnectionTarget }): string[];
}

/** DbGate learns its connections from these variables. */
function dbgateEnv(input: CompanionCompileInput & { connection: ConnectionTarget }): string[] {
  const { engine, service, connection, user, password, databaseName } = input;
  const plugin = engine === "mariadb" ? "mysql" : engine;
  return [
    "CONNECTIONS=db",
    `LABEL_db=${service}`,
    `SERVER_db=${connection.host}`,
    `PORT_db=${connection.port}`,
    ...(engine === "redis" ? [] : [`USER_db=${user}`]),
    `PASSWORD_db=${password}`,
    ...(databaseName === null ? [] : [`DATABASE_db=${databaseName}`]),
    ...(engine === "mongo" ? [`URL_db=${connectionUrl(connection, password)}`] : []),
    `ENGINE_db=${engine}@dbgate-plugin-${plugin}`,
  ];
}

const companions: Record<CompanionTool, CompanionDefinition> = {
  pgweb: {
    image: "sosedoff/pgweb:0.16.2",
    port: 8081,
    env: ({ connection, password }) => [`PGWEB_DATABASE_URL=${connectionUrl(connection, password)}`],
  },
  dbgate: { image: "dbgate/dbgate:6-alpine", port: 3000, env: dbgateEnv },
  phpmyadmin: {
    image: "phpmyadmin:5-apache",
    port: 80,
    env: ({ connection, rootPassword }) => [
      `PMA_HOST=${connection.host}`,
      `PMA_PORT=${connection.port}`,
      "PMA_USER=root",
      `PMA_PASSWORD=${rootPassword ?? ""}`,
      "UPLOAD_LIMIT=256M",
    ],
  },
  "mongo-express": {
    image: "mongo-express:1",
    port: 8081,
    env: ({ connection, password }) => [
      `ME_CONFIG_MONGODB_URL=${connectionUrl(connection, password)}`,
      "ME_CONFIG_BASICAUTH=false",
    ],
  },
  "redis-commander": {
    image: "rediscommander/redis-commander:latest",
    port: 8081,
    env: ({ connection, password }) => [
      `REDIS_HOST=${connection.host}`,
      `REDIS_PORT=${connection.port}`,
      `REDIS_PASSWORD=${password}`,
    ],
  },
};

export const companionImage = (tool: CompanionTool): string => companions[tool].image;

export const companionServiceName = (project: string, service: string, tool: CompanionTool): string =>
  `${qualifiedName(project, service)}-${tool}`;

const NANOS_PER_SECOND = 1_000_000_000;
const ROLLING = {
  Parallelism: 1,
  FailureAction: "pause",
  Monitor: 5 * NANOS_PER_SECOND,
  Order: "stop-first",
};

/** A tool for one database. Pure: it needs the proxy to hide it behind a generated token. */
export function compileCompanion(input: CompanionCompileInput): CompiledCompanion {
  const { project, service, tool, engine, user, databaseName, host, username, token } = input;
  assertHostname(host);
  const definition = companions[tool];
  const name = companionServiceName(project, service, tool);
  const connection: ConnectionTarget = {
    engine,
    host: qualifiedName(project, service),
    port: databaseEngineInfo[engine].port,
    user,
    databaseName,
  };

  const swarmSpec: SwarmServiceSpec = {
    Name: name,
    Labels: {
      "opsifier.project": project,
      "opsifier.service": `${service}-${tool}`,
      "opsifier.type": "companion",
      "opsifier.parent": service,
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: definition.image,
        Env: definition.env({ ...input, connection }),
      },
      RestartPolicy: { Condition: "any", Delay: 5 * NANOS_PER_SECOND, MaxAttempts: 0 },
      Networks: routedNetworks(project, [name]),
      LogDriver: { Name: "json-file", Options: { "max-file": "3", "max-size": "10m" } },
    },
    Mode: { Replicated: { Replicas: 1 } },
    UpdateConfig: ROLLING,
    RollbackConfig: ROLLING,
    EndpointSpec: { Mode: "vip" },
  };

  const auth = `${name}-auth`;
  const rule = `Host(\`${host}\`)`;
  const proxyConfig = {
    http: {
      routers: {
        [`http-${name}`]: {
          rule,
          entryPoints: ["web"],
          service: name,
          middlewares: ["opsifier-redirect-https"],
        },
        [`https-${name}`]: {
          rule,
          entryPoints: ["websecure"],
          service: name,
          middlewares: [auth],
          tls: { certResolver: "letsencrypt", domains: [{ main: host }] },
        },
      },
      services: {
        [name]: {
          loadBalancer: { passHostHeader: true, servers: [{ url: `http://${name}:${definition.port}/` }] },
        },
      },
      middlewares: {
        [auth]: { basicAuth: { removeHeader: true, users: [`${username}:${sha1Secret(token)}`] } },
      },
    },
  };

  return { routeName: `${service}-${tool}`, swarmSpec, proxyConfig };
}

/** `{SHA}` is one of the formats Traefik understands. The token is long and random, so it is enough. */
function sha1Secret(token: string): string {
  return `{SHA}${createHash("sha1").update(token).digest("base64")}`;
}
