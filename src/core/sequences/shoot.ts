/**
 * The Shoot action sequence (core rules › Shoot 1AP), as a resumable state machine.
 *
 * 1. Select Weapon · 2. Select Valid Target · 3. Roll Attack Dice · 4. Roll Defence Dice
 * 5. Resolve Defence Dice · 6. Resolve Attack Dice
 *
 * Every player choice becomes a PendingDecision so the UI can show dice above the operatives
 * and offer rerolls interactively, and so the AI answers through the same channel.
 */
import {
  accurateValue,
  addAutoNormal,
  addRolled,
  allocateSavesOptimally,
  applyObscured,
  applyRetention,
  classify,
  countCrits,
  countNormals,
  devastatingDamage,
  hasRule,
  lethalThreshold,
  newPool,
  piercingValue,
  rerollDie,
  retentionOptions,
  ruleOf,
  successes,
  type Die,
  type DicePool,
} from '../dice.ts';
import { zeroStatMods, type AttackContext, type RerollGrant } from '../hooks.ts';
import { terrain, type GameContext } from '../context.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card,
  findProfile,
  gapBetween,
  hitOf,
  inControlRange,
  inflictDamage,
  isInjured,
  log,
  recordRoll,
  saveOf,
  weaponsOf,
} from '../state.ts';
import {
  coverAndObscured,
  isVisible,
  smokeObscures,
  vantageAccurate,
  vantageIgnoreFilter,
  whollyWithinSmoke,
  type SmokeArea,
} from '../visibility.ts';
import { condensedEnvironmentRules } from '../weaponRules.ts';
import type { GameState, OperativeState, PendingDecision, PlayerId, WeaponProfile, WeaponRule } from '../types.ts';
import { otherPlayer } from '../types.ts';
import type { ShootSequence } from './types.ts';

export const COMMAND_REROLL: Omit<RerollGrant, 'player'> = {
  id: 'commandReroll',
  label: 'Command Re-roll (1CP): re-roll one of those dice',
  mode: 'one',
  max: 1,
  cp: 1,
  sourceText: 'COMMAND RE-ROLL 1CP: Use this firefight ploy after rolling your attack or defence dice. You can re-roll one of those dice.',
};

// ---------------------------------------------------------------------------
// Target validity
// ---------------------------------------------------------------------------

export interface TargetCheck {
  valid: boolean;
  reason?: string;
  inCover: boolean;
  obscured: boolean;
  mustChoose: boolean;
  vantageAccurate: number;
  vantageImprovedCover: boolean;
  distance: number;
}

export function smokeAreas(state: GameState): SmokeArea[] {
  return Object.values(state.markers)
    .filter((m) => m.kind === 'smoke')
    .map((m) => ({ markerId: m.id, centre: m.pos, z0: m.z, radius: 1 }));
}

/**
 * Core rules › Select Valid Target: "an enemy operative that's a valid target and has no
 * friendly operatives within its control range. If the intended target has an Engage order,
 * it's a valid target if it's visible... If Conceal, visible and not in cover."
 */
export function checkTarget(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  profile: WeaponProfile,
  rules: WeaponRule[],
  opts: { pointBlank?: boolean; secondary?: boolean } = {},
): TargetCheck {
  const index = terrain(ctx, state);
  const a = body(ctx, attacker);
  const t = body(ctx, target);
  const distance = gapBetween(ctx, attacker, target);
  const base: TargetCheck = {
    valid: false,
    inCover: false,
    obscured: false,
    mustChoose: false,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    distance,
  };

  const range = ruleOf(rules, 'Range');
  if (range && distance > (range.x ?? 0) + 1e-6) return { ...base, reason: `out of Range ${range.x}"` };

  // "has no friendly operatives within its control range" — friendly to the ATTACKER.
  const friendlyBlock = aliveOperatives(state, attacker.player).some(
    (f) => f.id !== attacker.id && inControlRange(ctx, state, f, target),
  );
  if (friendlyBlock && !opts.pointBlank)
    return { ...base, reason: 'a friendly operative is within the target’s control range' };

  const vis = isVisible(index, a, t);
  if (!vis.visible && !opts.pointBlank)
    return { ...base, reason: `not visible${vis.blockedBy ? ` (${vis.blockedBy.types.join('+')} terrain)` : ''}` };

  const vAcc = target.order === 'engage' ? vantageAccurate(index, a, t) : 0;
  const vantageDeniesLight = a.z - t.z >= 2 - 1e-6 && target.order === 'conceal' && vantageAccurate(index, a, t) > 0;

  const seekAll = hasRule(rules, 'Seek');
  const seekLight = hasRule(rules, 'SeekLight');
  const hookEv = ctx.hooks.emit('onValidTarget', state, {
    state,
    attacker,
    target,
    valid: true,
    ignoreCoverTerrain: seekAll ? 'all' : seekLight ? 'light' : 'none',
    forceVisible: false,
  });

  const cover = coverAndObscured(index, a, t, {
    ignoreCoverTerrain: hookEv.ignoreCoverTerrain,
    vantageDeniesLightCover: vantageDeniesLight,
    ignore: vantageIgnoreFilter(index, a, t),
  });

  // Smoke grenades create a dynamic obscuring area.
  const smoke = smokeAreas(state);
  const smokeObscure = smokeObscures(a, t, smoke);

  const result: TargetCheck = {
    valid: true,
    inCover: cover.inCover,
    obscured: cover.obscured || smokeObscure,
    mustChoose: cover.mustChoose,
    vantageAccurate: vAcc,
    vantageImprovedCover: vantageDeniesLight && cover.inCover,
    distance,
  };

  if (!hookEv.valid) return { ...result, valid: false, reason: hookEv.reason ?? 'not a valid target' };

  // Conceal: valid only if visible AND not in cover.
  if (target.order === 'conceal' && result.inCover && !opts.pointBlank)
    return { ...result, valid: false, reason: 'target has a Conceal order and is in cover' };

  // Shoot while engaged is illegal unless this is a point-blank shot (On Guard).
  if (!opts.pointBlank) {
    const engaged = aliveOperatives(state, otherPlayer(attacker.player)).some((e) =>
      inControlRange(ctx, state, attacker, e),
    );
    if (engaged) return { ...result, valid: false, reason: 'cannot Shoot while within control range of an enemy' };
  }

  return result;
}

export function validTargets(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  weaponName: string,
  profileName?: string,
): { target: OperativeState; check: TargetCheck }[] {
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === weaponName);
  if (!w) return [];
  const profile = findProfile(w, profileName);
  if (!profile) return [];
  const rules = effectiveRules(ctx, state, profile);
  return aliveOperatives(state, otherPlayer(attacker.player))
    .map((target) => ({ target, check: checkTarget(ctx, state, attacker, target, profile, rules) }))
    .filter((r) => r.check.valid);
}

/** Weapon rules after killzone/hook modifications (Condensed Environment, granted rules). */
export function effectiveRules(ctx: GameContext, state: GameState, profile: WeaponProfile): WeaponRule[] {
  let rules = [...profile.rules];
  if (state.map.closeQuarters) rules = condensedEnvironmentRules(rules);
  return rules;
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

export function startShoot(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  weaponName: string,
  profileName: string | undefined,
  targetId: string,
  opts: { pointBlank?: boolean; free?: boolean } = {},
): { ok: boolean; reason?: string } {
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === weaponName);
  if (!w) return { ok: false, reason: `operative has no ranged weapon '${weaponName}'` };
  const profile = findProfile(w, profileName);
  if (!profile) return { ok: false, reason: `weapon '${weaponName}' has no profile '${profileName}'` };
  const rules = effectiveRules(ctx, state, profile);
  const target = state.operatives[targetId];
  if (!target || target.removed) return { ok: false, reason: 'no such target' };

  const check = checkTarget(ctx, state, attacker, target, profile, rules, { pointBlank: opts.pointBlank ?? false });
  if (!check.valid) return { ok: false, reason: check.reason ?? 'not a valid target' };

  const seq: ShootSequence = {
    kind: 'shoot',
    step: 'start',
    attackerId: attacker.id,
    targetId,
    queue: secondaryTargets(ctx, state, attacker, target, profile, rules).map((o) => o.id),
    resolvedTargets: [],
    weaponName,
    ...(profileName ? { profileName } : {}),
    secondary: false,
    pointBlank: opts.pointBlank ?? false,
    inCover: check.inCover,
    obscured: check.obscured,
    coverChoiceMade: !check.mustChoose,
    vantageAccurate: check.vantageAccurate,
    vantageImprovedCover: check.vantageImprovedCover,
    attack: newPool(),
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: opts.free ?? false,
  };
  state.sequence = seq;
  log(state, {
    kind: 'action',
    player: attacker.player,
    text: `${attacker.letter} shoots ${target.letter} with ${weaponName}${profileName ? ` (${profileName})` : ''}`,
    data: { attackerId: attacker.id, targetId, weaponName },
  });
  return { ok: true };
}

/**
 * Blast x: "Secondary targets are other operatives visible to and within x of the primary
 * target... They are all valid targets, regardless of a Conceal order."
 * Torrent x: "select any number of other valid targets within x of the first valid target,
 * but not within control range of friendly operatives."
 */
function secondaryTargets(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  primary: OperativeState,
  profile: WeaponProfile,
  rules: WeaponRule[],
): OperativeState[] {
  const blast = ruleOf(rules, 'Blast');
  const torrent = ruleOf(rules, 'Torrent');
  const index = terrain(ctx, state);
  if (blast) {
    const r = blast.x ?? 0;
    return aliveOperatives(state).filter(
      (o) =>
        o.id !== primary.id &&
        o.id !== attacker.id &&
        gapBetween(ctx, primary, o) <= r + 1e-6 &&
        isVisible(index, body(ctx, primary), body(ctx, o)).visible,
    );
  }
  if (torrent) {
    const r = torrent.x ?? 0;
    return aliveOperatives(state, otherPlayer(attacker.player)).filter((o) => {
      if (o.id === primary.id) return false;
      if (gapBetween(ctx, primary, o) > r + 1e-6) return false;
      const friendlyNear = aliveOperatives(state, attacker.player).some((f) => inControlRange(ctx, state, f, o));
      if (friendlyNear) return false;
      return checkTarget(ctx, state, attacker, o, profile, rules, { secondary: true }).valid;
    });
  }
  return [];
}

/** Advance the sequence until a decision is required or it completes. */
export function advanceShoot(ctx: GameContext, state: GameState): void {
  let guard = 0;
  while (state.sequence?.kind === 'shoot' && state.pending.length === 0 && guard++ < 100) {
    const seq = state.sequence;
    const attacker = state.operatives[seq.attackerId]!;
    const target = state.operatives[seq.targetId];
    if (!target || target.removed) {
      nextTarget(ctx, state, seq);
      continue;
    }
    const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName)!;
    const profile = findProfile(w, seq.profileName)!;
    const rules = effectiveRules(ctx, state, profile);
    const actx = attackContext(ctx, state, seq, attacker, target, profile, rules);

    switch (seq.step) {
      case 'start': {
        if (!seq.coverChoiceMade) {
          push(state, {
            id: `cover-${state.seq++}`,
            who: seq.defender,
            kind: 'coverOrObscured',
            prompt: `${target.letter} would be both in cover from and obscured by the same terrain feature — choose one`,
            sourceText:
              'An operative cannot be in cover from and obscured by the same terrain feature. If it would be, the defender must select one of them (cover or obscured) for that sequence.',
            options: [
              { id: 'cover', label: 'In cover (cover save)' },
              { id: 'obscured', label: 'Obscured (attacker discards a success, no crits)' },
            ],
          });
          return;
        }
        seq.step = 'rollAttack';
        break;
      }

      case 'rollAttack': {
        const mods = ctx.hooks.emit('onCollectAttackDice', state, {
          state,
          ctx: actx,
          count: profile.atk,
          mods: zeroStatMods(),
        });
        // Vantage grants Accurate; the weapon's own Accurate x adds to it.
        const accurate = accurateValue(rules) + (target.order === 'engage' ? seq.vantageAccurate : 0);
        const toRoll = Math.max(0, mods.count + mods.mods.atk - accurate);
        const hit = hitStat(ctx, state, attacker, profile, seq);
        const results = ctx.rng.roll(toRoll);
        recordRoll(state, 'attack', results, seq.attacker, `${seq.weaponName} vs ${target.letter}`);
        addRolled(seq.attack, results, hit, lethalOpts(rules));
        if (accurate > 0) addAutoNormal(seq.attack, accurate, 'Accurate');
        log(state, {
          kind: 'dice',
          player: seq.attacker,
          text: `Attack dice (${hit}+): ${results.join(', ')}${accurate > 0 ? ` +${accurate} auto (Accurate)` : ''}`,
          data: { pool: 'attack', results, hit },
        });
        seq.step = 'attackRerolls';
        break;
      }

      case 'attackRerolls': {
        const grants = attackRerollGrants(ctx, state, seq, rules, actx);
        const next = grants.find((g) => !seq.usedRerolls.includes(g.id));
        if (next) {
          seq.usedRerolls.push(next.id);
          const opts = rerollDecision(state, next, seq.attack, hitStat(ctx, state, attacker, profile, seq));
          if (opts) return;
          break;
        }
        seq.step = 'retention';
        break;
      }

      case 'retention': {
        const options = retentionOptions(seq.attack, rules, seq.obscured).filter(
          (o) => !seq.usedRetention.includes(o.id),
        );
        if (options.length > 0) {
          seq.usedRetention.push(...options.map((o) => o.id));
          push(state, {
            id: `retain-${state.seq++}`,
            who: seq.attacker,
            kind: 'retention',
            prompt: 'Apply weapon rules to your retained dice',
            optional: true,
            options: [
              ...options.map((o) => ({ id: o.id, label: o.label })),
              { id: 'skip', label: 'Keep the dice as they are' },
            ],
            ctx: { pool: 'attack' },
            sourceText: options.map((o) => o.sourceText).join(' '),
          });
          return;
        }
        seq.step = seq.obscured ? 'obscuredDiscard' : 'rollDefence';
        break;
      }

      case 'obscuredDiscard': {
        const succ = successes(seq.attack);
        if (succ.length > 1) {
          push(state, {
            id: `obsc-${state.seq++}`,
            who: seq.attacker,
            kind: 'obscuredDiscard',
            prompt: 'Obscured: discard one success of your choice',
            sourceText:
              'If the target operative is obscured: The attacker must discard one success of their choice instead of retaining it. All the attacker’s critical successes are retained as normal successes.',
            options: succ.map((d) => ({
              id: String(d.id),
              label: `${d.state === 'crit' ? 'Critical' : 'Normal'} success${d.rolled ? ` (${d.value})` : ''}`,
              data: { dieId: d.id },
            })),
          });
          return;
        }
        applyObscured(seq.attack);
        log(state, { kind: 'dice', player: seq.attacker, text: 'Obscured: one success discarded, crits become normals' });
        seq.step = 'rollDefence';
        break;
      }

      case 'rollDefence': {
        const retainedCrits = countCrits(seq.attack);
        const piercing = piercingValue(rules, retainedCrits);
        const ev = ctx.hooks.emit('onDefenceDice', state, {
          state,
          ctx: actx,
          count: 3 - piercing,
          coverSave: seq.inCover && !hasRule(rules, 'Saturate'),
          coverSaveAsCrit: false,
          extraCoverSaves: 0,
          mods: zeroStatMods(),
          rerolls: [],
        });
        const save = Math.max(2, Math.min(6, saveOf(ctx, state, target) - ev.mods.save));
        let count = Math.max(0, ev.count);
        // "If the target operative is in cover, they can retain one normal success without
        // rolling it — this is known as a cover save. They roll the remainder."
        let coverSaves = 0;
        if (ev.coverSave) {
          coverSaves = 1 + ev.extraCoverSaves + (seq.vantageImprovedCover ? 1 : 0);
          coverSaves = Math.min(coverSaves, count);
          count -= coverSaves;
        }
        const results = ctx.rng.roll(count);
        recordRoll(state, 'defence', results, seq.defender, `${target.letter} save ${save}+`);
        addRolled(seq.defence, results, save);
        for (let i = 0; i < coverSaves; i++) {
          const die = addAutoNormal(seq.defence, 1, 'cover save')[0]!;
          if (ev.coverSaveAsCrit && i === 0) die.state = 'crit';
        }
        log(state, {
          kind: 'dice',
          player: seq.defender,
          text: `Defence dice (${save}+): ${results.join(', ')}${coverSaves > 0 ? ` + ${coverSaves} cover save` : ''}${
            piercing > 0 ? ` (Piercing ${piercing})` : ''
          }`,
          data: { pool: 'defence', results, save, coverSaves, piercing },
        });
        seq.step = 'defenceRerolls';
        break;
      }

      case 'defenceRerolls': {
        const grants: RerollGrant[] = [];
        const defTeam = state.teams[seq.defender];
        if (defTeam.cp >= 1 && !defTeam.ploysUsedTP.includes('commandReroll:defence'))
          grants.push({ ...COMMAND_REROLL, id: 'commandReroll:defence', player: seq.defender });
        const ev = ctx.hooks.emit('onDefenceDice', state, {
          state,
          ctx: actx,
          count: 0,
          coverSave: false,
          coverSaveAsCrit: false,
          extraCoverSaves: 0,
          mods: zeroStatMods(),
          rerolls: grants,
        });
        const next = ev.rerolls.find((g) => !seq.usedRerolls.includes(g.id));
        if (next) {
          seq.usedRerolls.push(next.id);
          const save = saveOf(ctx, state, target);
          const opts = rerollDecision(state, { ...next, player: seq.defender }, seq.defence, save);
          if (opts) return;
          break;
        }
        seq.step = 'allocate';
        break;
      }

      case 'allocate': {
        const brutal = hasRule(rules, 'Brutal');
        const alloc = allocateSavesOptimally(
          countCrits(seq.attack),
          countNormals(seq.attack),
          countCrits(seq.defence),
          countNormals(seq.defence),
          profile.dmgN,
          profile.dmgC,
          brutal,
        );
        const hasChoice = countCrits(seq.defence) + countNormals(seq.defence) > 0 && alloc.damage > 0;
        if (hasChoice) {
          push(state, {
            id: `alloc-${state.seq++}`,
            who: seq.defender,
            kind: 'allocateDefence',
            prompt: `Allocate defence dice (auto-optimal saves ${
              countCrits(seq.attack) * profile.dmgC + countNormals(seq.attack) * profile.dmgN - alloc.damage
            } damage)`,
            optional: true,
            options: [
              { id: 'auto', label: `Auto-allocate (take ${alloc.damage} damage)`, data: { ...alloc } },
              { id: 'manual', label: 'Allocate manually' },
            ],
            ctx: { alloc: { ...alloc }, brutal },
            sourceText:
              'The defender allocates all their successful defence dice to block successful attack dice. A normal success can block a normal success. Two normal successes can block a critical success. A critical success can block a normal success or a critical success.',
          });
          return;
        }
        applyAllocation(seq, alloc.unblockedCrits, alloc.unblockedNormals);
        seq.step = 'resolve';
        break;
      }

      case 'resolve': {
        resolveAttackDice(ctx, state, seq, attacker, target, profile, rules);
        seq.step = 'nextTarget';
        break;
      }

      case 'nextTarget': {
        nextTarget(ctx, state, seq);
        break;
      }

      case 'done':
        return;
    }
  }
}

function hitStat(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  profile: WeaponProfile,
  seq: ShootSequence,
): number {
  // Point-blank shot: "Worsen the Hit stat of your operative's weapons by 1."
  return hitOf(ctx, state, attacker, profile, seq.pointBlank ? -1 : 0);
}

function lethalOpts(rules: WeaponRule[]) {
  const l = lethalThreshold(rules);
  return l !== undefined ? { lethal: l } : {};
}

function attackContext(
  ctx: GameContext,
  state: GameState,
  seq: ShootSequence,
  attacker: OperativeState,
  target: OperativeState,
  profile: WeaponProfile,
  rules: WeaponRule[],
): AttackContext {
  return {
    attacker,
    defender: target,
    weaponName: seq.weaponName,
    profile,
    rules,
    type: 'ranged',
    secondary: seq.secondary,
    pointBlank: seq.pointBlank,
    inCover: seq.inCover,
    obscured: seq.obscured,
    vantageAccurate: seq.vantageAccurate,
    distance: gapBetween(ctx, attacker, target),
  };
}

function attackRerollGrants(
  ctx: GameContext,
  state: GameState,
  seq: ShootSequence,
  rules: WeaponRule[],
  actx: AttackContext,
): RerollGrant[] {
  const grants: RerollGrant[] = [];
  if (hasRule(rules, 'Balanced'))
    grants.push({ id: 'balanced', label: 'Balanced: re-roll one of your attack dice', mode: 'one', max: 1 });
  if (hasRule(rules, 'Ceaseless'))
    grants.push({
      id: 'ceaseless',
      label: 'Ceaseless: re-roll any of your attack dice results of one result',
      mode: 'value',
    });
  if (hasRule(rules, 'Relentless'))
    grants.push({ id: 'relentless', label: 'Relentless: re-roll any of your attack dice', mode: 'any' });
  const team = state.teams[seq.attacker];
  if (team.cp >= 1 && !team.ploysUsedTP.includes('commandReroll:attack'))
    grants.push({ ...COMMAND_REROLL, id: 'commandReroll:attack', player: seq.attacker });
  const ev = ctx.hooks.emit('onRollAttack', state, { state, ctx: actx, dice: [], rerolls: grants });
  return ev.rerolls;
}

/** Push a reroll decision; returns true when a decision was raised. */
function rerollDecision(state: GameState, grant: RerollGrant, pool: DicePool, hit: number): boolean {
  const candidates = pool.dice.filter((d) => d.rolled && d.state !== 'discarded');
  if (candidates.length === 0) return false;
  let options: { id: string; label: string; data?: Record<string, unknown> }[];
  if (grant.mode === 'value') {
    const values = [...new Set(candidates.map((d) => d.value))].sort((a, b) => a - b);
    options = values.map((v) => ({
      id: `value:${v}`,
      label: `Re-roll all results of ${v} (${candidates.filter((d) => d.value === v).length} dice)`,
      data: { value: v },
    }));
  } else {
    options = candidates.map((d) => ({
      id: `die:${d.id}`,
      label: `Re-roll the ${d.value} (${d.state})`,
      data: { dieId: d.id },
    }));
    if (grant.mode === 'any' || grant.mode === 'fails') {
      const failIds = candidates.filter((d) => d.state === 'fail').map((d) => d.id);
      if (failIds.length > 1)
        options.unshift({ id: 'allFails', label: `Re-roll all ${failIds.length} fails`, data: { dieIds: failIds } });
    }
  }
  push(state, {
    id: `rr-${state.seq++}`,
    who: grant.player ?? 'p1',
    kind: 'reroll',
    prompt: grant.label,
    optional: true,
    options: [...options, { id: 'keep', label: 'Keep the dice as rolled' }],
    ctx: { grantId: grant.id, mode: grant.mode, hit, cp: grant.cp ?? 0, pool: pool === undefined ? '' : '' },
    ...(grant.sourceText ? { sourceText: grant.sourceText } : {}),
  });
  return true;
}

function push(state: GameState, d: PendingDecision): void {
  state.pending.push(d);
  log(state, { kind: 'decision', player: d.who, text: d.prompt, data: { decisionId: d.id, kind: d.kind } });
}

export function applyAllocation(seq: ShootSequence, unblockedCrits: number, unblockedNormals: number): void {
  const critDice = seq.attack.dice.filter((d) => d.state === 'crit');
  const normalDice = seq.attack.dice.filter((d) => d.state === 'normal');
  for (let i = unblockedCrits; i < critDice.length; i++) critDice[i]!.state = 'blocked';
  for (let i = unblockedNormals; i < normalDice.length; i++) normalDice[i]!.state = 'blocked';
}

function resolveAttackDice(
  ctx: GameContext,
  state: GameState,
  seq: ShootSequence,
  attacker: OperativeState,
  target: OperativeState,
  profile: WeaponProfile,
  rules: WeaponRule[],
): void {
  const unblockedCrits = seq.attack.dice.filter((d) => d.state === 'crit').length;
  const unblockedNormals = seq.attack.dice.filter((d) => d.state === 'normal').length;

  // Devastating x fires on RETAINED crits, before blocking is considered, and the success is
  // not discarded ("it can still be resolved later in the sequence").
  const retainedCrits = seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'blocked').length;
  const dev = devastatingDamage(rules, retainedCrits);
  if (dev.perCrit > 0) {
    const totalDev = dev.perCrit * retainedCrits;
    inflictDamage(ctx, state, target, totalDev, 'devastating');
    seq.damage += totalDev;
    if (dev.radius !== undefined) {
      const index = terrain(ctx, state);
      for (const other of aliveOperatives(state)) {
        if (other.id === target.id) continue;
        if (gapBetween(ctx, target, other) > dev.radius + 1e-6) continue;
        if (!isVisible(index, body(ctx, target), body(ctx, other)).visible) continue;
        inflictDamage(ctx, state, other, totalDev, 'devastating');
      }
    }
  }

  const damage = unblockedCrits * profile.dmgC + unblockedNormals * profile.dmgN;
  if (damage > 0) {
    inflictDamage(ctx, state, target, damage, 'attack');
    seq.damage += damage;
  }
  log(state, {
    kind: 'dice',
    player: seq.attacker,
    text: `${unblockedCrits} crit + ${unblockedNormals} normal unblocked → ${damage} damage to ${target.letter}`,
    data: { unblockedCrits, unblockedNormals, damage },
  });

  // Stun: "If you retain any critical successes, subtract 1 from the APL stat of the
  // operative this weapon is being used against until the end of its next activation."
  if (hasRule(rules, 'Stun') && retainedCrits > 0) {
    target.aplMods.push(-1);
    state.effects.push({
      id: `stun${state.seq++}`,
      rule: 'stun',
      source: { kind: 'weapon', id: seq.weaponName },
      operativeId: target.id,
      expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
    });
    log(state, { kind: 'action', player: seq.defender, text: `${target.letter} is stunned (-1 APL)` });
  }

  ctx.hooks.emit('onStrikeResolved', state, {
    state,
    ctx: attackContext(ctx, state, seq, attacker, target, profile, rules),
    crit: unblockedCrits > 0,
    struck: target,
  });
}

function nextTarget(ctx: GameContext, state: GameState, seq: ShootSequence): void {
  const attacker = state.operatives[seq.attackerId]!;
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
  const profile = w ? findProfile(w, seq.profileName) : undefined;
  const rules = profile ? effectiveRules(ctx, state, profile) : [];

  seq.resolvedTargets.push(seq.targetId);
  const nextId = seq.queue.shift();
  if (!nextId) {
    finishShoot(ctx, state, seq, attacker, rules);
    return;
  }
  const next = state.operatives[nextId];
  if (!next || next.removed) {
    nextTarget(ctx, state, seq);
    return;
  }
  // Blast/Torrent secondaries inherit cover/obscured from the primary.
  seq.targetId = nextId;
  seq.secondary = true;
  seq.defender = next.player;
  seq.attack = newPool();
  seq.defence = newPool();
  seq.usedRerolls = [];
  seq.usedRetention = [];
  seq.coverChoiceMade = true;
  seq.step = 'rollAttack';
  log(state, { kind: 'action', player: seq.attacker, text: `Secondary target: ${next.letter}` });
}

function finishShoot(
  ctx: GameContext,
  state: GameState,
  seq: ShootSequence,
  attacker: OperativeState,
  rules: WeaponRule[],
): void {
  // Limited x: "If it's used multiple times in one action (e.g. Blast), treat this as one use."
  if (!seq.useCounted && hasRule(rules, 'Limited')) {
    attacker.weaponUses[seq.weaponName] = (attacker.weaponUses[seq.weaponName] ?? 0) + 1;
    seq.useCounted = true;
  }
  // Hot: "After an operative uses this weapon, roll one D6. If the result is less than the
  // weapon's Hit stat, inflict damage on that operative equal to the result multiplied by two."
  if (hasRule(rules, 'Hot')) {
    const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
    const profile = w ? findProfile(w, seq.profileName) : undefined;
    const roll = ctx.rng.d6();
    recordRoll(state, 'hot', [roll], seq.attacker, seq.weaponName);
    if (profile && roll < profile.hit) {
      inflictDamage(ctx, state, attacker, roll * 2, 'other');
      log(state, { kind: 'dice', player: seq.attacker, text: `Hot: rolled ${roll} → ${roll * 2} damage to ${attacker.letter}` });
    } else {
      log(state, { kind: 'dice', player: seq.attacker, text: `Hot: rolled ${roll} — no damage` });
    }
  }
  seq.step = 'done';
}
