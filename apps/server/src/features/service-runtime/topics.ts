import { projectName, resourceName } from "@opsifier/contract";
import type { ServiceRef } from "./repo";

/** Reads `<prefix><project>/<service>`. Null for anything else, so a bad topic never reaches Docker. */
export function parseServiceTopic(topic: string, prefix: string): ServiceRef | null {
  if (!topic.startsWith(prefix)) {
    return null;
  }
  const [project, service, ...rest] = topic.slice(prefix.length).split("/");
  if (
    rest.length > 0 ||
    !projectName.safeParse(project).success ||
    !resourceName.safeParse(service).success
  ) {
    return null;
  }
  return { projectName: project as string, serviceName: service as string };
}
