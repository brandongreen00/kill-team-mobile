/**
 * The Fight action sequence (core rules › Fight 1AP).
 *
 * 1. Select Enemy Operative · 2. Select Weapons · 3. Roll Attack Dice (simultaneous)
 * 4. Resolve Attack Dice: "Starting with the attacker, the players alternate resolving one
 *    of their successful unblocked attack dice... until one player has resolved all their
 *    dice, or one operative in that fight is incapacitated."
 */
import {
  accurateValue,
  addAutoNormal,
  addRolled,
  classify,
  countCrits,
  countNormals,
  devastatingDamage,
  hasRule,
  lethalThreshold,
  newPool,
  retentionOptions,
  successes,
  type Die,
  type DicePool,
} from '../dice.ts';
import { zeroStatMods, type AttackContext, type RerollGrant } from '../hooks.ts';
import { type GameContext } from '../context.ts';
import {
  aliveOperatives,
  card,
  findProfile,
  gapBetween,
  hitOf,
  inControlRange,
  inflictDamage,
  log,
  recordRoll,
  weaponsOf,
} from '../state.ts';
import { effectiveRules, COMMAND_REROLL } from './shoot.ts';
import type { GameState, OperativeState, PendingDecision, WeaponProfile, WeaponRule } from '../types.ts';
import { otherPlayer } from '../types.ts';
import type { FightSequence } from './types.ts';

export function startFight(
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  weaponName: string,
  profileName: string | undefined,
  defenderId: string,
  opts: { free?: boolean; hatchway?: boolean } = {},
): { ok: boolean; reason?: string } {
  const defender = state.operatives[defenderId];
  if (!defender || defender.removed) return { ok: false, reason: 'no such enemy operative' };
  if (!opts.hatchway && !inControlRange(ctx, state, attacker, defender))
    return { ok: false, reason: 'the enemy operative is not within control range' };
  const w = weaponsOf(ctx, state, attacker, 'melee').find((x) => x.name === weaponName);
  if (!w) return { ok: false, reason: `operative has no melee weapon '${weaponName}'` };

  // The defender retaliates with its own melee weapon; the AI/UI may override the choice via
  // a decision, but the default is the first melee weapon on its card.
  const dw = weaponsOf(ctx, state, defender, 'melee')[0];
  const seq: FightSequence = {
    kind: 'fight',
    step: 'start',
    attackerId: attacker.id,
    defenderId,
    attackerWeapon: weaponName,
    ...(profileName ? { attackerProfile: profileName } : {}),
    ...(dw ? { defenderWeapon: dw.name } : {}),
    defenderCanRetaliate: Boolean(dw) && !cannotRetaliate(state, defender),
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: assistCount(ctx, state, attacker, defender),
    defenderAssists: assistCount(ctx, state, defender, attacker),
    attacker: attacker.player,
    defender: defender.player,
    free: opts.free ?? false,
    hatchway: opts.hatchway ?? false,
  };
  state.sequence = seq;
  log(state, {
    kind: 'action',
    player: attacker.player,
    text: `${attacker.letter} fights ${defender.letter} with ${weaponName}`,
    data: { attackerId: attacker.id, defenderId, weaponName },
  });
  return { ok: true };
}

function cannotRetaliate(state: GameState, op: OperativeState): boolean {
  return state.effects.some((e) => e.rule === 'cannotRetaliate' && e.operativeId === op.id);
}

/**
 * "While a friendly operative is assisted by other friendly operatives, improve the Hit stat
 * of its melee weapons by 1 for each doing so. For a friendly operative to assist them, it
 * must be within control range of the enemy operative in that fight and not within control
 * range of another enemy operative."
 */
export function assistCount(
  ctx: GameContext,
  state: GameState,
  fighter: OperativeState,
  enemy: OperativeState,
): number {
  const enemies = aliveOperatives(state, otherPlayer(fighter.player));
  let n = 0;
  for (const friend of aliveOperatives(state, fighter.player)) {
    if (friend.id === fighter.id) continue;
    if (!inControlRange(ctx, state, friend, enemy)) continue;
    const otherEnemy = enemies.some((e) => e.id !== enemy.id && inControlRange(ctx, state, friend, e));
    if (otherEnemy) continue;
    n++;
  }
  const ev = ctx.hooks.emit('onFightAssist', state, { state, operative: fighter, assists: n });
  return ev.assists;
}

export function advanceFight(ctx: GameContext, state: GameState): void {
  let guard = 0;
  while (state.sequence?.kind === 'fight' && state.pending.length === 0 && guard++ < 200) {
    const seq = state.sequence;
    const attacker = state.operatives[seq.attackerId]!;
    const defender = state.operatives[seq.defenderId]!;

    switch (seq.step) {
      case 'start':
        seq.step = 'rollAttack';
        break;

      case 'rollAttack': {
        rollSide(ctx, state, seq, 'attacker');
        if (seq.defenderCanRetaliate) rollSide(ctx, state, seq, 'defender');
        seq.step = 'attackerRerolls';
        break;
      }

      case 'attackerRerolls': {
        if (offerRerolls(ctx, state, seq, 'attacker')) return;
        seq.step = 'defenderRerolls';
        break;
      }

      case 'defenderRerolls': {
        if (seq.defenderCanRetaliate && offerRerolls(ctx, state, seq, 'defender')) return;
        seq.step = 'retention';
        break;
      }

      case 'retention': {
        for (const side of ['attacker', 'defender'] as const) {
          if (side === 'defender' && !seq.defenderCanRetaliate) continue;
          const { rules } = sideWeapon(ctx, state, seq, side);
          const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
          const key = `${side}:retention`;
          if (seq.usedRetention.includes(key)) continue;
          const options = retentionOptions(pool, rules, false);
          seq.usedRetention.push(key);
          if (options.length > 0) {
            push(state, {
              id: `fretain-${state.seq++}`,
              who: side === 'attacker' ? seq.attacker : seq.defender,
              kind: 'retention',
              prompt: 'Apply weapon rules to your retained dice',
              optional: true,
              options: [
                ...options.map((o) => ({ id: o.id, label: o.label })),
                { id: 'skip', label: 'Keep the dice as they are' },
              ],
              ctx: { side },
              sourceText: options.map((o) => o.sourceText).join(' '),
            });
            return;
          }
        }
        seq.step = 'resolve';
        break;
      }

      case 'resolve': {
        if (attacker.removed || attacker.incapacitated || defender.removed || defender.incapacitated) {
          seq.step = 'done';
          break;
        }
        const side = seq.turn;
        const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
        const opponentPool = side === 'attacker' ? seq.defenderPool : seq.attackerPool;
        const mine = successes(pool);
        if (mine.length === 0) {
          // "until one player has resolved all their dice (in which case their opponent
          // resolves all their remaining dice)"
          const other = successes(opponentPool);
          if (other.length === 0) {
            seq.step = 'done';
            break;
          }
          seq.turn = side === 'attacker' ? 'defender' : 'attacker';
          break;
        }
        const player = side === 'attacker' ? seq.attacker : seq.defender;
        const canBlock = successes(opponentPool).length > 0;
        push(state, {
          id: `strike-${state.seq++}`,
          who: player,
          kind: 'strikeOrBlock',
          prompt: `Resolve one success: strike or block (${mine.length} left)`,
          options: [
            ...mine.map((d) => ({
              id: `strike:${d.id}`,
              label: `Strike with the ${d.state === 'crit' ? 'critical' : 'normal'} success${d.rolled ? ` (${d.value})` : ''}`,
              data: { dieId: d.id, mode: 'strike' },
            })),
            ...(canBlock
              ? mine.map((d) => ({
                  id: `block:${d.id}`,
                  label: `Block with the ${d.state === 'crit' ? 'critical' : 'normal'} success`,
                  data: { dieId: d.id, mode: 'block' },
                  ...(d.state === 'normal' && brutalAgainst(ctx, state, seq, side)
                    ? { disabled: true, reason: 'Brutal: only critical successes can block' }
                    : {}),
                }))
              : []),
          ],
          ctx: { side },
          sourceText:
            'Starting with the attacker, the players alternate resolving one of their successful unblocked attack dice. When a player resolves a dice, they must strike or block with it.',
        });
        return;
      }

      case 'done':
        return;
    }
  }
}

function brutalAgainst(
  ctx: GameContext,
  state: GameState,
  seq: FightSequence,
  side: 'attacker' | 'defender',
): boolean {
  // Brutal is on the OPPONENT's weapon: "Your opponent can only block with critical successes."
  const opponent = side === 'attacker' ? 'defender' : 'attacker';
  const { rules } = sideWeapon(ctx, state, seq, opponent);
  return hasRule(rules, 'Brutal');
}

export function sideWeapon(
  ctx: GameContext,
  state: GameState,
  seq: FightSequence,
  side: 'attacker' | 'defender',
): { profile: WeaponProfile; rules: WeaponRule[]; name: string } {
  const op = side === 'attacker' ? state.operatives[seq.attackerId]! : state.operatives[seq.defenderId]!;
  const name = side === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName = side === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  const w = weaponsOf(ctx, state, op, 'melee').find((x) => x.name === name) ?? weaponsOf(ctx, state, op, 'melee')[0];
  const profile = w ? (findProfile(w, profileName) ?? w.profiles[0]!) : fallbackProfile();
  const foe = side === 'attacker' ? state.operatives[seq.defenderId] : state.operatives[seq.attackerId];
  return {
    profile,
    rules: effectiveRules(ctx, state, profile, {
      operative: op,
      ...(foe ? { target: foe } : {}),
      weaponName: w?.name ?? name,
      retaliating: side === 'defender',
    }),
    name: w?.name ?? name,
  };
}

function fallbackProfile(): WeaponProfile {
  return { type: 'melee', atk: 0, hit: 6, dmgN: 0, dmgC: 0, rules: [] };
}

function rollSide(ctx: GameContext, state: GameState, seq: FightSequence, side: 'attacker' | 'defender'): void {
  const op = side === 'attacker' ? state.operatives[seq.attackerId]! : state.operatives[seq.defenderId]!;
  const { profile, rules, name } = sideWeapon(ctx, state, seq, side);
  const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
  const hit = hitOf(ctx, state, op, profile, assists);
  const accurate = accurateValue(rules);
  const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
  const ctxObj: AttackContext = {
    attacker: op,
    defender: side === 'attacker' ? state.operatives[seq.defenderId]! : state.operatives[seq.attackerId]!,
    weaponName: name,
    profile,
    rules,
    type: 'melee',
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 0,
  };
  const ev = ctx.hooks.emit('onCollectAttackDice', state, {
    state,
    ctx: ctxObj,
    count: profile.atk,
    mods: zeroStatMods(),
  });
  const toRoll = Math.max(0, ev.count + ev.mods.atk - accurate);
  const results = ctx.rng.roll(toRoll);
  recordRoll(state, 'fight', results, op.player, `${op.letter} ${name}`);
  const lethal = lethalThreshold(rules);
  addRolled(pool, results, hit, lethal !== undefined ? { lethal } : {});
  if (accurate > 0) addAutoNormal(pool, accurate, 'Accurate');
  log(state, {
    kind: 'dice',
    player: op.player,
    text: `${op.letter} fight dice (${hit}+${assists > 0 ? `, +${assists} assist` : ''}): ${results.join(', ')}`,
    data: { pool: side, results, hit, assists },
  });
}

function offerRerolls(
  ctx: GameContext,
  state: GameState,
  seq: FightSequence,
  side: 'attacker' | 'defender',
): boolean {
  const { rules, profile } = sideWeapon(ctx, state, seq, side);
  const player = side === 'attacker' ? seq.attacker : seq.defender;
  const op = side === 'attacker' ? state.operatives[seq.attackerId]! : state.operatives[seq.defenderId]!;
  const grants: RerollGrant[] = [];
  if (hasRule(rules, 'Balanced')) grants.push({ id: `${side}:balanced`, label: 'Balanced: re-roll one attack die', mode: 'one', max: 1, player });
  if (hasRule(rules, 'Ceaseless'))
    grants.push({ id: `${side}:ceaseless`, label: 'Ceaseless: re-roll all dice of one result', mode: 'value', player });
  if (hasRule(rules, 'Relentless'))
    grants.push({ id: `${side}:relentless`, label: 'Relentless: re-roll any attack dice', mode: 'any', player });
  const team = state.teams[player];
  if (team.cp >= 1 && !team.ploysUsedTP.includes(`commandReroll:${side}`))
    grants.push({ ...COMMAND_REROLL, id: `commandReroll:${side}`, player });

  const next = grants.find((g) => !seq.usedRerolls.includes(g.id));
  if (!next) return false;
  seq.usedRerolls.push(next.id);
  const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
  const candidates = pool.dice.filter((d) => d.rolled && d.state !== 'discarded');
  if (candidates.length === 0) return false;
  const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
  const hit = hitOf(ctx, state, op, profile, assists);
  let options: PendingDecision['options'];
  if (next.mode === 'value') {
    const values = [...new Set(candidates.map((d) => d.value))].sort((a, b) => a - b);
    options = values.map((v) => ({
      id: `value:${v}`,
      label: `Re-roll all results of ${v}`,
      data: { value: v },
    }));
  } else {
    options = candidates.map((d) => ({ id: `die:${d.id}`, label: `Re-roll the ${d.value}`, data: { dieId: d.id } }));
  }
  push(state, {
    id: `frr-${state.seq++}`,
    who: player,
    kind: 'reroll',
    prompt: next.label,
    optional: true,
    options: [...options, { id: 'keep', label: 'Keep the dice as rolled' }],
    ctx: { grantId: next.id, mode: next.mode, hit, cp: next.cp ?? 0, side },
    ...(next.sourceText ? { sourceText: next.sourceText } : {}),
  });
  return true;
}

/** Resolve one die as a strike or a block; called by the decision handler. */
export function resolveFightDie(
  ctx: GameContext,
  state: GameState,
  seq: FightSequence,
  side: 'attacker' | 'defender',
  dieId: number,
  mode: 'strike' | 'block',
  blockTargetId?: number,
): void {
  const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
  const opponentPool = side === 'attacker' ? seq.defenderPool : seq.attackerPool;
  const die = pool.dice.find((d) => d.id === dieId);
  if (!die || (die.state !== 'crit' && die.state !== 'normal')) return;
  const me = side === 'attacker' ? state.operatives[seq.attackerId]! : state.operatives[seq.defenderId]!;
  const them = side === 'attacker' ? state.operatives[seq.defenderId]! : state.operatives[seq.attackerId]!;
  const { profile, rules } = sideWeapon(ctx, state, seq, side);
  const dieWasCrit = die.state === 'crit';

  if (mode === 'strike') {
    const crit = die.state === 'crit';
    const dmg = crit ? profile.dmgC : profile.dmgN;
    die.state = 'struck';
    inflictDamage(ctx, state, them, dmg, 'attack');
    log(state, {
      kind: 'dice',
      player: me.player,
      text: `${me.letter} strikes ${them.letter} for ${dmg}${crit ? ' (critical)' : ''}`,
    });
    // Devastating x in melee inflicts on each retained critical success as it is retained;
    // we apply it on the strike so it is visible in the ticker.
    const dev = devastatingDamage(rules, crit ? 1 : 0);
    if (dev.perCrit > 0 && crit) inflictDamage(ctx, state, them, dev.perCrit, 'devastating');
    // Shock: "The first time you strike with a critical success in each sequence, also
    // discard one of your opponent's unresolved normal successes (or a critical if none)."
    if (crit && hasRule(rules, 'Shock') && !seq.shockUsed[side]) {
      seq.shockUsed[side] = true;
      const victims = successes(opponentPool);
      const victim = victims.find((d) => d.state === 'normal') ?? victims[0];
      if (victim) {
        victim.state = 'discarded';
        victim.note = 'Shock';
        log(state, { kind: 'dice', player: me.player, text: `Shock discards one of ${them.letter}'s successes` });
      }
    }
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: {
        attacker: me,
        defender: them,
        weaponName: seq.attackerWeapon,
        profile,
        rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      crit,
      struck: them,
    });
  } else {
    // "Each of your blocks can be allocated to block ONE unresolved success" — the rare
    // Shield weapon rule raises that to two, via the onBlockAllocation hook.
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: me,
        defender: them,
        weaponName: seq.attackerWeapon,
        profile,
        rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      brutal: hasRule(rules, 'Brutal'),
      blocks: 1,
    });
    die.state = 'discarded';
    let blocked = 0;
    for (let i = 0; i < Math.max(1, ev.blocks); i++) {
      // "A normal success can block a normal success... a critical success can block either."
      const targets = successes(opponentPool);
      const blockable = dieWasCrit ? targets : targets.filter((d) => d.state === 'normal');
      const victim =
        (i === 0 && blockTargetId !== undefined ? blockable.find((d) => d.id === blockTargetId) : undefined) ??
        blockable.find((d) => d.state === 'crit') ??
        blockable[0];
      if (!victim) break;
      const wasCrit = victim.state === 'crit';
      victim.state = 'blocked';
      blocked++;
      log(state, { kind: 'dice', player: me.player, text: `${me.letter} blocks a ${wasCrit ? 'critical' : 'normal'} success` });
    }
    if (blocked === 0) log(state, { kind: 'dice', player: me.player, text: `${me.letter} blocks (nothing to block)` });
  }

  // "or one operative in that fight is incapacitated" — stop mid-sequence.
  if (them.incapacitated || me.incapacitated) {
    seq.step = 'done';
    return;
  }
  seq.turn = side === 'attacker' ? 'defender' : 'attacker';
  // If the other side has nothing left, this side resolves all remaining dice.
  if (successes(side === 'attacker' ? seq.defenderPool : seq.attackerPool).length === 0) {
    seq.turn = side;
  }
  if (successes(seq.attackerPool).length === 0 && successes(seq.defenderPool).length === 0) seq.step = 'done';
}

function push(state: GameState, d: PendingDecision): void {
  state.pending.push(d);
  log(state, { kind: 'decision', player: d.who, text: d.prompt, data: { decisionId: d.id, kind: d.kind } });
}
