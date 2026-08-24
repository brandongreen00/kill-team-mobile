/**
 * INQUISITORIAL AGENT (Agents of the Imperium). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/inquisitorial-agent/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { apBudgetOf, freeApOf, hitOf, inflictDamage, markerController, moveOf, aplOf } from '../../src/core/state.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { registerAction } from '../../src/core/actions.ts';
import { selectionEntries, teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import {
  ACT,
  CARD,
  COMBAT_DAGGER,
  EFFECTS,
  EQ,
  FP,
  HUNTER_CHARGE,
  PISTOL_BARRAGE_2,
  REQUISITIONED_CARDS,
  REQUISITION_GROUPS,
  RULE_REQUISITION,
  SIGNAL_2,
  SMOKE_ADAPTIVE,
  SP,
  STUN_ADAPTIVE,
  TOMES,
  TOMES_GAMBIT,
  TOME_RULE,
  chastenableRules,
  chastenedRule,
  denounceCost,
  denounced,
  inquisitorialAgent,
  quarryOf,
  tomeOf,
} from '../../src/teams/inquisitorial-agent/index.ts';
import { activate, act, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('inquisitorial-agent');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

interface SetupOpts {
  cards?: string[];
  p2cards?: string[];
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
  modules?: typeof kasrkin[];
}

function setup(opts: SetupOpts = {}): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext(
    [inquisitorialAgent, ...((opts.modules ?? []) as never[])],
    opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 },
  );
  const picks = opts.cards ? rosterIncluding(inquisitorialAgent, opts.cards) : defaultRoster(inquisitorialAgent.data);
  const p2picks = opts.p2cards
    ? rosterIncluding(inquisitorialAgent, opts.p2cards)
    : defaultRoster(inquisitorialAgent.data);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: inquisitorialAgent, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: inquisitorialAgent, picks: p2picks },
  });
  state.teams.p1.cp = 8;
  state.teams.p2.cp = 8;
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee' = 'ranged',
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules: profile.rules,
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
  opts: {
    profileName?: string;
    attack?: { value: number; state: 'crit' | 'normal' | 'fail' }[];
    defence?: { value: number; state: 'crit' | 'normal' | 'fail' }[];
  } = {},
): void {
  const attack = opts.attack ?? [];
  const defence = opts.defence ?? [];
  state.sequence = {
    kind: 'shoot',
    step: 'done',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: {
      dice: attack.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: attack.length + 1,
    },
    defence: {
      dice: defence.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: defence.length + 1,
    },
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

/** Park every operative of a player out of the way. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    const op = state.operatives[id]!;
    op.pos = { x: player === 'p1' ? 0.6 : 29.4, y: 0.6 + i * 0.05 };
  });
}

const gambitIds = (ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId): string[] =>
  gambitOptions(ctx, state, player).map((o) => o.id);

// ---------------------------------------------------------------------------
describe('INQUISITORIAL AGENT data (pinned against data/teams/inquisitorial-agent.json)', () => {
  it('has 18 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(18);
    const interrogator = DATA.datacards.find((c) => c.id === CARD.interrogator)!;
    expect(interrogator).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8, base: { shape: 'round', mm: 25 } });
    expect(interrogator.keywords).toEqual(['INQUISITORIAL AGENT', 'IMPERIUM', 'INQUISITION', 'LEADER', 'INTERROGATOR']);
    expect(DATA.datacards.find((c) => c.id === CARD.tomeSkull)!).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 5 });
    // The GUN SERVITOR is the only APL 1 / 32mm / 11-wound operative on the list.
    expect(DATA.datacards.find((c) => c.id === CARD.gunServitor)!).toMatchObject({
      apl: 1,
      move: 5,
      save: 4,
      wounds: 11,
      base: { shape: 'round', mm: 32 },
    });
    expect(DATA.datacards.find((c) => c.id === CARD.autosavant)!.save).toBe(4);
    expect(DATA.datacards.find((c) => c.id === CARD.prosecutor)!).toMatchObject({ save: 3, wounds: 8, base: { shape: 'round', mm: 32 } });
    expect(DATA.datacards.find((c) => c.id === CARD.mystic)!.keywords).toContain('PSYKER');
  });

  it('pins every weapon profile of the PISTOLIER, the GUN SERVITOR and the DEATH WORLD VETERAN', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
        );
    expect(flat(CARD.pistolier)).toEqual([
      'Scoped plasma pistol|standard|ranged|4|3|3|5',
      'Scoped plasma pistol|supercharge|ranged|4|3|4|5',
      'Suppressed autopistol||ranged|4|3|2|3',
      'Fists||melee|3|4|2|3',
    ]);
    expect(flat(CARD.gunServitor)).toEqual([
      'Heavy bolter|focused|ranged|5|4|4|5',
      'Heavy bolter|sweeping|ranged|4|4|4|5',
      'Multi-melta||ranged|4|4|6|3',
      'Plasma cannon|standard|ranged|4|4|4|6',
      'Plasma cannon|supercharge|ranged|4|4|5|6',
      'Servo claw||melee|3|4|4|5',
    ]);
    expect(flat(CARD.deathWorldVeteran)).toEqual([
      'Autopistol||ranged|4|4|2|3',
      'Knife||melee|1|2|5|7',
      'Polearm||melee|4|3|4|5',
    ]);
    expect(profileOf(CARD.enlightener, 'Paired blades').rules.map((r) => r.id)).toEqual(['Balanced', 'Rending']);
    expect(profileOf(CARD.pistolier, 'Suppressed autopistol').rules.map((r) => r.id)).toEqual(['Range', 'Silent']);
    // COMBAT DAGGERS' weapon table is printed underneath the equipment entry.
    expect(COMBAT_DAGGER.profiles[0]).toMatchObject({ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4 });
  });

  it('exposes 1 faction rule, 4 + 4 ploys, 4 equipment, 26 abilities, 5 unique actions and no rare rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Inquisitorial Requisition']);
    expect(inquisitorialAgent.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(inquisitorialAgent.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(inquisitorialAgent.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(26);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'CHASTEN',
      'SCRY',
      'PISTOL BARRAGE',
      'MEDIKIT',
      'SIGNAL',
    ]);
    expect(DATA.rareWeaponRules).toEqual([]);
    // DATA BUG: the scraper glued the CP cost onto every firefight ploy NAME and id.
    expect(DATA.firefightPloys.map((p) => p.name)).toEqual([
      'ABSOLUTE AUTHORITY1CP',
      'RELENTLESS IN PURSUIT1CP',
      "THE EMPEROR'S WILL1CP",
      'INTIMIDATING PRESENCE1CP',
    ]);
    expect(DATA.strategyPloys.map((p) => p.name)).toEqual([
      'DENOUNCE',
      'INTENSE SCRUTINY',
      'QUARRY',
      'IRREFUTABLE JURISDICTION',
    ]);
  });

  it('the printed default roster is legal, and every datacard has an AI role', () => {
    const picks = defaultRoster(inquisitorialAgent.data);
    expect(inquisitorialAgent.validateRoster(picks).ok).toBe(true);
    expect(picks).toHaveLength(12); // "1 INTERROGATOR … 1 TOME-SKULL … 5 … 5"
    // "you can include up to two GUN SERVITOR operatives, but each one must have different options"
    const servitors = picks.filter((p) => p.datacardId === CARD.gunServitor);
    expect(servitors).toHaveLength(2);
    expect(new Set(servitors.map((p) => p.loadoutIds?.[0])).size).toBe(2);
    for (const card of DATA.datacards) expect(inquisitorialAgent.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of inquisitorialAgent.ploys) expect(inquisitorialAgent.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of inquisitorialAgent.equipment) expect(inquisitorialAgent.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });

  it('Inquisitorial Requisition names six REQUISITIONED groups, and the datacards carry the new keyword', () => {
    expect(rule(RULE_REQUISITION)).toContain(
      'These operatives have their faction keyword replaced in all instances on their datacards with INQUISITORIAL AGENT',
    );
    expect(REQUISITION_GROUPS).toEqual([
      'DEATH KORPS',
      'EXACTION SQUAD',
      'IMPERIAL NAVY BREACHER',
      'KASRKIN',
      'SISTER OF SILENCE',
      'TEMPESTUS SCION',
    ]);
    // "Note that with their new faction keyword, REQUISITIONED operatives can interact with the
    //  INQUISITORIAL AGENT rules" — the keyword replacement is already baked into the data.
    for (const card of DATA.datacards) expect(card.keywords).toContain('INQUISITORIAL AGENT');
    expect(REQUISITIONED_CARDS).toEqual([
      CARD.prosecutor,
      CARD.vigilator,
      CARD.witchseeker,
      CARD.scionGunner,
      CARD.scionMedic,
      CARD.scionTrooper,
      CARD.scionVox,
    ]);
    // DATA BUG: the scraper emitted no selection-list row for any of them, so the shared
    // validator cannot field a REQUISITIONED operative at all.
    const listed = new Set(selectionEntries(DATA).map((e) => e.datacardId));
    for (const id of REQUISITIONED_CARDS) expect(listed.has(id)).toBe(false);
    expect(DATA.selection.groups[3]).toMatchObject({ kind: 'sameAsAbove', roles: [] });
  });

  it('"You cannot use ploys and equipment associated with a REQUISITIONED operative\'s former faction keyword"', () => {
    const { state } = setup({ modules: [kasrkin], equipment: ['kasrkin.eq.combat-daggers', EQ.bodysuits] });
    expect(state.teams.p1.equipment).toEqual([EQ.bodysuits]);
  });
});

// ---------------------------------------------------------------------------
describe('Inquisitorial Tomes — "Select one … for this operative … and one for a friendly TOME-SKULL"', () => {
  it('offers the four INTERROGATOR × TOME-SKULL combinations as a STRATEGIC GAMBIT', () => {
    expect(ability(CARD.interrogator, 'inquisitorial-agent.interrogator-agent.inquisitorial-tomes')).toContain(
      'STRATEGIC GAMBIT if this operative is in the killzone',
    );
    expect(TOMES).toEqual(['Denunciation', 'Sanctification']);
    expect(TOME_RULE.Denunciation).toContain('add 1 to the Atk stat of that friendly operative’s weapons');
    expect(TOME_RULE.Sanctification).toContain('subtract 1 from the Atk stat of that enemy operative’s weapons');

    const { ctx, state } = setup();
    const offered = gambitIds(ctx, state, 'p1').filter((id) => id.startsWith(`${TOMES_GAMBIT}:`));
    expect(offered).toEqual([
      `${TOMES_GAMBIT}:Denunciation|Denunciation`,
      `${TOMES_GAMBIT}:Denunciation|Sanctification`,
      `${TOMES_GAMBIT}:Sanctification|Denunciation`,
      `${TOMES_GAMBIT}:Sanctification|Sanctification`,
    ]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const after = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: `${TOMES_GAMBIT}:Denunciation|Sanctification` },
      ctx,
    ).state;
    expect(tomeOf(after, after.operatives[opWith(after, 'p1', CARD.interrogator)]!)).toBe('Denunciation');
    expect(tomeOf(after, after.operatives[opWith(after, 'p1', CARD.tomeSkull)]!)).toBe('Sanctification');
  });

  it('Denunciation: "add 1 to the Atk stat of that friendly operative’s weapons"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const interrogator = state.operatives[opWith(state, 'p1', CARD.interrogator)]!;
    const shooter = state.operatives[opWith(state, 'p1', CARD.hexorcist)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    interrogator.pos = { x: 14, y: 11 };
    shooter.pos = { x: 8, y: 11 };
    foe.pos = { x: 15.4, y: 11 }; // within 2" of the tome holder
    const shotgun = profileOf(CARD.hexorcist, 'Shotgun');
    const base = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, foe, 'Shotgun', shotgun),
      count: shotgun.atk,
      mods: zeroStatMods(),
    });
    expect(base.count).toBe(4);

    const gambit = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: `${TOMES_GAMBIT}:Denunciation|Denunciation` },
      ctx,
    ).state;
    const boosted = ctx.hooks.emit('onCollectAttackDice', gambit, {
      state: gambit,
      ctx: attackCtx(gambit.operatives[shooter.id]!, gambit.operatives[foe.id]!, 'Shotgun', shotgun),
      count: shotgun.atk,
      mods: zeroStatMods(),
    });
    expect(boosted.count).toBe(5);
    // Out of the 2" bubble it does nothing.
    gambit.operatives[foe.id]!.pos = { x: 20, y: 11 };
    const away = ctx.hooks.emit('onCollectAttackDice', gambit, {
      state: gambit,
      ctx: attackCtx(gambit.operatives[shooter.id]!, gambit.operatives[foe.id]!, 'Shotgun', shotgun),
      count: shotgun.atk,
      mods: zeroStatMods(),
    });
    expect(away.count).toBe(4);
  });

  it('Sanctification: "subtract 1 from the Atk stat of that enemy operative’s weapons"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    skull.pos = { x: 10, y: 11 };
    victim.pos = { x: 11.4, y: 11 }; // within 2" of the tome holder
    foe.pos = { x: 16, y: 11 };
    const gambit = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: `${TOMES_GAMBIT}:Sanctification|Sanctification` },
      ctx,
    ).state;
    const shotgun = profileOf(CARD.hexorcist, 'Shotgun');
    const ev = ctx.hooks.emit('onCollectAttackDice', gambit, {
      state: gambit,
      ctx: attackCtx(gambit.operatives[foe.id]!, gambit.operatives[victim.id]!, 'Shotgun', shotgun),
      count: shotgun.atk,
      mods: zeroStatMods(),
    });
    expect(ev.count).toBe(3);
  });

  it('Consecrated Tome: "it keeps that rule even if that friendly INTERROGATOR operative is removed"', () => {
    expect(ability(CARD.tomeSkull, 'inquisitorial-agent.tome-skull.consecrated-tome')).toContain(
      'Note it keeps that rule even if that friendly INTERROGATOR operative is removed from the killzone',
    );
    const { ctx, state } = setup();
    const after = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: `${TOMES_GAMBIT}:Denunciation|Sanctification` },
      ctx,
    ).state;
    const interrogator = after.operatives[opWith(after, 'p1', CARD.interrogator)]!;
    const skull = after.operatives[opWith(after, 'p1', CARD.tomeSkull)]!;
    interrogator.removed = true;
    expect(tomeOf(after, skull)).toBe('Sanctification');
  });

  it('"…and/or when this operative is activated" raises a real decision, defaulting to keeping the tomes', () => {
    const { ctx, state } = setup();
    const interrogatorId = opWith(state, 'p1', CARD.interrogator);
    const activated = activate(ctx, state, interrogatorId);
    const decision = activated.pending[0]!;
    expect(decision.kind).toBe('inquisitorial-agent.tomes');
    expect(decision.options[0]!.id).toBe('keep');
    const kept = settle(ctx, activated);
    expect(tomeOf(kept, kept.operatives[interrogatorId]!)).toBeUndefined();

    const picked = settle(ctx, activated, () => 'Sanctification|Denunciation');
    expect(tomeOf(picked, picked.operatives[interrogatorId]!)).toBe('Sanctification');
    expect(tomeOf(picked, picked.operatives[opWith(picked, 'p1', CARD.tomeSkull)]!)).toBe('Denunciation');
  });
});

// ---------------------------------------------------------------------------
describe('TOME-SKULL', () => {
  it('Machine: "cannot perform any actions other than Charge, Dash, Fall Back and Reposition"', () => {
    expect(ability(CARD.tomeSkull, 'inquisitorial-agent.tome-skull.machine')).toContain(
      'This operative cannot perform any actions other than Charge, Dash, Fall Back and Reposition',
    );
    const { ctx, state } = setup();
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    const allowed = availableActions(ctx, state, skull).filter((a) => a.ok).map((a) => a.def.id);
    expect(allowed.sort()).toEqual(['Charge', 'Dash', 'Fall Back', 'Reposition']);
  });

  it('Machine: "It cannot retaliate or assist in a fight"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    const fighter = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    fighter.pos = { x: 14.2, y: 11 };
    foe.pos = { x: 15, y: 11 };
    skull.pos = { x: 15, y: 11.75 };
    const after = settle(ctx, activate(ctx, state, fighter.id));
    // "cannot retaliate" is the effect `startFight` reads by name.
    expect(after.effects.some((e) => e.rule === EFFECTS.cannotRetaliate && e.operativeId === skull.id)).toBe(true);
    // "or assist in a fight": the TOME-SKULL is in the enemy's control range but is not counted.
    const ev = ctx.hooks.emit('onFightAssist', after, {
      state: after,
      operative: after.operatives[fighter.id]!,
      assists: 1,
    });
    expect(ev.assists).toBe(0);
  });

  it('Machine: "treat this operative’s APL stat as 1 lower" when determining control of a marker', () => {
    const { ctx, state } = setup();
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 0, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(0); // nothing contests it yet
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    skull.pos = { x: 15, y: 11 };
    const contesting = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 2, p2: 0 },
    });
    expect(contesting.aplByPlayer.p1).toBe(1);
  });

  it('Machine: a Conceal-order TOME-SKULL in cover "cannot be selected as a valid target … except being within 2"', () => {
    const map = testMap({ features: [heavyBlock('wall', 14, 10.4, 1, 1.2, 3)] });
    const { ctx, state } = setup({ map });
    banish(state, 'p1');
    banish(state, 'p2');
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    skull.pos = { x: 13.2, y: 11 };
    skull.order = 'conceal';
    shooter.pos = { x: 19, y: 11 };
    const far = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: skull,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(far.valid).toBe(false);
    expect(far.reason).toContain('Conceal order and is in cover');
    // "…except being within 2"."
    shooter.pos = { x: 15.9, y: 11 };
    const close = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: skull,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(close.valid).toBe(true);
  });

  it('Group Activation records the forced pairing (the engine alternates activations strictly)', () => {
    expect(ability(CARD.tomeSkull, 'inquisitorial-agent.tome-skull.group-activation')).toContain(
      'you must then activate a ready friendly INQUISITORIAL AGENT INTERROGATOR operative',
    );
    const { ctx, state } = setup();
    const skullId = opWith(state, 'p1', CARD.tomeSkull);
    const interrogatorId = opWith(state, 'p1', CARD.interrogator);
    let s = settle(ctx, activate(ctx, state, skullId));
    s = reduce(s, { t: 'EndActivation', operativeId: skullId }, ctx).state;
    const pairing = s.effects.find((e) => e.rule === EFFECTS.groupActivation);
    expect(pairing?.operativeId).toBe(interrogatorId);
    expect(pairing?.data?.['after']).toBe(skullId);
  });
});

// ---------------------------------------------------------------------------
describe('AUTOSAVANT', () => {
  it('Scrivener: "Each subsequent time your opponent uses each ploy … you gain 1CP (max 2CP per TP)"', () => {
    const { ctx, state } = setup();
    state.teams.p2.cp = 20;
    const use = (s: GameState, ployId: string): GameState => {
      const t = { ...s, teams: { ...s.teams } } as GameState;
      t.teams.p2 = { ...t.teams.p2, ploysUsedTP: t.teams.p2.ploysUsedTP.filter((p) => p !== ployId) };
      return reduce(t, { t: 'UsePloy', player: 'p2', ployId }, ctx).state;
    };
    const before = state.teams.p1.cp;
    let s = use(state, SP.irrefutableJurisdiction); // first use of that ploy: not "subsequent"
    expect(s.teams.p1.cp).toBe(before);
    s = use(s, SP.irrefutableJurisdiction);
    expect(s.teams.p1.cp).toBe(before + 1);
    s = use(s, SP.irrefutableJurisdiction);
    expect(s.teams.p1.cp).toBe(before + 2);
    s = use(s, SP.irrefutableJurisdiction); // "to a maximum of 2CP per turning point"
    expect(s.teams.p1.cp).toBe(before + 2);
  });

  it('Irrefutable Report: "it always controls that marker. This takes precedence over all other rules"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const savant = state.operatives[opWith(state, 'p1', CARD.autosavant)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    foeA.pos = { x: 15, y: 11.4 };
    foeB.pos = { x: 15, y: 10.6 };
    expect(markerController(ctx, state, state.markers['centre']!)).toBe('p2');
    savant.pos = { x: 15.4, y: 11 };
    expect(markerController(ctx, state, state.markers['centre']!)).toBe('p1');
  });

  it('Lightly Armed: no COMBAT DAGGER and "or perform unique actions"', () => {
    expect(ability(CARD.autosavant, 'inquisitorial-agent.autosavant-agent.lightly-armed')).toContain(
      'cannot use any weapons that aren’t on its datacard, or perform unique actions',
    );
    const { ctx, state } = setup({ cards: [CARD.scionVox], equipment: [EQ.daggers] });
    const savantId = opWith(state, 'p1', CARD.autosavant);
    const questkeeperId = opWith(state, 'p1', CARD.questkeeper);
    const s = settle(ctx, activate(ctx, state, questkeeperId));
    const granted = (id: string): string[] =>
      ((s.operatives[id] as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map(
        (w) => w.name,
      );
    expect(granted(questkeeperId)).toEqual(['Combat dagger']);
    expect(granted(savantId)).toEqual([]);
    const blocked = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[savantId]!,
      action: ACT.signal,
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DEATH WORLD VETERAN', () => {
  it('Hunter: "can perform the Charge action while it has a Conceal order"', () => {
    expect(ability(CARD.deathWorldVeteran, 'inquisitorial-agent.death-world-veteran-agent.hunter')).toContain(
      'can perform the Charge action while it has a Conceal order',
    );
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const vet = state.operatives[opWith(state, 'p1', CARD.deathWorldVeteran)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    vet.pos = { x: 12, y: 11 };
    foe.pos = { x: 15, y: 11 };
    const s = settle(ctx, activate(ctx, state, vet.id, 'conceal'));
    expect(getAction('Charge')!.check(ctx, s, s.operatives[vet.id]!, { path: { points: [{ x: 14.2, y: 11 }] } }).ok).toBe(
      false,
    );
    const hunter = getAction(HUNTER_CHARGE)!;
    expect(hunter.treatedAs).toBe('Charge');
    expect(hunter.check(ctx, s, s.operatives[vet.id]!, { path: { points: [{ x: 14.2, y: 11 }] } }).ok).toBe(true);
    // Only the DEATH WORLD VETERAN gets it.
    expect(hunter.available!(ctx, s, s.operatives[opWith(s, 'p1', CARD.questkeeper)]!)).toBe(false);
  });

  it('Weathered: "once per turning point … ignore the damage inflicted on it from one normal success"', () => {
    expect(ability(CARD.deathWorldVeteran, 'inquisitorial-agent.death-world-veteran-agent.weathered')).toContain(
      'you can ignore the damage inflicted on it from one normal success',
    );
    const { ctx, state } = setup();
    const vet = state.operatives[opWith(state, 'p1', CARD.deathWorldVeteran)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    fakeFight(state, foe.id, vet.id, 'Eviscerator');
    const dmgN = profileOf(CARD.questkeeper, 'Eviscerator').dmgN; // 5
    const before = vet.wounds;
    inflictDamage(ctx, state, vet, dmgN, 'attack');
    expect(vet.wounds).toBe(before); // ignored
    inflictDamage(ctx, state, vet, dmgN, 'attack');
    expect(vet.wounds).toBe(before - dmgN); // once per turning point
  });
});

// ---------------------------------------------------------------------------
describe('ENLIGHTENER', () => {
  it('No Escape: "on a 4+, that enemy operative cannot perform that action during that activation"', () => {
    expect(ability(CARD.enlightener, 'inquisitorial-agent.enlightener-agent.no-escape')).toContain(
      'on a 4+, that enemy operative cannot perform that action during that activation',
    );
    const { ctx, state } = setup({ script: [4] });
    banish(state, 'p1');
    banish(state, 'p2');
    const enlightener = state.operatives[opWith(state, 'p1', CARD.enlightener)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    enlightener.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    const s = settle(ctx, activate(ctx, state, foe.id));
    expect(s.effects.some((e) => e.rule === EFFECTS.noEscape && e.operativeId === foe.id)).toBe(true);
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[foe.id]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
  });

  it('No Escape rolls under 4 leave the Fall Back alone', () => {
    const { ctx, state } = setup({ script: [3] });
    banish(state, 'p1');
    banish(state, 'p2');
    const enlightener = state.operatives[opWith(state, 'p1', CARD.enlightener)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    enlightener.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    const s = settle(ctx, activate(ctx, state, foe.id));
    expect(s.effects.some((e) => e.rule === EFFECTS.noEscape)).toBe(false);
  });

  it('Extract Information: "Whenever an enemy operative is incapacitated within this operative’s control range, you gain 1CP"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const enlightener = state.operatives[opWith(state, 'p1', CARD.enlightener)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    enlightener.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    const before = state.teams.p1.cp;
    inflictDamage(ctx, state, foe, 99, 'other');
    expect(state.teams.p1.cp).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
describe('HEXORCIST', () => {
  it('Hexorcise: "your opponent cannot re-roll their attack or defence dice for that operative"', () => {
    expect(ability(CARD.hexorcist, 'inquisitorial-agent.hexorcist-agent.hexorcise')).toContain(
      'your opponent cannot re-roll their attack or defence dice for that operative',
    );
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const hexorcist = state.operatives[opWith(state, 'p1', CARD.hexorcist)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.enlightener)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    hexorcist.pos = { x: 15, y: 11 };
    foe.pos = { x: 19, y: 11 };
    victim.pos = { x: 9, y: 11 };
    const blades = profileOf(CARD.enlightener, 'Paired blades');
    const actx = attackCtx(foe, victim, 'Paired blades', blades, 'melee');
    const grants = [{ id: 'balanced', label: 'Balanced', mode: 'one' as const, max: 1 }];
    const stripped = ctx.hooks.emit('onRollAttack', state, { state, ctx: actx, dice: [], rerolls: [...grants] });
    expect(stripped.rerolls).toEqual([]);
    const def = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(victim, foe, 'Autopistol', profileOf(CARD.questkeeper, 'Autopistol')),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [{ id: 'commandReroll:defence', label: 'Command Re-roll', mode: 'one' as const, cp: 1, player: 'p2' as PlayerId }],
    });
    expect(def.rerolls).toEqual([]);
    // Beyond 6" the rule does nothing.
    foe.pos = { x: 24, y: 11 };
    const kept = ctx.hooks.emit('onRollAttack', state, { state, ctx: actx, dice: [], rerolls: [...grants] });
    expect(kept.rerolls).toHaveLength(1);
  });

  it('CHASTEN: "Until the end of that enemy operative’s next activation, it’s treated as not having that additional rule"', () => {
    expect(actionText(CARD.hexorcist, ACT.chasten)).toContain(
      'select one additional rule (including a unique action) that enemy operative has on its datacard',
    );
    const { ctx, state } = setup({ p2cards: [CARD.scionVox] });
    banish(state, 'p1');
    banish(state, 'p2');
    const hexorcist = state.operatives[opWith(state, 'p1', CARD.hexorcist)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.scionVox)]!;
    hexorcist.pos = { x: 12, y: 11 };
    foe.pos = { x: 16, y: 11 };
    // "excluding … a rule that states it is ignored for the kill/elimination op" — Expendable.
    const skull = state.operatives[opWith(state, 'p2', CARD.tomeSkull)]!;
    expect(chastenableRules(ctx, skull).map((r) => r.name)).toEqual(['Consecrated Tome', 'Machine', 'Group Activation']);

    let s = settle(ctx, activate(ctx, state, hexorcist.id));
    const res = act(ctx, s, hexorcist.id, ACT.chasten, { targetOperativeId: foe.id, choice: ACT.signal });
    expect(res.ok).toBe(true);
    s = res.state;
    expect(chastenedRule(s, s.operatives[foe.id]!)).toBe(ACT.signal);
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[foe.id]!,
      action: ACT.signal,
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    // "This operative cannot perform this action while within control range of an enemy operative."
    s.operatives[foe.id]!.pos = { x: 12.6, y: 11 };
    expect(getAction(ACT.chasten)!.check(ctx, s, s.operatives[hexorcist.id]!, { targetOperativeId: foe.id }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('MYSTIC', () => {
  it('Icon Bearer: "treat this operative’s APL stat as 1 higher" when determining control of a marker', () => {
    const { ctx, state } = setup();
    const mystic = state.operatives[opWith(state, 'p1', CARD.mystic)]!;
    mystic.pos = { x: 15, y: 11 };
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 2, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(3);
  });

  it('SCRY: "Select one friendly INQUISITORIAL AGENT operative within 6" of this operative"', () => {
    expect(actionText(CARD.mystic, ACT.scry)).toContain('PSYCHIC.');
    const { ctx, state } = setup();
    banish(state, 'p1');
    const mystic = state.operatives[opWith(state, 'p1', CARD.mystic)]!;
    const friend = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    mystic.pos = { x: 10, y: 11 };
    friend.pos = { x: 13, y: 11 };
    let s = settle(ctx, activate(ctx, state, mystic.id));
    const res = act(ctx, s, mystic.id, ACT.scry, { targetOperativeId: friend.id });
    expect(res.ok).toBe(true);
    s = res.state;
    expect(s.effects.some((e) => e.rule === EFFECTS.scry && e.operativeId === friend.id)).toBe(true);
    // "…or until it performs this action again": a second SCRY replaces the first.
    const solo = setup().state;
    banish(solo, 'p1');
    const mystic2 = solo.operatives[opWith(solo, 'p1', CARD.mystic)]!;
    mystic2.pos = { x: 10, y: 11 };
    // The printed text says "one friendly INQUISITORIAL AGENT operative", not "one other", so
    // with everything else out of reach the MYSTIC is a legal target for itself.
    const alone = getAction(ACT.scry)!.check(ctx, solo, mystic2, {});
    expect(alone.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('PENAL LEGIONNAIRE', () => {
  it('Chem-mask: "You can ignore any changes to this operative’s APL stat"', () => {
    const { ctx, state } = setup();
    const penal = state.operatives[opWith(state, 'p1', CARD.penalLegionnaire)]!;
    const other = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    penal.aplMods.push(-1);
    other.aplMods.push(-1);
    expect(aplOf(ctx, state, other)).toBe(1);
    expect(aplOf(ctx, state, penal)).toBe(2);
  });

  it('Chem-mask: "…and any changes to its stats from being injured", and no enemy Shock or Stun', () => {
    expect(ability(CARD.penalLegionnaire, 'inquisitorial-agent.penal-legionnaire-agent.chem-mask')).toContain(
      'This operative isn’t affected by enemy operatives’ Shock and Stun weapon rules',
    );
    const { ctx, state } = setup();
    const penal = state.operatives[opWith(state, 'p1', CARD.penalLegionnaire)]!;
    const other = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    penal.wounds = 2; // injured (7 wounds)
    other.wounds = 2;
    const chainsword = profileOf(CARD.penalLegionnaire, 'Chainsword');
    const eviscerator = profileOf(CARD.questkeeper, 'Eviscerator');
    expect(moveOf(ctx, state, other)).toBe(4); // 6 - 2
    expect(moveOf(ctx, state, penal)).toBe(6);
    expect(hitOf(ctx, state, other, eviscerator)).toBe(eviscerator.hit + 1);
    expect(hitOf(ctx, state, penal, chainsword)).toBe(chainsword.hit);
    // Shock / Stun on an ENEMY weapon are dropped when it is used against this operative.
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const shocking: WeaponProfile = { ...eviscerator, rules: [...eviscerator.rules, { id: 'Shock', raw: 'Shock' }] };
    const against = effectiveRules(ctx, state, shocking, {
      operative: foe,
      target: penal,
      weaponName: 'Eviscerator',
    });
    expect(against.some((r) => r.id === 'Shock')).toBe(false);
    const elsewhere = effectiveRules(ctx, state, shocking, {
      operative: foe,
      target: other,
      weaponName: 'Eviscerator',
    });
    expect(elsewhere.some((r) => r.id === 'Shock')).toBe(true);
  });

  it('Cruel: "…against a wounded enemy operative, this operative’s weapons have the Relentless weapon rule"', () => {
    const { ctx, state } = setup();
    const penal = state.operatives[opWith(state, 'p1', CARD.penalLegionnaire)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const flamer = profileOf(CARD.penalLegionnaire, 'Hand flamer');
    expect(
      effectiveRules(ctx, state, flamer, { operative: penal, target: foe, weaponName: 'Hand flamer' }).some(
        (r) => r.id === 'Relentless',
      ),
    ).toBe(false);
    foe.wounds -= 1;
    expect(
      effectiveRules(ctx, state, flamer, { operative: penal, target: foe, weaponName: 'Hand flamer' }).some(
        (r) => r.id === 'Relentless',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('PISTOLIER', () => {
  it('Pistolier: "You can ignore any changes to the Hit stat of this operative’s ranged weapons"', () => {
    const { ctx, state } = setup();
    const pistolier = state.operatives[opWith(state, 'p1', CARD.pistolier)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const plasma = profileOf(CARD.pistolier, 'Scoped plasma pistol', 'standard');
    pistolier.wounds = 2; // injured: "worsen the Hit stat of their weapons by 1"
    expect(hitOf(ctx, state, pistolier, plasma)).toBe(plasma.hit + 1);
    fakeShoot(state, pistolier.id, foe.id, 'Scoped plasma pistol', { profileName: 'standard' });
    expect(hitOf(ctx, state, pistolier, plasma)).toBe(plasma.hit);
    // A point-blank shot worsens the Hit stat by 1 outside `StatMods`; that is a change too.
    (state.sequence as { pointBlank: boolean }).pointBlank = true;
    expect(hitOf(ctx, state, pistolier, plasma, -1)).toBe(plasma.hit);
  });

  it('PISTOL BARRAGE: "two free Shoot actions … scoped plasma pistol for one and suppressed autopistol for the other"', () => {
    expect(actionText(CARD.pistolier, ACT.pistolBarrage)).toContain(
      'You must select a profile of its scoped plasma pistol for one action and its suppressed autopistol for the other',
    );
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const pistolier = state.operatives[opWith(state, 'p1', CARD.pistolier)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gunServitor)]!; // 11 wounds: it survives
    pistolier.pos = { x: 12, y: 11 };
    foe.pos = { x: 16, y: 11 };
    let s = settle(ctx, activate(ctx, state, pistolier.id));
    // "cannot perform this action while it has a Conceal order"
    s.operatives[pistolier.id]!.order = 'conceal';
    expect(getAction(ACT.pistolBarrage)!.check(ctx, s, s.operatives[pistolier.id]!, { targetId: foe.id }).ok).toBe(false);
    s.operatives[pistolier.id]!.order = 'engage';
    const first = act(ctx, s, pistolier.id, ACT.pistolBarrage, { targetId: foe.id });
    expect(first.ok).toBe(true);
    s = settle(ctx, first.state);
    expect(s.operatives[pistolier.id]!.actionsThisActivation).toContain(ACT.pistolBarrage);
    const second = act(ctx, s, pistolier.id, PISTOL_BARRAGE_2, { targetId: foe.id });
    expect(second.ok).toBe(true);
    s = settle(ctx, second.state);
    // The whole barrage costs the printed 1AP.
    expect(s.operatives[pistolier.id]!.apSpent).toBe(1);
    // "…or during an activation in which it performed the Shoot action (or vice versa)."
    const withShoot = { ...s } as GameState;
    withShoot.operatives[pistolier.id]!.actionsThisActivation = ['Shoot'];
    expect(getAction(ACT.pistolBarrage)!.check(ctx, withShoot, withShoot.operatives[pistolier.id]!, { targetId: foe.id }).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
describe('QUESTKEEPER', () => {
  it('Irrepressible Purpose: "you can strike the enemy operative in that sequence with one of your unresolved successes"', () => {
    expect(ability(CARD.questkeeper, 'inquisitorial-agent.questkeeper-agent.irrepressible-purpose')).toContain(
      'you can strike the enemy operative in that sequence with one of your unresolved successes',
    );
    const { ctx, state } = setup();
    const questkeeper = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.enlightener)]!;
    fakeFight(state, foe.id, questkeeper.id, 'Paired blades', {
      defenderWeapon: 'Eviscerator',
      defenderDice: [{ value: 6, state: 'crit' }],
    });
    const before = foe.wounds;
    inflictDamage(ctx, state, questkeeper, 99, 'attack');
    expect(questkeeper.incapacitated).toBe(true);
    expect(before - foe.wounds).toBe(profileOf(CARD.questkeeper, 'Eviscerator').dmgC); // 6
  });

  it('Zealot: "Whenever an attack dice inflicts damage of 3 or more … on a 5+, subtract 1"', () => {
    const { ctx, state } = setup({ script: [5, 1] });
    const questkeeper = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const before = questkeeper.wounds;
    inflictDamage(ctx, state, questkeeper, 3, 'attack');
    expect(questkeeper.wounds).toBe(before - 2); // 5+ → 1 less
    inflictDamage(ctx, state, questkeeper, 3, 'attack');
    expect(questkeeper.wounds).toBe(before - 5); // 1 → full damage
    // Damage under 3 never triggers it.
    const after = questkeeper.wounds;
    inflictDamage(ctx, state, questkeeper, 2, 'attack');
    expect(questkeeper.wounds).toBe(after - 2);
  });
});

// ---------------------------------------------------------------------------
describe('GUN SERVITOR › Lobotomised', () => {
  it('"…visible to and within 3" of another friendly … operative (excluding GUN SERVITOR) … add 1 to its APL stat"', () => {
    expect(ability(CARD.gunServitor, 'inquisitorial-agent.requisitioned-gun-servitor.lobotomised')).toContain(
      'add 1 to this operative’s APL stat until the end of that activation',
    );
    const { ctx, state } = setup();
    banish(state, 'p1');
    const servitorId = opWith(state, 'p1', CARD.gunServitor);
    const servitor = state.operatives[servitorId]!;
    servitor.pos = { x: 10, y: 11 };
    // Alone: APL stays 1.
    const alone = settle(ctx, activate(ctx, state, servitorId));
    expect(aplOf(ctx, alone, alone.operatives[servitorId]!)).toBe(1);

    const s2 = setup().state;
    const ctx2 = ctx;
    banish(s2, 'p1');
    const servitor2 = s2.operatives[opWith(s2, 'p1', CARD.gunServitor)]!;
    const friend = s2.operatives[opWith(s2, 'p1', CARD.questkeeper)]!;
    servitor2.pos = { x: 10, y: 11 };
    friend.pos = { x: 12, y: 11 };
    const boosted = settle(ctx2, activate(ctx2, s2, servitor2.id));
    expect(aplOf(ctx2, boosted, boosted.operatives[servitor2.id]!)).toBe(2);
    // "until the end of that activation" — the +1 is popped, not leaked.
    const ended = reduce(boosted, { t: 'EndActivation', operativeId: servitor2.id }, ctx2).state;
    expect(ended.operatives[servitor2.id]!.aplMods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('SISTER OF SILENCE › Psychic Null', () => {
  const psychicProfile = (): WeaponProfile => ({
    type: 'ranged',
    atk: 4,
    hit: 3,
    dmgN: 3,
    dmgC: 4,
    rules: [{ id: 'PSYCHIC', raw: 'PSYCHIC' }],
  });

  it('"PSYCHIC ranged weapons cannot inflict damage on this operative"', () => {
    const { ctx, state } = setup({ cards: [CARD.prosecutor] });
    const sister = state.operatives[opWith(state, 'p1', CARD.prosecutor)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    // A PSYCHIC ranged weapon standing in for the enemy's; the sequence names the profile.
    const card = ctx.datacards.get(foe.datacardId)!;
    const original = card.weapons;
    ctx.datacards.set(foe.datacardId, { ...card, weapons: [{ name: 'Witchfire', profiles: [psychicProfile()] }] });
    fakeShoot(state, foe.id, sister.id, 'Witchfire');
    const before = sister.wounds;
    inflictDamage(ctx, state, sister, 4, 'attack');
    expect(sister.wounds).toBe(before);
    ctx.datacards.set(foe.datacardId, { ...card, weapons: original });
  });

  it('within 6": "cannot perform PSYCHIC actions" and "cannot use PSYCHIC ranged weapons"', () => {
    const { ctx, state } = setup({ cards: [CARD.prosecutor] });
    banish(state, 'p1');
    const sister = state.operatives[opWith(state, 'p1', CARD.prosecutor)]!;
    const mystic = state.operatives[opWith(state, 'p1', CARD.mystic)]!;
    sister.pos = { x: 10, y: 11 };
    mystic.pos = { x: 14, y: 11 };
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: mystic,
      action: ACT.scry,
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('SISTER OF SILENCE');
    mystic.pos = { x: 20, y: 11 };
    expect(
      ctx.hooks.emit('canPerformAction', state, { state, operative: mystic, action: ACT.scry, allowed: true }).allowed,
    ).toBe(true);
    // "That operative cannot use PSYCHIC ranged weapons."
    mystic.pos = { x: 14, y: 11 };
    const card = ctx.datacards.get(mystic.datacardId)!;
    ctx.datacards.set(mystic.datacardId, {
      ...card,
      weapons: [...card.weapons, { name: 'Witchfire', profiles: [psychicProfile()] }],
    });
    const names = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: mystic,
      weapons: ['Autopistol', 'Fists', 'Witchfire'],
    }).weapons;
    expect(names).toEqual(['Autopistol', 'Fists']);
    ctx.datacards.set(mystic.datacardId, card);
  });

  it('"PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4"', () => {
    const { ctx, state } = setup({ cards: [CARD.prosecutor] });
    banish(state, 'p1');
    banish(state, 'p2');
    const sister = state.operatives[opWith(state, 'p1', CARD.prosecutor)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    sister.pos = { x: 15, y: 11 };
    foe.pos = { x: 18, y: 11 };
    const forceSword: WeaponProfile = {
      type: 'melee',
      atk: 4,
      hit: 3,
      dmgN: 5,
      dmgC: 7,
      rules: [
        { id: 'PSYCHIC', raw: 'PSYCHIC' },
        { id: 'Lethal', x: 5, raw: 'Lethal 5+' },
      ],
    };
    const rules = effectiveRules(ctx, state, forceSword, { operative: foe, target: sister, weaponName: 'Force sword' });
    expect(rules).toEqual([]);
    const card = ctx.datacards.get(foe.datacardId)!;
    ctx.datacards.set(foe.datacardId, { ...card, weapons: [{ name: 'Force sword', profiles: [forceSword] }] });
    fakeFight(state, foe.id, sister.id, 'Force sword');
    const before = sister.wounds;
    inflictDamage(ctx, state, sister, 7, 'attack');
    expect(before - sister.wounds).toBe(4); // capped at the critical 4
    ctx.datacards.set(foe.datacardId, card);
  });
});

// ---------------------------------------------------------------------------
describe('TEMPESTUS SCION', () => {
  it('Medic!: "that friendly operative isn’t incapacitated, has 1 wound remaining"', () => {
    expect(ability(CARD.scionMedic, 'inquisitorial-agent.tempestus-scion-medic.medic')).toContain(
      'that friendly operative isn’t incapacitated, has 1 wound remaining and cannot be incapacitated for the remainder of the action',
    );
    const { ctx, state } = setup({ cards: [CARD.scionMedic] });
    banish(state, 'p1');
    banish(state, 'p2');
    const medic = state.operatives[opWith(state, 'p1', CARD.scionMedic)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    medic.pos = { x: 10, y: 11 };
    victim.pos = { x: 12, y: 11 };
    inflictDamage(ctx, state, victim, 99, 'other');
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(1);
    // "…cannot be incapacitated for the remainder of the action."
    inflictDamage(ctx, state, victim, 99, 'other');
    expect(victim.incapacitated).toBeFalsy();
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations."
    expect(aplOf(ctx, state, medic)).toBe(1);
    // The victim is subtracted from as well, so its APL STAT is 1. "That friendly operative can
    // immediately perform a free Dash action" grants an action, not a stat change, so it does
    // not net off against that -1 (docs/DECISIONS.md D-100): it is one AP on top of the stat,
    // and it is the last AP the victim spends.
    expect(aplOf(ctx, state, victim)).toBe(1);
    expect(freeApOf(state, victim)).toBe(1);
    expect(apBudgetOf(ctx, state, victim)).toBe(2);
    victim.apSpent = 1;
    expect(
      ctx.hooks.emit('canPerformAction', state, { state, operative: victim, action: 'Shoot', allowed: true }).allowed,
    ).toBe(false);
    expect(
      ctx.hooks.emit('canPerformAction', state, { state, operative: victim, action: 'Dash', allowed: true }).allowed,
    ).toBe(true);
    // "The FIRST time during each turning point" — a second operative is not saved.
    const other = state.operatives[opWith(state, 'p1', CARD.enlightener)]!;
    other.pos = { x: 11, y: 11 };
    inflictDamage(ctx, state, other, 99, 'other');
    expect(other.incapacitated).toBe(true);
  });

  it('MEDIKIT: "Select one friendly … operative within this operative’s control range to regain up to 2D3 lost wounds"', () => {
    const { ctx, state } = setup({ cards: [CARD.scionMedic], script: [5, 5] });
    banish(state, 'p1');
    banish(state, 'p2');
    const medic = state.operatives[opWith(state, 'p1', CARD.scionMedic)]!;
    const patient = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    medic.pos = { x: 10, y: 11 };
    patient.pos = { x: 10.8, y: 11 };
    patient.wounds = 1;
    let s = settle(ctx, activate(ctx, state, medic.id));
    const res = act(ctx, s, medic.id, ACT.medikit, { targetOperativeId: patient.id });
    expect(res.ok).toBe(true);
    s = res.state;
    expect(s.operatives[patient.id]!.wounds).toBe(7); // 1 + 3 + 3 = 7, capped at the printed 7
    // Nothing in control range → refused in `check` (D-026), never in `perform`.
    s.operatives[patient.id]!.pos = { x: 20, y: 1 };
    expect(getAction(ACT.medikit)!.check(ctx, s, s.operatives[medic.id]!, {}).ok).toBe(false);
  });

  it('Adaptive Equipment: the Smoke and Stun Grenade actions, "once per turning point" each and free of the equipment', () => {
    expect(ability(CARD.scionTrooper, 'inquisitorial-agent.tempestus-scion-trooper.adaptive-equipment')).toContain(
      'Performing these actions using this rule doesn’t count towards their action limits',
    );
    const { ctx, state } = setup({ cards: [CARD.scionTrooper] });
    banish(state, 'p1');
    banish(state, 'p2');
    const trooper = state.operatives[opWith(state, 'p1', CARD.scionTrooper)]!;
    trooper.pos = { x: 10, y: 11 };
    let s = settle(ctx, activate(ctx, state, trooper.id));
    expect(s.teams.p1.equipment).not.toContain('eq.utilityGrenades');
    const res = act(ctx, s, trooper.id, SMOKE_ADAPTIVE, { targetPos: { x: 12, y: 11 } });
    expect(res.ok).toBe(true);
    s = res.state;
    expect(Object.values(s.markers).some((m) => m.kind === 'smoke')).toBe(true);
    // The kill team's grenade allowance is untouched.
    expect(s.teams.p1.equipmentUses).toEqual({});
    // "once per turning point"
    expect(getAction(SMOKE_ADAPTIVE)!.check(ctx, s, s.operatives[trooper.id]!, { targetPos: { x: 12, y: 11 } }).ok).toBe(
      false,
    );
    expect(getAction(STUN_ADAPTIVE)!.available!(ctx, s, s.operatives[trooper.id]!)).toBe(true);
  });

  it('SIGNAL: "add 1 to its APL stat", and "can perform this action twice during its activation"', () => {
    expect(actionText(CARD.scionVox, ACT.signal)).toContain('This operative can perform this action twice during its activation');
    const { ctx, state } = setup({ cards: [CARD.scionVox] });
    banish(state, 'p1');
    const vox = state.operatives[opWith(state, 'p1', CARD.scionVox)]!;
    const a = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const b = state.operatives[opWith(state, 'p1', CARD.enlightener)]!;
    vox.pos = { x: 10, y: 11 };
    a.pos = { x: 12, y: 11 };
    b.pos = { x: 13.5, y: 11 };
    let s = settle(ctx, activate(ctx, state, vox.id));
    s = act(ctx, s, vox.id, ACT.signal, { targetOperativeId: a.id }).state;
    expect(aplOf(ctx, s, s.operatives[a.id]!)).toBe(3);
    // The repeat is its own action, because action restrictions forbid a second SIGNAL.
    expect(getAction(ACT.signal)!.check(ctx, s, s.operatives[vox.id]!, { targetOperativeId: b.id }).ok).toBe(true);
    const second = act(ctx, s, vox.id, SIGNAL_2, { targetOperativeId: b.id });
    expect(second.ok).toBe(true);
    s = second.state;
    expect(aplOf(ctx, s, s.operatives[b.id]!)).toBe(3);
    expect(s.operatives[vox.id]!.apSpent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('DENOUNCE: the D3 lock, and "costs you 1 additional CP for each previous time you’ve used it"', () => {
    expect(rule(SP.denounce)).toContain('cannot be activated or perform actions until it’s the last enemy operative');
    const { ctx, state } = setup({ script: [5] }); // d3 = 3
    const foeId = opWith(state, 'p2', CARD.questkeeper);
    expect(denounceCost(state, 'p1')).toBe(1);
    let s = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: SP.denounce, data: { operativeId: foeId } },
      ctx,
    ).state;
    expect(s.teams.p1.cp).toBe(7); // 8 - 1
    expect(denounceCost(s, 'p1')).toBe(2); // "2CP the second time"
    const foe = s.operatives[foeId]!;
    expect(denounced(s, foe)).toBe(true);
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: foe, action: 'Shoot', allowed: true }).allowed,
    ).toBe(false);
    // Three enemy activations later the lock lifts.
    const eff = s.effects.find((e) => e.rule === EFFECTS.denounce)!;
    eff.data = { ...eff.data, activations: 3 };
    expect(denounced(s, foe)).toBe(false);
    // The escalated cost is charged on the next use.
    s.phase = 'strategy';
    s.strategyStep = 'gambit';
    s.teams.p1.gambitsUsedTP = [];
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: SP.denounce, data: { operativeId: foeId } }, ctx).state;
    expect(s.teams.p1.cp).toBe(5); // 7 - 2
    // …and the gambit is not offered when you cannot pay it.
    expect(denounceCost(s, 'p1')).toBe(3);
    s.teams.p1.cp = 3;
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitIds(ctx, s, 'p1')).toContain(SP.denounce);
    s.teams.p1.cp = 2;
    expect(gambitIds(ctx, s, 'p1')).not.toContain(SP.denounce);
  });

  it('INTENSE SCRUTINY: "enemy operatives within 4" of it cannot be in cover (instead of 2")"', () => {
    const map = testMap({ features: [heavyBlock('wall', 14, 10.4, 1, 1.2, 3)] });
    const { ctx, state } = setup({ map });
    banish(state, 'p1');
    banish(state, 'p2');
    const shooter = state.operatives[opWith(state, 'p1', CARD.hexorcist)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    shooter.pos = { x: 12, y: 11 };
    foe.pos = { x: 15.6, y: 11 }; // behind the wall, 3.1" away
    const before = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: foe,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(before.ignoreCoverTerrain).toBe('none');
    state.teams.p1.gambitsUsedTP = [SP.intenseScrutiny];
    const after = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: foe,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(after.ignoreCoverTerrain).toBe('all');
    // "…it doesn't remove their cover save (if any)."
    fakeShoot(state, shooter.id, foe.id, 'Shotgun');
    const def = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, foe, 'Shotgun', profileOf(CARD.hexorcist, 'Shotgun')),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(def.coverSave).toBe(true);
  });

  it('QUARRY: Ceaseless against the quarry, and a new quarry when it is incapacitated', () => {
    expect(rule(SP.quarry)).toContain('that friendly operative’s weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const shooter = state.operatives[opWith(state, 'p1', CARD.hexorcist)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const other = state.operatives[opWith(state, 'p2', CARD.enlightener)]!;
    shooter.pos = { x: 12, y: 11 };
    foe.pos = { x: 15, y: 11 };
    other.pos = { x: 17, y: 11 };
    const s = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: SP.quarry, data: { operativeId: foe.id } },
      ctx,
    ).state;
    expect(quarryOf(s, 'p1')).toBe(foe.id);
    const shotgun = profileOf(CARD.hexorcist, 'Shotgun');
    const has = (target: OperativeState): boolean =>
      effectiveRules(ctx, s, shotgun, { operative: s.operatives[shooter.id]!, target, weaponName: 'Shotgun' }).some(
        (r) => r.id === 'Ceaseless',
      );
    expect(has(s.operatives[foe.id]!)).toBe(true);
    expect(has(s.operatives[other.id]!)).toBe(false);
    // "Whenever your quarry is incapacitated, you can select a new enemy operative."
    inflictDamage(ctx, s, s.operatives[foe.id]!, 99, 'other');
    expect(quarryOf(s, 'p1')).toBe(other.id);
  });

  it('IRREFUTABLE JURISDICTION: one defence die within 3" of an objective, a whole result while contesting it', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    state.teams.p1.gambitsUsedTP = [SP.irrefutableJurisdiction];
    const defender = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    // Not the HEXORCIST: within 6" its own Hexorcise would strip the grant.
    const shooter = state.operatives[opWith(state, 'p2', CARD.enlightener)]!;
    shooter.pos = { x: 20, y: 11 };
    const grant = (): { id: string; mode: string }[] => {
      const ev = ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, defender, 'Autopistol', profileOf(CARD.enlightener, 'Autopistol')),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
      return ev.rerolls.map((r) => ({ id: r.id, mode: r.mode }));
    };
    defender.pos = { x: 12, y: 3 }; // nowhere near an objective
    expect(grant()).toEqual([]);
    defender.pos = { x: 17.4, y: 11 }; // within 3" of the centre objective, not contesting it
    expect(grant()).toEqual([{ id: 'inquisitorial-agent.irrefutableJurisdiction', mode: 'one' }]);
    defender.pos = { x: 15.5, y: 11 }; // contesting it
    expect(grant()).toEqual([{ id: 'inquisitorial-agent.irrefutableJurisdiction', mode: 'value' }]);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('ABSOLUTE AUTHORITY: the CP is refunded and the ploy cannot be used again this turning point', () => {
    expect(rule(FP.absoluteAuthority)).toContain(
      'Their ploy isn’t used, the CP spent on it is refunded and they cannot use that ploy again during this turning point',
    );
    const { ctx, state } = setup();
    // Nothing to stop yet.
    expect(inquisitorialAgent.ploys.find((p) => p.id === FP.absoluteAuthority)!.usable!(state, 'p1').ok).toBe(false);
    let s = reduce(state, { t: 'UsePloy', player: 'p2', ployId: SP.quarry }, ctx).state;
    expect(s.teams.p2.cp).toBe(7);
    expect(inquisitorialAgent.ploys.find((p) => p.id === FP.absoluteAuthority)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.absoluteAuthority }, ctx).state;
    expect(s.teams.p1.cp).toBe(7);
    expect(s.teams.p2.cp).toBe(8); // refunded
    expect(s.teams.p2.ploysUsedTP).toContain(SP.quarry); // still blocked this TP
    expect(reduce(s, { t: 'UsePloy', player: 'p2', ployId: SP.quarry }, ctx).ok).toBe(false);
    // "This ploy cannot be used to stop the same ploy more than once per battle."
    s.teams.p1.ploysUsedTP = [];
    expect(inquisitorialAgent.ploys.find((p) => p.id === FP.absoluteAuthority)!.usable!(s, 'p1').ok).toBe(false);
  });

  it('RELENTLESS IN PURSUIT: the free Reposition or Charge is AP outside the APL stat', () => {
    expect(rule(FP.relentlessInPursuit)).toContain(
      'that friendly INQUISITORIAL AGENT operative can either perform a free Reposition action',
    );
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const mine = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const usable = inquisitorialAgent.ploys.find((p) => p.id === FP.relentlessInPursuit)!.usable!;
    expect(usable(state, 'p1').ok).toBe(false);
    mine.pos = { x: 15, y: 11 };
    foe.pos = { x: 16.5, y: 11 };
    expect(usable(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.relentlessInPursuit, data: { operativeId: mine.id } }, ctx)
      .state;
    const boosted = s.operatives[mine.id]!;
    // "can either perform a free Reposition action" is an action, not an APL stat change, so
    // the APL stat is untouched and the operative simply has one AP more to spend than its APL
    // (docs/DECISIONS.md D-100).
    expect(boosted.aplMods).toEqual([]);
    expect(aplOf(ctx, s, boosted)).toBe(2);
    expect(apBudgetOf(ctx, s, boosted)).toBe(3);
    boosted.apSpent = 2;
    const shoot = ctx.hooks.emit('canPerformAction', s, { state: s, operative: boosted, action: 'Shoot', allowed: true });
    expect(shoot.allowed).toBe(false);
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: boosted, action: 'Charge', allowed: true }).allowed,
    ).toBe(true);
    // "immediately": the AP belongs to that one activation and goes away with it, so the
    // operative is back on its printed 2AP afterwards rather than carrying a spare AP around.
    let after = activate(ctx, s, mine.id);
    after = reduce(after, { t: 'EndActivation', operativeId: mine.id }, ctx).state;
    expect(freeApOf(after, after.operatives[mine.id]!)).toBe(0);
    expect(apBudgetOf(ctx, after, after.operatives[mine.id]!)).toBe(2);
  });

  it('THE EMPEROR\'S WILL: "you can ignore any changes to its stats (including its weapons\' stats)"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    mine.aplMods.push(-1);
    mine.wounds = 2; // injured
    const usable = inquisitorialAgent.ploys.find((p) => p.id === FP.emperorsWill)!.usable!;
    expect(usable(state, 'p1').ok).toBe(false);
    state.activeOperativeId = mine.id;
    expect(usable(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.emperorsWill }, ctx).state;
    const op = s.operatives[mine.id]!;
    expect(aplOf(ctx, s, op)).toBe(2);
    expect(moveOf(ctx, s, op)).toBe(6);
    const eviscerator = profileOf(CARD.questkeeper, 'Eviscerator');
    expect(hitOf(ctx, s, op, eviscerator)).toBe(eviscerator.hit);
    // The Atk stat goes back to the printed value, whatever changed it.
    const ev = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(op, s.operatives[foe.id]!, 'Eviscerator', eviscerator, 'melee'),
      count: eviscerator.atk + 2,
      mods: { ...zeroStatMods(), atk: 3 },
    });
    expect(ev.count).toBe(eviscerator.atk);
    expect(ev.mods.atk).toBe(0);
  });

  it('INTIMIDATING PRESENCE: "your opponent must spend 1 additional AP for that enemy operative to perform that action"', () => {
    const { ctx, state } = setup();
    banish(state, 'p1');
    banish(state, 'p2');
    const mine = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const mystic = state.operatives[opWith(state, 'p1', CARD.mystic)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    mine.pos = { x: 15, y: 11 };
    foe.pos = { x: 17, y: 11 };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.intimidatingPresence }, ctx).state;
    const cost = (action: string): number =>
      ctx.hooks.emit('onActionCost', s, { state: s, operative: s.operatives[foe.id]!, action, ap: 1 }).ap;
    expect(cost('Pick Up Marker')).toBe(2);
    expect(cost('Operate Hatch')).toBe(1); // "(excluding Operate Hatch)"
    expect(cost('Shoot')).toBe(1); // not a mission action
    // The MYSTIC reaches 6".
    s.operatives[mine.id]!.pos = { x: 1, y: 1 };
    s.operatives[mystic.id]!.pos = { x: 12, y: 11 };
    expect(cost('Pick Up Marker')).toBe(2);
    s.operatives[mystic.id]!.pos = { x: 8, y: 11 };
    expect(cost('Pick Up Marker')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('INQUISITORIAL ROSETTE: "once per battle … you can select a new enemy operative to be your quarry"', () => {
    expect(rule(EQ.rosette)).toContain('if you’ve used the Quarry strategy ploy during this turning point');
    const { ctx, state } = setup({ equipment: [EQ.rosette] });
    banish(state, 'p1');
    banish(state, 'p2');
    const mine = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const far = state.operatives[opWith(state, 'p2', CARD.questkeeper)]!;
    const near = state.operatives[opWith(state, 'p2', CARD.enlightener)]!;
    mine.pos = { x: 10, y: 11 };
    far.pos = { x: 28, y: 20 };
    near.pos = { x: 13, y: 11 };
    let s = reduce(
      { ...state, phase: 'strategy', strategyStep: 'gambit' } as GameState,
      { t: 'UseGambit', player: 'p1', gambitId: SP.quarry, data: { operativeId: far.id } },
      ctx,
    ).state;
    expect(quarryOf(s, 'p1')).toBe(far.id);
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s = settle(ctx, activate(ctx, s, mine.id));
    expect(quarryOf(s, 'p1')).toBe(near.id);
  });

  it('COMBAT DAGGERS: the printed melee weapon, "+1 Atk for a friendly SISTER OF SILENCE operative"', () => {
    expect(rule(EQ.daggers)).toContain('Whenever a friendly SISTER OF SILENCE operative is using it, add 1 to its Atk stat');
    const { ctx, state } = setup({ cards: [CARD.witchseeker], equipment: [EQ.daggers] });
    const sisterId = opWith(state, 'p1', CARD.witchseeker);
    const questkeeperId = opWith(state, 'p1', CARD.questkeeper);
    const s = settle(ctx, activate(ctx, state, questkeeperId));
    const daggerOf = (id: string): { name: string }[] =>
      ((s.operatives[id] as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []);
    expect(daggerOf(sisterId).map((w) => w.name)).toEqual(['Combat dagger']);
    const dagger = COMBAT_DAGGER.profiles[0]!;
    const foe = s.operatives[opWith(s, 'p2', CARD.questkeeper)]!;
    const sisterAtk = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[sisterId]!, foe, 'Combat dagger', dagger, 'melee'),
      count: dagger.atk,
      mods: zeroStatMods(),
    });
    expect(sisterAtk.count).toBe(4);
    const otherAtk = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[questkeeperId]!, foe, 'Combat dagger', dagger, 'melee'),
      count: dagger.atk,
      mods: zeroStatMods(),
    });
    expect(otherAtk.count).toBe(3);
  });

  it('ARMOURED BODYSUITS: "you can retain one of your defence dice results of 4 as a normal success"', () => {
    const { ctx, state } = setup({ equipment: [EQ.bodysuits] });
    const defender = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!; // 5+ Save
    const shooter = state.operatives[opWith(state, 'p2', CARD.hexorcist)]!;
    fakeShoot(state, shooter.id, defender.id, 'Shotgun', {
      defence: [
        { value: 4, state: 'fail' },
        { value: 4, state: 'fail' },
        { value: 2, state: 'fail' },
      ],
    });
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, defender, 'Shotgun', profileOf(CARD.hexorcist, 'Shotgun')),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    const seq = state.sequence as { defence: { dice: { value: number; state: string }[] } };
    expect(seq.defence.dice.map((d) => d.state)).toEqual(['normal', 'fail', 'fail']); // exactly one
    // "(excluding TOME-SKULL)" — and the TOME-SKULL also has a 5+ Save.
    const skull = state.operatives[opWith(state, 'p1', CARD.tomeSkull)]!;
    fakeShoot(state, shooter.id, skull.id, 'Shotgun', { defence: [{ value: 4, state: 'fail' }] });
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, skull, 'Shotgun', profileOf(CARD.hexorcist, 'Shotgun')),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    const skullSeq = state.sequence as { defence: { dice: { state: string }[] } };
    expect(skullSeq.defence.dice.map((d) => d.state)).toEqual(['fail']);
  });

  it('SERVO-SKULL: "Once per battle, one friendly … operative can perform a mission action for 1 less AP"', () => {
    const { ctx, state } = setup({ equipment: [EQ.servoSkull] });
    const op = state.operatives[opWith(state, 'p1', CARD.questkeeper)]!;
    const missionDef = {
      id: 'test.mission',
      name: 'Test mission action',
      ap: 1,
      type: 'mission' as const,
      sourceText: 'a mission action',
      check: () => ({ ok: true }),
      perform: () => ({ ok: true }),
    };
    registerAction(missionDef);
    expect(actionCost(ctx, state, op, missionDef)).toBe(0);
    // Once the mission action has actually been performed the allowance is spent.
    op.actionsThisActivation = ['test.mission'];
    let s = reduce(state, { t: 'EndActivation', operativeId: op.id }, { ...ctx }).state;
    s.activeOperativeId = op.id;
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(actionCost(ctx, s, s.operatives[op.id]!, missionDef)).toBe(1);
  });
});
