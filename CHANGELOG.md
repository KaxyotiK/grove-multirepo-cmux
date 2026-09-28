# Changelog

grove-multirepo-cmux follows Semantic Versioning. The npm package is `grove-multirepo-cmux`; the command it installs is `grove-cmux`.

## 0.1.0 - 2026-09-28

Initial release.

- `open` and `sync` project a Grove into cmux: one workspace group per Grove, an anchor workspace at the Grove root, and one member workspace per Tree. `sync --allow-destructive` also closes workspaces for Trees that no longer exist.
- `status` reports a projection's workspaces and whether each is present, with `--json` for scripts.
- `close` tears down exactly the workspaces the projection ledger names, verifies they are gone, and preserves foreign workspaces and groups. `--keep-anchor` and `--forget` control what remains.
- `new` creates a Grove with `grove new` and opens it; `run` hands one task to one agent in one Tree.
- Grove groups and Tree workspaces carry Grove branding: a group icon and colour, and a status pill on each Tree.
- The `grove-cmux` agent skill in `skills/grove-cmux/` teaches Claude Code, Codex and Pi agents to use the command. It ships in the npm package and installs into a project with skillshare.
