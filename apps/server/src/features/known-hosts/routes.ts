import { createRoute } from "@hono/zod-openapi";
import {
  addKnownHostRequest,
  knownHost,
  knownHostList,
  knownHostPath,
  scanKnownHostRequest,
  scanKnownHostResponse,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { addKnownHost, importLearnedHosts, listKnownHosts, removeKnownHost, scanKnownHost } from "./service";

const tags = ["Known hosts"];
const BASE = "/api/v1/settings/known-hosts";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  responses: { 200: jsonResponse(knownHostList, "The SSH hosts Git may connect to."), 401: denied },
});

const addRoute = createRoute({
  method: "post",
  path: BASE,
  tags,
  description: "Trusts one key of one host. Compare its fingerprint with what the host publishes first.",
  request: { body: jsonBody(addKnownHostRequest) },
  responses: {
    201: jsonResponse(knownHost, "The new entry."),
    400: invalid,
    401: denied,
  },
});

const scanRoute = createRoute({
  method: "post",
  path: `${BASE}/scan`,
  tags,
  description: "Reads a host's keys so that a person can compare them. Nothing is saved or trusted by this.",
  request: { body: jsonBody(scanKnownHostRequest) },
  responses: {
    200: jsonResponse(scanKnownHostResponse, "The keys the host offers, with their fingerprints."),
    400: invalid,
    401: denied,
    502: errorResponse("The host could not be reached."),
    503: errorResponse("ssh-keyscan is not available on this server."),
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: `${BASE}/{id}`,
  tags,
  request: { params: knownHostPath },
  responses: {
    200: jsonResponse(knownHostList, "The entry is gone."),
    401: denied,
    404: errorResponse("No such entry."),
  },
});

export const feature: Feature = {
  boot: (deps) => importLearnedHosts(deps),

  register(app, deps) {
    app.openapi(listRoute, (c) => c.json({ items: listKnownHosts(deps) }, 200));

    app.openapi(addRoute, (c) =>
      c.json(addKnownHost(deps, c.req.valid("json"), requirePrincipal(c).user.email), 201),
    );

    app.openapi(scanRoute, async (c) =>
      c.json({ items: await scanKnownHost(deps, c.req.valid("json")) }, 200),
    );

    app.openapi(removeRoute, (c) => {
      removeKnownHost(deps, c.req.valid("param").id, requirePrincipal(c).user.email);
      return c.json({ items: listKnownHosts(deps) }, 200);
    });
  },
};
