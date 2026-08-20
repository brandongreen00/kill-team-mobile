/**
 * BLADES OF KHAINE. Every test quotes the printed rule it pins, read out of
 * `data/teams/blades-of-khaine.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/blades-of-khaine/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions, readyStep, rollInitiative } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { sideWeapon, startFight } from '../../src/core/sequences/fight.ts';
import { effectiveRules, startShoot } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, hitOf, moveOf, statMods, weaponsOf } from '../../src/core/state.ts';
import { teamData } from '../../src/teams/data.ts';
import rawJson from '../../data/teams/blades-of-khaine.json';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import {
  ASPECT_TECHNIQUES,
  AT,
  C,
  CHARGE_WOE,
  DASH_STRIKE_AND_FADE,
  DECLARE_ONE_WITH_THE_GLOOM,
  DECLARE_RAGING_HEAT,
  DIRE_AVENGER,
  EQ,
  FALL_BACK_RAIN,
  FIGHT_BLADEWIND,
  FIGHT_EXARCH,
  FIGHT_MERCILESS,
  FP,
  HOWLING_BANSHEE,
  KW,
  RAIN_DECISION,
  REPOSITION_PATIENT_STALK,
  RULE_ASPECT_TECHNIQUES,
  SCREAM_DECISION,
  SHOOT_EXARCH,
  SHOOT_SCORPIONS_EYE,
  SHOOT_SHRIEK,
  SHOOT_SLICING,
  SHOOT_STARFALL,
  SHOOT_THOUSAND,
  SHOOT_VIGILANCE,
  SHRIEK_WEAPON,
  SP,
  STRIKING_SCORPION,
  aspectTechnique,
  bladesOfKhaine,
  monoAspect,
  perTurningPointLimit,
  techniqueUsable,
  techniqueUses,
} from '../../src/teams/blades-of-khaine/index.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { act, activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, KillzoneMap, OperativeState, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('blades-of-khaine');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const RAW = rawJson as unknown as {
  notes: string[];
  archetypes: string[];
  selection: { leaderList: { role: string; notes?: string[] }[]; rawText: string };
  factionRules: { weapons?: { name: string; profiles: { rules: unknown[] }[] }[] }[];
};

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/** All six datacards, so every Aspect is on the board (and the kill team is NOT mono-aspect). */
const MIXED = [
  C.direAvengerExarch,
  C.direAvengerWarrior,
  C.howlingBansheeExarch,
  C.howlingBansheeWarrior,
  C.strikingScorpionExarch,
  C.strikingScorpionWarrior,
];

interface SetupOpts {
  roles?: string[];
  equipment?: string[];
  seed?: number;
  script?: number[];
  map?: KillzoneMap;
  mirror?: boolean;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([bladesOfKhaine, kasrkin], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = rosterIncluding(bladesOfKhaine, opts.roles ?? MIXED);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: bladesOfKhaine, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: opts.mirror ? { module: bladesOfKhaine, picks } : { module: kasrkin },
  });
  // Zero CP by default: a Command Re-roll window on every pool would drown the dice tests.
  state.teams.p1.cp = 0;
  state.teams.p2.cp = 0;
  return { ctx, state };
}

/** Resolve pending decisions on a deterministic policy, optionally stopping at one kind. */
function drive(ctx: GameContext, start: GameState, stopAt?: string): GameState {
  let s = start;
  let guard = 0;
  while (s.pending.length > 0 && guard++ < 60) {
    const d = s.pending[0]!;
    if (stopAt && d.kind === stopAt) break;
    const pick =
      d.kind === 'reroll'
        ? 'keep'
        : d.kind === 'retention'
          ? 'skip'
          : d.kind === 'allocateDefence'
            ? 'auto'
            : d.kind === 'coverOrObscured'
              ? 'obscured'
              : d.options.find((o) => !o.disabled)!.id;
    s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: pick }, ctx).state;
  }
  return s;
}

const place = (state: GameState, id: string, x: number, y: number, z = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = z;
  return op;
};

/** Park every operative but the named ones far away so no third body interferes. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1 + (n % 3) * 0.8, y: 20 + Math.floor(n / 3) * 0.9 };
    n++;
  }
}

const meleeRules = (ctx: GameContext, state: GameState, op: OperativeState, weapon: string, target?: OperativeState) =>
  effectiveRules(ctx, state, profileOf(op.datacardId, weapon), {
    operative: op,
    ...(target ? { target } : {}),
    weaponName: weapon,
  }).map((r) => r.id);

const rangedRules = (ctx: GameContext, state: GameState, op: OperativeState, weapon: string, target?: OperativeState) =>
  effectiveRules(ctx, state, profileOf(op.datacardId, weapon), {
    operative: op,
    ...(target ? { target } : {}),
    weaponName: weapon,
  }).map((r) => r.id);

const path = (...points: Vec2[]) => ({ path: { points } });

// ---------------------------------------------------------------------------
describe('BLADES OF KHAINE data (pinned against data/teams/blades-of-khaine.json)', () => {
  it('has 6 datacards — an Exarch and a Warrior for each of the three Aspects — all APL 3, M 7", 28mm', () => {
    expect(DATA.datacards).toHaveLength(6);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 3, move: 7, base: { shape: 'round', mm: 28 } });
      expect(card.keywords.slice(0, 3)).toEqual([KW, 'AELDARI', 'ASURYANI']);
    }
    const aspects = DATA.datacards.map((c) => c.keywords.find((k) => k === DIRE_AVENGER || k === HOWLING_BANSHEE || k === STRIKING_SCORPION));
    expect(aspects).toEqual([DIRE_AVENGER, DIRE_AVENGER, HOWLING_BANSHEE, HOWLING_BANSHEE, STRIKING_SCORPION, STRIKING_SCORPION]);
    expect(DATA.datacards.filter((c) => c.keywords.includes('LEADER')).map((c) => c.id)).toEqual([
      C.direAvengerExarch,
      C.howlingBansheeExarch,
      C.strikingScorpionExarch,
    ]);
  });

  it('pins the wounds and saves the rules read: Exarchs 9W/3+, DIRE AVENGER and HOWLING BANSHEE WARRIORs 8W/4+, STRIKING SCORPION WARRIOR 8W/3+', () => {
    const by = Object.fromEntries(DATA.datacards.map((c) => [c.id, { wounds: c.wounds, save: c.save }]));
    expect(by[C.direAvengerExarch]).toEqual({ wounds: 9, save: 3 });
    expect(by[C.howlingBansheeExarch]).toEqual({ wounds: 9, save: 3 });
    expect(by[C.strikingScorpionExarch]).toEqual({ wounds: 9, save: 3 });
    expect(by[C.direAvengerWarrior]).toEqual({ wounds: 8, save: 4 });
    expect(by[C.howlingBansheeWarrior]).toEqual({ wounds: 8, save: 4 });
    expect(by[C.strikingScorpionWarrior]).toEqual({ wounds: 8, save: 3 });
  });

  it('pins the weapon profiles the ASPECT TECHNIQUES name', () => {
    expect(profileOf(C.direAvengerExarch, 'Shuriken catapult')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(C.direAvengerExarch, 'Shuriken catapult').rules.map((r) => r.id)).toEqual(['Rending']);
    expect(profileOf(C.direAvengerExarch, 'Twin shuriken catapult').rules.map((r) => r.id)).toEqual(['Ceaseless', 'Rending']);
    expect(profileOf(C.direAvengerExarch, 'Shuriken pistol').rules.map((r) => r.raw)).toEqual(['Range 8"', 'Rending']);
    expect(profileOf(C.direAvengerExarch, 'Diresword').rules.map((r) => r.raw)).toEqual(['Lethal 5+', 'Rending']);
    expect(profileOf(C.strikingScorpionExarch, "Scorpion's claw and chainsword").rules.map((r) => r.id)).toEqual(['Brutal', 'Lethal']);
    expect(profileOf(C.strikingScorpionExarch, 'Biting blade')).toMatchObject({ atk: 5, dmgN: 5, dmgC: 6 });
    expect(profileOf(C.howlingBansheeExarch, 'Executioner')).toMatchObject({ dmgN: 3, dmgC: 7 });
    const triskele = DATA.datacards.find((c) => c.id === C.howlingBansheeExarch)!.weapons.find((w) => w.name === 'Triskele')!;
    expect(triskele.profiles.map((p) => `${p.name}:${p.type}`)).toEqual(['throw:ranged', 'slice:melee']);
  });

  it('prints 1 faction rule, 4+4 ploys, 4 equipment options, 10 abilities and NO unique actions or rare weapon rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Aspect Techniques']);
    expect(bladesOfKhaine.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(bladesOfKhaine.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(bladesOfKhaine.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(10);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toEqual([]);
    expect(DATA.rareWeaponRules).toEqual([]);
    expect(RAW.notes).toEqual([]);
  });

  it('DATA BUG: every firefight ploy has "1CP" glued onto its NAME **and** its id', () => {
    expect(DATA.firefightPloys.map((p) => p.name)).toEqual(['BLADEWIND1CP', 'STARFALL1CP', 'FADING LIGHT1CP', 'CONTEMPT1CP']);
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual([FP.bladewind, FP.starfall, FP.fadingLight, FP.contempt]);
    for (const id of Object.values(FP)) expect(id).toMatch(/1cp$/);
    // The strategy ploys are clean, so this is the id-level Inquisitorial Agent bug, not a name trim.
    expect(DATA.strategyPloys.map((p) => p.name)).toEqual(['FOREWARNED', 'RUTHLESS POISE', "KHAINE'S VENGEANCE", 'DANCE OF DEATH']);
  });

  it('DATA BUG: the DIRE AVENGER EXARCH "Shimmershield" option is not a datacard weapon and is kept verbatim in items[]', () => {
    const group = DATA.selection.leaderList[0]!.optionGroups.find((g) => g.label.includes('Shimmershield'))!;
    const shield = group.choices[0] as unknown as { label: string; weapons: string[]; items?: string[] };
    expect(shield.weapons).toEqual([]);
    expect(shield.items).toEqual(['Shimmershield']);
    expect(RAW.selection.leaderList[0]!.notes).toEqual([
      "option 'Shimmershield': ['Shimmershield'] is not a weapon on the datacard (kept verbatim in `items`)",
    ]);
    expect(DATA.datacards.find((c) => c.id === C.direAvengerExarch)!.weapons.map((w) => w.name)).not.toContain('Shimmershield');
  });

  it('DATA BUG: only the DIRE AVENGER EXARCH is on the leader list, though the printed text offers three EXARCHes', () => {
    expect(DATA.selection.leaderList.map((e) => e.role)).toEqual(['DIRE AVENGER EXARCH']);
    expect(DATA.selection.rawText).toContain('HOWLING BANSHEE EXARCH equipped with one of the following options:');
    expect(DATA.selection.rawText).toContain('STRIKING SCORPION EXARCH equipped with one of the following options:');
    // …so neither of those two datacards can be fielded by the shared validator.
    expect(validateRosterFor(DATA, [{ datacardId: C.howlingBansheeExarch }]).codes).toContain('unknownEntry');
  });

  it('DATA BUG: the Shriek-that-kills weapon parses with rules: [] — they are sliced back out of the printed WR row', () => {
    expect(RAW.factionRules[0]!.weapons![0]!.profiles[0]!.rules).toEqual([]);
    expect(SHRIEK_WEAPON.name).toBe('Shriek-that-kills');
    expect(SHRIEK_WEAPON.profiles[0]).toMatchObject({ type: 'ranged', atk: 5, hit: 3, dmgN: 1, dmgC: 2 });
    expect(SHRIEK_WEAPON.profiles[0]!.rules.map((r) => r.raw)).toEqual(['Range 6"', 'Saturate', 'Seek Light', 'Stun', 'Torrent 1"']);
  });

  it('its archetypes are ["*"] because the second archetype follows the Aspect chosen', () => {
    expect(DATA.archetypes).toEqual(['*']);
    // `TeamState.archetypes` is never populated from team data, so the reducer's tac-op gate
    // (`archetypes.length > 0 && !archetypes.includes(...)`) never sees the wildcard.
    const { state } = setup();
    expect(state.teams.p1.archetypes).toEqual([]);
  });

  it('the section overrun is trimmed at load and the marker guide names three tokens', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.markerGuide).toContain('Wraithbone Talisman token');
  });
});

// ---------------------------------------------------------------------------
describe('BLADES OF KHAINE selection', () => {
  it('defaultRoster is a legal 8-operative kill team: 1 DIRE AVENGER EXARCH + 7 DIRE AVENGER WARRIORs', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(8);
    expect(picks[0]!.datacardId).toBe(C.direAvengerExarch);
    expect(picks.filter((p) => p.datacardId === C.direAvengerWarrior)).toHaveLength(7);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(DATA.selection.constraints).toEqual([]);
    // Its EXARCH takes the shimmershield option, so the printed loadout omits the shuriken pistol.
    expect(validateRosterFor(DATA, picks).weapons[0]).toEqual(['Shuriken catapult', 'Diresword', 'Fists']);
  });
});

// ---------------------------------------------------------------------------
describe('Aspect Techniques — the faction rule is a MENU of fifteen sub-rules with no ids', () => {
  it('slices fifteen techniques out of the one printed faction rule, five per Aspect', () => {
    expect(ASPECT_TECHNIQUES).toHaveLength(15);
    const src = ruleText(RULE_ASPECT_TECHNIQUES);
    for (const t of ASPECT_TECHNIQUES) {
      expect(src).toContain(t.name);
      expect(src).toContain(t.text);
      expect(t.text.startsWith('Use this ASPECT TECHNIQUE')).toBe(true);
    }
    for (const aspect of [DIRE_AVENGER, HOWLING_BANSHEE, STRIKING_SCORPION])
      expect(ASPECT_TECHNIQUES.filter((t) => t.aspect === aspect)).toHaveLength(5);
    expect(Object.values(AT).sort()).toEqual(ASPECT_TECHNIQUES.map((t) => t.id).sort());
  });

  it('"Each ASPECT TECHNIQUE can only be used with a friendly operative that has the matching Aspect keyword"', () => {
    const { state } = setup();
    const avenger = state.operatives[opWith(state, 'p1', C.direAvengerWarrior)]!;
    const banshee = state.operatives[opWith(state, 'p1', C.howlingBansheeWarrior)]!;
    expect(techniqueUsable(state, avenger, AT.vigilance).ok).toBe(true);
    expect(techniqueUsable(state, banshee, AT.vigilance)).toEqual({
      ok: false,
      reason: 'VIGILANCE OF THE AVENGER can only be used with a friendly DIRE AVENGER operative',
    });
    expect(techniqueUsable(state, banshee, AT.rainOfTears).ok).toBe(true);
  });

  it('"You cannot use more than one ASPECT TECHNIQUE per activation or counteraction"', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    let s = activate(ctx, state, avenger);
    s = act(ctx, s, avenger, DECLARE_RAGING_HEAT).state;
    expect(techniqueUses(s, 'p1', AT.ragingHeat)).toBe(1);
    const second = techniqueUsable(s, s.operatives[avenger]!, AT.vigilance);
    expect(second).toEqual({
      ok: false,
      reason: 'you cannot use more than one ASPECT TECHNIQUE per activation or counteraction',
    });
    // A different operative's activation opens the window again.
    s = reduce(s, { t: 'EndActivation', operativeId: avenger }, ctx).state;
    const other = opWith(state, 'p1', C.direAvengerExarch);
    s.activePlayer = 'p1';
    s = activate(ctx, s, other);
    expect(techniqueUsable(s, s.operatives[other]!, AT.vigilance).ok).toBe(true);
  });

  it('"You cannot use each ASPECT TECHNIQUE more than once per turning point" — twice for a mono-Aspect kill team', () => {
    const mixed = setup();
    expect(monoAspect(mixed.state, 'p1')).toBeUndefined();
    expect(perTurningPointLimit(mixed.state, 'p1')).toBe(1);

    const mono = setup({ roles: [C.direAvengerExarch, C.direAvengerWarrior] });
    expect(monoAspect(mono.state, 'p1')).toBe(DIRE_AVENGER);
    expect(perTurningPointLimit(mono.state, 'p1')).toBe(2);

    // Two different DIRE AVENGERs, two activations: the mixed team is out after the first.
    const run = (fixture: { ctx: GameContext; state: GameState }): number => {
      const { ctx } = fixture;
      let s = fixture.state;
      const a = opWith(s, 'p1', C.direAvengerExarch);
      const b = opWith(s, 'p1', C.direAvengerWarrior);
      s = activate(ctx, s, a);
      s = act(ctx, s, a, DECLARE_RAGING_HEAT).state;
      s = reduce(s, { t: 'EndActivation', operativeId: a }, ctx).state;
      s.activePlayer = 'p1';
      s = activate(ctx, s, b);
      s = act(ctx, s, b, DECLARE_RAGING_HEAT).state;
      return techniqueUses(s, 'p1', AT.ragingHeat);
    };
    expect(run(mixed)).toBe(1);
    expect(run(mono)).toBe(2);
  });

  it('ACROBATIC is REMINDER-ONLY: `onMoveRules` is declared but never emitted, so no handler is registered', () => {
    const t = aspectTechnique(AT.acrobatic);
    expect(t.text).toContain('Can ignore all vertical distances whenever it drops and climbs.');
    expect(t.text).toContain('Can move through enemy operatives, move within control range of them');
    // No ActionDef and no declaration channel exists for it — registering one would be a
    // silent no-op for both permissions and would leave only its Charge PENALTY live.
    expect(getAction('Aspect Technique (Acrobatic)')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('Dire Avenger Aspect Techniques', () => {
  it('THE SLICING HURRICANE is a 0AP Shoot performed during a Reposition, limited to the three shuriken weapons', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 6, 11);
    place(state, foe, 14, 11);
    const def = getAction(SHOOT_SLICING)!;
    expect(def.ap).toBe(0);
    expect(def.treatedAs).toBe('Shoot');
    let s = activate(ctx, state, avenger);
    const op = s.operatives[avenger]!;
    expect(def.check(ctx, s, op, { weaponName: 'Shuriken catapult', targetId: foe }).reason).toBe(
      'THE SLICING HURRICANE is performed during the Reposition action',
    );
    s = act(ctx, s, avenger, 'Reposition', path({ x: 8, y: 11 })).state;
    const moved = s.operatives[avenger]!;
    expect(def.check(ctx, s, moved, { weaponName: 'Fists', targetId: foe }).reason).toContain('shuriken catapult');
    expect(def.check(ctx, s, moved, { weaponName: 'Shuriken catapult', targetId: foe }).ok).toBe(true);
    const before = moved.apSpent;
    s = act(ctx, s, avenger, SHOOT_SLICING, { weaponName: 'Shuriken catapult', targetId: foe }).state;
    expect(s.operatives[avenger]!.apSpent).toBe(before); // "during that action" — no extra AP
    expect(s.operatives[avenger]!.actionsThisActivation).toEqual(['Reposition', 'Shoot']);
    expect(techniqueUses(s, 'p1', AT.slicingHurricane)).toBe(1);
  });

  it('DEATH OF A THOUSAND BLADES gives the shuriken catapult Torrent 2" and caps the sequence at ONE secondary target', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foes = state.teams.p2.operativeIds.slice(0, 3);
    isolate(state, [avenger, ...foes]);
    place(state, avenger, 6, 11);
    place(state, foes[0]!, 14, 11);
    place(state, foes[1]!, 14, 12.4);
    place(state, foes[2]!, 14, 9.6);
    let s = activate(ctx, state, avenger);
    const op = s.operatives[avenger]!;
    expect(rangedRules(ctx, s, op, 'Shuriken catapult')).not.toContain('Torrent');
    s = act(ctx, s, avenger, SHOOT_THOUSAND, { weaponName: 'Shuriken catapult', targetId: foes[0] }).state;
    const seq = s.sequence as ShootSequence;
    expect(seq.kind).toBe('shoot');
    // Torrent 2" found both neighbours; the technique keeps only one of them.
    expect(rangedRules(ctx, s, s.operatives[avenger]!, 'Shuriken catapult')).toContain('Torrent');
    expect(seq.queue.length + seq.resolvedTargets.length).toBeLessThanOrEqual(2);
    expect(s.log.some((e) => e.text === 'DEATH OF A THOUSAND BLADES: only one secondary target')).toBe(true);
    expect(ruleText(RULE_ASPECT_TECHNIQUES)).toContain('you cannot select more than one secondary target');
  });

  it('VIGILANCE OF THE AVENGER gives the shuriken catapult Lethal 5+ and nothing else', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 6, 11);
    place(state, foe, 14, 11);
    let s = activate(ctx, state, avenger);
    expect(getAction(SHOOT_VIGILANCE)!.check(ctx, s, s.operatives[avenger]!, { weaponName: 'Fists', targetId: foe }).ok).toBe(false);
    s = act(ctx, s, avenger, SHOOT_VIGILANCE, { weaponName: 'Shuriken catapult', targetId: foe }).state;
    const op = s.operatives[avenger]!;
    expect(rangedRules(ctx, s, op, 'Shuriken catapult')).toContain('Lethal');
    expect(rangedRules(ctx, s, op, 'Fists')).not.toContain('Lethal');
    expect(techniqueUses(s, 'p1', AT.vigilance)).toBe(1);
  });

  it('UNSTINTING, IMMOVABLE discards one defence-dice fail to retain another as a normal success', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const shooter = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, shooter]);
    place(state, avenger, 14, 11);
    place(state, shooter, 6, 11);
    const gunner = state.operatives[shooter]!;
    const weapon = ctx.datacards.get(gunner.datacardId)!.weapons.find((w) => w.profiles[0]!.type === 'ranged')!;
    expect(startShoot(ctx, state, gunner, weapon.name, weapon.profiles[0]!.name, avenger).ok).toBe(true);
    const seq = state.sequence as ShootSequence;
    seq.step = 'defenceRerolls';
    addRolled(seq.defence, [1, 2, 5], 4); // two fails at a 4+ save
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: fakeAttack(state.operatives[shooter]!, state.operatives[avenger]!, weapon.name, weapon.profiles[0]!),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'normal']);
    expect(techniqueUses(state, 'p1', AT.unstinting)).toBe(1);
  });

  it('RAGING HEAT OF THE DYING FLAME cancels the injured Move and Hit penalties until its next activation', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const op = state.operatives[avenger]!;
    op.wounds = 3; // fewer than half of 8 — injured
    expect(moveOf(ctx, state, op)).toBe(5);
    expect(hitOf(ctx, state, op, profileOf(C.direAvengerWarrior, 'Shuriken catapult'))).toBe(4);
    let s = activate(ctx, state, avenger);
    s = act(ctx, s, avenger, DECLARE_RAGING_HEAT).state;
    const hot = s.operatives[avenger]!;
    expect(moveOf(ctx, s, hot)).toBe(7);
    expect(hitOf(ctx, s, hot, profileOf(C.direAvengerWarrior, 'Shuriken catapult'))).toBe(3);
    expect(statMods(ctx, s, hot)).toMatchObject({ move: 2, hit: 1 });
    // "Until the start of that operative's next activation."
    s = reduce(s, { t: 'EndActivation', operativeId: avenger }, ctx).state;
    expect(moveOf(ctx, s, s.operatives[avenger]!)).toBe(7);
    s.operatives[avenger]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, avenger);
    expect(moveOf(ctx, s, s.operatives[avenger]!)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('Howling Banshee Aspect Techniques', () => {
  it('SHRIEK-THAT-KILLS grants a weapon that is on no datacard, and the universal Shoot refuses it undeclared', () => {
    const { ctx, state } = setup();
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 13, 11);
    let s = activate(ctx, state, banshee);
    const gate = (st: GameState) =>
      ctx.hooks.emit('onSelectWeapon', st, {
        state: st,
        ctx: fakeAttack(st.operatives[banshee]!, st.operatives[foe]!, SHRIEK_WEAPON.name, SHRIEK_WEAPON.profiles[0]!),
        allowed: true,
        dryRun: true,
      });
    // Undeclared, the weapon can never be selected — so it can never reach the universal Shoot.
    expect(gate(s).allowed).toBe(false);
    expect(gate(s).reason).toContain('SHRIEK-THAT-KILLS');
    expect(weaponsOf(ctx, s, s.operatives[banshee]!, 'ranged').map((w) => w.name)).not.toContain(SHRIEK_WEAPON.name);
    s = act(ctx, s, banshee, SHOOT_SHRIEK, { targetId: foe }).state;
    expect(s.rejected).toEqual([]);
    expect(gate(s).allowed).toBe(true);
    expect(weaponsOf(ctx, s, s.operatives[banshee]!, 'ranged').map((w) => w.name)).toContain(SHRIEK_WEAPON.name);
    expect(s.log.some((e) => e.text.includes('Shriek-that-kills'))).toBe(true);
    expect(techniqueUses(s, 'p1', AT.shriekThatKills)).toBe(1);
  });

  it('RAIN OF TEARS raises a decision on a critical strike, ends the sequence and arms a 0AP 3" Fall Back', () => {
    // A 6 on every dice: the HOWLING BANSHEE's power weapon strikes with a critical success.
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1] });
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 10.9, 11);
    state.operatives[foe]!.wounds = 40; // survives the crit, so the technique can trigger
    let s = activate(ctx, state, banshee);
    s = drive(ctx, act(ctx, s, banshee, 'Fight', { targetId: foe }).state, 'strikeOrBlock');
    const strike = s.pending.find((d) => d.kind === 'strikeOrBlock')!;
    const critStrike = strike.options.find((o) => o.id.startsWith('strike:'))!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: strike.id, optionId: critStrike.id }, ctx).state;
    const offer = s.pending.find((d) => d.kind === RAIN_DECISION);
    expect(offer).toBeDefined();
    expect(offer!.options[0]!.id).toBe('decline'); // the deterministic default declines
    s = reduce(s, { t: 'ResolveDecision', decisionId: offer!.id, optionId: 'use' }, ctx).state;
    expect(s.sequence).toBeNull();
    expect(techniqueUses(s, 'p1', AT.rainOfTears)).toBe(1);
    const fallBack = getAction(FALL_BACK_RAIN)!;
    expect(fallBack.ap).toBe(0);
    const op = s.operatives[banshee]!;
    expect(fallBack.available!(ctx, s, op)).toBe(true);
    // "up to 3"" — 4" is refused, 2.5" is allowed.
    expect(fallBack.check(ctx, s, op, { path: { points: [{ x: 6, y: 11 }] } }).ok).toBe(false);
    expect(fallBack.check(ctx, s, op, { path: { points: [{ x: 7.5, y: 11 }] } }).ok).toBe(true);
  });

  it('THE WOE is a second Charge action, gated on Charge + Fight + a kill, using what is left of the first Charge', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1] });
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    const other = state.teams.p2.operativeIds[1]!;
    isolate(state, [banshee, foe, other]);
    place(state, banshee, 6, 11);
    place(state, foe, 9, 11);
    place(state, other, 13.5, 11);
    state.operatives[foe]!.wounds = 1;
    state.operatives[banshee]!.wounds = 40;
    let s = activate(ctx, state, banshee);
    s = act(ctx, s, banshee, 'Charge', path({ x: 8, y: 11 })).state; // 2" of the 9" allowance
    const woe = getAction(CHARGE_WOE)!;
    expect(woe.ap).toBe(0);
    expect(woe.check(ctx, s, s.operatives[banshee]!, path({ x: 12, y: 11 })).reason).toContain('incapacitated an enemy');
    s = drive(ctx, act(ctx, s, banshee, 'Fight', { targetId: foe }).state);
    expect(s.operatives[foe]!.removed).toBe(true);
    const op = s.operatives[banshee]!;
    expect(op.actionsThisActivation).toEqual(['Charge', 'Fight']);
    // "using any remaining move distance it had from that first Charge action": 9" − 2" = 7".
    expect(moveBudget(ctx, s, op, { action: 'Charge', bonusInches: 2 })).toBe(7);
    expect(woe.check(ctx, s, op, path({ x: 12.5, y: 11 })).ok).toBe(true);
    const after = act(ctx, s, banshee, CHARGE_WOE, path({ x: 12.5, y: 11 }));
    expect(after.ok).toBe(true);
    expect(after.state.operatives[banshee]!.pos).toEqual({ x: 12.5, y: 11 });
    expect(techniqueUses(after.state, 'p1', AT.theWoe)).toBe(1);
  });

  it('SCREAM-THAT-STEALS is offered only while RETALIATING and resolves one success before the normal order', () => {
    const { ctx, state } = setup({ seed: 3 });
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 10.9, 11);
    // p2 fights p1's HOWLING BANSHEE, so the Banshee is the RETALIATING side.
    let s: GameState = { ...state, activePlayer: 'p2' };
    s = activate(ctx, s, foe);
    s = act(ctx, s, foe, 'Fight', { targetId: banshee }).state;
    const offer = s.pending.find((d) => d.kind === SCREAM_DECISION);
    expect(offer).toBeDefined();
    expect(offer!.who).toBe('p1');
    expect(offer!.options[0]!.id).toBe('decline');
    s = reduce(s, { t: 'ResolveDecision', decisionId: offer!.id, optionId: 'use' }, ctx).state;
    expect((s.sequence as FightSequence).turn).toBe('defender');
    expect(techniqueUses(s, 'p1', AT.screamThatSteals)).toBe(1);
  });

  it('…and "that success must be used to block" is NOT enforced — the engine builds the strike/block options', () => {
    const t = aspectTechnique(AT.screamThatSteals);
    expect(t.text).toContain('that success must be used to block');
    const { ctx, state } = setup({ seed: 3 });
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 10.9, 11);
    let s: GameState = { ...state, activePlayer: 'p2' };
    s = activate(ctx, s, foe);
    s = act(ctx, s, foe, 'Fight', { targetId: banshee }).state;
    const offer = s.pending.find((d) => d.kind === SCREAM_DECISION)!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: offer.id, optionId: 'use' }, ctx).state;
    const strike = s.pending.find((d) => d.kind === 'strikeOrBlock');
    if (strike) expect(strike.options.some((o) => o.id.startsWith('strike:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Striking Scorpion Aspect Techniques', () => {
  it("SCORPION'S EYE gives the shuriken pistol Seek Light for that Shoot action", () => {
    const { ctx, state } = setup();
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 10, 11);
    place(state, foe, 14, 11);
    let s = activate(ctx, state, scorpion);
    expect(rangedRules(ctx, s, s.operatives[scorpion]!, 'Shuriken pistol')).not.toContain('SeekLight');
    s = act(ctx, s, scorpion, SHOOT_SCORPIONS_EYE, { weaponName: 'Shuriken pistol', targetId: foe }).state;
    expect(rangedRules(ctx, s, s.operatives[scorpion]!, 'Shuriken pistol')).toContain('SeekLight');
  });

  it('MERCILESS STRIKES adds Shock to the melee weapon after the first critical strike of the sequence', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1] });
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 10, 11);
    place(state, foe, 10.9, 11);
    state.operatives[foe]!.wounds = 40;
    state.operatives[scorpion]!.wounds = 40;
    let s = activate(ctx, state, scorpion);
    s = drive(ctx, act(ctx, s, scorpion, FIGHT_MERCILESS, { targetId: foe }).state, 'strikeOrBlock');
    const seq = s.sequence as FightSequence;
    expect(meleeRules(ctx, s, s.operatives[scorpion]!, 'Chainsword')).not.toContain('Shock');
    const strike = s.pending.find((d) => d.kind === 'strikeOrBlock')!;
    s = reduce(
      s,
      { t: 'ResolveDecision', decisionId: strike.id, optionId: strike.options.find((o) => o.id.startsWith('strike:'))!.id },
      ctx,
    ).state;
    expect(sideWeapon(ctx, s, s.sequence as FightSequence, 'attacker').rules.map((r) => r.id)).toContain('Shock');
    expect(seq.kind).toBe('fight');
    expect(techniqueUses(s, 'p1', AT.mercilessStrikes)).toBe(1);
  });

  it('ONE WITH THE GLOOM makes a Conceal-order STRIKING SCORPION in cover an invalid target — except within 2"', () => {
    const map = testMap({ features: [heavyBlock('block', 12, 10, 1, 4, 2)] });
    const { ctx, state } = setup({ map });
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 13.6, 11);
    place(state, foe, 6, 11);
    const shooter = state.operatives[foe]!;
    const target = state.operatives[scorpion]!;
    target.order = 'conceal';
    const before = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(before.valid).toBe(true);
    let s = activate(ctx, state, scorpion, 'conceal');
    s = act(ctx, s, scorpion, DECLARE_ONE_WITH_THE_GLOOM).state;
    const after = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[foe]!,
      target: s.operatives[scorpion]!,
      valid: true,
      ignoreCoverTerrain: 'all', // Seek would normally strip the cover — the technique takes precedence
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(after.valid).toBe(false);
    expect(after.reason).toContain('ONE WITH THE GLOOM');
    // "…except being within 2"."
    place(s, foe, 12.0, 11);
    const close = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[foe]!,
      target: s.operatives[scorpion]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(close.valid).toBe(true);
  });

  it('PATIENT STALK, SUDDEN BLOW is a Conceal-order Reposition that inflicts D3+2 on an enemy the move passed', () => {
    const { ctx, state } = setup({ script: [2] }); // D3 = 1 → 3 damage
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 6, 11);
    place(state, foe, 10, 11);
    const def = getAction(REPOSITION_PATIENT_STALK)!;
    let s = activate(ctx, state, scorpion, 'engage');
    expect(def.check(ctx, s, s.operatives[scorpion]!, path({ x: 12, y: 11 })).reason).toBe(
      'this operative must have a Conceal order',
    );
    s = reduce(s, { t: 'EndActivation', operativeId: scorpion }, ctx).state;
    s.operatives[scorpion]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, scorpion, 'conceal');
    const wounds = s.operatives[foe]!.wounds;
    // The path runs straight through the enemy's control range and finishes clear of it.
    s = act(ctx, s, scorpion, REPOSITION_PATIENT_STALK, path({ x: 12.5, y: 11 })).state;
    expect(s.rejected).toEqual([]);
    expect(s.operatives[foe]!.wounds).toBe(wounds - 3);
    expect(techniqueUses(s, 'p1', AT.patientStalk)).toBe(1);
  });

  it('STRIKE AND FADE changes the order to Conceal and gives a free 0AP Dash after a fighting kill', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1] });
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    const other = state.teams.p2.operativeIds[1]!;
    isolate(state, [scorpion, foe, other]);
    place(state, scorpion, 10, 11);
    place(state, foe, 10.9, 11);
    place(state, other, 24, 11);
    state.operatives[foe]!.wounds = 1;
    state.operatives[scorpion]!.wounds = 40;
    let s = drive(ctx, act(ctx, activate(ctx, state, scorpion), scorpion, 'Fight', { targetId: foe }).state);
    expect(s.operatives[foe]!.removed).toBe(true);
    const def = getAction(DASH_STRIKE_AND_FADE)!;
    expect(def.ap).toBe(0);
    expect(def.available!(ctx, s, s.operatives[scorpion]!)).toBe(true);
    const spent = s.operatives[scorpion]!.apSpent;
    s = act(ctx, s, scorpion, DASH_STRIKE_AND_FADE, path({ x: 8, y: 11 })).state;
    expect(s.rejected).toEqual([]);
    expect(s.operatives[scorpion]!.order).toBe('conceal');
    expect(s.operatives[scorpion]!.apSpent).toBe(spent);
    expect(s.operatives[scorpion]!.pos).toEqual({ x: 8, y: 11 });
    expect(techniqueUses(s, 'p1', AT.strikeAndFade)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Datacard abilities', () => {
  it('Defence Tactics — Balanced while contesting an objective marker, and while shooting one that does', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 5, 11);
    place(state, foe, 12, 11);
    const op = state.operatives[avenger]!;
    const target = state.operatives[foe]!;
    expect(abilityText(C.direAvengerWarrior, 'blades-of-khaine.dire-avenger-warrior.defence-tactics')).toContain(
      'Balanced weapon rule',
    );
    expect(rangedRules(ctx, state, op, 'Shuriken catapult', target)).not.toContain('Balanced');
    place(state, avenger, 15, 11); // on the centre objective marker
    expect(rangedRules(ctx, state, op, 'Shuriken catapult', target)).toContain('Balanced');
    expect(meleeRules(ctx, state, op, 'Fists', target)).toContain('Balanced'); // "this operative's weapons"
    place(state, avenger, 5, 11);
    place(state, foe, 15, 11); // the TARGET now contests it
    expect(rangedRules(ctx, state, op, 'Shuriken catapult', target)).toContain('Balanced');
  });

  it('Exarch — "This operative can perform two Shoot or two Fight actions", never one of each', () => {
    const { ctx, state } = setup();
    const exarch = opWith(state, 'p1', C.direAvengerExarch);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [exarch, foe]);
    place(state, exarch, 6, 11);
    place(state, foe, 14, 11);
    let s = activate(ctx, state, exarch);
    const def = getAction(SHOOT_EXARCH)!;
    expect(def.check(ctx, s, s.operatives[exarch]!, { weaponName: 'Shuriken catapult', targetId: foe }).reason).toContain(
      'second Shoot action',
    );
    s = drive(ctx, act(ctx, s, exarch, 'Shoot', { weaponName: 'Shuriken catapult', targetId: foe }).state);
    expect(def.check(ctx, s, s.operatives[exarch]!, { weaponName: 'Shuriken catapult', targetId: foe }).ok).toBe(true);
    // A WARRIOR has no Exarch ability.
    const warrior = state.operatives[opWith(state, 'p1', C.direAvengerWarrior)]!;
    expect(def.available!(ctx, s, warrior)).toBe(false);
    // …and the Fight variant refuses once a Shoot has been performed.
    expect(getAction(FIGHT_EXARCH)!.check(ctx, s, s.operatives[exarch]!, { targetId: foe }).reason).toContain(
      'either two Shoot actions or two Fight actions',
    );
  });

  it('Shimmershield — Piercing is ignored against a friendly operative within 2" of the EXARCH that took it', () => {
    const { ctx, state } = setup();
    const exarch = opWith(state, 'p1', C.direAvengerExarch);
    const mate = opWith(state, 'p1', C.direAvengerWarrior);
    const sergeant = state.teams.p2.operativeIds.find((id) => state.operatives[id]!.datacardId === 'kasrkin.sergeant')!;
    isolate(state, [exarch, mate, sergeant]);
    place(state, exarch, 14, 11);
    place(state, mate, 15.2, 11);
    place(state, sergeant, 8, 11);
    const shooter = state.operatives[sergeant]!;
    const plasma = ctx.datacards.get('kasrkin.sergeant')!.weapons.find((w) => w.name === 'Plasma pistol')!;
    const before = effectiveRules(ctx, state, plasma.profiles[0]!, {
      operative: shooter,
      target: state.operatives[mate]!,
      weaponName: 'Plasma pistol',
    }).map((r) => r.id);
    expect(before).not.toContain('Piercing');
    // Out of range: 2"+ away, the shield does nothing.
    place(state, mate, 18, 11);
    const far = effectiveRules(ctx, state, plasma.profiles[0]!, {
      operative: shooter,
      target: state.operatives[mate]!,
      weaponName: 'Plasma pistol',
    }).map((r) => r.id);
    expect(far).toContain('Piercing');
  });

  it('Shimmershield is OFF for an EXARCH that took the shuriken pistol option instead', () => {
    const ctx = teamContext([bladesOfKhaine, kasrkin], { seed: 7 });
    const picks = defaultRoster(DATA).map((p, i) =>
      i === 0
        ? {
            ...p,
            loadoutIds: ['blades-of-khaine.g1e1.opt1', 'blades-of-khaine.g1e1.g1o1', 'blades-of-khaine.g1e1.g2o2'],
          }
        : p,
    );
    const state = battle({ ctx, p1: { module: bladesOfKhaine, picks }, p2: { module: kasrkin } });
    const exarch = opWith(state, 'p1', C.direAvengerExarch);
    const mate = opWith(state, 'p1', C.direAvengerWarrior);
    const sergeant = state.teams.p2.operativeIds.find((id) => state.operatives[id]!.datacardId === 'kasrkin.sergeant')!;
    isolate(state, [exarch, mate, sergeant]);
    place(state, exarch, 14, 11);
    place(state, mate, 15.2, 11);
    place(state, sergeant, 8, 11);
    const plasma = ctx.datacards.get('kasrkin.sergeant')!.weapons.find((w) => w.name === 'Plasma pistol')!;
    const rules = effectiveRules(ctx, state, plasma.profiles[0]!, {
      operative: state.operatives[sergeant]!,
      target: state.operatives[mate]!,
      weaponName: 'Plasma pistol',
    }).map((r) => r.id);
    // "This operative only has this rule if you select the shimmershield weapon option."
    expect(rules).toContain('Piercing');
    expect(abilityText(C.direAvengerExarch, 'blades-of-khaine.dire-avenger-exarch.shimmershield')).toContain(
      'only has this rule if you select the shimmershield weapon option',
    );
  });

  it('Banshee Mask — the enemy operative’s melee Hit is worsened by 1, and not cumulatively with injured', () => {
    const { ctx, state } = setup();
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 10.9, 11);
    const enemy = state.operatives[foe]!;
    const knife = weaponsOf(ctx, state, enemy, 'melee')[0]!;
    const base = hitOf(ctx, state, enemy, knife.profiles[0]!);
    expect(startFight(ctx, state, state.operatives[banshee]!, 'Power weapon', undefined, foe).ok).toBe(true);
    expect(hitOf(ctx, state, enemy, knife.profiles[0]!)).toBe(base + 1);
    // "This isn't cumulative with being injured."
    enemy.wounds = 2;
    expect(hitOf(ctx, state, enemy, knife.profiles[0]!)).toBe(base + 1);
    expect(abilityText(C.howlingBansheeWarrior, 'blades-of-khaine.howling-banshee-warrior.banshee-mask')).toContain(
      'This isn\u2019t cumulative with being injured.',
    );
  });

  it('Mandiblasters — 2 damage at the start of the Roll Attack Dice step, once per sequence', () => {
    const { ctx, state } = setup({ seed: 5 });
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 10, 11);
    place(state, foe, 10.9, 11);
    state.operatives[foe]!.wounds = 40;
    state.operatives[scorpion]!.wounds = 40;
    const before = state.operatives[foe]!.wounds;
    let s = activate(ctx, state, scorpion);
    s = act(ctx, s, scorpion, 'Fight', { targetId: foe }).state;
    expect(s.operatives[foe]!.wounds).toBeLessThanOrEqual(before - 2);
    expect(s.log.some((e) => e.text.startsWith('Mandiblasters:'))).toBe(true);
    expect(s.log.filter((e) => e.text.startsWith('Mandiblasters:'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('all four are offered as STRATEGIC GAMBITs', () => {
    const { ctx, state } = setup();
    const s = { ...state, phase: 'strategy' as const, strategyStep: 'gambit' as const };
    s.teams.p1.cp = 4;
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).toEqual([
      SP.danceOfDeath,
      SP.forewarned,
      SP.khainesVengeance,
      SP.ruthlessPoise,
    ]);
  });

  it('FOREWARNED — a re-roll of one defence-dice result, only while the friendly operative is READY', () => {
    const { ctx, state } = setup();
    const avenger = state.operatives[opWith(state, 'p1', C.direAvengerWarrior)]!;
    const shooter = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const weapon = ctx.datacards.get(shooter.datacardId)!.weapons.find((w) => w.profiles[0]!.type === 'ranged')!;
    const grants = (s: GameState) =>
      ctx.hooks
        .emit('onDefenceDice', s, {
          state: s,
          ctx: fakeAttack(shooter, avenger, weapon.name, weapon.profiles[0]!),
          count: 3,
          coverSave: false,
          coverSaveAsCrit: false,
          extraCoverSaves: 0,
          mods: zeroStatMods(),
          rerolls: [],
        })
        .rerolls.map((g) => g.id);
    expect(grants(state)).not.toContain('blades-of-khaine.forewarned');
    state.teams.p1.gambitsUsedTP.push(SP.forewarned);
    expect(grants(state)).toContain('blades-of-khaine.forewarned');
    avenger.ready = false;
    expect(grants(state)).not.toContain('blades-of-khaine.forewarned');
    expect(ruleText(SP.forewarned)).toContain('re-roll any of your defence dice results of one result');
  });

  it('RUTHLESS POISE — Ceaseless melee against a READY enemy only, and not while retaliating', () => {
    const { ctx, state } = setup();
    const scorpion = state.operatives[opWith(state, 'p1', C.strikingScorpionWarrior)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const rules = (retaliating: boolean) =>
      effectiveRules(ctx, state, profileOf(C.strikingScorpionWarrior, 'Chainsword'), {
        operative: scorpion,
        target: foe,
        weaponName: 'Chainsword',
        retaliating,
      }).filter((r) => r.raw.includes('RUTHLESS POISE'));
    expect(rules(false)).toEqual([]);
    state.teams.p1.gambitsUsedTP.push(SP.ruthlessPoise);
    expect(rules(false)).toHaveLength(1);
    expect(rules(true)).toEqual([]); // "is fighting", not retaliating
    foe.ready = false;
    expect(rules(false)).toEqual([]);
  });

  it("KHAINE'S VENGEANCE — Ceaseless ranged against an EXPENDED enemy operative", () => {
    const { ctx, state } = setup();
    const avenger = state.operatives[opWith(state, 'p1', C.direAvengerWarrior)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    state.teams.p1.gambitsUsedTP.push(SP.khainesVengeance);
    const rules = () =>
      rangedRules(ctx, state, avenger, 'Shuriken catapult', foe).filter((id) => id === 'Ceaseless');
    expect(rules()).toEqual([]);
    foe.expended = true;
    expect(rules()).toEqual(['Ceaseless']);
  });

  it('DANCE OF DEATH swaps two friendly operatives visible to and within 6" of each other', () => {
    const { ctx, state } = setup();
    const a = opWith(state, 'p1', C.direAvengerExarch);
    const b = opWith(state, 'p1', C.howlingBansheeWarrior);
    isolate(state, [a, b]);
    place(state, a, 6, 11);
    place(state, b, 10, 11);
    const s = { ...state, phase: 'strategy' as const, strategyStep: 'gambit' as const };
    s.teams.p1.cp = 4;
    const out = reduce(
      s,
      { t: 'UseGambit', player: 'p1', gambitId: SP.danceOfDeath, data: { operativeIdA: a, operativeIdB: b } },
      ctx,
    ).state;
    expect(out.operatives[a]!.pos).toEqual({ x: 10, y: 11 });
    expect(out.operatives[b]!.pos).toEqual({ x: 6, y: 11 });
    expect(out.log.some((e) => e.text.startsWith('DANCE OF DEATH:'))).toBe(true);
    expect(ruleText(SP.danceOfDeath)).toContain('swap their positions');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('BLADEWIND — "that operative can perform two Fight actions"', () => {
    const { ctx, state } = setup({ seed: 5 });
    const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [scorpion, foe]);
    place(state, scorpion, 10, 11);
    place(state, foe, 10.9, 11);
    state.operatives[foe]!.wounds = 40;
    state.operatives[scorpion]!.wounds = 40;
    state.teams.p1.cp = 4;
    let s = activate(ctx, state, scorpion);
    const def = getAction(FIGHT_BLADEWIND)!;
    expect(def.available!(ctx, s, s.operatives[scorpion]!)).toBe(false);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.bladewind }, ctx).state;
    expect(def.available!(ctx, s, s.operatives[scorpion]!)).toBe(true);
    s = drive(ctx, act(ctx, s, scorpion, 'Fight', { targetId: foe }).state);
    expect(def.check(ctx, s, s.operatives[scorpion]!, { targetId: foe }).ok).toBe(true);
  });

  it('STARFALL — "that operative can perform two Shoot actions"', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 6, 11);
    place(state, foe, 14, 11);
    state.teams.p1.cp = 4;
    let s = activate(ctx, state, avenger);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.starfall }, ctx).state;
    s = drive(ctx, act(ctx, s, avenger, 'Shoot', { weaponName: 'Shuriken catapult', targetId: foe }).state);
    expect(getAction(SHOOT_STARFALL)!.check(ctx, s, s.operatives[avenger]!, { weaponName: 'Shuriken catapult', targetId: foe }).ok).toBe(true);
  });

  it('FADING LIGHT — the Fall Back action costs 1 less AP during that activation', () => {
    const { ctx, state } = setup();
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [banshee, foe]);
    place(state, banshee, 10, 11);
    place(state, foe, 10.9, 11);
    state.teams.p1.cp = 4;
    let s = activate(ctx, state, banshee);
    expect(actionCost(ctx, s, s.operatives[banshee]!, getAction('Fall Back')!)).toBe(2);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.fadingLight }, ctx).state;
    expect(actionCost(ctx, s, s.operatives[banshee]!, getAction('Fall Back')!)).toBe(1);
  });

  it('CONTEMPT — the opponent cannot re-roll their attack dice for the rest of that shooting sequence', () => {
    const { ctx, state } = setup();
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const shooter = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, shooter]);
    place(state, avenger, 14, 11);
    place(state, shooter, 6, 11);
    state.teams.p2.cp = 4;
    state.teams.p1.cp = 4;
    const gunner = state.operatives[shooter]!;
    const weapon = ctx.datacards.get(gunner.datacardId)!.weapons.find((w) => w.profiles[0]!.type === 'ranged')!;
    expect(startShoot(ctx, state, gunner, weapon.name, weapon.profiles[0]!.name, avenger).ok).toBe(true);
    const grants = (s: GameState) =>
      ctx.hooks
        .emit('onRollAttack', s, {
          state: s,
          ctx: fakeAttack(gunner, s.operatives[avenger]!, weapon.name, weapon.profiles[0]!),
          dice: [],
          rerolls: [{ id: 'commandReroll:attack', label: 'Command Re-roll', mode: 'one', max: 1, cp: 1, player: 'p2' }],
        })
        .rerolls.map((g) => g.id);
    expect(grants(state)).toContain('commandReroll:attack');
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.contempt }, ctx).state;
    expect(grants(s)).toEqual([]);
    // …and it is scoped to that sequence.
    s.sequence = null;
    expect(grants(s)).toContain('commandReroll:attack');
  });

  it('CONTEMPT is only usable while a friendly operative is being shot at or retaliating', () => {
    const { state } = setup();
    const usable = bladesOfKhaine.ploys.find((p) => p.id === FP.contempt)!.usable!;
    expect(usable(state, 'p1').ok).toBe(false);
    expect(usable(state, 'p1').reason).toContain('being shot at or retaliating');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('RUNE OF PROPHECY adds D3 to the initiative roll-off, once per battle, from turning point 2', () => {
    const { ctx, state } = setup({ equipment: [EQ.runeOfProphecy], script: [3, 4, 2] });
    const s = { ...state, phase: 'strategy' as const, strategyStep: 'initiative' as const, turningPoint: 2 };
    const first = rollInitiative(ctx, s);
    // script: D3 from a 3 → +2, then the two D6 (4 and 2).
    expect(s.log.some((e) => e.text === 'RUNE OF PROPHECY: +2 to the initiative roll-off')).toBe(true);
    expect(first).toMatchObject({ p1: 6, p2: 2, winner: 'p1' });
    const logs = s.log.filter((e) => e.text.startsWith('RUNE OF PROPHECY:')).length;
    rollInitiative(ctx, s);
    expect(s.log.filter((e) => e.text.startsWith('RUNE OF PROPHECY:')).length).toBe(logs); // once per battle
    expect(ruleText(EQ.runeOfProphecy)).toContain('Once per battle, after rolling off to decide initiative');
  });

  it('RUNE OF SHIELDING ignores one attack dice worth of Normal Dmg — spent on a killing blow', () => {
    const { ctx, state } = setup({ equipment: [EQ.runeOfShielding] });
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const shooter = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, shooter]);
    place(state, avenger, 14, 11);
    place(state, shooter, 6, 11);
    const gunner = state.operatives[shooter]!;
    const weapon = ctx.datacards.get(gunner.datacardId)!.weapons.find((w) => w.profiles[0]!.type === 'ranged')!;
    expect(startShoot(ctx, state, gunner, weapon.name, weapon.profiles[0]!.name, avenger).ok).toBe(true);
    const seq = state.sequence as ShootSequence;
    addRolled(seq.attack, [6, 6], 3); // two unblocked successes, at least one normal after obscure/retention
    seq.attack.dice[0]!.state = 'normal';
    seq.attack.dice[1]!.state = 'normal';
    const dmgN = weapon.profiles[0]!.dmgN;
    state.operatives[avenger]!.wounds = dmgN * 2;
    const ev = ctx.hooks.emit('onDamage', state, {
      state,
      ctx: null,
      target: state.operatives[avenger]!,
      amount: dmgN * 2,
      kind: 'attack',
    });
    expect(ev.amount).toBe(dmgN);
    expect(state.log.some((e) => e.text.startsWith('RUNE OF SHIELDING:'))).toBe(true);
    // "Once per battle" — the second killing blow is not saved.
    const again = ctx.hooks.emit('onDamage', state, {
      state,
      ctx: null,
      target: state.operatives[avenger]!,
      amount: dmgN * 2,
      kind: 'attack',
    });
    expect(again.amount).toBe(dmgN * 2);
    expect(ruleText(EQ.runeOfShielding)).toContain('Once per battle');
  });

  it('RUNE OF FORESIGHT rolls a D3 when it is revealed and pays 1CP in that turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.runeOfForesight], script: [5] }); // D3 = 3
    expect(state.log.some((e) => e.text === 'RUNE OF FORESIGHT: +1CP in turning point 3')).toBe(true);
    const s = { ...state, turningPoint: 3, initiative: 'p1' as const };
    const before = s.teams.p1.cp;
    readyStep(ctx, s);
    expect(s.teams.p1.cp).toBe(before + 2); // 1CP for the Ready step + 1 from the rune
    const later = { ...state, turningPoint: 4, initiative: 'p1' as const };
    const cp = later.teams.p1.cp;
    readyStep(ctx, later);
    expect(later.teams.p1.cp).toBe(cp + 1);
  });

  it('WRAITHBONE TALISMAN discards a fail for a normal success when SHOOTING, once per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 6, 11);
    place(state, foe, 14, 11);
    const shooter = state.operatives[avenger]!;
    expect(startShoot(ctx, state, shooter, 'Shuriken catapult', undefined, foe).ok).toBe(true);
    const seq = state.sequence as ShootSequence;
    seq.step = 'retention';
    addRolled(seq.attack, [1, 2, 5], 3);
    effectiveRules(ctx, state, profileOf(C.direAvengerWarrior, 'Shuriken catapult'), {
      operative: shooter,
      weaponName: 'Shuriken catapult',
    });
    expect(seq.attack.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'normal']);
    // Once per turning point: a second sequence gets nothing.
    const pool: DicePool = { dice: [], nextId: 1 };
    addRolled(pool, [1, 2], 3);
    seq.attack = pool;
    effectiveRules(ctx, state, profileOf(C.direAvengerWarrior, 'Shuriken catapult'), {
      operative: shooter,
      weaponName: 'Shuriken catapult',
    });
    expect(pool.dice.map((d) => d.state)).toEqual(['fail', 'fail']);
  });

  it('WRAITHBONE TALISMAN also fires when FIGHTING and when RETALIATING — both sequences read onWeaponRules', () => {
    for (const retaliating of [false, true]) {
      const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
      const scorpion = opWith(state, 'p1', C.strikingScorpionWarrior);
      const foe = state.teams.p2.operativeIds[0]!;
      isolate(state, [scorpion, foe]);
      place(state, scorpion, 10, 11);
      place(state, foe, 10.9, 11);
      const me = state.operatives[scorpion]!;
      const them = state.operatives[foe]!;
      const attacker = retaliating ? them : me;
      const defender = retaliating ? me : them;
      expect(startFight(ctx, state, attacker, meleeName(ctx, state, attacker), undefined, defender.id).ok).toBe(true);
      const seq = state.sequence as FightSequence;
      seq.step = 'retention';
      const pool = retaliating ? seq.defenderPool : seq.attackerPool;
      addRolled(pool, [1, 2, 5], 3);
      sideWeapon(ctx, state, seq, retaliating ? 'defender' : 'attacker');
      expect(pool.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'normal']);
    }
  });

  it('WRAITHBONE TALISMAN does not fire outside the Retention step', () => {
    const { ctx, state } = setup({ equipment: [EQ.wraithboneTalisman] });
    const avenger = opWith(state, 'p1', C.direAvengerWarrior);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [avenger, foe]);
    place(state, avenger, 6, 11);
    place(state, foe, 14, 11);
    const shooter = state.operatives[avenger]!;
    startShoot(ctx, state, shooter, 'Shuriken catapult', undefined, foe);
    const seq = state.sequence as ShootSequence;
    seq.step = 'rollAttack';
    addRolled(seq.attack, [1, 2], 3);
    effectiveRules(ctx, state, profileOf(C.direAvengerWarrior, 'Shuriken catapult'), {
      operative: shooter,
      weaponName: 'Shuriken catapult',
    });
    expect(seq.attack.dice.map((d) => d.state)).toEqual(['fail', 'fail']);
  });
});

// ---------------------------------------------------------------------------
describe('AI hints and action surface', () => {
  it('names a role for every datacard and a value for all 8 ploys and all 4 equipment options', () => {
    const hints = bladesOfKhaine.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(bladesOfKhaine.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });

  it('every ASPECT TECHNIQUE ActionDef is gated to its own Aspect, so no other kill team can see them', () => {
    const { ctx, state } = setup();
    const kasrkinOp = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const ids = [
      SHOOT_SLICING,
      SHOOT_THOUSAND,
      SHOOT_VIGILANCE,
      SHOOT_SCORPIONS_EYE,
      SHOOT_SHRIEK,
      FIGHT_MERCILESS,
      REPOSITION_PATIENT_STALK,
      CHARGE_WOE,
      DASH_STRIKE_AND_FADE,
      DECLARE_RAGING_HEAT,
      DECLARE_ONE_WITH_THE_GLOOM,
    ];
    for (const id of ids) expect(getAction(id)!.available!(ctx, state, kasrkinOp)).toBe(false);
    const banshee = state.operatives[opWith(state, 'p1', C.howlingBansheeWarrior)]!;
    expect(getAction(SHOOT_SHRIEK)!.available!(ctx, state, banshee)).toBe(true);
    expect(getAction(SHOOT_VIGILANCE)!.available!(ctx, state, banshee)).toBe(false);
  });

  it('a plain activation offers no 0AP technique action to an operative of the wrong Aspect', () => {
    const { ctx, state } = setup();
    const banshee = opWith(state, 'p1', C.howlingBansheeWarrior);
    const s = activate(ctx, state, banshee);
    const offered = availableActions(ctx, s, s.operatives[banshee]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(offered).not.toContain(DECLARE_RAGING_HEAT);
    expect(offered).not.toContain(DECLARE_ONE_WITH_THE_GLOOM);
  });
});

// ---------------------------------------------------------------------------

function fakeAttack(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules: profile.rules,
    type: profile.type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 6,
  };
}

function meleeName(ctx: GameContext, state: GameState, op: OperativeState): string {
  return weaponsOf(ctx, state, op, 'melee')[0]!.name;
}
