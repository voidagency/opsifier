import { EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--raised)",
    color: "var(--ink)",
    fontSize: "var(--text-sm)",
    border: "1px solid var(--off)",
    borderRadius: "3px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none", borderColor: "var(--accent)" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--ink)", padding: "6px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--raised)",
    color: "var(--muted)",
    border: "none",
    borderRight: "1px solid var(--rule)",
    fontFamily: "var(--font-mono)",
  },
  ".cm-activeLine": { backgroundColor: "var(--wash)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--wash)", color: "var(--ink)" },
  ".cm-env-comment": { color: "var(--muted)", fontStyle: "italic" },
  ".cm-env-key": { fontWeight: "500" },
  ".cm-env-eq": { color: "var(--muted)" },
});

const commentMark = Decoration.mark({ class: "cm-env-comment" });
const keyMark = Decoration.mark({ class: "cm-env-key" });
const equalsMark = Decoration.mark({ class: "cm-env-eq" });

function highlightDotenv(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to; ) {
      const line = view.state.doc.lineAt(position);
      const trimmed = line.text.trimStart();
      if (trimmed.startsWith("#")) {
        builder.add(line.from, line.to, commentMark);
      } else {
        const equals = line.text.indexOf("=");
        if (equals > 0) {
          builder.add(line.from, line.from + equals, keyMark);
          builder.add(line.from + equals, line.from + equals + 1, equalsMark);
        }
      }
      position = line.to + 1;
    }
  }
  return builder.finish();
}

/** Comments, keys and the equals sign, in our own tokens. */
const dotenvHighlighting: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = highlightDotenv(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = highlightDotenv(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Names the editor for assistive technology. */
  label: string;
  /** Marks the editor invalid, as a Field does for its control. */
  invalid?: boolean;
  /** dotenv highlighting, or plain text. */
  language?: "dotenv" | "plain";
  readOnly?: boolean;
  className?: string;
}

export function CodeEditor({
  value,
  onChange,
  label,
  invalid = false,
  language = "dotenv",
  readOnly = false,
  className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  // The editor is built once, then the value is pushed into it when it changes from outside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the props below only apply at creation
  useEffect(() => {
    if (host.current === null) {
      return;
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          editorTheme,
          ...(language === "dotenv" ? [dotenvHighlighting] : []),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({
            "aria-label": label,
            ...(invalid ? { "aria-invalid": "true" } : {}),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              latestOnChange.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor !== null && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      className={cn("min-h-[280px] w-full", invalid && "[&_.cm-editor]:border-bad", className)}
    />
  );
}
