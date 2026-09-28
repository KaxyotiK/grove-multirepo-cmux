# Close a projection

`grove-cmux close` is the supported ledger-driven teardown. It was verified against cmux `0.64.22 (102) [ddd4a01bc]` in a disposable Tart guest on 2026-09-15.

## Preview, then close

```bash
grove-cmux close <grove-root> --dry-run
grove-cmux close <grove-root>
```

Do not pass `--window`: close enumerates every cmux window, locates each ledgered workspace by UUID, and uses that workspace's actual window. It reads all required `workspace.list` and `workspace.group.list` results before the first mutation. An unreadable window refuses with `E_CMUX_TARGET`, names the window, and leaves the ledger byte-for-byte unchanged.

The default plan closes every live workspace under `trees`, then the ledger's anchor. Missing ledgered ids need no mutation. It does not ungroup first. cmux promotes another member when an anchor closes, and removes the group only when its last workspace closes; the measured lifecycle is 3 → 2 → 1 → 0.

After close, a second complete read verifies that every ledgered workspace id is absent, including one the first read could not see, and that the owned group is gone unless a foreign workspace holds it. A failed close or failed verification retains the uncleared ledger, even with `--forget`; resolve the reported problem and rerun `close`. If the owned group persists with no foreign member, rerun `close`; should it survive repeated runs, dissolve it with `cmux rpc workspace.group.ungroup '{"window_id":"<evidence.window_id>","group_id":"<evidence.group_id>"}'`, the same call `close --keep-anchor` makes, and rerun. If that call refuses, stop and report both ids rather than deleting the ledger. Do not treat group disappearance or `Workspace not found` as independent proof of workspace absence.

On verified success the default keeps the ledger but clears ownership: `trees` is `{}` and `group_id`, `anchor_workspace_id`, and `window_id` are null. Provenance stays in the ledger. A later `grove-cmux open <root> --window <id>` creates a new projection with new ids.

## Remove the ledger after verified success

```bash
grove-cmux close <grove-root> --dry-run --forget
grove-cmux close <grove-root> --forget
```

`--forget` removes `<grove-root>/.grove-cmux` only after all planned mutations and verification succeed. It is appropriate before archiving or permanently deleting the Grove. It is unnecessary for cmux-only cleanup.

## Keep the anchor workspace

```bash
grove-cmux close <grove-root> --dry-run --keep-anchor
grove-cmux close <grove-root> --keep-anchor
```

This closes ledgered Tree workspaces, then ungroups the owned group when doing so is safe. The anchor survives as a plain workspace. If the owned group is already gone, ungroup is a successful no-op. If the group contains a foreign workspace, or the retained anchor belongs to another group, close leaves that group intact and warns with the relevant ids. When an ungroup is planned, close first requires `cmux capabilities` to list `workspace.group.ungroup`; if the list is unavailable or omits it, close refuses `E_CMUX_INCOMPATIBLE` before closing anything. Use the default close on such a build.

Successful `--keep-anchor` still clears or forgets the projection ledger. Ownership of the retained anchor is released. A later `open` does not adopt it; it creates a new anchor and group beside it because path is never a capability.

## Foreign workspaces

Close acts only on ids the ledger records. A foreign member of the owned group stays open, and the group may survive holding it. The report names why the group outlived the close. Never close the foreign member merely to make the group disappear, and never hand-edit a ledger to claim it.

## Archive or delete

For an active Grove, close the projection before Grove moves or removes its ledger:

```bash
grove-cmux close <grove-root> --dry-run --forget
grove-cmux close <grove-root> --forget
grove archive <grove>
```

For permanent deletion, replace the final command with plain `grove delete <grove>`. Preserve its safety checks and report any refusal; do not add `--allow-destructive-all`.

If the Grove is already archived, target `<workspace>/archives/<grove>`. Close there with `--forget`; for permanent deletion, then run plain `grove delete <grove>`, which accepts archived Groves. A missing active root can include an `archived_at` path and remedy when a readable, matching archive ledger proves where it moved.

`grove delete --allow-destructive-all` on a live projection destroys the only ownership record while leaving cmux objects alive. Recreating the Grove cannot recover that capability: matching paths remain foreign.

Close is not a lock against concurrent `open`, relocation, or manual workspace movement. Do not run projection teardown concurrently with those operations.

## Older-build fallback

Use this only when `grove-cmux --help` confirms the installed build has no `close` command. Read and preserve `window_id`, `group_id`, `anchor_workspace_id`, and every id under `trees` from `<grove-root>/.grove-cmux/projection.json`. Then enumerate all windows and map every saved id to its actual window:

```bash
cmux list-windows --id-format uuids
cmux --json rpc workspace.list '{"window_id":"<each window UUID>"}'
cmux --json rpc workspace.group.list '{"window_id":"<each window UUID>"}'
```

Close only saved Tree ids, then the saved anchor, each in its actual window:

```bash
cmux rpc workspace.close '{"workspace_id":"<saved Tree UUID>","window_id":"<actual window UUID>"}'
cmux rpc workspace.close '{"workspace_id":"<saved anchor UUID>","window_id":"<actual window UUID>"}'
```

Repeat the full enumeration and require every saved id absent. If any window is unreadable, an id remains, or the window set changes during verification, retain the ledger and retry the reads. Only after verified absence may an old-build permanent cleanup remove `.grove-cmux` and invoke plain `grove delete`.

There is no supported way to adopt orphans whose ledger was destroyed. Confirm their identities with the user before handling them directly in cmux; position alone cannot establish ownership.
