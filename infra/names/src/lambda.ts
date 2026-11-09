import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Route53Client } from "@aws-sdk/client-route-53";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { type HttpEvent, handle, type OperatorEvent, runMaintenance } from "./api";
import { createDynamoStore, createRoute53Dns } from "./aws";
import { randomId, randomSecret, randomToken } from "./rules";
import { type Deps, requestMessage } from "./service";

/** Short and bounded: a call has to fail well inside the function's own timeout, not be killed by it. */
const CLIENT_OPTIONS = {
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 1500, requestTimeout: 3000 },
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const number = (name: string): number => {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is not a number`);
  }
  return value;
};

const topicArn = process.env.REQUESTS_TOPIC_ARN ?? "";
const sns = new SNSClient(CLIENT_OPTIONS);
const zone = required("ZONE_NAME");

const deps: Deps = {
  store: createDynamoStore(new DynamoDBClient(CLIENT_OPTIONS), required("TABLE_NAME")),
  // Route 53 is a global service, and it signs in this one region.
  dns: createRoute53Dns(
    new Route53Client({ ...CLIENT_OPTIONS, region: "us-east-1" }),
    required("HOSTED_ZONE_ID"),
  ),
  zone,
  limits: {
    registrationsPerIpPerDay: number("REGISTRATIONS_PER_IP_PER_DAY"),
    registrationsPerDay: number("REGISTRATIONS_PER_DAY"),
    changesPerServerPerHour: number("CHANGES_PER_SERVER_PER_HOUR"),
    inactiveAfterDays: number("INACTIVE_AFTER_DAYS"),
    removalsPerRun: number("REMOVALS_PER_RUN"),
    removalPauseMs: number("REMOVAL_PAUSE_MS"),
    maxChallengeValues: number("MAX_CHALLENGE_VALUES"),
  },
  now: Date.now,
  newId: randomId,
  newSecret: randomSecret,
  newToken: randomToken,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (event, fields = {}) => console.log(JSON.stringify({ event, ...fields })),
  // With no topic there is nobody to tell: requests wait to be listed.
  notify: async (request) => {
    if (topicArn !== "") {
      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: "Opsifier: a server is asking for an address",
          Message: requestMessage(request, zone),
        }),
      );
    }
  },
};

export const api = (event: HttpEvent) => handle(event, deps);

export const maintenance = (event: OperatorEvent | undefined) => runMaintenance(event, deps);
