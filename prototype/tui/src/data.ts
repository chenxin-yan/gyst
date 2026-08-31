// PROTOTYPE sample data — one folded session, hard-coded.

export type DiffLine = { sign: " " | "+" | "-"; text: string };

export type Member = { file: string; lines: DiffLine[]; start: number };

export type Item =
  | {
      kind: "group";
      id: string;
      title: string;
      agentNote: string;
      members: Member[]; // members[0] is the exemplar
    }
  | {
      kind: "spotlight";
      id: string;
      file: string;
      hunkHeader: string;
      tldr: string;
      start: number;
      lines: DiffLine[];
    };

const rename = (file: string): Member => ({
  file,
  start: 12,
  lines: [
    { sign: " ", text: "  const session = await auth(ctx)" },
    { sign: "-", text: "  const user = getUser(session.id)" },
    { sign: "+", text: "  const user = fetchUser(session.id)" },
  ],
});

const importPath = (file: string): Member => ({
  file,
  start: 1,
  lines: [
    { sign: "-", text: 'import { retry } from "../../lib/retry"' },
    { sign: "+", text: 'import { retry } from "@app/lib/retry"' },
  ],
});

const guard = (file: string): Member => ({
  file,
  start: 18,
  lines: [
    { sign: " ", text: "  const user = fetchUser(id)" },
    { sign: "+", text: "  if (!user) return null" },
    { sign: " ", text: "  return user.profile" },
  ],
});

export const items: Item[] = [
  {
    kind: "group",
    id: "g1",
    title: "rename getUser → fetchUser",
    agentNote: "same mechanical rename at every call site, no signature change",
    members: [
      "src/api/user.ts",
      "src/api/auth.ts",
      "src/api/session.ts",
      "src/cli/main.ts",
      "src/cli/status.ts",
      "src/hooks/useUser.ts",
      "src/lib/cache.ts",
      "src/lib/prefetch.ts",
    ].map(rename),
  },
  {
    kind: "group",
    id: "g2",
    title: "import path ../lib → @app/lib",
    agentNote: "alias migration, paths verified against tsconfig",
    members: [
      "src/api/user.ts",
      "src/api/retry.ts",
      "src/cli/main.ts",
      "src/hooks/useUser.ts",
      "src/lib/cache.ts",
      "src/workers/sync.ts",
    ].map(importPath),
  },
  {
    kind: "group",
    id: "g3",
    title: "null-check guard after fetch",
    agentNote: "same guard added after every fetchUser call site",
    members: ["src/api/user.ts", "src/api/auth.ts", "src/hooks/useUser.ts", "src/cli/status.ts"].map(guard),
  },
  {
    kind: "spotlight",
    id: "s1",
    start: 40,
    tldr: "resolve() now serves fresh cache hits and refreshes expired ones instead of returning stale entries",
    file: "src/api/session.ts",
    hunkHeader: "@@ -40,7 +40,11 @@ export function resolve(key: string)",
    lines: [
      { sign: " ", text: "export function resolve(key: string) {" },
      { sign: "-", text: "  return cache.get(key)" },
      { sign: "+", text: "  const hit = cache.get(key)" },
      { sign: "+", text: "  if (hit && !expired(hit)) return hit" },
      { sign: "+", text: "  return refresh(key)" },
      { sign: " ", text: "}" },
    ],
  },
  {
    kind: "spotlight",
    id: "s2",
    start: 12,
    tldr: "new expired() helper — TTL check used by session.ts to decide cache freshness",
    file: "src/lib/cache.ts",
    hunkHeader: "@@ -12,4 +12,9 @@ export function expired(entry: Entry)",
    lines: [
      { sign: "+", text: "export function expired(entry: Entry) {" },
      { sign: "+", text: "  return Date.now() - entry.at > TTL_MS" },
      { sign: "+", text: "}" },
    ],
  },
  {
    kind: "spotlight",
    id: "s3",
    start: 88,
    tldr: "sync tick now skips keys already in flight — prevents duplicate pushes under slow networks",
    file: "src/workers/sync.ts",
    hunkHeader: "@@ -88,6 +88,8 @@ async function tick()",
    lines: [
      { sign: " ", text: "  for (const key of dirty) {" },
      { sign: "+", text: "    if (inflight.has(key)) continue" },
      { sign: "+", text: "    inflight.add(key)" },
      { sign: " ", text: "    await push(key)" },
      { sign: " ", text: "  }" },
    ],
  },
];

export const session = {
  branch: "feat/rename-user-service",
  totalHunks: items.reduce((n, it) => n + (it.kind === "group" ? it.members.length : 1), 0),
};
