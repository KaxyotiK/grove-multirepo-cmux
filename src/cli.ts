#!/usr/bin/env node
/**
 * grove-cmux: project a Grove and its Trees into cmux native workspace groups.
 *
 * Grove is the source of truth. The wrapper is a plain external process speaking cmux's
 * control socket; it never spawns a terminal and never needs caller context.
 */

import { resolve } from 'node:path';
import { CmuxClient, isMutating } from './cmux.ts';
import { destructiveActions } from './classify.ts';
import { GroveCmuxError, isGroveCmuxError } from './errors.ts';
import { apply, closeProjection, launchAgent, observe, type Observation } from './engine.ts';
import { GroveRunner, groveRootFromJson, isCompletedOutcome } from './grove.ts';
import { readLedger } from './ledger.ts';
import { renderHuman, renderJson, type Launch, type Report } from './render.ts';

export const VERSION = '0.1.0';

const USAGE = `grove-cmux ${VERSION} — project a Grove into cmux workspace groups

Usage:
  grove-cmux open   [<grove-root>] [options]
  grove-cmux sync   [<grove-root>] [options]
  grove-cmux status [<grove-root>] [options]
  grove-cmux close  [<grove-root>] [options]
  grove-cmux new    <name> [grove options...] [options]
  grove-cmux run    [<grove-root>] --tree <tree> [--agent <name>] [-- <agent args>...]

Options:
  --window <id|focused>   target window; "focused" opts into the focused-window fallback
  --tree <tree>           run: which Tree to hand the task to (short or full name)
  --agent <name>          start "grove agent run" in each workspace this run creates
  --allow-destructive     sync may close workspaces whose Tree is gone (never the anchor)
  --forget                close: remove .grove-cmux after verified success
  --keep-anchor           close: retain the anchor as an ungrouped workspace
  --relocate              re-project here and leave the other window's group alone
  --dry-run               sync/close: print the plan, change nothing
  --all                   show workspaces unrelated to this Grove
  --json                  machine output
  -h, --help              this text
  -V, --version           version

Environment:
  CMUX_SOCKET_PASSWORD    cmux socket password
  GROVE_CMUX_WINDOW       set to "focused" to make the focused fallback your default
  GROVE_CMUX_CMUX_BIN     path to the cmux binary (default: cmux)
  GROVE_BIN               path to the grove binary (default: grove)
  GROVE_CMUX_BRAND        set to "off" to project without the Grove icon, colour and pill
  GROVE_CMUX_BRAND_ICON   SF Symbol for the group header and the pill (default: leaf.fill)
  GROVE_CMUX_BRAND_COLOR  hex colour for both (default: #2F9E44)
`;

const COMMAND_HELP: Record<string, string> = {
  open: `grove-cmux open [<grove-root>] [options]

Project the Grove into a cmux window: one workspace per Tree, then one group whose anchor
sits at the Grove root. Additive and idempotent — running it twice creates nothing the
second time. Refuses if the Grove is already projected in another window; --relocate
re-projects here and closes nothing there.

Options: --window, --agent, --relocate, --json, --all`,
  sync: `grove-cmux sync [<grove-root>] [options]

Reconcile the projection with what Grove says exists. Additive by default: a Tree whose
directory is gone is reported stale and its workspace is left open. --allow-destructive
closes those, and never closes the anchor.

Options: --window, --allow-destructive, --dry-run, --relocate, --json, --all`,
  status: `grove-cmux status [<grove-root>] [options]

Read-only. Classifies every workspace as present, detached, missing, stale, foreign or
ignore, and prints the actions sync would take. Issues no mutating call.
With no --window it reports every window rather than refusing.

Exit code is 0 whenever a report was produced. A non-zero exit always means a refusal,
never a finding.

Options: --window, --all, --json`,
  close: `grove-cmux close [<grove-root>] [options]

Close every workspace the projection ledger names. The command finds each workspace in its
actual cmux window, closes Tree workspaces first, and closes the anchor last. --keep-anchor
releases a safe group and retains the anchor. --forget removes .grove-cmux only after the
close is verified.

Options: --forget, --keep-anchor, --dry-run, --json`,
  new: `grove-cmux new <name> [grove options...] [options]

Compose "grove --json new", then project the result. Only a completed Grove outcome is
projected; a partial one is reported and nothing is created in cmux.

Options: --window, --json`,
  run: `grove-cmux run [<grove-root>] --tree <tree> [--agent <name>] [-- <agent args>...]

Hand one task to one agent in one Tree. Projects the Grove first if it is not open, then
starts a new terminal inside that Tree's workspace running "grove agent run". Everything
after "--" is forwarded to the agent verbatim, so a multi-word prompt arrives as one
argument.

Unlike "open --agent", this works on a Grove that is already open: it creates a surface in
the existing workspace rather than relying on a workspace being created.

With no --agent, the Tree's default grove agent runs.

Options: --window, --tree, --agent, --relocate, --json, --all`,
};

interface Args {
  command: string;
  positional: string[];
  window: string | null;
  tree: string | null;
  agent: string | null;
  allowDestructive: boolean;
  forget: boolean;
  keepAnchor: boolean;
  relocate: boolean;
  dryRun: boolean;
  all: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  passthrough: string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: '',
    positional: [],
    window: null,
    tree: null,
    agent: null,
    allowDestructive: false,
    forget: false,
    keepAnchor: false,
    relocate: false,
    dryRun: false,
    all: false,
    json: false,
    help: false,
    version: false,
    passthrough: [],
  };
  let i = 0;
  let seenSeparator = false;
  for (; i < argv.length; i++) {
    const t = argv[i]!;
    if (seenSeparator) {
      a.passthrough.push(t);
      continue;
    }
    switch (t) {
      case '--':
        seenSeparator = true;
        continue;
      case '-h':
      case '--help':
        a.help = true;
        continue;
      case '-V':
      case '--version':
        a.version = true;
        continue;
      case '--json':
        a.json = true;
        continue;
      case '--all':
        // `--all` is grove's flag on `new` (project every registered repo) and grove-cmux's
        // everywhere else (show unrelated rows). On `new` it belongs to grove, because
        // showing ignored rows of a Grove that did not exist a second ago means nothing.
        if (a.command === 'new') a.passthrough.push(t);
        else a.all = true;
        continue;
      case '--allow-destructive':
        a.allowDestructive = true;
        continue;
      case '--forget':
        a.forget = true;
        continue;
      case '--keep-anchor':
        a.keepAnchor = true;
        continue;
      case '--relocate':
        a.relocate = true;
        continue;
      case '--dry-run':
        a.dryRun = true;
        continue;
      case '--window':
      case '--tree':
      case '--agent': {
        const v = argv[++i];
        if (v === undefined) {
          throw new GroveCmuxError('E_USAGE', `${t} needs a value`, { flag: t });
        }
        if (t === '--window') a.window = v;
        else if (t === '--tree') a.tree = v;
        else a.agent = v;
        continue;
      }
      default:
        break;
    }
    if (t.startsWith('--window=')) {
      a.window = t.slice('--window='.length);
      continue;
    }
    if (t.startsWith('-')) {
      // Unknown flags after the command name belong to grove for `new`.
      if (a.command === 'new') {
        a.passthrough.push(t);
        continue;
      }
      throw new GroveCmuxError('E_USAGE', `unknown option ${t}`, { option: t });
    }
    if (a.command === '') a.command = t;
    // `new` takes one positional, the Grove name. Anything after it is grove's, in order, so
    // `--repo api` keeps its value; collecting `api` as a positional sent grove `--repo` alone.
    else if (a.command === 'new' && a.positional.length > 0) a.passthrough.push(t);
    else a.positional.push(t);
  }
  // `--` means something on exactly two commands: on `new` it belongs to grove, and on `run`
  // it belongs to the agent. Everywhere else it was collected and silently dropped, so
  // `grove-cmux open g -- foo` exited 0 having ignored `foo` entirely.
  if (seenSeparator && a.command !== 'new' && a.command !== 'run') {
    throw new GroveCmuxError(
      'E_USAGE',
      `${a.command || 'this command'} takes nothing after "--"`,
      { command: a.command || null, after_separator: a.passthrough },
      'pass agent arguments to grove-cmux run --tree <tree> -- <args>',
    );
  }
  return a;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    // A parse failure happens before --json has been read, so look for it in the raw argv.
    // Otherwise a caller asking for machine output gets prose on the one path where it most
    // needs to be parsed: the flag it got wrong.
    return fail(e, argv.includes('--json'));
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === '' || args.help) {
    const help = COMMAND_HELP[args.command];
    process.stdout.write(help ? `${help}\n` : USAGE);
    return args.command === '' && !args.help ? 2 : 0;
  }
  if (!['open', 'sync', 'status', 'close', 'new', 'run'].includes(args.command)) {
    return fail(
      new GroveCmuxError('E_USAGE', `unknown command "${args.command}"`, {
        command: args.command,
      }),
      args.json,
    );
  }

  try {
    if (args.command !== 'close' && (args.forget || args.keepAnchor)) {
      const flag = args.forget ? '--forget' : '--keep-anchor';
      throw new GroveCmuxError('E_USAGE', `${flag} is only valid with close`, {
        command: args.command,
        flag,
      });
    }
    switch (args.command) {
      case 'status':
        return await cmdStatus(args);
      case 'open':
      case 'sync':
        return await cmdProject(args);
      case 'close':
        return await cmdClose(args);
      case 'new':
        return await cmdNew(args);
      case 'run':
        return await cmdRun(args);
      default:
        return 2;
    }
  } catch (e) {
    return fail(e, args.json);
  }
}

async function cmdClose(args: Args): Promise<number> {
  if (args.positional.length > 1) {
    throw new GroveCmuxError('E_USAGE', 'close accepts at most one Grove root', {
      command: 'close',
      positional: args.positional,
    });
  }
  const invalid = [
    ...(args.window ? ['--window'] : []),
    ...(args.relocate ? ['--relocate'] : []),
    ...(args.allowDestructive ? ['--allow-destructive'] : []),
    ...(args.tree ? ['--tree'] : []),
    ...(args.agent ? ['--agent'] : []),
    ...(args.all ? ['--all'] : []),
  ];
  if (invalid.length > 0) {
    const flag = invalid[0]!;
    throw new GroveCmuxError(
      'E_USAGE',
      `close does not accept ${flag}`,
      { command: 'close', flag },
      flag === '--window'
        ? 'run grove-cmux close without --window; close finds each ledgered workspace itself'
        : 'run grove-cmux close --help to see the supported options',
    );
  }
  const report = await closeProjection({
    groveRoot: groveRootFrom(args),
    client: new CmuxClient(),
    keepAnchor: args.keepAnchor,
    forget: args.forget,
    dryRun: args.dryRun,
  });
  process.stdout.write(args.json ? renderJson(report) : renderHuman(report));
  return 0;
}

function groveRootFrom(args: Args): string {
  return resolve(args.positional[0] ?? process.cwd());
}

async function cmdStatus(args: Args): Promise<number> {
  const client = new CmuxClient();
  const result = await observe({
    groveRoot: groveRootFrom(args),
    client,
    window: args.window,
    mutating: false,
  });
  const reports = Array.isArray(result) ? result.map((o) => o.report) : result.report;

  // AC-02: status issues read calls only. This is asserted here, not just in a test, so a
  // future edit that adds a mutation to the read path fails loudly rather than silently.
  const mutations = client.journal.filter((c) => isMutating(c.method));
  if (mutations.length > 0) {
    throw new GroveCmuxError('E_INTERNAL', 'status issued a mutating call', {
      calls: mutations.map((m) => m.method),
    });
  }

  process.stdout.write(
    args.json ? renderJson(reports) : renderHuman(reports, { all: args.all }),
  );
  return 0;
}

type LaunchHook = (obs: Observation, client: CmuxClient) => Promise<Launch[]>;

async function cmdProject(args: Args, launch?: LaunchHook): Promise<number> {
  // open never closes anything. Accepting the flag and ignoring it gave a clean exit, no
  // warning, and a stale workspace still open — the person had every reason to think it had
  // been closed.
  if (args.command === 'open' && args.allowDestructive) {
    throw new GroveCmuxError(
      'E_USAGE',
      'open never closes anything, so --allow-destructive has no meaning here',
      { command: 'open', flag: '--allow-destructive' },
      'run grove-cmux sync --allow-destructive to close workspaces whose Tree is gone',
    );
  }
  const client = new CmuxClient();
  const groveRoot = groveRootFrom(args);
  const result = await observe({
    groveRoot,
    client,
    window: args.window,
    mutating: true,
    relocate: args.relocate,
  });
  const obs = (Array.isArray(result) ? result[0]! : result) as Observation;

  // --relocate abandons the other window's objects rather than closing them: groups are
  // window-local, so "moving" would mean destroying terminals that may be running work.
  if (args.relocate) {
    const stale = readLedger(groveRoot);
    if (stale && stale.window_id && stale.window_id !== obs.window.id) {
      process.stderr.write(
        `note: window ${stale.window_id} still holds this Grove's old workspaces; nothing there was closed\n`,
      );
    }
  }

  if (args.dryRun) {
    process.stdout.write(
      args.json ? renderJson(obs.report) : renderHuman(obs.report, { all: args.all }),
    );
    return 0;
  }

  const { applied, warnings: brandingWarnings } = await apply(obs, {
    client,
    allowDestructive: args.command === 'sync' && args.allowDestructive,
    // `run` launches through its own hook, into a workspace that may already have existed.
    // Passing the agent here too would start it twice on the run that also creates the
    // workspace, and not at all on the run that does not.
    agent: launch ? null : args.agent,
  });

  const launched = launch ? await launch(obs, client) : undefined;

  // Re-observe so the printed report describes the world after the run, not before it.
  const after = (await observe({
    groveRoot,
    client,
    window: obs.window.id,
    mutating: false,
  })) as Observation;
  after.report.applied = applied;
  if (launched) after.report.launched = launched;

  // An agent is launched by workspace.create's initial_command, which fires only when the
  // workspace is created. On an already-projected Grove `open --agent` therefore created
  // nothing, started nothing, and said nothing — a clean exit that looked like a launch.
  if (!launch && args.agent && !applied.some((a) => a.op === 'workspace.create')) {
    after.report.warnings.push(
      `--agent ${args.agent} started nothing: every Tree already had a workspace, and an agent starts only with a new one; use grove-cmux run --tree <tree> --agent ${args.agent}`,
    );
  }

  // Branding never fails a run, so the only place a failed branding call can be seen is here.
  // The re-observe cannot rediscover it: the calls happened during apply.
  after.report.warnings.push(...brandingWarnings);

  // Keyed on what the run actually did, not on the flag: gating it on the flag meant the one
  // person who asked for destruction was the one who never heard that it had not happened.
  {
    const wouldClose = destructiveActions(after.plan.actions);
    if (wouldClose.length > 0) {
      after.report.warnings.push(
        `${wouldClose.length} stale workspace${wouldClose.length === 1 ? '' : 's'} left open; --allow-destructive would close ${wouldClose.length === 1 ? 'it' : 'them'}`,
      );
    }
  }

  process.stdout.write(
    args.json ? renderJson(after.report) : renderHuman(after.report, { all: args.all }),
  );
  return 0;
}

async function cmdNew(args: Args): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    throw new GroveCmuxError('E_USAGE', 'new needs a Grove name', { command: 'new' });
  }
  const grove = new GroveRunner();
  const out = await grove.json(['new', name, ...args.passthrough]);
  if (!isCompletedOutcome(out)) {
    throw new GroveCmuxError(
      'E_GROVE_FAILED',
      `grove new did not complete (outcome: ${out.outcome ?? 'unknown'})`,
      { outcome: out.outcome ?? null, diagnostics: out.diagnostics ?? null },
      'fix what grove reported, then run grove-cmux open',
    );
  }
  const root = groveRootFromJson(out);
  if (!root) {
    throw new GroveCmuxError(
      'E_GROVE_SCHEMA',
      'grove new reported success but named no Tree path, so the Grove root is unknown',
      { outcome: out.outcome ?? null, targets: out.targets ?? null },
      'run grove --json new yourself and check its targets, then grove-cmux open <root>',
    );
  }
  return cmdProject({ ...args, command: 'open', positional: [root] });
}

/**
 * `run`: hand one task to one agent in one Tree.
 *
 * The projection runs first, through the same path `open` uses, so the command works whether
 * or not the Grove was already open. The launch itself is a surface in the Tree's ledgered
 * workspace, which is what makes "already open" and "just opened" the same case.
 */
async function cmdRun(args: Args): Promise<number> {
  if (!args.tree) {
    throw new GroveCmuxError(
      'E_USAGE',
      'run needs --tree <tree>',
      { command: 'run' },
      'pass --tree <tree>; grove-cmux status lists the Trees of this Grove',
    );
  }
  const requested = args.tree;

  // Before cmux is touched at all. Refusing after the projection would mean a run that
  // mistyped an agent name still created N+1 workspaces on its way to saying no.
  await assertAgentDefined(groveRootFrom(args), args.agent);

  return cmdProject({ ...args, command: 'open' }, async (obs, client) => {
    const tree = resolveTree(obs, requested);

    // The ledger is re-read after apply, because the workspace may have been created by it.
    const ledger = readLedger(obs.grove.root);
    const workspaceId = ledger?.trees[tree.name];
    if (!workspaceId) {
      throw new GroveCmuxError(
        'E_PRECONDITION',
        `tree ${tree.name} has no workspace to run in`,
        { tree: tree.name, ledger: ledger?.trees ?? null },
        'run grove-cmux open first, and check that the Tree directory still exists',
      );
    }

    const launched = await launchAgent({
      client,
      windowId: obs.window.id,
      workspaceId,
      grove: obs.grove,
      tree,
      agent: args.agent,
      argv: args.passthrough,
    });
    return [launched];
  });
}

/** Accept either the short Tree name ("api") or the full directory name ("grove@api"). */
function resolveTree(obs: Observation, requested: string) {
  const hits = obs.grove.trees.filter(
    (t) => t.name === requested || t.shortName === requested,
  );
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new GroveCmuxError(
      'E_AMBIGUOUS_TARGET',
      `"${requested}" names ${hits.length} Trees of grove ${obs.grove.name}`,
      { requested, matches: hits.map((t) => t.name) },
      `pass the full name, one of: ${hits.map((t) => t.name).join(', ')}`,
    );
  }
  throw new GroveCmuxError(
    'E_USAGE',
    `grove ${obs.grove.name} has no Tree "${requested}"`,
    { requested, trees: obs.grove.trees.map((t) => t.name) },
    obs.grove.trees.length > 0
      ? `use one of: ${obs.grove.trees.map((t) => t.shortName).join(', ')}`
      : 'this Grove has no Trees; run grove new or grove add first',
  );
}

/**
 * Refuse a named agent that grove does not define, before anything is created.
 *
 * grove reports an undefined agent by exiting 2 inside the terminal, which under the trailing
 * `exec` leaves a live shell and no visible failure — the surface looks exactly like a
 * successful launch. Checking first turns that into a refusal that names the agents there are.
 *
 * A grove that cannot answer at all yields null, and null is not a refusal: failing to check
 * is not evidence that the agent is missing.
 */
async function assertAgentDefined(cwd: string, agent: string | null): Promise<void> {
  // Called even with no agent named, because `run` launches `grove agent run` either way and
  // listAgents is where an absolute GROVE_BIN that does not exist is caught. Without this the
  // no-agent path projected the Grove and then reported "launched" into a command that
  // provably could not run.
  const agents = await new GroveRunner().listAgents(cwd);
  if (!agent) return;
  if (agents === null) return;
  const hit = agents.find((a) => a.name === agent);
  if (!hit) {
    throw new GroveCmuxError(
      'E_PRECONDITION',
      `grove defines no agent named "${agent}"`,
      { agent, defined: agents.map((a) => a.name) },
      agents.length > 0
        ? `use one of: ${agents.map((a) => a.name).join(', ')}, or grove agent add ${agent} <command>`
        : `run grove agent add ${agent} <command> first`,
    );
  }
  if (!hit.available) {
    throw new GroveCmuxError(
      'E_PRECONDITION',
      `grove agent "${agent}" is defined but its command is not executable`,
      { agent },
      `check the command with grove agent ls, then fix it or re-add ${agent}`,
    );
  }
}

function fail(e: unknown, json: boolean): number {
  if (isGroveCmuxError(e)) {
    process.stderr.write(json ? `${JSON.stringify(e.toJSON(), null, 2)}\n` : `${e.toHuman()}\n`);
    return e.code;
  }
  const wrapped = new GroveCmuxError('E_INTERNAL', (e as Error)?.message ?? String(e), {
    stack: (e as Error)?.stack?.split('\n').slice(0, 5).join('\n') ?? null,
  });
  process.stderr.write(
    json ? `${JSON.stringify(wrapped.toJSON(), null, 2)}\n` : `${wrapped.toHuman()}\n`,
  );
  return wrapped.code;
}

export type { Report };

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('grove-cmux'));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.exitCode = fail(e, false);
    },
  );
}
