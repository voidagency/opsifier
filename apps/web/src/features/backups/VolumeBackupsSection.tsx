import { useServiceParams } from "../services/api";
import { BackupsPanel } from "./BackupsPanel";

/** The Storage tab's own section for copies of named volumes. */
export function VolumeBackupsSection() {
  const { project, service } = useServiceParams();
  return <BackupsPanel project={project} service={service} scope="volume" />;
}
