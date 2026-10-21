# `caller-and-helper`, attempt `1`, `2026-10-08`

## Inputs

- **Instruction revision:** gyst commit `4ccc632528de6523bc2571ca51b030519e2e5343` the package was
  packed from; last commit to `apps/gyst/skills/gyst/`: `c2fc512386e818e737a08c374480f5dc680f674d`
  (last to `apps/gyst/skills/` as a whole: `5967e6c2a6f9c39d6b491b8f26597e34076dddcf`);
  `@gyst/cli` `0.1.2`, tarball sha256
  `62256a80f03b5a61bde946a617bb0df33fe82fb8f6e1ea795bca87abd661603b`.
- **Case:** `caller-and-helper.bundle`, scope `main...feature`, commits `main` `97dd67699556e149190fb38119ad71f7e273a2c5`, `feature` `e1f93c1c97071088c82440d8f4dc12534d3455c2`.
- **Request given to the agent:** passed as pi's message argument, verbatim:

  ```text
  /skill:gyst Prepare a gyst walkthrough of the Git range main...feature in this repository.
  ```

- **Model and harness:** pi `1.0.4` in print mode (`pi -p`), `anthropic/claude-opus-5-5`, thinking
  level `high` (the pi settings default). Flags: `--no-skills`, `--no-context-files`,
  `--no-prompt-templates`, `--no-extensions`, `--no-mcp`, three `--skill` paths and a new
  `--session-dir`.
  Run from 2026-10-08T23:39:47Z to 2026-10-08T23:41:28Z.
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

- **Session:** `9dfa99bb-09a3-4c4c-a6c6-91d06f2ff407`, snapshot
  `887692e57e34792c23d5776ab0b60bd3478b0e72307449821216c643e49cde7c`.
- **Final status:** [`2026-10-08-caller-and-helper-1.status.json`](2026-10-08-caller-and-helper-1.status.json).
- **Rejected batches:** None. Two batches, both accepted on first submission (revisions 1 and 2); no `validation_failed`, `stale_revision` or other gyst error appears in the transcript. Three read-only shell commands exited non-zero on the agent's own tooling: piping `gyst session code` into `python3`, which is not on the generator's `PATH` (exit 127); a `which jq` probe (exit 1); and a loop whose `grep` over `node --test` output matched nothing (exit 1). The agent rewrote each; none was a gyst command error.
- **Questions:** none. Print mode has no human to answer, and the agent asked nothing.

## Structural check

**Pass.** `preparation.state` is `complete`: `groupedHunks` 7 of `totalHunks` 7, `overviewMissing` `false`, `overviewOutdated` `false`, `groupsMissingOverview` `[]`, `groupsOutdated` `[]`, `notesOutdated` `[]`. Final revision 2, 2 groups, 8 notes.

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

Exported from the final status [`2026-10-08-caller-and-helper-1.status.json`](./2026-10-08-caller-and-helper-1.status.json) (revision 2) and `gyst session diff` for the same snapshot. Overviews and notes are the agent's Markdown, unedited; each sits between rules. Headings, hunk lists and code excerpts (read with `gyst session code`) were added for reading only. The repository formatter (`vp fmt`, part of `pnpm check`) normalizes this file without changing what it renders: emphasis written `*x*` reads `_x_` here, tables are padded and trailing spaces in excerpts are dropped. The status file holds the exact text; the formatter only re-indents its JSON.

### Walkthrough overview

---

`AccountStore` already keys accounts by identity: [`save`](gyst:new/src/accounts/store.ts#L14-L17) writes under `normalizeEmail(account.email)`, which lowercases, trims and folds Gmail dots, `+tags` and `googlemail.com` ([`normalizeEmail`](gyst:new/src/email.ts#L13-L35)). But [`findByKey`](gyst:new/src/accounts/store.ts#L19-L26) does not normalize, and before this change both entry points passed it the raw address. So the write and the lookup used different keys. This change makes `signUp` and `logIn` normalize before they look up. `store.ts` and `email.ts` are unchanged.

| Call                                                                                         | Before                                                                              | After                                 |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| `signUp` twice with `Ada@example.com`                                                        | second call succeeds and **replaces** the first account under key `ada@example.com` | second call throws `DuplicateAccount` |
| `logIn(" adalovelace+work@GMAIL.com", …)` for an account created as `Ada.Lovelace@gmail.com` | `unknown-account`                                                                   | `ok`                                  |
| `logIn("ada", …)` (not an address)                                                           | `unknown-account`                                                                   | `unknown-account` (unchanged)         |

Read it in two groups:

1. **Check duplicates by identity key at sign-up**: the one-line fix and its tests.
2. **Look up logins by identity key**: the same fix in `logIn`, plus how it handles text that is not an address.

Evidence: ran `node --test` on the `feature` commit (`e1f93c1`, the snapshot's new side): 12 tests pass. With this change's `test/accounts.test.ts` run against `main`'s source, the two spelling tests fail and the other six pass. A probe on `main` signing up `Ada@example.com` twice left one account, the second one, which is the replacement in the first row.

---

<details><summary>Reference 1: <code>src/accounts/store.ts</code> new lines 14–17</summary>

```text
  14    /** Saves `account` under its email's identity key, replacing any account with the same key. */
  15    save(account: Account): void {
  16      this.#byKey.set(normalizeEmail(account.email), account);
  17    }
```

</details>
<details><summary>Reference 2: <code>src/email.ts</code> new lines 13–35</summary>

```text
  13  /**
  14   * The identity key for an email address: addresses that reach the same mailbox get the same key.
  15   *
  16   * Trims surrounding whitespace and lowercases the whole address. For Gmail it also drops dots and
  17   * any `+tag` from the local part, because Gmail delivers `a.da+news@gmail.com` to
  18   * `ada@gmail.com`, and folds `googlemail.com` into `gmail.com`.
  19   *
  20   * Throws `InvalidEmail` unless the input has exactly one `@` with something on both sides.
  21   */
  22  export function normalizeEmail(input: string): string {
  23    const address = input.trim().toLowerCase();
  24    const at = address.indexOf("@");
  25    if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1)
  26      throw new InvalidEmail(input);
  27    let local = address.slice(0, at);
  28    let domain = address.slice(at + 1);
  29    if (gmailDomains.has(domain)) {
  30      local = local.split("+", 1)[0]!.replaceAll(".", "");
  31      domain = "gmail.com";
  32    }
  33    if (local === "") throw new InvalidEmail(input);
  34    return `${local}@${domain}`;
  35  }
```

</details>
<details><summary>Reference 3: <code>src/accounts/store.ts</code> new lines 19–26</summary>

```text
  19    /**
  20     * The account saved under identity key `key`. The key must come from `normalizeEmail`: the
  21     * store does not normalize lookups, so a raw address finds nothing unless it is already in
  22     * normal form.
  23     */
  24    findByKey(key: string): Account | undefined {
  25      return this.#byKey.get(key);
  26    }
```

</details>

### Group 1: Check duplicates by identity key at sign-up

Id `signup-identity-key`; files `src/accounts/signup.ts`, `test/accounts.test.ts`.

---

The fix is one line in [`signUp`](gyst:new/src/accounts/signup.ts#L17-L30): the duplicate check now looks up `normalizeEmail(input.email)`, the same key `store.save` writes under, so the check and the write agree. What is stored is unchanged: `email` stays as typed, only trimmed, and mail still goes there.

Read `signup.ts`, then the two new `signUp` tests; the test-file import feeds the second one.

---

<details><summary>Reference 1: <code>src/accounts/signup.ts</code> new lines 17–30</summary>

```text
  17  /**
  18   * Creates an account, refusing an email whose mailbox already has one. Throws `InvalidEmail`
  19   * for input that is not an address.
  20   */
  21  export function signUp(store: AccountStore, newId: () => string, input: SignUpInput): Account {
  22    if (store.findByKey(normalizeEmail(input.email))) throw new DuplicateAccount(input.email);
  23    const account: Account = {
  24      id: newId(),
  25      email: input.email.trim(),
  26      passwordHash: hashPassword(input.password),
  27    };
  28    store.save(account);
  29    return account;
  30  }
```

</details>

#### Hunks, in order

<details><summary><code>src/accounts/signup.ts</code> <code>@@ -1,3 +1,4 @@</code> (7f981d034ebc0262)</summary>

```diff
@@ -1,3 +1,4 @@
+import { normalizeEmail } from "../email.ts";
 import { hashPassword } from "../password.ts";
 import type { Account, AccountStore } from "./store.ts";

```

</details>

<details><summary><code>src/accounts/signup.ts</code> <code>@@ -13,9 +14,12 @@</code> (32ba8ba9d46708dc)</summary>

```diff
@@ -13,9 +14,12 @@ export interface SignUpInput {
   readonly password: string;
 }

-/** Creates an account, refusing an email that already has one. */
+/**
+ * Creates an account, refusing an email whose mailbox already has one. Throws `InvalidEmail`
+ * for input that is not an address.
+ */
 export function signUp(store: AccountStore, newId: () => string, input: SignUpInput): Account {
-  if (store.findByKey(input.email)) throw new DuplicateAccount(input.email);
+  if (store.findByKey(normalizeEmail(input.email))) throw new DuplicateAccount(input.email);
   const account: Account = {
     id: newId(),
     email: input.email.trim(),
```

</details>

<details><summary><code>test/accounts.test.ts</code> <code>@@ -4,6 +4,7 @@</code> (4934c960ca6bb5a3)</summary>

```diff
@@ -4,6 +4,7 @@ import { describe, it } from "node:test";
 import { logIn } from "../src/accounts/login.ts";
 import { DuplicateAccount, signUp } from "../src/accounts/signup.ts";
 import { AccountStore } from "../src/accounts/store.ts";
+import { InvalidEmail } from "../src/email.ts";

 function setup() {
   const store = new AccountStore();
```

</details>

<details><summary><code>test/accounts.test.ts</code> <code>@@ -28,6 +29,20 @@</code> (0b0ba7baef435662)</summary>

```diff
@@ -28,6 +29,20 @@ describe("signUp", () => {
     signUp("ada@example.com");
     assert.throws(() => signUp("ada@example.com"), DuplicateAccount);
   });
+
+  it("refuses another spelling of the same mailbox and keeps the first account", () => {
+    const { store, signUp } = setup();
+    const first = signUp("ada.lovelace@gmail.com", "first password");
+    for (const email of ["Ada.Lovelace@gmail.com", "adalovelace+shop@googlemail.com"])
+      assert.throws(() => signUp(email, "second password"), DuplicateAccount, email);
+    assert.equal(store.findByKey("adalovelace@gmail.com"), first);
+  });
+
+  it("rejects input that is not an address", () => {
+    const { store, signUp } = setup();
+    assert.throws(() => signUp("ada"), InvalidEmail);
+    assert.equal(store.size, 0);
+  });
 });

 describe("logIn", () => {
```

</details>

#### Note 1.1 (`signup-invalid-order`) on `src/accounts/signup.ts` new lines 17–20

<details><summary>Anchored lines: <code>src/accounts/signup.ts</code> new lines 17–20</summary>

```text
  17  /**
  18   * Creates an account, refusing an email whose mailbox already has one. Throws `InvalidEmail`
  19   * for input that is not an address.
  20   */
```

</details>

---

Invalid input threw `InvalidEmail` before this change too, but from `store.save`, after `newId()` and `hashPassword` had run. It now throws from the lookup, before either of them. The doc comment makes that exception part of the contract.

---

#### Note 1.2 (`signup-lookup-key`) on `src/accounts/signup.ts` new lines 22–22

<details><summary>Anchored lines: <code>src/accounts/signup.ts</code> new lines 22–22</summary>

```text
  22    if (store.findByKey(normalizeEmail(input.email))) throw new DuplicateAccount(input.email);
```

</details>

---

Before, a lookup with a raw address missed an existing account whenever the input was not already in normal form. `save` then [replaced](gyst:new/src/accounts/store.ts#L14-L17) that account under the same key, so a second sign-up took over the first account with a new password. `DuplicateAccount` still quotes the input as typed, not the key.

---

<details><summary>Reference 1: <code>src/accounts/store.ts</code> new lines 14–17</summary>

```text
  14    /** Saves `account` under its email's identity key, replacing any account with the same key. */
  15    save(account: Account): void {
  16      this.#byKey.set(normalizeEmail(account.email), account);
  17    }
```

</details>

#### Note 1.3 (`signup-spelling-test`) on `test/accounts.test.ts` new lines 33–39

<details><summary>Anchored lines: <code>test/accounts.test.ts</code> new lines 33–39</summary>

```text
  33    it("refuses another spelling of the same mailbox and keeps the first account", () => {
  34      const { store, signUp } = setup();
  35      const first = signUp("ada.lovelace@gmail.com", "first password");
  36      for (const email of ["Ada.Lovelace@gmail.com", "adalovelace+shop@googlemail.com"])
  37        assert.throws(() => signUp(email, "second password"), DuplicateAccount, email);
  38      assert.equal(store.findByKey("adalovelace@gmail.com"), first);
  39    });
```

</details>

---

Covers both kinds of folding, case and Gmail dots, tags and domain. The last assertion checks that the first account survived, which is the takeover the old code allowed. Fails against `main`'s source, passes on `feature` (both runs executed).

---

#### Note 1.4 (`signup-invalid-test`) on `test/accounts.test.ts` new lines 41–45

<details><summary>Anchored lines: <code>test/accounts.test.ts</code> new lines 41–45</summary>

```text
  41    it("rejects input that is not an address", () => {
  42      const { store, signUp } = setup();
  43      assert.throws(() => signUp("ada"), InvalidEmail);
  44      assert.equal(store.size, 0);
  45    });
```

</details>

---

Pins behavior that already held on `main`, where this test also passes. It does not tell you whether the throw happened before or after hashing.

---

### Group 2: Look up logins by identity key

Id `login-identity-key`; files `src/accounts/login.ts`, `test/accounts.test.ts`.

---

[`logIn`](gyst:new/src/accounts/login.ts#L9-L15) normalizes the same way, but a login form accepts any text. So the new private helper [`identityKey`](gyst:new/src/accounts/login.ts#L17-L25) turns `InvalidEmail` into "no key", and `logIn` reports `unknown-account` rather than throwing. Sign-up still lets `InvalidEmail` propagate. `LoginResult` is unchanged.

Read `logIn`, then `identityKey`, then the two new `logIn` tests.

---

<details><summary>Reference 1: <code>src/accounts/login.ts</code> new lines 9–15</summary>

```text
   9  export function logIn(store: AccountStore, email: string, password: string): LoginResult {
  10    const key = identityKey(email);
  11    const account = key === undefined ? undefined : store.findByKey(key);
  12    if (account === undefined) return { ok: false, reason: "unknown-account" };
  13    if (!verifyPassword(password, account.passwordHash)) return { ok: false, reason: "wrong-password" };
  14    return { ok: true, account };
  15  }
```

</details>
<details><summary>Reference 2: <code>src/accounts/login.ts</code> new lines 17–25</summary>

```text
  17  // A login form accepts any text; text that is not an address cannot name an account.
  18  function identityKey(email: string): string | undefined {
  19    try {
  20      return normalizeEmail(email);
  21    } catch (error) {
  22      if (error instanceof InvalidEmail) return undefined;
  23      throw error;
  24    }
  25  }
```

</details>

#### Hunks, in order

<details><summary><code>src/accounts/login.ts</code> <code>@@ -1,3 +1,4 @@</code> (d90da84e542ac8d2)</summary>

```diff
@@ -1,3 +1,4 @@
+import { InvalidEmail, normalizeEmail } from "../email.ts";
 import { verifyPassword } from "../password.ts";
 import type { Account, AccountStore } from "./store.ts";

```

</details>

<details><summary><code>src/accounts/login.ts</code> <code>@@ -6,8 +7,19 @@</code> (b975c5d4e480c61e)</summary>

```diff
@@ -6,8 +7,19 @@ export type LoginResult =
   | { readonly ok: false; readonly reason: "unknown-account" | "wrong-password" };

 export function logIn(store: AccountStore, email: string, password: string): LoginResult {
-  const account = store.findByKey(email);
+  const key = identityKey(email);
+  const account = key === undefined ? undefined : store.findByKey(key);
   if (account === undefined) return { ok: false, reason: "unknown-account" };
   if (!verifyPassword(password, account.passwordHash)) return { ok: false, reason: "wrong-password" };
   return { ok: true, account };
 }
+
+// A login form accepts any text; text that is not an address cannot name an account.
+function identityKey(email: string): string | undefined {
+  try {
+    return normalizeEmail(email);
+  } catch (error) {
+    if (error instanceof InvalidEmail) return undefined;
+    throw error;
+  }
+}
```

</details>

<details><summary><code>test/accounts.test.ts</code> <code>@@ -49,4 +64,21 @@</code> (d1414f39880ce34f)</summary>

```diff
@@ -49,4 +64,21 @@ describe("logIn", () => {
       reason: "unknown-account",
     });
   });
+
+  it("accepts any spelling of the account's mailbox", () => {
+    const { store, signUp } = setup();
+    const account = signUp("Ada.Lovelace@gmail.com", "correct horse");
+    assert.deepEqual(logIn(store, " adalovelace+work@GMAIL.com", "correct horse"), {
+      ok: true,
+      account,
+    });
+  });
+
+  it("treats text that is not an address as an unknown account", () => {
+    const { store } = setup();
+    assert.deepEqual(logIn(store, "ada", "correct horse"), {
+      ok: false,
+      reason: "unknown-account",
+    });
+  });
 });
```

</details>

#### Note 2.1 (`login-no-key`) on `src/accounts/login.ts` new lines 10–12

<details><summary>Anchored lines: <code>src/accounts/login.ts</code> new lines 10–12</summary>

```text
  10    const key = identityKey(email);
  11    const account = key === undefined ? undefined : store.findByKey(key);
  12    if (account === undefined) return { ok: false, reason: "unknown-account" };
```

</details>

---

With no key there is no store lookup, and the result goes through the existing `unknown-account` branch. That matches what `main` returned for such input: the raw lookup simply found nothing.

---

#### Note 2.2 (`login-identity-key-helper`) on `src/accounts/login.ts` new lines 18–25

<details><summary>Anchored lines: <code>src/accounts/login.ts</code> new lines 18–25</summary>

```text
  18  function identityKey(email: string): string | undefined {
  19    try {
  20      return normalizeEmail(email);
  21    } catch (error) {
  22      if (error instanceof InvalidEmail) return undefined;
  23      throw error;
  24    }
  25  }
```

</details>

---

Only `InvalidEmail` is swallowed; anything else is rethrown. As captured, [`normalizeEmail`](gyst:new/src/email.ts#L22-L35) throws nothing but `InvalidEmail`, so the rethrow covers only unexpected errors.

---

<details><summary>Reference 1: <code>src/email.ts</code> new lines 22–35</summary>

```text
  22  export function normalizeEmail(input: string): string {
  23    const address = input.trim().toLowerCase();
  24    const at = address.indexOf("@");
  25    if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1)
  26      throw new InvalidEmail(input);
  27    let local = address.slice(0, at);
  28    let domain = address.slice(at + 1);
  29    if (gmailDomains.has(domain)) {
  30      local = local.split("+", 1)[0]!.replaceAll(".", "");
  31      domain = "gmail.com";
  32    }
  33    if (local === "") throw new InvalidEmail(input);
  34    return `${local}@${domain}`;
  35  }
```

</details>

#### Note 2.3 (`login-spelling-test`) on `test/accounts.test.ts` new lines 68–75

<details><summary>Anchored lines: <code>test/accounts.test.ts</code> new lines 68–75</summary>

```text
  68    it("accepts any spelling of the account's mailbox", () => {
  69      const { store, signUp } = setup();
  70      const account = signUp("Ada.Lovelace@gmail.com", "correct horse");
  71      assert.deepEqual(logIn(store, " adalovelace+work@GMAIL.com", "correct horse"), {
  72        ok: true,
  73        account,
  74      });
  75    });
```

</details>

---

The login spelling differs from the sign-up spelling in whitespace, case, dots, a `+tag` and the domain's case. Fails against `main`'s source, passes on `feature` (both runs executed).

---

#### Note 2.4 (`login-invalid-test`) on `test/accounts.test.ts` new lines 77–83

<details><summary>Anchored lines: <code>test/accounts.test.ts</code> new lines 77–83</summary>

```text
  77    it("treats text that is not an address as an unknown account", () => {
  78      const { store } = setup();
  79      assert.deepEqual(logIn(store, "ada", "correct horse"), {
  80        ok: false,
  81        reason: "unknown-account",
  82      });
  83    });
```

</details>

---

Pins that `logIn` never throws for text that is not an address. It also passes on `main`, so this is a regression guard for the new `normalizeEmail` call, not a behavior change.

---
