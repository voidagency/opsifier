import { createRoute } from "@hono/zod-openapi";
import { storageHealth, systemAbout, systemInfo } from "@opsifier/contract";
import type { Feature } from "../../core/context";
import { errorResponse, jsonResponse } from "../../core/openapi";
import { getSystemAbout } from "./about";
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

const storageRoute = createRoute({
  method: "get",
  path: "/api/v1/system/storage",
  tags: ["System"],
  responses: {
    200: jsonResponse(storageHealth, "Whether the panel can still write its state."),
    401: errorResponse("Not signed in."),
  },
});

const aboutRoute = createRoute({
  method: "get",
  path: "/api/v1/system/about",
  tags: ["System"],
  summary: "Show the panel's license and the software it ships",
  description:
    "Opsifier's license and where its source is, and every program and JavaScript package in the panel's image with its own license. Their texts are in the file `noticesFile` names, on the server.",
  responses: {
    200: jsonResponse(systemAbout, "The license, the source and the third-party components."),
    401: errorResponse("Not signed in."),
  },
});

export const feature: Feature = {
  boot: ensureServerIp,

  register(app, deps) {
    app.openapi(infoRoute, (c) => c.json(getSystemInfo(deps), 200));
    app.openapi(storageRoute, (c) => c.json(deps.storage.state(), 200));
    app.openapi(aboutRoute, (c) => c.json(getSystemAbout(deps), 200));
  },
};
