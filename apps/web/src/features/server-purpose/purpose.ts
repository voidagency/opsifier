import type { DomainProtection, ServerPurpose } from "@opsifier/contract";
import type { PictogramName, VisualState } from "../../ui";
import "./purpose.css";

/** Each purpose has its own pictogram, colour and label, wherever it is shown. */
export const purposeLook: Record<ServerPurpose, { pictogram: PictogramName; color: string }> = {
  development: { pictogram: "development", color: "var(--purpose-development)" },
  staging: { pictogram: "staging", color: "var(--purpose-staging)" },
  production: { pictogram: "production", color: "var(--purpose-production)" },
};

/** Exposed is the failure nobody should see, public is simply how a production server works. */
export function stateFromProtection(status: DomainProtection): VisualState {
  const states: Record<DomainProtection, VisualState> = {
    exposed: "failed",
    protected: "running",
    public: "stopped",
  };
  return states[status];
}
