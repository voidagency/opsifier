import { useEffect } from "react";

/** Names the browser tab after the current screen. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Opsifier` : "Opsifier";
  }, [title]);
}
