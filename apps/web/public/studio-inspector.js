/*
 * Opsifier Studio inspector. A page that loads it, inside the Studio's preview frame, lets the person in
 * the Studio point at one of its elements: hovering outlines it, a click sends what it is to the
 * Studio, which joins it to the next message for the agent. It also tells the Studio which address
 * the page is at. It does nothing in a page that is not in a frame.
 *
 * The Studio and the page talk with postMessage. From the Studio: { source: "opsifier-studio",
 * type: "inspect", on } and { type: "ping" }. From the page: { source: "opsifier-studio-preview",
 * type: "ready" | "location" | "selected" | "inspect-ended", ... }. Only the frame's parent is
 * listened to, and once it has spoken, only its origin is answered.
 */
(() => {
  if (window.parent === window || window.__opsifierStudioInspector) {
    return;
  }
  window.__opsifierStudioInspector = true;

  const FROM_STUDIO = "opsifier-studio";
  const TO_STUDIO = "opsifier-studio-preview";
  const ACCENT = "#f97316";
  let studioOrigin = null;
  let inspecting = false;
  let overlay = null;
  let badge = null;
  let hovered = null;

  const post = (message) => {
    window.parent.postMessage({ source: TO_STUDIO, ...message }, studioOrigin ?? "*");
  };
  const where = () => location.pathname + location.search + location.hash;

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

  function show(element) {
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

  function hide() {
    if (overlay) {
      overlay.style.display = "none";
      badge.style.display = "none";
    }
    hovered = null;
  }

  function stop(tell) {
    inspecting = false;
    document.documentElement.style.cursor = "";
    hide();
    if (tell) {
      post({ type: "inspect-ended" });
    }
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!inspecting) {
        return;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target && target !== hovered && target !== overlay && target !== badge) {
        hovered = target;
        show(target);
      }
    },
    true,
  );

  // A click while inspecting picks the element, and does nothing else: no link followed, no button pressed.
  for (const kind of ["pointerdown", "mousedown", "mouseup", "click"]) {
    document.addEventListener(
      kind,
      (event) => {
        if (!inspecting) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (kind === "click") {
          const target = hovered || document.elementFromPoint(event.clientX, event.clientY);
          if (target) {
            post({ type: "selected", element: describe(target) });
          }
          stop(false);
        }
      },
      true,
    );
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (inspecting && event.key === "Escape") {
        event.preventDefault();
        stop(true);
      }
    },
    true,
  );
  window.addEventListener("scroll", () => inspecting && hovered && show(hovered), true);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data || event.data.source !== FROM_STUDIO) {
      return;
    }
    studioOrigin = event.origin;
    if (event.data.type === "inspect") {
      if (event.data.on) {
        inspecting = true;
        document.documentElement.style.cursor = "crosshair";
      } else {
        stop(false);
      }
    } else if (event.data.type === "ping") {
      post({ type: "ready", path: where() });
    }
  });

  // Single-page apps change address without loading a page: the Studio follows them.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      post({ type: "location", path: where() });
      return result;
    };
  }
  window.addEventListener("popstate", () => post({ type: "location", path: where() }));
  post({ type: "ready", path: where() });
})();
