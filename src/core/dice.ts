/**
 * Attack / defence dice mechanics and the universal weapon rules.
 *
 * Individual dice keep their identity (`Die.id`) all the way through the sequence so the
 * UI can animate the exact dice that were re-rolled, discarded or promoted.
 */
import type { WeaponRule, WeaponRuleId } from './types.ts';

export type DieState = 'crit' | 'normal' | 'fail' | 'discarded' | 'blocked' | 'struck';

export interface Die {
  id: number;
  /** 0 for an auto-retained die (Accurate x) that was never rolled. */
  value: number;
  state: DieState;
  rolled: boolean;
  rerolledFrom?: number;
  /**
   * What this die was retained as before the defender blocked it. A blocked die keeps no
   * trace of that in `state`, and Devastating x fires on RETAINED critical successes — so
   * without this a blocked NORMAL success read as a retained crit.
   */
  blockedFrom?: 'crit' | 'normal';
  /** Which rule produced or changed this die, for the log. */
  note?: string;
}

export interface DicePool {
  dice: Die[];
  nextId: number;
}

export const newPool = (): DicePool => ({ dice: [], nextId: 1 });

export function addRolled(pool: DicePool, values: number[], hit: number, opts: ClassifyOpts = {}): Die[] {
  const added: Die[] = [];
  for (const v of values) {
    const d: Die = { id: pool.nextId++, value: v, state: classify(v, hit, opts), rolled: true };
    pool.dice.push(d);
    added.push(d);
  }
  return added;
}

export function addAutoNormal(pool: DicePool, count: number, note = 'Accurate'): Die[] {
  const added: Die[] = [];
  for (let i = 0; i < count; i++) {
    const d: Die = { id: pool.nextId++, value: 0, state: 'normal', rolled: false, note };
    pool.dice.push(d);
    added.push(d);
  }
  return added;
}

export interface ClassifyOpts {
  /** Lethal x+: successes >= x are critical successes. */
  lethal?: number;
  /** Rare rules that move the critical threshold; 6 always crits regardless. */
  critOn?: number;
}

/**
 * "Each result that equals or beats the Hit stat is a success and is retained... Each result
 * of 6 is always a critical success. Each other success is a normal success. Each result of 1
 * is always a fail."
 */
export function classify(value: number, hit: number, opts: ClassifyOpts = {}): DieState {
  if (value === 1) return 'fail';
  if (value === 6) return 'crit';
  const critOn = Math.min(opts.critOn ?? 6, opts.lethal ?? 6);
  if (value >= critOn) return 'crit';
  if (value >= hit) return 'normal';
  return 'fail';
}

export const crits = (pool: DicePool): Die[] => pool.dice.filter((d) => d.state === 'crit');
export const normals = (pool: DicePool): Die[] => pool.dice.filter((d) => d.state === 'normal');
export const fails = (pool: DicePool): Die[] => pool.dice.filter((d) => d.state === 'fail');
export const successes = (pool: DicePool): Die[] => pool.dice.filter((d) => d.state === 'crit' || d.state === 'normal');
export const countCrits = (pool: DicePool): number => crits(pool).length;
export const countNormals = (pool: DicePool): number => normals(pool).length;

// ---------------------------------------------------------------------------
// Weapon rules
// ---------------------------------------------------------------------------

export function ruleOf(rules: WeaponRule[], id: WeaponRuleId): WeaponRule | undefined {
  const matching = rules.filter((r) => r.id === id);
  if (matching.length === 0) return undefined;
  // "Weapons gain no benefit from having the same weapon rule more than once, unless the
  // weapon rule has an x, in which case select which x to use." Default: the best (largest).
  // Accurate is special-cased by `accurateValue`.
  return matching.reduce((best, r) => ((r.x ?? 0) > (best.x ?? 0) ? r : best));
}

export const hasRule = (rules: WeaponRule[], id: WeaponRuleId): boolean => rules.some((r) => r.id === id);

/**
 * "If a weapon has more than one instance of Accurate x, you can treat it as one instance
 * of Accurate 2 instead (this takes precedence over x rules)."
 */
export function accurateValue(rules: WeaponRule[]): number {
  const all = rules.filter((r) => r.id === 'Accurate');
  if (all.length === 0) return 0;
  if (all.length === 1) return all[0]!.x ?? 1;
  return Math.max(2, ...all.map((r) => r.x ?? 1));
}

/** Piercing x / Piercing Crits x: how many defence dice the defender loses. */
export function piercingValue(rules: WeaponRule[], retainedCrits: number): number {
  let p = 0;
  const flat = ruleOf(rules, 'Piercing');
  if (flat) p = Math.max(p, flat.x ?? 1);
  if (retainedCrits > 0) {
    const pc = ruleOf(rules, 'PiercingCrits');
    if (pc) p = Math.max(p, pc.x ?? 1);
  }
  return p;
}

/** Lethal x+ threshold, or undefined. */
export function lethalThreshold(rules: WeaponRule[]): number | undefined {
  const r = ruleOf(rules, 'Lethal');
  return r?.x;
}

/**
 * The classification a weapon's dice are graded with. Both the first roll and every re-roll
 * must use it: "your successes equal to or greater than x are critical successes" does not
 * stop applying because the dice was re-rolled.
 */
export function lethalOpts(rules: WeaponRule[]): ClassifyOpts {
  const l = lethalThreshold(rules);
  return l !== undefined ? { lethal: l } : {};
}

/** Retention transforms the player may choose to apply, in an order of their choice. */
export interface RetentionOption {
  id: 'severe' | 'rending' | 'punishing';
  label: string;
  sourceText: string;
}

/**
 * Which retention rules currently apply to a pool.
 * Severe: "If you don't retain any critical successes, you can change one of your normal
 *   successes to a critical success."
 * Rending: "If you retain any critical successes, you can retain one of your normal
 *   successes as a Critical success instead."
 * Punishing: "If you retain any critical successes, you can retain one of your fails as a
 *   normal success instead of discarding it."
 */
export function retentionOptions(pool: DicePool, rules: WeaponRule[], obscured: boolean): RetentionOption[] {
  const out: RetentionOption[] = [];
  const c = countCrits(pool);
  const n = countNormals(pool);
  const f = fails(pool).length;
  // Obscured: "All the attacker's critical successes are retained as normal successes and
  // cannot be changed to critical successes (this takes precedence over all other rules)."
  const critsAllowed = !obscured;
  if (hasRule(rules, 'Severe') && c === 0 && n > 0 && critsAllowed) {
    out.push({
      id: 'severe',
      label: 'Severe: change a normal success to a critical success',
      sourceText:
        "Severe: If you don't retain any critical successes, you can change one of your normal successes to a critical success.",
    });
  }
  if (hasRule(rules, 'Rending') && c > 0 && n > 0 && critsAllowed) {
    out.push({
      id: 'rending',
      label: 'Rending: retain a normal success as a critical success',
      sourceText:
        'Rending: If you retain any critical successes, you can retain one of your normal successes as a Critical success instead.',
    });
  }
  // Punishing keys off retained CRITICAL successes, and obscured leaves the attacker with
  // none: "All the attacker's critical successes are retained as normal successes and cannot
  // be changed to critical successes (this takes precedence over all other rules)." Severe and
  // Rending were already guarded; Punishing was not, so it was offered — and taken — on a shot
  // that could not have a critical success to trigger it.
  if (hasRule(rules, 'Punishing') && critsAllowed && c > 0 && f > 0) {
    out.push({
      id: 'punishing',
      label: 'Punishing: retain a fail as a normal success',
      sourceText:
        'Punishing: If you retain any critical successes, you can retain one of your fails as a normal success instead of discarding it.',
    });
  }
  return out;
}

export function applyRetention(pool: DicePool, option: RetentionOption['id'], dieId?: number): boolean {
  const pick = (state: DieState): Die | undefined =>
    dieId !== undefined
      ? pool.dice.find((d) => d.id === dieId && d.state === state)
      : pool.dice.filter((d) => d.state === state).sort((a, b) => a.value - b.value)[0];
  if (option === 'severe' || option === 'rending') {
    const d = pick('normal');
    if (!d) return false;
    d.state = 'crit';
    d.note = option === 'severe' ? 'Severe' : 'Rending';
    return true;
  }
  const d = pick('fail');
  if (!d) return false;
  d.state = 'normal';
  d.note = 'Punishing';
  return true;
}

/**
 * Obscured: "The attacker must discard one success of their choice instead of retaining it.
 * All the attacker's critical successes are retained as normal successes."
 */
export function applyObscured(pool: DicePool, discardDieId?: number): void {
  const succ = successes(pool);
  if (succ.length > 0) {
    const target =
      (discardDieId !== undefined ? succ.find((d) => d.id === discardDieId) : undefined) ??
      // Default choice: discard the least valuable success (a normal if any).
      succ.find((d) => d.state === 'normal') ??
      succ[0]!;
    target.state = 'discarded';
    target.note = 'obscured: discarded';
  }
  for (const d of pool.dice) {
    if (d.state === 'crit') {
      d.state = 'normal';
      d.note = 'obscured: crit -> normal';
    }
  }
}

// ---------------------------------------------------------------------------
// Defence allocation
// ---------------------------------------------------------------------------

export interface Allocation {
  /** Defender crits used to block attacker crits. */
  critBlocksCrit: number;
  /** Defender crits used to block attacker normals. */
  critBlocksNormal: number;
  /** Pairs of defender normals used to block attacker crits. */
  normalPairBlocksCrit: number;
  /** Defender normals used to block attacker normals. */
  normalBlocksNormal: number;
  damage: number;
  unblockedCrits: number;
  unblockedNormals: number;
}

/**
 * Optimal defence allocation.
 * "A normal success can block a normal success. Two normal successes can block a critical
 * success. A critical success can block a normal success or a critical success."
 * Brutal: "Your opponent can only block with critical successes."
 */
export function allocateSavesOptimally(
  atkCrits: number,
  atkNormals: number,
  defCrits: number,
  defNormals: number,
  dmgN: number,
  dmgC: number,
  brutal = false,
): Allocation {
  const usableNormals = brutal ? 0 : defNormals;
  let best: Allocation | null = null;
  for (let cc = 0; cc <= Math.min(defCrits, atkCrits); cc++) {
    const critsLeft = defCrits - cc;
    for (let np = 0; np <= Math.min(Math.floor(usableNormals / 2), atkCrits - cc); np++) {
      const normalsLeft = usableNormals - np * 2;
      const remainingAtkNormals = atkNormals;
      const cn = Math.min(critsLeft, remainingAtkNormals);
      const nn = Math.min(normalsLeft, remainingAtkNormals - cn);
      const unblockedCrits = atkCrits - cc - np;
      const unblockedNormals = remainingAtkNormals - cn - nn;
      const damage = unblockedCrits * dmgC + unblockedNormals * dmgN;
      const cand: Allocation = {
        critBlocksCrit: cc,
        critBlocksNormal: cn,
        normalPairBlocksCrit: np,
        normalBlocksNormal: nn,
        damage,
        unblockedCrits,
        unblockedNormals,
      };
      if (!best || cand.damage < best.damage) best = cand;
    }
  }
  return (
    best ?? {
      critBlocksCrit: 0,
      critBlocksNormal: 0,
      normalPairBlocksCrit: 0,
      normalBlocksNormal: 0,
      damage: atkCrits * dmgC + atkNormals * dmgN,
      unblockedCrits: atkCrits,
      unblockedNormals: atkNormals,
    }
  );
}

/** Damage from unblocked attack dice. */
export function damageFrom(unblockedCrits: number, unblockedNormals: number, dmgN: number, dmgC: number): number {
  return unblockedCrits * dmgC + unblockedNormals * dmgN;
}

/**
 * Devastating x: each retained critical success immediately inflicts x damage.
 * "x" Devastating x" additionally hits every operative visible to and within that distance.
 * "Note that success isn't discarded after doing so — it can still be resolved later."
 */
export function devastatingDamage(rules: WeaponRule[], retainedCrits: number): { perCrit: number; radius?: number } {
  const r = ruleOf(rules, 'Devastating');
  if (!r || retainedCrits === 0) return { perCrit: 0 };
  return { perCrit: r.x ?? 0, ...(r.dist !== undefined ? { radius: r.dist } : {}) };
}

/** Re-roll a die in place, keeping identity so the UI can animate just that die. */
export function rerollDie(die: Die, newValue: number, hit: number, opts: ClassifyOpts = {}): void {
  die.rerolledFrom = die.value;
  die.value = newValue;
  die.state = classify(newValue, hit, opts);
  die.rolled = true;
}
