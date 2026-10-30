# `invariant-refactor`, attempt `1`, `2026-10-08`

## Inputs

- **Instruction revision:** gyst commit `4ccc632528de6523bc2571ca51b030519e2e5343` the package was
  packed from; last commit to `apps/gyst/skills/gyst/`: `c2fc512386e818e737a08c374480f5dc680f674d`
  (last to `apps/gyst/skills/` as a whole: `5967e6c2a6f9c39d6b491b8f26597e34076dddcf`);
  `@gyst/cli` `0.1.2`, tarball sha256
  `62256a80f03b5a61bde946a617bb0df33fe82fb8f6e1ea795bca87abd661603b`.
- **Case:** `invariant-refactor.bundle`, scope `main...feature`, commits `main` `0f1f45e03bb391055779e377449fd1a3ee8f7f42`, `feature` `3b8049333b26a922e446833aabcafa3b4b8964f4`.
- **Request given to the agent:** passed as pi's message argument, verbatim:

  ```text
  /skill:gyst Prepare a gyst walkthrough of the Git range main...feature in this repository.
  ```

- **Model and harness:** pi `1.0.4` in print mode (`pi -p`), `anthropic/claude-opus-5-5`, thinking
  level `high` (the pi settings default). Flags: `--no-skills`, `--no-context-files`,
  `--no-prompt-templates`, `--no-extensions`, `--no-mcp`, three `--skill` paths and a new
  `--session-dir`.
  Run from 2026-10-08T23:28:31Z to 2026-10-08T23:39:47Z.
- **Fresh session:** a new pi session with its own session directory and no earlier conversation.
  The process ran under `env -i` with `HOME` and the XDG directories set to an isolated
  `/tmp/gyst-98b-home`; only pi's own config directory (`PI_CODING_AGENT_DIR`) pointed at the real
  one, for its credentials and model settings. Skill, extension, prompt-template, MCP and
  context-file discovery were off, and the only skills were the clone's
  `.agents/skills/{gyst,gyst-respond,gyst-cli}` links into the installed package. The session's
  system message lists exactly `gyst` and `gyst-cli` (`gyst-respond` is loaded but hidden from the
  model by its `disable-model-invocation`). `PATH` held only the installed `gyst`, Node 24.21.0 and
  `/run/current-system/sw/bin` (no `python3` or `jq`); pi's bash tool adds its own ripgrep and fd. `GYST_DATA_DIR` was a new `/tmp/gyst-98b-data`, shared by the four
  cases in turn, with `GYST_PORT=5598`; this case's `open` reported `created: true`.
- **Previous attempts:** none.

## Outputs

- **Session:** `0058665e-72cd-408d-93d7-d6677f662fda`, snapshot
  `7efc9c5a01d97079b3baf8ec58a59f7585b318bb7c3ce47d5ddcb13e84332303`.
- **Final status:** [`2026-10-08-invariant-refactor-1.status.json`](2026-10-08-invariant-refactor-1.status.json).
- **Rejected batches:** None. Two batches, both accepted on first submission (revisions 1 and 2); no `validation_failed`, `stale_revision` or other gyst error appears in the transcript. The second batch's reply was lost because the agent piped it into `python3`, which is not on the generator's `PATH` (exit 127); the agent then read `gyst session status`, saw revision 2 and `complete`, and did not resubmit.
- **Questions:** none. Print mode has no human to answer, and the agent asked nothing.

## Structural check

**Pass.** `preparation.state` is `complete`: `groupedHunks` 4 of `totalHunks` 4, `overviewMissing` `false`, `overviewOutdated` `false`, `groupsMissingOverview` `[]`, `groupsOutdated` `[]`, `notesOutdated` `[]`. Final revision 2, 2 groups, 8 notes.

## Human verdict

Filled in by the human evaluator only.

- **Evaluator and date:**
- **Correctness and evidence:**
- **Mental-model clarity:**
- **Meaningful-step coverage:**
- **Useful examples and references:**
- **Standalone readability:**
- **Economy:**
- **Verdict:** accepted / failed, with the concrete reasons.

## Appendix: the published walkthrough

Exported from the final status [`2026-10-08-invariant-refactor-1.status.json`](./2026-10-08-invariant-refactor-1.status.json) (revision 2) and `gyst session diff` for the same snapshot. Overviews and notes are the agent's Markdown, unedited; each sits between rules. Headings, hunk lists and code excerpts (read with `gyst session code`) were added for reading only. The repository formatter (`vp fmt`, part of `pnpm check`) normalizes this file without changing what it renders: emphasis written `*x*` reads `_x_` here, tables are padded and trailing spaces in excerpts are dropped. The status file holds the exact text; the formatter only re-indents its JSON.

### Walkthrough overview

---

A refactor of `LruCache` in `src/lru.ts`. Before, it kept values in a `#values` Map and recency in a separate `#order` array, so every `get`, replace and `delete` searched and spliced the array: O(n) per use. Now one `#entries` Map holds both, because a `Map` iterates in insertion order: deleting and reinserting a key on use moves it to the end, and the first key is always the next eviction.

**Invariant to check:** the `#entries` iteration order is exactly the old `#order` array, least to most recently used, after every public operation. If it holds, `keys()`, `size` and the choice of eviction victim are unchanged. The public API is unchanged, and [`memoize`](gyst:new/src/memo.ts#L12-L21) is untouched.

| Step                 | Before                                 | After                              |
| -------------------- | -------------------------------------- | ---------------------------------- |
| Use (`get`, replace) | `#values.set` + splice `#order` + push | `#use`: delete + set on `#entries` |
| Evict                | `#order.shift()` + `#values.delete`    | first entry of `#entries`, deleted |
| `delete`             | `#values.delete` + splice `#order`     | `#entries.delete`                  |

One observable difference: a `NaN` key. The old array lookup used `indexOf` (`===`), which never finds `NaN`, while a `Map` matches it; see the note on the removed `#touch`. String-keyed `memoize` cannot produce a `NaN` key.

Read in two steps:

1. **One Map holds values and recency**: the new field and the read paths.
2. **Write paths and eviction on the single Map**: `set`, `delete`, eviction, and the two tests that pin delete and eviction order.

Verification run on the snapshot's commits: `node --test` on `feature` passes 9 of 9; the `feature` test file run against `main`'s `src/lru.ts` also passes 9 of 9, so the new tests describe behavior the old code already had.

---

<details><summary>Reference 1: <code>src/memo.ts</code> new lines 12–21</summary>

```text
  12  export function memoize<A, V>(fn: (arg: A) => V, options: MemoOptions<V>): (arg: A) => V {
  13    const cache = new LruCache<string, V>(options.capacity, options.onEvict);
  14    return (arg) => {
  15      const key = JSON.stringify(arg);
  16      if (cache.has(key)) return cache.get(key)!;
  17      const value = fn(arg);
  18      cache.set(key, value);
  19      return value;
  20    };
  21  }
```

</details>

### Group 1: One Map holds values and recency

Id `single-map`; files `src/lru.ts`.

---

Start at the [new field and its comment](gyst:new/src/lru.ts#L12-L16): it states the invariant the whole change relies on. Then the read methods: `size`, `has` and `peek` read the same Map and do not reorder it, so inspecting the cache still never changes what it evicts next. `get` is the one read that counts as a use, and moves its key to the end through [`#use`](gyst:new/src/lru.ts#L69-L72).

---

<details><summary>Reference 1: <code>src/lru.ts</code> new lines 12–16</summary>

```text
  12    /**
  13     * Every entry, from least to most recently used. A `Map` iterates in insertion order, so a use
  14     * deletes and reinserts its key to move it to the end, and the first key is the next eviction.
  15     */
  16    readonly #entries = new Map<K, V>();
```

</details>
<details><summary>Reference 2: <code>src/lru.ts</code> new lines 69–72</summary>

```text
  69    #use(key: K, value: V): void {
  70      this.#entries.delete(key);
  71      this.#entries.set(key, value);
  72    }
```

</details>

#### Hunks, in order

<details><summary><code>src/lru.ts</code> <code>@@ -9,9 +9,11 @@</code> (bee368c51382ab9e)</summary>

```diff
@@ -9,9 +9,11 @@ export type EvictionListener<K, V> = (key: K, value: V) => void;
  */
 export class LruCache<K, V> {
   readonly capacity: number;
-  readonly #values = new Map<K, V>();
-  /** Every key, from least to most recently used. */
-  #order: K[] = [];
+  /**
+   * Every entry, from least to most recently used. A `Map` iterates in insertion order, so a use
+   * deletes and reinserts its key to move it to the end, and the first key is the next eviction.
+   */
+  readonly #entries = new Map<K, V>();
   readonly #onEvict: EvictionListener<K, V> | undefined;

   constructor(capacity: number, onEvict?: EvictionListener<K, V>) {
```

</details>

<details><summary><code>src/lru.ts</code> <code>@@ -22,22 +24,23 @@</code> (1759e064885c1957)</summary>

```diff
@@ -22,22 +24,23 @@ export class LruCache<K, V> {
   }

   get size(): number {
-    return this.#order.length;
+    return this.#entries.size;
   }

   has(key: K): boolean {
-    return this.#values.has(key);
+    return this.#entries.has(key);
   }

   /** The value for `key` without marking it used. */
   peek(key: K): V | undefined {
-    return this.#values.get(key);
+    return this.#entries.get(key);
   }

   get(key: K): V | undefined {
-    if (!this.#values.has(key)) return undefined;
-    this.#touch(key);
-    return this.#values.get(key);
+    if (!this.#entries.has(key)) return undefined;
+    const value = this.#entries.get(key)!;
+    this.#use(key, value);
+    return value;
   }

   /**
```

</details>

#### Note 1.1 (`entries-invariant`) on `src/lru.ts` new lines 12–16

<details><summary>Anchored lines: <code>src/lru.ts</code> new lines 12–16</summary>

```text
  12    /**
  13     * Every entry, from least to most recently used. A `Map` iterates in insertion order, so a use
  14     * deletes and reinserts its key to move it to the end, and the first key is the next eviction.
  15     */
  16    readonly #entries = new Map<K, V>();
```

</details>

---

`Map.prototype.set` on an existing key keeps its original position, so moving a key to the most-recent end needs the delete before the set. Before, the keys of `#values` and the contents of `#order` had to agree; now there is only one structure, so they cannot drift apart.

---

#### Note 1.2 (`get-reads-before-use`) on `src/lru.ts` new lines 39–44

<details><summary>Anchored lines: <code>src/lru.ts</code> new lines 39–44</summary>

```text
  39    get(key: K): V | undefined {
  40      if (!this.#entries.has(key)) return undefined;
  41      const value = this.#entries.get(key)!;
  42      this.#use(key, value);
  43      return value;
  44    }
```

</details>

---

The value is read before `#use` because `#use` reinserts it. The `!` is only a type assertion: the `has` guard has already settled presence, so a stored `undefined` value is still returned as `undefined`, as before.

---

### Group 2: Write paths and eviction on the single Map

Id `write-paths`; files `src/lru.ts`, `test/lru.test.ts`.

---

Read [`set`](gyst:new/src/lru.ts#L50-L57) first, then the two private helpers it calls, `#use` and `#evictOldest`, and compare them with the [old `set`](gyst:old/src/lru.ts#L47-L61). The order of effects is unchanged: a replaced key moves to the end without evicting; a new key at capacity first removes the oldest entry, then reports it, then inserts. The two new tests pin the parts of that order a rewrite could most easily break.

For example, with capacity 2 holding `a`, `b`: `set("c")` evicts `a`, and the listener sees `keys()` as `["b"]`, without `a` and before `c` is added.

---

<details><summary>Reference 1: <code>src/lru.ts</code> new lines 50–57</summary>

```text
  50    set(key: K, value: V): void {
  51      if (this.#entries.has(key)) {
  52        this.#use(key, value);
  53        return;
  54      }
  55      if (this.#entries.size === this.capacity) this.#evictOldest();
  56      this.#entries.set(key, value);
  57    }
```

</details>
<details><summary>Reference 2: <code>src/lru.ts</code> old lines 47–61</summary>

```text
  47    set(key: K, value: V): void {
  48      if (this.#values.has(key)) {
  49        this.#values.set(key, value);
  50        this.#touch(key);
  51        return;
  52      }
  53      if (this.#order.length === this.capacity) {
  54        const oldest = this.#order.shift()!;
  55        const evicted = this.#values.get(oldest)!;
  56        this.#values.delete(oldest);
  57        this.#onEvict?.(oldest, evicted);
  58      }
  59      this.#values.set(key, value);
  60      this.#order.push(key);
  61    }
```

</details>

#### Hunks, in order

<details><summary><code>src/lru.ts</code> <code>@@ -45,35 +48,32 @@</code> (02511a2a4a2c2e64)</summary>

```diff
@@ -45,35 +48,32 @@ export class LruCache<K, V> {
    * a new key at capacity first evicts the least recently used one.
    */
   set(key: K, value: V): void {
-    if (this.#values.has(key)) {
-      this.#values.set(key, value);
-      this.#touch(key);
+    if (this.#entries.has(key)) {
+      this.#use(key, value);
       return;
     }
-    if (this.#order.length === this.capacity) {
-      const oldest = this.#order.shift()!;
-      const evicted = this.#values.get(oldest)!;
-      this.#values.delete(oldest);
-      this.#onEvict?.(oldest, evicted);
-    }
-    this.#values.set(key, value);
-    this.#order.push(key);
+    if (this.#entries.size === this.capacity) this.#evictOldest();
+    this.#entries.set(key, value);
   }

   /** Removes `key` without reporting it as evicted. */
   delete(key: K): boolean {
-    if (!this.#values.delete(key)) return false;
-    this.#order.splice(this.#order.indexOf(key), 1);
-    return true;
+    return this.#entries.delete(key);
   }

   /** Every key, from least to most recently used. */
   keys(): K[] {
-    return [...this.#order];
+    return [...this.#entries.keys()];
+  }
+
+  #use(key: K, value: V): void {
+    this.#entries.delete(key);
+    this.#entries.set(key, value);
   }

-  #touch(key: K): void {
-    this.#order.splice(this.#order.indexOf(key), 1);
-    this.#order.push(key);
+  #evictOldest(): void {
+    const [oldest, evicted] = this.#entries.entries().next().value!;
+    this.#entries.delete(oldest);
+    this.#onEvict?.(oldest, evicted);
   }
 }
```

</details>

<details><summary><code>test/lru.test.ts</code> <code>@@ -51,6 +51,23 @@</code> (eaa8dc7dd500ce5b)</summary>

```diff
@@ -51,6 +51,23 @@ describe("LruCache", () => {
     assert.deepEqual(evicted, []);
   });

+  it("fills a slot freed by delete without evicting", () => {
+    const { cache, evicted } = filled(2, "a", "b");
+    cache.delete("a");
+    cache.set("c", 2);
+    assert.deepEqual(evicted, []);
+    assert.deepEqual(cache.keys(), ["b", "c"]);
+  });
+
+  it("reports an eviction after removing the entry and before adding the new one", () => {
+    const seen: string[][] = [];
+    const cache: LruCache<string, number> = new LruCache(2, () => seen.push(cache.keys()));
+    cache.set("a", 0);
+    cache.set("b", 1);
+    cache.set("c", 2);
+    assert.deepEqual(seen, [["b"]]);
+  });
+
   it("rejects a capacity below one", () => {
     assert.throws(() => new LruCache(0), RangeError);
     assert.throws(() => new LruCache(1.5), RangeError);
```

</details>

#### Note 2.1 (`touch-nan`) on `src/lru.ts` old lines 75–78

<details><summary>Anchored lines: <code>src/lru.ts</code> old lines 75–78</summary>

```text
  75    #touch(key: K): void {
  76      this.#order.splice(this.#order.indexOf(key), 1);
  77      this.#order.push(key);
  78    }
```

</details>

---

Removed code had an edge case: `indexOf` uses `===`, so for a `NaN` key it returned `-1`, and `splice(-1, 1)` removed the _last_ key instead. `Map` uses SameValueZero, so the new code handles `NaN`. This changes observable behavior for `NaN` keys only. Ran a script on both commits: with capacity 3, `set("a")`, `set(NaN)`, `set("b")`, `get(NaN)` leaves `keys()` as `["a", NaN, NaN]` on `main` and `["a", "b", NaN]` on `feature`. No test covers this.

---

#### Note 2.2 (`set-paths`) on `src/lru.ts` new lines 51–56

<details><summary>Anchored lines: <code>src/lru.ts</code> new lines 51–56</summary>

```text
  51      if (this.#entries.has(key)) {
  52        this.#use(key, value);
  53        return;
  54      }
  55      if (this.#entries.size === this.capacity) this.#evictOldest();
  56      this.#entries.set(key, value);
```

</details>

---

Replacing goes through `#use`, which deletes and reinserts with the new value: the same result as the old `#values.set` plus `#touch`. A new key is a plain `set`, which appends it at the most recent end.

---

#### Note 2.3 (`delete-single-call`) on `src/lru.ts` new lines 60–62

<details><summary>Anchored lines: <code>src/lru.ts</code> new lines 60–62</summary>

```text
  60    delete(key: K): boolean {
  61      return this.#entries.delete(key);
  62    }
```

</details>

---

`Map.prototype.delete` already returns whether the key was present, so the return value matches the old version, and there is no second structure to splice.

---

#### Note 2.4 (`evict-oldest`) on `src/lru.ts` new lines 74–78

<details><summary>Anchored lines: <code>src/lru.ts</code> new lines 74–78</summary>

```text
  74    #evictOldest(): void {
  75      const [oldest, evicted] = this.#entries.entries().next().value!;
  76      this.#entries.delete(oldest);
  77      this.#onEvict?.(oldest, evicted);
  78    }
```

</details>

---

The first entry of the iterator is the least recently used one. The `!` on `.value` is safe because the only caller runs it when `size === capacity`, and the constructor requires `capacity >= 1`, so the Map is never empty here. Deleting before calling `#onEvict` keeps the old order of effects.

---

#### Note 2.5 (`test-delete-frees-slot`) on `test/lru.test.ts` new lines 53–59

<details><summary>Anchored lines: <code>test/lru.test.ts</code> new lines 53–59</summary>

```text
  53
  54    it("fills a slot freed by delete without evicting", () => {
  55      const { cache, evicted } = filled(2, "a", "b");
  56      cache.delete("a");
  57      cache.set("c", 2);
  58      assert.deepEqual(evicted, []);
  59      assert.deepEqual(cache.keys(), ["b", "c"]);
```

</details>

---

Pins that `delete` frees capacity: `size` now comes from the Map, so the next new key fits without evicting.

---

#### Note 2.6 (`test-evict-order`) on `test/lru.test.ts` new lines 61–68

<details><summary>Anchored lines: <code>test/lru.test.ts</code> new lines 61–68</summary>

```text
  61
  62    it("reports an eviction after removing the entry and before adding the new one", () => {
  63      const seen: string[][] = [];
  64      const cache: LruCache<string, number> = new LruCache(2, () => seen.push(cache.keys()));
  65      cache.set("a", 0);
  66      cache.set("b", 1);
  67      cache.set("c", 2);
  68      assert.deepEqual(seen, [["b"]]);
```

</details>

---

The listener records `keys()` when it is called, so `[["b"]]` proves the victim is already gone and the new key is not yet added. Ran `node --test`: this test passes on `feature`, and also against `main`'s implementation.

---
