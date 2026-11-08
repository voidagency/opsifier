import { eq } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { settings } from "../../core/db/schema";

export function deleteSetting(db: DbHandle, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
