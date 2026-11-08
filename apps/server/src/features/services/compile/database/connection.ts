import { isIP } from "node:net";
import { type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";

export interface ConnectionTarget {
  engine: DatabaseEngine;
  host: string;
  port: number;
  user: string;
  databaseName: string | null;
}

/** RFC 3986 allows `!*'()` in a userinfo field, but plenty of parsers do not, so they are encoded too. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A literal IPv6 address needs brackets to be told apart from the port. */
const urlHost = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);

/** The URL itself, with `userinfo` already in its final form. */
function assembleUrl(target: ConnectionTarget, password: string): string {
  const { engine, port, user, databaseName } = target;
  const host = urlHost(target.host);
  const userinfo = `${percentEncode(user)}:${password}`;
  switch (engine) {
    case "postgres":
      return `postgres://${userinfo}@${host}:${port}/${percentEncode(databaseName ?? "")}?sslmode=disable`;
    // MariaDB speaks the MySQL protocol, and its clients all accept the mysql:// scheme.
    case "mysql":
    case "mariadb":
      return `mysql://${userinfo}@${host}:${port}/${percentEncode(databaseName ?? "")}`;
    case "mongo":
      return `mongodb://${userinfo}@${host}:${port}/?tls=false`;
    case "redis":
      return `redis://${userinfo}@${host}:${port}`;
  }
}

/** A URL any client can parse, whatever characters the user, password or database name hold. */
export function connectionUrl(target: ConnectionTarget, password: string): string {
  return assembleUrl(target, percentEncode(password));
}

/** The same address with the password blanked out, for showing before anyone asks to reveal it. */
export const MASK = "••••••••";

export function maskedConnectionUrl(target: ConnectionTarget): string {
  return assembleUrl(target, MASK);
}

export const enginePort = (engine: DatabaseEngine): number => databaseEngineInfo[engine].port;
