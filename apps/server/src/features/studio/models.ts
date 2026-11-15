import { isIP } from "node:net";
import type { StudioModel, StudioModels } from "@opsifier/contract";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function hostOf(baseUrl: string | null): string | null {
  if (baseUrl === null) {
    return null;
  }
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function privateIPv4(host: string): boolean {
  const [a = -1, b = -1] = host.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/**
 * Whether what is sent to this host stays on private addresses: one's own machines and networks, a
 * container's name, or a name only a private network knows. A public name is an outside provider.
 */
export function isPrivateHost(host: string | null): boolean {
  if (host === null) {
    return false;
  }
  const version = isIP(host);
  if (version === 4) {
    return privateIPv4(host);
  }
  if (version === 6) {
    return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return host === "localhost" || !host.includes(".") || /\.(internal|local|lan|home\.arpa)$/.test(host);
}

/** `openai/Qwen/Qwen3.6-27B` reads `Qwen3.6-27B`: the provider's and the publisher's prefixes say little. */
function shortName(model: string): string {
  return model.split("/").at(-1) || model;
}

export function toStudioModel(profile: string | null, model: string, baseUrl: string | null): StudioModel {
  const host = hostOf(baseUrl);
  return { profile, name: shortName(model), host, private: isPrivateHost(host) };
}

interface Profile {
  name: string;
  model: string;
  baseUrl: string | null;
}

function readProfiles(answer: unknown): { active: string | null; profiles: Profile[] } {
  if (!isRecord(answer)) {
    return { active: null, profiles: [] };
  }
  const profiles = (Array.isArray(answer.profiles) ? answer.profiles : []).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const name = text(item.name);
    const model = text(item.model);
    return name === null || model === null ? [] : [{ name, model, baseUrl: text(item.base_url) }];
  });
  return { active: text(answer.active_profile), profiles };
}

/** GET /api/profiles of the agent server, as the Studio lists it. */
export function toStudioModels(answer: unknown): StudioModels {
  const { active, profiles } = readProfiles(answer);
  return {
    active,
    models: profiles.map((profile) => toStudioModel(profile.name, profile.model, profile.baseUrl)),
  };
}

/** The model of a conversation, named after the profile it matches when one does. */
export function conversationModel(llm: unknown, profilesAnswer: unknown): StudioModel | null {
  if (!isRecord(llm)) {
    return null;
  }
  const model = text(llm.model);
  if (model === null) {
    return null;
  }
  const baseUrl = text(llm.base_url);
  const match = readProfiles(profilesAnswer).profiles.find(
    (profile) => profile.model === model && (profile.baseUrl ?? null) === baseUrl,
  );
  return toStudioModel(match?.name ?? null, model, baseUrl);
}
