import { createRoute } from "@hono/zod-openapi";
import { boxDetail, saveBoxModulesRequest, servicePath } from "@opsifier/contract";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { saveBoxModules } from "../../box/service";

const putRoute = createRoute({
  method: "put",
  path: "/api/v1/projects/{project}/services/{service}/box/modules",
  tags: ["Box"],
  description:
    "Saves which runtimes this box contains, and which versions. Anything outside the module matrix is refused. The image is rebuilt at the next deploy.",
  request: { params: servicePath, body: jsonBody(saveBoxModulesRequest) },
  responses: {
    200: jsonResponse(boxDetail, "Saved. Used by the next deploy."),
    400: errorResponse("The request failed validation, or the matrix does not allow this."),
    401: errorResponse("Not signed in."),
    404: errorResponse("No such box."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(putRoute, (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(
        saveBoxModules(deps, { projectName: project, serviceName: service }, c.req.valid("json")),
        200,
      );
    });
  },
};
