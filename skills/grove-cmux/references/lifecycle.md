# The commands in detail

The original lifecycle transcripts were captured against cmux `0.64.22 (102) [ddd4a01bc]`, grove 0.3.0 and node 24 in the `gcx-run` Tart guest on 2026-09-06. The shipped `close` flow was verified against the same cmux build in a disposable guest on 2026-09-15.

## Global shape

```
grove-cmux open   [<grove-root>] [options]
grove-cmux sync   [<grove-root>] [options]
grove-cmux status [<grove-root>] [options]
grove-cmux close  [<grove-root>] [options]
grove-cmux new    <name> [grove options...] [options]
grove-cmux run    [<grove-root>] --tree <tree> [--agent <name>] [-- <agent args>...]
```

`<grove-root>` defaults to the working directory. A directory is only a Grove if it has a `trees/` directory or a `.grove-cmux/` ledger; otherwise `E_PRECONDITION`.

| Option | Meaning |
| --- | --- |
| `--window <id\|focused>` | which cmux window to act in; refused by `close` |
| `--tree <tree>` | `run`: short name (`api`) or full name (`grove@api`) |
| `--agent <name>` | a grove-defined agent, checked before anything is created |
| `--allow-destructive` | `sync` only: close workspaces whose Tree is gone. Never the anchor. |
| `--relocate` | re-project into this window and abandon the other one's objects |
| `--dry-run` | `sync` or `close`: print the plan, change nothing |
| `--forget` | `close`: remove `.grove-cmux` after verified success |
| `--keep-anchor` | `close`: retain the anchor and release ownership of it |
| `--all` | show `ignore` rows too. On `new` it is grove's flag and is forwarded. |
| `--json` | machine output |

Environment: `CMUX_SOCKET_PASSWORD`, `GROVE_CMUX_WINDOW=focused`, `GROVE_CMUX_CMUX_BIN`, `GROVE_BIN`. Branding: `GROVE_CMUX_BRAND=off` projects without the group icon, colour and Tree status pill; `GROVE_CMUX_BRAND_ICON` (an SF Symbol) and `GROVE_CMUX_BRAND_COLOR` (hex) change them. Branding is best-effort: a build that cannot brand still projects and says so in a warning.

## Window resolution

First hit wins: `--window <id>`; `--window focused` or `GROVE_CMUX_WINDOW=focused`; the ledger's `window_id`, verified by finding one of our UUIDs there; caller context when cmux supplies one; exactly one window open. Otherwise a mutation refuses `E_AMBIGUOUS_TARGET` and a read enumerates every window.

`close` does not use this resolution ladder. It refuses `--window`, reads every window, and maps each ledgered workspace id to the window that actually holds it.

The focused window is not the default on purpose. `grove-cmux` runs from a shell outside cmux, so cmux is backgrounded and "focused" means last-focused. A refusal costs one re-run with a flag; a wrong-window projection costs N+1 objects to hunt down.

## `new`

```
$ grove-cmux new tdown3 --repo=checkout-api --repo=storefront-web --window 7FC42EEF-…
grove tdown3   /Users/admin/work/groves/tdown3
window 7FC42EEF-638E-474F-AF58-2A4376AC05A5 (flag)   group CF03F04A-… [present]   cmux cmux 0.64.22 (102) [ddd4a01bc]
ledger /Users/admin/work/groves/tdown3/.grove-cmux/projection.json schema 1

  present  tdown3@checkout-api    89784202  /Users/admin/work/groves/tdown3/trees/tdown3@checkout-api
  present  tdown3@storefront-web  83D715DD  /Users/admin/work/groves/tdown3/trees/tdown3@storefront-web

2 present
created 1 group; created 2 workspaces
```

Grove's flags must use `--flag=value`. The space-separated form loses its value:

```
$ grove-cmux new tdown --repo checkout-api --repo storefront-web --window 7FC42EEF-…
error: E_GROVE_FAILED (8): grove exited non-zero
evidence:
  args: ["--json","new","tdown","--repo","--repo"]
  exit_code: 2
```

`grove new` runs before the window is resolved, so a window refusal leaves the Grove created and unprojected:

```
$ grove-cmux new tdown5 --repo=checkout-api
error: E_AMBIGUOUS_TARGET (11): 14 cmux windows are open and nothing named which one to use
try: pass --window <id>, one of: 20E3B5C1-…, 3A190273-…, …
```

Recover with `grove-cmux open <root> --window <id>`. A second `new` fails, because grove refuses to create a Grove that exists.

## `open`

Additive and idempotent. A second `open` on a projected Grove prints the same `present` rows followed by `nothing to do`.

`open` never closes anything, and says so rather than accepting a flag it would ignore:

```
$ grove-cmux open <root> --window <id> --allow-destructive
error: E_USAGE (2): open never closes anything, so --allow-destructive has no meaning here
try: run grove-cmux sync --allow-destructive to close workspaces whose Tree is gone
```

It also refuses a `--` it would silently drop:

```
$ grove-cmux open <root> --window <id> -- x
error: E_USAGE (2): open takes nothing after "--"
try: pass agent arguments to grove-cmux run --tree <tree> -- <args>
```

`open --agent <name>` starts an agent in each workspace **this run creates**, because it rides on `workspace.create`'s `initial_command`. On an already-open Grove it starts nothing, and says so in a warning. It takes no task arguments. For a task, use `run`.

## `status`

Read-only, and asserted so: a mutating call on the read path raises `E_INTERNAL` rather than happening. Exit 0 whenever a report was produced.

Six classifications, in the order they print:

| Class | Meaning | Remedy sync applies |
| --- | --- | --- |
| `present` | ledger names it, it is live, it is in our group | none |
| `detached` | ledger names it, live, not in our group | `group.attach` |
| `missing` | a Tree with no live ledgered workspace | `workspace.create` |
| `stale` | ledger names it, Tree gone from disk | `workspace.close`, only under `--allow-destructive` |
| `foreign` | at a Tree path or the Grove root, not in the ledger | none, ever |
| `ignore` | unrelated to this Grove | none |

Group state is one of `present`, `dissolved` (our group is gone, our workspaces live), `missing` (our group is gone and so are our workspaces), `never_created`.

With no `--window` and several windows open, `status` reports each window in turn rather than refusing.

## `--json`

One window:

```json
{
  "schema": "grove-cmux.status/1",
  "grove":   {"name": "...", "root": "..."},
  "cmux":    {"version": "...", "build": "102", "hash": "...", "minimum_build": "102", "below_minimum": false},
  "window":  {"id": "...", "source": "flag|focused|caller|ledger|sole-window"},
  "ledger":  {"present": true, "path": "...", "schema": 1, "cmux_build": "102"},
  "group":   {"id": "...", "name": "...", "anchor_workspace_id": "...", "state": "present"},
  "items":   [ ... ],
  "summary": {"present": 2, "detached": 0, "missing": 0, "stale": 0, "foreign": 0, "ignore": 1},
  "actions": [ {"op": "...", "tree": "...", "workspace_id": "...", "destructive": false, "reason": "..."} ],
  "warnings": []
}
```

Several windows: `{"schema": "grove-cmux.status/1", "windows": [ <the body above>, ... ]}`.

`sync` adds `applied` (the actions it executed). `run` adds `launched` (`{surface_id, workspace_id, tree, command}`).

`op` is one of `workspace.create`, `group.create`, `group.attach`, `workspace.close`, `group.ungroup`. `status`, `sync --dry-run` and `sync` all consume the identical `actions` array, so the plan and the execution cannot disagree.

## `sync`

```
$ grove-cmux sync <root> --window <id>
  present  tdown@checkout-api    9C7BA245  …/trees/tdown@checkout-api
  stale    tdown@storefront-web  68B493DB  tree no longer on disk

1 present, 1 stale
nothing to do
warning: 1 stale workspace left open; --allow-destructive would close it
```

The warning fires on what the run found, not on the flag passed, so the person who asked for destruction is not the one who never hears it did not happen.

```
$ grove-cmux sync <root> --window <id> --allow-destructive
  present  tdown@checkout-api  9C7BA245  …/trees/tdown@checkout-api

1 present
closed 1
```

The anchor is skipped unconditionally. A destructive sync that removes every Tree leaves the group alive with its anchor.

A ledger row whose workspace someone closed by hand is dropped silently on the next run.

## `close`

```
$ grove-cmux close <root> --dry-run
close would close 3 workspaces

$ grove-cmux close <root>
closed 3
```

Close requires an existing projection ledger. It scans all windows and groups before mutation, builds its action plan directly from ledger-owned ids, and targets each workspace in its actual window. The default closes Tree workspaces first and the anchor last. It never closes a workspace merely because its path matches the Grove.

After mutation, close scans again and requires every ledgered workspace id absent, including an id the first scan could not see: it is live, so the ledger is still its only ownership record. The owned group must also be gone unless a live foreign workspace holds it open. Only then does close clear ownership in the ledger. `--forget` removes `.grove-cmux` after the same verification. Any read, close, ledger-write, or verification failure preserves an uncleared ledger for retry; `--forget` is withheld. A foreign workspace in the owned group survives, and the report warns that the group outlived close.

`--keep-anchor` closes the Trees and substitutes `group.ungroup` when the owned group contains no foreign member and still owns the anchor. If the group is missing, the ungroup is a no-op. If the group has a foreign member, or the anchor is in another group, that group is left intact and a warning names the reason. On success the retained anchor is no longer ledger-owned, so a later `open` creates a new projection beside it. Because every Tree closes before the ungroup, a planned ungroup needs positive evidence first: unless `cmux capabilities` lists `workspace.group.ungroup`, close refuses `E_CMUX_INCOMPATIBLE` before any mutation. Default close and the other five commands never call ungroup and never require it.

`close --dry-run` uses the exact action array the live run would consume and issues no mutating RPC. `close` refuses `--window`, `--relocate`, `--allow-destructive`, and trailing passthrough arguments with `E_USAGE` rather than silently ignoring them.

## `run`

```
$ grove-cmux run <root> --tree checkout-api --agent prover --window <id> -- 'a task'
2 present
nothing to do
launched tdown3@checkout-api in surface 6AF8F5D7: grove agent run tdown3 --tree tdown3@checkout-api --agent prover -- 'a task'; exec "${SHELL:-/bin/zsh}" -l
```

`run` projects first, through the same path `open` uses, then creates a surface in the workspace the ledger names for that Tree. That is what makes "just opened" and "open for a day" the same case, and what makes a second handoff work.

The trailing `exec "${SHELL:-/bin/zsh}" -l` is required, not decoration: cmux closes a workspace as soon as its launch command exits, so without it the workspace vanishes when the agent finishes, scrollback included.

Refusals come before anything is created:

```
$ grove-cmux run <root> --window <id>
error: E_USAGE (2): run needs --tree <tree>
try: pass --tree <tree>; grove-cmux status lists the Trees of this Grove

$ grove-cmux run <root> --tree nope --window <id> -- x
error: E_USAGE (2): grove tdown has no Tree "nope"
evidence:
  trees: ["tdown@checkout-api","tdown@storefront-web"]
try: use one of: checkout-api, storefront-web

$ grove-cmux run <root> --tree checkout-api --agent nosuch --window <id> -- x
error: E_PRECONDITION (12): grove defines no agent named "nosuch"
evidence:
  defined: ["prover","claude-task"]
try: use one of: prover, claude-task, or grove agent add nosuch <command>
```

The agent check runs before cmux is touched, because an undefined agent fails inside the terminal with exit 2 and, under the trailing `exec`, leaves a live shell that looks like a working launch.

`--tree` takes either the short name (`checkout-api`) or the full directory name (`tdown@checkout-api`).

With no `--agent`, the Tree's default grove agent runs.

## Diagnose an apparently empty launch

Read `run`'s reported surface id, workspace id and command. Confirm the configured agent with `grove agent ls` from the correct Grove workspace, then check its configured executable; a listed definition alone does not prove the executable exists or that its authentication works.

cmux resolves the first whitespace-delimited token of `initial_command` as an executable. `export FOO=1; ...`, `{ ... }` and `true; ...` were measured to produce no running command; `grove ...` and `node ...` resolve. Environment belongs in `startup_environment`, not a shell prefix. The generated `run` command starts with `grove`; inspect evidence before blaming it. A surface being created proves routing, not a successful agent response. Inspect that surface and its output, including authentication errors, instead of sending text into an existing terminal that may belong to the user. Do not repeat the task until the earlier launch's state is understood, because another surface can still be running it.

## Repeat handoffs

Two runs into one Tree, with the fixture agent recording its own working directory:

```
$ tail -3 /tmp/agent-proof.txt
/Users/admin/work/groves/tdown/trees/tdown@checkout-api
/Users/admin/work/groves/tdown/trees/tdown@checkout-api
```

Each run reported a distinct surface id, the workspace stayed open, and both agents ran in that Tree's worktree.
