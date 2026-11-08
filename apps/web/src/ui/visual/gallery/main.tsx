import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../../theme.css";
import "../../../i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BothThemes, Gallery } from "./Gallery";

/**
 * The visual language review page. It lives at /src/ui/visual/gallery/ on the Vite dev server,
 * and because nothing imports it, `vite build` leaves it out: it cannot exist in production.
 */
const container = document.getElementById("root");
if (!container) {
  throw new Error("The page has no #root element");
}

const theme = new URLSearchParams(location.search).get("theme");

createRoot(container).render(
  <StrictMode>{theme === "light" || theme === "dark" ? <Gallery /> : <BothThemes />}</StrictMode>,
);
