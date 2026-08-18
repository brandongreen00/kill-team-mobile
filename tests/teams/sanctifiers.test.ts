/**
 * SANCTIFIERS (Adeptus Ministorum). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/sanctifiers/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { checkTarget, effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aplOf, hitOf, inflictDamage, markerController, moveOf, weaponsOf } from '../../src/core/state.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import type { FightSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile, WeaponRule } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { FREE_ACTION_RULE, effectOn, hasToken } from '../../src/teams/helpers.ts';
import { validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  ACT_INCENTIVISE,
  ACT_MEDIKIT,
  ACT_SANCTIFICATION_ORB,
  ACT_TRAINED_ASSASSIN,
  BLAZE_DECISION,
  BLAZE_TOKEN,
  CHERUB,
  CONFESSOR,
  CONFLAGRATOR,
  DEATH_CULT_ASSASSIN,
  DOUSED_TOKEN,
  DRILL_ABBOT,
  FLY_REPOSITION,
  MERCILESS_FIGHT,
  MIRACULIST,
  MISSIONARY,
  PERSECUTOR,
  PREACHER,
  RELIQUANT,
  SALVATIONIST,
  SERMON_GAMBIT,
  WREATHED_SHOOT,
  benefitsFromSermon,
  isOrator,
  sanctifiers,
} from '../../src/teams/sanctifiers/index.ts';
import { activate, battle, opWith, settle, teamContext } from './harness.ts';
import { rect, testMap } from '../fixtures.ts';

const DATA = teamData('sanctifiers');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const SP_EMPEROR_PROTECTS = 'sanctifiers.sp.the-emperor-protects';
const SP_FERVENT_BRAWL = 'sanctifiers.sp.fervent-brawl';
const SP_ZEALOUS_PERSECUTION = 'sanctifiers.sp.zealous-persecution';
const SP_RALLY_THE_FLOCK = 'sanctifiers.sp.rally-the-flock';
const FP_ROSARIUS = 'sanctifiers.fp.rosarius';
const FP_ARDENT_ERADICATION = 'sanctifiers.fp.ardent-eradication';
const FP_REDEEMED_THROUGH_FIRE = 'sanctifiers.fp.redeemed-through-fire';
const FP_UNWAVERING_DEVOTION = 'sanctifiers.fp.unwavering-devotion';
const EQ_ORBS = 'sanctifiers.eq.sanctification-orbs';
const EQ_PURITY_SEALS = 'sanctifiers.eq.purity-seals';
const EQ_ECCLESIARCHY_TEXTS = 'sanctifiers.eq.ecclesiarchy-texts';
const EQ_CULT_SYMBOLS = 'sanctifiers.eq.imperial-cult-symbols';

/**
 * One of each datacard. The printed list is 12 rows for 11 slots, so the MISSIONARY row that
 * offers the brazier is the one dropped — the remaining MISSIONARY takes the holy relic
 * option, which is what `Holy Relic` needs.
 */
const ROSTER: RosterPickIn[] = [
  { datacardId: CONFESSOR },
  { datacardId: CHERUB },
  { datacardId: CONFLAGRATOR },
  { datacardId: DEATH_CULT_ASSASSIN },
  { datacardId: DRILL_ABBOT },
  { datacardId: MIRACULIST },
  { datacardId: MISSIONARY, entryId: 'sanctifiers.sel7.missionary', loadoutIds: ['sanctifiers.g3e6.opt1'] },
  { datacardId: PERSECUTOR },
  { datacardId: PREACHER },
  { datacardId: RELIQUANT },
  { datacardId: SALVATIONIST },
];

function setup(
  opts: { equipment?: string[]; script?: number[]; seed?: number; map?: ReturnType<typeof testMap> } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([sanctifiers], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: sanctifiers, picks: ROSTER, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: sanctifiers, picks: ROSTER },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

/** Park every operative of a player out of the way. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    state.operatives[id]!.pos = { x: player === 'p1' ? 1 : 29, y: 1 + i * 1.6 };
  });
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};
const profileOfType = (cardId: string, weapon: string, type: 'ranged' | 'melee'): WeaponProfile =>
  DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!.profiles.find((p) => p.type === type)!;

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee' = 'ranged',
  rules: WeaponRule[] = profile.rules,
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules,
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
  };
}

/** A shoot sequence parked mid-flight, so a rule that reads `state.sequence` can be pinned. */
function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  dice: { value: number; state: 'crit' | 'normal' | 'fail' }[],
  step: 'done' | 'rollDefence' = 'done',
  profileName?: string,
): void {
  state.sequence = {
    kind: 'shoot',
    step,
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(profileName ? { profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: { dice: dice.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })), nextId: dice.length + 1 },
    defence: { dice: [], nextId: 1 },
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[targetId]!.player,
    free: false,
  };
}

function fakeFight(
  state: GameState,
  attackerId: string,
  defenderId: string,
  attackerWeapon: string,
  opts: { defenderWeapon?: string; defenderDice?: { value: number; state: 'crit' | 'normal' }[] } = {},
): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    ...(opts.defenderWeapon ? { defenderWeapon: opts.defenderWeapon } : {}),
    defenderCanRetaliate: true,
    attackerPool: { dice: [], nextId: 1 },
    defenderPool: {
      dice: (opts.defenderDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.defenderDice ?? []).length + 1,
    },
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[defenderId]!.player,
    free: false,
    hatchway: false,
  };
}

/** Make `operativeId` the ORATOR, through the printed STRATEGIC GAMBIT. */
function preach(ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId, operativeId?: string): GameState {
  const out = reduce(
    state,
    { t: 'UseGambit', player, gambitId: SERMON_GAMBIT, ...(operativeId ? { data: { operativeId } } : {}) },
    ctx,
  );
  expect(out.ok).toBe(true);
  return out.state;
}

function useGambit(ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId, gambitId: string): GameState {
  const out = reduce(state, { t: 'UseGambit', player, gambitId }, ctx);
  expect(out.reason).toBeUndefined();
  return out.state;
}

function usePloy(ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId, ployId: string): GameState {
  const out = reduce(state, { t: 'UsePloy', player, ployId }, ctx);
  expect(out.reason).toBeUndefined();
  return out.state;
}

// ---------------------------------------------------------------------------
describe('SANCTIFIERS data (pinned against data/teams/sanctifiers.json)', () => {
  it('has 11 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(11);
    const confessor = DATA.datacards.find((c) => c.id === CONFESSOR)!;
    expect(confessor).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 10, base: { shape: 'round', mm: 32 } });
    expect(confessor.keywords).toEqual(['SANCTIFIER', 'IMPERIUM', 'ADEPTUS MINISTORUM', 'LEADER', 'CONFESSOR']);
    expect(DATA.datacards.find((c) => c.id === CHERUB)).toMatchObject({ apl: 2, move: 7, save: 5, wounds: 5 });
    expect(DATA.datacards.find((c) => c.id === DEATH_CULT_ASSASSIN)).toMatchObject({ apl: 3, move: 6, save: 5, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === MIRACULIST)).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 7 });
    expect(DATA.datacards.find((c) => c.id === MISSIONARY)).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === SALVATIONIST)!.keywords).toContain('MEDIC');
    for (const card of DATA.datacards.filter((c) => c.id !== CONFESSOR)) {
      expect(card.base).toEqual({ shape: 'round', mm: 25 });
    }
  });

  it('the Brazier of holy fire is ONE weapon with two UNNAMED profiles that differ only by type', () => {
    const brazier = DATA.datacards.find((c) => c.id === MISSIONARY)!.weapons.find((w) => w.name === 'Brazier of holy fire')!;
    expect(brazier.profiles).toHaveLength(2);
    expect(brazier.profiles.map((p) => p.name ?? '')).toEqual(['', '']);
    expect(brazier.profiles.map((p) => p.type)).toEqual(['ranged', 'melee']);
    expect(profileOfType(MISSIONARY, 'Brazier of holy fire', 'ranged')).toMatchObject({ atk: 4, hit: 2, dmgN: 4, dmgC: 4 });
    expect(profileOfType(MISSIONARY, 'Brazier of holy fire', 'melee')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 4 });
    // Both profiles carry Blaze; only the ranged one is a flamer.
    expect(profileOfType(MISSIONARY, 'Brazier of holy fire', 'ranged').rules.map((r) => r.id)).toEqual([
      'Range',
      'Saturate',
      'Torrent',
      'Blaze',
    ]);
    expect(profileOfType(MISSIONARY, 'Brazier of holy fire', 'melee').rules.map((r) => r.id)).toEqual(['Shock', 'Blaze']);
  });

  it('pins the CONFLAGRATOR and MIRACULIST weapon profiles that carry the three rare rules', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat(CONFLAGRATOR)).toEqual([
      'Twin hand flamers|focused|ranged|4|2|3|3',
      'Twin hand flamers|twin torrent|ranged|4|2|3|3',
      'Gun butts||melee|4|4|2|3',
    ]);
    expect(flat(MIRACULIST)).toEqual([
      'Holy light||ranged|4|2|4|3',
      'Wreathe in fire||ranged|4|2|4|4',
      'Burning hands||melee|1|2|7|8',
      'Fists||melee|2|5|1|2',
    ]);
    expect(profileOf(CONFLAGRATOR, 'Twin hand flamers', 'twin torrent').rules.map((r) => r.id)).toEqual([
      'Range',
      'Saturate',
      'Torrent',
      'TwinTorrent',
      'Blaze',
    ]);
    expect(profileOf(MIRACULIST, 'Wreathe in fire').rules.map((r) => r.id)).toEqual(['Blast', 'Limited', 'Wreathed', 'Blaze']);
    expect(DATA.rareWeaponRules).toEqual(['Blaze', 'TwinTorrent', 'Wreathed']);
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 19 abilities and 3 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Blaze', 'Ministorum Sermon']);
    expect(sanctifiers.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(sanctifiers.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(sanctifiers.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(19);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'INCENTIVISE',
      'TRAINED ASSASSIN',
      'MEDIKIT',
    ]);
    // The section overrun is trimmed at load, so the last ploy of each section is its own text.
    expect(rule(SP_RALLY_THE_FLOCK)).not.toContain('Firefight Ploys');
    expect(rule(FP_UNWAVERING_DEVOTION)).not.toContain('Faction Equipment');
  });

  it('the printed selection is legal, records the holy relic in items[] and caps the brazier at one', () => {
    expect(DATA.selection.totalOperatives).toBe(11);
    expect(sanctifiers.validateRoster(ROSTER).ok).toBe(true);
    expect(validateRosterFor(DATA, ROSTER).weapons[6]).toEqual(['Meltagun', 'Chainsword']);
    // "You cannot select an option that includes a brazier of holy fire more than once per battle."
    expect(DATA.selection.constraints).toContainEqual({ kind: 'maxItem', item: 'brazier of holy fire', max: 1, group: '*' });
    // The holy relic is NOT a datacard weapon — the scraper keeps it verbatim in `items`.
    const row = DATA.selection.list.find((e) => e.loadouts.some((l) => l.id === 'sanctifiers.g3e6.opt1'))!;
    const relic = row.loadouts.find((l) => l.id === 'sanctifiers.g3e6.opt1')! as { items?: string[] };
    expect(relic.items).toEqual(['holy relic']);
    expect(DATA.datacards.find((c) => c.id === MISSIONARY)!.weapons.map((w) => w.name)).not.toContain('holy relic');
  });

  it('every datacard has an AI role, every ploy a value and every equipment option a value', () => {
    for (const card of DATA.datacards) expect(sanctifiers.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of sanctifiers.ploys) expect(sanctifiers.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of sanctifiers.equipment) expect(sanctifiers.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Blaze — "the operative this weapon is being used against gains one of your Blaze tokens"', () => {
  it('a critical success that inflicts damage hands out a Blaze token; a normal success does not', () => {
    expect(rule('sanctifiers.rule.blaze')).toContain('If you inflict damage with any critical successes');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', PERSECUTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', PREACHER)]!;
    const flamer = profileOf(PERSECUTOR, 'Hand flamer');
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: attackCtx(shooter, foe, 'Hand flamer', flamer), crit: false, struck: foe });
    expect(hasToken(state, foe.id, BLAZE_TOKEN, 'p1')).toBe(false);
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: attackCtx(shooter, foe, 'Hand flamer', flamer), crit: true, struck: foe });
    expect(hasToken(state, foe.id, BLAZE_TOKEN, 'p1')).toBe(true);
    // A weapon without Blaze never hands one out.
    const other = state.operatives[opWith(state, 'p2', DRILL_ABBOT)]!;
    const eviscerator = profileOf(PERSECUTOR, 'Eviscerator');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, other, 'Eviscerator', eviscerator, 'melee'),
      crit: true,
      struck: other,
    });
    expect(hasToken(state, other.id, BLAZE_TOKEN, 'p1')).toBe(false);
  });

  it('"Whenever an operative that has one of your Blaze tokens is activated, inflict D3 damage on it"', () => {
    expect(rule('sanctifiers.rule.blaze')).toContain('inflict D3 damage on it');
    const { ctx, state } = setup({ script: [4, 6] }); // D3 -> 2, then the removal D6 -> 6
    const shooter = state.operatives[opWith(state, 'p1', PERSECUTOR)]!;
    const foeId = opWith(state, 'p2', PREACHER);
    const foe = state.operatives[foeId]!;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, foe, 'Hand flamer', profileOf(PERSECUTOR, 'Hand flamer')),
      crit: true,
      struck: foe,
    });
    const before = foe.wounds;
    let s = activate(ctx, state, foeId);
    expect(before - s.operatives[foeId]!.wounds).toBe(2);
    // "Then that operative's controlling player selects one of the following"
    expect(s.pending[0]!.kind).toBe(BLAZE_DECISION);
    expect(s.pending[0]!.who).toBe('p2');
    s = reduce(s, { t: 'ResolveDecision', decisionId: s.pending[0]!.id, optionId: 'roll' }, ctx).state;
    expect(hasToken(s, foeId, BLAZE_TOKEN, 'p1')).toBe(false); // "on a 3+, remove that token"
  });

  it('"Roll one D6: on a 3+, remove that token" — a 1 leaves it burning', () => {
    const { ctx, state } = setup({ script: [2, 1] }); // D3 -> 1, removal D6 -> 1
    const shooter = state.operatives[opWith(state, 'p1', PERSECUTOR)]!;
    const foeId = opWith(state, 'p2', PREACHER);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, state.operatives[foeId]!, 'Hand flamer', profileOf(PERSECUTOR, 'Hand flamer')),
      crit: true,
      struck: state.operatives[foeId]!,
    });
    let s = activate(ctx, state, foeId);
    s = reduce(s, { t: 'ResolveDecision', decisionId: s.pending[0]!.id, optionId: 'roll' }, ctx).state;
    expect(hasToken(s, foeId, BLAZE_TOKEN, 'p1')).toBe(true);
  });

  it('"Subtract 1 from the operative’s APL stat until the end of that activation to remove that token"', () => {
    const { ctx, state } = setup({ script: [2] });
    const shooter = state.operatives[opWith(state, 'p1', PERSECUTOR)]!;
    const foeId = opWith(state, 'p2', PREACHER);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, state.operatives[foeId]!, 'Hand flamer', profileOf(PERSECUTOR, 'Hand flamer')),
      crit: true,
      struck: state.operatives[foeId]!,
    });
    let s = activate(ctx, state, foeId);
    s = reduce(s, { t: 'ResolveDecision', decisionId: s.pending[0]!.id, optionId: 'apl' }, ctx).state;
    expect(hasToken(s, foeId, BLAZE_TOKEN, 'p1')).toBe(false);
    expect(aplOf(ctx, s, s.operatives[foeId]!)).toBe(1);
    // "…until the end of that activation": the change is popped when the activation ends.
    s = reduce(s, { t: 'EndActivation', operativeId: foeId }, ctx).state;
    expect(s.operatives[foeId]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s, s.operatives[foeId]!)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Ministorum Sermon — "Select one friendly SANCTIFIER operative … that operative has the ORATOR keyword"', () => {
  it('is a 0CP STRATEGIC GAMBIT that must select a live CONFESSOR', () => {
    expect(rule('sanctifiers.rule.ministorum-sermon')).toContain(
      'If a friendly CONFESSOR operative hasn’t been incapacitated, you must select it',
    );
    const { ctx, state } = setup();
    expect(gambitOptions(ctx, state, 'p1').some((o) => o.id === SERMON_GAMBIT)).toBe(true);
    // Even when another operative is named, the CONFESSOR is taken.
    const s = preach(ctx, state, 'p1', opWith(state, 'p1', PREACHER));
    expect(isOrator(s, s.operatives[opWith(s, 'p1', CONFESSOR)]!)).toBe(true);
    expect(isOrator(s, s.operatives[opWith(s, 'p1', PREACHER)]!)).toBe(false);
    expect(s.teams.p1.cp).toBe(6); // a faction-rule gambit, not a ploy — it costs nothing
  });

  it('"Until you use this STRATEGIC GAMBIT again during the battle" — a second use moves the keyword', () => {
    const { ctx, state } = setup();
    let s = preach(ctx, state, 'p1');
    const confessorId = opWith(s, 'p1', CONFESSOR);
    expect(isOrator(s, s.operatives[confessorId]!)).toBe(true);
    s.operatives[confessorId]!.removed = true; // "hasn't been incapacitated"
    s.turningPoint = 2;
    s.teams.p1.gambitsUsedTP = [];
    const abbotId = opWith(s, 'p1', DRILL_ABBOT);
    s = preach(ctx, s, 'p1', abbotId);
    expect(isOrator(s, s.operatives[abbotId]!)).toBe(true);
    expect(isOrator(s, s.operatives[confessorId]!)).toBe(false);
  });

  it('SERMON reaches 6" from a CONFESSOR ORATOR and 3" from any other ORATOR', () => {
    expect(rule('sanctifiers.rule.ministorum-sermon')).toContain(
      'within 3" of a friendly ORATOR operative (or 6" if the ORATOR is a CONFESSOR)',
    );
    const { ctx, state } = setup();
    banish(state, 'p2');
    const confessor = state.operatives[opWith(state, 'p1', CONFESSOR)]!;
    const preacher = state.operatives[opWith(state, 'p1', PREACHER)]!;
    banish(state, 'p1', [confessor.id, preacher.id]);
    // Away from every objective marker, so PREACHER › Defend the Faith cannot confound it.
    confessor.pos = { x: 10, y: 4 };
    preacher.pos = { x: 15, y: 4 };
    const s = preach(ctx, state, 'p1');
    expect(benefitsFromSermon(ctx, s, s.operatives[preacher.id]!)).toBe(true);
    s.operatives[preacher.id]!.pos = { x: 18, y: 4 }; // > 6"
    expect(benefitsFromSermon(ctx, s, s.operatives[preacher.id]!)).toBe(false);

    // A non-CONFESSOR ORATOR only reaches 3".
    s.operatives[confessor.id]!.removed = true;
    s.turningPoint = 2;
    s.teams.p1.gambitsUsedTP = [];
    const abbot = s.operatives[opWith(s, 'p1', DRILL_ABBOT)]!;
    abbot.pos = { x: 10, y: 4 };
    const s2 = preach(ctx, s, 'p1', abbot.id);
    s2.operatives[preacher.id]!.pos = { x: 12.5, y: 4 };
    expect(benefitsFromSermon(ctx, s2, s2.operatives[preacher.id]!)).toBe(true);
    s2.operatives[preacher.id]!.pos = { x: 15, y: 4 };
    expect(benefitsFromSermon(ctx, s2, s2.operatives[preacher.id]!)).toBe(false);
  });

  it('an operative ACTIVATED in range benefits "until the end of that activation … even if it then moves"', () => {
    const { ctx, state } = setup();
    banish(state, 'p2');
    const confessor = state.operatives[opWith(state, 'p1', CONFESSOR)]!;
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [confessor.id, preacherId]);
    confessor.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    let s = preach(ctx, state, 'p1');
    s = activate(ctx, s, preacherId);
    s.operatives[preacherId]!.pos = { x: 25, y: 4 }; // walked far out of range
    expect(benefitsFromSermon(ctx, s, s.operatives[preacherId]!)).toBe(true);
    s = reduce(s, { t: 'EndActivation', operativeId: preacherId }, ctx).state;
    expect(benefitsFromSermon(ctx, s, s.operatives[preacherId]!)).toBe(false);
  });

  it('"Normal and Critical Dmg of 4 or more inflicts 1 less damage on it"', () => {
    expect(rule('sanctifiers.rule.ministorum-sermon')).toContain('Normal and Critical Dmg of 4 or more inflicts 1 less damage');
    const { ctx, state } = setup();
    banish(state, 'p2');
    const confessor = state.operatives[opWith(state, 'p1', CONFESSOR)]!;
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [confessor.id, preacherId]);
    confessor.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    const s = preach(ctx, state, 'p1');
    const preacher = s.operatives[preacherId]!;
    const start = preacher.wounds;
    inflictDamage(ctx, s, preacher, 3, 'attack');
    expect(start - preacher.wounds).toBe(3); // Dmg 3 is unaffected
    const mid = preacher.wounds;
    inflictDamage(ctx, s, preacher, 5, 'attack');
    expect(mid - preacher.wounds).toBe(4); // Dmg 5 -> 4
  });
});

// ---------------------------------------------------------------------------
describe('CONFESSOR', () => {
  it('Lead the Procession grants a free Charge/Fall Back/Reposition capped at 3", from turning point 2', () => {
    expect(ability(CONFESSOR, 'sanctifiers.confessor.lead-the-procession')).toContain(
      'In each turning point after the first',
    );
    const { ctx, state } = setup();
    banish(state, 'p2');
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [confessorId, preacherId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    let s = preach(ctx, state, 'p1');

    // Turning point 1: nothing.
    s = activate(ctx, s, confessorId);
    s = reduce(s, { t: 'PerformAction', operativeId: confessorId, action: 'Reposition', params: { path: { points: [{ x: 11, y: 4 }] } } }, ctx).state;
    s = reduce(s, { t: 'EndActivation', operativeId: confessorId }, ctx).state;
    expect(effectOn(s, preacherId, FREE_ACTION_RULE)).toBeUndefined();

    // Turning point 2: the procession moves.
    s.turningPoint = 2;
    s.operatives[confessorId]!.ready = true;
    s.operatives[confessorId]!.expended = false;
    s.operatives[confessorId]!.actionsThisActivation = [];
    s.operatives[confessorId]!.apSpent = 0;
    s = activate(ctx, s, confessorId);
    s = reduce(s, { t: 'PerformAction', operativeId: confessorId, action: 'Reposition', params: { path: { points: [{ x: 10, y: 4 }] } } }, ctx).state;
    s = reduce(s, { t: 'EndActivation', operativeId: confessorId }, ctx).state;
    const grant = effectOn(s, preacherId, FREE_ACTION_RULE);
    expect(grant?.source.id).toBe('sanctifiers.confessor.lead-the-procession');
    expect(grant?.data?.['only']).toEqual(['Charge', 'Fall Back', 'Reposition']);
    expect(aplOf(ctx, s, s.operatives[preacherId]!)).toBe(3);

    // "…cannot move more than … 3"" once the free AP is the one being spent.
    const preacher = s.operatives[preacherId]!;
    expect(moveBudget(ctx, s, preacher, { action: 'Reposition' })).toBeCloseTo(6);
    preacher.apSpent = 2;
    expect(moveBudget(ctx, s, preacher, { action: 'Reposition' })).toBeCloseTo(3);
    // A "free" 2AP Fall Back costs 1AP while the grant is being spent.
    expect(actionCost(ctx, s, preacher, getAction('Fall Back')!)).toBe(1);
  });

  it('Commanding Declamation costs an enemy an action once per battle when the D6 beats its APL', () => {
    expect(ability(CONFESSOR, 'sanctifiers.confessor.commanding-declamation')).toContain(
      'You cannot use this rule again during the battle',
    );
    const { ctx, state } = setup({ script: [5] });
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const foeId = opWith(state, 'p2', PREACHER);
    const foe2Id = opWith(state, 'p2', RELIQUANT);
    banish(state, 'p1', [confessorId]);
    banish(state, 'p2', [foeId, foe2Id]);
    state.operatives[confessorId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 13, y: 11 };
    state.operatives[foe2Id]!.pos = { x: 13, y: 14 };
    let s = activate(ctx, state, foeId);
    expect(aplOf(ctx, s, s.operatives[foeId]!)).toBe(1); // 5 > APL 2 -> one action lost
    s = reduce(s, { t: 'EndActivation', operativeId: foeId }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[foeId]!)).toBe(2);
    // "You cannot use this rule again during the battle."
    s = activate(ctx, s, foe2Id);
    expect(aplOf(ctx, s, s.operatives[foe2Id]!)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('CHERUB', () => {
  it('"Whenever determining control of an objective marker, treat this operative’s APL stat as 1 lower"', () => {
    expect(ability(CHERUB, 'sanctifiers.cherub.cherub')).toContain('treat this operative’s APL stat as 1 lower');
    const { ctx, state } = setup();
    const cherubId = opWith(state, 'p1', CHERUB);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [cherubId]);
    banish(state, 'p2', [foeId]);
    const marker = state.markers['centre']!;
    state.operatives[cherubId]!.pos = { x: marker.pos.x - 1, y: marker.pos.y };
    state.operatives[foeId]!.pos = { x: marker.pos.x + 1, y: marker.pos.y };
    // APL 2 vs APL 2 would be a tie; the CHERUB counts as 1, so the enemy controls it.
    expect(markerController(ctx, state, marker)).toBe('p2');
  });

  it('"Whenever this operative has a Conceal order and is in cover, it cannot be selected as a valid target … except being within 2""', () => {
    const light = {
      id: 'lb',
      kind: 'test.light',
      placement: { x: 0, y: 0, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'lb.body',
          featureId: 'lb',
          poly: rect(12, 10.5, 1, 1),
          z0: 0,
          z1: 0.5,
          types: ['Light' as const],
          role: 'wall' as const,
          blocksVisibility: false,
          solid: false,
        },
      ],
    };
    const { ctx, state } = setup({ map: testMap({ features: [light] }) });
    const cherubId = opWith(state, 'p1', CHERUB);
    const preacherId = opWith(state, 'p1', PREACHER);
    const shooterId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [cherubId, preacherId]);
    banish(state, 'p2', [shooterId]);
    const shooter = state.operatives[shooterId]!;
    shooter.pos = { x: 8, y: 11 };
    const cherub = state.operatives[cherubId]!;
    cherub.pos = { x: 13.3, y: 11 };
    cherub.order = 'conceal';
    // A Seek weapon ignores cover, so the core rule would make it a valid target…
    const seek: WeaponRule[] = [{ id: 'Seek', raw: 'Seek' }];
    const flamer = profileOf(PREACHER, 'Hand flamer');
    expect(checkTarget(ctx, state, shooter, cherub, flamer, seek).valid).toBe(false);
    // …and the rule is the CHERUB's alone: a PREACHER in the same spot stays targetable.
    const preacher = state.operatives[preacherId]!;
    preacher.pos = { x: 13.3, y: 11 };
    preacher.order = 'conceal';
    cherub.pos = { x: 1, y: 1 };
    expect(checkTarget(ctx, state, shooter, preacher, flamer, seek).valid).toBe(true);
    // "…except being within 2""
    cherub.pos = { x: 13.3, y: 11 };
    preacher.pos = { x: 1, y: 1 };
    shooter.pos = { x: 11, y: 11 }; // 1.3" gap: within 2", but not control range
    expect(checkTarget(ctx, state, shooter, cherub, flamer, seek).valid).toBe(true);
  });

  it('"cannot … perform unique actions other than Incentivise" (its own FLY moves are not unique actions)', () => {
    const { ctx, state } = setup();
    const cherub = state.operatives[opWith(state, 'p1', CHERUB)]!;
    const ask = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: cherub, action, allowed: true }).allowed;
    expect(ask(ACT_MEDIKIT)).toBe(false);
    expect(ask(ACT_SANCTIFICATION_ORB)).toBe(false);
    expect(ask(ACT_INCENTIVISE)).toBe(true);
    expect(ask(FLY_REPOSITION)).toBe(true);
    expect(ask('Reposition')).toBe(true);
  });

  it('Fly: "remove it from the killzone and set it back up wholly within a distance equal to its Move stat"', () => {
    expect(ability(CHERUB, 'sanctifiers.cherub.fly')).toContain('remove it from the killzone and set it back up');
    const { ctx, state } = setup();
    const cherubId = opWith(state, 'p1', CHERUB);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [cherubId]);
    banish(state, 'p2', [foeId]);
    state.operatives[cherubId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 22, y: 11 };
    let s = activate(ctx, s0(state), cherubId);
    // Move stat 7: 9" is too far.
    expect(
      reduce(s, { t: 'PerformAction', operativeId: cherubId, action: FLY_REPOSITION, params: { targetPos: { x: 19, y: 11 } } }, ctx).ok,
    ).toBe(false);
    // 6" is fine, and the operative is set up there rather than moved.
    const out = reduce(s, { t: 'PerformAction', operativeId: cherubId, action: FLY_REPOSITION, params: { targetPos: { x: 16, y: 11 } } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[cherubId]!.pos).toEqual({ x: 16, y: 11 });
    // "…it cannot be set up within control range of an enemy operative"
    s = out.state;
    s.operatives[cherubId]!.actionsThisActivation = [];
    expect(
      reduce(s, { t: 'PerformAction', operativeId: cherubId, action: FLY_REPOSITION, params: { targetPos: { x: 21.2, y: 11 } } }, ctx).ok,
    ).toBe(false);
  });

  it('INCENTIVISE: "Until the end of that operative’s next activation, add 1 to its APL stat"', () => {
    expect(actionOf(CHERUB, ACT_INCENTIVISE)).toContain('add 1 to its APL stat');
    const { ctx, state } = setup();
    const cherubId = opWith(state, 'p1', CHERUB);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [cherubId, preacherId]);
    banish(state, 'p2');
    state.operatives[cherubId]!.pos = { x: 10, y: 11 };
    state.operatives[preacherId]!.pos = { x: 11, y: 11 };
    let s = activate(ctx, state, cherubId);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: cherubId, action: ACT_INCENTIVISE, params: { targetOperativeId: preacherId } },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[preacherId]!)).toBe(3);
    expect(s.rejected).toEqual([]);
    // "…excluding CONFESSOR, DEATH CULT ASSASSIN, MIRACULIST and ORATOR"
    const confessorId = opWith(s, 'p1', CONFESSOR);
    s.operatives[confessorId]!.pos = { x: 10.9, y: 11 };
    s.operatives[preacherId]!.pos = { x: 1, y: 1 };
    s.operatives[cherubId]!.actionsThisActivation = [];
    const bad = getAction(ACT_INCENTIVISE)!.check(ctx, s, s.operatives[cherubId]!, { targetOperativeId: confessorId });
    expect(bad.ok).toBe(false);
  });
});

/** `battle()` hands back a fresh state; this keeps the helper chain readable. */
const s0 = (state: GameState): GameState => state;

// ---------------------------------------------------------------------------
describe('CONFLAGRATOR', () => {
  it('Twin Torrent: "Shoot with this weapon against both of them … (roll each sequence separately)"', () => {
    expect(ability(CONFLAGRATOR, 'sanctifiers.conflagrator.twin-torrent')).toContain(
      'Select up to two different valid targets',
    );
    const { ctx, state } = setup({ seed: 3 });
    const gunId = opWith(state, 'p1', CONFLAGRATOR);
    const aId = opWith(state, 'p2', PREACHER);
    const bId = opWith(state, 'p2', RELIQUANT);
    banish(state, 'p1', [gunId]);
    banish(state, 'p2', [aId, bId]);
    state.operatives[gunId]!.pos = { x: 10, y: 11 };
    state.operatives[aId]!.pos = { x: 13, y: 11 };
    state.operatives[bId]!.pos = { x: 13, y: 14 };
    let s = activate(ctx, state, gunId);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: gunId,
        action: 'Shoot',
        params: { weaponName: 'Twin hand flamers', profileName: 'twin torrent', targetId: aId },
      },
      ctx,
    ).state;
    s = settle(ctx, s);
    expect(s.log.some((l) => l.text.startsWith('Twin Torrent:'))).toBe(true);
    expect(s.log.some((l) => l.text.startsWith('Secondary target:'))).toBe(true);
    expect(s.rejected).toEqual([]);
  });

  it('Sanctification Rack lets the CONFLAGRATOR use the orb without the equipment and outside its once-per-TP limit', () => {
    expect(ability(CONFLAGRATOR, 'sanctifiers.conflagrator.sanctification-rack')).toContain(
      'doesn’t count towards the once per turning point limit',
    );
    const { ctx, state } = setup(); // no equipment selected
    const gun = state.operatives[opWith(state, 'p1', CONFLAGRATOR)]!;
    const preacher = state.operatives[opWith(state, 'p1', PREACHER)]!;
    const def = getAction(ACT_SANCTIFICATION_ORB)!;
    expect(def.available!(ctx, state, gun)).toBe(true);
    expect(def.available!(ctx, state, preacher)).toBe(false);
    // With the equipment the PREACHER can too — and the CHERUB never can.
    const withEq = setup({ equipment: [EQ_ORBS] });
    const eqPreacher = withEq.state.operatives[opWith(withEq.state, 'p1', PREACHER)]!;
    const eqCherub = withEq.state.operatives[opWith(withEq.state, 'p1', CHERUB)]!;
    expect(def.available!(withEq.ctx, withEq.state, eqPreacher)).toBe(true);
    expect(def.available!(withEq.ctx, withEq.state, eqCherub)).toBe(false);
  });

  it('SANCTIFICATION ORB douses the target and everything within 1" of it, on a 3+', () => {
    expect(rule(EQ_ORBS)).toContain('roll one D6: on a 3+, it gains one of your Doused tokens');
    const { ctx, state } = setup({ equipment: [EQ_ORBS], script: [5, 5] });
    const thrower = opWith(state, 'p1', PREACHER);
    const aId = opWith(state, 'p2', PREACHER);
    const bId = opWith(state, 'p2', RELIQUANT);
    banish(state, 'p1', [thrower]);
    banish(state, 'p2', [aId, bId]);
    state.operatives[thrower]!.pos = { x: 10, y: 11 };
    state.operatives[aId]!.pos = { x: 14, y: 11 };
    state.operatives[bId]!.pos = { x: 14.8, y: 11 };
    let s = activate(ctx, state, thrower);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: thrower, action: ACT_SANCTIFICATION_ORB, params: { targetOperativeId: aId } },
      ctx,
    ).state;
    expect(hasToken(s, aId, DOUSED_TOKEN, 'p1')).toBe(true);
    expect(hasToken(s, bId, DOUSED_TOKEN, 'p1')).toBe(true);
    // "Once per turning point, one friendly SANCTIFIER operative … can perform" this action.
    const again = getAction(ACT_SANCTIFICATION_ORB)!.check(ctx, s, s.operatives[opWith(s, 'p1', RELIQUANT)]!, {
      targetOperativeId: aId,
    });
    expect(again.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DEATH CULT ASSASSIN', () => {
  it('Bladed Stance: "you can resolve one of your successes before the normal order"', () => {
    expect(ability(DEATH_CULT_ASSASSIN, 'sanctifiers.death-cult-assassin.bladed-stance')).toContain(
      'resolve one of your successes before the normal order',
    );
    const { ctx, state } = setup();
    const dcaId = opWith(state, 'p1', DEATH_CULT_ASSASSIN);
    const foeId = opWith(state, 'p2', PREACHER);
    fakeFight(state, foeId, dcaId, 'Chainsword', { defenderWeapon: 'Ritual blades' });
    expect((state.sequence as FightSequence).turn).toBe('attacker');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(state.operatives[dcaId]!, state.operatives[foeId]!, 'Ritual blades', profileOf(DEATH_CULT_ASSASSIN, 'Ritual blades'), 'melee'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((state.sequence as FightSequence).turn).toBe('defender');
  });

  it('TRAINED ASSASSIN: "Change this operative’s order"', () => {
    expect(actionOf(DEATH_CULT_ASSASSIN, ACT_TRAINED_ASSASSIN)).toContain('Change this operative’s order');
    const { ctx, state } = setup();
    const dcaId = opWith(state, 'p1', DEATH_CULT_ASSASSIN);
    banish(state, 'p2');
    let s = activate(ctx, state, dcaId, 'engage');
    s = reduce(s, { t: 'PerformAction', operativeId: dcaId, action: ACT_TRAINED_ASSASSIN }, ctx).state;
    expect(s.operatives[dcaId]!.order).toBe('conceal');
    expect(s.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('DRILL ABBOT', () => {
  it('Schola Progenium Disciplinarian: "ignore any changes to that operative’s stats from being injured"', () => {
    expect(ability(DRILL_ABBOT, 'sanctifiers.drill-abbot.schola-progenium-disciplinarian')).toContain(
      'ignore any changes to that operative’s stats from being injured',
    );
    const { ctx, state } = setup();
    const abbot = state.operatives[opWith(state, 'p1', DRILL_ABBOT)]!;
    const preacher = state.operatives[opWith(state, 'p1', PREACHER)]!;
    banish(state, 'p2');
    banish(state, 'p1', [abbot.id, preacher.id]);
    preacher.wounds = 3; // 3 of 7 — injured
    const flamer = profileOf(PREACHER, 'Hand flamer');
    abbot.pos = { x: 10, y: 11 };
    preacher.pos = { x: 14, y: 11 };
    expect(moveOf(ctx, state, preacher)).toBe(6);
    expect(hitOf(ctx, state, preacher, flamer)).toBe(2);
    abbot.pos = { x: 1, y: 1 }; // more than 6" away
    expect(moveOf(ctx, state, preacher)).toBe(4);
    expect(hitOf(ctx, state, preacher, flamer)).toBe(3);
  });

  it('Null Skull: "that enemy operative’s APL stat cannot be added to (remove all positive APL stat changes it has)"', () => {
    expect(ability(DRILL_ABBOT, 'sanctifiers.drill-abbot.null-skull')).toContain(
      'remove all positive APL stat changes it has',
    );
    const { ctx, state } = setup();
    const abbot = state.operatives[opWith(state, 'p1', DRILL_ABBOT)]!;
    const foe = state.operatives[opWith(state, 'p2', PREACHER)]!;
    banish(state, 'p1', [abbot.id]);
    banish(state, 'p2', [foe.id]);
    foe.aplMods.push(1);
    abbot.pos = { x: 10, y: 11 };
    foe.pos = { x: 18, y: 11 };
    expect(aplOf(ctx, state, foe)).toBe(3);
    foe.pos = { x: 13, y: 11 }; // within 4"
    expect(aplOf(ctx, state, foe)).toBe(2);
    // A negative change is untouched.
    foe.aplMods = [-1];
    expect(aplOf(ctx, state, foe)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('PERSECUTOR', () => {
  it('Merciless Castigation grants a second Fight against the same enemy, past the action restriction', () => {
    expect(ability(PERSECUTOR, 'sanctifiers.persecutor.merciless-castigation')).toContain(
      'This takes precedence over action restrictions',
    );
    const { ctx, state } = setup({ script: new Array(40).fill(1) as number[] });
    const persId = opWith(state, 'p1', PERSECUTOR);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [persId]);
    banish(state, 'p2', [foeId]);
    state.operatives[persId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 11.2, y: 11 };
    let s = activate(ctx, state, persId);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: persId, action: 'Fight', params: { meleeWeaponName: 'Eviscerator', targetId: foeId } },
      ctx,
    ).state;
    s = settle(ctx, s);
    expect(effectOn(s, persId, FREE_ACTION_RULE)?.source.id).toBe('sanctifiers.persecutor.merciless-castigation');
    expect(aplOf(ctx, s, s.operatives[persId]!)).toBe(3);
    const second = reduce(
      s,
      { t: 'PerformAction', operativeId: persId, action: MERCILESS_FIGHT, params: { meleeWeaponName: 'Eviscerator' } },
      ctx,
    );
    expect(second.ok).toBe(true);
    expect(second.state.operatives[persId]!.actionsThisActivation).toEqual(['Fight', MERCILESS_FIGHT]);
    // "…and only if it's still valid to fight against"
    const dead = { ...s, operatives: { ...s.operatives } };
    dead.operatives[foeId] = { ...s.operatives[foeId]!, incapacitated: true };
    expect(getAction(MERCILESS_FIGHT)!.check(ctx, dead, dead.operatives[persId]!, {}).ok).toBe(false);
  });

  it('Fanatical Retribution strikes with one unresolved success before the PERSECUTOR is removed', () => {
    expect(ability(PERSECUTOR, 'sanctifiers.persecutor.fanatical-retribution')).toContain(
      'strike the enemy operative in that sequence with one of your unresolved successes',
    );
    const { ctx, state } = setup();
    const persId = opWith(state, 'p1', PERSECUTOR);
    const foeId = opWith(state, 'p2', PREACHER);
    fakeFight(state, foeId, persId, 'Chainsword', {
      defenderWeapon: 'Eviscerator',
      defenderDice: [{ value: 6, state: 'crit' }],
    });
    const before = state.operatives[foeId]!.wounds;
    inflictDamage(ctx, state, state.operatives[persId]!, 99, 'attack');
    // Eviscerator Critical Dmg 6
    expect(before - state.operatives[foeId]!.wounds).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe('MIRACULIST', () => {
  it('Wreathed: the MIRACULIST shoots from inside control range and "this operative isn’t affected"', () => {
    expect(ability(MIRACULIST, 'sanctifiers.miraculist.wreathed')).toContain(
      'This operative can perform the Shoot action with this weapon while within control range of an enemy operative',
    );
    const { ctx, state } = setup({ seed: 5 });
    const mirId = opWith(state, 'p1', MIRACULIST);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [mirId]);
    banish(state, 'p2', [foeId]);
    state.operatives[mirId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 11.2, y: 11 }; // inside control range, inside Blast 1"
    // The weapon is not offered to the universal Shoot action.
    expect(weaponsOf(ctx, state, state.operatives[mirId]!, 'ranged').map((w) => w.name)).not.toContain('Wreathe in fire');
    let s = activate(ctx, state, mirId);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: mirId, action: WREATHED_SHOOT, params: { weaponName: 'Wreathe in fire' } },
      ctx,
    );
    expect(out.ok).toBe(true);
    s = settle(ctx, out.state);
    expect(s.log.some((l) => l.text.includes('shoots') && l.text.includes('Wreathe in fire'))).toBe(true);
    expect(s.operatives[mirId]!.wounds).toBe(7); // never its own target
    expect(s.rejected).toEqual([]);
  });

  it('Miracle: "it’s not incapacitated, has 1 wound remaining and cannot be incapacitated for the remainder of the action"', () => {
    expect(ability(MIRACULIST, 'sanctifiers.miraculist.miracle')).toContain('has 1 wound remaining');
    const { ctx, state } = setup();
    const mirId = opWith(state, 'p1', MIRACULIST);
    const foeId = opWith(state, 'p2', PREACHER);
    fakeShoot(state, foeId, mirId, 'Hand flamer', [{ value: 6, state: 'crit' }]);
    const mir = state.operatives[mirId]!;
    inflictDamage(ctx, state, mir, 99, 'attack');
    expect(mir.incapacitated).toBeFalsy();
    expect(mir.wounds).toBe(1);
    expect(effectOn(state, mirId, FREE_ACTION_RULE)?.data?.['only']).toEqual(['Dash', 'Fall Back']);
    // "…cannot be incapacitated for the remainder of the action"
    inflictDamage(ctx, state, mir, 99, 'attack');
    expect(mir.incapacitated).toBeFalsy();
    // A different action, and the once-per-battle allowance is gone.
    fakeShoot(state, foeId, mirId, 'Chainsword', [{ value: 6, state: 'crit' }]);
    inflictDamage(ctx, state, mir, 99, 'attack');
    expect(mir.incapacitated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('MISSIONARY, PREACHER, RELIQUANT, SALVATIONIST', () => {
  it('Holy Relic: "If this operative has a holy relic, it’s always benefitting from the SERMON"', () => {
    expect(ability(MISSIONARY, 'sanctifiers.missionary.holy-relic')).toContain('it’s always benefitting from the SERMON');
    const { ctx, state } = setup();
    const missionaryId = opWith(state, 'p1', MISSIONARY);
    banish(state, 'p1', [missionaryId]);
    banish(state, 'p2');
    // No ORATOR anywhere, and the relic option is the loadout without the brazier.
    expect(benefitsFromSermon(ctx, state, state.operatives[missionaryId]!)).toBe(true);
    const loadouts = state.opState['loadout'] as Record<string, string[]>;
    loadouts[missionaryId] = ['Ministorum flamer', 'Brazier of holy fire'];
    expect(benefitsFromSermon(ctx, state, state.operatives[missionaryId]!)).toBe(false);
  });

  it('Spread the Word of the God-Emperor: Severe "more than 6" from other friendly operatives"', () => {
    expect(ability(MISSIONARY, 'sanctifiers.missionary.spread-the-word-of-the-god-emperor')).toContain(
      'its weapons have the Severe weapon rule',
    );
    const { ctx, state } = setup();
    const missionary = state.operatives[opWith(state, 'p1', MISSIONARY)]!;
    const preacher = state.operatives[opWith(state, 'p1', PREACHER)]!;
    banish(state, 'p2');
    banish(state, 'p1', [missionary.id, preacher.id]);
    missionary.pos = { x: 14, y: 11 };
    preacher.pos = { x: 1, y: 1 };
    const meltagun = profileOf(MISSIONARY, 'Meltagun');
    const rules = (): WeaponRule[] =>
      effectiveRules(ctx, state, meltagun, { operative: missionary, weaponName: 'Meltagun' });
    expect(rules().some((r) => r.id === 'Severe')).toBe(true);
    preacher.pos = { x: 16, y: 11 }; // within 6"
    expect(rules().some((r) => r.id === 'Severe')).toBe(false);
  });

  it('Defend the Faith: "Whenever this operative controls an objective marker, it’s benefitting from the SERMON"', () => {
    expect(ability(PREACHER, 'sanctifiers.preacher.defend-the-faith')).toContain('it’s benefitting from the SERMON');
    const { ctx, state } = setup();
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [preacherId]);
    banish(state, 'p2');
    const marker = state.markers['centre']!;
    state.operatives[preacherId]!.pos = { x: marker.pos.x - 1, y: marker.pos.y };
    expect(benefitsFromSermon(ctx, state, state.operatives[preacherId]!)).toBe(true);
    state.operatives[preacherId]!.pos = { x: 5, y: 3 };
    expect(benefitsFromSermon(ctx, state, state.operatives[preacherId]!)).toBe(false);
  });

  it('Cult Icon: "treat the total APL stat of friendly SANCTIFIER operatives that contest it as 1 higher"', () => {
    expect(ability(RELIQUANT, 'sanctifiers.reliquant.cult-icon')).toContain(
      'treat the total APL stat of friendly SANCTIFIER operatives that contest it as 1 higher',
    );
    const { ctx, state } = setup();
    const preacherId = opWith(state, 'p1', PREACHER);
    const reliquantId = opWith(state, 'p1', RELIQUANT);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [preacherId, reliquantId]);
    banish(state, 'p2', [foeId]);
    const marker = state.markers['centre']!;
    state.operatives[preacherId]!.pos = { x: marker.pos.x - 1, y: marker.pos.y };
    state.operatives[foeId]!.pos = { x: marker.pos.x + 1, y: marker.pos.y };
    state.operatives[reliquantId]!.pos = { x: marker.pos.x, y: marker.pos.y + 3 }; // within 4", not contesting
    expect(markerController(ctx, state, marker)).toBe('p1');
    state.operatives[reliquantId]!.pos = { x: 1, y: 1 }; // more than 4" away — a 2-2 tie
    expect(markerController(ctx, state, marker)).toBeNull();
  });

  it('Conversion Field: "improve that friendly operative’s Save stat by 1" against shooters more than 6" away', () => {
    expect(ability(SALVATIONIST, 'sanctifiers.salvationist.conversion-field')).toContain('improve that friendly operative’s Save stat by 1');
    const { ctx, state } = setup();
    const salv = state.operatives[opWith(state, 'p1', SALVATIONIST)]!;
    const preacher = state.operatives[opWith(state, 'p1', PREACHER)]!;
    const foe = state.operatives[opWith(state, 'p2', PREACHER)]!;
    banish(state, 'p1', [salv.id, preacher.id]);
    banish(state, 'p2', [foe.id]);
    salv.pos = { x: 10, y: 11 };
    preacher.pos = { x: 13, y: 11 };
    foe.pos = { x: 25, y: 11 };
    const save = (): number =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(foe, preacher, 'Hand flamer', profileOf(PREACHER, 'Hand flamer')),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).mods.save;
    expect(save()).toBe(1);
    foe.pos = { x: 14, y: 11 }; // the shooter is within 6" of the SALVATIONIST
    expect(save()).toBe(0);
  });

  it('MEDIKIT: "Select one friendly SANCTIFIER operative within this operative’s control range to regain up to 2D3 lost wounds"', () => {
    expect(actionOf(SALVATIONIST, ACT_MEDIKIT)).toContain('regain up to 2D3 lost wounds');
    const { ctx, state } = setup({ script: [6, 6] }); // 2D3 -> 3 + 3
    const salvId = opWith(state, 'p1', SALVATIONIST);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p1', [salvId, preacherId]);
    banish(state, 'p2');
    state.operatives[salvId]!.pos = { x: 10, y: 11 };
    state.operatives[preacherId]!.pos = { x: 11, y: 11 };
    state.operatives[preacherId]!.wounds = 1;
    let s = activate(ctx, state, salvId);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: salvId, action: ACT_MEDIKIT, params: { targetOperativeId: preacherId } },
      ctx,
    ).state;
    expect(s.operatives[preacherId]!.wounds).toBe(7); // 1 + 6, capped at the Wounds stat
    expect(s.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('THE EMPEROR PROTECTS: "you can re-roll any of your defence dice results of one result"', () => {
    const { ctx, state } = setup();
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p2');
    banish(state, 'p1', [confessorId, preacherId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    let s = preach(ctx, state, 'p1');
    const foe = s.operatives[opWith(s, 'p2', PREACHER)]!;
    const grants = (): string[] =>
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(foe, s.operatives[preacherId]!, 'Hand flamer', profileOf(PREACHER, 'Hand flamer')),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls.map((r) => r.id);
    expect(grants()).not.toContain('sanctifiers.theEmperorProtects');
    s = useGambit(ctx, s, 'p1', SP_EMPEROR_PROTECTS);
    expect(grants()).toContain('sanctifiers.theEmperorProtects');
  });

  it('FERVENT BRAWL: "its melee weapons have the Ceaseless weapon rule" while benefitting from the SERMON', () => {
    expect(rule(SP_FERVENT_BRAWL)).toContain('its melee weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p2');
    banish(state, 'p1', [confessorId, preacherId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    let s = preach(ctx, state, 'p1');
    s = useGambit(ctx, s, 'p1', SP_FERVENT_BRAWL);
    const preacher = s.operatives[preacherId]!;
    const sword = profileOf(PREACHER, 'Chainsword');
    expect(
      effectiveRules(ctx, s, sword, { operative: preacher, weaponName: 'Chainsword' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);
    // A ranged weapon is untouched.
    const flamer = profileOf(PREACHER, 'Hand flamer');
    expect(
      effectiveRules(ctx, s, flamer, { operative: preacher, weaponName: 'Hand flamer' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(false);
  });

  it('ZEALOUS PERSECUTION: Lethal 5+ "during an activation in which it performed the Charge action"', () => {
    expect(rule(SP_ZEALOUS_PERSECUTION)).toContain('its melee weapons have the Lethal 5+ weapon rule');
    const { ctx, state } = setup();
    let s = useGambit(ctx, state, 'p1', SP_ZEALOUS_PERSECUTION);
    const pers = s.operatives[opWith(s, 'p1', PERSECUTOR)]!;
    const eviscerator = profileOf(PERSECUTOR, 'Eviscerator');
    const lethal = (): boolean =>
      effectiveRules(ctx, s, eviscerator, { operative: pers, weaponName: 'Eviscerator' }).some(
        (r) => r.id === 'Lethal' && r.x === 5,
      );
    expect(lethal()).toBe(false);
    pers.actionsThisActivation = ['Charge'];
    expect(lethal()).toBe(true);
    // "is fighting", not retaliating.
    expect(
      effectiveRules(ctx, s, eviscerator, { operative: pers, weaponName: 'Eviscerator', retaliating: true }).some(
        (r) => r.id === 'Lethal',
      ),
    ).toBe(false);
  });

  it('RALLY THE FLOCK: a free Dash or Fall Back for each SERMON operative, never in the first turning point', () => {
    expect(rule(SP_RALLY_THE_FLOCK)).toContain('You cannot use this ploy during the first turning point');
    const { ctx, state } = setup();
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const preacherId = opWith(state, 'p1', PREACHER);
    banish(state, 'p2');
    banish(state, 'p1', [confessorId, preacherId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    let s = preach(ctx, state, 'p1');
    expect(gambitOptions(ctx, s, 'p1').some((o) => o.id === SP_RALLY_THE_FLOCK)).toBe(false);
    s.turningPoint = 2;
    expect(gambitOptions(ctx, s, 'p1').some((o) => o.id === SP_RALLY_THE_FLOCK)).toBe(true);
    s = useGambit(ctx, s, 'p1', SP_RALLY_THE_FLOCK);
    const grant = effectOn(s, preacherId, FREE_ACTION_RULE);
    expect(grant?.data?.['only']).toEqual(['Dash', 'Fall Back']);
    // "(excluding ORATOR)"
    expect(effectOn(s, confessorId, FREE_ACTION_RULE)).toBeUndefined();
    // "…for the latter, it cannot move more than 3""
    const preacher = s.operatives[preacherId]!;
    preacher.apSpent = 2;
    expect(moveBudget(ctx, s, preacher, { action: 'Fall Back' })).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('ROSARIUS: "when an attack dice inflicts Normal Dmg on a friendly SANCTIFIER operative. Ignore that inflicted damage"', () => {
    expect(rule(FP_ROSARIUS)).toContain('Ignore that inflicted damage');
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const preacherId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', MISSIONARY);
    const s = usePloy(ctx, state, 'p1', FP_ROSARIUS);
    // Meltagun: Normal Dmg 6, one unblocked normal success.
    fakeShoot(s, foeId, preacherId, 'Meltagun', [{ value: 4, state: 'normal' }]);
    const preacher = s.operatives[preacherId]!;
    const before = preacher.wounds;
    inflictDamage(ctx, s, preacher, 6, 'attack');
    expect(before - preacher.wounds).toBe(0);
    // One attack dice per use of the ploy.
    inflictDamage(ctx, s, preacher, 6, 'attack');
    expect(before - preacher.wounds).toBe(6);
  });

  it('ARDENT ERADICATION: re-roll the attack dice against an enemy near a friendly ORATOR', () => {
    expect(rule(FP_ARDENT_ERADICATION)).toContain('You can re-roll any of your attack dice');
    const { ctx, state } = setup();
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const shooterId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [confessorId, shooterId]);
    banish(state, 'p2', [foeId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 11 };
    state.operatives[shooterId]!.pos = { x: 10, y: 14 };
    state.operatives[foeId]!.pos = { x: 15, y: 11 }; // within 6" of the CONFESSOR ORATOR
    let s = preach(ctx, state, 'p1');
    s = usePloy(ctx, s, 'p1', FP_ARDENT_ERADICATION);
    const grants = (): string[] =>
      ctx.hooks.emit('onRollAttack', s, {
        state: s,
        ctx: attackCtx(s.operatives[shooterId]!, s.operatives[foeId]!, 'Hand flamer', profileOf(PREACHER, 'Hand flamer')),
        dice: [],
        rerolls: [],
      }).rerolls.map((r) => r.id);
    expect(grants()).toContain('sanctifiers.ardentEradication');
    s.operatives[foeId]!.pos = { x: 25, y: 3 }; // out of the ORATOR's reach
    expect(grants()).not.toContain('sanctifiers.ardentEradication');
  });

  it('REDEEMED THROUGH FIRE: "Each enemy operative visible to and within 2" of it gains one of your Blaze tokens"', () => {
    expect(rule(FP_REDEEMED_THROUGH_FIRE)).toContain('gains one of your Blaze tokens');
    const { ctx, state } = setup();
    const martyrId = opWith(state, 'p1', PREACHER); // hand flamer -> Blaze
    const nearId = opWith(state, 'p2', PREACHER);
    const farId = opWith(state, 'p2', RELIQUANT);
    banish(state, 'p1', [martyrId]);
    banish(state, 'p2', [nearId, farId]);
    state.operatives[martyrId]!.pos = { x: 10, y: 11 };
    state.operatives[nearId]!.pos = { x: 11.5, y: 11 };
    state.operatives[farId]!.pos = { x: 16, y: 11 };
    const s = usePloy(ctx, state, 'p1', FP_REDEEMED_THROUGH_FIRE);
    inflictDamage(ctx, s, s.operatives[martyrId]!, 99, 'attack');
    expect(hasToken(s, nearId, BLAZE_TOKEN, 'p1')).toBe(true);
    expect(hasToken(s, farId, BLAZE_TOKEN, 'p1')).toBe(false);
  });

  it('UNWAVERING DEVOTION redirects a Shoot away from the ORATOR, but not a Blast or Torrent weapon', () => {
    expect(rule(FP_UNWAVERING_DEVOTION)).toContain(
      'This ploy has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule',
    );
    const { ctx, state } = setup();
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const shieldId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', MISSIONARY);
    banish(state, 'p1', [confessorId, shieldId]);
    banish(state, 'p2', [foeId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 11 };
    state.operatives[shieldId]!.pos = { x: 12, y: 11 };
    state.operatives[foeId]!.pos = { x: 20, y: 11 };
    let s = preach(ctx, state, 'p1');
    s = usePloy(ctx, s, 'p1', FP_UNWAVERING_DEVOTION);
    const torrent = profileOf(MISSIONARY, 'Ministorum flamer');
    const redirect = (profile: WeaponProfile, weaponName: string): string | undefined =>
      ctx.hooks.emit('onSelectTarget', s, {
        state: s,
        attacker: s.operatives[foeId]!,
        target: s.operatives[confessorId]!,
        weaponName,
        profile,
        rules: profile.rules,
      }).redirectTo;
    expect(redirect(torrent, 'Ministorum flamer')).toBeUndefined(); // Torrent
    const melta = profileOf(MISSIONARY, 'Meltagun');
    expect(redirect(melta, 'Meltagun')).toBe(shieldId);
    // "Once per turning point" — the second shot is not redirected.
    expect(redirect(melta, 'Meltagun')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('SANCTIFICATION ORBS: a Blaze weapon "also has the Seek weapon rule" against a Doused operative, then the token goes', () => {
    expect(rule(EQ_ORBS)).toContain('that weapon also has the Seek weapon rule');
    const { ctx, state } = setup({ equipment: [EQ_ORBS], script: [5, 5] });
    const throwerId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', PREACHER);
    banish(state, 'p1', [throwerId]);
    banish(state, 'p2', [foeId]);
    state.operatives[throwerId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 14, y: 11 };
    let s = activate(ctx, state, throwerId);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: throwerId, action: ACT_SANCTIFICATION_ORB, params: { targetOperativeId: foeId } },
      ctx,
    ).state;
    const thrower = s.operatives[throwerId]!;
    const foe = s.operatives[foeId]!;
    const flamer = profileOf(PREACHER, 'Hand flamer');
    const rules = effectiveRules(ctx, s, flamer, { operative: thrower, target: foe, weaponName: 'Hand flamer' });
    expect(rules.some((r) => r.id === 'Seek')).toBe(true);
    // "After a friendly SANCTIFIER operative uses a weapon that has the Blaze weapon rule … remove that token"
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(thrower, foe, 'Hand flamer', flamer, 'ranged', rules),
      crit: false,
      struck: foe,
    });
    expect(hasToken(s, foeId, DOUSED_TOKEN, 'p1')).toBe(false);
  });

  it('PURITY SEALS: "if you roll two or more fails, you can discard one of them to retain another as a normal success"', () => {
    expect(rule(EQ_PURITY_SEALS)).toContain('discard one of them to retain another as a normal success');
    const { ctx, state } = setup({ equipment: [EQ_PURITY_SEALS] });
    const shooterId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', PREACHER);
    const grants = (): string[] =>
      ctx.hooks.emit('onRollAttack', state, {
        state,
        ctx: attackCtx(state.operatives[shooterId]!, state.operatives[foeId]!, 'Hand flamer', profileOf(PREACHER, 'Hand flamer')),
        dice: [],
        rerolls: [],
      }).rerolls.map((r) => r.id);
    fakeShoot(state, shooterId, foeId, 'Hand flamer', [{ value: 1, state: 'fail' }]);
    expect(grants()).not.toContain('sanctifiers.puritySeals'); // one fail is not enough
    fakeShoot(state, shooterId, foeId, 'Hand flamer', [
      { value: 1, state: 'fail' },
      { value: 1, state: 'fail' },
    ]);
    expect(grants()).toContain('sanctifiers.puritySeals');
    expect(grants()).not.toContain('sanctifiers.puritySeals'); // "Once per turning point"
  });

  it('ECCLESIARCHY TEXTS: "roll 3D6: if the result is less than the remaining wounds of a friendly ORATOR operative, you gain 1CP"', () => {
    expect(rule(EQ_ECCLESIARCHY_TEXTS)).toContain('you gain 1CP');
    const { ctx, state } = setup({ equipment: [EQ_ECCLESIARCHY_TEXTS], script: [1, 1, 1] });
    const cp = (s: GameState): number =>
      ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 1 }).cp;
    // "if there isn't a valid ORATOR operative, you cannot use this rule during that turning point"
    expect(cp(state)).toBe(1);
    const s = preach(ctx, state, 'p1');
    expect(cp(s)).toBe(2); // 3 < the CONFESSOR's 10 wounds
  });

  it('IMPERIAL CULT SYMBOLS: "change one of the attacker’s retained critical successes to a normal success"', () => {
    expect(rule(EQ_CULT_SYMBOLS)).toContain('change one of the attacker’s retained critical successes to a normal success');
    const { ctx, state } = setup({ equipment: [EQ_CULT_SYMBOLS] });
    const confessorId = opWith(state, 'p1', CONFESSOR);
    const preacherId = opWith(state, 'p1', PREACHER);
    const foeId = opWith(state, 'p2', MISSIONARY);
    banish(state, 'p2', [foeId]);
    banish(state, 'p1', [confessorId, preacherId]);
    state.operatives[confessorId]!.pos = { x: 10, y: 4 };
    state.operatives[preacherId]!.pos = { x: 13, y: 4 };
    state.operatives[foeId]!.pos = { x: 20, y: 4 };
    const s = preach(ctx, state, 'p1');
    fakeShoot(s, foeId, preacherId, 'Meltagun', [
      { value: 6, state: 'crit' },
      { value: 4, state: 'normal' },
    ], 'rollDefence');
    const melta = profileOf(MISSIONARY, 'Meltagun');
    const emit = (): void => {
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(s.operatives[foeId]!, s.operatives[preacherId]!, 'Meltagun', melta),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    };
    emit();
    const pool = (s.sequence as { attack: { dice: { state: string }[] } }).attack.dice;
    expect(pool.map((d) => d.state)).toEqual(['normal', 'normal']);
    // "Once per turning point"
    fakeShoot(s, foeId, preacherId, 'Meltagun', [{ value: 6, state: 'crit' }], 'rollDefence');
    emit();
    expect((s.sequence as { attack: { dice: { state: string }[] } }).attack.dice[0]!.state).toBe('crit');
  });
});

// ---------------------------------------------------------------------------
describe('AI surface', () => {
  it('the CHERUB is offered its FLY moves and the CONFLAGRATOR its orb, and nothing is rejected', () => {
    const { ctx, state } = setup();
    const cherubId = opWith(state, 'p1', CHERUB);
    banish(state, 'p2');
    const s = activate(ctx, state, cherubId);
    const ids = availableActions(ctx, s, s.operatives[cherubId]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(ids).toContain(FLY_REPOSITION);
    expect(ids).not.toContain(ACT_MEDIKIT);
    expect(s.rejected).toEqual([]);
  });
});

