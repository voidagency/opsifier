import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, type Tags } from "yaml";

const intrinsic = (tag: string, key: string): Tags[number] => ({
  tag,
  resolve: (value: string | unknown) => ({ [key]: value }),
});

const template = parse(readFileSync(join(import.meta.dirname, "..", "template.yaml"), "utf8"), {
  customTags: [
    intrinsic("!Ref", "Ref"),
    intrinsic("!Sub", "Fn::Sub"),
    intrinsic("!GetAtt", "Fn::GetAtt"),
    { tag: "!If", collection: "seq" },
    { tag: "!Not", collection: "seq" },
    { tag: "!Equals", collection: "seq" },
  ],
}) as {
  Parameters: Record<string, { Type: string }>;
  Resources: Record<string, Resource>;
};

// biome-ignore lint/suspicious/noExplicitAny: a parsed YAML document, checked by what the tests assert
type Yaml = any;

interface Resource {
  Type: string;
  Properties: Yaml;
  DeletionPolicy?: string;
  DependsOn?: string[];
}

const resources = Object.entries(template.Resources);
const ofType = (type: string) => resources.filter(([, resource]) => resource.Type === type);
const resource = (name: string): Resource => template.Resources[name] as Resource;

const statements = (role: string): Yaml[] =>
  resource(role).Properties.Policies.flatMap(
    (policy: { PolicyDocument: { Statement: Yaml[] } }) => policy.PolicyDocument.Statement,
  );

describe("what the template creates", () => {
  it("takes the hosted zone as a parameter and never creates one", () => {
    expect(template.Parameters.HostedZoneId?.Type).toBe("AWS::Route53::HostedZone::Id");
    expect(ofType("AWS::Route53::HostedZone")).toEqual([]);
  });

  it("keeps the table when the stack goes, with point-in-time recovery on", () => {
    const table = resource("ServersTable");
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
  });

  it("runs on Node 22 on arm64", () => {
    for (const [, fn] of ofType("AWS::Lambda::Function")) {
      expect(fn.Properties.Runtime).toBe("nodejs22.x");
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
    }
  });

  it("serves the API on its own domain, with a DNS-validated certificate and an alias record", () => {
    const certificate = resource("Certificate");
    expect(certificate.Properties.ValidationMethod).toBe("DNS");
    expect(certificate.Properties.DomainValidationOptions[0].HostedZoneId).toEqual({ Ref: "HostedZoneId" });
    expect(resource("ApiDomain").Properties.DomainNameConfigurations[0].CertificateArn).toEqual({
      Ref: "Certificate",
    });
    expect(resource("ApiDnsRecord").Properties.AliasTarget).toBeDefined();
    expect(resource("Api").Properties.DisableExecuteApiEndpoint).toBe(true);
  });

  it("throttles the API, and registration hardest", () => {
    const stage = resource("ApiStage").Properties;
    expect(stage.DefaultRouteSettings).toMatchObject({
      ThrottlingRateLimit: { Ref: "ThrottleRate" },
      ThrottlingBurstLimit: { Ref: "ThrottleBurst" },
    });
    expect(stage.RouteSettings["POST /v1/servers"]).toMatchObject({
      ThrottlingRateLimit: 2,
    });
  });

  it("has a route for each endpoint in the API, and nothing else", () => {
    const keys = ofType("AWS::ApiGatewayV2::Route").map(([, route]) => route.Properties.RouteKey);
    expect(keys.sort()).toEqual([
      "DELETE /v1/servers/{id}",
      "POST /v1/acme/cleanup",
      "POST /v1/acme/present",
      "POST /v1/servers",
      "PUT /v1/servers/{id}",
    ]);
  });

  it("logs no headers in its access log, so no credentials", () => {
    expect(resource("ApiStage").Properties.AccessLogSettings.Format).not.toMatch(/authorization|header/i);
  });

  it("runs the cleanup every day", () => {
    expect(resource("DailyCleanup").Properties.ScheduleExpression).toBe("rate(1 day)");
    expect(resource("DailyCleanupPermission").Properties.Principal).toBe("events.amazonaws.com");
  });

  it("gives the API no way in to the operator's function", () => {
    const integration = resource("ApiIntegration").Properties.IntegrationUri;
    expect(integration).toEqual({ "Fn::GetAtt": "ApiFunction.Arn" });
  });
});

describe("the permissions", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation's own syntax
  const ZONE_ARN = { "Fn::Sub": "arn:${AWS::Partition}:route53:::hostedzone/${HostedZoneId}" };
  const TABLE_ARN = { "Fn::GetAtt": "ServersTable.Arn" };

  it.each(["ApiRole", "MaintenanceRole"])("%s has no wildcard action or resource", (role) => {
    for (const statement of statements(role)) {
      expect(JSON.stringify(statement.Resource)).not.toBe('"*"');
      for (const action of [statement.Action].flat()) {
        expect(action).not.toMatch(/\*/);
      }
    }
  });

  it.each(["ApiRole", "MaintenanceRole"])("%s changes records only in this zone", (role) => {
    const route53 = statements(role).filter((statement) =>
      [statement.Action].flat()[0].startsWith("route53:"),
    );
    expect(route53.length).toBeGreaterThan(0);
    for (const statement of route53) {
      expect(statement.Resource).toEqual(ZONE_ARN);
    }
  });

  it.each(["ApiRole", "MaintenanceRole"])("%s touches only this table", (role) => {
    const table = statements(role).filter((statement) =>
      [statement.Action].flat()[0].startsWith("dynamodb:"),
    );
    expect(table.length).toBe(1);
    expect(table[0]?.Resource).toEqual(TABLE_ARN);
  });

  it.each(["ApiRole", "MaintenanceRole"])("%s can only change A and TXT records under the zone", (role) => {
    const allow = statements(role).find((statement) => statement.Sid === "ChangeServerRecords");
    expect(allow?.Condition["ForAllValues:StringEquals"]).toEqual({
      "route53:ChangeResourceRecordSetsRecordTypes": ["A", "TXT"],
    });
    expect(allow?.Condition["ForAllValues:StringLike"]).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation's own syntax
      "route53:ChangeResourceRecordSetsNormalizedRecordNames": [{ "Fn::Sub": "*.${ZoneName}" }],
    });
  });

  it.each(["ApiRole", "MaintenanceRole"])("%s is denied the zone's own names", (role) => {
    const deny = statements(role).find((statement) => statement.Effect === "Deny");
    const names = deny?.Condition["ForAnyValue:StringEquals"][
      "route53:ChangeResourceRecordSetsNormalizedRecordNames"
    ] as unknown[];
    expect(names).toEqual(
      expect.arrayContaining([
        { Ref: "ZoneName" },
        { Ref: "ApiHostname" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation's own syntax
        { "Fn::Sub": "_psl.${ZoneName}" },
      ]),
    );
  });

  it("does not let the API scan the table, and only the job can", () => {
    const actions = (role: string) => statements(role).flatMap((statement) => [statement.Action].flat());
    expect(actions("ApiRole")).not.toContain("dynamodb:Scan");
    expect(actions("MaintenanceRole")).toContain("dynamodb:Scan");
  });

  it("lets only API Gateway invoke the API function, for this API", () => {
    const permission = resource("ApiInvokePermission").Properties;
    expect(permission.Principal).toBe("apigateway.amazonaws.com");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudFormation's own syntax
    expect(permission.SourceArn["Fn::Sub"]).toContain("${Api}");
  });

  it("gives each function its own role", () => {
    expect(resource("ApiFunction").Properties.Role).toEqual({ "Fn::GetAtt": "ApiRole.Arn" });
    expect(resource("MaintenanceFunction").Properties.Role).toEqual({
      "Fn::GetAtt": "MaintenanceRole.Arn",
    });
  });
});
