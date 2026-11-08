import { MAX_REDIRECT_RULES, type RedirectRule, type SaveRedirectRequest } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import { badRequest, notFound } from "../../../core/errors";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget, writeProxyConfig } from "../../services/service";

type RuleFields = Required<SaveRedirectRequest>;

/** Rules take effect at once. The Docker service never hears about them. */
async function apply(deps: AppDeps, target: ServiceTarget, redirects: RedirectRule[]): Promise<void> {
  const record = requireService(deps, target);
  const spec = { ...record.spec, redirects };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  await writeProxyConfig(deps, target, spec);
}

export function listRedirects(deps: AppDeps, target: ServiceTarget): RedirectRule[] {
  return requireService(deps, target).spec.redirects;
}

export async function addRedirect(
  deps: AppDeps,
  target: ServiceTarget,
  fields: RuleFields,
): Promise<RedirectRule> {
  const { redirects } = requireService(deps, target).spec;
  if (redirects.length >= MAX_REDIRECT_RULES) {
    throw badRequest("too_many_redirects", `A service can have at most ${MAX_REDIRECT_RULES} redirects.`, {
      regex: `A service can have at most ${MAX_REDIRECT_RULES} redirects`,
    });
  }
  const rule: RedirectRule = { id: nanoid(), ...fields };
  await apply(deps, target, [...redirects, rule]);
  return rule;
}

function requireRule(rules: readonly RedirectRule[], id: string): RedirectRule {
  const rule = rules.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw notFound("This redirect does not exist.");
  }
  return rule;
}

export async function updateRedirect(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  fields: RuleFields,
): Promise<RedirectRule> {
  const { redirects } = requireService(deps, target).spec;
  requireRule(redirects, id);
  const updated: RedirectRule = { id, ...fields };
  await apply(
    deps,
    target,
    redirects.map((rule) => (rule.id === id ? updated : rule)),
  );
  return updated;
}

export async function deleteRedirect(deps: AppDeps, target: ServiceTarget, id: string): Promise<void> {
  const { redirects } = requireService(deps, target).spec;
  requireRule(redirects, id);
  await apply(
    deps,
    target,
    redirects.filter((rule) => rule.id !== id),
  );
}
