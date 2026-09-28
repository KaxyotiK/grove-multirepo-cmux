#!/usr/bin/env node
/**
 * The acceptance record must be authoritative and total.
 *
 * Authoritative: every criterion declared in test/ACCEPTANCE.md is named by at least one test.
 * Total: every criterion a test names is declared there, exactly once.
 *
 * This only reports. It never edits the record or the tests, because a checker that fixes its own
 * input cannot tell you the input was wrong.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join('test', 'ACCEPTANCE.md');
const CRITERION = /\bAC-\d{2}\b/g;
const DECLARATION = /^- \*\*(AC-\d{2})\b/gm;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

export function inspectAcceptanceRecord(repo = DEFAULT_REPO) {
  let text;
  try {
    text = readFileSync(join(repo, RECORD), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { exitCode: 2, declared: [], coveredBy: new Map(), duplicates: [], undeclared: [], uncovered: [], configurationErrors: [`missing acceptance record: ${RECORD}`] };
  }

  const declared = [...text.matchAll(DECLARATION)].map((match) => match[1]);
  const configurationErrors = declared.length === 0 ? [`no acceptance criteria found in ${RECORD}`] : [];
  const seen = new Set();
  const duplicates = [...new Set(declared.filter((id) => seen.has(id) || !seen.add(id)))].sort();
  const declaredSet = new Set(declared);

  const coveredBy = new Map();
  for (const file of walk(join(repo, 'test'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(CRITERION)) {
      if (!coveredBy.has(match[0])) coveredBy.set(match[0], new Set());
      coveredBy.get(match[0]).add(relative(repo, file));
    }
  }

  const undeclared = [...coveredBy.keys()].filter((id) => !declaredSet.has(id)).sort();
  const uncovered = [...declaredSet].filter((id) => !coveredBy.has(id)).sort();
  const fatal = duplicates.length > 0 || undeclared.length > 0 || uncovered.length > 0;
  return {
    exitCode: configurationErrors.length > 0 ? 2 : fatal ? 1 : 0,
    declared: [...declaredSet].sort(),
    coveredBy,
    duplicates,
    undeclared,
    uncovered,
    configurationErrors,
  };
}

export function formatAcceptanceRecord(result) {
  const stdout = [];
  const stderr = [];
  stdout.push(`acceptance criteria declared in ${RECORD}: ${result.declared.length}`);
  stdout.push(`acceptance criteria named by a test: ${result.coveredBy.size}`);
  for (const id of result.declared) {
    const files = result.coveredBy.get(id);
    stdout.push(`  ${id}  ${files ? [...files].sort().join(', ') : 'NOT COVERED'}`);
  }
  for (const error of result.configurationErrors) stderr.push(error);
  if (result.uncovered.length > 0) stderr.push(`no test names these criteria: ${result.uncovered.join(', ')}`);
  if (result.undeclared.length > 0) stderr.push(`tests name criteria ${RECORD} does not declare: ${result.undeclared.join(', ')}`);
  if (result.duplicates.length > 0) stderr.push(`criteria declared more than once: ${result.duplicates.join(', ')}`);
  if (result.exitCode === 0) {
    stdout.push('');
    stdout.push('the record is authoritative and total.');
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

export function main(repo = DEFAULT_REPO) {
  const result = inspectAcceptanceRecord(repo);
  const output = formatAcceptanceRecord(result);
  console.log(output.stdout);
  if (output.stderr) console.error(`\n${output.stderr}`);
  return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
