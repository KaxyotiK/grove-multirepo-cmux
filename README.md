# grove-cmux

Project a Grove and its Trees into cmux's native workspace groups: one group per Grove, an anchor workspace at the Grove root, one member workspace per Tree.

Grove is the source of truth. This wrapper does no git work of its own, never spawns a terminal, and never needs caller context — it speaks cmux's control socket as a plain external process.

```
grove-cmux open   [<grove-root>] [--window <id|focused>] [--agent <name>] [--relocate]
grove-cmux sync   [<grove-root>] [--allow-destructive] [--dry-run] [...]
grove-cmux status [<grove-root>] [--all] [--json]
grove-cmux close  [<grove-root>] [--dry-run] [--forget] [--keep-anchor]
grove-cmux new    <name> [grove options...]
grove-cmux run    [<grove-root>] --tree <tree> [--agent <name>] [-- <agent args>...]
```

`open` and `sync` are the same reconcile pass; the only difference is whether it may close anything. Additive is the default, mirroring `grove tree remove --allow-destructive`.

`run` hands one task to one agent in one Tree, and works on a Grove that is already open. `open --agent` cannot: it launches through `workspace.create`, which fires only when the workspace is created, so it starts an agent once per Tree and never again.

```
grove-cmux run feat-checkout --tree api --agent claude -- "port the retry logic to v2"
```

Everything after `--` reaches the agent verbatim, so a multi-word prompt stays one argument.

`close` tears down exactly the workspaces named by the projection ledger. It discovers each workspace's actual window, closes Trees before the anchor, and verifies absence before clearing ownership. It therefore takes no `--window`. The default retains a cleared ledger so a later `open` creates a new projection; `--forget` removes `.grove-cmux` after verified success. `--keep-anchor` retains the anchor, ungroups the owned group when safe, and releases ownership of the anchor; when it plans that ungroup, it refuses before any mutation unless cmux's method list names `workspace.group.ungroup`. Foreign workspaces and foreign groups are preserved. Read or verification failures, including a ledgered workspace or the owned group still live afterwards, retain the ledger for retry.

```bash
grove-cmux close feat-checkout --dry-run
grove-cmux close feat-checkout
```

See the [teardown guide](skills/grove-cmux/references/teardown.md) before combining close with `grove archive` or `grove delete`.

## Requirements

| | |
|---|---|
| Node | >= 24 |
| [cmux](https://manaflow-ai-cmux.mintlify.app) | build 102 or newer, running, with its control socket reachable |
| [Grove](https://github.com/KaxyotiK/grove-multirepo) | only for `new` and `run`: `npm install -g grove-multirepo`, which provides the `grove` command |

`open`, `sync` and `status` do not need the `grove` binary. They read the Tree layout off disk (`<grove-root>/trees/<grove>@<repo>`), so any directory in that shape projects, however it was made. `new` wraps `grove --json new` and refuses with `E_GROVE_FAILED` (exit 8) when grove is not on PATH.

`run` launches `grove agent run` inside a cmux terminal, whose PATH is a login shell's, not this process's. So it refuses only when `GROVE_BIN` names an absolute path that does not exist — a string that cannot resolve differently there. A bare `grove` missing from this process's PATH is not treated as evidence about the terminal's.

## Install

```bash
npm install -g grove-multirepo-cmux   # installs the grove-cmux command and ships the grove-cmux skill
```

From a local checkout:

```bash
npm install
npm run build
npm link                       # puts grove-cmux on PATH
grove-cmux --version
```


## Local cmux setup

For local automation from Herdr, an external terminal, or another agent, select **cmux Settings → Automation → Socket Control Mode → Automation mode**. This allows processes running as your macOS user to control cmux without a socket password.

- **cmux processes only** fits workflows where every caller starts inside cmux.
- **Password mode** is optional. If chosen, configure its password in cmux Settings; external callers can use the saved password or `CMUX_SOCKET_PASSWORD`.
- **Full open access** permits other local users too and is unnecessary for this workflow.

Before `grove-cmux new`, check access from the same environment that will run the agent:

```bash
cmux list-windows --id-format uuids
```

Require a successful window listing, then use the intended window UUID explicitly. Repeat the check after changing socket settings or restarting cmux. Installing the CLI or skill does not configure socket access. See [cmux's socket settings documentation](https://manaflow-ai-cmux.mintlify.app/configuration/settings).

If Grove creation already succeeded but projection failed, fix access and run `grove-cmux open <existing-grove-root> --window <window-UUID>`; do not repeat `new`. The Tart harness uses Password mode to test authentication; that is a test setup choice, not a requirement for local use.

## Project skill installation

The operational skill lives in `skills/grove-cmux/`. Install it only in projects that use Grove's cmux projection. From the target project, pin it to the release that matches the installed CLI:

```bash
cd /path/to/target-project
# Initialize once; choose only the agents this project uses.
skillshare init --project --targets claude,codex,pi
v="v$(grove-cmux --version)"
skillshare install github.com/KaxyotiK/grove-multirepo-cmux/skills/grove-cmux --branch "$v" --kind skill --project --dry-run
skillshare install github.com/KaxyotiK/grove-multirepo-cmux/skills/grove-cmux --branch "$v" --kind skill --project
skillshare sync --project --dry-run
skillshare sync --project
skillshare status --project
skillshare diff --project
```

For an existing `.skillshare/config.yaml`, keep that configuration and skip initialization. Skillshare stores the copy in the project's `.skillshare/skills/grove-cmux` (gitignored) and creates project links in `.claude/skills`, `.agents/skills` (Codex), and `.pi/skills` for the selected targets. `.skillshare/config.yaml` records the GitHub source and tag, so anyone with the project can reproduce the install with `skillshare install --project`. After upgrading the CLI, reinstall with the new tag. No global skill installation is needed.

Offline, the npm package carries the same skill: `skillshare install "$(npm root -g)/grove-multirepo-cmux/skills/grove-cmux" --kind skill --project`. That records a path on your machine in `config.yaml`, so others cannot reinstall from it.

The CLI is a separate prerequisite: the skill does not install `grove-cmux`, Grove, or cmux. Verify `grove-cmux --version` and `grove-cmux --help` in the agent's environment. The npm package includes the skill files but does not install them into any project; run the skillshare steps above.

## Ownership

The wrapper owns a ledger at `<grove root>/.grove-cmux/projection.json` mapping each Tree to a cmux workspace UUID. That is the sole answer to "did we create this". cmux is what the ledger is checked against, never what identity is read from.

Nothing is adopted by its path, at any depth, and that holds for a group as well as for a workspace. Being in the right place is never evidence of being ours: a workspace someone else opened at a Tree is reported `foreign` and left alone, and a group that merely holds our workspaces is not ours either — we reclaim them into one of our own.

The ledger is written after every single workspace creation, so a crash leaves it describing exactly what exists and a rerun completes the remainder.

## Branding

A Grove's group carries the Grove icon and colour in its header, and each Tree workspace carries one keyed status pill in the sidebar. Both come from what cmux already renders; nothing is written to cmux's config. Branding is best-effort — a cmux that cannot do it still projects, and says so in a warning. `GROVE_CMUX_BRAND=off` turns it off; `GROVE_CMUX_BRAND_ICON` and `GROVE_CMUX_BRAND_COLOR` change it.

## Tests

```
npm run verify                              # typecheck, build, offline cases, acceptance record
GROVE_CMUX_LIVE_VM=auto GROVE_CMUX_GROVE_TARBALL=<grove-multirepo.tgz> npm run test:live   # 32 cases against a real cmux in a Tart guest
```

The offline suite needs nothing but Node: it builds its Grove fixtures with plain `git init` and talks to a fake cmux, so no cmux, Grove or VM is involved.

Every test names the acceptance criterion it proves; the criteria are in [`test/ACCEPTANCE.md`](test/ACCEPTANCE.md), and `npm run verify:acceptance` fails if one has no test.

`test:live` clones the frozen guest, boots it, arms the socket, deploys the build, runs, and deletes the clone. Without `GROVE_CMUX_LIVE_VM` it skips and says why.

It expects a Tart VM named `gcx-base` holding macOS and cmux. Each run installs Grove into the guest from the local `grove-multirepo` tarball `GROVE_CMUX_GROVE_TARBALL` names (make one with `npm pack` in a grove-multirepo checkout) and builds its fixture with it. That image is built locally, not distributed — [`scripts/tart/README.md`](scripts/tart/README.md) describes how, and the scripts beside it do it. Without it the live suite skips; the offline suite is unaffected.

## License

MIT — see [LICENSE](LICENSE).
