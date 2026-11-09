import { createRoute } from "@hono/zod-openapi";
import { actionEntry, certificateList, certificatePath, deleteCertificateRequest } from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { deleteCertificate, listCertificates } from "./service";

const tags = ["Certificates"];
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/certificates",
  tags,
  summary: "List the certificates the proxy holds",
  responses: { 200: jsonResponse(certificateList, "By domain."), 401: denied, 403: refused },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/api/v1/certificates/{id}",
  tags,
  summary: "Remove a certificate from the proxy's store",
  description: "The proxy restarts to forget it, and requests a new one the next time it is needed.",
  request: { params: certificatePath, body: jsonBody(deleteCertificateRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action restarting the proxy."),
    400: errorResponse("The request failed validation."),
    401: denied,
    403: refused,
    404: errorResponse("No such certificate."),
    409: errorResponse("The typed domain does not match."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(listRoute, async (c) => c.json({ certificates: await listCertificates(deps) }, 200));

    app.openapi(deleteRoute, async (c) =>
      c.json(
        toActionEntry(
          await deleteCertificate(
            deps,
            c.req.valid("param").id,
            c.req.valid("json").confirm,
            requireSessionPrincipal(c).user.email,
          ),
        ),
        202,
      ),
    );
  },
};
