import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  type Change,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53";
import type {
  Dns,
  DnsChange,
  FinalStatus,
  Lease,
  RecordSet,
  ServerRecord,
  ServerStatus,
  Store,
} from "./ports";

const SERVER_PREFIX = "server#";
const LIMIT_PREFIX = "limit#";
/** Far more than one server's three names, in case Route 53 mixes in a neighbour. */
const LIST_PAGE = 20;

type Item = Record<string, AttributeValue>;

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });

const serverKey = (id: string): Item => ({ pk: S(`${SERVER_PREFIX}${id}`) });

function toItem(server: ServerRecord): Item {
  return {
    ...serverKey(server.id),
    id: S(server.id),
    status: S(server.status),
    createdAt: N(server.createdAt),
    lastSeen: N(server.lastSeen),
    ...(server.secretHash === undefined ? {} : { secretHash: S(server.secretHash) }),
    ...(server.ip === undefined ? {} : { ip: S(server.ip) }),
  };
}

function fromItem(item: Item): ServerRecord {
  return {
    id: item.id?.S ?? "",
    status: item.status?.S as ServerStatus,
    createdAt: Number(item.createdAt?.N ?? 0),
    lastSeen: Number(item.lastSeen?.N ?? 0),
    ...(item.secretHash?.S === undefined ? {} : { secretHash: item.secretHash.S }),
    ...(item.ip?.S === undefined ? {} : { ip: item.ip.S }),
    ...(item.removeTo?.S === undefined ? {} : { removeTo: item.removeTo.S as FinalStatus }),
  };
}

const isConditionFailure = (error: unknown): error is ConditionalCheckFailedException =>
  error instanceof ConditionalCheckFailedException;

/** True if the write went through, false if its condition said no. Anything else is a real failure. */
async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (isConditionFailure(error)) {
      return false;
    }
    throw error;
  }
}

/** A real status list is short and constant, but it still goes through placeholders. */
function statusPlaceholders(statuses: readonly ServerStatus[]): { names: string; values: Item } {
  const values: Item = {};
  const names = statuses.map((status, index) => {
    values[`:s${index}`] = S(status);
    return `:s${index}`;
  });
  return { names: names.join(", "), values };
}

function renderPatch(patch: Parameters<Store["update"]>[1]): {
  expression: string;
  names: Record<string, string>;
  values: Item;
} {
  const set: string[] = [];
  const remove: string[] = [];
  const names: Record<string, string> = {};
  const values: Item = {};
  if (patch.status !== undefined) {
    set.push("#status = :status");
    names["#status"] = "status";
    values[":status"] = S(patch.status);
  }
  if (patch.lastSeen !== undefined) {
    set.push("lastSeen = :lastSeen");
    values[":lastSeen"] = N(patch.lastSeen);
  }
  if (patch.ip === null) {
    remove.push("ip");
  } else if (patch.ip !== undefined) {
    set.push("ip = :ip");
    values[":ip"] = S(patch.ip);
  }
  if (patch.removeTo === null) {
    remove.push("removeTo");
  } else if (patch.removeTo !== undefined) {
    set.push("removeTo = :removeTo");
    values[":removeTo"] = S(patch.removeTo);
  }
  if (patch.secretHash === null) {
    remove.push("secretHash");
  }
  const expression = [
    ...(set.length > 0 ? [`SET ${set.join(", ")}`] : []),
    ...(remove.length > 0 ? [`REMOVE ${remove.join(", ")}`] : []),
  ].join(" ");
  return { expression, names, values };
}

export function createDynamoStore(client: Pick<DynamoDBClient, "send">, tableName: string): Store {
  const Key = serverKey;
  const TableName = tableName;
  const STATUS = { "#status": "status" };

  return {
    createPending: (server) =>
      conditional(() =>
        client.send(
          new PutItemCommand({
            TableName,
            Item: toItem(server),
            // Any row at all stops it, tombstones included: an ID is never issued twice.
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        ),
      ),

    async get(id) {
      const { Item: item } = await client.send(
        new GetItemCommand({ TableName, Key: Key(id), ConsistentRead: true }),
      );
      return item === undefined ? null : fromItem(item);
    },

    activate: (id, at) =>
      conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName,
            Key: Key(id),
            UpdateExpression: "SET #status = :active, lastSeen = :at",
            ConditionExpression: "#status = :pending",
            ExpressionAttributeNames: STATUS,
            ExpressionAttributeValues: { ":active": S("active"), ":pending": S("pending"), ":at": N(at) },
          }),
        ),
      ),

    touch: (id, ip, at) =>
      conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName,
            Key: Key(id),
            UpdateExpression: "SET lastSeen = :at",
            ConditionExpression: "#status = :active AND ip = :ip",
            ExpressionAttributeNames: STATUS,
            ExpressionAttributeValues: { ":active": S("active"), ":ip": S(ip), ":at": N(at) },
          }),
        ),
      ),

    async lease(lease, statuses, now, until) {
      const placeholders = statusPlaceholders(statuses);
      try {
        await client.send(
          new UpdateItemCommand({
            TableName,
            Key: Key(lease.id),
            UpdateExpression: "SET leaseToken = :token, leaseUntil = :until",
            ConditionExpression: `#status IN (${placeholders.names}) AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)`,
            ExpressionAttributeNames: STATUS,
            ExpressionAttributeValues: {
              ...placeholders.values,
              ":token": S(lease.token),
              ":until": N(until),
              ":now": N(now),
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          }),
        );
        return "leased";
      } catch (error) {
        if (!isConditionFailure(error)) {
          throw error;
        }
        const held = error.Item === undefined ? undefined : (error.Item as Item);
        return held !== undefined && statuses.includes(held.status?.S as ServerStatus) ? "busy" : "refused";
      }
    },

    update(lease, patch) {
      const { expression, names, values } = renderPatch(patch);
      return conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName,
            Key: Key(lease.id),
            UpdateExpression: expression,
            ConditionExpression: "leaseToken = :token",
            ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
            ExpressionAttributeValues: { ...values, ":token": S(lease.token) },
          }),
        ),
      );
    },

    async unlease(lease: Lease) {
      await conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName,
            Key: Key(lease.id),
            UpdateExpression: "REMOVE leaseToken, leaseUntil",
            ConditionExpression: "leaseToken = :token",
            ExpressionAttributeValues: { ":token": S(lease.token) },
          }),
        ),
      );
    },

    deleteRow(id, statuses) {
      const placeholders = statusPlaceholders(statuses);
      return conditional(() =>
        client.send(
          new DeleteItemCommand({
            TableName,
            Key: Key(id),
            ConditionExpression: `#status IN (${placeholders.names})`,
            ExpressionAttributeNames: STATUS,
            ExpressionAttributeValues: placeholders.values,
          }),
        ),
      );
    },

    hit: (key, limit, expiresAtSeconds) =>
      conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName,
            Key: { pk: S(`${LIMIT_PREFIX}${key}`) },
            UpdateExpression: "SET expiresAt = if_not_exists(expiresAt, :expires) ADD #count :one",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames: { "#count": "count" },
            ExpressionAttributeValues: {
              ":one": N(1),
              ":limit": N(limit),
              ":expires": N(expiresAtSeconds),
            },
          }),
        ),
      ),

    async scan(cursor) {
      const { Items, LastEvaluatedKey } = await client.send(
        new ScanCommand({
          TableName,
          FilterExpression: "begins_with(pk, :prefix)",
          ExpressionAttributeValues: { ":prefix": S(SERVER_PREFIX) },
          ...(cursor === undefined ? {} : { ExclusiveStartKey: JSON.parse(cursor) as Item }),
        }),
      );
      return {
        servers: (Items ?? []).map((item) => fromItem(item)),
        ...(LastEvaluatedKey === undefined ? {} : { cursor: JSON.stringify(LastEvaluatedKey) }),
      };
    },
  };
}

/** Route 53 spells `*` as `\052` and ends every name with a dot. */
const fromRoute53Name = (name: string): string =>
  name.toLowerCase().replaceAll("\\052", "*").replace(/\.$/, "");

const fromRoute53Value = (value: string, type: RecordSet["type"]): string =>
  type === "TXT" ? value.replace(/^"|"$/g, "") : value;

const toRoute53Value = (value: string, type: RecordSet["type"]): string =>
  type === "TXT" ? `"${value}"` : value;

function toRoute53Change({ action, record }: DnsChange): Change {
  return {
    Action: action,
    ResourceRecordSet: {
      Name: record.name,
      Type: record.type,
      TTL: record.ttl,
      ResourceRecords: record.values.map((value) => ({ Value: toRoute53Value(value, record.type) })),
    },
  };
}

export function createRoute53Dns(client: Pick<Route53Client, "send">, hostedZoneId: string): Dns {
  return {
    async list(name) {
      // Sorted by reversed labels, so a name and everything under it sit together from this point on.
      const { ResourceRecordSets } = await client.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          StartRecordName: name,
          MaxItems: LIST_PAGE,
        }),
      );
      return (ResourceRecordSets ?? []).flatMap((set): RecordSet[] => {
        const recordName = fromRoute53Name(set.Name ?? "");
        if ((recordName !== name && !recordName.endsWith(`.${name}`)) || !isManagedType(set.Type)) {
          return [];
        }
        const type = set.Type;
        return [
          {
            name: recordName,
            type,
            ttl: set.TTL ?? 0,
            values: (set.ResourceRecords ?? []).map(({ Value }) => fromRoute53Value(Value ?? "", type)),
          },
        ];
      });
    },

    async change(changes) {
      await client.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: { Changes: changes.map(toRoute53Change) },
        }),
      );
    },
  };
}

const isManagedType = (type: string | undefined): type is RecordSet["type"] => type === "A" || type === "TXT";
