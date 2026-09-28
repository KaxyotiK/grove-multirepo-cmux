---
name: grove-cmux
description: "Operate a Grove’s cmux projection: open, reconcile, inspect, hand off an agent task, or close its ledger-owned workspaces. Select for grove-cmux commands, .grove-cmux/projection.json, and archiving or deleting a Grove explicitly open in cmux. Do not select for Grove-only questions such as creating Groves, adding repositories, or managing Git when no cmux projection is involved."
metadata:
  targets: [claude, codex, pi]
---

# grove-cmux

`grove-cmux` projects a Grove into cmux. This skill covers the whole life of one projection, including ledger-driven close and reopening after ownership is released.

Do not use this skill for `grove` itself. Creating, archiving, deleting and syncing Groves is the `grove` CLI's business. This skill owns the projection — the cmux objects, the ledger that names them, and the order grove-side and cmux-side steps have to happen in.

## The model

1. A **Grove** is one unit of work across several repositories. Each repository's worktree in it is a **Tree**, named `<grove>@<repo>`, at `<grove-root>/trees/<grove>@<repo>`. In the standard workspace layout the root is `<workspace>/groves/<grove>`; confirm the workspace/root from Grove or the user before acting on a name.
2. `grove-cmux` projects that as one cmux **group**, an **anchor** workspace at the Grove root, and one **member** workspace per Tree.
3. The **ledger** at `<grove-root>/.grove-cmux/projection.json` maps Tree name to workspace UUID and records the group, anchor and window. It is the only answer to "did we create this".
4. **Path is never a capability.** A workspace at a Tree path is not ours unless the ledger names it. `grove-cmux` creates a second workspace beside a stranger's rather than adopt it.
5. **The ledger lives inside the Grove.** Anything that removes the Grove directory removes the ledger from that path. Archive moves it to `<workspace>/archives/<grove>`; delete can destroy it and make the projection unreachable through `grove-cmux`.

Point 5 generates every teardown rule below.

## Local setup

For agents running outside cmux, recommend **Settings → Automation → Socket Control Mode → Automation mode**: local processes owned by the same macOS user can connect without a password. `cmux processes only` is suitable when all callers start inside cmux. Password mode is optional; configure its password only if that mode is chosen. Full open access is unnecessary here. Do not change the user's access mode merely to retry a failure.

Before `new`, verify `cmux list-windows --id-format uuids` succeeds from the agent's environment and resolve the intended window. Repeat after settings changes or cmux restart. If Grove creation already succeeded, recover with `open` at that root, never a second `new`.

## Commands

```
grove-cmux open   [<grove-root>] [--window <id|focused>] [--agent <name>] [--relocate]
grove-cmux sync   [<grove-root>] [--allow-destructive] [--dry-run] [--window <id>]
grove-cmux status [<grove-root>] [--all] [--json] [--window <id>]
grove-cmux close  [<grove-root>] [--dry-run] [--forget] [--keep-anchor]
grove-cmux new    <name> [grove options...] [--window <id>]
grove-cmux run    [<grove-root>] --tree <tree> [--agent <name>] [-- <agent args>...]
```

`open` and `sync` are the same reconcile pass; `sync --allow-destructive` closes stale Tree workspaces but never the anchor. `close` tears down the whole ledger-owned projection. `status` issues no mutating call and exits 0 whenever it produced a report, so a non-zero exit from `status` is always a refusal and never a finding.

Read `references/lifecycle.md` for flags, classifications and the `--json` shape.

## Stand a projection up

```bash
grove-cmux open <grove-root> --window <window-id>          # existing Grove
grove-cmux new  <name> --repo=<repo> --window <window-id>   # create, then project
```

Two things to know on `new`:

- **Grove's flags pass through.** Everything after the Grove name, except grove-cmux's own flags (`--window`, `--agent`, `--json`), reaches `grove new` in order, so `--repo api` and `--repo=api` both work. `--all` on `new` is grove's.
- **`new` runs `grove new` before it resolves the window.** If window resolution then refuses, the Grove exists on disk and is unprojected. Recover with `grove-cmux open <root> --window <id>`, never a second `new`.

Pass `--window <id>` for projection mutations unless exactly one cmux window is open. `close` is the exception: it refuses `--window` and finds each ledgered workspace in its actual window. Do not reach for `--window focused` as an automatic retry — from outside cmux it means last-focused, not necessarily the window the person is looking at. If the user explicitly chooses that fallback, explain the consequence and honor that choice; otherwise resolve a concrete id.

## Work in it

```bash
grove-cmux status <root> --window <id>            # read-only
grove-cmux status <root> --window <id> --all      # include unrelated workspaces
grove-cmux status <root> --json                   # machine shape
grove-cmux sync   <root> --window <id> --dry-run  # the plan, executing nothing
grove-cmux sync   <root> --window <id>            # additive reconcile
```

`present` is projected and in our group. `detached` is ours but out of the group — sync re-attaches. `missing` — sync creates. `stale` means the Tree is gone from disk and only `--allow-destructive` closes it. `foreign` is at a Tree path or the Grove root and not in the ledger; it is somebody else's and is never touched. `ignore` is unrelated.

Never try to make `grove-cmux` adopt a `foreign` workspace. There is no flag for it and that is deliberate.

## Hand a task to an agent

```bash
grove-cmux run <root> --tree <tree> --agent <name> --window <id> -- 'the whole prompt'
```

Everything after `--` reaches the agent verbatim, so a multi-word prompt stays one argument. `run` works on an already-open Grove and is repeatable: run it again for the next task.

`open --agent` is not a handoff. It launches through workspace creation, so it starts an agent once per Tree and never again, and it takes no task arguments. If someone wants to hand a second task to a Tree, that is `run`.

If a launch reports success but the agent is absent, read the reported surface, workspace and command first. Use the launch diagnosis in `references/lifecycle.md`; do not type into an existing terminal that may be running the user's shell or another process.

## Close a projection

Preview every close, then run the same command without `--dry-run`:

```bash
grove-cmux close <root> --dry-run
grove-cmux close <root>
```

Do not pass `--window`. `close` enumerates every window, locates each ledgered workspace by UUID, and closes Tree workspaces before the anchor in their actual windows. It performs every required read before mutation and verifies absence afterward. A read, mutation, or verification failure leaves the ownership ledger uncleared so the same command can be retried safely.

A successful default close keeps a cleared ledger: `trees` is `{}` and the group, anchor, and window ids are null. A later `open <root> --window <id>` creates a new projection with new ids. Use `--forget` when the `.grove-cmux` directory should be removed after verified success, such as before archive or permanent deletion.

`--keep-anchor` closes the Tree workspaces and safely ungroups the owned group, leaving the anchor as a plain workspace. It releases ownership of that anchor; a later `open` creates a new anchor and group beside it. A missing group is a successful no-op. A group with foreign members, or an anchor inside a foreign group, is left intact with a warning. Foreign workspaces are never closed. When it plans to ungroup, it refuses `E_CMUX_INCOMPATIBLE` before any mutation unless `cmux capabilities` lists `workspace.group.ungroup`; the default close does not need that method.

For an active Grove, close before Grove moves or removes the ledger:

```bash
grove-cmux close <root> --dry-run --forget
grove-cmux close <root> --forget
grove archive <grove>        # reversible route
# or: grove delete <grove>   # permanent route, with plain Grove safety checks
```

If the Grove is already archived, close `<workspace>/archives/<grove>` with `--forget`. For permanent deletion, then run plain `grove delete <grove>`, which accepts an archived Grove. Never add Grove's `--allow-destructive-all` to bypass a refusal.

Read `references/teardown.md` for failure recovery, foreign-group behavior, the measured 3 → 2 → 1 → 0 group lifecycle, and the manual RPC fallback for older builds that have no `close`.

## Refuse these

**`grove delete <grove> --allow-destructive-all` while the projection is live.** It deletes the root and the ledger and leaves the group, anchor and every Tree workspace alive with nothing naming them. `grove-cmux status` and `grove-cmux sync` then both exit 12 at that path, forever. Recreating the Grove does not recover it — the orphans classify as `foreign` and sync builds a second group beside them. That refusal on `.grove-cmux` is the guard; run `close --forget` first.

**`--relocate` as a retry for `E_PROJECTION_CONFLICT`.** It builds a second projection in the new window and abandons the first, and the ledger stops naming the abandoned ids. Its own stderr note is the only record. Run against the window in the evidence unless the user actually wants a second copy; if they do, capture the old ids from the ledger before relocating.

**Adopting a workspace because it sits at the right path.** Not by flag, not by hand-editing the ledger, not for orphans you just created. A ledger you wrote yourself is not a record of ownership. If the ledger has already been destroyed, confirm identities with the user before handling the orphans directly in cmux.

**Guessing a window after `E_AMBIGUOUS_TARGET`.** Use a resolved id unless the user explicitly chooses the focused fallback after its last-focused meaning is clear.

## Refusals

Every refusal prints its class, evidence and a `try:` line. Read the `try:` line.

| Exit | Class | What to do |
| --- | --- | --- |
| 2 | `E_USAGE` | The `try:` line names the command that does what was wanted. |
| 3 | `E_CMUX_UNAVAILABLE` | Start cmux. |
| 4 | `E_CMUX_AUTH` | Set `CMUX_SOCKET_PASSWORD`. Do not retry blind. |
| 5 | `E_CMUX_TARGET` | Run `grove-cmux status` to list the ids that exist. |
| 8 | `E_GROVE_FAILED` | Follow `grove_error.remedy` when present; otherwise run the command in `args` directly. On `new`, check that `args` carries each grove flag with its value. |
| 10 | `E_LEDGER` | Never delete the ledger to clear this. It is the only record of ownership. |
| 11 | `E_AMBIGUOUS_TARGET` | Pass `--window <id>` from the evidence. |
| 12 | `E_PRECONDITION` | For a missing Grove root: look in `<workspace>/archives/<grove>` before concluding it is gone. |
| 13 | `E_PROJECTION_CONFLICT` | Run against `found_window` from the evidence. If the recorded window no longer exists (no `found_window`), run `grove-cmux close <root>`, then `open --window <id>`. `--relocate` only on purpose. |

`references/refusals.md` has all thirteen with observed messages and recoveries.

## Rules

- Preview `close` and every `sync --allow-destructive` run with `--dry-run`.
- Name the window explicitly for projection mutations; never pass `--window` to `close`.
- Use `close --forget` before archive or delete, and preserve plain Grove safety refusals.
- Retain the ledger after any close failure; deleting it is not recovery.
- Members before the anchor, always.
- Use `run` for a task, `open --agent` never for a task.
- Report ids and exit codes when something fails; do not retry a refusal unchanged.

## Close requests

`close` is shipped. Use it rather than reconstructing teardown with raw cmux calls. If an older installed build lacks the command, follow the ledger-driven fallback in `references/teardown.md` and say that upgrading restores the supported one-command flow. A request to describe close does not authorize executing it against the user's projection.

## References

- `references/lifecycle.md` — every command, flag, classification and the `--json` shape.
- `references/teardown.md` — the measured behaviour behind the sequence, and orphan recovery.
- `references/refusals.md` — the thirteen error classes and their recoveries.
