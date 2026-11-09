import { createRoute } from "@hono/zod-openapi";
import { actionEntry, destroyRequest, retainedVolumeList, retainedVolumePath } from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { enqueueRetainedVolumeDeletion, listRetainedVolumes } from "./service";

const tags = ["Storage"];
const PATH = "/api/v1/retained-volumes";
const denied = errorResponse("Not signed in.");

const listRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  summary: "Volumes left behind by destroyed services",
  responses: {
    200: jsonResponse(retainedVolumeList, "The volumes."),
    401: denied,
    403: errorResponse("Only an administrator can do this."),
    502: errorResponse("Docker is not answering."),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${PATH}/{name}`,
  tags,
  summary: "Delete a kept volume and its data",
  description: "Separate from destroying a service, which never deletes a volume.",
  request: { params: retainedVolumePath, body: jsonBody(destroyRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: errorResponse("The request failed validation."),
    401: denied,
    403: errorResponse("Only an administrator can do this."),
    404: errorResponse("No such kept volume."),
    409: errorResponse("The name does not match, or a service uses this volume again."),
  },
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(listRoute, async (c) => c.json(await listRetainedVolumes(deps), 200));

    app.openapi(deleteRoute, (c) =>
      c.json(
        toActionEntry(
          enqueueRetainedVolumeDeletion(
            deps,
            c.req.valid("param").name,
            c.req.valid("json").confirm,
            actorEmailOf(requirePrincipal(c)),
          ),
        ),
        202,
      ),
    );
  },
};
