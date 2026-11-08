import { projectName, resourceName } from "@opsifier/contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, Feature } from "../../core/context";
import { PROXY_PAGES_PREFIX, type ProxyPageName, proxyPagePath } from "../../core/proxy";
import { findService } from "../services/repo";
import { renderMaintenancePage, renderProxyPage } from "./render";
import { pickLanguage } from "./strings";

const PAGES: readonly ProxyPageName[] = ["bad-gateway", "not-found", "stopped"];

const languageOf = (c: Context<AppEnv>) => pickLanguage(c.req.header("accept-language"));

function serve(c: Context<AppEnv>, html: string, status: ContentfulStatusCode) {
  // Each answer depends on what is true right now, so nothing in between should keep it.
  c.header("Cache-Control", "no-store");
  c.header("Content-Type", "text/html; charset=UTF-8");
  return c.body(html, status);
}

/**
 * The pages Traefik shows in place of a site: reached through the proxy only, with no session.
 * Anything may be sent here, so these handlers answer every method and never read a body.
 */
export const feature: Feature = {
  register(app, deps) {
    for (const name of PAGES) {
      app.all(proxyPagePath(name), (c) => {
        const { status, html } = renderProxyPage(name, languageOf(c));
        return serve(c, html, status);
      });
    }

    app.all(`${PROXY_PAGES_PREFIX}/maintenance/:project/:service`, (c) => {
      const project = projectName.safeParse(c.req.param("project"));
      const service = resourceName.safeParse(c.req.param("service"));
      const record =
        project.success && service.success ? findService(deps.db, project.data, service.data) : undefined;
      if (record === undefined || !record.spec.maintenance.enabled) {
        const { html, status } = renderProxyPage("not-found", languageOf(c));
        return serve(c, html, status);
      }
      return serve(c, renderMaintenancePage(record.spec.maintenance, languageOf(c)), 503);
    });
  },
};
