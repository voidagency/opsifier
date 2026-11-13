import { createRoute } from "@hono/zod-openapi";
import { twoFactorPolicy, twoFactorPolicyState } from "@opsifier/contract";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { readPolicy, savePolicy } from "./service";

const PATH = "/api/v1/settings/two-factor";
const tags = ["Accounts"];
const denied = errorResponse("Not signed in.");
const refused = errorResponse("The caller is not allowed to do this, or is not the owner.");

const readRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  summary: "Whether every account must use two-factor sign-in",
  responses: {
    200: jsonResponse(twoFactorPolicyState, "The rule, and how many accounts don't have it yet."),
    401: denied,
    403: refused,
  },
});

const saveRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  summary: "Require two-factor sign-in of every account, or stop requiring it",
  description:
    "Only the owner can, and only once their own account uses it. While it is required, an account without it can only turn it on, and its API keys are refused.",
  request: { body: jsonBody(twoFactorPolicy) },
  responses: {
    200: jsonResponse(twoFactorPolicyState, "The rule now."),
    400: errorResponse("The request failed validation."),
    401: denied,
    403: refused,
    409: errorResponse("`two_factor_first`: the owner's own account doesn't use two-factor sign-in yet."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(readRoute, (c) => c.json(readPolicy(deps, requireSessionPrincipal(c)), 200));
    app.openapi(saveRoute, (c) =>
      c.json(savePolicy(deps, requireSessionPrincipal(c), c.req.valid("json")), 200),
    );
  },
};
