/**
 * The live guest lifecycle.
 *
 * This is what makes the live cases re-runnable rather than something a person drives by
 * hand. The suite owns the whole lifecycle: clone the frozen base, boot it, arm the cmux
 * socket, deploy the built wrapper, run the cases, delete the clone.
 *
 * A wrecked guest costs one clone, so a run never repairs one — it reclones. APFS
 * copy-on-write makes that cheap.
 *
 * GROVE_CMUX_LIVE_VM controls it:
 *   unset          the live suite skips and says so
 *   auto           clone gcx-base to a private name, and delete it afterwards
 *   <name>         use a guest that is already running, and leave it alone afterwards
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SEED_SCRIPT = join(REPO, 'scripts', 'tart', 'seed-fixture.sh');
const START_CMUX_SCRIPT = join(REPO, 'scripts', 'tart', 'start-cmux.sh');
const INSTALL_GROVE_SCRIPT = join(REPO, 'scripts', 'tart', 'install-grove.sh');
const GROVE_PACKAGE = 'grove-multirepo';

/**
 * The Grove a live run installs: the grove-multirepo tarball GROVE_CMUX_GROVE_TARBALL names on
 * the host. There is no registry fallback, so a run tests exactly the build it was handed. A
 * missing or foreign tarball is refused here, before a guest is cloned.
 */
export function groveRequest(env = process.env) {
  const path = env.GROVE_CMUX_GROVE_TARBALL;
  if (!path) {
    throw new Error(
      'GROVE_CMUX_GROVE_TARBALL is not set, so there is no Grove to install in the guest. ' +
        'Make one with `npm pack` in a grove-multirepo checkout and set ' +
        'GROVE_CMUX_GROVE_TARBALL to the grove-multirepo-<version>.tgz it writes.',
    );
  }
  let bytes;
  let pkg;
  try {
    bytes = readFileSync(path);
    pkg = JSON.parse(
      execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }),
    );
  } catch (e) {
    throw new Error(`GROVE_CMUX_GROVE_TARBALL is not a readable npm tarball: ${path}: ${e.message}`);
  }
  if (pkg.name !== GROVE_PACKAGE) {
    throw new Error(
      `GROVE_CMUX_GROVE_TARBALL holds ${pkg.name}@${pkg.version}, not ${GROVE_PACKAGE}: ${path}`,
    );
  }
  return {
    path,
    version: pkg.version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Judge install-grove.sh's report against the tarball. The run fails unless npm lists
 * grove-multirepo at the tarball's version, `command -v grove` (here and in a login shell)
 * resolves to that package's own bin, and `grove --version` agrees.
 */
export function checkGroveInstall(request, out) {
  const m = /^GROVE_INSTALL (\{.*\})\s*$/m.exec(out);
  if (!m) throw new Error(`installing grove failed; guest said: ${out}`);
  const r = JSON.parse(m[1]);
  const wanted = request.version;
  const problems = [];
  if (r.npm_ls_version !== wanted) {
    problems.push(`npm ls -g shows ${GROVE_PACKAGE}@${r.npm_ls_version ?? 'nothing'}, not ${wanted}`);
  }
  if (!r.package_bin) problems.push(`${GROVE_PACKAGE} has no grove bin`);
  for (const [label, got] of [['command -v grove', r.command_v], ["a login shell's command -v grove", r.login_command_v]]) {
    if (got !== r.package_bin) {
      problems.push(`${label} resolves to ${got ?? 'nothing'}, not ${r.package_bin}`);
    }
  }
  if (r.grove_version !== wanted) {
    problems.push(`grove --version prints ${r.grove_version ?? 'nothing'}, not ${wanted}`);
  }
  if (problems.length > 0) {
    throw new Error(`the guest's grove is not the tarball's: ${problems.join('; ')}\n${out}`);
  }
  return { ...r, version: wanted };
}

/**
 * Launch cmux and arm its socket, from this repo's start-cmux.sh rather than a copy baked into the
 * image, so the guest always runs the script this checkout carries. Idempotent; prints PONG.
 */
export function startCmux(vm) {
  const script = readFileSync(START_CMUX_SCRIPT, 'utf8');
  return guestExec(vm, `export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"\n${script}`);
}
const TART = process.env.TART_BIN ?? '/opt/homebrew/bin/tart';
const BASE_VM = process.env.GROVE_CMUX_LIVE_BASE ?? 'gcx-base';
const GUEST_PREFIX = '/Users/admin/grove-cmux';

export function liveVmSetting() {
  const v = process.env.GROVE_CMUX_LIVE_VM;
  return v && v.length > 0 ? v : null;
}

export const SKIP_REASON =
  'GROVE_CMUX_LIVE_VM is not set, so the live acceptance suite did not run. ' +
  'Set it to "auto" to clone gcx-base for the run, or to the name of a running guest.';

function tart(args, opts = {}) {
  return execFileSync(TART, args, { encoding: 'utf8', ...opts });
}

/** `tart exec` drops its control socket under load, so every call retries. */
function guestExec(vm, script, { attempts = 6, timeoutMs = 180000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gcx-exec-'));
  const file = join(dir, 'script.sh');
  writeFileSync(file, script);
  try {
    let last = '';
    for (let i = 0; i < attempts; i++) {
      // A guest command exiting nonzero is data, not a harness failure — half the cases are
      // about refusals. Capture the output either way and let the caller judge it.
      let res;
      try {
        res = execFileSync(
          '/bin/bash',
          ['-c', `${TART} exec -i ${vm} /bin/bash -s < ${JSON.stringify(file)} 2>&1`],
          { encoding: 'utf8', timeout: timeoutMs },
        );
      } catch (e) {
        res = (e.stdout ?? '').toString() || (e.message ?? '').toString();
      }
      last = res;
      if (!res.includes('Failed to connect to the VM using its control socket')) return res;
      execFileSync('/bin/sleep', ['8']);
    }
    return last;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function acquireGuest() {
  const setting = liveVmSetting();
  if (!setting) return null;

  if (setting !== 'auto') {
    return makeHandle(setting, false);
  }

  const vm = `gcx-live-${process.pid}`;
  tart(['clone', BASE_VM, vm]);
  const proc = spawn(TART, ['run', vm], { detached: true, stdio: 'ignore' });
  proc.unref();

  // Wait for the guest agent, then arm the socket. start-cmux.sh is idempotent and prints PONG.
  const deadline = Date.now() + 300000;
  let armed = false;
  while (Date.now() < deadline) {
    const out = guestExec(vm, 'echo READY', { attempts: 1, timeoutMs: 30000 }).trim();
    if (out.endsWith('READY')) {
      const up = startCmux(vm);
      if (up.includes('PONG')) {
        armed = true;
        break;
      }
    }
    execFileSync('/bin/sleep', ['5']);
  }
  if (!armed) {
    try {
      tart(['delete', vm]);
    } catch {
      /* leave it for inspection if delete also fails */
    }
    throw new Error(`guest ${vm} never armed its cmux socket`);
  }
  return makeHandle(vm, true);
}

function makeHandle(vm, ephemeral) {
  return {
    vm,
    ephemeral,
    exec: (script) => guestExec(vm, script),

    /** Ship the built wrapper into the guest. dist is small, so one base64 blob is enough. */
    deploy() {
      const tar = execFileSync(
        '/bin/bash',
        ['-c', `cd ${JSON.stringify(REPO)} && tar czf - dist package.json | base64`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      const out = guestExec(
        vm,
        `set -e
mkdir -p ${GUEST_PREFIX}
cd ${GUEST_PREFIX}
rm -rf dist package.json
cat > /tmp/gcx.b64 <<'B64EOF'
${tar}
B64EOF
base64 -d < /tmp/gcx.b64 | tar xzf -
/opt/homebrew/bin/node ${GUEST_PREFIX}/dist/cli.js --version`,
      );
      const version = out.trim().split('\n').pop();
      if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
        throw new Error(`deploy failed; guest said: ${out}`);
      }
      return version;
    },

    startCmux() {
      return startCmux(vm);
    },

    /**
     * Copy the requested grove-multirepo tarball in and install it, before seeding. The image
     * carries no grove, so a run tests the Grove it names. Returns the checked install report.
     */
    installGrove(request = groveRequest()) {
      const b64 = readFileSync(request.path).toString('base64');
      const out = guestExec(
        vm,
        `rm -f /tmp/grove-multirepo.tgz
base64 -d > /tmp/grove-multirepo.tgz <<'B64EOF'
${b64}
B64EOF
export GROVE_TARBALL=/tmp/grove-multirepo.tgz
${readFileSync(INSTALL_GROVE_SCRIPT, 'utf8')}`,
        { timeoutMs: 600000 },
      );
      return checkGroveInstall(request, out);
    },

    /**
     * Build the Grove fixture the cases run against, always from scratch.
     *
     * The workspace and its remotes are removed first, so the fixture is written by the grove
     * installGrove just put there and never by one an earlier run or the image used.
     */
    seed() {
      const script = readFileSync(SEED_SCRIPT, 'utf8');
      const out = guestExec(vm, `rm -rf "$HOME/work" "$HOME/fixture-remotes"\n${script}`);
      if (!out.includes('SEED_OK')) {
        throw new Error(`seeding the Grove fixture failed; guest said: ${out}`);
      }
      const trees = [...out.matchAll(/^tree\s+(\S+)\s+->\s+(\S+)$/gm)];
      if (trees.length === 0) {
        throw new Error(`the fixture has no Trees; guest said: ${out}`);
      }
      for (const [, name, top] of trees) {
        if (top.endsWith(name) === false) {
          throw new Error(`Tree ${name} does not resolve to its own worktree: ${top}`);
        }
      }
      return trees.map(([, name]) => name);
    },

    /** Run grove-cmux in the guest with the socket password armed. */
    cli(args, { cwd = '~', env = {} } = {}) {
      const exports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}\n`)
        .join('');
      const script = `export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin"
export CMUX_SOCKET_PASSWORD=$(cat "$HOME/.cmux-test-password")
export CMUX_QUIET=1
${exports}cd ${cwd}
node ${GUEST_PREFIX}/dist/cli.js ${args.map((a) => JSON.stringify(a)).join(' ')}
echo "__EXIT__$?"`;
      const out = guestExec(vm, script);
      const m = /__EXIT__(\d+)\s*$/.exec(out);
      const code = m ? Number(m[1]) : 1;
      return { code, out: out.replace(/__EXIT__\d+\s*$/, '') };
    },

    json(args, opts) {
      const r = this.cli([...args, '--json'], opts);
      const start = r.out.indexOf('{');
      let parsed = null;
      if (start >= 0) {
        try {
          parsed = JSON.parse(r.out.slice(start));
        } catch {
          /* leave null so the assertion names the raw output */
        }
      }
      return { ...r, json: parsed };
    },

    /** Raw cmux RPC in the guest, for arranging a case the wrapper must not arrange itself. */
    rpc(method, params = {}) {
      const script = `export PATH="/opt/homebrew/bin:$PATH"
export CMUX_SOCKET_PASSWORD=$(cat "$HOME/.cmux-test-password") CMUX_QUIET=1
cmux rpc ${JSON.stringify(method)} ${JSON.stringify(JSON.stringify(params))}`;
      const out = guestExec(vm, script);
      const start = out.indexOf('{');
      if (start < 0) throw new Error(`rpc ${method} returned no JSON: ${out}`);
      const parsed = JSON.parse(out.slice(start));
      // The live build returns the payload directly; some shapes wrap it in `result`.
      return parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed;
    },

    windowId() {
      const out = guestExec(
        vm,
        `export PATH="/opt/homebrew/bin:$PATH"
export CMUX_SOCKET_PASSWORD=$(cat "$HOME/.cmux-test-password") CMUX_QUIET=1
cmux list-windows --id-format uuids`,
      );
      const ids = out.match(
        /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g,
      );
      if (!ids || ids.length === 0) throw new Error(`no window id in: ${out}`);
      // A restarted cmux lists windows whose TabManager is not available yet. Pick one that
      // actually answers, so a case is not aimed at a window that cannot be read.
      for (const id of ids) {
        try {
          this.rpc('workspace.list', { window_id: id });
          return id;
        } catch {
          /* try the next one */
        }
      }
      throw new Error(`no window answered workspace.list; tried ${ids.length}`);
    },

    cmuxVersion() {
      return guestExec(vm, 'export PATH="/opt/homebrew/bin:$PATH"; cmux version').trim();
    },

    release() {
      if (!ephemeral) return;
      try {
        tart(['stop', vm]);
      } catch {
        /* it may already be down */
      }
      try {
        tart(['delete', vm]);
      } catch {
        /* leave it for inspection */
      }
    },
  };
}
