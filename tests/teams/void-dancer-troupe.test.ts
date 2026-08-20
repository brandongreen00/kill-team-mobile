/**
 * VOID-DANCER TROUPE. Every test quotes the printed rule it pins, read out of
 * `data/teams/void-dancer-troupe.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/void-dancer-troupe/
 */
import { describe, expect, it } from 'vitest';
import { getAction } from '../../src/core/actions.ts';
import type { GameContext } from '../../src/core/context.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import { hitOf, moveOf, statMods } from '../../src/core/state.ts';
import { rareRuleTextFor } from '../../src/teams/helpers.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import rawJson from '../../data/teams/void-dancer-troupe.json';
import { applyLoadouts, defaultRoster, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  A,
  ACT,
  ALLEGORIES,
  C,
  DASH_CRESCENDO,
  EQ,
  FP,
  KW,
  REPOSITION_SALVO,
  RULE,
  SAEDATH_ACCOLADE,
  SP,
  allegoryOf,
  fogLocked,
  hasAccolade,
  hasHumblingToken,
  isToxinWeapon,
  movedThisTP,
  pivotalRole,
  saedathGambit,
  tragedyTally,
  voidDancerTroupe,
} from '../../src/teams/void-dancer-troupe/index.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { act, activate, battle, opWith, teamContext } from './harness.ts';

const DATA = teamData('void-dancer-troupe');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;
const RAW_SELECTION = (rawJson as { selection: { constraints: unknown[] } }).selection.constraints;

const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/**
 * `defaultRoster` never reaches the SHADOWSEER row (see the data note below), so the test roster
 * swaps the last PLAYER for one — with its printed "Shuriken pistol; miststave" option.
 */
function troupeRoster(): RosterPickIn[] {
  const picks = defaultRoster(DATA);
  picks[picks.length - 1] = {
    datacardId: C.shadowseer,
    entryId: 'void-dancer-troupe.sel3.shadowseer',
    loadoutIds: ['void-dancer-troupe.g2e3.opt2'],
  };
  return picks;
}

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: ReturnType<typeof testMap>;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([voidDancerTroupe], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = troupeRoster();
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: voidDancerTroupe, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: voidDancerTroupe, picks },
  });
  state.teams.p1.cp = 10;
  state.teams.p2.cp = 10;
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Park every other operative out of the way so a control-range/cover rule stands alone. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of Object.values(state.operatives)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1 + (n % 4) * 1.2, y: 20 - Math.floor(n / 4) * 1.2 };
    n++;
  }
}

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

type FakeDie = { value: number; state: 'crit' | 'normal' | 'fail' | 'struck' };
const pool = (dice: FakeDie[]) => ({
  dice: dice.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
  nextId: dice.length + 1,
});

function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  attack: FakeDie[],
  opts: { profileName?: string; step?: ShootSequence['step']; defence?: FakeDie[] } = {},
): ShootSequence {
  const seq: ShootSequence = {
    kind: 'shoot',
    step: opts.step ?? 'rollDefence',
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
    attack: pool(attack),
    defence: pool(opts.defence ?? []),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[targetId]!.player,
    free: false,
  };
  state.sequence = seq;
  return seq;
}

function fakeFight(
  state: GameState,
  attackerId: string,
  defenderId: string,
  attackerWeapon: string,
  defenderWeapon: string,
  opts: { step?: FightSequence['step']; attack?: FakeDie[]; defence?: FakeDie[] } = {},
): FightSequence {
  const seq: FightSequence = {
    kind: 'fight',
    step: opts.step ?? 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    defenderWeapon,
    defenderCanRetaliate: true,
    attackerPool: pool(opts.attack ?? []),
    defenderPool: pool(opts.defence ?? []),
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
  state.sequence = seq;
  return seq;
}

const defenceEvent = (
  ctx: GameContext,
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  count: number,
) =>
  ctx.hooks.emit('onDefenceDice', state, {
    state,
    ctx: attackCtx(attacker, defender, weaponName, profile),
    count,
    coverSave: false,
    coverSaveAsCrit: false,
    extraCoverSaves: 0,
    mods: zeroStatMods(),
    rerolls: [],
  });

/** Put a kill team into the Gambit step of the Strategy phase. */
function gambitStep(state: GameState, turningPoint = 1): GameState {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  state.turningPoint = turningPoint;
  return state;
}

const useGambit = (ctx: GameContext, state: GameState, gambitId: string, data?: Record<string, unknown>) =>
  reduce(state, { t: 'UseGambit', player: 'p1', gambitId, ...(data ? { data } : {}) }, ctx);

/** Saedath, chosen: the ALLEGORY plus the PIVOTAL ROLE operative. */
function chooseSaedath(
  ctx: GameContext,
  state: GameState,
  allegory: 'epic' | 'melodrama',
  operativeId: string,
): GameState {
  const s = gambitStep(state, 1);
  const out = useGambit(ctx, s, saedathGambit(allegory), { operativeId });
  expect(out.ok).toBe(true);
  out.state.phase = 'firefight';
  out.state.firefightStep = 'performActions';
  return out.state;
}

// ---------------------------------------------------------------------------
describe('VOID-DANCER TROUPE data (pinned against data/teams/void-dancer-troupe.json)', () => {
  it('has 4 datacards, all APL 3 / M 7" / Sv 4+ on 25mm bases', () => {
    expect(DATA.datacards).toHaveLength(4);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 3, move: 7, save: 4, base: { shape: 'round', mm: 25 } });
      expect(card.keywords).toContain(KW);
      expect(card.keywords).toContain('HARLEQUIN');
      expect(card.keywords).toContain('AELDARI');
    }
    expect(DATA.datacards.map((c) => c.wounds)).toEqual([9, 9, 8, 9]);
    expect(DATA.datacards.find((c) => c.id === C.leadPlayer)!.keywords).toContain('LEADER');
    expect(DATA.datacards.find((c) => c.id === C.shadowseer)!.keywords).toContain('PSYKER');
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(C.leadPlayer, 'Fusion pistol')).toMatchObject({ atk: 4, hit: 3, dmgN: 5, dmgC: 3 });
    expect(profileOf(C.leadPlayer, 'Fusion pistol').rules.map((r) => r.raw)).toEqual([
      'Range 3"',
      'Devastating 3',
      'Piercing 2',
    ]);
    expect(profileOf(C.player, 'Neuro disruptor').rules.map((r) => r.id)).toEqual(['Range', 'Piercing', 'Stun']);
    expect(profileOf(C.player, 'Shuriken pistol')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(C.leadPlayer, 'Kiss')).toMatchObject({ atk: 5, hit: 3, dmgN: 3, dmgC: 7 });
    expect(profileOf(C.leadPlayer, 'Power weapon').rules.map((r) => r.raw)).toEqual(['Lethal 5+']);
    expect(profileOf(C.shadowseer, 'Miststave').rules.map((r) => r.id)).toEqual(['Shock']);
    expect(profileOf(C.shadowseer, 'Hallucinogen grenade').rules.map((r) => r.id)).toEqual([
      'Range',
      'Blast',
      'Lethal',
      'SeekLight',
      'Silent',
      'Stun',
    ]);
  });

  it('the shrieker cannon has both printed profiles, each with Humbling Cruelty', () => {
    const cannon = DATA.datacards.find((c) => c.id === C.deathJester)!.weapons.find((w) => w.name === 'Shrieker cannon')!;
    expect(cannon.profiles.map((p) => p.name)).toEqual(['focused', 'sweeping']);
    expect(profileOf(C.deathJester, 'Shrieker cannon', 'focused').rules.map((r) => r.raw)).toEqual([
      'Rending',
      'Heavy (Reposition only)',
      'Humbling Cruelty*',
    ]);
    expect(profileOf(C.deathJester, 'Shrieker cannon', 'sweeping').rules.map((r) => r.raw)).toEqual([
      'Rending',
      'Heavy (Dash only)',
      'Torrent 2"',
      'Humbling Cruelty*',
    ]);
    expect(DATA.rareWeaponRules).toEqual(['HumblingCruelty']);
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment options, 3 abilities and 2 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Saedath', 'Harlequin’s Panoply']);
    expect(voidDancerTroupe.ploys.filter((p) => p.kind === 'strategy').map((p) => p.name)).toEqual([
      'DARTING SALVO',
      'RISING CRESCENDO',
      'PRISMATIC BLUR',
      'CEGORACH’S JEST',
    ]);
    expect(voidDancerTroupe.ploys.filter((p) => p.kind === 'firefight').map((p) => p.name)).toEqual([
      'MURDEROUS ENTRANCE',
      'THE CURTAIN FALLS',
      'ELUSIVE TARGET',
      'DOMINO FIELD',
    ]);
    expect(voidDancerTroupe.equipment.map((e) => e.name)).toEqual([
      'WRAITHBONE TALISMAN',
      'SHRIEKER TOXIN ROUNDS',
      'DEATH MASK',
      'UNDERSTUDY’S MASK',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities).map((a) => a.name)).toEqual([
      'Lead the Performance',
      'Humbling Cruelty',
      'Luck of the Laughing God',
    ]);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'FOG OF DREAMS',
      'MIRROR OF MINDS',
    ]);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap)).toEqual([1, 1]);
    expect(getAction(ACT.fogOfDreams)!.ap).toBe(uniqueActionOf(C.shadowseer, ACT.fogOfDreams).ap);
    expect(getAction(ACT.mirrorOfMinds)!.ap).toBe(uniqueActionOf(C.shadowseer, ACT.mirrorOfMinds).ap);
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    // The committed JSON is wrong for every team; `trimTrailingSection` repairs it at load.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect(rule(SP.cegorachsJest)).not.toContain('Firefight Ploys');
    expect(rule(SP.cegorachsJest).endsWith('for the rest of the sequence.')).toBe(true);
    expect(rule(FP.dominoField)).not.toContain('Faction Equipment');
    expect(rule(FP.dominoField).endsWith('successful attack dice results of 5).')).toBe(true);
  });

  it('the Humbling Cruelty rare rule resolves to the DEATH JESTER’s own datacard ability (D-033)', () => {
    expect(rareRuleTextFor(DATA, 'HumblingCruelty')).toBe(ability(C.deathJester, A.humblingCruelty));
    expect(rareRuleTextFor(DATA, 'HumblingCruelty')).toContain('subtract 2" from its Move stat');
  });

  it('no printed effect list is truncated at a colon, and `notes` / `markerGuide` are empty', () => {
    for (const r of [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment])
      expect(r.text.trim().endsWith(':')).toBe(false);
    for (const a of DATA.datacards.flatMap((c) => [...c.abilities, ...c.uniqueActions]))
      expect(a.text.trim().endsWith(':')).toBe(false);
    expect(NOTES).toEqual([]);
    expect(DATA.markerGuide ?? '').toBe('');
  });

  it('every datacard, ploy and equipment option has an AI hint', () => {
    for (const card of DATA.datacards) expect(voidDancerTroupe.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of voidDancerTroupe.ploys) expect(voidDancerTroupe.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of voidDancerTroupe.equipment)
      expect(voidDancerTroupe.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('VOID-DANCER TROUPE selection', () => {
  it('prints uniqueExcept plus TWO maxItem weapon caps', () => {
    expect(RAW_SELECTION).toEqual([
      { kind: 'uniqueExcept', roles: ['PLAYER'] },
      { kind: 'maxItem', item: 'fusion pistol', max: 1 },
      { kind: 'maxItem', item: 'neuro disruptor', max: 1 },
    ]);
    expect(DATA.selection.rawText).toContain('up to one fusion pistol and up to one neuro disruptor');
  });

  it('defaultRoster is a legal 8-operative kill team with exactly one fusion pistol and one neuro disruptor', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(8); // "1 … LEAD PLAYER" + "7 VOID-DANCER TROUPE operatives"
    const v = validateRosterFor(DATA, picks);
    expect(v.ok).toBe(true);
    expect(voidDancerTroupe.validateRoster(picks).ok).toBe(true);
    expect(picks.map((p) => p.datacardId)).toEqual([
      C.leadPlayer,
      C.deathJester,
      C.player,
      C.player,
      C.player,
      C.player,
      C.player,
      C.player,
    ]);
    const flat = v.weapons.flat().map((w) => w.toLowerCase());
    expect(flat.filter((w) => w === 'fusion pistol')).toHaveLength(1);
    expect(flat.filter((w) => w === 'neuro disruptor')).toHaveLength(1);
    // Data note: the SHADOWSEER row is never reached, so its two PSYCHIC actions are unexercised.
    expect(picks.map((p) => p.datacardId)).not.toContain(C.shadowseer);
  });

  it('both maxItem caps are enforced by the shared validator (docs/DECISIONS.md D-036)', () => {
    const picks = defaultRoster(DATA);
    const twoFusion: RosterPickIn[] = [
      ...picks.slice(0, 2),
      { datacardId: C.player, entryId: 'void-dancer-troupe.sel2.player', loadoutIds: ['void-dancer-troupe.g2e2.g1o1', 'void-dancer-troupe.g2e2.g2o1'] },
      ...picks.slice(3),
    ];
    expect(validateRosterFor(DATA, twoFusion).codes).toContain('maxItem');
    const twoNeuro: RosterPickIn[] = [
      ...picks.slice(0, 3),
      { datacardId: C.player, entryId: 'void-dancer-troupe.sel2.player', loadoutIds: ['void-dancer-troupe.g2e2.g1o2', 'void-dancer-troupe.g2e2.g2o1'] },
      ...picks.slice(4),
    ];
    expect(validateRosterFor(DATA, twoNeuro).codes).toContain('maxItem');
  });

  it('"Other than PLAYER operatives … only include each operative on this list once"', () => {
    const picks = defaultRoster(DATA);
    const twoJesters = [...picks.slice(0, 2), { datacardId: C.deathJester }, ...picks.slice(3)];
    expect(validateRosterFor(DATA, twoJesters).codes).toContain('unique');
    // The test roster (a SHADOWSEER in place of the last PLAYER) is legal.
    expect(validateRosterFor(DATA, troupeRoster()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Saedath — "select an ALLEGORY … and one friendly operative to have the PIVOTAL ROLE"', () => {
  it('slices both ALLEGORIES out of the one printed faction rule', () => {
    expect(ALLEGORIES.map((a) => a.id)).toEqual(['epic', 'melodrama']);
    for (const allegory of ALLEGORIES) {
      expect(rule(RULE.saedath)).toContain(allegory.performance);
      expect(rule(RULE.saedath)).toContain(allegory.accolade);
    }
    expect(ALLEGORIES[0]!.performance).toContain('while fighting');
    expect(ALLEGORIES[1]!.performance).toContain('while shooting');
    expect(ALLEGORIES[0]!.accolade).toContain('melee weapons have the Balanced weapon rule');
    expect(ALLEGORIES[1]!.accolade).toContain('ranged weapons have the Balanced weapon rule');
  });

  it('offers one STRATEGIC GAMBIT per ALLEGORY, and the chosen operative takes the PIVOTAL ROLE', () => {
    const { ctx, state } = setup();
    gambitStep(state, 1);
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(saedathGambit('epic'));
    expect(ids).toContain(saedathGambit('melodrama'));
    const star = opWith(state, 'p1', C.deathJester);
    const out = useGambit(ctx, state, saedathGambit('melodrama'), { operativeId: star });
    expect(out.ok).toBe(true);
    expect(allegoryOf(out.state, 'p1')!.name).toBe('Melodrama');
    expect(pivotalRole(out.state, 'p1')!.id).toBe(star);
    // A faction rule is not a ploy, so it costs no CP.
    expect(out.state.teams.p1.cp).toBe(state.teams.p1.cp);
    // Once an ALLEGORY is selected the choice is withdrawn.
    expect(gambitOptions(ctx, out.state, 'p1').map((o) => o.id)).not.toContain(saedathGambit('epic'));
  });

  it('"Whenever a friendly operative has the PIVOTAL ROLE, it has the ACCOLADE rule of your ALLEGORY"', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.deathJester);
    const s = chooseSaedath(ctx, state, 'melodrama', star);
    expect(hasAccolade(s, s.operatives[star]!)).toBe(true);
    expect(hasAccolade(s, s.operatives[opWith(s, 'p1', C.player)]!)).toBe(false);
  });

  it('Melodrama ACCOLADE: "The operative’s ranged weapons have the Balanced weapon rule"', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.deathJester);
    const s = chooseSaedath(ctx, state, 'melodrama', star);
    const op = s.operatives[star]!;
    const foe = s.operatives[opWith(s, 'p2', C.player)]!;
    const cannon = profileOf(C.deathJester, 'Shrieker cannon', 'focused');
    const ranged = effectiveRules(ctx, s, cannon, { operative: op, target: foe, weaponName: 'Shrieker cannon' });
    expect(ranged.some((r) => r.id === 'Balanced')).toBe(true);
    // Melodrama says nothing about melee.
    const blade = profileOf(C.deathJester, 'Shrieker blade');
    const melee = effectiveRules(ctx, s, blade, { operative: op, target: foe, weaponName: 'Shrieker blade' });
    expect(melee.some((r) => r.id === 'Balanced')).toBe(false);
  });

  it('Epic ACCOLADE: "Whenever this operative is FIGHTING, its melee weapons have the Balanced weapon rule"', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.leadPlayer);
    const s = chooseSaedath(ctx, state, 'epic', star);
    const op = s.operatives[star]!;
    const foe = s.operatives[opWith(s, 'p2', C.player)]!;
    const blade = profileOf(C.leadPlayer, 'Blade');
    const fighting = effectiveRules(ctx, s, blade, { operative: op, target: foe, weaponName: 'Blade' });
    expect(fighting.some((r) => r.id === 'Balanced')).toBe(true);
    // "fighting", not "fighting or retaliating".
    const retaliating = effectiveRules(ctx, s, blade, {
      operative: op,
      target: foe,
      weaponName: 'Blade',
      retaliating: true,
    });
    expect(retaliating.some((r) => r.id === 'Balanced')).toBe(false);
    // …and nothing lands on a ranged weapon.
    const pistol = profileOf(C.leadPlayer, 'Fusion pistol');
    expect(
      effectiveRules(ctx, s, pistol, { operative: op, target: foe, weaponName: 'Fusion pistol' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('"As a STRATEGIC GAMBIT in each SUBSEQUENT turning point … one friendly operative gains the ACCOLADE"', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.leadPlayer);
    let s = chooseSaedath(ctx, state, 'epic', star);
    // Not offered in the first turning point.
    gambitStep(s, 1);
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(SAEDATH_ACCOLADE);
    gambitStep(s, 2);
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).toContain(SAEDATH_ACCOLADE);
    const second = opWith(s, 'p1', C.player);
    const out = useGambit(ctx, s, SAEDATH_ACCOLADE, { operativeId: second });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(hasAccolade(s, s.operatives[second]!)).toBe(true);
    expect(
      effectiveRules(ctx, s, profileOf(C.player, 'Caress'), {
        operative: s.operatives[second]!,
        weaponName: 'Caress',
      }).some((r) => r.id === 'Balanced'),
    ).toBe(true);
  });

  it('Melodrama performance: the PIVOTAL ROLE operative incapacitating while SHOOTING grants an ACCOLADE, once per TP', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.deathJester);
    const s = chooseSaedath(ctx, state, 'melodrama', star);
    const victim = s.operatives[opWith(s, 'p2', C.player)]!;
    fakeShoot(s, star, victim.id, 'Shrieker cannon', [{ value: 6, state: 'crit' }], { profileName: 'focused' });
    const before = Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o)).length;
    ctx.hooks.emit('onIncapacitated', s, { state: s, operative: victim, prevented: false, freeActions: [] });
    const after = Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o)).length;
    expect(after).toBe(before + 1);
    // "Once per turning point".
    const victim2 = s.operatives[opWith(s, 'p2', C.deathJester)]!;
    fakeShoot(s, star, victim2.id, 'Shrieker cannon', [{ value: 6, state: 'crit' }], { profileName: 'focused' });
    ctx.hooks.emit('onIncapacitated', s, { state: s, operative: victim2, prevented: false, freeActions: [] });
    expect(Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o)).length).toBe(after);
  });

  it('the performance is ALLEGORY-specific: a fight kill does nothing under Melodrama, and everything under Epic', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.leadPlayer);
    const s = chooseSaedath(ctx, state, 'melodrama', star);
    const victim = s.operatives[opWith(s, 'p2', C.player)]!;
    fakeFight(s, star, victim.id, 'Blade', 'Caress');
    const before = Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o)).length;
    ctx.hooks.emit('onIncapacitated', s, { state: s, operative: victim, prevented: false, freeActions: [] });
    expect(Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o)).length).toBe(before);

    const second = setup();
    const star2 = opWith(second.state, 'p1', C.leadPlayer);
    const s2 = chooseSaedath(second.ctx, second.state, 'epic', star2);
    const victim2 = s2.operatives[opWith(s2, 'p2', C.player)]!;
    fakeFight(s2, star2, victim2.id, 'Blade', 'Caress');
    const before2 = Object.values(s2.operatives).filter((o) => o.player === 'p1' && hasAccolade(s2, o)).length;
    second.ctx.hooks.emit('onIncapacitated', s2, { state: s2, operative: victim2, prevented: false, freeActions: [] });
    expect(Object.values(s2.operatives).filter((o) => o.player === 'p1' && hasAccolade(s2, o)).length).toBe(before2 + 1);
  });
});

// ---------------------------------------------------------------------------
describe('LEAD PLAYER › Lead the Performance — "change the ALLEGORY you selected"', () => {
  it('is a once-per-battle STRATEGIC GAMBIT and the ACCOLADE rule changes with it', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.leadPlayer);
    let s = chooseSaedath(ctx, state, 'epic', star);
    const op = s.operatives[star]!;
    const pistol = profileOf(C.leadPlayer, 'Fusion pistol');
    expect(effectiveRules(ctx, s, pistol, { operative: op, weaponName: 'Fusion pistol' }).some((r) => r.id === 'Balanced')).toBe(
      false,
    );
    gambitStep(s, 2);
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).toContain(A.leadThePerformance);
    const out = useGambit(ctx, s, A.leadThePerformance);
    expect(out.ok).toBe(true);
    s = out.state;
    expect(allegoryOf(s, 'p1')!.name).toBe('Melodrama');
    // "Note that the ACCOLADE rule friendly operatives have will also change."
    expect(
      effectiveRules(ctx, s, pistol, { operative: s.operatives[star]!, weaponName: 'Fusion pistol' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(true);
    // "Once per battle".
    gambitStep(s, 3);
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(A.leadThePerformance);
  });

  it('"If this operative is in the killzone" — no LEAD PLAYER, no gambit', () => {
    const { ctx, state } = setup();
    const star = opWith(state, 'p1', C.deathJester);
    const s = chooseSaedath(ctx, state, 'epic', star);
    s.operatives[opWith(s, 'p1', C.leadPlayer)]!.removed = true;
    gambitStep(s, 2);
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(A.leadThePerformance);
  });
});

// ---------------------------------------------------------------------------
describe('Harlequin’s Panoply', () => {
  it('"worsen the x of the Piercing weapon rule by 1 … Piercing 1 would therefore be ignored"', () => {
    expect(rule(RULE.panoply)).toContain('Note that Piercing 1 would therefore be ignored');
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.leadPlayer)]!;
    // Piercing 1 → the defender keeps all three dice.
    const neuro = profileOf(C.leadPlayer, 'Neuro disruptor');
    fakeShoot(state, foe.id, target.id, 'Neuro disruptor', [{ value: 4, state: 'normal' }]);
    expect(defenceEvent(ctx, state, foe, target, 'Neuro disruptor', neuro, 2).count).toBe(3);
    // Piercing 2 → Piercing 1.
    const fusion = profileOf(C.leadPlayer, 'Fusion pistol');
    fakeShoot(state, foe.id, target.id, 'Fusion pistol', [{ value: 4, state: 'normal' }]);
    expect(defenceEvent(ctx, state, foe, target, 'Fusion pistol', fusion, 1).count).toBe(2);
  });

  it('"and no attack dice are retained as critical successes" — a retained crit switches it off', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.leadPlayer)]!;
    const neuro = profileOf(C.leadPlayer, 'Neuro disruptor');
    fakeShoot(state, foe.id, target.id, 'Neuro disruptor', [{ value: 6, state: 'crit' }]);
    expect(defenceEvent(ctx, state, foe, target, 'Neuro disruptor', neuro, 2).count).toBe(2);
  });

  it('a weapon with no Piercing is untouched ("(if any)")', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.player)]!;
    const shuriken = profileOf(C.player, 'Shuriken pistol');
    fakeShoot(state, foe.id, target.id, 'Shuriken pistol', [{ value: 4, state: 'normal' }]);
    expect(defenceEvent(ctx, state, foe, target, 'Shuriken pistol', shuriken, 3).count).toBe(3);
  });

  it('the climb clause and the move-within-control-range clause are printed but reminder-only', () => {
    // REMINDER-ONLY: `onMoveRules` is never emitted, so a climb's charged vertical distance has
    // no seam (the Ratlings' Grappling Hook gap).
    expect(rule(RULE.panoply)).toContain('you can treat the vertical distance as 2"');
    // NO-OP BY CONSTRUCTION: `validateMove` only tests the END of a move against enemy control
    // range, so nothing in the engine restricts the middle of a move for anyone.
    expect(rule(RULE.panoply)).toContain('can move within control range of enemy operatives');
  });
});

// ---------------------------------------------------------------------------
describe('DEATH JESTER › Humbling Cruelty (rare weapon rule)', () => {
  function shot(dmg: number, targetWounds?: number) {
    const { ctx, state } = setup();
    const jester = state.operatives[opWith(state, 'p1', C.deathJester)]!;
    const victim = state.operatives[opWith(state, 'p2', C.player)]!;
    if (targetWounds !== undefined) victim.wounds = targetWounds;
    fakeShoot(state, jester.id, victim.id, 'Shrieker cannon', [{ value: 5, state: 'normal' }], {
      profileName: 'focused',
    });
    ctx.hooks.emit('onDamage', state, { state, ctx: null, target: victim, amount: dmg, kind: 'attack' });
    return { ctx, state, victim, jester };
  }

  it('"the target gains one of your Humbling Cruelty tokens" when attack dice inflict damage', () => {
    const { state, victim } = shot(4);
    expect(hasHumblingToken(state, victim.id, 'p1')).toBe(true);
  });

  it('"If the target of this weapon ISN’T INCAPACITATED" — a killing blow hands out nothing', () => {
    const { state, victim } = shot(4, 3);
    expect(hasHumblingToken(state, victim.id, 'p1')).toBe(false);
  });

  it('another weapon does not hand out a token', () => {
    const { ctx, state } = setup();
    const player = state.operatives[opWith(state, 'p1', C.player)]!;
    const victim = state.operatives[opWith(state, 'p2', C.player)]!;
    fakeShoot(state, player.id, victim.id, 'Shuriken pistol', [{ value: 5, state: 'normal' }]);
    ctx.hooks.emit('onDamage', state, { state, ctx: null, target: victim, amount: 3, kind: 'attack' });
    expect(hasHumblingToken(state, victim.id, 'p1')).toBe(false);
  });

  it('"subtract 2" from its Move stat and worsen the Hit stat of its weapons by 1"', () => {
    const { ctx, state, victim } = shot(3);
    expect(moveOf(ctx, state, victim)).toBe(5); // 7" − 2"
    expect(hitOf(ctx, state, victim, profileOf(C.player, 'Shuriken pistol'))).toBe(4); // 3+ worsened to 4+
    expect(statMods(ctx, state, victim)).toMatchObject({ move: -2, hit: -1 });
  });

  it('"This isn’t cumulative with being injured"', () => {
    const { ctx, state, victim } = shot(3);
    victim.wounds = 3; // fewer than half of 8
    expect(statMods(ctx, state, victim)).toMatchObject({ move: 0, hit: 0 });
    expect(moveOf(ctx, state, victim)).toBe(5); // the injured −2" alone
    expect(hitOf(ctx, state, victim, profileOf(C.player, 'Shuriken pistol'))).toBe(4); // the injured +1 alone
  });

  it('"At the end of that enemy operative’s next activation, remove its Humbling Cruelty token"', () => {
    const { ctx, state, victim } = shot(3);
    let s = state;
    s.sequence = null;
    s.activePlayer = 'p2';
    s = activate(ctx, s, victim.id, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: victim.id }, ctx).state;
    expect(hasHumblingToken(s, victim.id, 'p1')).toBe(false);
  });

  it('the token is stripped again if a later dice of the same shot incapacitates the target', () => {
    const { ctx, state, victim } = shot(3);
    expect(hasHumblingToken(state, victim.id, 'p1')).toBe(true);
    ctx.hooks.emit('onIncapacitated', state, { state, operative: victim, prevented: false, freeActions: [] });
    expect(hasHumblingToken(state, victim.id, 'p1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('PLAYER › Luck of the Laughing God — "you can use a firefight ploy for 0CP"', () => {
  it('refunds the ploy when the specified operative is a PLAYER, once per turning point', () => {
    const { ctx, state } = setup();
    const player = opWith(state, 'p1', C.player);
    let s = activate(ctx, state, player, 'engage');
    const before = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.elusiveTarget }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP charged, 1CP refunded
    // "You cannot select the same firefight ploy for this rule more than once per battle."
    s.teams.p1.ploysUsedTP = [];
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.elusiveTarget }, ctx).state;
    expect(s.teams.p1.cp).toBe(before - 1);
  });

  it('does nothing when the specified operative is not a PLAYER', () => {
    const { ctx, state } = setup();
    let s = activate(ctx, state, opWith(state, 'p1', C.deathJester), 'engage');
    const before = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.elusiveTarget }, ctx).state;
    expect(s.teams.p1.cp).toBe(before - 1);
  });

  it('the Command Re-roll half is reminder-only — it never emits onPloyUsed', () => {
    expect(ability(C.player, A.luckOfTheLaughingGod)).toContain('including Command Re-roll');
    // `applyReroll` (src/core/decisions.ts) charges the CP itself and emits nothing.
    const { ctx, state } = setup();
    let s = activate(ctx, state, opWith(state, 'p1', C.player), 'engage');
    const before = s.teams.p1.cp;
    s.teams.p1.cp -= 1;
    s.teams.p1.ploysUsedTP.push('commandReroll:attack');
    expect(s.teams.p1.cp).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
describe('DARTING SALVO — "any remaining move distance it had from that Reposition action"', () => {
  it('is a 0AP `Reposition (DARTING SALVO)` offered only after Reposition → Shoot with the gambit used', () => {
    const { ctx, state } = setup();
    const def = getAction(REPOSITION_SALVO)!;
    expect(def.ap).toBe(0);
    const id = opWith(state, 'p1', C.player);
    let s = activate(ctx, state, id, 'engage');
    const op = s.operatives[id]!;
    op.actionsThisActivation = ['Reposition', 'Shoot'];
    // Without the STRATEGIC GAMBIT it is not available at all.
    expect(def.available!(ctx, s, op)).toBe(false);
    s.teams.p1.gambitsUsedTP.push(SP.dartingSalvo);
    expect(def.available!(ctx, s, op)).toBe(true);
    // …and not the other way round ("it can perform the Shoot action during that action").
    op.actionsThisActivation = ['Shoot', 'Reposition'];
    expect(def.available!(ctx, s, op)).toBe(false);
    expect(def.check(ctx, s, op, {}).reason).toContain('Reposition action interrupted by the Shoot action');
  });

  it('caps the follow-up leg at the move distance the first Reposition left over', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.player);
    isolate(state, [id]);
    place(state, id, 8, 11);
    let s = activate(ctx, state, id, 'engage');
    s.teams.p1.gambitsUsedTP.push(SP.dartingSalvo);
    const moved = act(ctx, s, id, 'Reposition', { path: { points: [{ x: 11, y: 11 }] } });
    expect(moved.ok).toBe(true);
    s = moved.state;
    const op = s.operatives[id]!;
    expect(moveOf(ctx, s, op)).toBe(7);
    op.actionsThisActivation.push('Shoot');
    // 7" Move − the 3" already spent.
    expect(moveBudget(ctx, s, op, { action: 'Reposition' })).toBe(4);
    // The follow-up leg validates within that budget and is refused beyond it.
    expect(getAction(REPOSITION_SALVO)!.check(ctx, s, op, { path: { points: [{ x: 15, y: 11 }] } }).ok).toBe(true);
    expect(getAction(REPOSITION_SALVO)!.check(ctx, s, op, { path: { points: [{ x: 16.5, y: 11 }] } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RISING CRESCENDO — "can perform the Dash action during the same activation in which they performed the Charge action"', () => {
  it('is its own `Dash (RISING CRESCENDO)`, because the universal Dash refuses an activation that Charged', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.player);
    isolate(state, [id]);
    place(state, id, 8, 11);
    let s = activate(ctx, state, id, 'engage');
    const op = s.operatives[id]!;
    op.actionsThisActivation = ['Charge'];
    const path = { points: [{ x: 10, y: 11 }] };
    expect(getAction('Dash')!.check(ctx, s, op, { path }).reason).toContain('already performed Charge');
    // Without the STRATEGIC GAMBIT the carve-out is not available either.
    expect(getAction(DASH_CRESCENDO)!.available!(ctx, s, op)).toBe(false);
    s.teams.p1.gambitsUsedTP.push(SP.risingCrescendo);
    expect(getAction(DASH_CRESCENDO)!.available!(ctx, s, op)).toBe(true);
    expect(getAction(DASH_CRESCENDO)!.check(ctx, s, op, { path }).ok).toBe(true);
    // "…but not vice versa (i.e. not DASH then CHARGE)" needs no code: the universal Charge
    // already refuses after a Dash.
    op.actionsThisActivation = ['Dash'];
    expect(getAction('Charge')!.check(ctx, s, op, { path }).reason).toContain('already performed Reposition, Dash or Fall Back');
    expect(getAction(DASH_CRESCENDO)!.check(ctx, s, op, { path }).reason).toContain('performed the Charge action');
  });

  it('the printed Dash restrictions still apply — it cannot be used while engaged', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [id, foe]);
    place(state, id, 8, 11);
    place(state, foe, 8.7, 11);
    const s = activate(ctx, state, id, 'engage');
    s.teams.p1.gambitsUsedTP.push(SP.risingCrescendo);
    const op = s.operatives[id]!;
    op.actionsThisActivation = ['Charge'];
    expect(getAction(DASH_CRESCENDO)!.check(ctx, s, op, { path: { points: [{ x: 10, y: 11 }] } }).reason).toContain(
      'within control range',
    );
  });
});

// ---------------------------------------------------------------------------
describe('PRISMATIC BLUR — "you can re-roll one of your defence dice"', () => {
  it('is offered when the target moved during this turning point, and not otherwise', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.player);
    const foe = state.operatives[opWith(state, 'p2', C.leadPlayer)]!;
    let s = activate(ctx, state, id, 'engage');
    s.teams.p1.gambitsUsedTP.push(SP.prismaticBlur);
    const target = s.operatives[id]!;
    const shuriken = profileOf(C.leadPlayer, 'Shuriken pistol');
    fakeShoot(s, foe.id, target.id, 'Shuriken pistol', [{ value: 4, state: 'normal' }], { step: 'defenceRerolls' });
    expect(movedThisTP(s, target)).toBe(false);
    expect(defenceEvent(ctx, s, foe, target, 'Shuriken pistol', shuriken, 3).rerolls).toHaveLength(0);
    target.actionsThisActivation.push('Reposition');
    expect(movedThisTP(s, target)).toBe(true);
    const grants = defenceEvent(ctx, s, foe, target, 'Shuriken pistol', shuriken, 3).rerolls;
    expect(grants.map((g) => g.id)).toEqual(['vdt.prismaticBlur']);
    expect(grants[0]).toMatchObject({ mode: 'one', max: 1, player: 'p1' });
  });

  it('does nothing without the STRATEGIC GAMBIT', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.player);
    const foe = state.operatives[opWith(state, 'p2', C.leadPlayer)]!;
    const s = activate(ctx, state, id, 'engage');
    const target = s.operatives[id]!;
    target.actionsThisActivation.push('Reposition');
    fakeShoot(s, foe.id, target.id, 'Shuriken pistol', [{ value: 4, state: 'normal' }], { step: 'defenceRerolls' });
    expect(
      defenceEvent(ctx, s, foe, target, 'Shuriken pistol', profileOf(C.leadPlayer, 'Shuriken pistol'), 3).rerolls,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('CEGORACH’S JEST — "that strike is allocated to block one of your dice instead"', () => {
  function jestFight(script: number[]) {
    const { ctx, state } = setup({ script });
    const mine = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.leadPlayer);
    isolate(state, [mine, foe]);
    place(state, mine, 10, 11);
    place(state, foe, 10.7, 11);
    state.teams.p1.gambitsUsedTP.push(SP.cegorachsJest);
    const seq = fakeFight(state, foe, mine, 'Blade', 'Caress', {
      attack: [{ value: 4, state: 'struck' }, { value: 5, state: 'normal' }],
      defence: [{ value: 6, state: 'crit' }, { value: 4, state: 'normal' }],
    });
    return { ctx, state, seq, mine: state.operatives[mine]!, foe: state.operatives[foe]! };
  }

  it('a low D6 turns the opponent’s normal-success strike into a block and prevents the damage', () => {
    const { ctx, state, seq, mine } = jestFight([2]); // "less than the Hit stat" — the Blade is 3+
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(0);
    expect(seq.attackerPool.dice[0]!.state).toBe('discarded');
    // "block one of your dice" — the dearest unresolved success.
    expect(seq.defenderPool.dice[0]!.state).toBe('blocked');
  });

  it('"you cannot use this rule for the rest of the sequence"', () => {
    const { ctx, state, seq, mine } = jestFight([2, 1]);
    ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 4, kind: 'attack' });
    seq.attackerPool.dice[1]!.state = 'struck';
    const second = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 4, kind: 'attack' });
    expect(second.amount).toBe(4);
  });

  it('a result that is not less than the Hit stat does nothing', () => {
    const { ctx, state, seq, mine } = jestFight([3]); // the Blade's Hit stat is 3+
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(4);
    expect(seq.attackerPool.dice[0]!.state).toBe('struck');
  });

  it('"your opponent strikes with a NORMAL success" — a critical strike is not affected', () => {
    const { ctx, state, seq, mine } = jestFight([1]);
    seq.attackerPool.dice[0]!.value = 6; // a critical success
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 6, kind: 'attack' });
    expect(ev.amount).toBe(6);
  });

  it('does nothing without the STRATEGIC GAMBIT', () => {
    const { ctx, state, mine } = jestFight([1]);
    state.teams.p1.gambitsUsedTP = [];
    expect(ctx.hooks.emit('onDamage', state, { state, ctx: null, target: mine, amount: 4, kind: 'attack' }).amount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('MURDEROUS ENTRANCE — "resolve another of your normal successes as a strike (before your opponent)"', () => {
  function charged() {
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', C.leadPlayer);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [mine, foe]);
    place(state, mine, 10, 11);
    place(state, foe, 10.7, 11);
    const s = activate(ctx, state, mine, 'engage');
    s.operatives[mine]!.actionsThisActivation = ['Charge'];
    fakeFight(s, mine, foe, 'Blade', 'Caress', {
      attack: [{ value: 6, state: 'struck' }, { value: 4, state: 'normal' }, { value: 6, state: 'crit' }],
      defence: [{ value: 4, state: 'normal' }],
    });
    return { ctx, state: s, mine, foe };
  }

  it('resolves the extra strike and hands the turn back to the opponent', () => {
    const { ctx, state, mine, foe } = charged();
    const wounds = state.operatives[foe]!.wounds;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.murderousEntrance }, ctx);
    expect(out.ok).toBe(true);
    // Blade: Normal Dmg 4 — "another of your NORMAL successes", not the critical one.
    expect(out.state.operatives[foe]!.wounds).toBe(wounds - profileOf(C.leadPlayer, 'Blade').dmgN);
    expect(out.state.operatives[mine]!.wounds).toBe(state.operatives[mine]!.wounds);
    const seq = out.state.sequence as FightSequence | null;
    if (seq) expect(seq.turn).toBe('defender');
  });

  it('"during an activation in which it performed the Charge action, after you strike"', () => {
    const { ctx, state, mine } = charged();
    state.operatives[mine]!.actionsThisActivation = [];
    const noCharge = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.murderousEntrance }, ctx);
    expect(noCharge.ok).toBe(false);
    expect(noCharge.reason).toContain('Charge');
    state.operatives[mine]!.actionsThisActivation = ['Charge'];
    (state.sequence as FightSequence).attackerPool.dice[0]!.state = 'normal'; // nothing struck yet
    const noStrike = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.murderousEntrance }, ctx);
    expect(noStrike.ok).toBe(false);
    expect(noStrike.reason).toContain('struck');
  });
});

// ---------------------------------------------------------------------------
describe('THE CURTAIN FALLS — "End that sequence … and immediately perform a free Fall Back action up to 3""', () => {
  function struckCrit() {
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', C.leadPlayer);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [mine, foe]);
    place(state, mine, 10, 11);
    place(state, foe, 10.7, 11);
    const s = activate(ctx, state, mine, 'engage');
    fakeFight(s, mine, foe, 'Blade', 'Caress', {
      attack: [{ value: 6, state: 'struck' }, { value: 5, state: 'normal' }],
      defence: [{ value: 6, state: 'crit' }],
    });
    return { ctx, state: s, mine, foe };
  }

  it('discards the remaining dice, ends the sequence and falls back up to 3"', () => {
    const { ctx, state, mine, foe } = struckCrit();
    const seq = state.sequence as FightSequence;
    const from = { ...state.operatives[mine]!.pos };
    const wounds = state.operatives[foe]!.wounds;
    // Emitted straight onto the state the test owns, so the discarded dice stay observable —
    // `reduce` clones, and the ploy clears `state.sequence` on the clone.
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: FP.theCurtainFalls,
      kind: 'firefight',
    });
    expect(state.sequence).toBeNull();
    expect(seq.step).toBe('done');
    expect(seq.attackerPool.dice.every((d) => d.state !== 'normal' && d.state !== 'crit')).toBe(true);
    expect(seq.defenderPool.dice.every((d) => d.state !== 'normal' && d.state !== 'crit')).toBe(true);
    const moved = state.operatives[mine]!.pos;
    const travelled = Math.hypot(moved.x - from.x, moved.y - from.y);
    expect(travelled).toBeGreaterThan(0);
    expect(travelled).toBeLessThanOrEqual(3 + 1e-6);
    // It ends the move away from the enemy, out of its control range.
    expect(moved.x).toBeLessThan(from.x);
    expect(state.operatives[foe]!.wounds).toBe(wounds);
  });

  it('is used through the reducer as a 1CP firefight ploy', () => {
    const { ctx, state } = struckCrit();
    const cp = state.teams.p1.cp;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.theCurtainFalls }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.cp).toBe(cp - 1);
    expect(out.state.sequence).toBeNull();
  });

  it('"after you strike with a critical success, if the enemy operative isn’t incapacitated"', () => {
    const { ctx, state, foe } = struckCrit();
    (state.sequence as FightSequence).attackerPool.dice[0]!.value = 4; // a normal success, not a crit
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.theCurtainFalls }, ctx).reason).toContain(
      'critical success',
    );
    (state.sequence as FightSequence).attackerPool.dice[0]!.value = 6;
    state.operatives[foe]!.incapacitated = true;
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.theCurtainFalls }, ctx).reason).toContain(
      'incapacitated',
    );
  });
});

// ---------------------------------------------------------------------------
describe('ELUSIVE TARGET — "while that operative has a Conceal order and is in cover, it cannot be selected"', () => {
  it('takes precedence over Seek and Vantage, except within 2"', () => {
    const map = testMap({ features: [heavyBlock('block', 12, 10, 1, 4, 2)] });
    const { ctx, state } = setup({ map });
    const mine = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.leadPlayer);
    isolate(state, [mine, foe]);
    place(state, mine, 13.6, 11);
    place(state, foe, 6, 11);
    let s = activate(ctx, state, mine, 'conceal');
    const validTarget = (st: GameState, ignore: 'none' | 'all' = 'none') =>
      ctx.hooks.emit('onValidTarget', st, {
        state: st,
        attacker: st.operatives[foe]!,
        target: st.operatives[mine]!,
        valid: true,
        ignoreCoverTerrain: ignore,
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(validTarget(s)).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.elusiveTarget }, ctx).state;
    expect(validTarget(s)).toBe(false);
    // "taking precedence over all other rules (e.g. Seek, Vantage terrain)"
    expect(validTarget(s, 'all')).toBe(false);
    // "…except being within 2"."
    place(s, foe, 12.2, 11);
    expect(validTarget(s)).toBe(true);
    // An Engage order is not covered by the ploy.
    place(s, foe, 6, 11);
    s.operatives[mine]!.order = 'engage';
    expect(validTarget(s)).toBe(true);
  });

  it('"Until the start of its next activation" — the effect is dropped when it activates again', () => {
    const map = testMap({ features: [heavyBlock('block', 12, 10, 1, 4, 2)] });
    const { ctx, state } = setup({ map });
    const mine = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.leadPlayer);
    isolate(state, [mine, foe]);
    place(state, mine, 13.6, 11);
    place(state, foe, 6, 11);
    let s = activate(ctx, state, mine, 'conceal');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.elusiveTarget }, ctx).state;
    s = reduce(s, { t: 'EndActivation', operativeId: mine }, ctx).state;
    s.operatives[mine]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, mine, 'conceal');
    expect(
      ctx.hooks.emit('onValidTarget', s, {
        state: s,
        attacker: s.operatives[foe]!,
        target: s.operatives[mine]!,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('DOMINO FIELD — "block all of your opponent’s attack dice with matching results"', () => {
  it('spends one rolled defence success to block every attack dice showing that result', () => {
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.player); // its printed loadout carries the neuro disruptor
    fakeShoot(
      state,
      foe,
      mine,
      'Neuro disruptor',
      [
        { value: 5, state: 'normal' },
        { value: 5, state: 'normal' },
        { value: 3, state: 'fail' },
      ],
      { step: 'allocate', defence: [{ value: 5, state: 'normal' }, { value: 2, state: 'fail' }] },
    );
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.dominoField }, ctx);
    expect(out.ok).toBe(true);
    const seq = out.state.sequence as ShootSequence;
    expect(seq.attack.dice.filter((d) => d.state === 'blocked')).toHaveLength(2);
    expect(seq.defence.dice[0]!.state).toBe('discarded');
    // Both successes were blocked, so nothing reached the operative.
    expect(out.state.operatives[mine]!.wounds).toBe(state.operatives[mine]!.wounds);
  });

  it('is refused when no rolled defence success matches an attack dice', () => {
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', C.player);
    const foe = opWith(state, 'p2', C.player);
    fakeShoot(state, foe, mine, 'Neuro disruptor', [{ value: 4, state: 'normal' }], {
      step: 'allocate',
      defence: [{ value: 5, state: 'normal' }],
    });
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.dominoField }, ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('matches');
  });
});

// ---------------------------------------------------------------------------
describe('WRAITHBONE TALISMAN — "discard one of them to retain another as a normal success"', () => {
  it('fires when SHOOTING, at the retention step', () => {
    const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
    const shooter = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.player)]!;
    const seq = fakeShoot(
      state,
      shooter.id,
      foe.id,
      'Shuriken pistol',
      [
        { value: 1, state: 'fail' },
        { value: 2, state: 'fail' },
        { value: 5, state: 'normal' },
      ],
      { step: 'retention' },
    );
    effectiveRules(ctx, state, profileOf(C.player, 'Shuriken pistol'), {
      operative: shooter,
      target: foe,
      weaponName: 'Shuriken pistol',
    });
    expect(seq.attack.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'normal']);
  });

  it('fires when FIGHTING and when RETALIATING — `onWeaponRules` is emitted by both sequences', () => {
    for (const retaliating of [false, true]) {
      const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
      const mine = opWith(state, 'p1', C.player);
      const foe = opWith(state, 'p2', C.player);
      const seq = fakeFight(state, retaliating ? foe : mine, retaliating ? mine : foe, 'Caress', 'Caress', {
        step: 'retention',
        ...(retaliating
          ? { defence: [{ value: 1, state: 'fail' }, { value: 3, state: 'fail' }] }
          : { attack: [{ value: 1, state: 'fail' }, { value: 3, state: 'fail' }] }),
      });
      effectiveRules(ctx, state, profileOf(C.player, 'Caress'), {
        operative: state.operatives[mine]!,
        weaponName: 'Caress',
        retaliating,
      });
      const myPool = retaliating ? seq.defenderPool : seq.attackerPool;
      expect(myPool.dice.map((d) => d.state)).toEqual(['discarded', 'normal']);
    }
  });

  it('"if you roll TWO OR MORE fails" and "once per turning point"', () => {
    const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
    const shooter = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.player)]!;
    const profile = profileOf(C.player, 'Shuriken pistol');
    const one = fakeShoot(state, shooter.id, foe.id, 'Shuriken pistol', [{ value: 1, state: 'fail' }], {
      step: 'retention',
    });
    effectiveRules(ctx, state, profile, { operative: shooter, weaponName: 'Shuriken pistol' });
    expect(one.attack.dice[0]!.state).toBe('fail');
    const two = fakeShoot(
      state,
      shooter.id,
      foe.id,
      'Shuriken pistol',
      [{ value: 1, state: 'fail' }, { value: 2, state: 'fail' }],
      { step: 'retention' },
    );
    effectiveRules(ctx, state, profile, { operative: shooter, weaponName: 'Shuriken pistol' });
    expect(two.attack.dice.map((d) => d.state)).toEqual(['discarded', 'normal']);
    const three = fakeShoot(
      state,
      shooter.id,
      foe.id,
      'Shuriken pistol',
      [{ value: 1, state: 'fail' }, { value: 2, state: 'fail' }],
      { step: 'retention' },
    );
    effectiveRules(ctx, state, profile, { operative: shooter, weaponName: 'Shuriken pistol' });
    expect(three.attack.dice.map((d) => d.state)).toEqual(['fail', 'fail']);
  });

  it('does nothing without the equipment', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.player)]!;
    const seq = fakeShoot(
      state,
      shooter.id,
      opWith(state, 'p2', C.player),
      'Shuriken pistol',
      [{ value: 1, state: 'fail' }, { value: 2, state: 'fail' }],
      { step: 'retention' },
    );
    effectiveRules(ctx, state, profileOf(C.player, 'Shuriken pistol'), {
      operative: shooter,
      weaponName: 'Shuriken pistol',
    });
    expect(seq.attack.dice.map((d) => d.state)).toEqual(['fail', 'fail']);
  });
});

// ---------------------------------------------------------------------------
describe('SHRIEKER TOXIN ROUNDS — "that weapon has the Devastating 1 weapon rule"', () => {
  const selectWeapon = (
    ctx: GameContext,
    state: GameState,
    attacker: OperativeState,
    target: OperativeState,
    weaponName: string,
    profile: WeaponProfile,
    dryRun: boolean,
  ) =>
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(attacker, target, weaponName, profile),
      allowed: true,
      dryRun,
    });

  it('names the two printed weapons', () => {
    expect(rule(EQ.shriekerToxinRounds)).toContain('shuriken pistol or shrieker cannon (focused)');
    expect(isToxinWeapon('Shuriken pistol', profileOf(C.player, 'Shuriken pistol'))).toBe(true);
    expect(isToxinWeapon('Shrieker cannon', profileOf(C.deathJester, 'Shrieker cannon', 'focused'))).toBe(true);
    expect(isToxinWeapon('Shrieker cannon', profileOf(C.deathJester, 'Shrieker cannon', 'sweeping'))).toBe(false);
    expect(isToxinWeapon('Neuro disruptor', profileOf(C.player, 'Neuro disruptor'))).toBe(false);
  });

  it('arms at Select Weapon and adds Devastating 1 for the rest of that action, once per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.shriekerToxinRounds] });
    const shooter = state.operatives[opWith(state, 'p1', C.player)]!;
    const foe = state.operatives[opWith(state, 'p2', C.player)]!;
    const profile = profileOf(C.player, 'Shuriken pistol');
    const use = () =>
      effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Shuriken pistol' }).some(
        (r) => r.id === 'Devastating',
      );
    expect(use()).toBe(false);
    // The Shoot action's `check` runs it as a dry run, which must never spend the rule (D-032).
    selectWeapon(ctx, state, shooter, foe, 'Shuriken pistol', profile, true);
    expect(use()).toBe(false);
    selectWeapon(ctx, state, shooter, foe, 'Shuriken pistol', profile, false);
    expect(use()).toBe(true);
    // "Once per turning point" — a second operative gets nothing this turning point.
    const other = state.operatives[opWith(state, 'p1', C.deathJester)]!;
    selectWeapon(ctx, state, other, foe, 'Shrieker cannon', profileOf(C.deathJester, 'Shrieker cannon', 'focused'), false);
    expect(
      effectiveRules(ctx, state, profileOf(C.deathJester, 'Shrieker cannon', 'focused'), {
        operative: other,
        weaponName: 'Shrieker cannon',
      }).some((r) => r.id === 'Devastating'),
    ).toBe(false);
  });

  it('the sweeping profile is not armed', () => {
    const { ctx, state } = setup({ equipment: [EQ.shriekerToxinRounds] });
    const jester = state.operatives[opWith(state, 'p1', C.deathJester)]!;
    const foe = state.operatives[opWith(state, 'p2', C.player)]!;
    const sweeping = profileOf(C.deathJester, 'Shrieker cannon', 'sweeping');
    selectWeapon(ctx, state, jester, foe, 'Shrieker cannon', sweeping, false);
    expect(
      effectiveRules(ctx, state, sweeping, { operative: jester, weaponName: 'Shrieker cannon' }).some(
        (r) => r.id === 'Devastating',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DEATH MASK — "when your Tragedy tally reaches 3, you gain 1CP and stop that tally"', () => {
  it('counts only friendly operatives that have an ACCOLADE rule, and pays out once', () => {
    const { ctx, state } = setup({ equipment: [EQ.deathMask] });
    const star = opWith(state, 'p1', C.leadPlayer);
    let s = chooseSaedath(ctx, state, 'epic', star);
    // Two more ACCOLADEs, one per subsequent turning point.
    for (const tp of [2, 3]) {
      gambitStep(s, tp);
      s.teams.p1.gambitsUsedTP = [];
      s = useGambit(ctx, s, SAEDATH_ACCOLADE).state;
    }
    const holders = Object.values(s.operatives).filter((o) => o.player === 'p1' && hasAccolade(s, o));
    expect(holders).toHaveLength(3);
    const noAccolade = Object.values(s.operatives).find((o) => o.player === 'p1' && !hasAccolade(s, o))!;
    ctx.hooks.emit('onIncapacitated', s, { state: s, operative: noAccolade, prevented: false, freeActions: [] });
    expect(tragedyTally(s, 'p1')).toBe(0);
    const cp = s.teams.p1.cp;
    for (const holder of holders)
      ctx.hooks.emit('onIncapacitated', s, { state: s, operative: holder, prevented: false, freeActions: [] });
    expect(tragedyTally(s, 'p1')).toBe(3);
    expect(s.teams.p1.cp).toBe(cp + 1);
    // "…and stop that tally."
    ctx.hooks.emit('onIncapacitated', s, { state: s, operative: holders[0]!, prevented: false, freeActions: [] });
    expect(tragedyTally(s, 'p1')).toBe(3);
    expect(s.teams.p1.cp).toBe(cp + 1);
  });
});

// ---------------------------------------------------------------------------
describe('UNDERSTUDY’S MASK — "that activated operative has the PIVOTAL ROLE for the battle"', () => {
  it('transfers the PIVOTAL ROLE once per battle, only once the holder is incapacitated', () => {
    const { ctx, state } = setup({ equipment: [EQ.understudysMask] });
    const star = opWith(state, 'p1', C.leadPlayer);
    let s = chooseSaedath(ctx, state, 'epic', star);
    const understudy = opWith(s, 'p1', C.deathJester);
    // While the PIVOTAL ROLE operative lives, nothing happens.
    s = activate(ctx, s, understudy, 'engage');
    expect(pivotalRole(s, 'p1')!.id).toBe(star);
    s = reduce(s, { t: 'EndActivation', operativeId: understudy }, ctx).state;
    s.operatives[star]!.incapacitated = true;
    s.operatives[star]!.removed = true;
    const next = opWith(s, 'p1', C.player);
    s.activePlayer = 'p1';
    s = activate(ctx, s, next, 'engage');
    expect(pivotalRole(s, 'p1')!.id).toBe(next);
    expect(hasAccolade(s, s.operatives[next]!)).toBe(true);
    // "Once per battle."
    s = reduce(s, { t: 'EndActivation', operativeId: next }, ctx).state;
    s.operatives[next]!.incapacitated = true;
    const third = s.teams.p1.operativeIds.find((id) => id !== star && id !== next && id !== understudy)!;
    s.activePlayer = 'p1';
    s = activate(ctx, s, third, 'engage');
    expect(pivotalRole(s, 'p1')!.id).toBe(next);
  });
});

// ---------------------------------------------------------------------------
describe('SHADOWSEER › FOG OF DREAMS 1AP', () => {
  function shadowseerBattle(script?: number[]) {
    const { ctx, state } = setup(script ? { script } : {});
    const seer = opWith(state, 'p1', C.shadowseer);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [seer, foe]);
    place(state, seer, 10, 11);
    place(state, foe, 16, 11);
    return { ctx, state, seer, foe };
  }

  it('"Select one ready enemy operative visible to this operative and roll one D6"', () => {
    const { ctx, state, seer, foe } = shadowseerBattle([3]);
    const s = activate(ctx, state, seer, 'engage');
    const out = act(ctx, s, seer, ACT.fogOfDreams, { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    expect(out.state.rejected).toHaveLength(0);
    expect(fogLocked(out.state, out.state.operatives[foe]!)).toBe(true);
    // "…cannot be activated or perform actions"
    const blocked = ctx.hooks.emit('canPerformAction', out.state, {
      state: out.state,
      operative: out.state.operatives[foe]!,
      action: 'Shoot',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('FOG OF DREAMS');
  });

  it('"until your opponent has activated a number of enemy operatives … equal to the result of the D6"', () => {
    const { ctx, state, seer, foe } = shadowseerBattle([2]);
    let s = activate(ctx, state, seer, 'engage');
    s = act(ctx, s, seer, ACT.fogOfDreams, { targetOperativeId: foe }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: seer }, ctx).state;
    expect(fogLocked(s, s.operatives[foe]!)).toBe(true);
    for (const id of s.teams.p2.operativeIds.filter((x) => x !== foe).slice(0, 2)) {
      s.activePlayer = 'p2';
      s = activate(ctx, s, id, 'engage');
      s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    }
    expect(fogLocked(s, s.operatives[foe]!)).toBe(false);
  });

  it('"…or until it’s the last enemy operative to be activated"', () => {
    const { ctx, state, seer, foe } = shadowseerBattle([6]);
    let s = activate(ctx, state, seer, 'engage');
    s = act(ctx, s, seer, ACT.fogOfDreams, { targetOperativeId: foe }).state;
    expect(fogLocked(s, s.operatives[foe]!)).toBe(true);
    for (const id of s.teams.p2.operativeIds) if (id !== foe) s.operatives[id]!.ready = false;
    expect(fogLocked(s, s.operatives[foe]!)).toBe(false);
  });

  it('"This operative cannot perform this action while within control range of an enemy operative"', () => {
    const { ctx, state, seer, foe } = shadowseerBattle();
    place(state, foe, 10.7, 11);
    const s = activate(ctx, state, seer, 'engage');
    const out = act(ctx, s, seer, ACT.fogOfDreams, { targetOperativeId: foe });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('control range');
  });

  it('an expended enemy operative is not a legal target ("one READY enemy operative")', () => {
    const { ctx, state, seer, foe } = shadowseerBattle();
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.ready = false;
    const s = activate(ctx, state, seer, 'engage');
    const out = act(ctx, s, seer, ACT.fogOfDreams, { targetOperativeId: foe });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('ready enemy operative');
  });
});

// ---------------------------------------------------------------------------
describe('SHADOWSEER › MIRROR OF MINDS 1AP', () => {
  it('pairs five D6 each and inflicts D3 damage per matching pair', () => {
    // yours 6,5,4,3,2 · theirs 6,5,1,1,1 → two pairs → 2 × D3 (6→3, 6→3) = 6 damage.
    const script = [6, 5, 4, 3, 2, 6, 5, 1, 1, 1, 6, 6];
    const { ctx, state } = setup({ script });
    const seer = opWith(state, 'p1', C.shadowseer);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [seer, foe]);
    place(state, seer, 10, 11);
    place(state, foe, 16, 11);
    const wounds = state.operatives[foe]!.wounds;
    const s = activate(ctx, state, seer, 'engage');
    const out = act(ctx, s, seer, ACT.mirrorOfMinds, { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe]!.wounds).toBe(wounds - 6);
  });

  it('"(to a maximum of 8)"', () => {
    const script = [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6];
    const { ctx, state } = setup({ script });
    const seer = opWith(state, 'p1', C.shadowseer);
    const foe = opWith(state, 'p2', C.leadPlayer);
    isolate(state, [seer, foe]);
    place(state, seer, 10, 11);
    place(state, foe, 16, 11);
    const wounds = state.operatives[foe]!.wounds;
    const s = activate(ctx, state, seer, 'engage');
    const out = act(ctx, s, seer, ACT.mirrorOfMinds, { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe]!.wounds).toBe(wounds - 8);
  });

  it('"within 8" of this operative" — and the whole legality lives in `check` (D-026)', () => {
    const { ctx, state } = setup();
    const seer = opWith(state, 'p1', C.shadowseer);
    const foe = opWith(state, 'p2', C.player);
    isolate(state, [seer, foe]);
    place(state, seer, 4, 11);
    place(state, foe, 20, 11);
    const s = activate(ctx, state, seer, 'engage');
    const def = getAction(ACT.mirrorOfMinds)!;
    expect(def.check(ctx, s, s.operatives[seer]!, { targetOperativeId: foe }).ok).toBe(false);
    // A friendly operative is never selectable, and `check` says so rather than `perform`.
    expect(def.check(ctx, s, s.operatives[seer]!, { targetOperativeId: opWith(s, 'p1', C.player) }).ok).toBe(false);
    const out = act(ctx, s, seer, ACT.mirrorOfMinds, { targetOperativeId: foe });
    expect(out.ok).toBe(false);
    expect(out.state.rejected).toHaveLength(1); // rejected by `check`, never by `perform`
  });
});

// ---------------------------------------------------------------------------
describe('module wiring', () => {
  it('registers both SHADOWSEER actions plus the two D-021 carve-outs, gated to their owners', () => {
    const { ctx, state } = setup();
    const seer = state.operatives[opWith(state, 'p1', C.shadowseer)]!;
    const player = state.operatives[opWith(state, 'p1', C.player)]!;
    for (const id of [ACT.fogOfDreams, ACT.mirrorOfMinds]) {
      expect(getAction(id)!.available!(ctx, state, seer)).toBe(true);
      expect(getAction(id)!.available!(ctx, state, player)).toBe(false);
    }
    expect(getAction(DASH_CRESCENDO)!.treatedAs).toBe('Dash');
    expect(getAction(REPOSITION_SALVO)!.treatedAs).toBeUndefined();
  });

  it('applyLoadouts records the printed loadout the roster picked', () => {
    const picks = troupeRoster();
    const v = validateRosterFor(DATA, picks);
    const { state } = setup();
    applyLoadouts(state, state.teams.p1.operativeIds, v.weapons);
    const seer = opWith(state, 'p1', C.shadowseer);
    expect((state.opState['loadout'] as Record<string, string[]>)[seer]).toEqual([
      'Hallucinogen grenade',
      'Shuriken pistol',
      'Miststave',
    ]);
  });
});
