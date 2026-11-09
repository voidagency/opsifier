import { isDatabaseEngine } from "@opsifier/contract";

/** Where a service's page lives. Databases have their own URLs, named after their engine. */
export function servicePageLink(project: string, name: string, type: string) {
  if (type === "compose") {
    return { to: "/projects/$project/compose/$service/", params: { project, service: name } } as const;
  }
  if (type === "box") {
    return { to: "/projects/$project/box/$service/", params: { project, service: name } } as const;
  }
  return isDatabaseEngine(type)
    ? ({
        to: "/projects/$project/$engine/$service/",
        params: { project, engine: type, service: name },
      } as const)
    : ({ to: "/projects/$project/app/$service/", params: { project, service: name } } as const);
}
