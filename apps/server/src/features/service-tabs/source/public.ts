import type { ServiceSource } from "@opsifier/contract";
import type { StoredSource } from "./stored";

/** The API's view of a source: everything but the sealed parts. */
export function toPublicSource(source: StoredSource): ServiceSource {
  switch (source.type) {
    case "image":
      return {
        type: "image",
        image: source.image,
        username: source.username,
        hasPassword: source.sealedPassword !== null,
      };
    case "github":
      return {
        type: "github",
        repository: source.repository,
        ref: source.ref,
        path: source.path,
        autoDeploy: source.webhookId !== null,
      };
    case "git":
      return { type: "git", url: source.url, ref: source.ref, path: source.path };
    case "dockerfile":
      return { type: "dockerfile", dockerfile: source.dockerfile };
    case "upload":
      return {
        type: "upload",
        fileName: source.fileName,
        sizeBytes: source.sizeBytes,
        uploadedAt: source.uploadedAt,
        path: source.path,
      };
  }
}
