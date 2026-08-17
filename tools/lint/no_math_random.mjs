#!/usr/bin/env node
/**
 * CI gate: `Math.random` may only appear in src/core/rng.ts and UI-only animation code.
 * Determinism is an architecture invariant — a battle must replay byte-identically from
 * (rosters, map, seed, intents[]).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ALLOWED = [
  'src/core/rng.ts',
  'src/ui/anim/', // UI-only animation jitter, never game state
  'tools/lint/no_math_random.mjs', // this file names the symbol it forbids
  'tools/ui-review-legacy/', // legacy harness, deleted with legacy/ in Phase 8
];
const SCAN = ['src', 'tools', 'tests'];
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx']);

const offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = entry.slice(entry.lastIndexOf('.'));
    if (!EXT.has(ext)) continue;
    const rel = relative(ROOT, full).split('\\').join('/');
    if (ALLOWED.some((a) => rel === a || rel.startsWith(a))) continue;
    const src = readFileSync(full, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (line.includes('Math.random')) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
}

for (const dir of SCAN) walk(join(ROOT, dir));

if (offenders.length > 0) {
  console.error('Math.random() is not allowed outside src/core/rng.ts:\n');
  for (const o of offenders) console.error('  ' + o);
  console.error('\nUse the injected Rng (ctx.rng) so battles replay deterministically.');
  process.exit(1);
}
console.log('no_math_random: OK');
