import type { MaintenanceSettings } from "@opsifier/contract";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ProxyPageName } from "../../core/proxy";
import { type PageLanguage, strings } from "./strings";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** Whatever was stored, the text can't end the style element it is written into. */
const sanitizeCss = (css: string): string => css.replace(/<\/style/gi, "<\\/style");

const MARK = `<svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true" width="40" height="40"><circle cx="16" cy="16" r="12.5" stroke="currentColor" stroke-width="4.2"/><path d="M14.3 3.62A12.5 12.5 0 0 1 17.7 3.62" stroke="#e3a33a" stroke-width="4.2"/><path d="M11.5 9.5H21.2V12.4H14.9V14.8H19.8V17.5H14.9V22.5H11.5Z" fill="currentColor"/></svg>`;

const BASE_STYLES = `
  :root { color-scheme: light dark; --bg: #ffffff; --ink: #16264a; --muted: #5b6781; --rule: #dfe3ec; --signal: #e3a33a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1b36; --ink: #ffffff; --muted: #a9b4ca; --rule: #2b3c63; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 400 15px/1.55 Poppins, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .page {
    min-height: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 64px 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
  }
  .logo { color: var(--ink); align-self: flex-start; max-width: 200px; max-height: 64px; height: auto; }
  .code {
    margin: 0;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    color: var(--muted);
    font: 500 13px/1 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
  }
  .code::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 8px;
    background: var(--signal);
  }
  .title { margin: 0; font-size: 26px; font-weight: 500; letter-spacing: -0.01em; line-height: 1.25; }
  .subtitle { margin: 0; color: var(--muted); max-width: 44ch; }
  .links { margin: 0; font-size: 14px; }
  .links a { color: inherit; text-underline-offset: 3px; }
`;

interface PageLayout {
  language: PageLanguage;
  documentTitle: string;
  status: number;
  title: string;
  message: string;
  logo: string;
  links: string;
  css: string;
}

function renderDocument(page: PageLayout): string {
  return `<!doctype html>
<html lang="${page.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.documentTitle)}</title>
<style>${BASE_STYLES}${page.css === "" ? "" : `\n${sanitizeCss(page.css)}`}</style>
</head>
<body>
<main class="page">
${page.logo}
<p class="code">${page.status}</p>
<h1 class="title">${escapeHtml(page.title)}</h1>
<p class="subtitle">${escapeHtml(page.message)}</p>
${page.links}
</main>
</body>
</html>
`;
}

const STATUS: Record<ProxyPageName, ContentfulStatusCode> = {
  "bad-gateway": 502,
  "not-found": 404,
  stopped: 503,
};

/** The pages the proxy shows on its own: the same for every site, so nothing here is user input. */
export function renderProxyPage(
  name: ProxyPageName,
  language: PageLanguage,
): { status: ContentfulStatusCode; html: string } {
  const copy = strings[language];
  const status = STATUS[name];
  return {
    status,
    html: renderDocument({
      language,
      documentTitle: copy.documentTitle[name],
      status,
      title: copy.pages[name].title,
      message: copy.pages[name].message,
      logo: MARK,
      links: `<p class="links"><a href="">${escapeHtml(copy.retry)}</a></p>`,
      css: "",
    }),
  };
}

/** A service's maintenance page. Title, subtitle and CSS come from its owner, so they are escaped. */
export function renderMaintenancePage(settings: MaintenanceSettings, language: PageLanguage): string {
  const copy = strings[language];
  const logo = settings.hideLogo
    ? ""
    : settings.customLogo === null
      ? MARK
      : `<img class="logo" alt="" src="${escapeHtml(settings.customLogo)}">`;
  return renderDocument({
    language,
    documentTitle: copy.documentTitle.maintenance,
    status: 503,
    title: settings.title === "" ? copy.maintenance.title : settings.title,
    message: settings.subtitle === "" ? copy.maintenance.message : settings.subtitle,
    logo,
    links: settings.hideLinks ? "" : `<p class="links"><a href="">${escapeHtml(copy.retry)}</a></p>`,
    css: settings.customCss,
  });
}
