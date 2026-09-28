/**
 * The Grove's identity, as cmux renders it.
 *
 * Two surfaces, both of them things cmux already draws: the workspace group header carries an
 * SF Symbol and a hex colour, and each Tree workspace carries one keyed sidebar status pill.
 * Nothing here builds a surface of its own, writes a config file, or ships an image.
 *
 * Branding is best-effort by construction. A cmux that does not answer these calls still
 * projects the Grove; the failure becomes a warning on the report and the run exits 0. That is
 * why none of these methods is in `REQUIRED_METHODS`: refusing the whole projection because a
 * header could not be tinted would trade the product for the decoration.
 *
 * Two rules govern when a call is issued, and they differ because the surfaces differ:
 *
 *   - The group header is set only when cmux reports it unset. A person who recolours our
 *     group has expressed a preference, and re-asserting it on every reconcile would fight
 *     them. This is the same posture the wrapper already takes towards a workspace title,
 *     which it sets at create and never restores.
 *   - The pill is written every reconcile, because the key is ours. `set_status` is last write
 *     per key, so a stable key overwrites rather than accumulates, and there is no read-back
 *     that would make a conditional write cheaper than the write itself.
 *
 * The values are here rather than at the call site so that "what a Grove looks like" is one
 * edit, and the override ladder is the same `GROVE_CMUX_*` environment family the window
 * resolution already uses.
 */

import type { CmuxClient, CmuxGroup } from './cmux.ts';

/** `leaf.fill` renders: it is a real SF Symbol, and cmux's own docs use it in this position. */
export const DEFAULT_BRAND_ICON = 'leaf.fill';
/** Grove green. Any hex string is accepted by cmux; this one is legible in both themes. */
export const DEFAULT_BRAND_COLOR = '#2F9E44';
/** One key, so a reconcile overwrites the row rather than adding another. */
export const TREE_STATUS_KEY = 'grove';
/** Higher sorts first. Above 0 so the Grove row leads an agent's own status rows. */
export const TREE_STATUS_PRIORITY = 60;

export const BRAND_ENV = 'GROVE_CMUX_BRAND';
export const BRAND_ICON_ENV = 'GROVE_CMUX_BRAND_ICON';
export const BRAND_COLOR_ENV = 'GROVE_CMUX_BRAND_COLOR';

/**
 * An SF Symbol name. cmux resolves it through `NSImage(systemSymbolName:)` and stores null for
 * anything unrenderable, so a typo is a silent no-op there; this shape check at least catches
 * a value that could never be a symbol name at all.
 */
const SYMBOL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.]*[A-Za-z0-9]$/;
const HEX_SHAPE = /^#[0-9A-Fa-f]{3,8}$/;

export interface Branding {
  enabled: boolean;
  icon: string;
  color: string;
  key: string;
  priority: number;
}

export interface ResolvedBranding {
  branding: Branding;
  warnings: string[];
}

/**
 * The override ladder, in one place.
 *
 * A flag was rejected: branding is a property of the Grove, not of the run, and a flag that
 * must be re-passed on every reconcile brands inconsistently the first time someone forgets
 * it. A config file was rejected for the reason O3 and O4 were deferred — it is a new file to
 * own. An environment variable is the mechanism the wrapper already has for exactly this kind
 * of standing preference.
 *
 * A malformed override warns and falls back rather than refusing: branding never fails a run,
 * and that has to hold for the person's own input too. Silence would be worse than either.
 */
export function resolveBranding(env: NodeJS.ProcessEnv = process.env): ResolvedBranding {
  const warnings: string[] = [];
  const raw = (name: string): string | null => {
    const v = env[name];
    return v !== undefined && v.trim().length > 0 ? v.trim() : null;
  };

  const off = raw(BRAND_ENV);
  const enabled = !(off !== null && /^(off|0|false|no)$/i.test(off));

  let icon = DEFAULT_BRAND_ICON;
  const iconOverride = raw(BRAND_ICON_ENV);
  if (iconOverride !== null) {
    if (SYMBOL_SHAPE.test(iconOverride)) icon = iconOverride;
    else
      warnings.push(
        `${BRAND_ICON_ENV}="${iconOverride}" is not shaped like an SF Symbol name; using ${DEFAULT_BRAND_ICON}`,
      );
  }

  let color = DEFAULT_BRAND_COLOR;
  const colorOverride = raw(BRAND_COLOR_ENV);
  if (colorOverride !== null) {
    if (HEX_SHAPE.test(colorOverride)) color = colorOverride;
    else
      warnings.push(
        `${BRAND_COLOR_ENV}="${colorOverride}" is not a hex colour; using ${DEFAULT_BRAND_COLOR}`,
      );
  }

  return {
    branding: { enabled, icon, color, key: TREE_STATUS_KEY, priority: TREE_STATUS_PRIORITY },
    warnings,
  };
}

/** What the pill says. Derived only from what the wrapper already reads: the Grove's name. */
export function treeStatusValue(groveName: string): string {
  return groveName;
}

export interface BrandTarget {
  client: CmuxClient;
  windowId: string;
  branding: Branding;
  groveName: string;
  /** The group we own, or null when this run owns none. Never a group the ledger does not name. */
  groupId: string | null;
  /** The group as cmux last reported it, or null when this run created it. */
  observedGroup: CmuxGroup | null;
  /** Ledger rows only: tree name and the workspace UUID the ledger records for it. */
  trees: Array<{ tree: string; workspaceId: string }>;
}

/**
 * Brand what the ledger says is ours, and nothing else.
 *
 * Every id named here comes from the caller's ledger writer or from a create this run issued,
 * so the capability rule holds unchanged: a `foreign` group is never restyled and a workspace
 * the ledger does not name never gets a pill.
 *
 * Returns warnings. It never throws — every failure is one line on the report.
 */
export async function applyBranding(t: BrandTarget): Promise<string[]> {
  const warnings: string[] = [];
  if (!t.branding.enabled) return warnings;

  if (t.groupId) {
    // Absent group means we created it in this run, so both fields are unset.
    const haveIcon = nonEmpty(t.observedGroup?.icon_symbol);
    const haveColor = nonEmpty(t.observedGroup?.custom_color);
    if (!haveIcon) {
      await best(warnings, `set the group icon`, () =>
        t.client.setGroupIcon(t.groupId!, t.branding.icon, t.windowId),
      );
    }
    if (!haveColor) {
      await best(warnings, `set the group colour`, () =>
        t.client.setGroupColor(t.groupId!, t.branding.color, t.windowId),
      );
    }
  }

  for (const { tree, workspaceId } of t.trees) {
    await best(warnings, `set the sidebar status for ${tree}`, () =>
      t.client.setStatus({
        workspaceId,
        key: t.branding.key,
        value: treeStatusValue(t.groveName),
        icon: t.branding.icon,
        color: t.branding.color,
        priority: t.branding.priority,
      }),
    );
  }

  return warnings;
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

async function best(warnings: string[], what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warnings.push(`could not ${what}: ${message.split('\n')[0]}`);
  }
}
