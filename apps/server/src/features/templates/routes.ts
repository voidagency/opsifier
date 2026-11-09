import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  deployTemplateRequest,
  destroyRequest,
  installTemplateRequest,
  projectPath,
  revealedTemplateSecret,
  revealTemplateSecretRequest,
  templateCatalogue,
  templateDocument,
  templateInstall,
  templateInstallList,
  templateInstallPath,
  templatePreviewRequest,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse, optionalJsonBody } from "../../core/openapi";
import { requestAccess, requireHostAccess } from "../access/guard";
import {
  enqueueInstallDeploy,
  enqueueInstallRemoval,
  getInstall,
  installTemplate,
  listCatalogue,
  listInstalls,
  parseTemplateSchema,
  revealInstallSecret,
} from "./service";

const tags = ["Templates"];
const INSTALLS = "/api/v1/projects/{project}/templates";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project or install.");

const listCatalogueRoute = createRoute({
  method: "get",
  path: "/api/v1/templates",
  tags,
  responses: {
    200: jsonResponse(templateCatalogue, "Every template, with what its form needs."),
    401: denied,
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/api/v1/templates/preview",
  tags,
  description: "Validates a pasted template and returns it, so its form can be shown.",
  request: { body: jsonBody(templatePreviewRequest) },
  responses: {
    200: jsonResponse(templateDocument, "The document, as it will be installed."),
    400: invalid,
    401: denied,
  },
});

const listInstallsRoute = createRoute({
  method: "get",
  path: INSTALLS,
  tags,
  request: { params: projectPath },
  responses: {
    200: jsonResponse(templateInstallList, "What has been installed in this project."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const installRoute = createRoute({
  method: "post",
  path: INSTALLS,
  tags,
  description: "Creates the services a template describes. Nothing runs until they are deployed.",
  request: { params: projectPath, body: jsonBody(installTemplateRequest) },
  responses: {
    201: jsonResponse(templateInstall, "The install, with the services it created."),
    400: invalid,
    401: denied,
    403: errorResponse("Only an administrator can let a template reach the server."),
    404: missing,
    409: errorResponse("A name is already taken."),
  },
});

const getInstallRoute = createRoute({
  method: "get",
  path: `${INSTALLS}/{install}`,
  tags,
  request: { params: templateInstallPath },
  responses: {
    200: jsonResponse(templateInstall, "The install."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const deployInstallRoute = createRoute({
  method: "post",
  path: `${INSTALLS}/{install}/deploy`,
  tags,
  description: "Deploys the install's services in dependency order. Already running ones are skipped.",
  request: {
    params: templateInstallPath,
    body: optionalJsonBody(deployTemplateRequest),
  },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("Something on these services is already happening."),
  },
});

const removeInstallRoute = createRoute({
  method: "delete",
  path: `${INSTALLS}/{install}`,
  tags,
  description: "Destroys what the install created, and nothing else.",
  request: { params: templateInstallPath, body: jsonBody(destroyRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The confirmation does not match."),
  },
});

const revealRoute = createRoute({
  method: "post",
  path: `${INSTALLS}/{install}/secrets/reveal`,
  tags,
  description: "Reveals one secret of an install. Every reveal is written to the activity log.",
  request: { params: templateInstallPath, body: jsonBody(revealTemplateSecretRequest) },
  responses: {
    200: jsonResponse(revealedTemplateSecret, "The secret."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

/** The application catalogue and the installs made from it. */
export const feature: Feature = {
  register(app, deps) {
    app.openapi(listCatalogueRoute, (c) => c.json(listCatalogue(deps), 200));

    app.openapi(previewRoute, (c) => {
      requirePrincipal(c);
      return c.json(parseTemplateSchema(c.req.valid("json").schema), 200);
    });

    app.openapi(listInstallsRoute, async (c) =>
      c.json(await listInstalls(deps, c.req.valid("param").project), 200),
    );

    app.openapi(installRoute, async (c) => {
      const request = c.req.valid("json");
      if (request.acknowledgeHostAccess) {
        requireHostAccess(requestAccess(deps, c));
      }
      return c.json(
        await installTemplate(deps, c.req.valid("param").project, request, actorEmailOf(requirePrincipal(c))),
        201,
      );
    });

    app.openapi(getInstallRoute, async (c) => {
      const { project, install } = c.req.valid("param");
      return c.json(await getInstall(deps, project, install), 200);
    });

    app.openapi(deployInstallRoute, (c) => {
      const { project, install } = c.req.valid("param");
      return c.json(
        toActionEntry(
          enqueueInstallDeploy(
            deps,
            project,
            install,
            c.req.valid("json"),
            actorEmailOf(requirePrincipal(c)),
          ),
        ),
        202,
      );
    });

    app.openapi(removeInstallRoute, (c) => {
      const { project, install } = c.req.valid("param");
      return c.json(
        toActionEntry(
          enqueueInstallRemoval(
            deps,
            project,
            install,
            c.req.valid("json").confirm,
            actorEmailOf(requirePrincipal(c)),
          ),
        ),
        202,
      );
    });

    app.openapi(revealRoute, (c) => {
      const { project, install } = c.req.valid("param");
      const { service, name } = c.req.valid("json");
      return c.json(
        revealInstallSecret(deps, project, install, service, name, actorEmailOf(requirePrincipal(c))),
        200,
      );
    });
  },
};
