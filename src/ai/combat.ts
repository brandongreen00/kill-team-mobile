/**
 * Expected-damage maths for the AI.
 *
 * This module deliberately REUSES the engine's own primitives (`classify`,
 * `allocateSavesOptimally`, `piercingValue`, `devastatingDamage`, `checkTarget`) rather than
 * re-deriving the rules, so the AI's estimate can never drift from what the sequence will
 * actually roll. Only two things are approximated, both documented in docs/AI.md:
 *   - re-rolls (Balanced / Ceaseless / Relentless) are folded into the per-die probabilities;
 *   - retention (Severe / Rending / Punishing) applies the single option the default
 *     decision policy would pick, matching `defaultDecisionOption`.
 */
import {
  accurateValue,
  allocateSavesOptimally,
  classify,
  devastatingDamage,
  hasRule,
  lethalThreshold,
  piercingValue,
  ruleOf,
} from '../core/dice.ts';
import type { GameContext } from '../core/context.ts';
import { assistCount } from '../core/sequences/fight.ts';
import { checkTarget, effectiveRules, type TargetCheck } from '../core/sequences/shoot.ts';
import { aliveOperatives, card, hitOf, saveOf, startingWounds, weaponsOf } from '../core/state.ts';
import type { GameState, OperativeState, Vec2, WeaponProfile, WeaponRule } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';

export interface ShotEstimate {
  /** Expected raw damage. */
  expected: number;
  /** Expected damage that actually lands on the target: E[min(damage, wounds left)]. */
  effective: number;
  killProb: number;
}

export const ZERO_SHOT: ShotEstimate = { expected: 0, effective: 0, killProb: 0 };

interface Probs {
  crit: number;
  normal: number;
  fail: number;
}

/** Per-die outcome probabilities, read straight off the engine's `classify`. */
export function dieProbs(hit: number, lethal?: number): Probs {
  let c = 0;
  let n = 0;
  let f = 0;
  for (let v = 1; v <= 6; v++) {
    const s = classify(v, hit, lethal !== undefined ? { lethal } : {});
    if (s === 'crit') c++;
    else if (s === 'normal') n++;
    else f++;
  }
  return { crit: c / 6, normal: n / 6, fail: f / 6 };
}

/** Fold a re-roll grant into the per-die probabilities: `fraction` of the fail mass is re-rolled once. */
function withReroll(p: Probs, fraction: number): Probs {
  if (fraction <= 0) return p;
  const moved = p.fail * Math.min(1, fraction);
  return {
    crit: p.crit + moved * p.crit,
    normal: p.normal + moved * p.normal,
    fail: p.fail - moved * (p.crit + p.normal),
  };
}

/**
 * How much of a pool's fail mass the available re-rolls recover.
 * Relentless re-rolls anything; Ceaseless re-rolls one value (~60% of the fails in practice);
 * Balanced re-rolls a single die.
 */
function rerollFraction(rules: WeaponRule[], dice: number): number {
  if (hasRule(rules, 'Relentless')) return 1;
  if (hasRule(rules, 'Ceaseless')) return 0.6;
  if (hasRule(rules, 'Balanced')) return dice > 0 ? 1 / dice : 0;
  return 0;
}

type Dist = number[][]; // dist[crits][normals] = probability

function addTo(d: Dist, c: number, n: number, p: number): void {
  const row = (d[c] ??= []);
  row[n] = (row[n] ?? 0) + p;
}

function poolDist(k: number, p: Probs): Dist {
  let d: Dist = [[1]];
  for (let i = 0; i < k; i++) {
    const nd: Dist = [];
    for (let c = 0; c < d.length; c++) {
      const row = d[c];
      if (!row) continue;
      for (let n = 0; n < row.length; n++) {
        const pr = row[n];
        if (!pr) continue;
        addTo(nd, c + 1, n, pr * p.crit);
        addTo(nd, c, n + 1, pr * p.normal);
        addTo(nd, c, n, pr * p.fail);
      }
    }
    d = nd;
  }
  return d;
}

function eachOutcome(d: Dist, fn: (c: number, n: number, p: number) => void): void {
  for (let c = 0; c < d.length; c++) {
    const row = d[c];
    if (!row) continue;
    for (let n = 0; n < row.length; n++) {
      const p = row[n];
      if (p && p > 1e-12) fn(c, n, p);
    }
  }
}

/**
 * Retention: the engine offers every applicable option at once but only ONE is applied
 * (`applyRetentionDecision`), and `defaultDecisionOption` prefers severe → rending → punishing.
 */
function applyRetention(c: number, n: number, fails: number, rules: WeaponRule[], obscured: boolean): [number, number] {
  const critsAllowed = !obscured;
  if (critsAllowed && hasRule(rules, 'Severe') && c === 0 && n > 0) return [1, n - 1];
  if (critsAllowed && hasRule(rules, 'Rending') && c > 0 && n > 0) return [c + 1, n - 1];
  if (hasRule(rules, 'Punishing') && c > 0 && fails > 0) return [c, n + 1];
  return [c, n];
}

/** Obscured: discard one success (a normal first), then every crit becomes a normal. */
function applyObscured(c: number, n: number): [number, number] {
  if (n > 0) return [0, c + n - 1];
  if (c > 0) return [0, c - 1];
  return [0, 0];
}

export interface ShootParams {
  attacker: OperativeState;
  target: OperativeState;
  profile: WeaponProfile;
  rules: WeaponRule[];
  check: Pick<TargetCheck, 'inCover' | 'obscured' | 'vantageAccurate' | 'vantageImprovedCover'>;
  pointBlank?: boolean;
}

/** Expected damage of one Shoot action, computed over the exact dice distribution. */
export function shootEstimate(ctx: GameContext, state: GameState, params: ShootParams): ShotEstimate {
  const { attacker, target, profile, rules, check } = params;
  const hit = hitOf(ctx, state, attacker, profile, params.pointBlank ? -1 : 0);
  const accurate = accurateValue(rules) + (target.order === 'engage' ? check.vantageAccurate : 0);
  const toRoll = Math.max(0, profile.atk - accurate);
  const lethal = lethalThreshold(rules);
  const atkP = withReroll(dieProbs(hit, lethal), rerollFraction(rules, toRoll));
  const atkDist = poolDist(toRoll, atkP);

  const save = saveOf(ctx, state, target);
  const defP = dieProbs(save);
  const brutal = hasRule(rules, 'Brutal');
  const saturate = hasRule(rules, 'Saturate');
  const wounds = Math.max(1, target.wounds);

  // Cache defence distributions by dice count — piercing changes it, nothing else does.
  const defCache = new Map<number, Dist>();
  const defDistFor = (k: number): Dist => {
    let d = defCache.get(k);
    if (!d) {
      d = poolDist(k, defP);
      defCache.set(k, d);
    }
    return d;
  };

  let expected = 0;
  let effective = 0;
  let killProb = 0;

  eachOutcome(atkDist, (c0, n0, pAtk) => {
    const fails = toRoll - c0 - n0;
    let [c1, n1] = applyRetention(c0, n0 + accurate, fails, rules, check.obscured);
    if (check.obscured) [c1, n1] = applyObscured(c1, n1);

    const retainedCrits = c1;
    const piercing = piercingValue(rules, retainedCrits);
    let count = Math.max(0, 3 - piercing);
    let coverSaves = 0;
    if (check.inCover && !saturate && count > 0) {
      coverSaves = Math.min(count, 1 + (check.vantageImprovedCover ? 1 : 0));
      count -= coverSaves;
    }
    const dev = devastatingDamage(rules, retainedCrits);
    const devDamage = dev.perCrit * retainedCrits;

    eachOutcome(defDistFor(count), (dc, dn, pDef) => {
      const alloc = allocateSavesOptimally(c1, n1, dc, dn + coverSaves, profile.dmgN, profile.dmgC, brutal);
      const damage = alloc.damage + devDamage;
      const p = pAtk * pDef;
      expected += p * damage;
      effective += p * Math.min(damage, wounds);
      if (damage >= wounds) killProb += p;
    });
  });

  return { expected, effective, killProb };
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

export interface FightEstimate {
  /** Expected damage dealt to the enemy operative. */
  dealt: number;
  /** Expected damage taken from the retaliation. */
  taken: number;
  killProb: number;
  deathProb: number;
}

export const ZERO_FIGHT: FightEstimate = { dealt: 0, taken: 0, killProb: 0, deathProb: 0 };

/**
 * Expected outcome of a Fight, under the "always strike, best die first" policy the AI and
 * the default decision policy both use. The engine alternates resolution starting with the
 * attacker and stops as soon as one operative is incapacitated.
 */
export function fightEstimate(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  attackerProfile: WeaponProfile,
): FightEstimate {
  const aRules = effectiveRules(ctx, state, attackerProfile);
  const aAssists = assistCount(ctx, state, attacker, defender);
  const aHit = hitOf(ctx, state, attacker, attackerProfile, aAssists);
  const aAcc = accurateValue(aRules);
  const aRoll = Math.max(0, attackerProfile.atk - aAcc);
  const aDist = poolDist(aRoll, withReroll(dieProbs(aHit, lethalThreshold(aRules)), rerollFraction(aRules, aRoll)));

  const dWeapon = weaponsOf(ctx, state, defender, 'melee')[0];
  const dProfile = dWeapon?.profiles.find((p) => p.type === 'melee');
  const canRetaliate =
    Boolean(dProfile) && !state.effects.some((e) => e.rule === 'cannotRetaliate' && e.operativeId === defender.id);
  let dDist: Dist = [[1]];
  let dAcc = 0;
  let dProf: WeaponProfile = { type: 'melee', atk: 0, hit: 6, dmgN: 0, dmgC: 0, rules: [] };
  if (canRetaliate && dProfile) {
    dProf = dProfile;
    const dRules = effectiveRules(ctx, state, dProfile);
    const dAssists = assistCount(ctx, state, defender, attacker);
    const dHit = hitOf(ctx, state, defender, dProfile, dAssists);
    dAcc = accurateValue(dRules);
    const dRoll = Math.max(0, dProfile.atk - dAcc);
    dDist = poolDist(dRoll, withReroll(dieProbs(dHit, lethalThreshold(dRules)), rerollFraction(dRules, dRoll)));
  }
  const dRules = canRetaliate && dProfile ? effectiveRules(ctx, state, dProfile) : [];

  const aDev = devastatingDamage(aRules, 1).perCrit;
  const dDev = devastatingDamage(dRules, 1).perCrit;
  const aWounds = Math.max(1, attacker.wounds);
  const dWounds = Math.max(1, defender.wounds);

  let dealt = 0;
  let taken = 0;
  let killProb = 0;
  let deathProb = 0;

  eachOutcome(aDist, (ac, an0, pA) => {
    const an = an0 + aAcc;
    eachOutcome(dDist, (dc, dn0, pD) => {
      const dn = dn0 + dAcc;
      const p = pA * pD;
      let aCrit = ac;
      let aNorm = an;
      let dCrit = dc;
      let dNorm = dn;
      let hpDef = dWounds;
      let hpAtk = aWounds;
      let turn: 'a' | 'd' = 'a';
      let guard = 0;
      while (guard++ < 40 && hpDef > 0 && hpAtk > 0) {
        const mineCrit = turn === 'a' ? aCrit : dCrit;
        const mineNorm = turn === 'a' ? aNorm : dNorm;
        if (mineCrit + mineNorm === 0) {
          const otherLeft = turn === 'a' ? dCrit + dNorm : aCrit + aNorm;
          if (otherLeft === 0) break;
          turn = turn === 'a' ? 'd' : 'a';
          continue;
        }
        const crit = mineCrit > 0;
        const profile = turn === 'a' ? attackerProfile : dProf;
        const dmg = (crit ? profile.dmgC : profile.dmgN) + (crit ? (turn === 'a' ? aDev : dDev) : 0);
        if (turn === 'a') {
          if (crit) aCrit--;
          else aNorm--;
          hpDef -= dmg;
        } else {
          if (crit) dCrit--;
          else dNorm--;
          hpAtk -= dmg;
        }
        // "one player has resolved all their dice (in which case their opponent resolves all
        // their remaining dice)" — otherwise alternate.
        const otherLeft = turn === 'a' ? dCrit + dNorm : aCrit + aNorm;
        if (otherLeft > 0) turn = turn === 'a' ? 'd' : 'a';
      }
      dealt += p * Math.min(dWounds, dWounds - Math.max(0, hpDef));
      taken += p * Math.min(aWounds, aWounds - Math.max(0, hpAtk));
      if (hpDef <= 0) killProb += p;
      if (hpAtk <= 0) deathProb += p;
    });
  });

  return { dealt, taken, killProb, deathProb };
}

// ---------------------------------------------------------------------------
// Convenience: best shot / best fight from a (possibly hypothetical) position
// ---------------------------------------------------------------------------

export interface ShotPlan {
  weaponName: string;
  profileName?: string;
  targetId: string;
  estimate: ShotEstimate;
  check: TargetCheck;
}

/** Every legal shot this operative could take, best first. `at` allows hypothetical positions. */
export function shotPlans(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  at?: { pos: Vec2; z: number; order?: OperativeState['order'] },
): ShotPlan[] {
  const shooter: OperativeState = at ? { ...op, pos: at.pos, z: at.z, order: at.order ?? op.order } : op;
  if (shooter.order === 'conceal') {
    // Only Silent weapons may be used with a Conceal order.
    const silent = weaponsOf(ctx, state, shooter, 'ranged').some((w) =>
      w.profiles.some((p) => p.rules.some((r) => r.id === 'Silent')),
    );
    if (!silent) return [];
  }
  const enemies = aliveOperatives(state, otherPlayer(op.player));
  const out: ShotPlan[] = [];
  for (const w of weaponsOf(ctx, state, shooter, 'ranged')) {
    for (const profile of w.profiles) {
      if (profile.type !== 'ranged') continue;
      if (shooter.order === 'conceal' && !profile.rules.some((r) => r.id === 'Silent')) continue;
      const rules = effectiveRules(ctx, state, profile);
      for (const target of enemies) {
        const check = checkTarget(ctx, state, shooter, target, profile, rules);
        if (!check.valid) continue;
        const estimate = shootEstimate(ctx, state, {
          attacker: shooter,
          target,
          profile,
          rules,
          check,
        });
        out.push({
          weaponName: w.name,
          ...(profile.name ? { profileName: profile.name } : {}),
          targetId: target.id,
          estimate,
          check,
        });
      }
    }
  }
  out.sort((a, b) => shotValue(b) - shotValue(a));
  return out;
}

/** Damage that lands, with a premium for finishing an operative off. */
export const shotValue = (p: ShotPlan): number => p.estimate.effective + p.estimate.killProb * 4;

export interface FightPlan {
  weaponName: string;
  profileName?: string;
  targetId: string;
  estimate: FightEstimate;
}

export function fightPlans(ctx: GameContext, state: GameState, op: OperativeState, targets: OperativeState[]): FightPlan[] {
  const out: FightPlan[] = [];
  for (const w of weaponsOf(ctx, state, op, 'melee')) {
    for (const profile of w.profiles) {
      if (profile.type !== 'melee') continue;
      for (const target of targets) {
        out.push({
          weaponName: w.name,
          ...(profile.name ? { profileName: profile.name } : {}),
          targetId: target.id,
          estimate: fightEstimate(ctx, state, op, target, profile),
        });
      }
    }
  }
  out.sort((a, b) => fightValue(b) - fightValue(a));
  return out;
}

export const fightValue = (p: FightPlan): number =>
  p.estimate.dealt + p.estimate.killProb * 5 - p.estimate.taken * 0.9 - p.estimate.deathProb * 5;

const VALUE_CACHE = new Map<string, number>();

/** Datacard ids repeat across battles with different stats — see src/ai/caches.ts. */
export function clearValueCache(): void {
  VALUE_CACHE.clear();
}

/** Rough worth of an operative, used to weight kills and losses. Datacards carry no points. */
export function operativeValue(ctx: GameContext, op: OperativeState): number {
  const cached = VALUE_CACHE.get(op.datacardId);
  if (cached !== undefined) return cached;
  const c = card(ctx, op);
  let value = c.wounds * 0.6 + c.apl * 2 + c.move * 0.15 + (7 - c.save) * 1.2;
  for (const w of c.weapons) {
    for (const p of w.profiles) {
      value += (p.atk * (p.dmgN + p.dmgC)) / 12;
    }
  }
  if (VALUE_CACHE.size > 512) VALUE_CACHE.clear();
  VALUE_CACHE.set(op.datacardId, value);
  return value;
}

/** Fraction of starting wounds remaining, 0..1. */
export function healthFraction(ctx: GameContext, op: OperativeState): number {
  const max = Math.max(1, startingWounds(ctx, op));
  return Math.max(0, Math.min(1, op.wounds / max));
}

/** Does this weapon profile actually threaten anything at range? Used for role inference. */
export function profileRange(profile: WeaponProfile): number {
  const r = ruleOf(profile.rules, 'Range');
  return r?.x ?? Infinity;
}
