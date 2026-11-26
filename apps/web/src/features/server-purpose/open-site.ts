import { useQuery } from "@tanstack/react-query";
import { type MouseEvent, useCallback } from "react";
import { withBinding } from "../../lib/session-binding";
import { purposeQuery } from "./api";

/** The panel's hop to one of this server's sites, which takes someone signed in past the site's gate. */
export const siteHop = (url: string): string =>
  withBinding(`/api/v1/server-purpose/open?${new URLSearchParams({ url })}`);

/**
 * Opens a link to one of this server's sites through the panel's hop while its sites ask for the
 * server's password, so that the browser goes in without it. The link keeps the site's own address,
 * to read and to copy; a click with a key held, or the browser's own "open in a new tab", opens that
 * address as it is, where a browser that got in once this week goes in again.
 */
export function useOpenSite(): (event: MouseEvent<HTMLAnchorElement>, url: string) => void {
  const { data } = useQuery(purposeQuery);
  const gated = data?.protection === true;
  return useCallback(
    (event, url) => {
      const plain =
        event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (!gated || !plain || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      window.open(siteHop(url), "_blank", "noopener,noreferrer");
    },
    [gated],
  );
}
