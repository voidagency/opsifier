import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { describe, expect, it, vi } from "vitest";
import { createDynamoStore, createRoute53Dns } from "./aws";

const conditionFailed = (item?: Record<string, unknown>) =>
  new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
    ...(item === undefined ? {} : { Item: item as never }),
  });

/** A client whose `send` is answered by the test, and which remembers every command. */
function fakeClient(answer: (command: { input: unknown }) => unknown = () => ({})) {
  const commands: Array<{ input: Record<string, unknown>; constructor: unknown }> = [];
  return {
    commands,
    client: {
      send: vi.fn(async (command: { input: Record<string, unknown> }) => {
        commands.push(command as never);
        return answer(command);
      }),
    } as never,
  };
}

describe("the DynamoDB store", () => {
  it("creates a row only where none has ever existed", async () => {
    const { client, commands } = fakeClient();
    const store = createDynamoStore(client, "table");

    const created = await store.createPending({
      id: "bcdfghjk",
      status: "pending",
      secretHash: "abc",
      ip: "93.184.216.34",
      createdAt: 1,
      lastSeen: 1,
    });

    expect(created).toBe(true);
    expect(commands[0]).toBeInstanceOf(PutItemCommand);
    expect(commands[0]?.input).toMatchObject({
      TableName: "table",
      ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: { S: "server#bcdfghjk" }, status: { S: "pending" }, secretHash: { S: "abc" } },
    });
  });

  it("reports an existing row as false, not as a failure", async () => {
    const { client } = fakeClient(() => {
      throw conditionFailed();
    });

    expect(
      await createDynamoStore(client, "t").createPending({
        id: "bcdfghjk",
        status: "pending",
        createdAt: 1,
        lastSeen: 1,
      }),
    ).toBe(false);
  });

  it("lets a real failure through", async () => {
    const { client } = fakeClient(() => {
      throw new Error("Throttled");
    });

    await expect(createDynamoStore(client, "t").activate("bcdfghjk", 1)).rejects.toThrow("Throttled");
  });

  it("reads with strong consistency and maps a row back", async () => {
    const { client, commands } = fakeClient(() => ({
      Item: {
        id: { S: "bcdfghjk" },
        status: { S: "removing" },
        createdAt: { N: "1" },
        lastSeen: { N: "2" },
        removeTo: { S: "expired" },
      },
    }));

    const server = await createDynamoStore(client, "t").get("bcdfghjk");

    expect(commands[0]).toBeInstanceOf(GetItemCommand);
    expect(commands[0]?.input).toMatchObject({ ConsistentRead: true, Key: { pk: { S: "server#bcdfghjk" } } });
    expect(server).toEqual({
      id: "bcdfghjk",
      status: "removing",
      createdAt: 1,
      lastSeen: 2,
      removeTo: "expired",
    });
  });

  it("activates only what is still pending", async () => {
    const { client, commands } = fakeClient();

    await createDynamoStore(client, "t").activate("bcdfghjk", 5);

    expect(commands[0]).toBeInstanceOf(UpdateItemCommand);
    expect(commands[0]?.input).toMatchObject({ ConditionExpression: "#status = :pending" });
  });

  it("refreshes a heartbeat only while the row is active at that address", async () => {
    const { client, commands } = fakeClient();

    await createDynamoStore(client, "t").touch("bcdfghjk", "1.1.1.1", 5);

    expect(commands[0]?.input).toMatchObject({
      ConditionExpression: "#status = :active AND ip = :ip",
      UpdateExpression: "SET lastSeen = :at",
    });
  });

  it("tells a held lease apart from one it may not have", async () => {
    const holder = fakeClient(() => {
      throw conditionFailed({ status: { S: "active" } });
    });
    const gone = fakeClient(() => {
      throw conditionFailed({ status: { S: "released" } });
    });
    const missing = fakeClient(() => {
      throw conditionFailed();
    });
    const lease = { id: "bcdfghjk", token: "me" };

    expect(await createDynamoStore(holder.client, "t").lease(lease, ["active"], 1, 2)).toBe("busy");
    expect(await createDynamoStore(gone.client, "t").lease(lease, ["active"], 1, 2)).toBe("refused");
    expect(await createDynamoStore(missing.client, "t").lease(lease, ["active"], 1, 2)).toBe("refused");
  });

  it("takes a lease only when none is running", async () => {
    const { client, commands } = fakeClient();

    expect(await createDynamoStore(client, "t").lease({ id: "x", token: "me" }, ["active"], 1, 2)).toBe(
      "leased",
    );

    expect(commands[0]?.input).toMatchObject({
      UpdateExpression: "SET leaseToken = :token, leaseUntil = :until",
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
    expect(String(commands[0]?.input.ConditionExpression)).toContain(
      "attribute_not_exists(leaseUntil) OR leaseUntil <= :now",
    );
  });

  it("writes through a lease only while it is still held", async () => {
    const { client, commands } = fakeClient();

    await createDynamoStore(client, "t").update(
      { id: "x", token: "me" },
      { status: "released", ip: null, secretHash: null, removeTo: null, lastSeen: 9 },
    );

    expect(commands[0]?.input).toMatchObject({
      ConditionExpression: "leaseToken = :token",
      UpdateExpression: "SET #status = :status, lastSeen = :lastSeen REMOVE ip, removeTo, secretHash",
    });
  });

  it("deletes only a row in one of the statuses given", async () => {
    const { client, commands } = fakeClient();

    await createDynamoStore(client, "t").deleteRow("x", ["pending"]);

    expect(commands[0]).toBeInstanceOf(DeleteItemCommand);
    expect(commands[0]?.input).toMatchObject({ ConditionExpression: "#status IN (:s0)" });
  });

  it("counts atomically, and expires the counter with the table's TTL", async () => {
    const { client, commands } = fakeClient();

    await createDynamoStore(client, "t").hit("ip#1.1.1.1#2026-11-08", 10, 1234);

    expect(commands[0]?.input).toMatchObject({
      Key: { pk: { S: "limit#ip#1.1.1.1#2026-11-08" } },
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeValues: { ":limit": { N: "10" }, ":expires": { N: "1234" } },
    });
  });

  it("scans server rows only, page by page", async () => {
    const { client, commands } = fakeClient(() => ({
      Items: [
        { id: { S: "bcdfghjk" }, status: { S: "active" }, createdAt: { N: "1" }, lastSeen: { N: "1" } },
      ],
      LastEvaluatedKey: { pk: { S: "server#bcdfghjk" } },
    }));
    const store = createDynamoStore(client, "t");

    const page = await store.scan();
    await store.scan(page.cursor);

    expect(commands[0]).toBeInstanceOf(ScanCommand);
    expect(commands[0]?.input).toMatchObject({ FilterExpression: "begins_with(pk, :prefix)" });
    expect(commands[1]?.input).toMatchObject({ ExclusiveStartKey: { pk: { S: "server#bcdfghjk" } } });
  });
});

describe("the Route 53 client", () => {
  it("sends one batch for this zone, and quotes TXT values", async () => {
    const { client, commands } = fakeClient();

    await createRoute53Dns(client, "Z123").change([
      { action: "UPSERT", record: { name: "a.example.dev", type: "A", ttl: 300, values: ["1.1.1.1"] } },
      {
        action: "UPSERT",
        record: { name: "_acme-challenge.a.example.dev", type: "TXT", ttl: 60, values: ["v"] },
      },
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(ChangeResourceRecordSetsCommand);
    expect(commands[0]?.input).toEqual({
      HostedZoneId: "Z123",
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: "a.example.dev",
              Type: "A",
              TTL: 300,
              ResourceRecords: [{ Value: "1.1.1.1" }],
            },
          },
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: "_acme-challenge.a.example.dev",
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: '"v"' }],
            },
          },
        ],
      },
    });
  });

  it("lists from the server's name, and only what sits under it", async () => {
    const { client, commands } = fakeClient(() => ({
      ResourceRecordSets: [
        {
          Name: "bcdfghjk.opsifier.dev.",
          Type: "A",
          TTL: 300,
          ResourceRecords: [{ Value: "1.1.1.1" }],
        },
        {
          Name: "\\052.bcdfghjk.opsifier.dev.",
          Type: "A",
          TTL: 300,
          ResourceRecords: [{ Value: "1.1.1.1" }],
        },
        {
          Name: "_acme-challenge.bcdfghjk.opsifier.dev.",
          Type: "TXT",
          TTL: 60,
          ResourceRecords: [{ Value: '"abc"' }],
        },
        { Name: "cdfghjkm.opsifier.dev.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "2.2.2.2" }] },
      ],
    }));

    const records = await createRoute53Dns(client, "Z123").list("bcdfghjk.opsifier.dev");

    expect(commands[0]).toBeInstanceOf(ListResourceRecordSetsCommand);
    expect(commands[0]?.input).toMatchObject({
      HostedZoneId: "Z123",
      StartRecordName: "bcdfghjk.opsifier.dev",
    });
    expect(records).toEqual([
      { name: "bcdfghjk.opsifier.dev", type: "A", ttl: 300, values: ["1.1.1.1"] },
      { name: "*.bcdfghjk.opsifier.dev", type: "A", ttl: 300, values: ["1.1.1.1"] },
      { name: "_acme-challenge.bcdfghjk.opsifier.dev", type: "TXT", ttl: 60, values: ["abc"] },
    ]);
  });

  it("does not take a neighbour with the same prefix for one of its own", async () => {
    const { client } = fakeClient(() => ({
      ResourceRecordSets: [
        { Name: "xbcdfghjk.opsifier.dev.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "1.1.1.1" }] },
      ],
    }));

    expect(await createRoute53Dns(client, "Z123").list("bcdfghjk.opsifier.dev")).toEqual([]);
  });
});
