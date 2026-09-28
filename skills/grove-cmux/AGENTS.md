# grove-cmux (Codex agent instructions)

When asked to project a Grove into cmux, work inside a projection, hand a task to an agent in a Tree, or close a projection, read the `grove-cmux` skill first.

## Role

Drive `grove-cmux` from its ledger. A matching path, title, or group membership does not establish ownership.

## Checklist

1. Use `grove-cmux status <root> --window <id>` before projection work and read the classifications.
2. Name the window explicitly for projection mutations. `close` is the exception: it refuses `--window` and finds each ledgered workspace in its actual window.
3. Use `--dry-run` before `sync --allow-destructive` and before a live `close`.
4. Close a projection with `grove-cmux close <root>`. It closes ledgered Tree workspaces before the anchor, verifies absence across all windows, and retains a cleared ownership ledger by default. Use `--forget` only when the `.grove-cmux` directory should be removed after verified success.
5. `close --keep-anchor` closes the Trees and safely ungroups the owned group while retaining the anchor. It releases ownership of that anchor; a later `open` creates a new projection beside it.
6. For archive, run `grove-cmux close <root> --forget` before `grove archive`. For permanent deletion, close with `--forget`, then run plain `grove delete`. If already archived, close the archive path, restore without opening, then use plain delete. Preserve every Grove refusal.
7. If a close read or verification fails, retain the ledger and retry after resolving the window or socket problem. A surviving foreign workspace and group are reported and left alone.
8. On `grove-cmux new`, everything after the Grove name except grove-cmux's own flags goes to `grove new` in order, so `--repo api` and `--repo=api` both work.

## Refuse

- `grove delete <grove> --allow-destructive` while the projection is live.
- `--relocate` as a retry for a projection conflict.
- `close --window ...`; close derives actual windows from complete cmux reads.
- Adopting a `foreign` workspace, by flag or by writing a ledger.
- Deleting the ledger to clear an error.

## Output

Report the commands run, affected ids, warnings, and refusals with their exit codes. Use raw cmux RPC teardown only as the documented fallback for an older `grove-cmux` build without `close`.
