import type { DbHandle } from "../../core/db";
import { findService } from "../services/repo";
import { findProject } from "./repo";

/** Something recorded for a project, and maybe one of its services, at a given moment. */
export interface Recorded {
  projectName: string | null;
  serviceName: string | null;
  createdAt: Date;
}

/**
 * Whether a record belongs to what has its names now. Backups, restores and the activity log outlive
 * their project and service on purpose, and a project or service made later under the same name is
 * not the one they were about: its people may never have been the earlier one's. A record made while
 * the service that has its name now existed belongs to it, wherever that service has moved since, and
 * one made while the project that has its name now existed belongs to that project.
 */
export function belongsToCurrent(db: DbHandle, record: Recorded): boolean {
  if (record.projectName === null) {
    return true;
  }
  if (record.serviceName !== null) {
    const service = findService(db, record.projectName, record.serviceName);
    if (service !== undefined && service.createdAt.getTime() <= record.createdAt.getTime()) {
      return true;
    }
  }
  const project = findProject(db, record.projectName);
  return project !== undefined && project.createdAt.getTime() <= record.createdAt.getTime();
}
