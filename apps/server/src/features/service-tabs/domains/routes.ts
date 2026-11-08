import { createRoute } from "@hono/zod-openapi";
import {
  deletedDomain,
  domainEntry,
  domainList,
  domainPath,
  exposedPorts,
  saveDomainRequest,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { requireService } from "../../services/service";
import {
  createDomain,
  deleteDomain,
  exposedPortsOf,
  makeDomainPrimary,
  rewriteAllRoutes,
  updateDomain,
} from "./changes";
import { listDomainEntries } from "./service";

const tags = ["Service domains"];
const BASE = "/api/v1/projects/{project}/services/{service}/domains";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or domain.");
const conflicted = errorResponse("Another service already answers on this hostname and path.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(domainList, "The service's domains, in router order."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const createDomainRoute = createRoute({
  method: "post",
  path: BASE,
  tags,
  description: "Adds a domain and applies it at once. The Docker service is not touched.",
  request: { params: servicePath, body: jsonBody(saveDomainRequest) },
  responses: {
    201: jsonResponse(domainEntry, "The new domain."),
    400: invalid,
    401: denied,
    404: missing,
    409: conflicted,
  },
});

const updateDomainRoute = createRoute({
  method: "put",
  path: `${BASE}/{domain}`,
  tags,
  description: "Changes a domain and applies it at once.",
  request: { params: domainPath, body: jsonBody(saveDomainRequest) },
  responses: {
    200: jsonResponse(domainEntry, "The domain."),
    400: invalid,
    401: denied,
    404: missing,
    409: conflicted,
  },
});

const deleteDomainRoute = createRoute({
  method: "delete",
  path: `${BASE}/{domain}`,
  tags,
  description: "Removes a domain's routes at once.",
  request: { params: domainPath },
  responses: {
    200: jsonResponse(deletedDomain, "Removed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const makePrimaryRoute = createRoute({
  method: "post",
  path: `${BASE}/{domain}/primary`,
  tags,
  description: "Makes this domain the one behind Open and `$(PRIMARY_DOMAIN)`.",
  request: { params: domainPath },
  responses: {
    200: jsonResponse(domainEntry, "The new primary domain."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("A wildcard domain can't be primary."),
  },
});

const exposedPortsRoute = createRoute({
  method: "get",
  path: `${BASE}/exposed-ports`,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(exposedPorts, "The ports the service's image declares."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** API tokens are not people, so a change made by one has no actor to show. */
const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  boot: rewriteAllRoutes,

  register(app, deps) {
    const record = (
      params: { project: string; service: string },
      title: string,
      principal: ReturnType<typeof requirePrincipal>,
    ) => {
      deps.actions.record({
        type: "service.domains",
        title,
        ...target(params),
        actorEmail: actorEmailOf(principal),
      });
    };

    app.openapi(listRoute, (c) => {
      const params = c.req.valid("param");
      requireService(deps, target(params));
      return c.json({ domains: listDomainEntries(deps, target(params)) }, 200);
    });

    app.openapi(createDomainRoute, async (c) => {
      const params = c.req.valid("param");
      const entry = await createDomain(deps, target(params), c.req.valid("json"));
      record(params, `Add the domain ${entry.host}`, requirePrincipal(c));
      return c.json(entry, 201);
    });

    app.openapi(updateDomainRoute, async (c) => {
      const params = c.req.valid("param");
      const entry = await updateDomain(deps, target(params), params.domain, c.req.valid("json"));
      record(params, `Update the domain ${entry.host}`, requirePrincipal(c));
      return c.json(entry, 200);
    });

    app.openapi(deleteDomainRoute, async (c) => {
      const params = c.req.valid("param");
      await deleteDomain(deps, target(params), params.domain);
      record(params, `Remove a domain of ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json({ id: params.domain }, 200);
    });

    app.openapi(makePrimaryRoute, (c) => {
      const params = c.req.valid("param");
      const entry = makeDomainPrimary(deps, target(params), params.domain);
      record(params, `Make ${entry.host} the primary domain`, requirePrincipal(c));
      return c.json(entry, 200);
    });

    app.openapi(exposedPortsRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json({ ports: await exposedPortsOf(deps, target(params)) }, 200);
    });
  },
};
