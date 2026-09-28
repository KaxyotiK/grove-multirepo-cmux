# Refusals

Every refusal prints three parts: a class line with its exit code, an evidence block, and a `try:` line carrying the remedy. With `--json` the same thing arrives as `{schema: "grove-cmux.error/1", class, exit_code, message, evidence, remedy}`.

Exit codes are a contract. A code never means two things. An unclassified failure exits 1 and is a bug worth reporting.

Messages marked **observed** were reproduced in the `gcx-run` guest on 2026-09-06. The rest are the class definitions from the tool's own taxonomy.

## 1 — `E_INTERNAL`

An uncaught failure inside `grove-cmux`. Report it with the stack trace. Do not retry.

## 2 — `E_USAGE` (observed)

Bad flag, missing argument, unknown command. The `try:` line always names the command that does what was wanted.

```
$ grove-cmux run <root> --window <id>
error: E_USAGE (2): run needs --tree <tree>
try: pass --tree <tree>; grove-cmux status lists the Trees of this Grove

$ grove-cmux run <root> --tree nope --window <id> -- x
error: E_USAGE (2): grove tdown has no Tree "nope"
evidence:
  trees: ["tdown@checkout-api","tdown@storefront-web"]
try: use one of: checkout-api, storefront-web

$ grove-cmux open <root> --window <id> -- x
error: E_USAGE (2): open takes nothing after "--"
try: pass agent arguments to grove-cmux run --tree <tree> -- <args>

$ grove-cmux open <root> --window <id> --allow-destructive
error: E_USAGE (2): open never closes anything, so --allow-destructive has no meaning here
try: run grove-cmux sync --allow-destructive to close workspaces whose Tree is gone

$ grove-cmux close <root> --window <id>
error: E_USAGE (2): close does not accept --window
try: run grove-cmux close without --window; close finds each ledgered workspace itself
```

`close` also refuses `--relocate`, `--allow-destructive`, projection-only flags, and anything after `--`. Its supported options are `--dry-run`, `--forget`, `--keep-anchor`, and `--json`.

## 3 — `E_CMUX_UNAVAILABLE`

No cmux control socket: cmux is not running, or the socket is gone. Start cmux, then retry. Not reproduced here.

## 4 — `E_CMUX_AUTH` (observed)

```
$ CMUX_SOCKET_PASSWORD=wrong grove-cmux status <root> --window <id>
error: E_CMUX_AUTH (4): cmux rejected the socket password
evidence:
  method: list-windows
  stderr: Error: ERROR: Invalid password
try: set CMUX_SOCKET_PASSWORD, or arm the password in cmux Settings, then retry
```

The transcript above is specifically a Password-mode test. Password mode is not required: for same-user external agents, recommend Automation mode in cmux Settings. If the user chooses to retain Password mode, configure its password there or supply `CMUX_SOCKET_PASSWORD`. Do not change access modes automatically or retry blind. Verify a successful `cmux list-windows --id-format uuids` before retrying projection. If `new` already created the Grove, resume with `open` at its existing root.

## 5 — `E_CMUX_TARGET`

Outside `close`, this means a target the caller named does not exist; a conflicting target from the ledger routes to 13 instead. Run `grove-cmux status` to list the ids that do exist. `close` is the deliberate exception: a failed `workspace.list` or `workspace.group.list` read and a failed post-close verification use this class, name the unreadable window, and preserve the uncleared ledger. Verification also fails, with the same class and the same preserved ledger, when a ledgered workspace is still live afterwards (`evidence.planned: false` means the first scan could not see it) or when the owned group survives with no foreign member. Rerun `close`; never delete the ledger to get past it.

## 6 — `E_CMUX_RPC`

An RPC failed for a reason the tool does not classify. Read the evidence. If cmux is healthy, report it.

## 7 — `E_CMUX_INCOMPATIBLE`

A required method is absent, or the build is below the declared minimum. Upgrade cmux. A build that merely *differs* from the verified build is a warning, not a refusal, so do not treat a version-drift warning as something to fix before proceeding.

Each command requires only the methods it calls. `close --keep-anchor` is stricter about the one method it needs last: when it plans to dissolve the owned group, `cmux capabilities` must list `workspace.group.ungroup`, and `evidence.method_list: unavailable` means the build could not say. Nothing has been closed; run the default `close` instead, or use a build that lists the method.

## 8 — `E_GROVE_FAILED` (observed)

grove exited non-zero, or its binary is not on PATH. Run the command in `args` directly and fix what grove reports.

```
$ grove-cmux new tdown --repo nosuch --window <id>
error: E_GROVE_FAILED (8): grove exited non-zero
evidence:
  bin: grove
  args: ["--json","new","tdown","--repo","nosuch"]
  exit_code: 2
  stderr: —
try: run the grove command in the evidence directly and fix what it reports
```

Check the `args` line before anything else: it is exactly what grove received. Run it yourself to see grove's reason; here `grove --json new tdown --repo nosuch` answers `No unique repository "nosuch"`, and `grove repo ls` lists the ones that exist.

## 9 — `E_GROVE_SCHEMA`

grove emitted a `schemaVersion` this build does not understand, or named no path where one was required. Upgrade `grove-cmux`, or pin grove.

## 10 — `E_LEDGER`

The ledger is unreadable, unparsable, written by a newer schema, or could not be updated after a verified close. A final ledger update/removal failure is reported rather than claiming ownership was successfully cleared or forgotten.

**Never delete the ledger to clear this.** Its own remedy says so: it is the only record of ownership, and deleting it turns every workspace it named into an orphan that nothing can address. Upgrade `grove-cmux` instead, or fix the file.

## 11 — `E_AMBIGUOUS_TARGET` (observed)

Two or more candidates and nothing named one.

```
$ grove-cmux new tdown5 --repo=checkout-api
error: E_AMBIGUOUS_TARGET (11): 14 cmux windows are open and nothing named which one to use
evidence:
  windows: [{"id":"20E3B5C1-…","title":"0: … workspaces=17"}, …]
try: pass --window <id>, one of: 20E3B5C1-…, 3A190273-…, …
```

Pass `--window <id>` from the evidence, or ask the user which window. Do not reach for `--window focused`: the tool runs outside cmux, so focused means last-focused.

On `new`, this refusal comes **after** `grove new` has already created the Grove. Recover with `grove-cmux open <root> --window <id>`; a second `new` will fail because the Grove exists.

The same class also fires when `--tree` matches more than one Tree. Pass the full `<grove>@<repo>` name.

## 12 — `E_PRECONDITION` (observed)

The world cannot host the command.

```
$ grove-cmux status ~/work/groves/tdown2 --window <id>
error: E_PRECONDITION (12): the Grove root does not exist: /Users/admin/work/groves/tdown2
try: check the path in the evidence exists and is a Grove

$ grove-cmux run <root> --tree checkout-api --agent nosuch --window <id> -- x
error: E_PRECONDITION (12): grove defines no agent named "nosuch"
evidence:
  defined: ["prover","claude-task"]
try: use one of: prover, claude-task, or grove agent add nosuch <command>
```

A missing Grove root is the signal that matters most. It means the Grove was archived or deleted. When the conventional `<workspace>/archives/<grove>` contains a readable ledger for the same Grove, the evidence includes `archived_at` and the remedy says to run `grove-cmux` against that exact path. A missing, malformed, unreadable, or wrong-name archive ledger is treated as absent evidence, so the original missing-root message and generic remedy remain unchanged.

`close` also uses this class when the Grove exists but has no projection ledger. Inspect it with `grove-cmux status`; do not fabricate or infer ownership from paths.

The undefined-agent check runs before cmux is touched, so a mistyped agent name creates nothing.

## 13 — `E_PROJECTION_CONFLICT` (observed)

The Grove is already projected in another window, or its recorded window is gone.

```
$ grove-cmux open <root> --window <WB>
error: E_PROJECTION_CONFLICT (13): grove tdown6 is already projected in window 4ED3D11E-…
evidence:
  recorded_window: 4ED3D11E-…
  found_window: 4ED3D11E-…
  requested_window: 83C680E9-…
  workspaces_found: 2
try: run against window 4ED3D11E-…, or pass --relocate to re-project here and leave that window alone
```

Run against the window in the evidence. **`--relocate` is not a retry.** It builds a second projection here, abandons the objects there, and rewrites the ledger so it no longer names them:

```
$ grove-cmux open <root> --window <WB> --relocate
note: window 4ED3D11E-… still holds this Grove's old workspaces; nothing there was closed
created 1 group; created 1 workspace
```

Use it only when the user wants a second copy, and capture the old ids from the ledger first.
