/*
 * Opsifier Studio inspector. Every page of a Studio project's preview loads it, from the panel.
 *
 * In the Studio's preview frame, it lets the person in the Studio point at one of the page's elements:
 * hovering outlines it, a click sends what it is to the Studio, which joins it to the next message for
 * the agent. It tells the Studio which address the page is at, and pins on the page the remarks the
 * Studio sends it.
 *
 * Opened in a browser tab of its own, from a client's link most often, it shows the remarks tool once
 * the address says ?remarks=1, and until one says ?remarks=0: a pin on each remark of the page, the
 * list of them all, and a way to point at an element and write one. The tool talks to the panel at
 * /__opsifier/studio/remarks, on the preview's own address, with the page's own cookies.
 *
 * The Studio and the page talk with postMessage. From the Studio: { source: "opsifier-studio",
 * type: "inspect", on }, { type: "ping" }, { type: "remarks", items } and { type: "focus-remark", id }.
 * From the page: { source: "opsifier-studio-preview", type: "ready" | "location" | "selected" |
 * "inspect-ended" | "remark", ... }. Only the frame's parent is listened to, and once it has spoken,
 * only its origin is answered.
 */
(() => {
  if (window.__opsifierStudioInspector) {
    return;
  }
  window.__opsifierStudioInspector = true;

  const framed = window.parent !== window;
  const FROM_STUDIO = "opsifier-studio";
  const TO_STUDIO = "opsifier-studio-preview";
  const ACCENT = "#f97316";
  const API = "/__opsifier/studio/remarks";
  const FLAG = "remarks";
  const FLAG_COOKIE = "opsifier_studio_remarks";
  const MODE_KEY = "opsifier-studio-remarks";
  const FOCUS_KEY = "opsifier-studio-remarks-focus";
  const REFRESH_MS = 20000;

  const french = /^fr\b/i.test(navigator.language || "");
  const TEXT = french
    ? {
        remarks: "Remarques",
        add: "Ajouter une remarque",
        hide: "Masquer les remarques",
        show: "Afficher les remarques",
        picking: "Cliquez sur l'élément à commenter",
        escape: "Échap annule",
        cancel: "Annuler",
        send: "Envoyer",
        placeholder: "Votre remarque sur cet élément…",
        sent: "Remarque envoyée",
        failed: "La remarque n'a pas pu être envoyée. Réessayez.",
        tooMany: "Beaucoup de remarques d'un coup : patientez une minute.",
        full: "Ce projet a déjà beaucoup de remarques : l'équipe les traite d'abord.",
        takeBack: "Retirer",
        takenBack: "Remarque retirée",
        close: "Fermer",
        you: "Vous êtes",
        thisPage: "Sur cette page",
        otherPages: "Sur d'autres pages",
        none: "Aucune remarque pour l'instant. Ajoutez la première : cliquez sur un élément de la page.",
        missing: "Élément plus visible sur la page",
        noAccess: "Pour laisser des remarques, ouvrez le lien qu'on vous a envoyé.",
        remark: "Remarque",
        status: { new: "À traiter", in_progress: "En cours", done: "Traitée" },
        shortcut: "Ctrl+Entrée envoie",
      }
    : {
        remarks: "Remarks",
        add: "Add a remark",
        hide: "Hide the remarks",
        show: "Show the remarks",
        picking: "Click the element to comment on",
        escape: "Escape cancels",
        cancel: "Cancel",
        send: "Send",
        placeholder: "Your remark on this element…",
        sent: "Remark sent",
        failed: "The remark could not be sent. Try again.",
        tooMany: "Many remarks at once: wait a minute.",
        full: "This project has many remarks already: the team deals with them first.",
        takeBack: "Take back",
        takenBack: "Remark taken back",
        close: "Close",
        you: "You are",
        thisPage: "On this page",
        otherPages: "On other pages",
        none: "No remark yet. Add the first one: click an element of the page.",
        missing: "Element no longer on the page",
        noAccess: "To leave remarks, open the link you were sent.",
        remark: "Remark",
        status: { new: "To do", in_progress: "In progress", done: "Done" },
        shortcut: "Ctrl+Enter sends",
      };
  const STATUS_COLORS = { new: ACCENT, in_progress: "#2563eb", done: "#6b7280" };

  let studioOrigin = null;
  let overlay = null;
  let badge = null;
  let hovered = null;
  /** While someone points at an element: what a click does, and what Escape does. */
  let picker = null;

  const post = (message) => {
    if (framed) {
      window.parent.postMessage({ source: TO_STUDIO, ...message }, studioOrigin ?? "*");
    }
  };
  const where = () => location.pathname + location.search + location.hash;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /** The names of the React components around an element, nearest first, as a development build keeps them. */
  function componentsOf(element) {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
    const names = [];
    let fiber = key ? element[key] : null;
    while (fiber && names.length < 4) {
      const type = fiber.type;
      if (typeof type === "function" || (type && typeof type === "object" && type.$$typeof)) {
        const name = type.displayName || type.name || type.render?.displayName || type.render?.name;
        if (name && !names.includes(name) && /^[A-Z]/.test(name)) {
          names.push(name);
        }
      }
      fiber = fiber.return;
    }
    return names;
  }

  const identifier = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

  /** A CSS selector short enough to read, precise enough to find the element again. */
  function selectorOf(element) {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id && identifier.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const name = [...node.classList].find((one) => identifier.test(one) && !one.includes(":"));
      if (name) {
        part += `.${name}`;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) {
          part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function describe(element) {
    const attributes = {};
    for (const name of [
      "id",
      "href",
      "src",
      "alt",
      "title",
      "aria-label",
      "role",
      "name",
      "type",
      "placeholder",
    ]) {
      const value = element.getAttribute(name);
      if (value) {
        attributes[name] = value.slice(0, 200);
      }
    }
    // The text as the page shows it: what the person pointed at, without what is hidden.
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered text is the point here
    const shown = element.innerText || element.textContent || "";
    return {
      tag: element.tagName.toLowerCase(),
      text: shown.replace(/\s+/g, " ").trim().slice(0, 160),
      classes: [...element.classList].slice(0, 10),
      attributes,
      selector: selectorOf(element),
      components: componentsOf(element),
      path: where(),
    };
  }

  // The outline that follows the pointer while someone points at an element.
  function outline(element) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;border:2px solid ${ACCENT};border-radius:3px;background:rgba(249,115,22,0.08);transition:all 60ms ease-out;`;
      badge = document.createElement("div");
      badge.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;background:${ACCENT};color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:3px;white-space:nowrap;`;
      document.documentElement.append(overlay, badge);
    }
    const box = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: "block",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const component = componentsOf(element)[0];
    badge.textContent = component
      ? `${component} · ${element.tagName.toLowerCase()}`
      : element.tagName.toLowerCase();
    Object.assign(badge.style, {
      display: "block",
      left: `${Math.max(0, box.left)}px`,
      top: `${box.top > 20 ? box.top - 19 : box.bottom + 2}px`,
    });
  }

  function hideOutline() {
    if (overlay) {
      overlay.style.display = "none";
      badge.style.display = "none";
    }
    hovered = null;
  }

  // ---- The layer the pins and the remarks tool live in, apart from the page's own styles. ----

  let host = null;
  let shadow = null;
  let pinLayer = null;
  let chrome = null;
  const isOurs = (node) => host !== null && (node === host || host.contains(node));

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
    svg { width: 16px; height: 16px; display: block; flex: none; }
    .pin { position: fixed; top: 0; left: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 999px;
      border: 2px solid #fff; box-shadow: 0 2px 6px rgba(15, 23, 42, .35); color: #fff; font: 700 12px/22px system-ui, sans-serif;
      text-align: center; pointer-events: auto; transition: transform 120ms ease-out; }
    .pin:hover, .pin.open { transform: scale(1.15); }
    .pin svg { width: 14px; height: 14px; margin: 4px auto 0; }
    .pin.draft { background: ${ACCENT}; opacity: .85; }
    .pin.focus { animation: pulse 900ms ease-out 3; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, .75); } 100% { box-shadow: 0 0 0 16px rgba(249, 115, 22, 0); } }
    .tip { position: fixed; max-width: 260px; background: #16264a; color: #fff; font-size: 12px; line-height: 1.4;
      padding: 6px 8px; border-radius: 6px; pointer-events: none; white-space: pre-wrap; }
    .dock { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 2px; padding: 4px;
      background: #fff; color: #16264a; border: 1px solid #dfe3ec; border-radius: 999px;
      box-shadow: 0 8px 28px rgba(22, 38, 74, .18); pointer-events: auto; font-size: 14px; }
    .dock button { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 999px; white-space: nowrap; }
    .dock button:hover { background: #f1f3f8; }
    .dock .primary { background: #16264a; color: #fff; }
    .dock .primary:hover { background: #22366a; }
    .dock .icon { width: 36px; padding: 0; justify-content: center; }
    .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: ${ACCENT}; color: #fff;
      font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
    .round { position: fixed; right: 16px; bottom: 16px; width: 44px; height: 44px; border-radius: 999px; background: #16264a;
      color: #fff; display: flex; align-items: center; justify-content: center; pointer-events: auto;
      box-shadow: 0 8px 28px rgba(22, 38, 74, .25); }
    .round .count { position: absolute; top: -4px; right: -4px; }
    .box { position: fixed; background: #fff; color: #16264a; border: 1px solid #dfe3ec; border-radius: 12px;
      box-shadow: 0 12px 36px rgba(22, 38, 74, .2); pointer-events: auto; font-size: 14px; line-height: 1.45; }
    .panel { right: 16px; bottom: 68px; width: min(340px, calc(100vw - 32px)); max-height: min(60vh, 480px); overflow: auto; padding: 12px; }
    .card, .composer { top: 0; left: 0; width: min(300px, calc(100vw - 24px)); padding: 12px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .head .grow { flex: 1; min-width: 0; font-weight: 600; }
    .bubble { flex: none; width: 22px; height: 22px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 700;
      line-height: 22px; text-align: center; }
    .status { font-size: 12px; font-weight: 600; }
    .muted { color: #5b6781; font-size: 12px; }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 10px; }
    .chip { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 12px/1.6 ui-monospace, "SFMono-Regular", Menlo, monospace; background: #f6f7fa; border: 1px solid #dfe3ec;
      border-radius: 4px; padding: 0 6px; }
    textarea { display: block; width: 100%; min-height: 88px; margin: 8px 0; resize: vertical; border: 1px solid #dfe3ec;
      border-radius: 8px; padding: 8px; font: inherit; color: inherit; background: #fff; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
    .actions .grow { flex: 1; }
    .button { height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid #dfe3ec; font-weight: 500; }
    .button:hover { background: #f1f3f8; }
    .button.primary { background: #16264a; border-color: #16264a; color: #fff; }
    .button.primary:hover { background: #22366a; }
    .button:disabled { opacity: .5; cursor: default; }
    .error { color: #be2453; font-size: 12px; margin-top: 6px; }
    .section { margin: 10px 0 4px; font-size: 12px; font-weight: 600; color: #5b6781; text-transform: uppercase; letter-spacing: .04em; }
    .item { display: flex; gap: 8px; width: 100%; padding: 8px; border-radius: 8px; text-align: left; align-items: flex-start; }
    .item:hover { background: #f6f7fa; }
    .item .grow { flex: 1; min-width: 0; }
    .item .line { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      background: #16264a; color: #fff; padding: 8px 8px 8px 14px; border-radius: 999px; pointer-events: auto; font-size: 13px;
      box-shadow: 0 8px 28px rgba(22, 38, 74, .25); white-space: nowrap; max-width: calc(100vw - 24px); }
    .banner button { height: 28px; padding: 0 10px; border-radius: 999px; background: rgba(255, 255, 255, .14); }
    .toast { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); background: #16264a; color: #fff;
      padding: 8px 14px; border-radius: 999px; font-size: 13px; pointer-events: none; }
    .notice { position: fixed; right: 16px; bottom: 16px; max-width: min(340px, calc(100vw - 32px)); display: flex; gap: 10px;
      align-items: flex-start; padding: 12px; }
    @media (max-width: 560px) {
      .dock .label { display: none; }
      .card, .composer { left: 12px !important; right: 12px; top: auto !important; bottom: 68px; width: auto; }
      .banner .hint { display: none; }
    }
  `;

  const ICONS = {
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    hide: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  function icon(name) {
    const span = document.createElement("span");
    // The icons are this file's own constants: nothing from the page or the panel goes in here.
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
  }

  /** A small element, its properties and its children: text is always set as text. */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key === "style") {
        node.style.cssText = value;
      } else if (key.startsWith("on")) {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child instanceof Node ? child : String(child));
      }
    }
    return node;
  }

  function layer() {
    if (shadow) {
      if (!host.isConnected) {
        document.documentElement.append(host);
      }
      return shadow;
    }
    host = document.createElement("opsifier-studio-remarks");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "open" });
    pinLayer = h("div");
    chrome = h("div");
    shadow.append(h("style", { text: STYLE }), pinLayer, chrome);
    document.documentElement.append(host);
    return shadow;
  }

  // ---- Remarks and their pins: what the Studio sends in its frame, or the panel answers here. ----

  /** The remarks of the project. In the Studio's frame, what the Studio sent; here, what the panel said. */
  let remarks = [];
  /** Whoever is here, as the panel knows them: the tool's own, outside the Studio's frame. */
  let viewer = null;
  let pinsOn = false;
  const pins = new Map();
  let tip = null;
  let focusId = null;

  const pageOf = (path) => {
    try {
      return new URL(path, location.origin).pathname;
    } catch {
      return path;
    }
  };
  const onThisPage = (remark) => pageOf(remark.path) === location.pathname;
  const selectorOfRemark = (remark) => remark.selector || remark.element?.selector || "";

  function elementOf(remark) {
    const selector = selectorOfRemark(remark);
    if (!selector) {
      return null;
    }
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  /** Where a remark's pin goes on the screen, or null when its element is not on the page. */
  function placeOf(element, point) {
    if (!element?.isConnected) {
      return null;
    }
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return null;
    }
    const at = point || { x: 1, y: 0 };
    return { x: box.left + at.x * box.width, y: box.top + at.y * box.height };
  }

  function paintPin(pin, remark) {
    pin.style.background = STATUS_COLORS[remark.status] || ACCENT;
    const label = `${TEXT.remark} ${remark.number} · ${TEXT.status[remark.status] || ""}`;
    if (pin.dataset.status !== remark.status || pin.dataset.number !== String(remark.number)) {
      pin.dataset.status = remark.status;
      pin.dataset.number = String(remark.number);
      pin.replaceChildren(remark.status === "done" ? icon("check") : String(remark.number));
      pin.setAttribute("aria-label", label);
    }
    pin.classList.toggle("open", remark.id === openId);
  }

  function showTip(pin, remark) {
    layer();
    tip?.remove();
    const words = remark.text.length > 140 ? `${remark.text.slice(0, 139)}…` : remark.text;
    tip = h("div", { class: "tip", text: `${remark.number} · ${remark.author}\n${words}` });
    shadow.append(tip);
    const box = pin.getBoundingClientRect();
    const width = tip.offsetWidth;
    tip.style.left = `${clamp(box.left + box.width / 2 - width / 2, 8, innerWidth - width - 8)}px`;
    tip.style.top = `${box.bottom + 6 > innerHeight - 60 ? box.top - tip.offsetHeight - 6 : box.bottom + 6}px`;
  }

  function makePin(remark) {
    const pin = h("button", { class: "pin", type: "button" });
    pin.addEventListener("mouseenter", () => {
      const current = remarks.find((one) => one.id === pin.dataset.id);
      if (current && framed) {
        showTip(pin, current);
      }
    });
    pin.addEventListener("mouseleave", () => {
      tip?.remove();
      tip = null;
    });
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = pin.dataset.id;
      if (framed) {
        post({ type: "remark", id });
      } else {
        openCard(openId === id ? null : id);
      }
    });
    pin.dataset.id = remark.id;
    return pin;
  }

  let scheduled = false;
  /**
   * Lays the pins out at the next frame. A browser that holds frames back, as for a frame out of sight
   * or an embedded view, still gets it a moment later.
   */
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    const run = () => {
      if (scheduled) {
        scheduled = false;
        layout();
      }
    };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  /** Puts each pin, and the card or the composer beside its pin, where its element is now. */
  function layout() {
    if (!shadow) {
      return;
    }
    layer();
    const shown = pinsOn ? remarks.filter(onThisPage) : [];
    const kept = new Set();
    for (const remark of shown) {
      const place = placeOf(elementOf(remark), remark.point);
      let pin = pins.get(remark.id);
      if (place === null) {
        if (pin) {
          pin.style.display = "none";
        }
        continue;
      }
      if (!pin) {
        pin = makePin(remark);
        pins.set(remark.id, pin);
        pinLayer.append(pin);
      }
      paintPin(pin, remark);
      pin.style.display = "";
      pin.style.left = `${place.x}px`;
      pin.style.top = `${place.y}px`;
      kept.add(remark.id);
    }
    for (const [id, pin] of pins) {
      if (!kept.has(id)) {
        pin.remove();
        pins.delete(id);
      }
    }
    if (focusId !== null) {
      const pin = pins.get(focusId);
      if (pin && pin.style.display !== "none") {
        pin.classList.remove("focus");
        void pin.offsetWidth;
        pin.classList.add("focus");
        setTimeout(() => pin.classList.remove("focus"), 2800);
      }
      focusId = null;
    }
    placeDraft();
    placeBeside(cardNode, openId === null ? null : pins.get(openId));
    placeBeside(composerNode, draftPin);
  }

  function placeBeside(box, pin) {
    if (!box?.isConnected) {
      return;
    }
    if (!pin || pin.style.display === "none" || innerWidth <= 560) {
      box.style.left = "";
      box.style.top = "";
      if (innerWidth > 560) {
        box.style.left = `${innerWidth - box.offsetWidth - 16}px`;
        box.style.top = `${Math.max(16, innerHeight - box.offsetHeight - 76)}px`;
      }
      return;
    }
    const at = pin.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const right = at.right + 10;
    const left = right + width <= innerWidth - 12 ? right : at.left - width - 10;
    box.style.left = `${clamp(left, 12, innerWidth - width - 12)}px`;
    box.style.top = `${clamp(at.top - 8, 12, innerHeight - height - 12)}px`;
  }

  /** Brings a remark's pin into view, and makes it pulse. */
  function focusRemark(id) {
    const remark = remarks.find((one) => one.id === id);
    if (!remark) {
      return;
    }
    if (!framed && !onThisPage(remark)) {
      // Only ever a page of this preview, whatever the remark says its page is.
      let page = null;
      try {
        page = new URL(remark.path, location.origin);
      } catch {}
      if (page === null || page.origin !== location.origin) {
        return;
      }
      try {
        sessionStorage.setItem(FOCUS_KEY, id);
      } catch {}
      location.assign(page.pathname + page.search + page.hash);
      return;
    }
    elementOf(remark)?.scrollIntoView({ block: "center", behavior: "smooth" });
    focusId = id;
    if (!framed) {
      openCard(id);
    }
    schedule();
    // Smooth scrolling ends later than this frame: the pins follow it, and pulse where it stops.
    setTimeout(() => {
      focusId = id;
      schedule();
    }, 450);
  }

  let watching = false;
  /** Pins follow their elements as the page scrolls, resizes, or changes under them. */
  function watch() {
    if (watching) {
      return;
    }
    watching = true;
    addEventListener("scroll", schedule, { capture: true, passive: true });
    addEventListener("resize", schedule, { passive: true });
    if (typeof MutationObserver === "function") {
      new MutationObserver((changes) => {
        if (changes.some((change) => !isOurs(change.target))) {
          schedule();
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    setInterval(() => {
      if (pins.size > 0 || draftPin) {
        schedule();
      }
    }, 1000);
  }

  // ---- Pointing at an element: for the Studio's message, or for a remark here. ----

  function startPicking(onPick, onCancel) {
    picker = { onPick, onCancel };
    document.documentElement.style.cursor = "crosshair";
  }

  function stopPicking() {
    picker = null;
    document.documentElement.style.cursor = "";
    hideOutline();
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!picker) {
        return;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target && target !== hovered && target !== overlay && target !== badge && !isOurs(target)) {
        hovered = target;
        outline(target);
      }
    },
    true,
  );

  // A click while pointing picks the element, and does nothing else: no link followed, no button pressed.
  for (const kind of ["pointerdown", "mousedown", "mouseup", "click"]) {
    document.addEventListener(
      kind,
      (event) => {
        if (!picker || isOurs(event.target)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (kind === "click") {
          const target = document.elementFromPoint(event.clientX, event.clientY) || hovered;
          const { onPick } = picker;
          stopPicking();
          if (target && !isOurs(target)) {
            onPick(target, event);
          }
        }
      },
      true,
    );
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (picker && event.key === "Escape") {
        event.preventDefault();
        const { onCancel } = picker;
        stopPicking();
        onCancel();
      }
    },
    true,
  );
  addEventListener("scroll", () => picker && hovered && outline(hovered), true);

  // ---- In the Studio's frame: the Studio says what to do. ----

  if (framed) {
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || !event.data || event.data.source !== FROM_STUDIO) {
        return;
      }
      studioOrigin = event.origin;
      const data = event.data;
      if (data.type === "inspect") {
        if (data.on) {
          startPicking(
            (element) => post({ type: "selected", element: describe(element) }),
            () => post({ type: "inspect-ended" }),
          );
        } else {
          stopPicking();
        }
      } else if (data.type === "ping") {
        post({ type: "ready", path: where() });
      } else if (data.type === "remarks") {
        remarks = Array.isArray(data.items)
          ? data.items.filter((item) => item && typeof item.id === "string")
          : [];
        pinsOn = remarks.length > 0;
        if (pinsOn) {
          layer();
          watch();
        }
        schedule();
      } else if (data.type === "focus-remark" && typeof data.id === "string") {
        focusRemark(data.id);
      }
    });
  }

  // ---- In a tab of its own: the remarks tool, when the address asks for it. ----

  /** "on", "collapsed" to a button, or "off". */
  let mode = "off";
  let listOpen = false;
  let openId = null;
  let cardNode = null;
  let notice = null;
  /** The remark being written: its element, where in it, and its composer. */
  let draft = null;
  let draftPin = null;
  let composerNode = null;
  let toastTimer = null;

  function readMode() {
    const params = new URLSearchParams(location.search);
    // A client's link says it with a cookie too, which follows a site that sends its home page on to
    // another, as many do for their language. Read once, it goes.
    const fromLink = new RegExp(`(?:^|;\\s*)${FLAG_COOKIE}=1(?:;|$)`).test(document.cookie);
    if (fromLink) {
      // biome-ignore lint/suspicious/noDocumentCookie: every browser a client may use has this one
      document.cookie = `${FLAG_COOKIE}=; Max-Age=0; Path=/${location.protocol === "https:" ? "; Secure" : ""}`;
    }
    const asked = params.has(FLAG) ? params.get(FLAG) !== "0" : fromLink ? true : null;
    let stored = null;
    try {
      if (asked !== null) {
        sessionStorage.setItem(MODE_KEY, asked ? "on" : "off");
      }
      stored = sessionStorage.getItem(MODE_KEY);
    } catch {
      stored = asked ? "on" : null;
    }
    if (params.has(FLAG)) {
      // The flag has been read: the address goes back to the page's own.
      params.delete(FLAG);
      const query = params.toString();
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
      );
    }
    return stored === "on" || stored === "collapsed" ? stored : "off";
  }

  function saveMode(next) {
    mode = next;
    try {
      sessionStorage.setItem(MODE_KEY, next);
    } catch {}
  }

  async function load() {
    try {
      const response = await fetch(API, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        viewer = null;
        notice = TEXT.noAccess;
        return true;
      }
      if (!response.ok || !(response.headers.get("content-type") || "").includes("json")) {
        return false;
      }
      const data = await response.json();
      const next = Array.isArray(data.remarks) ? data.remarks : [];
      const changed = JSON.stringify(next) !== JSON.stringify(remarks) || viewer === null;
      viewer = data.viewer || null;
      remarks = next;
      notice = null;
      if (changed) {
        render();
        schedule();
      }
      return true;
    } catch {
      return false;
    }
  }

  function toast(message) {
    layer();
    shadow.querySelector(".toast")?.remove();
    const node = h("div", { class: "toast", role: "status", text: message });
    shadow.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 2600);
  }

  const openCount = () => remarks.filter((remark) => remark.status !== "done").length;
  const date = (value) => {
    try {
      return new Date(value).toLocaleString(navigator.language || undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };
  const elementLine = (remark) => {
    const element = remark.element;
    if (!element) {
      return null;
    }
    const words = element.text
      ? ` « ${element.text.length > 40 ? `${element.text.slice(0, 39)}…` : element.text} »`
      : "";
    return h("span", { class: "chip", text: `<${element.tag}>${words}` });
  };
  const bubble = (remark) =>
    h(
      "span",
      { class: "bubble", style: `background:${STATUS_COLORS[remark.status] || ACCENT}` },
      remark.status === "done" ? icon("check") : String(remark.number),
    );

  function openCard(id) {
    openId = id;
    if (id !== null) {
      cancelDraft();
      listOpen = false;
    }
    render();
    schedule();
  }

  function card(remark) {
    const color = STATUS_COLORS[remark.status] || ACCENT;
    const takeBack =
      remark.mine && remark.status === "new"
        ? h("button", {
            class: "button",
            type: "button",
            text: TEXT.takeBack,
            onclick: async () => {
              const response = await fetch(`${API}/${encodeURIComponent(remark.id)}`, {
                method: "DELETE",
                credentials: "same-origin",
              }).catch(() => null);
              if (response?.ok) {
                remarks = remarks.filter((one) => one.id !== remark.id);
                openCard(null);
                toast(TEXT.takenBack);
              } else {
                await load();
                render();
              }
            },
          })
        : null;
    return h(
      "div",
      { class: "box card", role: "dialog", "aria-label": `${TEXT.remark} ${remark.number}` },
      h(
        "div",
        { class: "head" },
        bubble(remark),
        h("span", { class: "grow", text: `${TEXT.remark} ${remark.number}` }),
        h("span", { class: "status", style: `color:${color}`, text: TEXT.status[remark.status] || "" }),
      ),
      h("div", { class: "muted", text: `${remark.author} · ${date(remark.createdAt)}` }),
      h("p", { class: "text", text: remark.text }),
      h(
        "div",
        { class: "actions" },
        takeBack,
        h("button", { class: "button", type: "button", text: TEXT.close, onclick: () => openCard(null) }),
      ),
    );
  }

  function list() {
    const here = remarks.filter(onThisPage);
    const elsewhere = remarks.filter((remark) => !onThisPage(remark));
    const item = (remark) => {
      const missing = onThisPage(remark) && !elementOf(remark);
      return h(
        "button",
        {
          class: "item",
          type: "button",
          onclick: () => {
            listOpen = false;
            focusRemark(remark.id);
            render();
          },
        },
        bubble(remark),
        h(
          "span",
          { class: "grow" },
          h("span", { class: "line", text: remark.text }),
          h("span", {
            class: "muted",
            text: [
              onThisPage(remark) ? null : pageOf(remark.path),
              TEXT.status[remark.status],
              missing ? TEXT.missing : null,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
        ),
      );
    };
    return h(
      "div",
      { class: "box panel", role: "dialog", "aria-label": TEXT.remarks },
      h(
        "div",
        { class: "head" },
        h("span", { class: "grow", text: `${TEXT.remarks} (${remarks.length})` }),
        h(
          "button",
          {
            class: "button",
            type: "button",
            "aria-label": TEXT.close,
            onclick: () => {
              listOpen = false;
              render();
            },
          },
          icon("close"),
        ),
      ),
      viewer ? h("div", { class: "muted", text: `${TEXT.you} ${viewer.name}` }) : null,
      remarks.length === 0 ? h("p", { class: "text", text: TEXT.none }) : null,
      here.length > 0 ? h("div", { class: "section", text: TEXT.thisPage }) : null,
      here.map(item),
      elsewhere.length > 0 ? h("div", { class: "section", text: TEXT.otherPages }) : null,
      elsewhere.map(item),
    );
  }

  function beginDraft(element, event) {
    const box = element.getBoundingClientRect();
    const point = {
      x: clamp(box.width > 0 ? (event.clientX - box.left) / box.width : 0.5, 0, 1),
      y: clamp(box.height > 0 ? (event.clientY - box.top) / box.height : 0.5, 0, 1),
    };
    draft = { element, point, description: describe(element) };
    openId = null;
    listOpen = false;
    composerNode = composer();
    render();
    schedule();
    composerNode.querySelector("textarea")?.focus();
  }

  function cancelDraft() {
    draft = null;
    composerNode = null;
    draftPin?.remove();
    draftPin = null;
  }

  function placeDraft() {
    if (!draft) {
      draftPin?.remove();
      draftPin = null;
      return;
    }
    const place = placeOf(draft.element, draft.point);
    if (!draftPin) {
      draftPin = h("span", { class: "pin draft", "aria-hidden": "true" }, icon("plus"));
      pinLayer.append(draftPin);
    }
    draftPin.style.display = place ? "" : "none";
    if (place) {
      draftPin.style.left = `${place.x}px`;
      draftPin.style.top = `${place.y}px`;
    }
  }

  function composer() {
    const field = h("textarea", {
      "aria-label": TEXT.placeholder,
      placeholder: TEXT.placeholder,
      maxlength: "2000",
    });
    const error = h("div", { class: "error", role: "alert" });
    const send = h("button", { class: "button primary", type: "submit", text: TEXT.send });
    const submit = async () => {
      const text = field.value.trim();
      if (!text || !draft || send.disabled) {
        return;
      }
      send.disabled = true;
      error.textContent = "";
      const response = await fetch(API, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          path: where(),
          text,
          element: draft.description,
          point: draft.point,
          viewport: { width: Math.round(innerWidth), height: Math.round(innerHeight) },
        }),
      }).catch(() => null);
      send.disabled = false;
      if (response?.status === 201) {
        const body = await response.json().catch(() => null);
        if (body?.remark) {
          remarks = [...remarks, body.remark];
        }
        cancelDraft();
        render();
        schedule();
        toast(TEXT.sent);
        return;
      }
      error.textContent =
        response?.status === 429 ? TEXT.tooMany : response?.status === 409 ? TEXT.full : TEXT.failed;
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelDraft();
        render();
      }
    });
    const element = draft.description;
    return h(
      "form",
      {
        class: "box composer",
        role: "dialog",
        "aria-label": TEXT.add,
        onsubmit: (event) => {
          event.preventDefault();
          void submit();
        },
      },
      h("div", { class: "head" }, h("span", { class: "grow", text: TEXT.add })),
      elementLine({ element }),
      field,
      error,
      h(
        "div",
        { class: "actions" },
        h("span", { class: "grow muted", text: TEXT.shortcut }),
        h("button", {
          class: "button",
          type: "button",
          text: TEXT.cancel,
          onclick: () => {
            cancelDraft();
            render();
          },
        }),
        send,
      ),
    );
  }

  function dock() {
    const count = openCount();
    return h(
      "div",
      { class: "dock", role: "toolbar", "aria-label": TEXT.remarks },
      h(
        "button",
        {
          type: "button",
          "aria-expanded": String(listOpen),
          onclick: () => {
            listOpen = !listOpen;
            if (listOpen) {
              openId = null;
              cancelDraft();
            }
            render();
            schedule();
          },
        },
        icon("message"),
        h("span", { class: "label", text: TEXT.remarks }),
        count > 0 ? h("span", { class: "count", text: String(count) }) : null,
      ),
      h(
        "button",
        {
          type: "button",
          class: "primary",
          "aria-label": TEXT.add,
          onclick: () => {
            cancelDraft();
            openId = null;
            listOpen = false;
            startPicking(beginDraft, () => render());
            render();
            schedule();
          },
        },
        icon("plus"),
        h("span", { class: "label", text: TEXT.add }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon",
          "aria-label": TEXT.hide,
          title: TEXT.hide,
          onclick: () => {
            saveMode("collapsed");
            pinsOn = false;
            listOpen = false;
            openId = null;
            cancelDraft();
            render();
            schedule();
          },
        },
        icon("hide"),
      ),
    );
  }

  /** The tool's own parts, made again from its state: a composer being typed in is kept as it is. */
  function render() {
    layer();
    const parts = [];
    if (notice !== null) {
      parts.push(
        h(
          "div",
          { class: "box notice", role: "status" },
          h("span", { class: "grow", text: notice }),
          h(
            "button",
            {
              class: "button",
              type: "button",
              "aria-label": TEXT.close,
              onclick: () => {
                notice = null;
                saveMode("off");
                render();
              },
            },
            icon("close"),
          ),
        ),
      );
    } else if (viewer !== null && mode === "collapsed") {
      const count = openCount();
      parts.push(
        h(
          "button",
          {
            class: "round",
            type: "button",
            "aria-label": TEXT.show,
            title: TEXT.show,
            onclick: () => {
              saveMode("on");
              pinsOn = true;
              render();
              schedule();
            },
          },
          icon("message"),
          count > 0 ? h("span", { class: "count", text: String(count) }) : null,
        ),
      );
    } else if (viewer !== null && mode === "on") {
      if (picker) {
        parts.push(
          h(
            "div",
            { class: "banner", role: "status" },
            h("span", { text: TEXT.picking }),
            h("span", { class: "hint", style: "opacity:.7", text: TEXT.escape }),
            h("button", {
              type: "button",
              text: TEXT.cancel,
              onclick: () => {
                stopPicking();
                render();
              },
            }),
          ),
        );
      }
      parts.push(dock());
      if (listOpen) {
        parts.push(list());
      }
      const open = openId === null ? null : remarks.find((remark) => remark.id === openId);
      cardNode = open ? card(open) : null;
      if (draft && composerNode) {
        parts.push(composerNode);
      } else if (cardNode) {
        parts.push(cardNode);
      }
    }
    chrome.replaceChildren(...parts);
  }

  /** A page that changes its address without loading follows: pins, list and cards of the new page. */
  function onNavigate() {
    post({ type: "location", path: where() });
    if (!framed && shadow) {
      if (draft && !draft.element.isConnected) {
        cancelDraft();
      }
      openId = null;
      render();
    }
    schedule();
  }

  // Single-page apps change address without loading a page: the Studio and the pins follow them.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    };
  }
  window.addEventListener("popstate", onNavigate);

  if (framed) {
    post({ type: "ready", path: where() });
    return;
  }

  mode = readMode();
  if (mode === "off") {
    return;
  }
  void load().then((answered) => {
    if (!answered) {
      return;
    }
    pinsOn = mode === "on";
    render();
    watch();
    schedule();
    let focus = null;
    try {
      focus = sessionStorage.getItem(FOCUS_KEY);
      sessionStorage.removeItem(FOCUS_KEY);
    } catch {}
    if (focus) {
      // The page has just loaded: its elements may still be on their way.
      setTimeout(() => focusRemark(focus), 600);
    }
    setInterval(() => {
      if (mode === "on" && viewer !== null && !document.hidden && !draft) {
        void load();
      }
    }, REFRESH_MS);
  });
})();
