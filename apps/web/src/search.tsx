// The reader's search over the current view: the scan that finds a query's matches a slice of files
// at a time, and the search field in the status line.
import * as stylex from "@stylexjs/stylex";
import { type Ref, startTransition, useEffect, useRef, useState } from "react";
import { type Hit, matcher, resultOf, type SearchResult } from "./search.ts";
import { theme } from "./tokens.stylex.ts";

/** What search reads of one shown file. `key` changes whenever its hits could. */
export type SearchSource = {
  key: readonly unknown[];
  hits: (test: (text: string) => boolean) => Hit[];
};

/** How long one slice of a scan may hold the main thread, in milliseconds. */
const sliceTime = 8;
const noHits: readonly Hit[] = [];
const sameKey = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((part, index) => Object.is(part, b[index]));

/**
 * The query's matches over the view's files, scanned a slice at a time so typing and scrolling stay
 * responsive in large views. A file's hits are kept while the query and its source key stay the
 * same, so a scan after one file loaded reads only that file again. `current` says the result is
 * for the latest query, files and sources; until then the previous result stands, and `searching`
 * says a new query's scan is still running.
 */
export function useSearchScan(
  query: string,
  files: readonly string[],
  sourceOf: (file: string) => SearchSource | undefined,
) {
  const [scan, setScan] = useState<{
    query: string;
    files: readonly string[];
    sourceOf: (file: string) => SearchSource | undefined;
    result: SearchResult;
  }>();
  const kept = useRef(
    new Map<string, { query: string; key: readonly unknown[]; hits: readonly Hit[] }>(),
  );
  useEffect(() => {
    if (query === "") return;
    const test = matcher(query);
    const hits: (readonly Hit[])[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slice = () => {
      const end = performance.now() + sliceTime;
      while (hits.length < files.length) {
        const file = files[hits.length];
        const source = sourceOf(file);
        const before = kept.current.get(file);
        if (source === undefined) hits.push(noHits);
        else if (before && before.query === query && sameKey(before.key, source.key))
          hits.push(before.hits);
        else {
          const found = source.hits(test);
          kept.current.set(file, { query, key: source.key, hits: found });
          hits.push(found);
        }
        if (hits.length < files.length && performance.now() >= end) {
          timer = setTimeout(slice);
          return;
        }
      }
      setScan({ query, files, sourceOf, result: resultOf(files, hits) });
    };
    slice();
    return () => clearTimeout(timer);
  }, [query, files, sourceOf]);
  return {
    result: query === "" ? undefined : scan?.result,
    current:
      scan !== undefined &&
      scan.query === query &&
      scan.files === files &&
      scan.sourceOf === sourceOf,
    searching: query !== "" && scan?.query !== query,
  };
}

/**
 * The search field, shown while the highlight is: typing searches as you go, Enter goes to the next
 * match (Shift+Enter the previous) and gives the keys back to the reader, Escape clears the
 * highlight and keeps the query.
 */
export function SearchField(props: {
  ref: Ref<HTMLInputElement>;
  query: string;
  /** The match count, or why there is none. */
  status: string;
  onQuery: (query: string) => void;
  onEnter: (query: string, direction: 1 | -1) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  // Typed text shows at once; the scan follows it as a transition, which typing interrupts.
  const [draft, setDraft] = useState(props.query);
  return (
    <div role="search" aria-label="Search the current view" {...stylex.props(styles.bar)}>
      <span aria-hidden {...stylex.props(styles.slash)}>
        /
      </span>
      <input
        ref={props.ref}
        type="text"
        role="searchbox"
        aria-label="Search this view"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        {...stylex.props(styles.input)}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          startTransition(() => props.onQuery(next));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onEnter(draft, event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <span role="status" {...stylex.props(styles.count)}>
        {props.status}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        {...stylex.props(styles.button)}
        onClick={() => props.onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        {...stylex.props(styles.button)}
        onClick={() => props.onStep(1)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Close search"
        {...stylex.props(styles.button)}
        onClick={props.onClose}
      >
        ×
      </button>
    </div>
  );
}

const styles = stylex.create({
  bar: { display: "flex", alignItems: "center", gap: "4px" },
  slash: { color: theme.ink },
  input: {
    width: "18ch",
    padding: "1px 6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: theme.line,
    borderRadius: "4px",
    backgroundColor: theme.surface,
    color: theme.ink,
    font: "inherit",
  },
  count: { minWidth: "6ch", color: theme.ink },
  button: {
    minWidth: "18px",
    height: "18px",
    borderRadius: "4px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
});
