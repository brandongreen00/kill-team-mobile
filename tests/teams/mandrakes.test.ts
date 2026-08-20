/**
 * MANDRAKES. Every test quotes the printed rule it pins, read out of
 * `data/teams/mandrakes.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/mandrakes/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { newPool } from '../../src/core/dice.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { advanceShoot, checkTarget, effectiveRules, smokeAreas, startShoot } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, aplOf, inflictDamage, moveOf, saveOf, hitOf, weaponsOf } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import { teamData } from '../../src/teams/data.ts';
import { rareRuleText, rareRuleTextFor } from '../../src/teams/helpers.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import {
  AB,
  ABYSSAL,
  ACT,
  BALEFIRE_TOKEN,
  BLADE_IN_THE_DARK_CHARGE,
  BONE_DART,
  CHOOSER,
  DIRGEMAW,
  EQ,
  FP,
  NIGHTFIEND,
  NOWHERE_EFFECT,
  OUBLIEX_ACTIVE,
  PAREIDOLIC_EFFECT,
  PASSAGE_LOCK,
  RULE,
  SHADEWEAVER,
  SHADOWS_BITE_EFFECT,
  SHADOW_GLYPH_EFFECT,
  SHADOW_PASSAGE_ACTION,
  SOUL_HARVEST_DECISION,
  SP,
  WARRIOR,
  mandrakes,
  portalMarkers,
  soulFeastRecord,
  soulHarvest,
  withinShadow,
} from '../../src/teams/mandrakes/index.ts';
import { makeTeamHooks, type TeamHooks } from '../../src/teams/helpers.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';
import { act, activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, OperativeState, Vec2, WeaponProfile } from '../../src/core/types.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';

const DATA = teamData('mandrakes');

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/** The five list roles plus the NIGHTFIEND: one of each, plus WARRIORs to fill the 9. */
const ROLES = [NIGHTFIEND, ABYSSAL, CHOOSER, DIRGEMAW, SHADEWEAVER, WARRIOR];

/** A killzone with one Heavy block and one Vantage platform, for the WITHIN SHADOW tests. */
function shadowMap(): KillzoneMap {
  return testMap({ features: [heavyBlock('heavy', 12, 4, 3, 3, 3), vantagePlatform('gantry', 12, 14, 4, 4, 3)] });
}

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
  foeIsKasrkin?: boolean;
  /** CP for the Mandrake player; both teams start at 0 so no Command Re-roll decision fires. */
  cp?: number;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState; T: TeamHooks } {
  const modules = opts.foeIsKasrkin ? [mandrakes, kasrkin] : [mandrakes];
  const ctx = teamContext(modules, opts.script ? { script: opts.script } : { seed: opts.seed ?? 9 });
  const map = opts.map ?? shadowMap();
  ctx.maps.set(map.id, map);
  const picks = rosterIncluding(mandrakes, ROLES);
  const state = battle({
    ctx,
    map,
    p1: { module: mandrakes, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: opts.foeIsKasrkin ? { module: kasrkin } : { module: mandrakes, picks },
  });
  state.teams.p1.cp = opts.cp ?? 0;
  state.teams.p2.cp = 0;
  return { ctx, state, T: makeTeamHooks(DATA, 'p1', ctx) };
}

const place = (state: GameState, id: string, x: number, y: number, z = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = z;
  return op;
};

/** The melee weapon an operative actually carries, for a fight the test starts by hand. */
const meleeOf = (ctx: GameContext, state: GameState, opId: string): string =>
  weaponsOf(ctx, state, state.operatives[opId]!, 'melee')[0]!.name;
/** The first ranged weapon an operative actually carries. */
const rangedOf = (ctx: GameContext, state: GameState, opId: string) =>
  weaponsOf(ctx, state, state.operatives[opId]!, 'ranged')[0]!;
/** The n-th enemy operative. Index 0 is the KASRKIN SERGEANT, which is APL 3. */
const foeAt = (state: GameState, i: number): string => state.teams.p2.operativeIds[i]!;

/**
 * Take everything not under test out of the killzone, so no third operative interferes with a
 * control-range, visibility or valid-target rule.
 */
function isolate(state: GameState, keep: string[]): void {
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.removed = true;
    op.ready = false;
  }
}

/** A shoot sequence parked at its Resolve Attack Dice step, with `n` unblocked normal successes. */
function fakeShoot(
  attackerId: string,
  targetId: string,
  weaponName: string,
  attacker: 'p1' | 'p2',
  defender: 'p1' | 'p2',
  n: number,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'resolve',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: {
      dice: Array.from({ length: n }, (_, i) => ({ id: i + 1, value: 4, state: 'normal' as const, rolled: true })),
      nextId: n + 1,
    },
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker,
    defender,
    free: false,
  };
}

/** Somewhere on the open floor, at least 1" from the Heavy block and clear of the gantry. */
const OPEN: Vec2 = { x: 22, y: 10 };
/** Touching the Heavy block, so the operative is WITHIN SHADOW. */
const SHADE: Vec2 = { x: 15.7, y: 5.5 };

// ---------------------------------------------------------------------------
describe('MANDRAKES data (pinned against data/teams/mandrakes.json)', () => {
  it('has 6 datacards, all MANDRAKE AELDARI DRUKHARI, APL 2 / M 7" / Sv 5+ on 28mm bases', () => {
    expect(DATA.datacards).toHaveLength(6);
    expect(DATA.datacards.map((c) => c.id)).toEqual([NIGHTFIEND, ABYSSAL, CHOOSER, DIRGEMAW, SHADEWEAVER, WARRIOR]);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, move: 7, save: 5, base: { shape: 'round', mm: 28 } });
      expect(card.keywords.slice(0, 3)).toEqual(['MANDRAKE', 'AELDARI', 'DRUKHARI']);
    }
    // "the NIGHTFIEND is the only 9-wound operative; everything else has 8."
    expect(DATA.datacards.filter((c) => c.wounds === 9).map((c) => c.id)).toEqual([NIGHTFIEND]);
    expect(DATA.datacards.filter((c) => c.wounds === 8)).toHaveLength(5);
    expect(DATA.datacards.find((c) => c.id === NIGHTFIEND)!.keywords).toContain('LEADER');
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(NIGHTFIEND, 'Baleblast')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(NIGHTFIEND, 'Huskblade')).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 6 });
    expect(profileOf(ABYSSAL, 'Balesurge', 'blast')).toMatchObject({ atk: 5, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(ABYSSAL, 'Balesurge', 'burn').rules.map((r) => r.id)).toEqual(['Lethal', 'Soulstrike']);
    expect(profileOf(CHOOSER, 'Baleblade')).toMatchObject({ atk: 4, hit: 3, dmgN: 5, dmgC: 6 });
    expect(profileOf(DIRGEMAW, 'Horrifying scream').rules.map((r) => r.id)).toEqual([
      'Range',
      'Devastating',
      'SeekLight',
      'Stun',
      'Soulstrike',
    ]);
    // Shadow Warrior adds 1 to the Critical Dmg of the glimmersteel blade, so its two Dmg
    // stats must stay distinguishable (4/5) for the per-dice damage read.
    expect(profileOf(WARRIOR, 'Glimmersteel blade')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
  });

  it('Soulstrike is the only rare weapon rule and sits on all eight baleblast/balesurge/scream profiles', () => {
    expect(DATA.rareWeaponRules).toEqual(['Soulstrike']);
    const carriers = DATA.datacards.flatMap((c) =>
      c.weapons.flatMap((w) => w.profiles.filter((p) => p.rules.some((r) => r.id === 'Soulstrike')).map(() => `${c.id}:${w.name}`)),
    );
    expect(carriers).toHaveLength(8);
    expect(new Set(carriers.map((s) => s.split(':')[1]))).toEqual(
      new Set(['Baleblast', 'Balesurge', 'Horrifying scream']),
    );
  });

  it('exposes 4 faction rules, 4+4 ploys, 4 equipment options, 8 abilities and 3 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual([
      'Soulstrike',
      'Shadow Passage',
      'Umbral Entities',
      'Within Shadow',
    ]);
    expect(mandrakes.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(mandrakes.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(mandrakes.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(8);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(3);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => `${a.name} ${a.ap}AP`)).toEqual([
      'WREATHE IN BALEFIRE 1AP',
      'PAREIDOLIC PROJECTION 1AP',
      'WEAVE DARKNESS 1AP',
    ]);
  });

  it('the scraped section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.strategyPloys[3]!.text.endsWith('you can re-roll one of your attack dice.')).toBe(true);
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.firefightPloys[3]!.text.endsWith('(i.e. defender instead of attacker).')).toBe(true);
  });

  it('no printed rule is truncated at its lead-in colon (the batch-3 data bug)', () => {
    const all = [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment];
    for (const r of all) expect(r.text.trim().endsWith(':')).toBe(false);
    for (const c of DATA.datacards) {
      for (const a of [...c.abilities, ...c.uniqueActions]) expect(a.text.trim().endsWith(':')).toBe(false);
    }
  });

  it('BONE DARTS: the scraper left the weapon rules empty, so the printed WR row is sliced out and parsed', () => {
    const raw = (DATA.equipment.find((e) => e.id === EQ.boneDarts) as { weapons?: { profiles: { rules: unknown[] }[] }[] })
      .weapons!;
    expect(raw[0]!.profiles[0]!.rules).toEqual([]); // the data bug
    expect(ruleText(EQ.boneDarts)).toContain('Range 6", Rending, Silent');
    expect(BONE_DART.name).toBe('Bone dart');
    expect(BONE_DART.profiles[0]).toMatchObject({ atk: 4, hit: 3, dmgN: 2, dmgC: 4 });
    expect(BONE_DART.profiles[0]!.rules.map((r) => r.id)).toEqual(['Range', 'Rending', 'Silent']);
    expect(BONE_DART.profiles[0]!.rules[0]).toMatchObject({ id: 'Range', x: 6 });
  });

  it('Soulstrike resolves through rareRuleTextFor (D-033) to this team’s own faction rule', () => {
    const printed = ruleText(RULE.soulstrike);
    expect(rareRuleTextFor(DATA, 'Soulstrike')).toBe(printed);
    // The generated registry was itself sourced from this faction rule, so the two agree.
    expect(rareRuleText('Soulstrike')).toBe(printed);
    expect(rareWeaponRuleText('Soulstrike', 'mandrakes')).toBe(printed);
    expect(printed).toContain('Each result of 1 is always a critical success');
    expect(printed).toContain('Each result of 6 is always a fail');
  });
});

// ---------------------------------------------------------------------------
describe('MANDRAKES selection', () => {
  it('defaultRoster is a legal 9-operative kill team: 1 NIGHTFIEND + 8 from the list', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(9);
    expect(picks[0]!.datacardId).toBe(NIGHTFIEND);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    // "Other than WARRIOR operatives, your kill team can only include each operative on this
    //  list once." — so the fill is one of each specialist and the rest WARRIORs.
    // One of each specialist plus four WARRIORs, which is the only legal shape of the list.
    expect(picks.map((p) => p.datacardId)).toEqual([
      NIGHTFIEND,
      ABYSSAL,
      CHOOSER,
      DIRGEMAW,
      SHADEWEAVER,
      WARRIOR,
      WARRIOR,
      WARRIOR,
      WARRIOR,
    ]);
  });

  it('prints exactly one selection constraint — uniqueExcept WARRIOR — and the validator enforces it', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['WARRIOR'] }]);
    expect(DATA.selection.totalOperatives).toBe(9);
    const twoAbyssals = [
      { datacardId: NIGHTFIEND },
      ...Array.from({ length: 6 }, () => ({ datacardId: WARRIOR })),
      { datacardId: ABYSSAL },
      { datacardId: ABYSSAL },
    ];
    expect(validateRosterFor(DATA, twoAbyssals).codes).toContain('unique');
    const oneAbyssal = [...twoAbyssals.slice(0, 8), { datacardId: DIRGEMAW }];
    expect(validateRosterFor(DATA, oneAbyssal).ok).toBe(true);
  });

  it('has no maxItem, custom or exclusiveItems constraint to leave unenforced', () => {
    const kinds = DATA.selection.constraints.map((c) => c.kind);
    expect(kinds).not.toContain('maxItem');
    expect(kinds).not.toContain('custom');
    expect(kinds).not.toContain('exclusiveItems');
  });
});

// ---------------------------------------------------------------------------
describe('Within Shadow — "It’s within 1" of Heavy terrain that’s not lower than it. Any part of its base is underneath Vantage terrain. A Shadow Portal marker is within its control range"', () => {
  it('is true within 1" of Heavy terrain and false out in the open', () => {
    const { state, T } = setup();
    const op = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    expect(ruleText(RULE.withinShadow)).toContain('within 1" of Heavy terrain that’s not lower than it');
    place(state, op.id, SHADE.x, SHADE.y);
    expect(withinShadow(T, state, op)).toBe(true);
    place(state, op.id, OPEN.x, OPEN.y);
    expect(withinShadow(T, state, op)).toBe(false);
  });

  it('is true underneath Vantage terrain, and false when the operative is standing on top of it', () => {
    const { state, T } = setup();
    const op = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    expect(ruleText(RULE.withinShadow)).toContain('underneath Vantage terrain');
    place(state, op.id, 14, 16, 0); // beneath the gantry (z0 = 3)
    expect(withinShadow(T, state, op)).toBe(true);
    place(state, op.id, 14, 16, 3); // on top of it — nothing is above
    expect(withinShadow(T, state, op)).toBe(false);
  });

  it('ignores Heavy terrain that IS lower than the operative', () => {
    const map = testMap({ features: [heavyBlock('low', 12, 4, 3, 3, 1)] });
    const { state, T } = setup({ map });
    const op = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    place(state, op.id, 15.7, 5.5, 4); // above a 1"-tall block
    expect(withinShadow(T, state, op)).toBe(false);
    place(state, op.id, 15.7, 5.5, 0);
    expect(withinShadow(T, state, op)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Soulstrike — "Each result that’s equal to or less than the target’s APL stat is a success and is retained… Each result of 1 is always a critical success… Each result of 6 is always a fail"', () => {
  /** A NIGHTFIEND baleblast into an APL 2 KASRKIN, stopped at the Allocate Defence step. */
  function shoot(script: number[]): { state: GameState; seq: ShootSequence } {
    const { ctx, state } = setup({ script, foeIsKasrkin: true });
    const shooter = opWith(state, 'p1', NIGHTFIEND);
    const foe = foeAt(state, 1);
    isolate(state, [shooter, foe]);
    place(state, shooter, 8, 10);
    place(state, foe, 14, 10);
    const s = activate(ctx, state, shooter);
    expect(aplOf(ctx, s, s.operatives[foe]!)).toBe(2);
    const started = startShoot(ctx, s, s.operatives[shooter]!, 'Baleblast', undefined, foe);
    expect(started.reason ?? 'ok').toBe('ok');
    advanceShoot(ctx, s);
    return { state: s, seq: s.sequence as ShootSequence };
  }

  it('re-reads the defence pool against the target’s APL: 1 crits, 2 saves at APL 2, 3 fails, 6 always fails', () => {
    expect(ruleText(RULE.soulstrike)).toContain('equal to or less than the target’s APL stat');
    // 4 attack dice (all normal successes), then 3 defence dice.
    const { state, seq } = shoot([4, 4, 4, 4, 1, 2, 3]);
    const rolled = seq.defence.dice.filter((d) => d.rolled);
    expect(rolled).toHaveLength(3);
    expect(state.log.some((l) => l.text.includes('Soulstrike'))).toBe(true);
    const byValue = Object.fromEntries(rolled.map((d) => [d.value, d.state]));
    expect(byValue[1]).toBe('crit');
    expect(byValue[2]).toBe('normal');
    expect(byValue[3]).toBe('fail'); // 3 beats the target’s APL 2, so it is discarded
  });

  it('makes a 6 a fail and a 1 a critical success — the opposite of the core reading', () => {
    const { seq } = shoot([4, 4, 4, 4, 6, 6, 1]);
    const byValue = Object.fromEntries(seq.defence.dice.filter((d) => d.rolled).map((d) => [d.value, d.state]));
    expect(byValue[6]).toBe('fail');
    expect(byValue[1]).toBe('crit');
  });

  it('classifies every rolled defence die by the printed table and rejects nothing', () => {
    const { state, seq } = shoot([4, 4, 4, 4, 1, 1, 2]);
    for (const die of seq.defence.dice) {
      if (!die.rolled) continue;
      const want = die.value === 6 ? 'fail' : die.value === 1 ? 'crit' : die.value <= 2 ? 'normal' : 'fail';
      expect(die.state).toBe(want);
    }
    expect(state.rejected).toHaveLength(0);
  });

  it('does nothing to a weapon without the Soulstrike rule — a 6 is still a critical success there', () => {
    const { ctx, state } = setup({ script: [4, 4, 4, 4, 6, 6, 6], foeIsKasrkin: true });
    const shooter = foeAt(state, 1); // a KASRKIN shooting a MANDRAKE
    const foe = opWith(state, 'p1', WARRIOR);
    isolate(state, [shooter, foe]);
    place(state, shooter, 14, 10);
    place(state, foe, 8, 10);
    const s = activate(ctx, state, shooter);
    const weapon = rangedOf(ctx, s, shooter);
    startShoot(ctx, s, s.operatives[shooter]!, weapon.name, weapon.profiles[0]!.name, foe);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    const sixes = seq.defence.dice.filter((d) => d.rolled && d.value === 6);
    expect(sixes.length).toBeGreaterThan(0);
    for (const die of sixes) expect(die.state).toBe('crit');
    expect(s.log.some((l) => l.text.includes('Soulstrike'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Umbral Entities — "ignore the Piercing weapon rule… Whenever a friendly MANDRAKE operative is WITHIN SHADOW, improve its Save stat by 1"', () => {
  it('strips Piercing from a weapon shooting a friendly MANDRAKE operative', () => {
    const { ctx, state } = setup({ foeIsKasrkin: true });
    expect(ruleText(RULE.umbralEntities)).toContain('ignore the Piercing weapon rule');
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const mandrake = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const profile: WeaponProfile = {
      type: 'ranged',
      atk: 4,
      hit: 3,
      dmgN: 3,
      dmgC: 4,
      rules: [{ id: 'Piercing', x: 1, raw: 'Piercing 1' }],
    };
    const vsMandrake = effectiveRules(ctx, state, profile, { operative: foe, target: mandrake, weaponName: 'test' });
    expect(vsMandrake.some((r) => r.id === 'Piercing')).toBe(false);
    const vsOther = effectiveRules(ctx, state, profile, {
      operative: foe,
      target: state.operatives[state.teams.p2.operativeIds[1]!]!,
      weaponName: 'test',
    });
    expect(vsOther.some((r) => r.id === 'Piercing')).toBe(true);
  });

  it('improves the Save stat by 1 while WITHIN SHADOW (5+ becomes 4+) and not otherwise', () => {
    const { ctx, state, T } = setup();
    const op = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    place(state, op.id, OPEN.x, OPEN.y);
    expect(withinShadow(T, state, op)).toBe(false);
    expect(saveOf(ctx, state, op)).toBe(5);
    place(state, op.id, SHADE.x, SHADE.y);
    expect(saveOf(ctx, state, op)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('Shadow Passage — "remove it from the killzone and set it back up WITHIN SHADOW in a location it can be placed"', () => {
  function passageSetup(): { ctx: GameContext; state: GameState; op: string; foe: string } {
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const op = opWith(state, 'p1', WARRIOR);
    const foe = foeAt(state, 1);
    isolate(state, [op, foe]);
    place(state, op, SHADE.x, SHADE.y);
    place(state, foe, 26, 20); // far away, with the Heavy block between it and the far side
    return { ctx, state, op, foe };
  }

  it('is a `treatedAs: Reposition` action of its own (D-021) and needs the operative to be WITHIN SHADOW', () => {
    const def = getAction(SHADOW_PASSAGE_ACTION)!;
    expect(def.treatedAs).toBe('Reposition');
    expect(def.ap).toBe(1);
    const { ctx, state, op } = passageSetup();
    const s = activate(ctx, state, op);
    place(s, op, OPEN.x, OPEN.y);
    expect(def.check(ctx, s, s.operatives[op]!, { targetPos: { x: 15.4, y: 8.5 } }).reason).toContain('not WITHIN SHADOW');
  });

  it('sets the operative back up, once per turning point, and locks it out of Shoot and Fight', () => {
    expect(ruleText(RULE.shadowPassage)).toContain(
      'Perform the Shoot or Fight action until the start of the next turning point',
    );
    const { ctx, state, op } = passageSetup();
    let s = activate(ctx, state, op);
    const dest = { x: 11.3, y: 5.5 }; // the far side of the same Heavy block — still WITHIN SHADOW
    const out = act(ctx, s, op, SHADOW_PASSAGE_ACTION, { targetPos: dest });
    expect(out.reason ?? 'ok').toBe('ok');
    s = out.state;
    expect(s.operatives[op]!.pos.x).toBeCloseTo(dest.x, 3);
    expect(s.effects.some((e) => e.rule === PASSAGE_LOCK && e.operativeId === op)).toBe(true);
    const shoot = availableActions(ctx, s, s.operatives[op]!).find((a) => a.def.id === 'Shoot');
    expect(shoot?.ok).toBe(false);
    expect(shoot?.reason).toContain('SHADOW PASSAGE');
    // "Once per turning point, ONE friendly MANDRAKE operative…"
    const other = opWith(s, 'p1', CHOOSER);
    s.operatives[other]!.removed = false;
    place(s, other, SHADE.x, SHADE.y);
    s = activate(ctx, s, other);
    expect(
      getAction(SHADOW_PASSAGE_ACTION)!.check(ctx, s, s.operatives[other]!, { targetPos: { x: 11.3, y: 6.6 } }).reason,
    ).toContain('already been used this turning point');
  });

  it('refuses a destination that is not WITHIN SHADOW, and one the operative would be a valid target from', () => {
    const { ctx, state, op, foe } = passageSetup();
    const def = getAction(SHADOW_PASSAGE_ACTION)!;
    const s = activate(ctx, state, op);
    expect(def.check(ctx, s, s.operatives[op]!, { targetPos: OPEN }).reason).toContain('WITHIN SHADOW');
    // Put the enemy where it can see the far side of the block: the passage is refused there.
    place(s, foe, 11.3, 13);
    expect(def.check(ctx, s, s.operatives[op]!, { targetPos: { x: 11.3, y: 5.5 } }).reason).toContain('valid target');
  });

  it('the AI’s only offered params (targetPos = its own position) are refused, so it never uses it (D-021)', () => {
    const { ctx, state, op } = passageSetup();
    const s = activate(ctx, state, op);
    const me = s.operatives[op]!;
    expect(
      getAction(SHADOW_PASSAGE_ACTION)!.check(ctx, s, me, { targetPos: { ...me.pos }, markerPos: { ...me.pos } }).ok,
    ).toBe(false);
    expect(getAction(SHADOW_PASSAGE_ACTION)!.check(ctx, s, me, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('SHADEWEAVER › Shadow Portal — "place one of your Shadow Portal markers within this operative’s control range before it’s removed and one within its control range after it’s set up"', () => {
  it('places both markers, and a second MANDRAKE may then take a passage of its own', () => {
    expect(abilityText(SHADEWEAVER, AB.shadowPortal)).toContain(
      'taking precedence over one operative once per turning point',
    );
    const { ctx, state, T } = setup({ foeIsKasrkin: true });
    const weaver = opWith(state, 'p1', SHADEWEAVER);
    const mate = opWith(state, 'p1', WARRIOR);
    isolate(state, [weaver, mate]);
    place(state, weaver, SHADE.x, SHADE.y);
    place(state, mate, 25, 20);
    let s = activate(ctx, state, weaver);
    const dest = { x: 11.3, y: 5.5 };
    const out = act(ctx, s, weaver, SHADOW_PASSAGE_ACTION, { targetPos: dest });
    expect(out.reason ?? 'ok').toBe('ok');
    s = out.state;
    const markers = portalMarkers(s, 'p1');
    expect(markers).toHaveLength(2);
    expect(markers[0]!.pos).toMatchObject({ x: SHADE.x, y: SHADE.y });
    expect(markers[1]!.pos.x).toBeCloseTo(dest.x, 3);
    // A Shadow Portal marker within control range is itself a WITHIN SHADOW condition.
    const lone = s.operatives[mate]!;
    lone.pos = { x: OPEN.x, y: OPEN.y };
    expect(withinShadow(T, s, lone)).toBe(false);
    lone.pos = { x: markers[1]!.pos.x, y: markers[1]!.pos.y + 1.2 };
    expect(withinShadow(T, s, lone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('NIGHTFIEND › Oubliex — "on a 5+, ignore the damage inflicted from that attack dice and its oubliex is no longer active"', () => {
  it('is armed when the operative is readied and ignores one attack dice’s damage on a 5+', () => {
    expect(abilityText(NIGHTFIEND, AB.oubliex)).toContain('on a 5+, ignore the damage inflicted from that attack dice');
    const { ctx, state } = setup({ script: [5], foeIsKasrkin: true });
    const nf = state.operatives[opWith(state, 'p1', NIGHTFIEND)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [nf.id, foe.id]);
    place(state, nf.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    // Arm it the printed way: "whenever this operative is readied".
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 0 });
    expect(state.effects.some((e) => e.rule === OUBLIEX_ACTIVE && e.operativeId === nf.id)).toBe(true);
    // A fight, so the damage is one attack dice worth the striker's Critical Dmg stat.
    const weapon = meleeOf(ctx, state, foe.id);
    const crit = ctx.datacards
      .get(foe.datacardId)!
      .weapons.find((w) => w.name === weapon)!
      .profiles.find((pr) => pr.type === 'melee')!.dmgC;
    const sf = startFight(ctx, state, foe, weapon, undefined, nf.id);
    expect(sf.reason ?? 'ok').toBe('ok');
    const before = nf.wounds;
    inflictDamage(ctx, state, nf, crit, 'attack');
    expect(nf.wounds).toBe(before); // the whole attack dice is ignored
    expect(state.rolls.some((r) => r.note?.includes('Oubliex'))).toBe(true);
    expect(state.effects.some((e) => e.rule === OUBLIEX_ACTIVE && e.operativeId === nf.id)).toBe(false);
  });

  it('is re-armed when the NIGHTFIEND incapacitates an enemy with its huskblade', () => {
    const { ctx, state } = setup({ seed: 3, foeIsKasrkin: true });
    const nf = state.operatives[opWith(state, 'p1', NIGHTFIEND)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [nf.id, foe.id]);
    place(state, nf.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    startFight(ctx, state, nf, 'Huskblade', undefined, foe.id);
    expect(state.sequence?.kind).toBe('fight');
    foe.wounds = 1;
    inflictDamage(ctx, state, foe, 6, 'attack');
    expect(foe.incapacitated).toBe(true);
    expect(state.effects.some((e) => e.rule === OUBLIEX_ACTIVE && e.operativeId === nf.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('NIGHTFIEND › Harrowing Whispers — "if the result is higher than that enemy operative’s APL stat, your opponent cannot activate it during this activation"', () => {
  it('rolls once per enemy per turning point and costs the enemy 1 APL when it beats their APL', () => {
    expect(abilityText(NIGHTFIEND, AB.harrowingWhispers)).toContain('your opponent cannot activate it during this activation');
    const { ctx, state } = setup({ script: [6], foeIsKasrkin: true });
    const nf = opWith(state, 'p1', NIGHTFIEND);
    const foe = foeAt(state, 1);
    const spare = foeAt(state, 2); // "If there are no OTHER enemy operatives eligible to be
    isolate(state, [nf, foe, spare]); //  activated, this rule has no effect."
    place(state, nf, 10, 10);
    place(state, foe, 13, 10); // within 6"
    place(state, spare, 28, 20);
    const before = aplOf(ctx, state, state.operatives[foe]!);
    expect(before).toBe(2);
    const s = activate(ctx, state, foe);
    expect(aplOf(ctx, s, s.operatives[foe]!)).toBe(before - 1);
    expect(s.log.some((l) => l.text.includes('Harrowing Whispers'))).toBe(true);
  });

  it('does nothing on a roll that does not beat the APL, or from more than 6" away', () => {
    const { ctx, state } = setup({ script: [2], foeIsKasrkin: true });
    const nf = opWith(state, 'p1', NIGHTFIEND);
    const foe = foeAt(state, 1);
    const spare = foeAt(state, 2);
    isolate(state, [nf, foe, spare]);
    place(state, nf, 10, 10);
    place(state, foe, 13, 10);
    place(state, spare, 28, 20);
    const s = activate(ctx, state, foe);
    expect(aplOf(ctx, s, s.operatives[foe]!)).toBe(2);

    const far = setup({ script: [6], foeIsKasrkin: true });
    const nf2 = opWith(far.state, 'p1', NIGHTFIEND);
    const foe2 = foeAt(far.state, 1);
    const spare2 = foeAt(far.state, 2);
    isolate(far.state, [nf2, foe2, spare2]);
    place(far.state, nf2, 3, 3);
    place(far.state, foe2, 25, 18);
    place(far.state, spare2, 28, 20);
    const s2 = activate(far.ctx, far.state, foe2);
    expect(aplOf(far.ctx, s2, s2.operatives[foe2]!)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('ABYSSAL › WREATHE IN BALEFIRE + Balefire', () => {
  function wreathed(): { ctx: GameContext; state: GameState; abyssal: string; foe: string; foe2: string } {
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const abyssal = opWith(state, 'p1', ABYSSAL);
    const foe = foeAt(state, 1);
    const foe2 = foeAt(state, 2);
    isolate(state, [abyssal, foe, foe2]);
    place(state, abyssal, 8, 10);
    place(state, foe, 14, 10);
    place(state, foe2, 14, 13);
    return { ctx, state, abyssal, foe, foe2 };
  }

  it('gives one operative a Balefire token and takes it back when the action is performed again', () => {
    expect(actionOf(ABYSSAL, ACT.wreatheInBalefire).text).toContain('until it performs this action again');
    const { ctx, state, abyssal, foe, foe2 } = wreathed();
    let s = activate(ctx, state, abyssal);
    s = act(ctx, s, abyssal, ACT.wreatheInBalefire, { targetOperativeId: foe }).state;
    expect(s.effects.some((e) => e.rule === BALEFIRE_TOKEN && e.operativeId === foe && e.player === 'p1')).toBe(true);
    s.operatives[abyssal]!.actionsThisActivation = [];
    s = act(ctx, s, abyssal, ACT.wreatheInBalefire, { targetOperativeId: foe2 }).state;
    expect(s.effects.some((e) => e.rule === BALEFIRE_TOKEN && e.operativeId === foe)).toBe(false);
    expect(s.effects.some((e) => e.rule === BALEFIRE_TOKEN && e.operativeId === foe2)).toBe(true);
  });

  it('cannot be performed while within control range of an enemy operative', () => {
    const { ctx, state, abyssal, foe } = wreathed();
    place(state, foe, 8.9, 10);
    const s = activate(ctx, state, abyssal);
    const out = act(ctx, s, abyssal, ACT.wreatheInBalefire, { targetOperativeId: foe });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('control range');
  });

  it('Balefire adds Saturate and 1 to both Dmg stats of a MANDRAKE shooting the marked operative', () => {
    expect(abilityText(ABYSSAL, AB.balefire)).toContain('add 1 to both Dmg stats');
    const { ctx, state, abyssal, foe } = wreathed();
    let s = activate(ctx, state, abyssal);
    s = act(ctx, s, abyssal, ACT.wreatheInBalefire, { targetOperativeId: foe }).state;
    const profile = profileOf(NIGHTFIEND, 'Baleblast');
    const shooterId = opWith(s, 'p1', NIGHTFIEND);
    s.operatives[shooterId]!.removed = false;
    place(s, shooterId, 9, 10);
    const shooter = s.operatives[shooterId]!;
    const rules = effectiveRules(ctx, s, profile, {
      operative: shooter,
      target: s.operatives[foe]!,
      weaponName: 'Baleblast',
    });
    expect(rules.some((r) => r.id === 'Saturate')).toBe(true);
    // The Dmg change lands at `onDamage`: two unblocked normals of a 3/4 weapon become 4+4.
    s.sequence = fakeShoot(shooter.id, foe, 'Baleblast', 'p1', 'p2', 2);
    const before = s.operatives[foe]!.wounds;
    inflictDamage(ctx, s, s.operatives[foe]!, 6, 'attack');
    expect(before - s.operatives[foe]!.wounds).toBe(8); // 6 printed + 1 per unblocked attack dice
  });

  it('and subtracts 1 (to a minimum of 1) from an operative shooting a MANDRAKE that holds a token', () => {
    expect(abilityText(ABYSSAL, AB.balefire)).toContain('to a minimum of 1');
    // A mirror match, so the enemy shooter carries a baleblast whose printed Dmg is 3/4.
    const { ctx, state } = setup();
    const abyssal = opWith(state, 'p1', ABYSSAL);
    const mate = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [abyssal, mate, foe]);
    place(state, abyssal, 8, 10);
    place(state, mate, 8, 12);
    place(state, foe, 16, 12);
    let s = activate(ctx, state, abyssal);
    s = act(ctx, s, abyssal, ACT.wreatheInBalefire, { targetOperativeId: mate }).state;
    expect(s.effects.some((e) => e.rule === BALEFIRE_TOKEN && e.operativeId === mate && e.player === 'p1')).toBe(true);
    s.sequence = fakeShoot(foe, mate, 'Baleblast', 'p2', 'p1', 1);
    const target = s.operatives[mate]!;
    const before = target.wounds;
    inflictDamage(ctx, s, target, 3, 'attack'); // one unblocked normal of a 3/4 baleblast
    expect(before - target.wounds).toBe(2); // "subtract 1 from both Dmg stats"
  });
});

// ---------------------------------------------------------------------------
describe('CHOOSER OF THE FLESH › Soul Harvest + Part Collector', () => {
  it('Part Collector inflicts 2D3 when the enemy has performed the Fall Back action in its control range', () => {
    expect(abilityText(CHOOSER, AB.partCollector)).toContain('inflict 2D3 damage on that enemy operative before it moves');
    const { ctx, state } = setup({ script: [5, 5], foeIsKasrkin: true });
    const chooser = opWith(state, 'p1', CHOOSER);
    const foe = foeAt(state, 1);
    isolate(state, [chooser, foe]);
    place(state, chooser, 10, 10);
    place(state, foe, 10.9, 10);
    let s = activate(ctx, state, foe);
    s.operatives[foe]!.actionsThisActivation = ['Fall Back'];
    const before = s.operatives[foe]!.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(before - s.operatives[foe]!.wounds).toBe(6); // 2D3, both threes on this script
    expect(s.log.some((l) => l.text.includes('Part Collector'))).toBe(true);
  });

  it('does nothing when the enemy never performed the Fall Back action', () => {
    const { ctx, state } = setup({ script: [5, 5], foeIsKasrkin: true });
    const chooser = opWith(state, 'p1', CHOOSER);
    const foe = foeAt(state, 1);
    isolate(state, [chooser, foe]);
    place(state, chooser, 10, 10);
    place(state, foe, 10.9, 10);
    let s = activate(ctx, state, foe);
    const before = s.operatives[foe]!.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.operatives[foe]!.wounds).toBe(before);
  });

  it('Soul Harvest gains two points for an APL 3 baleblade kill and one for an APL 2 one', () => {
    expect(abilityText(CHOOSER, AB.soulHarvest)).toContain('or two if that enemy operative had an APL stat of 3 or more');
    const kill = (foeIndex: number): number => {
      const { ctx, state } = setup({ foeIsKasrkin: true });
      const chooser = state.operatives[opWith(state, 'p1', CHOOSER)]!;
      const foe = state.operatives[foeAt(state, foeIndex)]!;
      isolate(state, [chooser.id, foe.id]);
      place(state, chooser.id, 10, 10);
      place(state, foe.id, 10.9, 10);
      expect(startFight(ctx, state, chooser, 'Baleblade', undefined, foe.id).ok).toBe(true);
      foe.wounds = 1;
      inflictDamage(ctx, state, foe, 6, 'attack');
      expect(foe.incapacitated).toBe(true);
      return soulHarvest(state, 'p1');
    };
    expect(kill(0)).toBe(2); // the KASRKIN SERGEANT is APL 3
    expect(kill(1)).toBe(1);
  });

  it('offers a real spend decision at a friendly activation, declining first', () => {
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const chooser = state.operatives[opWith(state, 'p1', CHOOSER)]!;
    const foe = state.operatives[foeAt(state, 1)]!;
    const mate = opWith(state, 'p1', WARRIOR);
    isolate(state, [chooser.id, foe.id, mate]);
    place(state, chooser.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    place(state, mate, 20, 20);
    startFight(ctx, state, chooser, 'Baleblade', undefined, foe.id);
    foe.wounds = 1;
    inflictDamage(ctx, state, foe, 6, 'attack');
    expect(soulHarvest(state, 'p1')).toBe(1);
    state.sequence = null;
    const s = activate(ctx, state, mate);
    const decision = s.pending.find((p) => p.kind === SOUL_HARVEST_DECISION);
    expect(decision).toBeDefined();
    expect(decision!.options.map((o) => o.id)).toEqual(['keep', 'apl', 'wounds']);
    const after = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'apl' }, ctx).state;
    expect(soulHarvest(after, 'p1')).toBe(0);
    expect(aplOf(ctx, after, after.operatives[mate]!)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('DIRGEMAW › Haunting Focus + PAREIDOLIC PROJECTION', () => {
  it('Haunting Focus is its own 0CP STRATEGIC GAMBIT that marks one enemy operative', () => {
    expect(abilityText(DIRGEMAW, AB.hauntingFocus)).toContain('STRATEGIC GAMBIT');
    const { ctx, state } = setup({ foeIsKasrkin: true });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const opts = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(opts).toContain('mandrakes.gambit.haunting-focus');
    const cp = state.teams.p1.cp;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'mandrakes.gambit.haunting-focus' }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp); // 0CP — it is a datacard ability, not one of the four ploys
    expect(s.effects.filter((e) => e.rule === 'mandrakes.hauntingFocus')).toHaveLength(1);
    // The activation interrupt itself has no engine seam and says so in the log.
    expect(s.log.some((l) => l.text.includes('reminder-only'))).toBe(true);
  });

  it('PAREIDOLIC PROJECTION worsens Hit by 1 and Move by 2", and is not cumulative with being injured', () => {
    expect(actionOf(DIRGEMAW, ACT.pareidolicProjection).text).toContain('these aren’t cumulative with being injured');
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const dirge = opWith(state, 'p1', DIRGEMAW);
    const foe = foeAt(state, 1);
    isolate(state, [dirge, foe]);
    place(state, dirge, 8, 10);
    place(state, foe, 12, 10);
    let s = activate(ctx, state, dirge);
    const foeOp = s.operatives[foe]!;
    const baseMove = moveOf(ctx, s, foeOp);
    const profile = rangedOf(ctx, s, foe).profiles[0]!;
    const baseHit = hitOf(ctx, s, foeOp, profile);
    const out = act(ctx, s, dirge, ACT.pareidolicProjection, { targetOperativeId: foe });
    expect(out.reason ?? 'ok').toBe('ok');
    s = out.state;
    expect(s.effects.some((e) => e.rule === PAREIDOLIC_EFFECT && e.operativeId === foe)).toBe(true);
    expect(moveOf(ctx, s, s.operatives[foe]!)).toBe(Math.max(4, baseMove - 2));
    expect(hitOf(ctx, s, s.operatives[foe]!, profile)).toBe(baseHit + 1);
    // Injured already worsens Hit by 1 and Move by 2" — the projection must not stack.
    s.operatives[foe]!.wounds = 1;
    expect(hitOf(ctx, s, s.operatives[foe]!, profile)).toBe(baseHit + 1);
    expect(moveOf(ctx, s, s.operatives[foe]!)).toBe(Math.max(4, baseMove - 2));
  });

  it('may be performed against the one enemy in its control range, but not while a second is there', () => {
    expect(actionOf(DIRGEMAW, ACT.pareidolicProjection).text).toContain(
      'unless the only enemy operative it’s within control range of is selected for this action',
    );
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const dirge = opWith(state, 'p1', DIRGEMAW);
    const foe = foeAt(state, 1);
    const foe2 = foeAt(state, 2);
    isolate(state, [dirge, foe, foe2]);
    place(state, dirge, 8, 10);
    place(state, foe, 8.9, 10);
    place(state, foe2, 25, 20);
    let s = activate(ctx, state, dirge);
    expect(act(ctx, s, dirge, ACT.pareidolicProjection, { targetOperativeId: foe }).reason ?? 'ok').toBe('ok');
    // A second enemy inside its control range closes the carve-out.
    place(state, foe2, 8, 8.9);
    s = activate(ctx, state, dirge);
    const out = act(ctx, s, dirge, ACT.pareidolicProjection, { targetOperativeId: foe });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('control range');
  });
});

// ---------------------------------------------------------------------------
describe('SHADEWEAVER › WEAVE DARKNESS — "an area of smoke with the same size and effects as a smoke grenade, except you don’t remove it during the following turning point"', () => {
  it('places a real smoke marker, replaces the previous one and removes it when the SHADEWEAVER dies', () => {
    const { ctx, state } = setup();
    const weaver = opWith(state, 'p1', SHADEWEAVER);
    isolate(state, [weaver]);
    place(state, weaver, 10, 10);
    let s = activate(ctx, state, weaver);
    s = act(ctx, s, weaver, ACT.weaveDarkness, { targetPos: { x: 11, y: 10 } }).state;
    const smoke = Object.values(s.markers).filter((m) => m.kind === 'smoke');
    expect(smoke).toHaveLength(1);
    expect(smoke[0]!.pos).toMatchObject({ x: 11, y: 10 });
    s.operatives[weaver]!.actionsThisActivation = [];
    s = act(ctx, s, weaver, ACT.weaveDarkness, { targetPos: { x: 9, y: 10 } }).state;
    expect(Object.values(s.markers).filter((m) => m.kind === 'smoke')).toHaveLength(1);
    // "If this operative is incapacitated, remove your Weave Darkness marker from the killzone."
    s.operatives[weaver]!.wounds = 1;
    inflictDamage(ctx, s, s.operatives[weaver]!, 5, 'other');
    expect(Object.values(s.markers).filter((m) => m.kind === 'smoke')).toHaveLength(0);
  });

  it('is a real area of smoke the shoot sequence reads', () => {
    expect(actionOf(SHADEWEAVER, ACT.weaveDarkness).text).toContain('the same size and effects as a smoke grenade');
    const { ctx, state } = setup();
    const weaver = opWith(state, 'p1', SHADEWEAVER);
    isolate(state, [weaver]);
    place(state, weaver, 10, 10);
    let s = activate(ctx, state, weaver);
    s = act(ctx, s, weaver, ACT.weaveDarkness, { targetPos: { x: 11, y: 10 } }).state;
    const areas = smokeAreas(s);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ radius: 1, centre: { x: 11, y: 10 } });
  });

  it('survives the end of the turning point it was placed in and is removed at the end of the next', () => {
    const { ctx, state } = setup();
    const weaver = opWith(state, 'p1', SHADEWEAVER);
    isolate(state, [weaver]);
    place(state, weaver, 10, 10);
    let s = activate(ctx, state, weaver);
    s = act(ctx, s, weaver, ACT.weaveDarkness, { targetPos: { x: 11, y: 10 } }).state;
    ctx.hooks.emit('onEndOfTP', s, { state: s });
    expect(Object.values(s.markers).filter((m) => m.kind === 'smoke')).toHaveLength(1);
    s.turningPoint = 2;
    ctx.hooks.emit('onEndOfTP', s, { state: s });
    expect(Object.values(s.markers).filter((m) => m.kind === 'smoke')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('WARRIOR › Shadow Warrior — "Whenever this operative is WITHIN SHADOW, add 1 to the Critical Dmg stat of its glimmersteel blade"', () => {
  it('adds 1 to a critical strike only while WITHIN SHADOW', () => {
    expect(abilityText(WARRIOR, AB.shadowWarrior)).toContain('add 1 to the Critical Dmg stat of its glimmersteel blade');
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const w = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [w.id, foe.id]);
    place(state, w.id, SHADE.x, SHADE.y);
    place(state, foe.id, SHADE.x + 0.9, SHADE.y);
    startFight(ctx, state, w, 'Glimmersteel blade', undefined, foe.id);
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, 5, 'attack'); // the printed Critical Dmg
    expect(before - foe.wounds).toBe(6);

    place(state, w.id, OPEN.x, OPEN.y);
    place(state, foe.id, OPEN.x + 0.9, OPEN.y);
    const before2 = foe.wounds;
    inflictDamage(ctx, state, foe, 5, 'attack');
    expect(before2 - foe.wounds).toBe(5);
  });

  it('leaves a normal strike alone', () => {
    const { ctx, state } = setup({ foeIsKasrkin: true });
    const w = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [w.id, foe.id]);
    place(state, w.id, SHADE.x, SHADE.y);
    place(state, foe.id, SHADE.x + 0.9, SHADE.y);
    startFight(ctx, state, w, 'Glimmersteel blade', undefined, foe.id);
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, 4, 'attack'); // the printed Normal Dmg
    expect(before - foe.wounds).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('CREEPING HORROR is not offered in the first turning point and grants a free Dash after an enemy activation', () => {
    expect(ruleText(SP.creepingHorror)).toContain('You cannot use this ploy during the first turning point');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SP.creepingHorror);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SP.creepingHorror);

    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.creepingHorror }, ctx).state;
    s.phase = 'firefight';
    const mate = opWith(s, 'p1', WARRIOR);
    const foe = foeAt(s, 1);
    isolate(s, [mate, foe]);
    place(s, mate, SHADE.x, SHADE.y);
    place(s, foe, 25, 18);
    s.operatives[mate]!.order = 'conceal';
    s = activate(ctx, s, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === mate);
    expect(grant).toBeDefined();
    expect(grant!.data?.['only']).toEqual(['Dash']);
    expect(s.operatives[mate]!.aplMods).toContain(1);
    // The un-popped +1 is cleaned up at the Ready step, or every operative drifts to APL 3.
    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 0 });
    expect(s.operatives[mate]!.aplMods).not.toContain(1);
  });

  it('CREEPING HORROR only picks an operative that is WITHIN SHADOW with a Conceal order', () => {
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    state.turningPoint = 2;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.creepingHorror }, ctx).state;
    const mate = opWith(s, 'p1', WARRIOR);
    const foe = foeAt(s, 1);
    isolate(s, [mate, foe]);
    place(s, mate, OPEN.x, OPEN.y); // not WITHIN SHADOW
    place(s, foe, 25, 18);
    s.operatives[mate]!.order = 'conceal';
    s = activate(ctx, s, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === mate)).toBe(false);
  });

  it('GLOAMING SHROUD retains one defence dice as a normal success without rolling it', () => {
    expect(ruleText(SP.gloamingShroud)).toContain('retain one of your defence dice as a normal success without rolling it');
    // A mirror match, so the shooter's baleblast carries no re-roll rule to interrupt the flow.
    const { ctx, state } = setup({ cp: 6, script: [4, 4, 4, 4, 6, 6, 6] });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.gloamingShroud }, ctx).state;
    s.phase = 'firefight';
    const shooter = opWith(s, 'p2', WARRIOR);
    const target = opWith(s, 'p1', WARRIOR);
    isolate(s, [shooter, target]);
    place(s, target, SHADE.x, SHADE.y);
    place(s, shooter, SHADE.x + 6, SHADE.y);
    s = activate(ctx, s, shooter);
    expect(startShoot(ctx, s, s.operatives[shooter]!, 'Baleblast', undefined, target).reason ?? 'ok').toBe('ok');
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    const auto = seq.defence.dice.filter((d) => !d.rolled && d.note === 'GLOAMING SHROUD');
    expect(auto).toHaveLength(1);
    expect(auto[0]!.state).toBe('normal');
    // "…in addition to a cover save, if any" — one fewer die is rolled, and the retained one
    // is not a "result", so Soulstrike leaves it alone.
    expect(seq.defence.dice.filter((d) => d.rolled)).toHaveLength(2);
    expect(s.log.some((l) => l.text.includes('GLOAMING SHROUD'))).toBe(true);
  });

  it('BLADE IN THE DARK is a Conceal-order Charge of its own (D-021), gated on starting or ending WITHIN SHADOW', () => {
    expect(ruleText(SP.bladeInTheDark)).toContain('while it has a Conceal order');
    const def = getAction(BLADE_IN_THE_DARK_CHARGE)!;
    expect(def.treatedAs).toBe('Charge');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = opWith(state, 'p1', WARRIOR);
    isolate(state, [me]);
    place(state, me, SHADE.x, SHADE.y);
    state.operatives[me]!.order = 'conceal';
    let s = activate(ctx, state, me, 'conceal');
    // Not offered until the gambit is used.
    expect(def.available!(ctx, s, s.operatives[me]!)).toBe(false);
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: SP.bladeInTheDark }, ctx).state;
    expect(def.available!(ctx, s, s.operatives[me]!)).toBe(true);
    // With an Engage order the universal Charge already works, so the carve-out refuses.
    s.operatives[me]!.order = 'engage';
    expect(def.check(ctx, s, s.operatives[me]!, {}).reason).toContain('Engage order');
    // Out of the shadows with a Conceal order and no path, it refuses for the printed reason.
    s.operatives[me]!.order = 'conceal';
    place(s, me, OPEN.x, OPEN.y);
    expect(def.check(ctx, s, s.operatives[me]!, {}).reason).toContain('start or end that action WITHIN SHADOW');
  });

  it('INESCAPABLE NIGHTMARE offers a one-dice re-roll while shooting WITHIN SHADOW (shoot only — D-031)', () => {
    expect(ruleText(SP.inescapableNightmare)).toContain('you can re-roll one of your attack dice');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true, script: [4, 4, 4, 4, 3, 3, 3] });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.inescapableNightmare }, ctx).state;
    s.phase = 'firefight';
    s.teams.p1.cp = 0; // so the only re-roll offered is this ploy's, not the Command Re-roll
    const shooter = opWith(s, 'p1', NIGHTFIEND);
    const foe = foeAt(s, 1);
    isolate(s, [shooter, foe]);
    place(s, shooter, SHADE.x, SHADE.y);
    place(s, foe, SHADE.x + 5, SHADE.y);
    s = activate(ctx, s, shooter);
    startShoot(ctx, s, s.operatives[shooter]!, 'Baleblast', undefined, foe);
    advanceShoot(ctx, s);
    const decision = s.pending.find((p) => p.kind === 'reroll');
    expect(decision).toBeDefined();
    expect(decision!.sourceText).toBe(ruleText(SP.inescapableNightmare));
    expect(decision!.options.some((o) => o.id !== 'keep')).toBe(true);
  });

  it('INESCAPABLE NIGHTMARE offers nothing to a shooter that is not WITHIN SHADOW', () => {
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true, script: [4, 4, 4, 4, 3, 3, 3] });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.inescapableNightmare }, ctx).state;
    s.phase = 'firefight';
    s.teams.p1.cp = 0;
    const shooter = opWith(s, 'p1', NIGHTFIEND);
    const foe = foeAt(s, 1);
    isolate(s, [shooter, foe]);
    place(s, shooter, OPEN.x, OPEN.y);
    place(s, foe, OPEN.x - 5, OPEN.y);
    s = activate(ctx, s, shooter);
    startShoot(ctx, s, s.operatives[shooter]!, 'Baleblast', undefined, foe);
    advanceShoot(ctx, s);
    expect(s.pending.some((p) => p.kind === 'reroll')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('SLITHER OUT OF SIGHT changes a WITHIN SHADOW operative’s order to Conceal', () => {
    expect(ruleText(FP.slitherOutOfSight)).toContain('Change that operative’s order to Conceal');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = opWith(state, 'p1', WARRIOR);
    isolate(state, [me]);
    place(state, me, SHADE.x, SHADE.y);
    state.operatives[me]!.order = 'engage';
    // The `usable` snapshot is taken at every activation boundary.
    let s = activate(ctx, state, me);
    s = reduce(s, { t: 'EndActivation', operativeId: me }, ctx).state;
    expect(mandrakes.ploys.find((p) => p.id === FP.slitherOutOfSight)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.slitherOutOfSight, data: { operativeId: me } }, ctx).state;
    expect(s.operatives[me]!.order).toBe('conceal');
  });

  it('SLITHER OUT OF SIGHT is not usable when no Engage-order MANDRAKE is WITHIN SHADOW', () => {
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = opWith(state, 'p1', WARRIOR);
    isolate(state, [me]);
    place(state, me, OPEN.x, OPEN.y);
    let s = activate(ctx, state, me);
    s = reduce(s, { t: 'EndActivation', operativeId: me }, ctx).state;
    expect(mandrakes.ploys.find((p) => p.id === FP.slitherOutOfSight)!.usable!(s, 'p1').ok).toBe(false);
  });

  it('SOUL FEAST heals APL × the number of attack dice that inflicted damage', () => {
    expect(ruleText(FP.soulFeast)).toContain('multiplied by the number of your attack dice that inflicted damage');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const w = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[foeAt(state, 1)]!;
    isolate(state, [w.id, foe.id]);
    place(state, w.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    w.wounds = 2;
    startFight(ctx, state, w, 'Glimmersteel blade', undefined, foe.id);
    inflictDamage(ctx, state, foe, 4, 'attack');
    const rec = soulFeastRecord(state, 'p1');
    expect(rec).toMatchObject({ friendlyId: w.id, enemyId: foe.id, dice: 1, apl: 2 });
    expect(mandrakes.ploys.find((p) => p.id === FP.soulFeast)!.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.soulFeast }, ctx).state;
    expect(s.operatives[w.id]!.wounds).toBe(2 + rec!.apl * rec!.dice);
  });

  it('SOUL FEAST is not usable once the sequence’s activation has ended', () => {
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const w = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[foeAt(state, 1)]!;
    isolate(state, [w.id, foe.id]);
    place(state, w.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    let s = activate(ctx, state, w.id);
    startFight(ctx, s, s.operatives[w.id]!, 'Glimmersteel blade', undefined, foe.id);
    inflictDamage(ctx, s, s.operatives[foe.id]!, 4, 'attack');
    s.sequence = null;
    s = reduce(s, { t: 'EndActivation', operativeId: w.id }, ctx).state;
    expect(soulFeastRecord(s, 'p1')).toBeUndefined();
    expect(mandrakes.ploys.find((p) => p.id === FP.soulFeast)!.usable!(s, 'p1').ok).toBe(false);
  });

  it('NOWHERE TO HIDE records its (reminder-only) terrain permission and caps a Charge at the Move stat', () => {
    expect(ruleText(FP.nowhereToHide)).toContain('move through parts of terrain features as if they were not there');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = opWith(state, 'p1', WARRIOR);
    isolate(state, [me]);
    place(state, me, 10, 10);
    let s = activate(ctx, state, me);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.nowhereToHide }, ctx).state;
    expect(s.effects.some((e) => e.rule === NOWHERE_EFFECT && e.operativeId === me)).toBe(true);
    const capped = ctx.hooks.emit('onMoveDistance', s, {
      state: s,
      operative: s.operatives[me]!,
      action: 'Charge',
      inches: 9, // Move 7" + the printed Charge bonus
    });
    expect(capped.inches).toBe(7);
    // The AI is told never to spend CP on it: its benefit has no engine seam.
    expect(mandrakes.aiHints!.ployValue![FP.nowhereToHide]).toBe(0);
  });

  it('SHADOW’S BITE lets the retaliating MANDRAKE resolve the first attack dice after a Charge', () => {
    expect(ruleText(FP.shadowsBite)).toContain('you resolve the first attack dice (i.e. defender instead of attacker)');
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[foeAt(state, 1)]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, SHADE.x, SHADE.y);
    place(state, foe.id, SHADE.x + 0.9, SHADE.y);
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.shadowsBite }, ctx).state;
    expect(s.effects.some((e) => e.rule === SHADOWS_BITE_EFFECT && e.player === 'p1')).toBe(true);
    s = activate(ctx, s, foe.id);
    s.operatives[foe.id]!.actionsThisActivation = ['Charge'];
    startFight(ctx, s, s.operatives[foe.id]!, meleeOf(ctx, s, foe.id), undefined, me.id);
    advanceFight(ctx, s);
    expect(s.log.some((l) => l.text.includes("SHADOW'S BITE"))).toBe(true);
    expect(s.effects.some((e) => e.rule === SHADOWS_BITE_EFFECT)).toBe(false);
  });

  it("SHADOW'S BITE does not fire when the enemy did not Charge this activation", () => {
    const { ctx, state } = setup({ cp: 6, foeIsKasrkin: true });
    const me = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[foeAt(state, 1)]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, SHADE.x, SHADE.y);
    place(state, foe.id, SHADE.x + 0.9, SHADE.y);
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.shadowsBite }, ctx).state;
    s = activate(ctx, s, foe.id);
    startFight(ctx, s, s.operatives[foe.id]!, meleeOf(ctx, s, foe.id), undefined, me.id);
    advanceFight(ctx, s);
    expect(s.log.some((l) => l.text.includes("SHADOW'S BITE"))).toBe(false);
    expect(s.effects.some((e) => e.rule === SHADOWS_BITE_EFFECT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('CHAIN SNARE rolls 2D6 (1D6 against a tougher operative) and stops the Fall Back on a 4+', () => {
    expect(ruleText(EQ.chainSnare)).toContain('If any result is a 4+, that enemy operative cannot perform that action');
    const { ctx, state } = setup({ script: [4, 1], equipment: [EQ.chainSnare], foeIsKasrkin: true });
    const snarer = opWith(state, 'p1', WARRIOR);
    const foe = foeAt(state, 1); // 8 wounds, the same as the WARRIOR, so two D6 are rolled
    isolate(state, [snarer, foe]);
    place(state, snarer, 10, 10);
    place(state, foe, 10.9, 10);
    const s = activate(ctx, state, foe);
    expect(s.rolls.some((r) => r.kind === 'chainSnare' && r.results.length === 2)).toBe(true);
    const fallBack = availableActions(ctx, s, s.operatives[foe]!).find((a) => a.def.id === 'Fall Back');
    expect(fallBack?.ok).toBe(false);
    expect(fallBack?.reason).toContain('CHAIN SNARE');
  });

  it('CHAIN SNARE rolls one D6 when the enemy has a higher Wounds stat than the snarer', () => {
    expect(ruleText(EQ.chainSnare)).toContain('or one D6 if that enemy operative has a higher Wounds stat');
    const { ctx, state } = setup({ script: [4], equipment: [EQ.chainSnare], foeIsKasrkin: true });
    const snarer = opWith(state, 'p1', WARRIOR); // 8 wounds
    const foe = foeAt(state, 0); // the KASRKIN SERGEANT, 9 wounds
    isolate(state, [snarer, foe]);
    place(state, snarer, 10, 10);
    place(state, foe, 10.9, 10);
    const s = activate(ctx, state, foe);
    const roll = s.rolls.find((r) => r.kind === 'chainSnare');
    expect(roll?.results).toHaveLength(1);
  });

  it('CHAIN SNARE does nothing when another enemy operative is also within the snarer’s control range', () => {
    const { ctx, state } = setup({ script: [4, 4], equipment: [EQ.chainSnare], foeIsKasrkin: true });
    const snarer = opWith(state, 'p1', WARRIOR);
    const foe = state.teams.p2.operativeIds[0]!;
    const foe2 = state.teams.p2.operativeIds[1]!;
    isolate(state, [snarer, foe, foe2]);
    place(state, snarer, 10, 10);
    place(state, foe, 10.9, 10);
    place(state, foe2, 10, 10.9);
    const s = activate(ctx, state, foe);
    expect(s.rolls.some((r) => r.kind === 'chainSnare')).toBe(false);
  });

  it('SHADOW GLYPH makes a Conceal-order operative in cover untargetable, except within 2"', () => {
    expect(ruleText(EQ.shadowGlyph)).toContain('taking precedence over all other rules');
    const map = testMap({ features: [heavyBlock('heavy', 12, 4, 3, 3, 3), heavyBlock('screen', 16, 9, 1, 4, 1)] });
    const { ctx, state } = setup({ map, equipment: [EQ.shadowGlyph], foeIsKasrkin: true });
    const me = opWith(state, 'p1', WARRIOR);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [me, foe]);
    place(state, me, 15, 11);
    place(state, foe, 22, 11);
    state.operatives[me]!.pos = { x: 15, y: 11 };
    const s = activate(ctx, state, me, 'conceal');
    // The rule is auto-used at the activation (D-022) because it is free.
    expect(s.effects.some((e) => e.rule === SHADOW_GLYPH_EFFECT && e.operativeId === me)).toBe(true);
    const profile = ctx.datacards.get(s.operatives[foe]!.datacardId)!.weapons.find((w) =>
      w.profiles.some((p) => p.type === 'ranged'),
    )!.profiles[0]!;
    const rules = effectiveRules(ctx, s, profile, { operative: s.operatives[foe]!, weaponName: 'x' });
    const far = checkTarget(ctx, s, s.operatives[foe]!, s.operatives[me]!, profile, rules);
    expect(far.valid).toBe(false);
    // "…except being within 2"."
    place(s, foe, 16.6, 11);
    const near = checkTarget(ctx, s, s.operatives[foe]!, s.operatives[me]!, profile, rules);
    expect(near.reason ?? '').not.toContain('SHADOW GLYPH');
  });

  it('SHADOW GLYPH is used once per turning point, on the first qualifying activation', () => {
    expect(ruleText(EQ.shadowGlyph)).toContain('Once per turning point');
    const { ctx, state } = setup({ equipment: [EQ.shadowGlyph], foeIsKasrkin: true });
    const first = opWith(state, 'p1', WARRIOR);
    const second = opWith(state, 'p1', CHOOSER);
    isolate(state, [first, second]);
    place(state, first, SHADE.x, SHADE.y);
    place(state, second, SHADE.x, SHADE.y + 1.5);
    let s = activate(ctx, state, first, 'conceal');
    expect(s.effects.some((e) => e.rule === SHADOW_GLYPH_EFFECT && e.operativeId === first)).toBe(true);
    s = reduce(s, { t: 'EndActivation', operativeId: first }, ctx).state;
    s = activate(ctx, s, second, 'conceal');
    expect(s.effects.some((e) => e.rule === SHADOW_GLYPH_EFFECT && e.operativeId === second)).toBe(false);
  });

  it('BONE DARTS grants the printed weapon once per turning point and then withdraws it', () => {
    expect(ruleText(EQ.boneDarts)).toContain('Once per turning point, a friendly MANDRAKE operative can use the following ranged weapon');
    const { ctx, state } = setup({ equipment: [EQ.boneDarts], foeIsKasrkin: true, seed: 4 });
    const me = opWith(state, 'p1', WARRIOR);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [me, foe]);
    place(state, me, 10, 10);
    place(state, foe, 13, 10);
    let s = activate(ctx, state, me);
    const before = ctx.hooks
      .emit('availableWeapons', s, { state: s, operative: s.operatives[me]!, weapons: [] })
      .weapons;
    void before;
    expect(
      (s.operatives[me]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons?.some(
        (w) => w.name === 'Bone dart',
      ),
    ).toBe(true);
    const started = startShoot(ctx, s, s.operatives[me]!, 'Bone dart', undefined, foe);
    expect(started.ok).toBe(true);
    advanceShoot(ctx, s);
    while (s.pending.length > 0) s = reduce(s, { t: 'PassDecision', decisionId: s.pending[0]!.id }, ctx).state;
    // Spent for the turning point: the grant is withdrawn on the next read.
    ctx.hooks.emit('availableWeapons', s, { state: s, operative: s.operatives[me]!, weapons: [] });
    expect(
      (s.operatives[me]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons?.some(
        (w) => w.name === 'Bone dart',
      ),
    ).toBe(false);
  });

  it('BONE DARTS refuses a second use in the same turning point at the Select Weapon step', () => {
    const { ctx, state } = setup({ equipment: [EQ.boneDarts], foeIsKasrkin: true, seed: 4 });
    const me = opWith(state, 'p1', WARRIOR);
    const foe = foeAt(state, 1);
    isolate(state, [me, foe]);
    place(state, me, 10, 10);
    place(state, foe, 13, 10);
    const s = activate(ctx, state, me);
    ctx.hooks.emit('availableWeapons', s, { state: s, operative: s.operatives[me]!, weapons: [] });
    const refusal = ctx.hooks.emit('onSelectWeapon', s, {
      state: s,
      ctx: {
        attacker: s.operatives[me]!,
        defender: s.operatives[foe]!,
        weaponName: BONE_DART.name,
        profile: BONE_DART.profiles[0]!,
        rules: BONE_DART.profiles[0]!.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 3,
      },
      allowed: true,
      dryRun: false,
    });
    expect(refusal.allowed).toBe(true); // the first use claims the allowance
    const second = ctx.hooks.emit('onSelectWeapon', s, {
      state: s,
      ctx: {
        attacker: s.operatives[me]!,
        defender: s.operatives[foe]!,
        weaponName: BONE_DART.name,
        profile: BONE_DART.profiles[0]!,
        rules: BONE_DART.profiles[0]!.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 3,
      },
      allowed: true,
      dryRun: true,
    });
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('once per turning point');
  });

  it('SOUL GEM adds Blast 1" to a baleblast only when another enemy is in the footprint and no friendly is', () => {
    expect(ruleText(EQ.soulGem)).toContain('that weapon has the Blast 1" weapon rule');
    const { ctx, state } = setup({ equipment: [EQ.soulGem], foeIsKasrkin: true });
    const shooter = state.operatives[opWith(state, 'p1', NIGHTFIEND)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const foe2 = state.operatives[state.teams.p2.operativeIds[1]!]!;
    const mate = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    isolate(state, [shooter.id, foe.id, foe2.id, mate.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    place(state, foe2.id, 25, 2);
    place(state, mate.id, 25, 4);
    const profile = profileOf(NIGHTFIEND, 'Baleblast');
    const alone = effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Baleblast' });
    expect(alone.some((r) => r.id === 'Blast')).toBe(false);
    place(state, foe2.id, 14.8, 10);
    const clustered = effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Baleblast' });
    expect(clustered.find((r) => r.id === 'Blast')).toMatchObject({ x: 1 });
    // A friendly operative in the footprint switches the policy off (Blast catches it too).
    place(state, mate.id, 14, 10.8);
    const risky = effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Baleblast' });
    expect(risky.some((r) => r.id === 'Blast')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('MANDRAKES AI hints', () => {
  it('names a role for every datacard and a value for all eight ploys plus the gambit and four equipment options', () => {
    const roles = mandrakes.aiHints!.roles!;
    for (const card of DATA.datacards) expect(roles[card.id]).toBeDefined();
    const ployValue = mandrakes.aiHints!.ployValue!;
    for (const ploy of mandrakes.ploys) expect(ployValue[ploy.id]).toBeDefined();
    expect(ployValue['mandrakes.gambit.haunting-focus']).toBeDefined();
    const equipmentValue = mandrakes.aiHints!.equipmentValue!;
    for (const eq of mandrakes.equipment) expect(equipmentValue[eq.id]).toBeDefined();
  });

  it('registers three unique actions plus the two D-021 carve-outs', () => {
    for (const id of [ACT.wreatheInBalefire, ACT.pareidolicProjection, ACT.weaveDarkness]) {
      expect(getAction(id)).toBeDefined();
    }
    expect(getAction(SHADOW_PASSAGE_ACTION)?.treatedAs).toBe('Reposition');
    expect(getAction(BLADE_IN_THE_DARK_CHARGE)?.treatedAs).toBe('Charge');
  });
});
