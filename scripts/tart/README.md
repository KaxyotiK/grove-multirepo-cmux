# Building the acceptance guest

The repo masters the guest. `gcx-base` is a cache of what these scripts produce, not a source of truth, and anything that exists only inside it is a defect. This document is the process, and [Guest findings](#guest-findings) records why each step is there.

Verified end to end on 2026-09-23: a fresh clone of `gcx-base` boots, arms its cmux socket, takes the built wrapper, seeds its own fixture, runs all 32 live cases green, and deletes itself.

Rebuilt on 2026-09-28 from `provision-guest.sh` with no grove in the image: a fresh clone installed grove-multirepo 0.1.1 from a local tarball, seeded with it, and ran all 32 live cases green. The rebuilt image has no Claude Code sign-in, so the authenticated-Claude case reports SKIPPED until one is added; see [Optional: agents and real GitHub remotes](#optional-agents-and-real-github-remotes).

## Local use versus the test guest

The guest deliberately uses Password mode to exercise authentication. For local same-user agents outside cmux, use Automation mode and the [local setup check](../../README.md#local-cmux-setup). The historical password re-arming workaround below applies to this guest setup; it is not a requirement to use grove-cmux locally.

## Requirements

**Host**

| | |
| --- | --- |
| Tart | 2.32.1 |
| macOS | 26.5.2 |
| Node | 24+ on the host to build; the guest runs its own |
| `TART_HOME` | Tart's default, `~/.tart`, on the internal disk |
| Disk | ~28GB for the OCI base, ~23GB for `gcx-base` plus one clone |
| `herdr` | on the host's PATH; `provision-guest.sh` copies that binary into the guest |

Keep Tart's home on a fast internal volume, never removable or external storage: see [Guest findings](#guest-findings). Keep base images and their disposable clones in the same Tart home so APFS cloning remains available.

**Guest, as produced by `provision-guest.sh`**

| Tool | Version observed |
| --- | --- |
| macOS | 26.6.2 |
| cmux | `0.64.22 (102) [ddd4a01bc]` |
| herdr | 0.9.1 |
| gh | 2.98.0 |
| node / npm | v24.20.0 / 11.19.0 |
| Claude Code | 2.1.284 |
| Codex | 0.158.0 |

Node 24 in the guest is the point: it is the version `engines` declares, so the live suite runs the wrapper on its target runtime rather than on the host's Node 26.

The image carries no grove. Every live run installs it fresh; see [Grove in the guest](#grove-in-the-guest).

## Build the base

```bash
tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest
tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest gcx-base
tart set gcx-base --cpu 6 --memory 16384 --disk-size 90 --display 1920x1200
tart run gcx-base &         # first boot, with the UI window
scripts/provision-guest.sh gcx-base
tart stop gcx-base
```

The Cirrus Labs base already carries Homebrew, Xcode CLT, git, Node 24, Python, the Tart guest agent, and auto-login as `admin`.

`provision-guest.sh` adds passwordless sudo, the host's SSH key, cmux from the cask, `gh`, herdr, Claude Code, Codex, dark mode, and `start-cmux.sh`. It installs no grove and builds no fixture: each live run does both, so the base it hands back is one the live suite can use immediately.

Nothing above is interactive. The guest is usable for acceptance at this point.

## Optional: agents and real GitHub remotes

Neither is needed by `test:live`. Add them only if you want them baked into the image.

**Claude Code and Codex** each need one interactive sign-in, from a browser on the host:

- Claude Code takes the `code=true` flow, which redirects to `platform.claude.com` and shows a code to paste back. Nothing has to reach the guest's network. Read the URL out of the terminal, open it locally, and type the code back with `herdr agent prompt`.
- Codex only offers a localhost callback. Either forward the port with `ssh -N -L 127.0.0.1:1455:127.0.0.1:1455 <guest>`, or use `codex login --device-auth`, which needs no tunnel and is the better thing to bake in.

**GitHub** exercises Grove against real remotes, which a local `file://` remote never does — clone, fetch, and credential paths. `gh auth login` in the guest, then create seed repos under a throwaway account.

> `gh` stores its token in plain text at `~/.config/gh/hosts.yml`, so **signing in makes the base a credential-bearing artifact**: every clone carries a live token. That is why the account is throwaway, with no access to anything that matters. The acceptance fixture is offline precisely so this is a choice rather than a requirement.

Freeze afterwards so every future clone starts ready:

```bash
tart stop gcx-base
tart clone gcx-base gcx-base-authed # or re-freeze in place
```

## The fixture

`scripts/seed-fixture.sh` runs in the guest, is offline, and is idempotent. The harness pipes it in from the checkout after installing Grove, and removes `~/work` and `~/fixture-remotes` first, so every run's fixture is written by the grove that run installed and never by an earlier one. It builds:

```
~/fixture-remotes/<repo>.git            one bare repo per fixture repo, one commit each
~/work                                  the Grove workspace
~/work/groves/feat-checkout             the Grove the live cases target
~/work/groves/feat-checkout/trees/      feat-checkout@{checkout-api,storefront-web,design-system}
```

`grove repo add` takes anything `git clone` accepts, so local bare repositories are enough. Each Tree is a real git worktree, which matters because the wrapper resolves directories with `git rev-parse --show-toplevel` and a faked fixture would prove nothing about that.

It prints one `tree <name> -> <worktree>` line per Tree and ends with `SEED_OK`. The harness parses those lines and fails if any Tree does not resolve to its own worktree, so a half-built fixture is a failure rather than a mysterious later one.

Override the shape if a case needs a different one:

```bash
seed-fixture.sh other-grove repo-a repo-b
```

## Running the live suite

```bash
export GROVE_CMUX_GROVE_TARBALL=/path/to/grove-multirepo-<version>.tgz   # see Grove in the guest
GROVE_CMUX_LIVE_VM=auto npm run test:live
GROVE_CMUX_LIVE_VM=gcx-run npm run test:live
npm run test:live                             # skips, and says why
```

`auto` is the one to prefer. It clones `gcx-base` to `gcx-live-<pid>`, and deletes it afterwards whether the run passed or failed. A wrecked guest costs one clone, so a run never repairs one.

The 32 cases take about nine minutes of guest time (measured 2026-09-23), much of it in the restart case, which waits for cmux's session autosave before killing the app.

## Grove in the guest

The image carries no grove. Every run, `auto` or a named guest, installs Grove from a local tarball before it seeds, and never from the npm registry. Make the tarball in a grove-multirepo checkout and pass its path:

```bash
cd /path/to/grove-multirepo && npm pack          # writes grove-multirepo-<version>.tgz
GROVE_CMUX_LIVE_VM=auto GROVE_CMUX_GROVE_TARBALL=/path/to/grove-multirepo-<version>.tgz npm run test:live
```

The harness refuses before cloning a guest when `GROVE_CMUX_GROVE_TARBALL` is unset or does not name a readable `grove-multirepo` tarball. Otherwise it copies the tarball in, installs it with `npm install -g` through `install-grove.sh`, and prints the tarball's version, sha256 and the installed bin. The run fails before any case unless `npm ls -g` shows `grove-multirepo` at the tarball's version, `command -v grove` resolves to that package's own bin both in the harness's shell and in a login shell (the PATH `grove agent run` gets in a cmux terminal), and `grove --version` agrees.

## Per-run mechanics, if you drive it by hand

```bash
tart clone gcx-base gcx-run
tart run gcx-run &
tart exec gcx-run /bin/sh -lc '~/.local/bin/start-cmux.sh'
base64 < /path/to/grove-multirepo-<version>.tgz | tart exec -i gcx-run /bin/bash -c 'base64 -d > /tmp/grove-multirepo.tgz'
tart exec -i gcx-run /usr/bin/env GROVE_TARBALL=/tmp/grove-multirepo.tgz /bin/bash -s < scripts/tart/install-grove.sh
tart exec -i gcx-run /bin/bash -s < scripts/tart/seed-fixture.sh
# … drive cmux over `tart exec` …
tart stop gcx-run
tart delete gcx-run
```

- **Prefer `tart exec` over SSH**, including for scripts. `tart exec -i <vm> /bin/bash -s < script.sh` pipes a whole script in, so there is no key to install, no IP to look up, and no SSH config to go stale. Set up SSH only when you need `scp`.
- **`tart ip` caches** and returns stale answers right after a boot. Poll `tart exec <vm> /bin/sh -lc 'echo READY'` instead.
- **The guest agent's control socket drops under load.** Every call retries; see `exec-guest.sh` and `guestExec` in `test/helpers/guest.mjs`.
- **A guest command exiting nonzero is data, not a harness failure.** Half the acceptance cases are about refusals, so the harness captures output either way rather than throwing.
- **`start-cmux.sh` must run after every cmux start.** cmux rewrites `~/.config/cmux/cmux.json` and strips `socketPassword` out of it, so external control does not survive a restart.
- **`tart suspend` does not round-trip.** Clone and cold boot.

## What lives where

```
gcx-base          frozen; never run it directly, clone it
gcx-live-<pid>    created and deleted by `test:live` in auto mode
gcx-run           an optional long-lived working clone for interactive poking
```

All of them live under `$TART_HOME/vms`, which is `~/.tart/vms` by default. `du` overcounts badly because clones share blocks; the base plus one clone is roughly 23Gi.

## Scripts

| Script | Side | Purpose |
| --- | --- | --- |
| `provision-guest.sh` | host | a cloned OCI base becomes a provisioned guest, with no grove and no fixture |
| `install-grove.sh` | guest | install `grove-multirepo` from the tarball at `GROVE_TARBALL` and report what resolves; the live harness copies the tarball in and pipes it on every run |
| `seed-fixture.sh` | guest | build the Grove fixture, offline and idempotent; the live harness pipes it in on every run |
| `start-cmux.sh` | guest | launch cmux into the GUI session and arm the socket; prints `PONG`. The live harness pipes it in from this checkout on every boot |
| `exec-guest.sh` | host | `tart exec` with retry, for driving a guest by hand |

## Guest findings

- **cmux must be launched into the GUI session.** `open -a cmux` from a non-GUI session fails with LaunchServices `-10673` and leaves a hung process that never creates its socket. Launching via `sudo launchctl asuser <uid> …/Contents/MacOS/cmux` works and the app renders normally, so Virtualization.framework's paravirtualized GPU is sufficient for a Ghostty-based AppKit app.
- **external socket control needs arming, and re-arming.** cmux refuses external callers with `only processes started inside cmux can connect` until `automation.socketControlMode` is `password` with a `socketPassword` in `~/.config/cmux/cmux.json`. cmux rewrites that file and strips the password out, so the value does not survive a cmux restart. `start-cmux.sh` writes it and calls `reload-config` on every boot, which is why it is idempotent by design.
- **the caller hop is genuine, not simulated.** A terminal created with `cmux workspace create --command …` runs argv as a real child of a cmux terminal. `identify` from inside it returns a `caller` whose `window_id` is the test window and whose `workspace_id` differs from the focused workspace, which also proves `--focus false` held.
- **restart preserves UUIDs but not ordering, and not the window id.** Workspace UUIDs, group ids and names, and member counts all come back unchanged, so the wrapper must re-resolve by UUID and never trust a `window:1` style ref. **Corrected since:** the window itself comes back with a *different* id, it is not the first window `list-windows` reports, and `workspace.list` against a window that has not restored yet answers `unavailable: TabManager not available`. Guessing a window after a restart therefore produces a projection conflict, correctly; resolving it from the ledger is what makes the restart acceptance pass.
- **`tart suspend` does not round-trip.** Suspend writes a 4.8GB `state.vzvmsave` in about 20s, but the restore fails with `VZErrorDomain Code=12 "invalid argument"` and leaves the VM stuck in `suspended`. Use clone plus cold boot instead: `tart clone` takes 0.13s through APFS copy-on-write, and a clone reaches SSH-ready in 22s.
- **keep `TART_HOME` on the internal disk.** Measured on the development host, an SD card wrote at 86 MB/s against 1.87 GB/s internally, a 22x gap, and clones across volumes lose APFS block sharing. Leave `TART_HOME` at Tart's default, `~/.tart`, or point it at another fast internal volume; never at removable or external storage.
- **dark mode needs a reboot.** Setting appearance over SSH updates the preference and System Events reports dark immediately, but the window server keeps painting light until the guest restarts. Treat it as provisioning, not a live toggle.
- **`screencapture` over SSH works, with a nag.** It returns a correct full-screen PNG, but macOS raises a TCC dialog asking to let `com.apple.sshd-session` bypass the private window picker. Suppressing it permanently means disabling SIP in the guest, which is the same detour as pre-granting computer-use permissions.

## cmux behaviours that are easy to get wrong

Each of these was assumed, then disproved against the live build.

| Assumed | What is true |
| --- | --- |
| `workspace.create {window_id, name, cwd}` | It takes **`title`** and **`working_directory`**. The CLI spellings are silently accepted and ignored, producing an untitled workspace in the wrong directory while reporting success. |
| `cmux version` yields the version as its first token | It prints `cmux 0.64.22 (102) [ddd4a01bc]`. Reading token one gives `"cmux"` and leaves build and hash null, which silently disables any minimum-build check. |
| `workspace.group.create` returns a flat payload | It nests the group under a `group` key. |
| a group's `member_workspace_ids` are its Trees | cmux counts the anchor as a member of its own group, so N Trees give N+1 members. |
| restart preserves UUIDs but not ordering | True but incomplete. The restored window has a **different id**, is **not** the first window `list-windows` reports, and `workspace.list` on a window that has not restored yet answers `unavailable: TabManager not available`. A run that guesses a window after a restart gets `E_PROJECTION_CONFLICT`, correctly; resolving from the ledger is what makes the case pass. |
| `initial_command` runs whatever string you give it | cmux resolves its **first whitespace-delimited token** as an executable, and when that fails the whole command silently does not run — no error, no output, a surface that looks like a successful launch. `export FOO=1; …`, `{ … }` and `true; …` all vanish; `node …` and `grove …` do not. Environment belongs in `startup_environment`. |
| `window_id` narrows a call that also names a workspace | `window_id` outranks `workspace_id` in cmux's selector precedence, so naming a window the workspace does not live in resolves to no target and answers `Workspace not found`. Pass one or the other. |
| the base image is the acceptance environment | It was not. `gcx-base` carried the tools and **no test data and no GitHub login**; every live case ran against a hand-built clone. `seed-fixture.sh` and the harness's `seed()` exist because of that, and the `auto` path is now proven from a clean base. |

Behaviours probed rather than assumed, all against the live build:

- Adopting a workspace into a group **moves** it; the old group loses a member.
- Closing a group's last non-anchor member leaves the group alive with its anchor.
- Old claim: closing the anchor destroys the group outright. Measured cmux instead promotes a member; the group lifecycle is 3 → 2 → 1 → 0 and the group disappears only at zero. The wrapper's `apply()` path still never closes the anchor because, after all Trees close, that guard leaves the anchor as the final workspace and keeps the group alive; `close` closes it last on purpose.
- `workspace.group.add` on an existing member is a no-op, not an error.
- `window.create` and `window.close` exist over RPC, which is how the live suite builds the two-window states that D1 and D2 need.
