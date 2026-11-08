import { type EnvDocument, envDocument } from "../env";

/** GET and PUT /api/v1/projects/{project}/services/{service}/environment */
export const serviceEnvironment = envDocument;
export type ServiceEnvironment = EnvDocument;
