import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SystemAbout, type ThirdPartyComponent, thirdPartyComponent } from "@opsifier/contract";
import { z } from "zod";
import type { AppDeps } from "../../core/context";

export const LICENSE = "Apache-2.0";
export const COPYRIGHT = "Copyright 2026 Opsifier contributors";
export const SOURCE_URL = "https://github.com/voidagency/opsifier";
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;

const components = z.array(thirdPartyComponent);

/** Read once: the image's notices never change while the panel runs. */
let cached: { dir: string; list: ThirdPartyComponent[] | null } | undefined;

/** What the image lists in `components.json`, written while it was built. Null outside the image. */
function shippedComponents(dir: string): ThirdPartyComponent[] | null {
  if (cached?.dir === dir) {
    return cached.list;
  }
  let list: ThirdPartyComponent[] | null = null;
  try {
    list = components.parse(JSON.parse(readFileSync(join(dir, "components.json"), "utf8")));
  } catch {
    list = null;
  }
  cached = { dir, list };
  return list;
}

export function getSystemAbout(deps: Pick<AppDeps, "config">): SystemAbout {
  const { noticesDir, version } = deps.config;
  const list = shippedComponents(noticesDir);
  return {
    version,
    license: LICENSE,
    copyright: COPYRIGHT,
    sourceUrl: SOURCE_URL,
    licenseUrl: LICENSE_URL,
    noticesFile: list === null ? null : join(noticesDir, "THIRD-PARTY-NOTICES.txt"),
    components: list ?? [],
  };
}
