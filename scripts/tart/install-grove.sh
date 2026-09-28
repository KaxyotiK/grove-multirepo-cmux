#!/bin/bash
# Guest-side. Install Grove from a grove-multirepo tarball already copied into the guest.
#
# The image carries no grove, so every live run installs the one it names. The harness copies
# the host tarball GROVE_CMUX_GROVE_TARBALL names to GROVE_TARBALL and pipes this in before
# seeding. By hand:
#
#   tart exec -i <vm> /usr/bin/env GROVE_TARBALL=/tmp/grove-multirepo.tgz /bin/bash -s < scripts/tart/install-grove.sh
#
# The last line is `GROVE_INSTALL <json>`, which the harness checks; this script does not judge it.
set -euo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin"
: "${GROVE_TARBALL:?GROVE_TARBALL must name a grove-multirepo tarball in the guest}"

npm install -g "$GROVE_TARBALL" >/dev/null
hash -r

node -e '
  const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; } };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const root = run("npm", ["root", "-g"]);
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "grove-multirepo", "package.json"), "utf8")); } catch {}
  let npmLs = null;
  try { npmLs = JSON.parse(run("npm", ["ls", "-g", "grove-multirepo", "--json", "--depth=0"]) ?? "null"); } catch {}
  const bin = pkg && pkg.bin && (typeof pkg.bin === "string" ? pkg.bin : pkg.bin.grove);
  const onPath = run("/bin/bash", ["-c", "command -v grove"]);
  const onLogin = run("/bin/zsh", ["-lc", "command -v grove"]);
  console.log("GROVE_INSTALL " + JSON.stringify({
    npm_ls_version: npmLs?.dependencies?.["grove-multirepo"]?.version ?? null,
    package_bin: bin ? real(path.join(root, "grove-multirepo", bin)) : null,
    command_v: onPath ? real(onPath) : null,
    login_command_v: onLogin ? real(onLogin) : null,
    grove_version: run("grove", ["--version"]),
  }));
'
