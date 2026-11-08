import { eq } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { settings } from "../../core/db/schema";

/** Base domain for the default hostname of new services. Its settings screen comes later. */
export const SERVICE_DOMAIN_KEY = "service_domain";

export function getSetting(db: DbHandle, key: string): unknown {
  return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value;
}

export function putSetting(db: DbHandle, key: string, value: unknown, updatedAt: Date): void {
  db.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run();
}
