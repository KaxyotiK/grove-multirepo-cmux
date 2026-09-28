/**
 * The override ladder, in isolation.
 *
 * The point of these is the failure direction: a malformed override warns and falls back
 * rather than refusing, because branding must never be able to fail a projection — and that
 * has to hold for the person's own input too, not only for cmux's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND_COLOR_ENV,
  BRAND_ENV,
  BRAND_ICON_ENV,
  DEFAULT_BRAND_COLOR,
  DEFAULT_BRAND_ICON,
  TREE_STATUS_KEY,
  resolveBranding,
  treeStatusValue,
} from '../../src/branding.ts';

test('O1: the defaults live in one place and are a renderable symbol and a hex colour', () => {
  const { branding, warnings } = resolveBranding({});
  assert.equal(branding.enabled, true);
  assert.equal(branding.icon, DEFAULT_BRAND_ICON);
  assert.equal(branding.color, DEFAULT_BRAND_COLOR);
  assert.equal(branding.key, TREE_STATUS_KEY);
  assert.match(branding.color, /^#[0-9A-Fa-f]{6}$/);
  assert.deepEqual(warnings, []);
});

test('O1: the environment ladder overrides both values', () => {
  const { branding, warnings } = resolveBranding({
    [BRAND_ICON_ENV]: 'tree.fill',
    [BRAND_COLOR_ENV]: '#7A4FD8',
  });
  assert.equal(branding.icon, 'tree.fill');
  assert.equal(branding.color, '#7A4FD8');
  assert.deepEqual(warnings, []);
});

test('O1: a blank override reads as unset rather than as an empty symbol', () => {
  const { branding } = resolveBranding({ [BRAND_ICON_ENV]: '   ', [BRAND_COLOR_ENV]: '' });
  assert.equal(branding.icon, DEFAULT_BRAND_ICON);
  assert.equal(branding.color, DEFAULT_BRAND_COLOR);
});

test('O1: a malformed override warns and falls back; it never refuses the run', () => {
  const { branding, warnings } = resolveBranding({
    [BRAND_ICON_ENV]: 'not a symbol!',
    [BRAND_COLOR_ENV]: 'green',
  });
  assert.equal(branding.icon, DEFAULT_BRAND_ICON);
  assert.equal(branding.color, DEFAULT_BRAND_COLOR);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes(BRAND_ICON_ENV)));
  assert.ok(warnings.some((w) => w.includes(BRAND_COLOR_ENV)));
});

test('O1: branding can be turned off entirely, and only by a word that means off', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no']) {
    assert.equal(resolveBranding({ [BRAND_ENV]: v }).branding.enabled, false, v);
  }
  for (const v of ['on', '1', 'yes', 'leaf.fill']) {
    assert.equal(resolveBranding({ [BRAND_ENV]: v }).branding.enabled, true, v);
  }
});

test('O2: the pill value is the Grove name and nothing the wrapper would have to go and read', () => {
  assert.equal(treeStatusValue('feat-checkout'), 'feat-checkout');
});
