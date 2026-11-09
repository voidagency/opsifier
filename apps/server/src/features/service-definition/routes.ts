import { createRoute } from "@hono/zod-openapi";
import { projectPath, serviceDefinitionRequest, serviceDetail } from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { createFromDefinition } from "./service";

const definitionRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services/definition",
  tags: ["Services"],
  summary: "Create a whole service from one definition",
  description:
    "Takes the source, environment, domains, mounts and resources together, for scripts and CI. " +
    "Everything is saved before anything runs, unless `deploy` is true. On a failure nothing is left behind.",
  request: { params: projectPath, body: jsonBody(serviceDefinitionRequest) },
  responses: {
    201: jsonResponse(serviceDetail, "The new service."),
    400: errorResponse("The request failed validation."),
    401: errorResponse("Not signed in."),
    403: errorResponse("A path on the host takes an administrator."),
    404: errorResponse("No such project."),
    409: errorResponse("A name, host or mount clashes with something that already exists."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(definitionRoute, async (c) => {
      const principal = requirePrincipal(c);
      const detail = await createFromDefinition(
        deps,
        c.req.valid("param").project,
        c.req.valid("json"),
        requestAccess(deps, c),
        principal.kind === "session" ? principal.user.email : undefined,
        principal.user.role === "admin",
      );
      return c.json(detail, 201);
    });
  },
};
