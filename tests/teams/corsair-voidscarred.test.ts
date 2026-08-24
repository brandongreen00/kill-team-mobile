/**
 * CORSAIR VOIDSCARRED. Every test quotes the printed rule it pins, read out of
 * `data/teams/corsair-voidscarred.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/corsair-voidscarred/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, inflictDamage, markerController } from '../../src/core/state.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { rareRuleTextFor, makeTeamHooks } from '../../src/teams/helpers.ts';
import { teamData } from '../../src/teams/data.ts';
import { COUNT_CODES, defaultRoster, entryId, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  A,
  ACT,
  BLINK_CHARGE,
  BLINK_FALL_BACK,
  BLINK_REPOSITION,
  C,
  DASH_BLADEMASTER,
  EQ,
  FP,
  KW,
  PICK_UP_LIGHT_FINGERS,
  PISTOL_BARRAGE_2,
  RULE,
  SHOOT_QUICK_TRIGGER,
  SP,
  blademasterRemaining,
  corsairVoidscarred as CV,
  eruditeEndPositionLegal,
  isolatedFrom,
  movedThisTP,
  psychicRange,
} from '../../src/teams/corsair-voidscarred/index.ts';
import { testMap, vantagePlatform, heavyBlock } from '../fixtures.ts';
import { act, activate, battle, opWith, settle, teamContext } from './harness.ts';

const DATA = teamData('corsair-voidscarred');

const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uaText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Rosters — 11 datacards but only 9 slots (1 FELARCH + 8 from the list), so each test
// builds the kill team the printed rule it pins actually needs.
// ---------------------------------------------------------------------------

const LIST_INDEX = new Map(DATA.selection.list.map((e, i) => [e.datacardId, i]));

function pick(datacardId: string, loadout = 0): RosterPickIn {
  if (datacardId === C.felarch) {
    return {
      datacardId,
      entryId: entryId(DATA, 0),
      loadoutIds: [DATA.selection.leaderList[0]!.loadouts[loadout]!.id],
    };
  }
  const i = LIST_INDEX.get(datacardId)!;
  const entry = DATA.selection.list[i]!;
  return {
    datacardId,
    entryId: entryId(DATA, DATA.selection.leaderList.length + i),
    loadoutIds: entry.loadouts.length > 0 ? [entry.loadouts[loadout]!.id] : [],
  };
}

const roster = (ids: string[], loadouts: Record<string, number> = {}): RosterPickIn[] =>
  ids.map((id) => pick(id, loadouts[id] ?? 0));

const column = (x: number, n = 9) => Array.from({ length: n }, (_, i) => ({ x, y: 1 + i * 2.4 }));

function setup(
  opts: {
    p1?: string[];
    p2?: string[];
    loadouts?: Record<string, number>;
    equipment?: string[];
    script?: number[];
    seed?: number;
    map?: ReturnType<typeof testMap>;
  } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([CV], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const p1 = roster(opts.p1 ?? [C.felarch, C.fateDealer, C.kurnathi, C.kurniteHunter, C.shadeRunner], opts.loadouts);
  const p2 = roster(opts.p2 ?? [C.felarch, C.warrior, C.warrior, C.warrior]);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: CV, picks: p1, positions: column(3, p1.length), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: CV, picks: p2, positions: column(27, p2.length) },
  });
  state.teams.p1.cp = 10;
  state.teams.p2.cp = 10;
  return { ctx, state };
}

const T = (state: GameState, ctx: ReturnType<typeof teamContext>, player: PlayerId = 'p1') =>
  makeTeamHooks(DATA, player, ctx);

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
  rules = profile.rules,
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

/** A shoot sequence parked mid-flight, so rules that read `state.sequence` can be pinned. */
function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  dice: { value: number; state: 'crit' | 'normal' | 'fail' }[],
  opts: {
    profileName?: string;
    step?: 'rollDefence' | 'defenceRerolls';
    inCover?: boolean;
    vantageImprovedCover?: boolean;
    pointBlank?: boolean;
  } = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: opts.step ?? 'defenceRerolls',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: opts.pointBlank ?? false,
    inCover: opts.inCover ?? false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: opts.vantageImprovedCover ?? false,
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

function fakeFight(state: GameState, attackerId: string, defenderId: string, attackerWeapon: string, defenderWeapon?: string): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    ...(defenderWeapon ? { defenderWeapon } : {}),
    defenderCanRetaliate: true,
    attackerPool: { dice: [], nextId: 1 },
    defenderPool: { dice: [], nextId: 1 },
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

const defenceEvent = (
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  opts: { count?: number; coverSave?: boolean; rules?: WeaponProfile['rules'] } = {},
) =>
  ctx.hooks.emit('onDefenceDice', state, {
    state,
    ctx: { ...attackCtx(attacker, defender, weaponName, profile), ...(opts.rules ? { rules: opts.rules } : {}) },
    count: opts.count ?? 3,
    coverSave: opts.coverSave ?? false,
    coverSaveAsCrit: false,
    extraCoverSaves: 0,
    mods: zeroStatMods(),
    rerolls: [],
  });

const collect = (
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee' = 'melee',
) =>
  ctx.hooks.emit('onCollectAttackDice', state, {
    state,
    ctx: attackCtx(attacker, defender, weaponName, profile, type),
    count: profile.atk,
    mods: zeroStatMods(),
  });

const useGambit = (
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  gambitId: string,
  data?: Record<string, unknown>,
): GameState => reduce(state, { t: 'UseGambit', player: 'p1', gambitId, ...(data ? { data } : {}) }, ctx).state;

const usePloy = (
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  ployId: string,
  data?: Record<string, unknown>,
): { state: GameState; ok: boolean; reason?: string } => {
  const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId, ...(data ? { data } : {}) }, ctx);
  return { state: out.state, ok: out.ok, ...(out.reason ? { reason: out.reason } : {}) };
};

const strategyPhase = (state: GameState): GameState => {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  return state;
};

const raw = (rules: { raw: string }[]): string[] => rules.map((r) => r.raw);

/** Constraint codes only — a short test roster always trips the count codes. */
const hardCodes = (picks: RosterPickIn[]): string[] =>
  validateRosterFor(DATA, picks).codes.filter((c) => !COUNT_CODES.includes(c));

// ---------------------------------------------------------------------------
describe('CORSAIR VOIDSCARRED data (pinned against data/teams/corsair-voidscarred.json)', () => {
  it('has 11 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(11);
    for (const card of DATA.datacards) {
      expect(card.base).toEqual({ shape: 'round', mm: 28 });
      expect(card).toMatchObject({ apl: 2, move: 7, save: 4 });
      expect(card.keywords.slice(0, 3)).toEqual(['CORSAIR VOIDSCARRED', 'AELDARI', 'ANHRATHE']);
    }
    expect(DATA.datacards.find((c) => c.id === C.felarch)).toMatchObject({ wounds: 9 });
    expect(DATA.datacards.find((c) => c.id === C.felarch)!.keywords).toEqual([
      'CORSAIR VOIDSCARRED',
      'AELDARI',
      'ANHRATHE',
      'LEADER',
      'FELARCH',
    ]);
    for (const card of DATA.datacards.filter((c) => c.id !== C.felarch)) expect(card.wounds).toBe(8);
    // PSYKER is what the two PSYCHIC unique-action datacards share; MEDIC sits on the SOUL WEAVER.
    expect(DATA.datacards.filter((c) => c.keywords.includes('PSYKER')).map((c) => c.id)).toEqual([
      C.soulWeaver,
      C.waySeeker,
    ]);
    expect(DATA.datacards.find((c) => c.id === C.soulWeaver)!.keywords).toContain('MEDIC');
  });

  it('pins every weapon profile on every datacard, including the Way Seeker’s "2\\" Devastating 2"', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat(C.felarch)).toEqual([
      'Neuro disruptor||ranged|4|3|4|5|Range 8"+Piercing 1+Stun',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Shuriken rifle||ranged|4|3|3|4|Rending',
      'Power weapon||melee|4|3|4|6|Lethal 5+',
    ]);
    expect(flat(C.fateDealer)).toEqual([
      'Ranger long rifle|mobile|ranged|4|3|3|4|',
      'Ranger long rifle|stationary|ranged|4|2|3|3|Devastating 3+Heavy+Silent',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Fists||melee|3|3|2|3|',
    ]);
    expect(flat(C.gunner)).toEqual([
      'Blaster||ranged|4|3|4|5|Piercing 2',
      'Shredder||ranged|4|3|4|5|Rending+Torrent 2"',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Fists||melee|3|3|2|3|',
    ]);
    expect(flat(C.heavyGunner)).toEqual([
      'Shuriken cannon|focused|ranged|5|3|4|5|Heavy (Dash only)+Rending',
      'Shuriken cannon|sweeping|ranged|4|3|4|5|Heavy (Dash only)+Rending+Torrent 1"',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Wraithcannon||ranged|4|3|6|3|Devastating 4+Heavy (Dash only)+Piercing 2',
      'Fists||melee|3|3|2|3|',
    ]);
    expect(flat(C.kurnathi)).toEqual([
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Dual power weapons||melee|4|3|4|6|Ceaseless+Lethal 5+',
    ]);
    expect(flat(C.kurniteHunter)).toEqual([
      'Faolchú||ranged|4|3|1|2|Rending+Saturate+Seek Light+Silent',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Power weapon||melee|4|3|4|6|Lethal 5+',
    ]);
    expect(flat(C.shadeRunner)).toEqual([
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Throwing blades||ranged|4|3|2|4|Range 6"+Silent',
      'Hekatarii blades||melee|4|3|3|5|Ceaseless+Lethal 5+',
    ]);
    expect(flat(C.soulWeaver)).toEqual([
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Power weapon||melee|4|3|4|6|Lethal 5+',
    ]);
    expect(flat(C.starstormDuellist)).toEqual([
      'Fusion pistol||ranged|4|3|5|3|Range 3"+Devastating 3+Piercing 2',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Fists||melee|3|3|2|3|',
    ]);
    expect(flat(C.warrior)).toEqual([
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Shuriken rifle||ranged|4|3|3|4|Rending',
      'Power weapon||melee|4|3|4|6|Lethal 5+',
      'Fists||melee|3|3|2|3|',
    ]);
    // The Way Seeker's lightning strike keeps its DISTANCE-prefixed Devastating, which
    // DIUTURNAL MANTLES and RUNES OF GUIDANCE both name explicitly.
    expect(flat(C.waySeeker)).toEqual([
      'Freezing grasp||ranged|4|3|1|2|PSYCHIC+Severe+Silent+Stun',
      'Lightning strike||ranged|4|3|4|3|PSYCHIC+2" Devastating 2',
      'Shuriken pistol||ranged|4|3|3|4|Range 8"+Rending',
      'Witch staff||melee|4|3|3|5|PSYCHIC+Shock',
    ]);
    const dev = profileOf(C.waySeeker, 'Lightning strike').rules.find((r) => r.id === 'Devastating')!;
    expect(dev).toMatchObject({ x: 2, dist: 2, raw: '2" Devastating 2' });
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 11 abilities and 5 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Rifles', 'Aeldari Raiders']);
    expect(CV.ploys.filter((p) => p.kind === 'strategy').map((p) => p.name)).toEqual([
      'PLUNDERERS',
      'PIRATICAL PROFITEERS',
      'MOBILE ENGAGEMENT',
      'OUTCASTS',
    ]);
    expect(CV.ploys.filter((p) => p.kind === 'firefight').map((p) => p.name)).toEqual([
      'OPPORTUNISTIC FIGHTERS',
      'LIGHT FINGERS',
      'CAPRICIOUS FLIGHT',
      'CONTEMPTUOUS ADVENTURER',
    ]);
    expect(CV.ploys.every((p) => p.cp === 1)).toBe(true);
    expect(CV.equipment.map((e) => e.name)).toEqual([
      'DIUTURNAL MANTLES',
      'MISTFIELD',
      'RUNES OF GUIDANCE',
      'STAR CHARTS',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(11);
    expect(DATA.datacards.flatMap((c) => c.abilities).map((a) => a.name)).toEqual([
      'Veteran Raider',
      'One Step Ahead',
      'Camo Cloak',
      'Blademaster',
      'Bladed Stance',
      'Faolchú’s Bond',
      'Erudite Hunter',
      'Blink Pack',
      'Slicing Attack',
      'Quick on the Trigger',
      'Prowling Raiders',
    ]);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'SOUL CHANNEL',
      'SOUL HEAL',
      'PISTOL BARRAGE',
      'WARP FOLD',
      'WARDING SHIELD',
    ]);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap)).toEqual([1, 1, 1, 1, 1]);
    expect(DATA.rareWeaponRules).toEqual(['PSYCHIC']);
  });

  it('the printed default kill team is legal and every datacard/ploy/equipment has an AI hint', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(9); // "1 … FELARCH" + "8 CORSAIR VOIDSCARRED operatives"
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(CV.validateRoster(picks).ok).toBe(true);
    // It fields the FELARCH plus the first eight rows — no WARRIOR and no WAY SEEKER.
    expect(picks.map((p) => p.datacardId)).not.toContain(C.waySeeker);
    for (const card of DATA.datacards) expect(CV.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of CV.ploys) expect(CV.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of CV.equipment) expect(CV.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });

  it('selection: "Other than WARRIOR operatives, your kill team can only include each operative on this list once"', () => {
    expect(DATA.selection.rawText).toContain(
      'Other than WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.constraints).toContainEqual({ kind: 'uniqueExcept', roles: ['WARRIOR'] });
    expect(hardCodes(roster([C.felarch, C.warrior, C.warrior, C.warrior]))).toEqual([]);
    expect(hardCodes(roster([C.felarch, C.kurnathi, C.kurnathi]))).toContain('unique');
  });

  it('selection: "Your kill team cannot include both a blaster and a wraithcannon" IS enforced', () => {
    expect(DATA.selection.footnotes['*']).toBe('Your kill team cannot include both a blaster and a wraithcannon.');
    expect(DATA.selection.constraints).toContainEqual({ kind: 'exclusiveItems', items: ['blaster', 'wraithcannon'] });
    expect(hardCodes(roster([C.felarch, C.gunner, C.heavyGunner], { [C.gunner]: 0, [C.heavyGunner]: 1 }))).toContain(
      'exclusiveItems',
    );
    // Blaster + shuriken cannon, and shredder + wraithcannon, are both legal.
    expect(hardCodes(roster([C.felarch, C.gunner, C.heavyGunner], { [C.gunner]: 0, [C.heavyGunner]: 0 }))).toEqual([]);
    expect(hardCodes(roster([C.felarch, C.gunner, C.heavyGunner], { [C.gunner]: 1, [C.heavyGunner]: 1 }))).toEqual([]);
    // `defaultRoster` picks the blaster and the shuriken cannon, so the default kill team is legal.
    expect(validateRosterFor(DATA, defaultRoster(DATA)).ok).toBe(true);
  });

  it('PSYCHIC is a keyword tag: the source defines it nowhere and this team prints no definition of its own', () => {
    const t = rareRuleTextFor(DATA, 'PSYCHIC');
    expect(t).toContain('no printed definition');
    // It is a tag on three of the WAY SEEKER's weapons, read by RUNES OF GUIDANCE's note.
    const psychicWeapons = DATA.datacards
      .find((c) => c.id === C.waySeeker)!
      .weapons.filter((w) => w.profiles.some((p) => p.rules.some((r) => r.id === 'PSYCHIC')))
      .map((w) => w.name);
    expect(psychicWeapons).toEqual(['Freezing grasp', 'Lightning strike', 'Witch staff']);
  });
});

// ---------------------------------------------------------------------------
describe('Rifles — "…that weapon has the Accurate 1 weapon rule"', () => {
  it('gives a shuriken rifle and a ranger long rifle Accurate 1 while the operative has not moved', () => {
    expect(rule(RULE.rifles)).toContain(
      'shooting with a shuriken rifle or ranger long rifle during an activation in which it hasn’t performed the Charge, Fall Back or Reposition action',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.fateDealer] });
    const felarch = state.operatives[opWith(state, 'p1', C.felarch)]!;
    const dealer = state.operatives[opWith(state, 'p1', C.fateDealer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    const rifle = effectiveRules(ctx, state, profileOf(C.felarch, 'Shuriken rifle'), {
      operative: felarch,
      target: foe,
      weaponName: 'Shuriken rifle',
    });
    expect(raw(rifle)).toContain('Accurate 1 (Rifles)');
    const long = effectiveRules(ctx, state, profileOf(C.fateDealer, 'Ranger long rifle', 'mobile'), {
      operative: dealer,
      target: foe,
      weaponName: 'Ranger long rifle',
    });
    expect(raw(long)).toContain('Accurate 1 (Rifles)');
  });

  it('does not apply to other weapons, nor after a Reposition — "Note that operative isn’t restricted from performing those actions after shooting"', () => {
    expect(rule(RULE.rifles)).toContain('Note that operative isn’t restricted from performing those actions after shooting');
    const { ctx, state } = setup({ p1: [C.felarch] });
    const felarch = state.operatives[opWith(state, 'p1', C.felarch)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    const pistol = effectiveRules(ctx, state, profileOf(C.felarch, 'Shuriken pistol'), {
      operative: felarch,
      target: foe,
      weaponName: 'Shuriken pistol',
    });
    expect(raw(pistol)).not.toContain('Accurate 1 (Rifles)');

    felarch.actionsThisActivation = ['Reposition'];
    const moved = effectiveRules(ctx, state, profileOf(C.felarch, 'Shuriken rifle'), {
      operative: felarch,
      target: foe,
      weaponName: 'Shuriken rifle',
    });
    expect(raw(moved)).not.toContain('Accurate 1 (Rifles)');
    // A Dash is not one of the three named actions.
    felarch.actionsThisActivation = ['Dash'];
    expect(
      raw(effectiveRules(ctx, state, profileOf(C.felarch, 'Shuriken rifle'), { operative: felarch, target: foe, weaponName: 'Shuriken rifle' })),
    ).toContain('Accurate 1 (Rifles)');
  });
});

// ---------------------------------------------------------------------------
describe('Aeldari Raiders — "Each friendly CORSAIR VOIDSCARRED operative can perform a free Dash action during their activation"', () => {
  it('hands every activating operative one extra AP restricted to Dash, and takes it back at the end', () => {
    expect(rule(RULE.aeldariRaiders)).toContain('can perform a free Dash action during their activation');
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi] });
    const id = opWith(state, 'p1', C.kurnathi);
    const s1 = activate(ctx, state, id);
    const op = s1.operatives[id]!;
    // "…for free" is AP on top of the APL budget, not an APL stat change (docs/DECISIONS.md
    // D-100): the AP gate sees three, the APL stat is still two.
    expect(aplOf(ctx, s1, op)).toBe(2);
    expect(freeApOf(s1, op)).toBe(1);
    expect(apBudgetOf(ctx, s1, op)).toBe(3);
    const grant = s1.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === id)!;
    expect(grant.data?.['only']).toEqual(['Dash', DASH_BLADEMASTER]);
    expect(grant.data?.['threshold']).toBe(2);

    // Once the operative has spent its own 2AP, only the Dash is left.
    op.apSpent = 2;
    const blocked = ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Shoot', allowed: true });
    expect(blocked.allowed).toBe(false);
    const allowed = ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Dash', allowed: true });
    expect(allowed.allowed).toBe(true);

    const s2 = reduce(s1, { t: 'EndActivation', operativeId: id }, ctx).state;
    // "…during their activation": the free AP is gone with the activation it belonged to.
    expect(freeApOf(s2, s2.operatives[id]!)).toBe(0);
    expect(apBudgetOf(ctx, s2, s2.operatives[id]!)).toBe(2);
    expect(s2.operatives[id]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s2, s2.operatives[id]!)).toBe(2);
  });

  it('the free Dash is AP, not APL: it does not help the operative control a marker', () => {
    expect(rule(RULE.aeldariRaiders)).toContain('can perform a free Dash action during their activation');
    // Core rules › Datacards: "Regardless of how many APL stat changes an operative is affected
    // by, the total can never be more than -1 or +1 from its normal APL." A free action is not
    // one of those changes, and marker control totals the APL STAT — so an operative holding a
    // free Dash still only brings its printed APL 2 to a contested marker.
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi], p2: [C.kurnathi] });
    const mine = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.kurnathi);
    state.operatives[mine]!.pos = { x: 10, y: 6 };
    state.operatives[foe]!.pos = { x: 11, y: 6 };
    state.markers['ar-obj'] = {
      id: 'ar-obj',
      kind: 'objective',
      diameterMm: 40,
      pos: { x: 10.5, y: 6 },
      z: 0,
      flags: {},
    };
    const s = activate(ctx, state, mine);
    expect(freeApOf(s, s.operatives[mine]!)).toBe(1);
    expect(markerController(ctx, s, s.markers['ar-obj']!)).toBeNull(); // APL 2 against APL 2
  });

  it('Veteran Raider: the FELARCH’s free action is any 1AP action "instead of the Dash action", and never a 2AP one', () => {
    expect(ability(C.felarch, A.veteranRaider)).toContain('can perform a 1AP action for free during their activation');
    const { ctx, state } = setup({ p1: [C.felarch] });
    const id = opWith(state, 'p1', C.felarch);
    const s1 = activate(ctx, state, id);
    const op = s1.operatives[id]!;
    expect(s1.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === id)!.data?.['only']).toBeUndefined();
    op.apSpent = 2;
    expect(ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Shoot', allowed: true }).allowed).toBe(true);
    // Fall Back is 2AP: the free AP alone cannot pay for it.
    expect(ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Fall Back', allowed: true }).allowed).toBe(
      false,
    );
    op.apSpent = 1;
    expect(ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Fall Back', allowed: true }).allowed).toBe(
      false,
    );
    op.apSpent = 0;
    expect(ctx.hooks.emit('canPerformAction', s1, { state: s1, operative: op, action: 'Fall Back', allowed: true }).allowed).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
describe('FELARCH › One Step Ahead', () => {
  it('interrupts on a D6 higher than the enemy’s APL and grants a free Shoot or Fight', () => {
    expect(ability(C.felarch, A.oneStepAhead)).toContain(
      'roll one D6: if the result is higher than that enemy operative’s APL stat',
    );
    const { ctx, state } = setup({ p1: [C.felarch], script: [6] });
    const felarch = opWith(state, 'p1', C.felarch);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 9, y: 4 }; // in the open, in the FELARCH's line of fire
    const s1 = activate(ctx, state, foe);
    const s2 = reduce(s1, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s2.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === felarch);
    expect(grant?.data?.['only']).toEqual(['Shoot', 'Fight', SHOOT_QUICK_TRIGGER]);
    expect(s2.effects.some((e) => e.rule === 'cv.oneStepAhead' && e.operativeId === felarch)).toBe(true);
  });

  it('is spent even when the roll fails, and only once per battle', () => {
    expect(ability(C.felarch, A.oneStepAhead)).toContain('Once per battle');
    const { ctx, state } = setup({ p1: [C.felarch], script: [1, 6, 6, 6] });
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 9, y: 4 };
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'cv.oneStepAhead')).toBe(false); // 1 is not higher than APL 2
    // A second enemy activation gets nothing: the once-per-battle use is gone.
    const foe2 = opWith(state, 'p2', C.warrior);
    s.operatives[foe2]!.pos = { x: 9, y: 8 };
    s.operatives[foe2]!.ready = true;
    s.activePlayer = 'p2';
    s = activate(ctx, s, foe2);
    s = reduce(s, { t: 'EndActivation', operativeId: foe2 }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'cv.oneStepAhead')).toBe(false);
  });

  it('"you cannot select any other enemy operative as a valid target … during that action"', () => {
    const { ctx, state } = setup({ p1: [C.felarch], script: [6] });
    const felarch = opWith(state, 'p1', C.felarch);
    const foe = opWith(state, 'p2', C.felarch);
    const other = opWith(state, 'p2', C.warrior);
    state.operatives[foe]!.pos = { x: 9, y: 4 };
    state.operatives[other]!.pos = { x: 9, y: 9 };
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const op = s.operatives[felarch]!;
    op.apSpent = 2; // spending the interrupt's free AP
    const locked = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: op,
      target: s.operatives[other]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(locked.valid).toBe(false);
    const ok = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: op,
      target: s.operatives[foe]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ok.valid).toBe(true);
  });

  it('"After you perform that action, subtract 1 from this operative’s APL stat until the end of its next activation"', () => {
    expect(ability(C.felarch, A.oneStepAhead)).toContain(
      'subtract 1 from this operative’s APL stat until the end of its next activation',
    );
    const { ctx, state } = setup({ p1: [C.felarch], script: [6] });
    const felarch = opWith(state, 'p1', C.felarch);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 9, y: 4 };
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    // The FELARCH spends the interrupt on a Shoot during its own next activation (D-013).
    s = activate(ctx, s, felarch);
    s.operatives[felarch]!.actionsThisActivation = ['Shoot'];
    s = reduce(s, { t: 'EndActivation', operativeId: felarch }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'cv.oneStepAheadApl' && e.operativeId === felarch)).toBe(true);
    expect(aplOf(ctx, s, s.operatives[felarch]!)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('FATE DEALER › Camo Cloak', () => {
  it('ignores Saturate and retains one additional cover save', () => {
    expect(ability(C.fateDealer, A.camoCloak)).toContain('Ignore the Saturate weapon rule');
    expect(ability(C.fateDealer, A.camoCloak)).toContain('you can retain one additional cover save');
    const { ctx, state } = setup({ p1: [C.felarch, C.fateDealer] });
    const dealer = state.operatives[opWith(state, 'p1', C.fateDealer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    const saturate = profileOf(C.kurniteHunter, 'Faolchú'); // Rending + Saturate + Seek Light + Silent
    fakeShoot(state, foe.id, dealer.id, 'Faolchú', [], { step: 'rollDefence', inCover: true });
    const ev = defenceEvent(ctx, state, foe, dealer, 'Faolchú', saturate, { coverSave: false });
    expect(ev.coverSave).toBe(true); // Saturate ignored
    expect(ev.extraCoverSaves).toBe(1);
  });

  it('"This isn’t cumulative with improved cover saves from Vantage terrain"', () => {
    expect(ability(C.fateDealer, A.camoCloak)).toContain('isn’t cumulative with improved cover saves from Vantage terrain');
    const { ctx, state } = setup({ p1: [C.felarch, C.fateDealer] });
    const dealer = state.operatives[opWith(state, 'p1', C.fateDealer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    fakeShoot(state, foe.id, dealer.id, 'Shuriken rifle', [], {
      step: 'rollDefence',
      inCover: true,
      vantageImprovedCover: true,
    });
    const ev = defenceEvent(ctx, state, foe, dealer, 'Shuriken rifle', profileOf(C.felarch, 'Shuriken rifle'), {
      coverSave: true,
    });
    expect(ev.extraCoverSaves).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('KURNATHI › Blademaster and Bladed Stance', () => {
  it('Dash (Blademaster) is legal after a Charge where the universal Dash is not', () => {
    expect(ability(C.kurnathi, A.blademaster)).toContain(
      'can perform the Dash action during an activation in which it performed the Charge action',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.kurnathi);
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    op.actionsThisActivation = ['Charge'];
    const path = { points: [{ x: op.pos.x + 1, y: op.pos.y }] };
    expect(getAction('Dash')!.check(ctx, s, op, { path }).ok).toBe(false);
    expect(getAction(DASH_BLADEMASTER)!.check(ctx, s, op, { path }).ok).toBe(true);
    // …and only after a Charge.
    op.actionsThisActivation = [];
    expect(getAction(DASH_BLADEMASTER)!.check(ctx, s, op, { path }).ok).toBe(false);
  });

  it('"…can only use any remaining move distance it had from that Charge action (to a maximum of 3\\")"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.kurnathi);
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    op.actionsThisActivation = ['Charge'];
    const hooks = T(s, ctx);
    // Move 7" + the Charge's 2" = 9". A 7" Charge leaves 2"; an 4" Charge leaves 5", capped at 3".
    s.log.push({ seq: 900, tp: 1, kind: 'action', player: 'p1', text: 'x', data: { operativeId: id, action: 'Charge', inches: 7 } });
    expect(blademasterRemaining(hooks, s, op)).toBe(2);
    expect(moveBudget(ctx, s, op, { action: 'Dash' })).toBe(2);
    s.log.push({ seq: 901, tp: 1, kind: 'action', player: 'p1', text: 'x', data: { operativeId: id, action: 'Charge', inches: 4 } });
    expect(blademasterRemaining(hooks, s, op)).toBe(3);
    expect(moveBudget(ctx, s, op, { action: 'Dash' })).toBe(3);
  });

  it('Bladed Stance: a retaliating KURNATHI resolves the first attack dice', () => {
    expect(ability(C.kurnathi, A.bladedStance)).toContain('you can resolve one of your successes before the normal order');
    const { ctx, state } = setup();
    const kurnathi = state.operatives[opWith(state, 'p1', C.kurnathi)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    fakeFight(state, foe.id, kurnathi.id, 'Power weapon', 'Dual power weapons');
    collect(ctx, state, kurnathi, foe, 'Dual power weapons', profileOf(C.kurnathi, 'Dual power weapons'));
    expect((state.sequence as { turn: string }).turn).toBe('defender');
  });
});

// ---------------------------------------------------------------------------
describe('KURNITE HUNTER › Faolchú’s Bond and Erudite Hunter', () => {
  it('"The first time during each turning point that this operative is retaliating … you resolve the first attack dice"', () => {
    expect(ability(C.kurniteHunter, A.faolchusBond)).toContain('you resolve the first attack dice');
    const { ctx, state } = setup();
    const hunter = state.operatives[opWith(state, 'p1', C.kurniteHunter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    fakeFight(state, foe.id, hunter.id, 'Power weapon', 'Power weapon');
    collect(ctx, state, hunter, foe, 'Power weapon', profileOf(C.kurniteHunter, 'Power weapon'));
    expect((state.sequence as { turn: string }).turn).toBe('defender');
    // "The first time during each turning point" — the second fight of the turning point does not.
    fakeFight(state, foe.id, hunter.id, 'Power weapon', 'Power weapon');
    collect(ctx, state, hunter, foe, 'Power weapon', profileOf(C.kurniteHunter, 'Power weapon'));
    expect((state.sequence as { turn: string }).turn).toBe('attacker');
  });

  it('"…if it’s ready" — an expended KURNITE HUNTER does not get the first dice', () => {
    const { ctx, state } = setup();
    const hunter = state.operatives[opWith(state, 'p1', C.kurniteHunter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    hunter.ready = false;
    fakeFight(state, foe.id, hunter.id, 'Power weapon', 'Power weapon');
    collect(ctx, state, hunter, foe, 'Power weapon', profileOf(C.kurniteHunter, 'Power weapon'));
    expect((state.sequence as { turn: string }).turn).toBe('attacker');
  });

  it('Erudite Hunter is a STRATEGIC GAMBIT that marks "one enemy operative within 9\\" of this operative"', () => {
    expect(ability(C.kurniteHunter, A.eruditeHunter)).toContain('STRATEGIC GAMBIT. Select one enemy operative within 9"');
    const { ctx, state } = setup();
    const hunter = opWith(state, 'p1', C.kurniteHunter);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 8, y: state.operatives[hunter]!.pos.y };
    const s0 = strategyPhase(state);
    expect(gambitOptions(ctx, s0, 'p1').map((o) => o.id)).toContain(A.eruditeHunter);
    const s1 = useGambit(ctx, s0, A.eruditeHunter, { targetOperativeId: foe });
    const mark = s1.effects.find((e) => e.rule === 'cv.eruditeMark' && e.player === 'p1')!;
    expect(mark.data).toMatchObject({ hunterId: hunter, enemyId: foe });
    // Out of range: no gambit at all.
    const far = setup();
    for (const id of far.state.teams.p2.operativeIds) far.state.operatives[id]!.pos = { x: 29, y: 9 };
    expect(gambitOptions(far.ctx, strategyPhase(far.state), 'p1').map((o) => o.id)).not.toContain(A.eruditeHunter);
  });

  it('interrupts after the marked enemy moves, granting a free Reposition or Charge', () => {
    expect(ability(C.kurniteHunter, A.eruditeHunter)).toContain(
      'this operative can immediately perform either a free Reposition action',
    );
    const { ctx, state } = setup();
    const hunter = opWith(state, 'p1', C.kurniteHunter);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 8, y: state.operatives[hunter]!.pos.y };
    let s = useGambit(ctx, strategyPhase(state), A.eruditeHunter, { targetOperativeId: foe });
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s = activate(ctx, s, foe);
    s.operatives[foe]!.actionsThisActivation = ['Reposition'];
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === hunter);
    expect(grant?.data?.['only']).toEqual(['Reposition', 'Charge']);
    expect(s.effects.some((e) => e.rule === 'cv.eruditeMark')).toBe(false); // "Once during this turning point"
  });

  it('"it cannot end that move further away from that enemy operative" is exported as a predicate (no end-of-move seam)', () => {
    const { ctx, state } = setup();
    const hunter = opWith(state, 'p1', C.kurniteHunter);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: 12, y: state.operatives[hunter]!.pos.y };
    let s = useGambit(ctx, strategyPhase(state), A.eruditeHunter, { targetOperativeId: foe });
    s.phase = 'firefight';
    s = activate(ctx, s, foe);
    s.operatives[foe]!.actionsThisActivation = ['Reposition'];
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const op = s.operatives[hunter]!;
    expect(eruditeEndPositionLegal(ctx, s, op, { x: op.pos.x + 2, y: op.pos.y })).toBe(true);
    expect(eruditeEndPositionLegal(ctx, s, op, { x: op.pos.x - 2, y: op.pos.y })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('SHADE RUNNER › Blink Pack and Slicing Attack', () => {
  it('warp jumps up to "wholly within 7\\" horizontally of its original location"', () => {
    expect(ability(C.shadeRunner, A.blinkPack)).toContain('set it back up wholly within 7" horizontally of its original location');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.shadeRunner);
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    const near = { x: op.pos.x + 5, y: op.pos.y };
    expect(getAction(BLINK_REPOSITION)!.check(ctx, s, op, { targetPos: near }).ok).toBe(true);
    const far = { x: op.pos.x + 7, y: op.pos.y }; // 7" + the 28mm base radius is outside
    expect(getAction(BLINK_REPOSITION)!.check(ctx, s, op, { targetPos: far }).ok).toBe(false);
    const out = act(ctx, s, id, BLINK_REPOSITION, { targetPos: near });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.pos.x).toBeCloseTo(near.x, 5);
  });

  it('"…unless it’s the Charge action, it cannot be set up within control range of an enemy operative"', () => {
    expect(ability(C.shadeRunner, A.blinkPack)).toContain(
      'unless it’s the Charge action, it cannot be set up within control range of an enemy operative',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.shadeRunner);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[foe]!.pos = { x: state.operatives[id]!.pos.x + 4, y: state.operatives[id]!.pos.y };
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    // Within the enemy's control range (1" base to base) without standing in its base:
    // "the sides of different bases can touch, but a base cannot be placed on another".
    const onTop = { x: op.pos.x + 2.7, y: op.pos.y };
    expect(getAction(BLINK_REPOSITION)!.check(ctx, s, op, { targetPos: onTop }).ok).toBe(false);
    expect(getAction(BLINK_CHARGE)!.check(ctx, s, op, { targetPos: onTop }).ok).toBe(true);
    // …and a Charge must finish there.
    expect(getAction(BLINK_CHARGE)!.check(ctx, s, op, { targetPos: { x: op.pos.x - 3, y: op.pos.y } }).ok).toBe(false);
    // The Fall Back variant needs an enemy in control range to begin with.
    expect(getAction(BLINK_FALL_BACK)!.check(ctx, s, op, { targetPos: { x: op.pos.x - 3, y: op.pos.y } }).ok).toBe(false);
  });

  it('Slicing Attack inflicts D3+2 on one enemy operative the line crosses', () => {
    expect(ability(C.shadeRunner, A.slicingAttack)).toContain('Inflict D3+2 damage on one enemy operative that line crosses');
    const { ctx, state } = setup({ p1: [C.felarch, C.shadeRunner], script: [5] }); // D6 5 -> D3 3
    const id = opWith(state, 'p1', C.shadeRunner);
    const foe = opWith(state, 'p2', C.felarch);
    const op = state.operatives[id]!;
    op.pos = { x: 6, y: 6 };
    state.operatives[opWith(state, 'p1', C.felarch)]!.pos = { x: 1, y: 20 };
    state.operatives[foe]!.pos = { x: 9, y: 6 }; // directly on the 6" straight line
    for (const other of state.teams.p2.operativeIds) {
      if (other !== foe) state.operatives[other]!.pos = { x: 28, y: 14 };
    }
    const s = activate(ctx, state, id);
    const before = s.operatives[foe]!.wounds;
    const out = act(ctx, s, id, BLINK_REPOSITION, { targetPos: { x: 12, y: 6 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe]!.wounds).toBe(before - 5); // D3 3 + 2
  });

  it('"You cannot inflict damage on an enemy operative that was not visible … at the start of that action"', () => {
    expect(ability(C.shadeRunner, A.slicingAttack)).toContain(
      'You cannot inflict damage on an enemy operative that was not visible to this operative at the start of that action',
    );
    const map = testMap();
    map.features = [...map.features, heavyBlock('slice-block', 6, 4, 1.4, 4, 3)];
    const { ctx, state } = setup({ map, p1: [C.felarch, C.shadeRunner], script: [5] });
    const id = opWith(state, 'p1', C.shadeRunner);
    const foe = opWith(state, 'p2', C.felarch);
    const op = state.operatives[id]!;
    op.pos = { x: 5, y: 6 };
    state.operatives[opWith(state, 'p1', C.felarch)]!.pos = { x: 1, y: 20 };
    state.operatives[foe]!.pos = { x: 8.5, y: 6 }; // behind the Heavy block
    for (const other of state.teams.p2.operativeIds) {
      if (other !== foe) state.operatives[other]!.pos = { x: 28, y: 14 };
    }
    const s = activate(ctx, state, id);
    const before = s.operatives[foe]!.wounds;
    const out = act(ctx, s, id, BLINK_REPOSITION, { targetPos: { x: 11, y: 6 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe]!.wounds).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('STARSTORM DUELLIST › Quick on the Trigger and PISTOL BARRAGE', () => {
  it('shoots while engaged, at an enemy within its control range only', () => {
    expect(ability(C.starstormDuellist, A.quickOnTheTrigger)).toContain(
      'can perform the Shoot action while within control range of an enemy operative',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.starstormDuellist] });
    const id = opWith(state, 'p1', C.starstormDuellist);
    const foe = opWith(state, 'p2', C.felarch);
    const other = opWith(state, 'p2', C.warrior);
    state.operatives[id]!.pos = { x: 10, y: 6 };
    state.operatives[foe]!.pos = { x: 11.2, y: 6 }; // within control range
    state.operatives[other]!.pos = { x: 14, y: 6 };
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    expect(getAction('Shoot')!.check(ctx, s, op, { weaponName: 'Shuriken pistol', targetId: foe }).ok).toBe(false);
    expect(getAction(SHOOT_QUICK_TRIGGER)!.check(ctx, s, op, { weaponName: 'Shuriken pistol', targetId: foe }).ok).toBe(true);
    // "you can only select an enemy operative within this operative's control range"
    const away = getAction(SHOOT_QUICK_TRIGGER)!.check(ctx, s, op, { weaponName: 'Shuriken pistol', targetId: other });
    expect(away.ok).toBe(false);
    expect(away.reason).toContain('control range');
  });

  it('cancels the engine’s point-blank Hit penalty, which the printed rule does not carry', () => {
    const { ctx, state } = setup({ p1: [C.felarch, C.starstormDuellist] });
    const id = opWith(state, 'p1', C.starstormDuellist);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[id]!.pos = { x: 10, y: 6 };
    state.operatives[foe]!.pos = { x: 11.2, y: 6 };
    const s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    const pistol = profileOf(C.starstormDuellist, 'Shuriken pistol'); // Hit 3+
    // Without the ability's effect, `shoot.ts` passes −1 for a point-blank shot: 4+.
    fakeShoot(s, id, foe, 'Shuriken pistol', [], { step: 'rollDefence', pointBlank: true });
    expect(hitOf(ctx, s, op, pistol, -1)).toBe(4);
    const out = act(ctx, s, id, SHOOT_QUICK_TRIGGER, { weaponName: 'Shuriken pistol', targetId: foe });
    expect(out.ok).toBe(true);
    const after = out.state;
    expect(after.effects.some((e) => e.rule === 'cv.quickTrigger' && e.operativeId === id)).toBe(true);
    fakeShoot(after, id, foe, 'Shuriken pistol', [], { step: 'rollDefence', pointBlank: true });
    expect(hitOf(ctx, after, after.operatives[id]!, pistol, -1)).toBe(3);
  });

  it('PISTOL BARRAGE is two Shoot actions — fusion pistol then shuriken pistol — and never with a Conceal order', () => {
    expect(uaText(C.starstormDuellist, ACT.pistolBarrage)).toContain(
      'You must select its fusion pistol for one action and its shuriken pistol for the other',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.starstormDuellist] });
    const id = opWith(state, 'p1', C.starstormDuellist);
    const foe = opWith(state, 'p2', C.felarch);
    const foe2 = opWith(state, 'p2', C.warrior);
    state.operatives[opWith(state, 'p1', C.felarch)]!.pos = { x: 1, y: 20 };
    state.operatives[id]!.pos = { x: 10, y: 6 };
    state.operatives[foe]!.pos = { x: 12.5, y: 6 }; // inside the fusion pistol's Range 3"
    state.operatives[foe2]!.pos = { x: 16, y: 6 }; // inside the shuriken pistol's Range 8"
    let s = activate(ctx, state, id);
    const first = act(ctx, s, id, ACT.pistolBarrage, { targetId: foe });
    expect(first.ok).toBe(true);
    s = settle(ctx, first.state);
    expect(s.log.some((e) => e.text.includes('Fusion pistol'))).toBe(true);
    const second = act(ctx, s, id, PISTOL_BARRAGE_2, { targetId: foe2 });
    expect(second.ok).toBe(true);
    s = settle(ctx, second.state);
    expect(s.log.some((e) => e.text.includes('Shuriken pistol'))).toBe(true);
    expect(s.operatives[id]!.apSpent).toBe(1); // the follow-up is free
    // The barrage never counts as the universal Shoot action, so action restrictions do not stop it.
    expect(s.operatives[id]!.actionsThisActivation).toEqual([ACT.pistolBarrage, PISTOL_BARRAGE_2]);

    // "…cannot perform this action while it has a Conceal order"
    const c = setup({ p1: [C.felarch, C.starstormDuellist] });
    const cid = opWith(c.state, 'p1', C.starstormDuellist);
    const cs = activate(c.ctx, c.state, cid, 'conceal');
    const r = getAction(ACT.pistolBarrage)!.check(c.ctx, cs, cs.operatives[cid]!, { targetId: opWith(cs, 'p2', C.felarch) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Conceal');
  });
});

// ---------------------------------------------------------------------------
describe('WARRIOR › Prowling Raiders', () => {
  it('"You can use the Capricious Flight and Light Fingers firefight ploys for 0CP each"', () => {
    expect(ability(C.warrior, A.prowlingRaiders)).toContain(
      'You can use the Capricious Flight and Light Fingers firefight ploys for 0CP each',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.warrior] });
    const warrior = opWith(state, 'p1', C.warrior);
    let s = activate(ctx, state, warrior);
    const before = s.teams.p1.cp;
    s = usePloy(ctx, s, FP.capriciousFlight).state;
    expect(s.teams.p1.cp).toBe(before); // the reducer charges 1CP, Prowling Raiders refunds it
    s = usePloy(ctx, s, FP.lightFingers).state;
    expect(s.teams.p1.cp).toBe(before);
  });

  it('charges the CP normally when the specified operative is not a WARRIOR', () => {
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi] });
    const kurnathi = opWith(state, 'p1', C.kurnathi);
    let s = activate(ctx, state, kurnathi);
    const before = s.teams.p1.cp;
    s = usePloy(ctx, s, FP.capriciousFlight).state;
    expect(s.teams.p1.cp).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
describe('PLUNDERERS (strategy ploy)', () => {
  it('"You cannot use this ploy during the first turning point"', () => {
    expect(rule(SP.plunderers)).toContain('You cannot use this ploy during the first turning point');
    const { ctx, state } = setup();
    const s = strategyPhase(state);
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(SP.plunderers);
    s.turningPoint = 2;
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).toContain(SP.plunderers);
  });

  it('"Up to D3 friendly CORSAIR VOIDSCARRED operatives can immediately perform a free Dash action"', () => {
    const { ctx, state } = setup({ script: [5] }); // D6 5 -> D3 3
    const s0 = strategyPhase(state);
    s0.turningPoint = 2;
    const s1 = useGambit(ctx, s0, SP.plunderers);
    const granted = s1.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(granted).toHaveLength(3);
    expect(granted.every((e) => (e.data?.['only'] as string[]).includes('Dash'))).toBe(true);
    expect(s1.effects.filter((e) => e.rule === 'cv.plundered')).toHaveLength(3);
  });

  it('"This turning point, each that does so cannot perform the Dash action during their activation"', () => {
    const { ctx, state } = setup({ script: [1] }); // D6 1 -> D3 1
    const s0 = strategyPhase(state);
    s0.turningPoint = 2;
    let s = useGambit(ctx, s0, SP.plunderers);
    const plundered = s.effects.find((e) => e.rule === 'cv.plundered')!.operativeId!;
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s = activate(ctx, s, plundered);
    const op = s.operatives[plundered]!;
    // Its own AP cannot buy a Dash…
    expect(ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Dash', allowed: true }).allowed).toBe(false);
    // …but the Dash the ploy paid for still lands, on the AP outside its APL budget
    // (docs/DECISIONS.md D-100).
    op.apSpent = 2;
    expect(ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Dash', allowed: true }).allowed).toBe(true);
    // Aeldari Raiders does not hand it a second free Dash on top.
    expect(s.effects.filter((e) => e.rule === 'teamFreeAction' && e.operativeId === plundered)).toHaveLength(1);
    expect(freeApOf(s, op)).toBe(1);
  });

  it('"can IMMEDIATELY perform a free Dash" — an unspent one does not survive the turning point', () => {
    expect(rule(SP.plunderers)).toContain('can immediately perform a free Dash action');
    const { ctx, state } = setup({ script: [1] }); // D6 1 -> D3 1
    const s0 = strategyPhase(state);
    s0.turningPoint = 2;
    const s = useGambit(ctx, s0, SP.plunderers);
    const plundered = s.effects.find((e) => e.rule === 'cv.plundered')!.operativeId!;
    expect(freeApOf(s, s.operatives[plundered]!)).toBe(1);
    // The operative never activates, so its activation never ends and nothing expires the grant
    // on its own. It must not still be holding a free Dash next turning point — and a stale one
    // would also suppress the Aeldari Raiders Dash it is owed then.
    s.turningPoint = 3;
    readyStep(ctx, s);
    expect(freeApOf(s, s.operatives[plundered]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[plundered]!)).toBe(2);
    const later = activate(ctx, s, plundered);
    expect(freeApOf(later, later.operatives[plundered]!)).toBe(1); // Aeldari Raiders, as normal
  });
});

// ---------------------------------------------------------------------------
describe('PIRATICAL PROFITEERS, MOBILE ENGAGEMENT and OUTCASTS (strategy ploys)', () => {
  it('PIRATICAL PROFITEERS gives Balanced while either operative contests an objective marker — shooting AND retaliating', () => {
    expect(rule(SP.piraticalProfiteers)).toContain('is shooting, fighting or retaliating');
    const { ctx, state } = setup();
    const kurnathi = state.operatives[opWith(state, 'p1', C.kurnathi)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    const s = useGambit(ctx, strategyPhase(state), SP.piraticalProfiteers);
    const k = s.operatives[kurnathi.id]!;
    const f = s.operatives[foe.id]!;
    const melee = profileOf(C.kurnathi, 'Dual power weapons');
    expect(raw(effectiveRules(ctx, s, melee, { operative: k, target: f, weaponName: 'Dual power weapons' }))).not.toContain(
      'Balanced (PIRATICAL PROFITEERS)',
    );
    // Drop an objective marker on the KURNATHI.
    s.markers['obj-test'] = { id: 'obj-test', kind: 'objective', diameterMm: 40, pos: { ...k.pos }, z: 0, flags: {} };
    expect(raw(effectiveRules(ctx, s, melee, { operative: k, target: f, weaponName: 'Dual power weapons' }))).toContain(
      'Balanced (PIRATICAL PROFITEERS)',
    );
    // …and while retaliating, because `onWeaponRules` is emitted by both sequences.
    expect(
      raw(effectiveRules(ctx, s, melee, { operative: k, target: f, weaponName: 'Dual power weapons', retaliating: true })),
    ).toContain('Balanced (PIRATICAL PROFITEERS)');
  });

  it('MOBILE ENGAGEMENT offers a defence re-roll only when the target moved this turning point', () => {
    expect(rule(SP.mobileEngagement)).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup();
    const target = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    let s = useGambit(ctx, strategyPhase(state), SP.mobileEngagement);
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    const profile = profileOf(C.felarch, 'Shuriken rifle');
    fakeShoot(s, foe, target, 'Shuriken rifle', [], { step: 'defenceRerolls' });
    expect(movedThisTP(s, s.operatives[target]!)).toBe(false);
    expect(defenceEvent(ctx, s, s.operatives[foe]!, s.operatives[target]!, 'Shuriken rifle', profile).rerolls).toHaveLength(0);

    s = activate(ctx, s, target);
    s.operatives[target]!.actionsThisActivation = ['Reposition'];
    fakeShoot(s, foe, target, 'Shuriken rifle', [], { step: 'defenceRerolls' });
    expect(movedThisTP(s, s.operatives[target]!)).toBe(true);
    const ev = defenceEvent(ctx, s, s.operatives[foe]!, s.operatives[target]!, 'Shuriken rifle', profile);
    expect(ev.rerolls.map((r) => r.id)).toEqual(['cv.mobileEngagement']);
    expect(ev.rerolls[0]!.player).toBe('p1');
  });

  it('OUTCASTS gives Punishing while "more than 5\\" from other friendly operatives"', () => {
    expect(rule(SP.outcasts)).toContain('its weapons have the Punishing weapon rule');
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi] });
    const lone = state.operatives[opWith(state, 'p1', C.kurnathi)]!;
    const mate = state.operatives[opWith(state, 'p1', C.felarch)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    lone.pos = { x: 6, y: 14 };
    mate.pos = { x: 6, y: 2 };
    const s = useGambit(ctx, strategyPhase(state), SP.outcasts);
    const hooks = T(s, ctx);
    expect(isolatedFrom(hooks, s, s.operatives[lone.id]!)).toBe(true);
    const melee = profileOf(C.kurnathi, 'Dual power weapons');
    expect(
      raw(effectiveRules(ctx, s, melee, { operative: s.operatives[lone.id]!, target: foe, weaponName: 'Dual power weapons' })),
    ).toContain('Punishing (OUTCASTS)');
    s.operatives[mate.id]!.pos = { x: 6, y: 12 };
    expect(isolatedFrom(hooks, s, s.operatives[lone.id]!)).toBe(false);
    expect(
      raw(effectiveRules(ctx, s, melee, { operative: s.operatives[lone.id]!, target: foe, weaponName: 'Dual power weapons' })),
    ).not.toContain('Punishing (OUTCASTS)');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('OPPORTUNISTIC FIGHTERS inflicts 2D3 "for each friendly CORSAIR VOIDSCARRED operative within its control range"', () => {
    expect(rule(FP.opportunisticFighters)).toContain(
      'inflict 2D3 damage on that operative for each friendly CORSAIR VOIDSCARRED operative within its control range',
    );
    const { ctx, state } = setup({ script: [5, 5, 5, 5] }); // four D3 of 3
    const foe = opWith(state, 'p2', C.felarch);
    const a = opWith(state, 'p1', C.kurnathi);
    const b = opWith(state, 'p1', C.kurniteHunter);
    state.operatives[foe]!.pos = { x: 10, y: 6 };
    state.operatives[a]!.pos = { x: 11.2, y: 6 };
    state.operatives[b]!.pos = { x: 8.8, y: 6 };
    for (const id of state.teams.p1.operativeIds) if (id !== a && id !== b) state.operatives[id]!.pos = { x: 1, y: 14 };
    let s = activate(ctx, state, foe);
    const before = s.operatives[foe]!.wounds;
    const out = usePloy(ctx, s, FP.opportunisticFighters);
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[foe]!.wounds).toBe(before - 12); // 2 operatives × (3+3)
  });

  it('OPPORTUNISTIC FIGHTERS is refused when no enemy is engaged with a friendly CORSAIR VOIDSCARRED operative', () => {
    const { ctx, state } = setup();
    const out = usePloy(ctx, state, FP.opportunisticFighters);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('control range');
  });

  it('LIGHT FINGERS lets an engaged operative Pick Up Marker; the mission-action half has no seam', () => {
    expect(rule(FP.lightFingers)).toContain(
      'having an enemy operative within its control range doesn’t prevent that friendly operative from performing the Pick Up Marker or mission actions',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[id]!.pos = { x: 10, y: 6 };
    state.operatives[foe]!.pos = { x: 11.2, y: 6 };
    // The marker sits on the far side of the KURNATHI from the enemy: within its own control
    // range, outside the enemy's, so "your operatives control that marker" is satisfied on the
    // APL stat alone. Aeldari Raiders' free Dash is AP, not APL (docs/DECISIONS.md D-100), and
    // contributes nothing to a marker-control total.
    state.markers['lf-obj'] = {
      id: 'lf-obj',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 8.9, y: 6 },
      z: 0,
      owner: 'p1',
      flags: { pickUpAllowed: true },
    };
    let s = activate(ctx, state, id);
    const op = s.operatives[id]!;
    expect(getAction('Pick Up Marker')!.check(ctx, s, op, { markerId: 'lf-obj' }).ok).toBe(false);
    // Without the ploy the carve-out action is not available at all.
    expect(getAction(PICK_UP_LIGHT_FINGERS)!.available!(ctx, s, op)).toBe(false);
    s = usePloy(ctx, s, FP.lightFingers).state;
    expect(getAction(PICK_UP_LIGHT_FINGERS)!.available!(ctx, s, s.operatives[id]!)).toBe(true);
    const out = act(ctx, s, id, PICK_UP_LIGHT_FINGERS, { markerId: 'lf-obj' });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.carryingMarkerId).toBe('lf-obj');
  });

  it('CAPRICIOUS FLIGHT: "that operative can perform the Fall Back action for 1 less AP"', () => {
    expect(rule(FP.capriciousFlight)).toContain('can perform the Fall Back action for 1 less AP');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.kurnathi);
    let s = activate(ctx, state, id);
    expect(actionCost(ctx, s, s.operatives[id]!, getAction('Fall Back')!)).toBe(2);
    s = usePloy(ctx, s, FP.capriciousFlight).state;
    expect(actionCost(ctx, s, s.operatives[id]!, getAction('Fall Back')!)).toBe(1);
  });

  it('CONTEMPTUOUS ADVENTURER: Relentless on the first Shoot or Fight action of that activation only', () => {
    expect(rule(FP.contemptuousAdventurer)).toContain('its weapons have the Relentless weapon rule');
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi] });
    const id = opWith(state, 'p1', C.kurnathi);
    const mate = opWith(state, 'p1', C.felarch);
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    state.operatives[id]!.pos = { x: 6, y: 14 };
    state.operatives[mate]!.pos = { x: 6, y: 2 };
    let s = activate(ctx, state, id);
    const out = usePloy(ctx, s, FP.contemptuousAdventurer);
    expect(out.ok).toBe(true);
    s = out.state;
    const melee = profileOf(C.kurnathi, 'Dual power weapons');
    const op = s.operatives[id]!;
    expect(raw(effectiveRules(ctx, s, melee, { operative: op, target: foe, weaponName: 'Dual power weapons' }))).toContain(
      'Relentless (CONTEMPTUOUS ADVENTURER)',
    );
    // "Note this ploy cannot come into effect more than once per activation."
    op.actionsThisActivation = ['Fight'];
    expect(raw(effectiveRules(ctx, s, melee, { operative: op, target: foe, weaponName: 'Dual power weapons' }))).not.toContain(
      'Relentless (CONTEMPTUOUS ADVENTURER)',
    );
  });

  it('CONTEMPTUOUS ADVENTURER is refused after the first activation, and when a friendly is within 5"', () => {
    expect(rule(FP.contemptuousAdventurer)).toContain(
      'when the first friendly CORSAIR VOIDSCARRED operative is activated during the turning point, if it’s more than 5" from other friendly operatives',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.kurnathi] });
    const id = opWith(state, 'p1', C.kurnathi);
    const mate = opWith(state, 'p1', C.felarch);
    state.operatives[id]!.pos = { x: 6, y: 8 };
    state.operatives[mate]!.pos = { x: 6, y: 10 }; // 2" away
    let s = activate(ctx, state, id);
    expect(usePloy(ctx, s, FP.contemptuousAdventurer).ok).toBe(false);
    // Second friendly activation of the turning point: refused even when alone.
    s.operatives[mate]!.pos = { x: 6, y: 1 };
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    s.activePlayer = 'p1';
    s = activate(ctx, s, mate);
    expect(usePloy(ctx, s, FP.contemptuousAdventurer).reason).toContain('first friendly');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('DIUTURNAL MANTLES offers a defence re-roll against a Blast or Torrent weapon', () => {
    expect(rule(EQ.diuturnalMantles)).toContain('has the Blast or Torrent weapon rule, you can re-roll one of your defence dice');
    const { ctx, state } = setup({ equipment: [EQ.diuturnalMantles] });
    const target = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    const shredder = profileOf(C.gunner, 'Shredder'); // Rending + Torrent 2"
    fakeShoot(state, foe, target, 'Shredder', [], { step: 'defenceRerolls' });
    const ev = defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Shredder', shredder);
    expect(ev.rerolls.map((r) => r.id)).toContain('cv.diuturnalMantles');
    // A plain weapon offers nothing.
    fakeShoot(state, foe, target, 'Shuriken rifle', [], { step: 'defenceRerolls' });
    expect(
      defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Shuriken rifle', profileOf(C.felarch, 'Shuriken rifle'))
        .rerolls,
    ).toHaveLength(0);
  });

  it('"…aren’t affected by the x\\" Devastating x weapon rule … unless they are the target during that sequence"', () => {
    expect(rule(EQ.diuturnalMantles)).toContain(
      'aren’t affected by the x" Devastating x weapon rule (i.e. Devastating with a distance) unless they are the target during that sequence',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.kurnathi], equipment: [EQ.diuturnalMantles] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const bystander = opWith(state, 'p1', C.kurnathi);
    const target = opWith(state, 'p2', C.felarch);
    fakeShoot(state, seeker, target, 'Lightning strike', [{ value: 6, state: 'crit' }], { step: 'defenceRerolls' });
    const before = state.operatives[bystander]!.wounds;
    inflictDamage(ctx, state, state.operatives[bystander]!, 2, 'devastating');
    expect(state.operatives[bystander]!.wounds).toBe(before); // splash ignored
    // The primary target of the sequence is still affected.
    const tBefore = state.operatives[target]!.wounds;
    inflictDamage(ctx, state, state.operatives[target]!, 2, 'devastating');
    expect(state.operatives[target]!.wounds).toBe(tBefore - 2);
    // Plain Devastating (no distance) is untouched — the fusion pistol's Devastating 3.
    fakeShoot(state, seeker, target, 'Fusion pistol', [{ value: 6, state: 'crit' }], { step: 'defenceRerolls' });
    const b2 = state.operatives[bystander]!.wounds;
    inflictDamage(ctx, state, state.operatives[bystander]!, 3, 'devastating');
    expect(state.operatives[bystander]!.wounds).toBe(b2 - 3);
  });

  it('MISTFIELD worsens Piercing by 1 beyond 3", once per turning point — "Piercing 1 would therefore be ignored"', () => {
    expect(rule(EQ.mistfield)).toContain('worsen the x of the Piercing weapon rule by 1 (if any)');
    expect(rule(EQ.mistfield)).toContain('Note that Piercing 1 would therefore be ignored');
    const { ctx, state } = setup({ equipment: [EQ.mistfield] });
    const target = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[target]!.pos = { x: 6, y: 6 };
    state.operatives[foe]!.pos = { x: 16, y: 6 };
    const neuro = profileOf(C.felarch, 'Neuro disruptor'); // Piercing 1
    fakeShoot(state, foe, target, 'Neuro disruptor', [], { step: 'rollDefence' });
    const ev = defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Neuro disruptor', neuro, { count: 2 });
    expect(ev.count).toBe(3);
    // "Once per turning point".
    fakeShoot(state, foe, target, 'Neuro disruptor', [], { step: 'rollDefence' });
    expect(
      defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Neuro disruptor', neuro, { count: 2 }).count,
    ).toBe(2);
  });

  it('MISTFIELD does nothing within 3", or against a weapon with no Piercing', () => {
    const { ctx, state } = setup({ equipment: [EQ.mistfield] });
    const target = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[target]!.pos = { x: 6, y: 6 };
    state.operatives[foe]!.pos = { x: 8.5, y: 6 }; // ~2.5" base-to-base
    const neuro = profileOf(C.felarch, 'Neuro disruptor');
    fakeShoot(state, foe, target, 'Neuro disruptor', [], { step: 'rollDefence' });
    expect(
      defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Neuro disruptor', neuro, { count: 2 }).count,
    ).toBe(2);
    state.operatives[foe]!.pos = { x: 16, y: 6 };
    const rifle = profileOf(C.felarch, 'Shuriken rifle');
    fakeShoot(state, foe, target, 'Shuriken rifle', [], { step: 'rollDefence' });
    expect(
      defenceEvent(ctx, state, state.operatives[foe]!, state.operatives[target]!, 'Shuriken rifle', rifle, { count: 3 }).count,
    ).toBe(3);
  });

  it('RUNES OF GUIDANCE adds 3" to a PSYCHIC unique action’s distance, once per turning point, and never to a PSYCHIC weapon', () => {
    expect(rule(EQ.runesOfGuidance)).toContain('add 3" to its distance requirement');
    expect(rule(EQ.runesOfGuidance)).toContain(
      'Note this has no effect on PSYCHIC weapons (e.g. the Devastating distance requirement of lightning strike)',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.soulWeaver, C.kurnathi], equipment: [EQ.runesOfGuidance] });
    const weaver = opWith(state, 'p1', C.soulWeaver);
    const mate = opWith(state, 'p1', C.kurnathi);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 1, y: 20 };
    state.operatives[weaver]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 14, y: 6 }; // ~7" base-to-base: outside 6", inside 9"
    expect(psychicRange(state, 'p1', 6)).toBe(9);
    let s = activate(ctx, state, weaver);
    const out = act(ctx, s, weaver, ACT.soulChannel, { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(psychicRange(s, 'p1', 6)).toBe(6); // the once-per-turning-point use is spent
    expect(s.log.some((e) => e.text.includes('RUNES OF GUIDANCE'))).toBe(true);
    // The lightning strike's printed Devastating distance is untouched.
    expect(profileOf(C.waySeeker, 'Lightning strike').rules.find((r) => r.id === 'Devastating')!.dist).toBe(2);
  });

  it('STAR CHARTS: "if the result is higher than the number of the current turning point, you gain 1CP"', () => {
    expect(rule(EQ.starCharts)).toContain('you gain 1CP and cannot use this STRATEGIC GAMBIT for the rest of the battle');
    const win = setup({ equipment: [EQ.starCharts], script: [6] }); // D6 6 -> D3 3
    const s0 = strategyPhase(win.state);
    expect(gambitOptions(win.ctx, s0, 'p1').map((o) => o.id)).toContain(EQ.starCharts);
    const cp = s0.teams.p1.cp;
    const s1 = useGambit(win.ctx, s0, EQ.starCharts);
    expect(s1.teams.p1.cp).toBe(cp + 1);
    expect(gambitOptions(win.ctx, s1, 'p1').map((o) => o.id)).not.toContain(EQ.starCharts);

    const lose = setup({ equipment: [EQ.starCharts], script: [1] }); // D6 1 -> D3 1, not > TP 1
    const l0 = strategyPhase(lose.state);
    const cp2 = l0.teams.p1.cp;
    const l1 = useGambit(lose.ctx, l0, EQ.starCharts);
    expect(l1.teams.p1.cp).toBe(cp2);
    l1.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(lose.ctx, l1, 'p1').map((o) => o.id)).toContain(EQ.starCharts);
  });

  it('STAR CHARTS is only offered when the equipment was actually selected', () => {
    const { ctx, state } = setup();
    expect(gambitOptions(ctx, strategyPhase(state), 'p1').map((o) => o.id)).not.toContain(EQ.starCharts);
  });
});

// ---------------------------------------------------------------------------
describe('Unique actions', () => {
  it('SOUL CHANNEL: "Until the end of that operative’s next activation, add 1 to its APL stat"', () => {
    expect(uaText(C.soulWeaver, ACT.soulChannel)).toContain('add 1 to its APL stat');
    const { ctx, state } = setup({ p1: [C.felarch, C.soulWeaver, C.kurnathi] });
    const weaver = opWith(state, 'p1', C.soulWeaver);
    const mate = opWith(state, 'p1', C.kurnathi);
    state.operatives[weaver]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 9, y: 6 };
    let s = activate(ctx, state, weaver);
    const out = act(ctx, s, weaver, ACT.soulChannel, { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(aplOf(ctx, s, s.operatives[mate]!)).toBe(3);
    // "…until the end of that operative's next activation."
    s = reduce(s, { t: 'EndActivation', operativeId: weaver }, ctx).state;
    s.activePlayer = 'p1';
    s = activate(ctx, s, mate);
    // "Regardless of how many APL stat changes an operative is affected by, the total can
    // never be more than -1 or +1" — SOUL CHANNEL and the Aeldari Raiders grant share one clamp.
    expect(aplOf(ctx, s, s.operatives[mate]!)).toBe(3);
    s = reduce(s, { t: 'EndActivation', operativeId: mate }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'cv.soulChannel')).toBe(false);
    expect(aplOf(ctx, s, s.operatives[mate]!)).toBe(2);
  });

  it('SOUL CHANNEL refuses to select itself, an operative out of range, and while engaged', () => {
    expect(uaText(C.soulWeaver, ACT.soulChannel)).toContain('Select one other friendly CORSAIR VOIDSCARRED operative');
    const { ctx, state } = setup({ p1: [C.felarch, C.soulWeaver, C.kurnathi] });
    const weaver = opWith(state, 'p1', C.soulWeaver);
    const mate = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 1, y: 20 };
    state.operatives[weaver]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 20, y: 6 };
    const s = activate(ctx, state, weaver);
    const op = s.operatives[weaver]!;
    expect(getAction(ACT.soulChannel)!.check(ctx, s, op, { targetOperativeId: weaver }).ok).toBe(false);
    expect(getAction(ACT.soulChannel)!.check(ctx, s, op, { targetOperativeId: mate }).ok).toBe(false);
    s.operatives[mate]!.pos = { x: 9, y: 6 };
    expect(getAction(ACT.soulChannel)!.check(ctx, s, op, { targetOperativeId: mate }).ok).toBe(true);
    // "This operative cannot perform this action while within control range of an enemy operative."
    s.operatives[foe]!.pos = { x: 7, y: 6 };
    expect(getAction(ACT.soulChannel)!.check(ctx, s, op, { targetOperativeId: mate }).ok).toBe(false);
  });

  it('SOUL HEAL: "That operative regains up to 2D3 lost wounds"', () => {
    expect(uaText(C.soulWeaver, ACT.soulHeal)).toContain('regains up to 2D3 lost wounds');
    const { ctx, state } = setup({ p1: [C.felarch, C.soulWeaver, C.kurnathi], script: [5, 3] }); // D3 3 + D3 2
    const weaver = opWith(state, 'p1', C.soulWeaver);
    const mate = opWith(state, 'p1', C.kurnathi);
    state.operatives[weaver]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 9, y: 6 };
    state.operatives[mate]!.wounds = 2;
    const s = activate(ctx, state, weaver);
    const out = act(ctx, s, weaver, ACT.soulHeal, { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mate]!.wounds).toBe(7);
    // …and never above its starting wounds.
    expect(getAction(ACT.soulHeal)!.check(ctx, out.state, out.state.operatives[weaver]!, { targetOperativeId: weaver }).ok).toBe(
      false,
    );
  });

  it('WARP FOLD swaps two friendly operatives’ positions', () => {
    expect(uaText(C.waySeeker, ACT.warpFold)).toContain('set them back up in each other’s previous locations');
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.kurnathi, C.kurniteHunter] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const a = opWith(state, 'p1', C.kurnathi);
    const b = opWith(state, 'p1', C.kurniteHunter);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 1, y: 20 };
    state.operatives[seeker]!.pos = { x: 6, y: 6 };
    state.operatives[a]!.pos = { x: 8, y: 6 };
    state.operatives[b]!.pos = { x: 6, y: 9 };
    const s = activate(ctx, state, seeker);
    const posA = { ...s.operatives[a]!.pos };
    const posB = { ...s.operatives[b]!.pos };
    const out = act(ctx, s, seeker, ACT.warpFold, { targetOperativeId: a, data: { secondOperativeId: b } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[a]!.pos).toEqual(posB);
    expect(out.state.operatives[b]!.pos).toEqual(posA);
  });

  it('WARP FOLD locks the ready operative out of Charge, Fall Back and Reposition for the turning point', () => {
    expect(uaText(C.waySeeker, ACT.warpFold)).toContain(
      'the other cannot perform any of those actions in its activation during this turning point',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.kurnathi, C.kurniteHunter] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const a = opWith(state, 'p1', C.kurnathi);
    const b = opWith(state, 'p1', C.kurniteHunter);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 1, y: 20 };
    state.operatives[seeker]!.pos = { x: 6, y: 6 };
    state.operatives[a]!.pos = { x: 8, y: 6 };
    state.operatives[b]!.pos = { x: 6, y: 9 };
    // A has already Repositioned this turning point; B is still ready.
    let s = activate(ctx, state, a);
    s.operatives[a]!.actionsThisActivation = ['Reposition'];
    s = reduce(s, { t: 'EndActivation', operativeId: a }, ctx).state;
    s.activePlayer = 'p1';
    s = activate(ctx, s, seeker);
    const out = act(ctx, s, seeker, ACT.warpFold, { targetOperativeId: a, data: { secondOperativeId: b } });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.effects.some((e) => e.rule === 'cv.warpFoldLock' && e.operativeId === b)).toBe(true);
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[b]!,
      action: 'Reposition',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    // Dash is not one of the three named actions.
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[b]!, action: 'Dash', allowed: true }).allowed,
    ).toBe(true);
  });

  it('WARDING SHIELD ignores the first attack dice that inflicts Normal Dmg, then ends', () => {
    expect(uaText(C.waySeeker, ACT.wardingShield)).toContain(
      'the first time an attack dice inflicts Normal Dmg on that friendly operative, ignore that inflicted damage',
    );
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.kurnathi] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const mate = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[seeker]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 9, y: 6 };
    let s = activate(ctx, state, seeker);
    s = act(ctx, s, seeker, ACT.wardingShield, { targetOperativeId: mate }).state;
    expect(s.effects.some((e) => e.rule === 'cv.wardingShield' && e.operativeId === mate)).toBe(true);
    // One normal + one crit of a shuriken rifle (3/4) = 7 damage; the normal 3 is ignored.
    fakeShoot(s, foe, mate, 'Shuriken rifle', [
      { value: 4, state: 'normal' },
      { value: 6, state: 'crit' },
    ]);
    const before = s.operatives[mate]!.wounds;
    inflictDamage(ctx, s, s.operatives[mate]!, 7, 'attack');
    expect(s.operatives[mate]!.wounds).toBe(before - 4);
    expect(s.effects.some((e) => e.rule === 'cv.wardingShield')).toBe(false); // "the first time"
  });

  it('WARDING SHIELD ends at the start of the WAY SEEKER’s next activation, and when it is re-cast', () => {
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.kurnathi] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const mate = opWith(state, 'p1', C.kurnathi);
    state.operatives[seeker]!.pos = { x: 6, y: 6 };
    state.operatives[mate]!.pos = { x: 9, y: 6 };
    let s = activate(ctx, state, seeker);
    s = act(ctx, s, seeker, ACT.wardingShield, { targetOperativeId: mate }).state;
    expect(s.effects.some((e) => e.rule === 'cv.wardingShield' && e.operativeId === mate)).toBe(true);
    // "Until the start of this operative's next activation…"
    s = reduce(s, { t: 'EndActivation', operativeId: seeker }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'cv.wardingShield')).toBe(true);
    s.operatives[seeker]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, seeker);
    expect(s.effects.some((e) => e.rule === 'cv.wardingShield')).toBe(false);
    // "…or until it performs this action again (whichever comes first)" — a second cast never
    // leaves two shields standing.
    s = act(ctx, s, seeker, ACT.wardingShield, { targetOperativeId: mate }).state;
    s.operatives[seeker]!.actionsThisActivation = [];
    s = act(ctx, s, seeker, ACT.wardingShield, { targetOperativeId: seeker }).state;
    expect(s.effects.filter((e) => e.rule === 'cv.wardingShield')).toHaveLength(1);
    expect(s.effects.find((e) => e.rule === 'cv.wardingShield')!.operativeId).toBe(seeker);
  });

  it('every unique action refuses to run while within control range of an enemy operative', () => {
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.soulWeaver, C.kurnathi] });
    const seeker = opWith(state, 'p1', C.waySeeker);
    const weaver = opWith(state, 'p1', C.soulWeaver);
    const mate = opWith(state, 'p1', C.kurnathi);
    const foe = opWith(state, 'p2', C.felarch);
    state.operatives[seeker]!.pos = { x: 6, y: 6 };
    state.operatives[weaver]!.pos = { x: 6, y: 8 };
    state.operatives[mate]!.pos = { x: 8, y: 7 };
    state.operatives[foe]!.pos = { x: 6.9, y: 6 };
    for (const id of [ACT.warpFold, ACT.wardingShield]) {
      const r = getAction(id)!.check(ctx, state, state.operatives[seeker]!, { targetOperativeId: mate });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('control range');
    }
    state.operatives[foe]!.pos = { x: 6.9, y: 8 };
    for (const id of [ACT.soulChannel, ACT.soulHeal]) {
      expect(getAction(id)!.check(ctx, state, state.operatives[weaver]!, { targetOperativeId: mate }).ok).toBe(false);
    }
  });

  it('the unique actions are only offered on their own datacards', () => {
    const { ctx, state } = setup({ p1: [C.felarch, C.waySeeker, C.soulWeaver, C.starstormDuellist] });
    const felarch = state.operatives[opWith(state, 'p1', C.felarch)]!;
    const ids = availableActions(ctx, state, felarch).map((a) => a.def.id);
    for (const id of Object.values(ACT)) expect(ids).not.toContain(id);
    const seeker = state.operatives[opWith(state, 'p1', C.waySeeker)]!;
    const seekerIds = availableActions(ctx, state, seeker).map((a) => a.def.id);
    expect(seekerIds).toContain(ACT.warpFold);
    expect(seekerIds).toContain(ACT.wardingShield);
    expect(seekerIds).not.toContain(ACT.soulHeal);
  });
});

// ---------------------------------------------------------------------------
describe('Board-level sanity', () => {
  it('a full activation with the free Dash leaves no APL residue on any operative', () => {
    const { ctx, state } = setup();
    let s = state;
    for (const id of [...s.teams.p1.operativeIds]) {
      s.activePlayer = 'p1';
      s = activate(ctx, s, id);
      s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    }
    for (const id of s.teams.p1.operativeIds) {
      expect(s.operatives[id]!.aplMods).toEqual([]);
      expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2);
    }
  });

  it('the Blink Pack actions do not offer themselves to anyone but the SHADE RUNNER', () => {
    const { ctx, state } = setup();
    const kurnathi = state.operatives[opWith(state, 'p1', C.kurnathi)]!;
    const ids = availableActions(ctx, state, kurnathi).map((a) => a.def.id);
    expect(ids).not.toContain(BLINK_REPOSITION);
    expect(ids).toContain(DASH_BLADEMASTER); // it is the KURNATHI's own carve-out
    const runner = state.operatives[opWith(state, 'p1', C.shadeRunner)]!;
    const runnerIds = availableActions(ctx, state, runner).map((a) => a.def.id);
    expect(runnerIds).toContain(BLINK_REPOSITION);
    expect(runnerIds).not.toContain(DASH_BLADEMASTER);
  });

  it('a Vantage platform still improves the FATE DEALER’s cover save exactly once', () => {
    const map = testMap();
    map.features = [...map.features, vantagePlatform('cv-vantage', 20, 4, 4, 4, 2)];
    const { ctx, state } = setup({ map, p1: [C.felarch, C.fateDealer] });
    const dealer = state.operatives[opWith(state, 'p1', C.fateDealer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.felarch)]!;
    fakeShoot(state, foe.id, dealer.id, 'Shuriken rifle', [], {
      step: 'rollDefence',
      inCover: true,
      vantageImprovedCover: false,
    });
    const ev = defenceEvent(ctx, state, foe, dealer, 'Shuriken rifle', profileOf(C.felarch, 'Shuriken rifle'), {
      coverSave: true,
    });
    expect(ev.extraCoverSaves).toBe(1);
  });
});
