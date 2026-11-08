import { createRoute } from "@hono/zod-openapi";
import { systemInfo } from "@opsifier/contract";
import type { Feature } from "../../core/context";
import { errorResponse, jsonResponse } from "../../core/openapi";
import { ensureServerIp, getSystemInfo } from "./service";

const infoRoute = createRoute({
  method: "get",
  path: "/api/v1/system/info",
  tags: ["System"],
  responses: {
    200: jsonResponse(systemInfo, "The panel's version and the server's address."),
    401: errorResponse("Not signed in."),
  },
});

export const feature: Feature = {
  boot: ensureServerIp,

  register(app, deps) {
    app.openapi(infoRoute, (c) => c.json(getSystemInfo(deps), 200));
  },
};
