import { createRoute } from "@hono/zod-openapi";
import { boxDetail, saveBoxHooksRequest, servicePath } from "@opsifier/contract";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { saveBoxHooks } from "../../box/service";

const putRoute = createRoute({
  method: "put",
  path: "/api/v1/projects/{project}/services/{service}/box/hooks",
  tags: ["Box"],
  description:
    "Saves the build and start hooks. Takes effect at the next deploy. The build hook runs while the image is built, the start hook before any process starts.",
  request: { params: servicePath, body: jsonBody(saveBoxHooksRequest) },
  responses: {
    200: jsonResponse(boxDetail, "Saved. Used by the next deploy."),
    400: errorResponse("The request failed validation."),
    401: errorResponse("Not signed in."),
    404: errorResponse("No such box."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(putRoute, (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(
        saveBoxHooks(deps, { projectName: project, serviceName: service }, c.req.valid("json")),
        200,
      );
    });
  },
};
