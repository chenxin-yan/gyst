// Semantic navigation in the reader: asking gyst for a line's symbols and their definitions or
// usages, and the peek that shows them under that line. Only an answer to the ask still shown
// applies: closing, another ask, Expand, Back or another snapshot leave a late reply nothing to
// change. Nothing here touches Viewed.
import type { AddonState, CapturedRange, NavigationUnavailable } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { type KeyboardEvent, type Ref, useMemo, useRef } from "react";
import { isExpectedFailure, operation } from "./api.ts";
import type { RangeRead } from "./captured.ts";
import { useMounted } from "./components.tsx";
import type { Peek } from "./navigation.ts";
import { InlinePeek, type PeekHandle, type PeekOverlay, PeekPreview } from "./peek.tsx";
import {
  afterIdentifiers,
  afterQuery,
  answers,
  choiceLabel,
  gapText,
  type LineOrigin,
  originTarget,
  type Readiness,
  readinessOf,
  requestOf,
  type SemanticAsk,
  type SemanticPeek,
  type SemanticStage,
  stepped,
  targetOf,
} from "./semantic.ts";
import { theme } from "./tokens.stylex.ts";

/** How many known missing inputs a result lists without being asked. */
const shownGaps = 3;

/** How often the queried side's readiness is read again while an answer is awaited. */
const readinessEvery = 750;

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message.replace(/\.$/, "") : "gyst didn't answer";

/**
 * Asks gyst for a line's symbols and their answers on behalf of the reader's peek. `peek` is the
 * open peek as last rendered; every change goes through `setPeek`. An ask on an earlier snapshot
 * than `snapshotId` is never sent: only the current snapshot is analysed.
 */
export function useSemanticNavigation(props: {
  sessionId: string;
  snapshotId: string;
  peek: Peek | undefined;
  setPeek: (peek: Peek | undefined) => void;
}) {
  const { sessionId, snapshotId, setPeek } = props;
  const latest = useRef(props.peek);
  latest.current = props.peek;
  const tickets = useRef(0);
  const mounted = useMounted();
  const show = (peek: SemanticPeek) => {
    latest.current = peek;
    setPeek(peek);
  };
  const semantic = () => {
    const peek = latest.current;
    return mounted.current && peek?.kind === "semantic" ? peek : undefined;
  };
  /** The open peek while it still waits for exactly this ask. */
  const waiting = (ticket: number) => {
    const peek = semantic();
    return peek?.stage.kind === "waiting" && peek.stage.ticket === ticket
      ? { ...peek, stage: peek.stage }
      : undefined;
  };

  const ask = (origin: LineOrigin, what: SemanticAsk) => {
    if (origin.snapshotId !== snapshotId)
      return show({
        kind: "semantic",
        origin,
        stage: { kind: "unavailable", ask: what, reason: { kind: "historical" } },
      });
    const ticket = ++tickets.current;
    show({ kind: "semantic", origin, stage: { kind: "waiting", ask: what, ticket } });
    const settle = (stage: SemanticStage) => {
      if (waiting(ticket)) show({ kind: "semantic", origin, stage });
    };
    // Readiness only tells the reader how far preparation is; reading it never starts anything.
    const readiness = async () => {
      if (!waiting(ticket)) return;
      try {
        const state = await operation({ command: "navigation", session: sessionId, snapshotId });
        const now = waiting(ticket);
        const read: Readiness | undefined = readinessOf(state.sides[origin.side]);
        if (now && read && read !== now.stage.readiness)
          show({ ...now, stage: { ...now.stage, readiness: read } });
      } catch {
        // The answer itself reports any failure.
      }
    };
    const timer = setInterval(() => void readiness(), readinessEvery);
    void (async () => {
      const request = requestOf(sessionId, origin, what);
      try {
        const reply = await operation(request);
        if (!waiting(ticket)) return;
        if (!answers(request, reply))
          return settle({ kind: "failed", ask: what, message: "gyst answered another question" });
        if (what.kind === "query" && "query" in reply)
          return settle(afterQuery(what.choice, reply));
        if (what.kind === "identifiers" && "line" in reply) {
          const next = afterIdentifiers(what, reply);
          return "ask" in next ? ask(origin, next.ask) : settle(next.stage);
        }
      } catch (error) {
        if (!isExpectedFailure(error)) console.error(error);
        settle({ kind: "failed", ask: what, message: messageOf(error) });
      } finally {
        clearInterval(timer);
      }
    })();
  };

  /** Has gyst look for the add-on again on the session's launch PATH, then asks again if found. */
  const checkAgain = () => {
    const peek = semantic();
    if (peek?.stage.kind !== "unavailable") return;
    const { origin, stage } = peek;
    const ticket = ++tickets.current;
    show({ ...peek, stage: { ...stage, checking: ticket } });
    const checking = () => {
      const now = semantic();
      return now?.stage.kind === "unavailable" && now.stage.checking === ticket;
    };
    operation({ command: "navigation", session: sessionId, snapshotId, recheck: true }).then(
      (state) => {
        if (!checking()) return;
        if (state.addon.kind === "available") return ask(origin, stage.ask);
        show({
          kind: "semantic",
          origin,
          stage: {
            kind: "unavailable",
            ask: stage.ask,
            reason: { kind: "addon", addon: state.addon },
            checked: true,
          },
        });
      },
      (error: unknown) => {
        if (!isExpectedFailure(error)) console.error(error);
        if (checking())
          show({
            kind: "semantic",
            origin,
            stage: { kind: "failed", ask: stage.ask, message: messageOf(error) },
          });
      },
    );
  };

  /** Asks again what the shown failure or unavailable answer asked. */
  const retry = () => {
    const peek = semantic();
    if (peek?.stage.kind === "unavailable" || peek?.stage.kind === "failed")
      ask(peek.origin, peek.stage.ask);
  };

  /** Asks the selected choice. */
  const choose = (index?: number) => {
    const peek = semantic();
    if (peek?.stage.kind !== "choose") return;
    const choice = peek.stage.choices[index ?? peek.stage.selected];
    if (choice) ask(peek.origin, { kind: "query", choice });
  };

  /** Moves the selection, which the preview follows. */
  const select = (to: { by: number } | { index: number }) => {
    const peek = semantic();
    if (peek === undefined) return;
    const { stage } = peek;
    const next =
      "by" in to
        ? stepped(stage, to.by)
        : stepped(
            stage.kind === "choose" || stage.kind === "locations"
              ? { ...stage, selected: to.index }
              : stage,
            0,
          );
    if (next !== stage) show({ ...peek, stage: next });
  };

  return { ask, checkAgain, retry, choose, select };
}

/** The key that remounts a semantic peek, so focus moves in afresh: every change but selection. */
export const semanticKey = ({ origin, stage }: SemanticPeek) =>
  JSON.stringify({ origin, stage: { ...stage, selected: undefined } });

const sideNames = (origin: LineOrigin, snapshotId: string) =>
  `${origin.side} side · snapshot ${origin.snapshotId.slice(0, 7)}${origin.snapshotId === snapshotId ? "" : " (earlier)"}`;

const readinessText = (readiness: Readiness | undefined, origin: LineOrigin) => {
  switch (readiness) {
    case "queued":
      return "Queued: waiting for an analysis engine; at most two run at once.";
    case "preparing":
      return `Preparing the ${origin.side} side: copying its captured TS/JS files and starting the engine…`;
    case "ready":
      return "Asking the engine…";
    default:
      return "Preparing navigation…";
  }
};

const unavailableText = (reason: Exclude<NavigationUnavailable, { kind: "addon" }>) => {
  switch (reason.kind) {
    case "historical":
      return "semantic queries cover only the session's current snapshot, and this code is from an earlier one";
    case "not-source":
      return reason.detail;
    case "engine":
      return `the TypeScript engine failed: ${reason.message.replace(/\.$/, "")}`;
  }
};

/**
 * A semantic peek under the code line it was asked on: Preparing while gyst prepares and asks, a
 * vertical list of symbols or result locations beside a live preview of the selected one,
 * potentially incomplete results with their known missing inputs, or why navigation is unavailable.
 * In the list `j`/`k` move, Enter asks or expands and Esc closes.
 */
export function SemanticPeekView(props: {
  peek: SemanticPeek;
  /** The session's current snapshot, to name the origin's own. */
  snapshotId: string;
  /** A captured range's lines with context, read once per range for the session. */
  read: (target: CapturedRange) => Promise<RangeRead>;
  narrow: boolean;
  onSelect: (to: { by: number } | { index: number }) => void;
  onChoose: (index?: number) => void;
  onExpand: (target: CapturedRange) => void;
  onClose: () => void;
  onCheckAgain: () => void;
  onRetry: () => void;
  onContinue: () => void;
  overlay?: PeekOverlay | undefined;
  handle?: Ref<PeekHandle> | undefined;
}) {
  const { peek, read } = props;
  const { origin, stage } = peek;
  const names = sideNames(origin, props.snapshotId);
  const location = stage.kind === "locations" ? stage.locations[stage.selected] : undefined;
  const target =
    stage.kind === "choose"
      ? originTarget(origin)
      : location === undefined
        ? undefined
        : targetOf(origin, location);
  const targetKey = JSON.stringify(target);
  // One function per previewed range, so stepping back to a range shows its kept lines at once.
  const previewRead = useMemo(
    () => (target === undefined ? undefined : () => read(target)),
    [read, targetKey],
  );
  const title =
    stage.kind === "locations"
      ? `${choiceLabel(stage.choice)} · ${names}`
      : stage.kind === "waiting" && stage.ask.kind === "query"
        ? `${choiceLabel(stage.ask.choice)} · ${names}`
        : `${origin.file}:${origin.line} · ${names}`;
  const listed = stage.kind === "choose" || (stage.kind === "locations" && location !== undefined);
  const expand = location && (() => props.onExpand(targetOf(origin, location)));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const onControl =
      event.target instanceof Element && event.target.closest("button, a[href], summary") !== null;
    switch (event.key) {
      case "Escape":
        props.onClose();
        break;
      case "j":
      case "ArrowDown":
      case "k":
      case "ArrowUp":
        if (!listed) return;
        props.onSelect({ by: event.key === "j" || event.key === "ArrowDown" ? 1 : -1 });
        break;
      case "Enter":
        if (!listed || onControl) return;
        if (stage.kind === "choose") props.onChoose();
        else expand?.();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  let preview;
  let selector;
  let footer;
  switch (stage.kind) {
    case "waiting":
      preview = (
        <p role="status" data-preparing {...stylex.props(styles.muted)}>
          {readinessText(stage.readiness, origin)}
        </p>
      );
      break;
    case "choose":
      preview = previewRead && (
        <PeekPreview
          target={target!}
          read={previewRead}
          span={stage.choices[stage.selected]?.symbol.range}
        />
      );
      selector = (
        <Listbox
          label="Symbols"
          selected={stage.selected}
          rows={stage.choices.map((choice) => ({
            title: choiceLabel(choice),
            meta: `line ${choice.symbol.range.start.line}, column ${choice.symbol.range.start.character + 1}`,
          }))}
          onPick={(index) => props.onChoose(index)}
        />
      );
      break;
    case "locations": {
      const empty = stage.locations.length === 0;
      preview =
        previewRead && location ? (
          <PeekPreview target={target!} read={previewRead} span={location.range} />
        ) : (
          <p role="status" {...stylex.props(styles.muted)}>
            {stage.choice.query === "definition"
              ? "No definition found in the captured files."
              : "No usages found in the captured files."}
          </p>
        );
      selector = !empty && (
        <Listbox
          label={stage.choice.query === "definition" ? "Definitions" : "Usages"}
          selected={stage.selected}
          // The file's name first: a monorepo's directories would push it out of the row.
          rows={stage.locations.map(({ file, range }) => {
            const slash = file.lastIndexOf("/");
            return {
              title: file.slice(slash + 1),
              meta: `${slash >= 0 ? `${file.slice(0, slash + 1)} · ` : ""}line ${range.start.line}, column ${range.start.character + 1}`,
            };
          })}
          onPick={(index) => props.onSelect({ index })}
        />
      );
      footer = (stage.outside > 0 || stage.gaps.length > 0) && (
        <div {...stylex.props(styles.footer)}>
          {stage.outside > 0 && (
            <p role="note">
              {stage.outside} more {stage.outside === 1 ? "lies" : "lie"} outside the captured
              files, in packages gyst never captures, and {stage.outside === 1 ? "isn't" : "aren't"}{" "}
              shown.
            </p>
          )}
          {stage.gaps.length > 0 && (
            <section aria-label="Potentially incomplete" role="note">
              <p {...stylex.props(styles.warning)}>
                Potentially incomplete
                {empty ? ": finding none doesn't mean there are none" : ""}.
              </p>
              {/* A monorepo can lack dozens of inputs; a few are shown, more on request. */}
              <details open={stage.gaps.length <= shownGaps}>
                <summary {...stylex.props(styles.summary)}>
                  {stage.gaps.length} known missing {stage.gaps.length === 1 ? "input" : "inputs"}
                </summary>
                <ul {...stylex.props(styles.gaps)}>
                  {stage.gaps.map((gap) => (
                    <li key={JSON.stringify(gap)}>{gapText(gap)}</li>
                  ))}
                </ul>
              </details>
            </section>
          )}
        </div>
      );
      break;
    }
    case "none":
      preview = (
        <p role="status" {...stylex.props(styles.muted)}>
          {stage.message}
        </p>
      );
      break;
    case "unavailable":
      preview =
        stage.reason.kind === "addon" ? (
          <AddonPanel
            addon={stage.reason.addon}
            checking={stage.checking !== undefined}
            checked={stage.checked === true}
            onCheckAgain={props.onCheckAgain}
            onContinue={props.onContinue}
          />
        ) : (
          <p role="status" {...stylex.props(styles.muted)}>
            Unavailable: {unavailableText(stage.reason)}.{" "}
            {stage.reason.kind === "engine" && (
              <button type="button" onClick={props.onRetry} {...stylex.props(styles.button)}>
                Try again
              </button>
            )}
          </p>
        );
      break;
    case "failed":
      preview = (
        <p role="alert" {...stylex.props(styles.failure)}>
          Couldn't ask gyst: {stage.message}.{" "}
          <button type="button" onClick={props.onRetry} {...stylex.props(styles.button)}>
            Try again
          </button>
        </p>
      );
      break;
  }

  return (
    <InlinePeek
      label={title}
      title={title}
      onExpand={expand}
      onClose={props.onClose}
      closeLabel="Close navigation"
      preview={preview}
      selector={selector || undefined}
      footer={footer || undefined}
      narrow={props.narrow}
      // An answer that arrives later never takes focus from typing or a dialog; while waiting the
      // keys stay with the review.
      focus={stage.kind === "waiting" ? "never" : "free"}
      reveal
      onKeyDown={onKeyDown}
      overlay={props.overlay}
      handle={props.handle}
    />
  );
}

/** The vertical selector: one focusable list whose active row the preview shows. */
function Listbox(props: {
  label: string;
  rows: readonly { title: string; meta: string }[];
  selected: number;
  onPick: (index: number) => void;
}) {
  const id = `peek-${props.label.toLowerCase()}`;
  return (
    <ul
      role="listbox"
      aria-label={props.label}
      aria-activedescendant={`${id}-${props.selected}`}
      tabIndex={0}
      data-peek-focus
      {...stylex.props(styles.list)}
    >
      {props.rows.map((row, index) => (
        <li
          key={index}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === props.selected}
          onClick={() => props.onPick(index)}
          {...stylex.props(styles.row, index === props.selected && styles.selected)}
        >
          <span {...stylex.props(styles.rowTitle)}>{row.title}</span>
          <span {...stylex.props(styles.meta)}>{row.meta}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why navigation needs the add-on, the exact global install or update for this gyst release, and
 * the two ways on: Check again, or Continue without navigation. Never about project inputs.
 */
export function AddonPanel(props: {
  addon: AddonState;
  checking: boolean;
  checked: boolean;
  onCheckAgain: () => void;
  onContinue: () => void;
}) {
  const { addon } = props;
  if (addon.kind === "available") return null;
  return (
    <div aria-label="Navigation add-on" role="group" {...stylex.props(styles.addon)}>
      <p role="status">
        {addon.kind === "missing"
          ? "TS/JS navigation needs its optional add-on, which isn't on the PATH gyst was last opened from."
          : addon.kind === "mismatched"
            ? `The TS/JS navigation add-on found is release ${addon.found}, not this gyst's. Update it to the matching release.`
            : `The TS/JS navigation add-on found can't run: ${addon.reason.replace(/\.$/, "")}. Install it again.`}
        {props.checked && " Checked again: no change yet."}
      </p>
      <p {...stylex.props(styles.muted)}>On the gyst host, run:</p>
      <code data-install {...stylex.props(styles.install)}>
        {addon.install}
      </code>
      <p {...stylex.props(styles.muted)}>
        Check again finds an install in a directory already on that PATH. After installing
        elsewhere, run gyst again from a shell whose PATH has it.
      </p>
      <p {...stylex.props(styles.actions)}>
        <button
          type="button"
          data-peek-focus
          disabled={props.checking}
          onClick={props.onCheckAgain}
          {...stylex.props(styles.button)}
        >
          {props.checking ? "Checking…" : "Check again"}
        </button>
        <button type="button" onClick={props.onContinue} {...stylex.props(styles.button)}>
          Continue without navigation
        </button>
      </p>
    </div>
  );
}

const styles = stylex.create({
  muted: { color: theme.muted },
  failure: { color: theme.del },
  warning: { color: theme.ink, fontWeight: 500 },
  footer: { display: "grid", gap: "4px", color: theme.muted, fontSize: "12px" },
  gaps: { paddingInlineStart: "18px", listStyleType: "disc" },
  summary: { cursor: "pointer", color: { default: theme.muted, ":hover": theme.ink } },
  list: {
    display: "grid",
    gap: "2px",
    minWidth: 0,
    maxHeight: "240px",
    overflowY: "auto",
    borderRadius: "4px",
    outline: { default: "none", ":focus-visible": `1px solid ${theme["--accent"]}` },
  },
  row: {
    display: "grid",
    gap: "2px",
    padding: "6px 8px",
    borderRadius: "4px",
    cursor: "pointer",
    backgroundColor: { default: "transparent", ":hover": theme.line },
  },
  selected: {
    backgroundColor: { default: theme.select, ":hover": theme.select },
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
  rowTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: theme["--mono"],
    fontSize: "12px",
  },
  meta: { color: theme.muted, fontSize: "11.5px" },
  addon: { display: "grid", justifyItems: "start", gap: "6px" },
  install: {
    padding: "4px 8px",
    borderRadius: "4px",
    backgroundColor: theme.panelBg,
    fontFamily: theme["--mono"],
    fontSize: "12px",
    userSelect: "all",
  },
  actions: { display: "flex", gap: "8px" },
  button: {
    paddingBlock: "1px",
    paddingInline: "8px",
    borderRadius: "4px",
    color: { default: theme.muted, ":hover": theme.ink, ":focus-visible": theme.ink },
    backgroundColor: { default: theme.line, ":hover": theme.select },
    fontSize: "12px",
  },
});
