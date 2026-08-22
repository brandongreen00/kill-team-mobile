/**
 * Manual defence allocation — the one reactive window where the rules give the DEFENDER a
 * real choice and the old screen quietly took it away.
 *
 * `allocateDefence` offered two buttons, "Auto-allocate" and "Allocate manually". Only the
 * first carried any data, and `resolveDecision` falls back to the auto allocation whenever
 * the payload has no `unblockedCrits` — so "Allocate manually" ran the automatic allocation
 * and the player never found out. It is a dead control on a screen that decides how much
 * damage an operative takes.
 *
 * The choice itself is stated in the rules as spending defence dice on attack dice, so that
 * is what this screen is: the incoming hits as a row of chips, tap one to save against it.
 * The allocator works out which defence dice pay for it, refuses what cannot be paid for and
 * says why, and the damage total updates under your thumb before you commit anything.
 */
import { useState } from 'preact/hooks';
import type { PendingDecision } from '../../core/types.ts';
import { IconAlert, IconCheck, IconShield } from '../icons.tsx';
import type { CommandAction, CommandPlan } from './types.ts';

/** What `shoot.ts` puts on the decision. Defaults keep an older saved battle renderable. */
interface AllocCtx {
  atkCrits: number;
  atkNormals: number;
  defCrits: number;
  defNormals: number;
  dmgN: number;
  dmgC: number;
  brutal: boolean;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function allocCtxOf(decision: PendingDecision): AllocCtx {
  const c = (decision.ctx ?? {}) as Record<string, unknown>;
  return {
    atkCrits: num(c['atkCrits']),
    atkNormals: num(c['atkNormals']),
    defCrits: num(c['defCrits']),
    defNormals: num(c['defNormals']),
    dmgN: num(c['dmgN'], 1),
    dmgC: num(c['dmgC'], 1),
    brutal: c['brutal'] === true,
  };
}

/**
 * Can `bc` critical and `bn` normal attack dice be blocked with the defence pool?
 *
 * Straight from the rule: "A normal success can block a normal success. Two normal successes
 * can block a critical success. A critical success can block a normal success or a critical
 * success." Brutal takes normals out of the pool entirely. Small enough numbers to just try
 * every split of the critical saves.
 */
export function canBlock(c: AllocCtx, bc: number, bn: number): boolean {
  if (bc < 0 || bn < 0 || bc > c.atkCrits || bn > c.atkNormals) return false;
  const usableNormals = c.brutal ? 0 : c.defNormals;
  for (let cc = 0; cc <= Math.min(c.defCrits, bc); cc++) {
    const pairs = bc - cc;
    if (pairs * 2 > usableNormals) continue;
    const critsLeft = c.defCrits - cc;
    const normalsLeft = usableNormals - pairs * 2;
    if (bn <= critsLeft + normalsLeft) return true;
  }
  return false;
}

/** How many defence dice the cheapest legal way to block `bc`/`bn` actually spends. */
function diceSpent(c: AllocCtx, bc: number, bn: number): number {
  const usableNormals = c.brutal ? 0 : c.defNormals;
  let best = Infinity;
  for (let cc = 0; cc <= Math.min(c.defCrits, bc); cc++) {
    const pairs = bc - cc;
    if (pairs * 2 > usableNormals) continue;
    const critsLeft = c.defCrits - cc;
    const normalsLeft = usableNormals - pairs * 2;
    if (bn > critsLeft + normalsLeft) continue;
    best = Math.min(best, cc + pairs * 2 + bn);
  }
  return Number.isFinite(best) ? best : 0;
}

interface AllocatorProps {
  c: AllocCtx;
  blocked: { crits: number; normals: number };
  onChange: (next: { crits: number; normals: number }) => void;
}

function Allocator({ c, blocked, onChange }: AllocatorProps) {
  const toggle = (crit: boolean, index: number) => {
    const cur = crit ? blocked.crits : blocked.normals;
    // Chips fill left-to-right: tapping any blocked chip un-blocks down to it, tapping any
    // unblocked chip blocks up to it. Nothing to drag, and the row never reorders.
    const want = index < cur ? index : index + 1;
    const next = crit ? { ...blocked, crits: want } : { ...blocked, normals: want };
    if (canBlock(c, next.crits, next.normals)) onChange(next);
  };

  const chip = (crit: boolean, index: number) => {
    const on = index < (crit ? blocked.crits : blocked.normals);
    const reachable =
      on ||
      canBlock(c, crit ? index + 1 : blocked.crits, crit ? blocked.normals : index + 1);
    return (
      <button
        key={`${crit ? 'c' : 'n'}${index}`}
        type="button"
        class={`hit-chip${crit ? ' is-crit' : ''}${on ? ' is-blocked-hit' : ''}`}
        disabled={!reachable}
        aria-pressed={on}
        aria-label={`${crit ? 'Critical' : 'Normal'} hit, ${crit ? c.dmgC : c.dmgN} damage — ${on ? 'saved' : 'not saved'}`}
        onClick={() => toggle(crit, index)}
      >
        {on ? <IconShield size={16} /> : null}
        <span>{crit ? c.dmgC : c.dmgN}</span>
      </button>
    );
  };

  const spent = diceSpent(c, blocked.crits, blocked.normals);
  const left = c.defCrits + (c.brutal ? 0 : c.defNormals) - spent;

  return (
    <div class="card allocator">
      <h2>Incoming hits</h2>
      <p class="dim" style={{ marginTop: 0 }}>
        Tap a hit to save against it. The number on each chip is the damage it does.
      </p>
      <div class="hit-row">
        {Array.from({ length: c.atkCrits }, (_, i) => chip(true, i))}
        {Array.from({ length: c.atkNormals }, (_, i) => chip(false, i))}
        {c.atkCrits + c.atkNormals === 0 && <span class="dim">No successful attack dice.</span>}
      </div>
      <p class="entry-meta" style={{ marginTop: '0.6rem' }}>
        {c.defCrits} critical + {c.defNormals} normal defence dice
        {c.brutal ? ' · Brutal: normal successes cannot block' : ''} · {left} unspent
      </p>
    </div>
  );
}

export function allocatePlan(
  answer: (optionId: string, data?: Record<string, unknown>) => void,
  decision: PendingDecision,
  step: string,
): CommandPlan {
  const c = allocCtxOf(decision);
  const auto = (decision.options.find((o) => o.id === 'auto')?.data ?? {}) as Record<string, unknown>;
  const autoUnblockedCrits = num(auto['unblockedCrits'], c.atkCrits);
  const autoUnblockedNormals = num(auto['unblockedNormals'], c.atkNormals);
  const autoDamage = autoUnblockedCrits * c.dmgC + autoUnblockedNormals * c.dmgN;

  return {
    id: 'decision.allocateDefence',
    step,
    title: 'Allocate your defence dice',
    frame: null,
    modal: true,
    detent: 'half',
    turnOf: decision.who,
    actions: [],
    body: <AllocatorBody c={c} decision={decision} answer={answer} autoDamage={autoDamage} />,
  };
}

/**
 * A component rather than inline JSX because the tapped-so-far allocation is real UI state
 * and has to survive re-renders of the plan.
 */
function AllocatorBody({
  c,
  decision,
  answer,
  autoDamage,
}: {
  c: AllocCtx;
  decision: PendingDecision;
  answer: (optionId: string, data?: Record<string, unknown>) => void;
  autoDamage: number;
}) {
  // Seeded with the engine's own optimal allocation, so the default tap is the safe one and
  // manual is a change FROM it rather than a blank slate you have to rebuild.
  const alloc = (decision.ctx?.['alloc'] ?? {}) as Record<string, unknown>;
  const [blocked, setBlocked] = useState({
    crits: c.atkCrits - num(alloc['unblockedCrits'], c.atkCrits),
    normals: c.atkNormals - num(alloc['unblockedNormals'], c.atkNormals),
  });

  const unblockedCrits = c.atkCrits - blocked.crits;
  const unblockedNormals = c.atkNormals - blocked.normals;
  const damage = unblockedCrits * c.dmgC + unblockedNormals * c.dmgN;
  const worse = damage > autoDamage;

  return (
    <>
      <Allocator c={c} blocked={blocked} onChange={setBlocked} />
      <div class={`armed-banner${worse ? ' is-blocked' : ''}`}>
        {worse ? <IconAlert size={18} /> : <IconCheck size={18} />}
        <span>
          {damage} damage
          {worse ? ` — auto-allocating would take ${autoDamage}` : ' — the best you can do'}
        </span>
      </div>
      <div class="actions">
        <button
          class="primary"
          onClick={() => answer('manual', { unblockedCrits, unblockedNormals })}
        >
          <span class="entry-name">Take {damage} damage</span>
        </button>
        {worse && (
          <button onClick={() => answer('auto')}>
            <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
              <span class="entry-name">Auto-allocate instead</span>
              <span class="entry-meta">Blocks as much as the rules allow — {autoDamage} damage</span>
            </span>
          </button>
        )}
      </div>
      {decision.sourceText && <p class="rule-text printed">{decision.sourceText}</p>}
    </>
  );
}
