/**
 * An element the person pointed at in the preview, as the Studio inspector describes it, and the
 * block of text that carries it to the agent in a message.
 */
export interface SelectedElement {
  tag: string;
  text: string;
  classes: string[];
  attributes: Record<string, string>;
  selector: string;
  /** The React components around it, nearest first. */
  components: string[];
  path: string;
}

const OPEN = "<selected_element>";
const CLOSE = "</selected_element>";
const BLOCK = /<selected_element>([\s\S]*?)<\/selected_element>/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const short = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const strings = (value: unknown, count: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => short(item, max))
        .filter((item) => item !== "")
        .slice(0, count)
    : [];

/** What the preview's page sent, kept only when it has the shape of an element. */
export function readSelected(value: unknown): SelectedElement | null {
  if (!isRecord(value)) {
    return null;
  }
  const tag = short(value.tag, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    return null;
  }
  const attributes: Record<string, string> = {};
  if (isRecord(value.attributes)) {
    for (const [name, attribute] of Object.entries(value.attributes).slice(0, 10)) {
      const text = short(attribute, 200);
      if (/^[a-z-]{1,30}$/.test(name) && text !== "") {
        attributes[name] = text;
      }
    }
  }
  return {
    tag,
    text: short(value.text, 160),
    classes: strings(value.classes, 10, 80),
    attributes,
    selector: short(value.selector, 400),
    components: strings(value.components, 4, 80),
    path: short(value.path, 300) || "/",
  };
}

const quoted = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A few words that name the element: its nearest component, its tag, and the start of its text. */
export function elementLabel(element: Pick<SelectedElement, "tag" | "text" | "components">): string {
  const parts = [
    element.components[0],
    `<${element.tag}>`,
    element.text === "" ? null : `« ${quoted(element.text, 40)} »`,
  ];
  return parts.filter((part) => part !== undefined && part !== null).join(" ");
}

/** The block a message carries for the agent: plain lines, easy for a model and a person to read. */
export function elementBlock(element: SelectedElement): string {
  const classes = element.classes.length === 0 ? "" : ` class="${element.classes.join(" ")}"`;
  const attributes = Object.entries(element.attributes)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return [
    OPEN,
    `Page: ${element.path}`,
    `Element: <${element.tag}${classes}>${element.text === "" ? "" : ` "${element.text}"`}`,
    ...(element.components.length === 0 ? [] : [`React components: ${element.components.join(" < ")}`]),
    `Selector: ${element.selector}`,
    ...(attributes === "" ? [] : [`Attributes: ${attributes}`]),
    CLOSE,
  ].join("\n");
}

/** A sent message's own words, and the elements it points at, each named as {@link elementLabel} does. */
export function splitMessage(text: string): { text: string; elements: string[] } {
  const elements: string[] = [];
  const rest = text.replace(BLOCK, (_, body: string) => {
    const line = (prefix: string) =>
      body
        .split("\n")
        .find((candidate) => candidate.startsWith(prefix))
        ?.slice(prefix.length)
        .trim() ?? "";
    const element = /^<([a-z][a-z0-9-]*)[^>]*>(?:\s+"(.*)")?$/.exec(line("Element:"));
    elements.push(
      elementLabel({
        tag: element?.[1] ?? "element",
        text: element?.[2] ?? "",
        components: line("React components:")
          .split("<")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      }),
    );
    return "";
  });
  return { text: rest.trim(), elements };
}
