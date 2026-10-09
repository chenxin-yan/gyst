import * as stylex from "@stylexjs/stylex";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type Command, type CommandId, keyLabels } from "./keymap.ts";
import { theme } from "./tokens.stylex.ts";

/** A command's keys as the help prints them: sequences joined, alternatives separated. */
export function Keys({ command }: { command: Command }) {
  return command.keys.map((keys, index) => (
    <span key={keys.join(" ")}>
      {index > 0 && <span {...stylex.props(styles.or)}> / </span>}
      {keys.map((key, at) => (
        // Indexed: a sequence repeats keys (`G G`). One kbd a step: a Mac chord has spaces (`⇧ R`).
        <Fragment key={at}>
          {at > 0 && " "}
          <kbd {...stylex.props(styles.kbd)}>{formatForDisplay(key, { keyLabels })}</kbd>
        </Fragment>
      ))}
    </span>
  ));
}

/**
 * A modal native dialog: it takes focus, keeps it inside, closes on Escape and gives focus back.
 * The review keys ignore keydowns from inside it, so it owns its own keys.
 */
function Dialog(props: { label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={props.label}
      // The close event is queued: one from an effect replayed by StrictMode arrives open again.
      onClose={() => !dialog.current?.open && props.onClose()}
      onClick={(event) => event.target === dialog.current && props.onClose()}
      {...stylex.props(styles.dialog)}
    >
      {props.children}
    </dialog>
  );
}

/** ⌘K: every command of the input mode, filtered as you type; ↑/↓ choose, Enter runs, Escape closes. */
export function CommandMenu(props: {
  commands: readonly Command[];
  labelOf: (command: Command) => string;
  onRun: (id: CommandId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = props.commands.filter(
    (command) =>
      command.id !== "menu" &&
      props.labelOf(command).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const current = Math.min(active, shown.length - 1);
  // aria-activedescendant moves no scroll: keep the active option in the menu's viewport.
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, current]);
  const run = (id: CommandId) => {
    props.onClose();
    props.onRun(id);
  };
  return (
    <Dialog label="Command menu" onClose={props.onClose}>
      <input
        {...stylex.props(styles.search)}
        role="combobox"
        aria-label="Search commands"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        placeholder="Run a command…"
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : shown.length - 1;
            setActive((current + step) % Math.max(shown.length, 1));
          }
          if (event.key === "Enter" && shown[current]) {
            event.preventDefault();
            run(shown[current].id);
          }
        }}
      />
      <ul id={listId} role="listbox" aria-label="Commands" {...stylex.props(styles.list)}>
        {shown.map((command, index) => (
          <li
            key={command.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === current}
            {...stylex.props(styles.option, index === current && styles.active)}
            onPointerMove={() => setActive(index)}
            onClick={() => run(command.id)}
          >
            <span {...stylex.props(styles.label)}>{props.labelOf(command)}</span>
            <span {...stylex.props(styles.keys)}>
              <Keys command={command} />
            </span>
          </li>
        ))}
        {shown.length === 0 && <li {...stylex.props(styles.none)}>No matching command.</li>}
      </ul>
    </Dialog>
  );
}

/** ?: the keys the input mode implements, from the same list the keyboard reads. */
export function KeyHelp(props: {
  commands: readonly Command[];
  labelOf: (command: Command) => string;
  onClose: () => void;
}) {
  return (
    <Dialog label="Keyboard shortcuts" onClose={props.onClose}>
      <div {...stylex.props(styles.help)}>
        <div {...stylex.props(styles.helpHead)}>
          <h2 {...stylex.props(styles.title)}>Keyboard shortcuts</h2>
          <button type="button" autoFocus {...stylex.props(styles.close)} onClick={props.onClose}>
            Close <kbd {...stylex.props(styles.kbd)}>Esc</kbd>
          </button>
        </div>
        <dl {...stylex.props(styles.table)}>
          {props.commands
            .filter((command) => command.keys.length > 0)
            .map((command) => (
              <div key={command.id} {...stylex.props(styles.row)}>
                <dt {...stylex.props(styles.term)}>
                  <Keys command={command} />
                </dt>
                <dd {...stylex.props(styles.description)}>{props.labelOf(command)}</dd>
              </div>
            ))}
        </dl>
      </div>
    </Dialog>
  );
}

const styles = stylex.create({
  dialog: {
    width: "min(560px, 92vw)",
    maxHeight: "72vh",
    marginTop: "14vh",
    padding: 0,
    overflow: "auto",
    overscrollBehavior: "none",
    borderWidth: 0,
    borderRadius: "10px",
    backgroundColor: theme.surface,
    color: theme.ink,
    boxShadow: `0 0 0 1px ${theme.line}, 0 30px 80px rgb(0 0 0 / 0.35)`,
    fontFamily: theme.sans,
    fontSize: "13px",
    "::backdrop": { backgroundColor: "rgb(17 17 27 / 0.6)" },
  },
  search: {
    width: "100%",
    padding: "14px 16px",
    borderWidth: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
  },
  list: { padding: "6px" },
  option: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "7px 10px",
    borderRadius: "6px",
    color: theme.muted,
    cursor: "pointer",
  },
  // The active option is outlined as well as tinted, so it shows without colour.
  active: {
    color: theme.ink,
    backgroundColor: theme.select,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
  label: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  keys: { flexShrink: 0, whiteSpace: "nowrap" },
  none: { padding: "7px 10px", color: theme.faint },
  help: { display: "grid", gap: "14px", padding: "20px 22px" },
  helpHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: "14px", fontWeight: 500 },
  table: { display: "grid", gap: "6px", margin: 0 },
  row: { display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: "12px" },
  term: { whiteSpace: "nowrap" },
  description: { margin: 0, color: theme.muted },
  close: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    height: "28px",
    padding: "0 10px",
    borderRadius: "7px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  kbd: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: "18px",
    height: "18px",
    padding: "0 4px",
    marginLeft: "3px",
    borderRadius: "4px",
    backgroundColor: theme.line,
    color: theme.ink,
    fontFamily: theme["--mono"],
    fontSize: "11px",
  },
  or: { color: theme.faint },
});
