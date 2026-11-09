import { createRoute } from "@hono/zod-openapi";
import {
  customDomainPath,
  deletedCustomDomain,
  domainsOverview,
  overviewDomain,
  saveCustomDomainRequest,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import {
  createCustomDomain,
  deleteCustomDomain,
  listOverview,
  rewriteCustomRoutes,
  updateCustomDomain,
} from "./service";

const tags = ["Domains"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const missing = errorResponse("No such domain.");
const conflicted = errorResponse("This hostname and path are already taken.");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/domains",
  tags,
  summary: "Every domain the caller can see",
  responses: {
    200: jsonResponse(domainsOverview, "Each domain, with the state of its certificate."),
    401: denied,
  },
});

const createCustomRoute = createRoute({
  method: "post",
  path: "/api/v1/domains/custom",
  tags,
  summary: "Add a domain that points outside the panel",
  request: { body: jsonBody(saveCustomDomainRequest) },
  responses: {
    201: jsonResponse(overviewDomain, "The domain."),
    400: invalid,
    401: denied,
    403: refused,
    409: conflicted,
  },
});

const updateCustomRoute = createRoute({
  method: "put",
  path: "/api/v1/domains/custom/{id}",
  tags,
  summary: "Change a custom domain",
  request: { params: customDomainPath, body: jsonBody(saveCustomDomainRequest) },
  responses: {
    200: jsonResponse(overviewDomain, "The domain."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: conflicted,
  },
});

const deleteCustomRoute = createRoute({
  method: "delete",
  path: "/api/v1/domains/custom/{id}",
  tags,
  summary: "Remove a custom domain",
  request: { params: customDomainPath },
  responses: {
    200: jsonResponse(deletedCustomDomain, "Removed."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  boot: rewriteCustomRoutes,

  register(app, deps) {
    app.openapi(listRoute, async (c) => c.json(await listOverview(deps, requestAccess(deps, c)), 200));

    app.openapi(createCustomRoute, async (c) =>
      c.json(await createCustomDomain(deps, c.req.valid("json"), actorEmailOf(requirePrincipal(c))), 201),
    );

    app.openapi(updateCustomRoute, async (c) =>
      c.json(
        await updateCustomDomain(
          deps,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorEmailOf(requirePrincipal(c)),
        ),
        200,
      ),
    );

    app.openapi(deleteCustomRoute, async (c) => {
      const { id } = c.req.valid("param");
      await deleteCustomDomain(deps, id, actorEmailOf(requirePrincipal(c)));
      return c.json({ id }, 200);
    });
  },
};
