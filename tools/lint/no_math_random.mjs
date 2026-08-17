#!/usr/bin/env node
/**
 * CI gate: Math.random may only be CALLED in src/core/rng.ts and UI-only animation code.
 * Determinism is an architecture invariant — a battle must replay byte-identically from
 * (rosters, map, seed, intents[]).
 *
 * Comments are stripped before scanning, so a file is free to document the rule it obeys;
 * only a real call site fails the build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ALLOWED = [
  'src/core/rng.ts',
  'src/ui/anim/', // UI-only animation jitter, never game state
  'tools/ui-review-legacy/', // legacy harness, deleted with legacy/ in the final QA phase
];
const SCAN = ['src', 'tools', 'tests', 'e2e'];
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx']);
const CALL = /\bMath\s*\.\s*random\s*\(/;

/** Blank out block comments, line comments and string literals so only code remains. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        state = 'string';
        quote = c;
        out += ' ';
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
        i++;
        continue;
      }
      out += ' ';
      i++;
      continue;
    }
    // string
    if (c === '\\') {
      out += '  ';
      i += 2;
      continue;
    }
    if (c === quote) {
      state = 'code';
      out += ' ';
      i++;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}

const offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__pycache__' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXT.has(entry.slice(entry.lastIndexOf('.')))) continue;
    const rel = relative(ROOT, full).split('\\').join('/');
    if (ALLOWED.some((a) => rel === a || rel.startsWith(a))) continue;
    const code = stripNonCode(readFileSync(full, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (CALL.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
}

for (const dir of SCAN) walk(join(ROOT, dir));

if (offenders.length > 0) {
  console.error('Math.random() is called outside src/core/rng.ts:\n');
  for (const o of offenders) console.error('  ' + o);
  console.error('\nUse the injected Rng (ctx.rng) so battles replay deterministically.');
  process.exit(1);
}
console.log(`no_math_random: OK`);
