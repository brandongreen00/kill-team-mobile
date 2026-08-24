/**
 * GELLERPOX INFECTED. Every test quotes the printed rule it pins, read out of
 * `data/teams/gellerpox-infected.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/gellerpox-infected/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction, registerAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  inflictDamage,
  markerController,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/gellerpox-infected.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  CARD,
  CHARGE_BARGE,
  CURSE,
  CURSES,
  CURSE_DEFAULT,
  CURSE_NAME,
  ENGINEERED_DEFAULT,
  ENGINEERED_OPTIONS,
  EQ,
  FIGHT_ONSLAUGHT,
  FIGHT_SWIPE,
  FP,
  GIFT_CLAUSE,
  GROUP_ACTIVATION,
  KW,
  MUTOID_VERMIN_COUNT,
  PARTIAL,
  REMINDER_ONLY,
  REPOSITION_BARGE,
  RULE,
  SP,
  SPREAD_GAMBIT,
  SWIPE_PROFILE,
  SWIPE_WEAPON,
  VERMIN_CHARGE,
  VERMIN_DASH,
  VERMIN_REPOSITION,
  VERMIN_ROWS,
  affectedBy,
  curseVerdict,
  drawnToTheHumEndLegal,
  engineeredOf,
  gellerpoxInfected,
  humMarkerId,
  setEngineered,
  setTechnoCurse,
  spreadTargets,
  swipeLedger,
  technoCurseOf,
} from '../../src/teams/gellerpox-infected/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, chargeTo, mapById, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('gellerpox-infected');

/**
 * A stand-in for another team's unique action. `available` is false, so `availableActions`,
 * `src/ai/legal.ts` and the soak below never see it; only a direct `canPerformAction` emit does.
 */
const PROBE_UNIQUE = 'Probe (another team’s unique action)';
registerAction({
  id: PROBE_UNIQUE,
  name: PROBE_UNIQUE,
  ap: 1,
  type: 'unique',
  sourceText: 'test probe',
  available: () => false,
  check: () => ({ ok: false, reason: 'test probe' }),
  perform: () => ({ ok: false, reason: 'test probe' }),
});
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const card = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = card(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

/** Both sides are Gellerpox Infected, so every rule can be tested from either seat. */
function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([gellerpoxInfected], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = defaultRoster(DATA);
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: gellerpoxInfected, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: gellerpoxInfected, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  over: Partial<AttackContext> = {},
): AttackContext {
  return {
    attacker,
    defender,
    weaponName: 'w',
    profile,
    rules: [...profile.rules],
    type: profile.type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 3,
    ...over,
  };
}

/** A fight sequence parked at a chosen step, so a retention-seam rule can be pinned. */
function fightAt(
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  spec: {
    step: FightSequence['step'];
    attackerWeapon: string;
    attackerProfile?: string;
    defenderWeapon?: string;
    defenderProfile?: string;
    attackerDice?: number[];
    defenderDice?: number[];
    attackerHit?: number;
    defenderHit?: number;
    defenderCanRetaliate?: boolean;
  },
): FightSequence {
  const seq: FightSequence = {
    kind: 'fight',
    step: spec.step,
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerWeapon: spec.attackerWeapon,
    ...(spec.attackerProfile ? { attackerProfile: spec.attackerProfile } : {}),
    ...(spec.defenderWeapon ? { defenderWeapon: spec.defenderWeapon } : {}),
    ...(spec.defenderProfile ? { defenderProfile: spec.defenderProfile } : {}),
    defenderCanRetaliate: spec.defenderCanRetaliate ?? true,
    attackerPool: pool(spec.attackerDice ?? [], spec.attackerHit ?? 4),
    defenderPool: pool(spec.defenderDice ?? [], spec.defenderHit ?? 4),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: attacker.player,
    defender: defender.player,
    free: false,
    hatchway: false,
  };
  state.sequence = seq;
  return seq;
}

function shootAt(
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  spec: { step: ShootSequence['step']; weaponName: string; profileName?: string; attack?: number[]; hit?: number; defence?: number[]; save?: number },
): ShootSequence {
  const seq: ShootSequence = {
    kind: 'shoot',
    step: spec.step,
    attackerId: attacker.id,
    targetId: target.id,
    queue: [],
    resolvedTargets: [],
    weaponName: spec.weaponName,
    ...(spec.profileName ? { profileName: spec.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: pool(spec.attack ?? [], spec.hit ?? 4),
    defence: pool(spec.defence ?? [], spec.save ?? 5),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: false,
  };
  state.sequence = seq;
  return seq;
}

// ---------------------------------------------------------------------------
describe('data is pinned to the committed JSON', () => {
  it('has nine datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards.map((c) => c.id).sort()).toEqual(
      [
        CARD.bloatspawn,
        CARD.cursemite,
        CARD.eyestinger,
        CARD.fleshscreamer,
        CARD.glitchling,
        CARD.lumberghast,
        CARD.mutant,
        CARD.sludgeGrub,
        CARD.vulgrar,
      ].sort(),
    );
    const stat = (id: string) => {
      const c = card(id);
      return { apl: c.apl, move: c.move, save: c.save, wounds: c.wounds, mm: c.base.mm };
    };
    expect(stat(CARD.vulgrar)).toEqual({ apl: 2, move: 5, save: 5, wounds: 21, mm: 40 });
    expect(stat(CARD.bloatspawn)).toEqual({ apl: 2, move: 5, save: 5, wounds: 20, mm: 40 });
    expect(stat(CARD.fleshscreamer)).toEqual({ apl: 2, move: 5, save: 5, wounds: 20, mm: 40 });
    expect(stat(CARD.lumberghast)).toEqual({ apl: 2, move: 5, save: 5, wounds: 20, mm: 40 });
    expect(stat(CARD.mutant)).toEqual({ apl: 2, move: 5, save: 5, wounds: 7, mm: 25 });
    expect(stat(CARD.glitchling)).toEqual({ apl: 2, move: 6, save: 6, wounds: 3, mm: 25 });
    expect(stat(CARD.cursemite)).toEqual({ apl: 2, move: 6, save: 6, wounds: 2, mm: 25 });
    expect(stat(CARD.eyestinger)).toEqual({ apl: 2, move: 6, save: 6, wounds: 2, mm: 25 });
    expect(stat(CARD.sludgeGrub)).toEqual({ apl: 2, move: 4, save: 6, wounds: 2, mm: 25 });
  });

  it('keywords carry the three that every faction rule reads', () => {
    expect(card(CARD.vulgrar).keywords).toEqual(['GELLERPOX INFECTED', 'CHAOS', 'NIGHTMARE HULK', 'LEADER', 'VULGRAR THRICE-CURSED']);
    for (const id of [CARD.bloatspawn, CARD.fleshscreamer, CARD.lumberghast])
      expect(card(id).keywords).toContain('NIGHTMARE HULK');
    expect(card(CARD.mutant).keywords).toContain('MUTANT');
    expect(card(CARD.glitchling).keywords).toContain('GLITCHLING');
    expect(card(CARD.glitchling).keywords).not.toContain('MUTOID VERMIN'); // the GLITCHLING is an aura carrier
    for (const id of [CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub])
      expect(card(id).keywords).toContain('MUTOID VERMIN');
  });

  it('pins the weapon profiles every rule in this module reads', () => {
    expect(profileOf(CARD.vulgrar, 'Pyregut', 'standard')).toMatchObject({ atk: 5, hit: 2, dmgN: 3, dmgC: 3 });
    expect(profileOf(CARD.vulgrar, 'Pyregut', 'deluge').rules.map((r) => r.id)).toEqual(['Range', 'Saturate', 'SeekLight']);
    expect(profileOf(CARD.vulgrar, 'Fleshmelded weapons')).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.vulgrar, 'Fleshmelded weapons').rules.map((r) => r.id)).toEqual(['Engineered']);
    expect(profileOf(CARD.bloatspawn, SWIPE_WEAPON, SWIPE_PROFILE)).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.bloatspawn, SWIPE_WEAPON, SWIPE_PROFILE).rules.map((r) => r.id)).toEqual(['Swipe']);
    expect(profileOf(CARD.bloatspawn, SWIPE_WEAPON, 'slashing')).toMatchObject({ atk: 6, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.fleshscreamer, 'Mutant fist and cleaver', 'lopping blow')).toMatchObject({ atk: 1, hit: 3, dmgN: 8, dmgC: 9 });
    expect(profileOf(CARD.lumberghast, 'Mutant claw')).toMatchObject({ atk: 4, dmgN: 6, dmgC: 7 });
    expect(profileOf(CARD.mutant, 'Heavy axe')).toMatchObject({ atk: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.cursemite, 'Bloodsucking proboscis').rules.map((r) => r.id)).toEqual(['Rending', 'Feast']);
    expect(profileOf(CARD.sludgeGrub, 'Acid spit').rules.map((r) => r.id)).toEqual(['Range', 'Devastating', 'Piercing']);
  });

  it('prints four faction rules, four strategy ploys, four firefight ploys, four equipment and no unique actions', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([
      RULE.technoCurse,
      RULE.mutoidVermin,
      RULE.nightmareHulks,
      RULE.revoltinglyResilient,
    ]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual(Object.values(SP));
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual(Object.values(FP));
    expect(DATA.equipment.map((e) => e.id)).toEqual(Object.values(EQ));
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toEqual([]);
    expect(DATA.datacards.flatMap((c) => c.abilities).length).toBe(16);
  });

  it('every printed ploy costs 1CP and no ploy name or id carries a glued-on "1CP"', () => {
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect(p.cp).toBe(1);
      expect(p.name).not.toMatch(/1CP/);
      expect(p.id).not.toMatch(/1cp/);
    }
  });

  it('the section overrun is trimmed out of the last strategy and firefight ploy', () => {
    // The scraper appends the whole following section to the LAST item of each section on all
    // 48 teams; `trimTrailingSection` cuts it at the heading (docs/TEAM-STATUS.md).
    expect(ruleText(SP.rustEmanations)).not.toMatch(/Firefight Ploys/);
    expect(ruleText(FP.frighteningOnslaught)).not.toMatch(/Faction Equipment/);
    expect(ruleText(SP.rustEmanations)).toBe(
      'Whenever a friendly GELLERPOX INFECTED NIGHTMARE HULK operative is fighting, your opponent cannot retain results of 3 as successes.',
    );
  });

  it('records the scraper note that the MUTANT selection entry had no datacard link', () => {
    expect(NOTES).toEqual(["selection entry 'MUTANT' has no datacard link on the page; matched by name to Mutant"]);
    // The name match did land: both MUTANT rows resolve to the Mutant datacard.
    const mutantRows = DATA.selection.list.filter((e) => e.role === 'MUTANT');
    expect(mutantRows.length).toBe(2);
    expect(mutantRows.every((e) => e.datacardId === CARD.mutant)).toBe(true);
    expect(mutantRows.map((e) => e.fixedWeapons)).toEqual([
      ['Frag grenade', 'Heavy axe'],
      ['Frag grenade', 'Improvised weapon'],
    ]);
  });

  it('markerGuide is empty although Spread the Glorious Gifts places a printed Techno-curse token', () => {
    expect(DATA.markerGuide ?? '').toBe('');
    expect(abilityText(CARD.vulgrar, AB.spreadTheGifts)).toMatch(/Techno-curse tokens/);
  });
});

// ---------------------------------------------------------------------------
describe('selection', () => {
  it('the printed group is a FIXED roster (D-034) and defaultRoster fields it exactly', () => {
    expect(DATA.selection.groups[0]!.kind).toBe('every');
    const picks = defaultRoster(DATA);
    const counts: Record<string, number> = {};
    for (const p of picks) counts[p.datacardId] = (counts[p.datacardId] ?? 0) + 1;
    expect(counts).toEqual({
      [CARD.vulgrar]: 1,
      [CARD.bloatspawn]: 1,
      [CARD.fleshscreamer]: 1,
      [CARD.lumberghast]: 1,
      [CARD.glitchling]: 4,
      [CARD.mutant]: 3,
      [CARD.cursemite]: 1,
    });
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
  });

  it('an `every` group rejects a roster that changes a printed count (D-034)', () => {
    const picks = defaultRoster(DATA);
    // "4 GLITCHLING" — three of them is not the printed roster.
    const oneShort = picks.filter((p, i) => p.datacardId !== CARD.glitchling || i !== picks.findIndex((q) => q.datacardId === CARD.glitchling));
    const short = validateRosterFor(DATA, oneShort);
    expect(short.ok).toBe(false);
    expect(short.errors.some((e) => /GLITCHLING/.test(String(e)))).toBe(true);
    // …and neither is a fifth.
    const oneOver = [...picks, picks.find((p) => p.datacardId === CARD.glitchling)!];
    expect(validateRosterFor(DATA, oneOver).ok).toBe(false);
  });

  it('defaultRoster never fields the EYESTINGER SWARM or the SLUDGE-GRUB (D-042)', () => {
    const fielded = new Set(defaultRoster(DATA).map((p) => p.datacardId));
    expect(fielded.has(CARD.eyestinger)).toBe(false);
    expect(fielded.has(CARD.sludgeGrub)).toBe(false);
  });

  it('the one printed constraint is a `custom` gate on the MUTOID VERMIN equipment, and it is unenforced', () => {
    expect(DATA.selection.constraints).toEqual([
      {
        kind: 'custom',
        text: 'If you selected the MUTOID VERMIN faction equipment:',
        hook: 'gellerpox-infected.if-you-selected-the-mutoid-vermin',
      },
    ]);
    // Unenforced by definition: `defaultRoster` picks a CURSEMITE without selecting the
    // equipment that gates its group, and `validateRosterFor` calls that legal.
    const picks = defaultRoster(DATA);
    expect(picks.some((p) => p.datacardId === CARD.cursemite)).toBe(true);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
  });

  it('DATA PROBLEM: the equipment-gated MUTOID VERMIN group is scraped with count 1, not the printed four', () => {
    const group = DATA.selection.groups.find((g) => g.index === 2)!;
    expect(group.count).toBe(1);
    expect(ruleText(EQ.mutoidVermin)).toMatch(/add four GELLERPOX INFECTED MUTOID VERMIN operatives/);
    expect(DATA.selection.totalOperatives).toBe(12); // the printed kill team is 11 + 4 = 15
    expect(VERMIN_ROWS).toEqual([CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub]);
  });
});

// ---------------------------------------------------------------------------
describe('Techno-Curse (faction rule)', () => {
  it('slices the three printed curses, each with its Infection Range and Symptom', () => {
    expect(CURSES).toEqual(['barrelwarp', 'rustspikes', 'vox-static']);
    const whole = ruleText(RULE.technoCurse);
    for (const curse of CURSES) {
      expect(whole).toContain(CURSE[curse].infectionRange);
      expect(whole).toContain(CURSE[curse].symptom);
      expect(CURSE[curse].text).toContain(CURSE[curse].symptom);
      // The flavour paragraph is dropped, the rule text is not.
      expect(CURSE[curse].text.startsWith('Infection Range:')).toBe(true);
    }
    expect(CURSE.barrelwarp.symptom).toBe(
      'Symptom: Subtract 1 from the Atk stat of that enemy operative’s ranged weapons.',
    );
    expect(CURSE.rustspikes.infectionRange).toBe(
      'Infection Range: Within control range of a friendly GELLERPOX INFECTED operative (excluding MUTOID VERMIN).',
    );
    expect(CURSE['vox-static'].symptom).toBe(
      'Symptom: That enemy operative’s APL stat cannot be added to (remove all positive APL stat changes it has).',
    );
  });

  it('the mandatory choice is taken deterministically and logged when nobody made one (D-016)', () => {
    const { ctx, state } = setup();
    expect(technoCurseOf(state, 'p1')).toBeUndefined();
    const after = activate(ctx, state, opWith(state, 'p1', CARD.vulgrar));
    expect(technoCurseOf(after, 'p1')).toBe(CURSE_DEFAULT);
    expect(after.log.some((l) => l.text === `TECHNO-CURSE: ${CURSE_NAME[CURSE_DEFAULT]}`)).toBe(true);
  });

  it('setTechnoCurse is a pure setter the UI owns and it wins over the default (D-017)', () => {
    const { ctx, state } = setup();
    setTechnoCurse(state, 'p1', 'vox-static');
    const after = activate(ctx, state, opWith(state, 'p1', CARD.vulgrar));
    expect(technoCurseOf(after, 'p1')).toBe('vox-static');
  });

  it('Barrelwarp subtracts 1 from the Atk stat of an enemy ranged weapon within 2" of a carrier', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    setTechnoCurse(state, 'p1', 'barrelwarp');
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 12, 10); // base gap ≈ 2 − radii; well inside 2"
    const profile = profileOf(CARD.vulgrar, 'Pyregut', 'standard');
    const collect = () =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(foe, hulk, profile),
        count: profile.atk,
        mods: zeroStatMods(),
      }).mods.atk;
    expect(collect()).toBe(-1);
    place(state, foe.id, 20, 10); // out of range
    expect(collect()).toBe(0);
  });

  it('Barrelwarp reaches 3" from a GLITCHLING and never from a MUTOID VERMIN', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const grub = state.operatives[opWith(state, 'p1', CARD.sludgeGrub)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [glitch.id, grub.id, foe.id]);
    setTechnoCurse(state, 'p1', 'barrelwarp');
    const T = hooksFor(ctx, 'p1');
    place(state, foe.id, 10, 10);
    place(state, glitch.id, 13.6, 10); // ~2.3" base gap: inside the GLITCHLING's 3", outside 2"
    place(state, grub.id, 30, 30);
    expect(T.gap(glitch, foe)).toBeGreaterThan(2);
    expect(affectedBy(T, state, foe, 'barrelwarp')).toBe(true);
    // A MUTOID VERMIN is explicitly excluded from the aura.
    place(state, glitch.id, 30, 20);
    place(state, grub.id, 10.8, 10);
    expect(T.gap(grub, foe)).toBeLessThan(1);
    expect(affectedBy(T, state, foe, 'barrelwarp')).toBe(false);
  });

  it('Screaming Rustspikes inflicts 1 damage when a fighting enemy discards a fail', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [hulk.id, foe.id]);
    setTechnoCurse(state, 'p1', 'rustspikes');
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 11.3, 10); // within control range
    const before = foe.wounds;
    const profile = profileOf(CARD.bloatspawn, SWIPE_WEAPON, 'slashing');
    fightAt(state, foe, hulk, {
      step: 'retention',
      attackerWeapon: SWIPE_WEAPON,
      attackerProfile: 'slashing',
      defenderWeapon: 'Mutant claw',
      attackerDice: [2, 5, 5, 5, 5, 5],
      attackerHit: 4,
    });
    effectiveRules(ctx, state, profile, { operative: foe, target: hulk, weaponName: SWIPE_WEAPON });
    expect(foe.wounds).toBe(before - 1);
    // Once per fight, however many times the retention step re-emits.
    effectiveRules(ctx, state, profile, { operative: foe, target: hulk, weaponName: SWIPE_WEAPON });
    expect(foe.wounds).toBe(before - 1);
  });

  it('Screaming Rustspikes does nothing when the enemy discards no fails', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [hulk.id, foe.id]);
    setTechnoCurse(state, 'p1', 'rustspikes');
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 11.3, 10);
    const before = foe.wounds;
    const profile = profileOf(CARD.bloatspawn, SWIPE_WEAPON, 'slashing');
    fightAt(state, foe, hulk, {
      step: 'retention',
      attackerWeapon: SWIPE_WEAPON,
      attackerProfile: 'slashing',
      attackerDice: [4, 5, 6],
      attackerHit: 4,
    });
    effectiveRules(ctx, state, profile, { operative: foe, target: hulk, weaponName: SWIPE_WEAPON });
    expect(foe.wounds).toBe(before);
  });

  it('Viral Vox-static removes every positive APL change an affected enemy has', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    setTechnoCurse(state, 'p1', 'vox-static');
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 30, 10);
    foe.aplMods.push(1);
    expect(aplOf(ctx, state, foe)).toBe(3); // out of range: the +1 stands
    place(state, foe.id, 12.5, 10); // ~2.5" gap — inside Viral Vox-static's 3"
    expect(aplOf(ctx, state, foe)).toBe(2);
    // A NEGATIVE change is untouched: only positive changes are removed.
    foe.aplMods.length = 0;
    foe.aplMods.push(-1);
    expect(aplOf(ctx, state, foe)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Mutoid Vermin (faction rule)', () => {
  it('a MUTOID VERMIN can only Charge, Dash, Fall Back, Fight, Reposition and Shoot', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const allowed = new Set(['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot']);
    for (const entry of availableActions(ctx, state, grub)) {
      const key = entry.def.treatedAs ?? entry.def.id;
      if (allowed.has(key) && entry.def.id !== 'Guard') continue;
      expect({ id: entry.def.id, ok: entry.ok, reason: entry.reason }).toMatchObject({ ok: false });
    }
    // Guard carries `treatedAs: 'Shoot'` but is not on the printed list.
    const guard = ctx.hooks.emit('canPerformAction', state, { state, operative: grub, action: 'Guard', allowed: true });
    expect(guard.allowed).toBe(false);
  });

  it('a MUTOID VERMIN performs the Fall Back action for 1 less AP', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    expect(actionCost(ctx, state, grub, getAction('Fall Back')!)).toBe(1);
    expect(actionCost(ctx, state, hulk, getAction('Fall Back')!)).toBe(2);
  });

  it('a MUTOID VERMIN cannot contest a marker', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    isolate(state, [grub.id, foe.id]);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 10, y: 10 }, z: 0, flags: {} };
    place(state, grub.id, 10.6, 10);
    place(state, foe.id, 30, 30);
    expect(markerController(ctx, state, state.markers['obj']!)).toBeNull(); // 0 vs 0, not 2 vs 0
    place(state, foe.id, 9.4, 10);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p2');
  });

  it('an enemy engaged ONLY by MUTOID VERMIN gets the three printed move actions back (D-021)', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    isolate(state, [grub.id, hulk.id, foe.id]);
    place(state, foe.id, 10, 10);
    place(state, hulk.id, 30, 30);
    place(state, grub.id, 10.9, 10); // only the grub is engaging
    for (const id of [VERMIN_REPOSITION, VERMIN_DASH, VERMIN_CHARGE]) {
      const def = getAction(id)!;
      expect(def.available!(ctx, state, foe)).toBe(true);
      expect(def.treatedAs).toBe(id.split(' ')[0] === 'Fall' ? 'Fall Back' : id.split(' ')[0]);
    }
    // A NIGHTMARE HULK in control range takes the permission away again.
    place(state, hulk.id, 9, 10);
    for (const id of [VERMIN_REPOSITION, VERMIN_DASH, VERMIN_CHARGE])
      expect(getAction(id)!.available!(ctx, state, foe)).toBe(false);
  });

  it('the four MUTOID VERMIN the equipment adds are NOT counted into the starting number of operatives', () => {
    const { state } = setup({ equipment: [EQ.mutoidVermin] });
    expect(ruleText(RULE.mutoidVermin)).toMatch(/when determining your starting number of operatives/);
    expect(state.teams.p1.startingSize).toBe(12);
    expect(state.teams.p1.operativeIds.length).toBe(15);
  });
});

// ---------------------------------------------------------------------------
describe('Nightmare Hulks (faction rule)', () => {
  it('a NIGHTMARE HULK cannot use Light terrain for cover when a target is selected', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const flag = (target: OperativeState) =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target,
        valid: true,
        ignoreCoverTerrain: 'none' as const,
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).ignoreCoverTerrain;
    expect(flag(hulk)).toBe('light');
    expect(flag(mutant)).toBe('none'); // only NIGHTMARE HULKs
  });

  it('"it doesn’t remove their cover save (if any)" — the Light cover save is handed back', () => {
    const light = heavyBlock('lightA', 14, 9, 1, 4, 1);
    light.parts[0]!.types = ['Light'];
    const { ctx, state } = setup({ map: testMap({ features: [light] }) });
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    place(state, hulk.id, 12.8, 11);
    place(state, foe.id, 22, 11);
    shootAt(state, foe, hulk, { step: 'rollDefence', weaponName: 'Pyregut', profileName: 'standard' });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, hulk, profileOf(CARD.vulgrar, 'Pyregut', 'standard'), { rules: [], distance: 8 }),
      count: 3,
      coverSave: false, // the core denied it, because this rule lifted Light terrain
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
  });

  it('a NIGHTMARE HULK cannot perform unique actions, but this module’s own carve-outs still work', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const ban = (op: OperativeState, action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    // Another team's `type: 'unique'` action is refused. `available` is false, so this probe is
    // invisible to `availableActions`, the AI and the soak below — only the hook sees it.
    expect(ban(hulk, PROBE_UNIQUE)).toBe(false);
    expect(ban(hulk, 'Reposition')).toBe(true);
    // …but this module's own D-021 carve-outs are the universal action wearing another id.
    expect(ban(hulk, FIGHT_ONSLAUGHT)).toBe(true);
    expect(ban(hulk, REPOSITION_BARGE)).toBe(true);
    expect(ban(hulk, CHARGE_BARGE)).toBe(true);
    for (const id of FIGHT_SWIPE) expect(ban(hulk, id)).toBe(true);
  });

  it('Small stops a GLITCHLING performing unique actions, and exempts the same carve-outs', () => {
    const { ctx, state } = setup();
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const ban = (action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: glitch, action, allowed: true }).allowed;
    expect(abilityText(CARD.glitchling, AB.small)).toContain('or perform unique actions');
    expect(ban(PROBE_UNIQUE)).toBe(false);
    expect(ban(VERMIN_REPOSITION)).toBe(true); // the printed permission is not a unique action
    expect(ban('Shoot')).toBe(true);
  });

  it('1 additional AP for Pick Up Marker and mission actions, excluding Operate Hatch and VULGRAR', () => {
    expect(ruleText(RULE.nightmareHulks)).toContain('excluding Operate Hatch');
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const cost = (op: OperativeState, action: string, ap = 1): number =>
      ctx.hooks.emit('onActionCost', state, { state, operative: op, action, ap }).ap;
    expect(cost(hulk, 'Pick Up Marker')).toBe(2);
    expect(cost(hulk, 'Operate Hatch')).toBe(1);
    expect(cost(vulgrar, 'Pick Up Marker')).toBe(1); // "excluding VULGRAR THRICE-CURSED"
    expect(cost(mutant, 'Pick Up Marker')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Revoltingly Resilient (faction rule)', () => {
  it('subtracts 1 from a fight strike of 3+ on a 4+, and nothing on a 3 or less', () => {
    const hulk4 = setup({ script: [4] }); // the D6 the rule rolls
    const target = hulk4.state.operatives[opWith(hulk4.state, 'p1', CARD.lumberghast)]!;
    const foe = hulk4.state.operatives[opWith(hulk4.state, 'p2', CARD.vulgrar)]!;
    fightAt(hulk4.state, foe, target, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const before = target.wounds;
    inflictDamage(hulk4.ctx, hulk4.state, target, 4, 'attack');
    expect(target.wounds).toBe(before - 3);

    const hulk3 = setup({ script: [3] });
    const t2 = hulk3.state.operatives[opWith(hulk3.state, 'p1', CARD.lumberghast)]!;
    const f2 = hulk3.state.operatives[opWith(hulk3.state, 'p2', CARD.vulgrar)]!;
    fightAt(hulk3.state, f2, t2, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const b2 = t2.wounds;
    inflictDamage(hulk3.ctx, hulk3.state, t2, 4, 'attack');
    expect(t2.wounds).toBe(b2 - 4);
  });

  it('damage of 2 is never rolled for, and an operative that is neither a HULK nor a MUTANT is not covered', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    fightAt(state, foe, hulk, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const rollsBefore = state.rolls.length;
    inflictDamage(ctx, state, hulk, 2, 'attack');
    expect(state.rolls.length).toBe(rollsBefore); // "damage of 3 or more"
    fightAt(state, foe, glitch, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    inflictDamage(ctx, state, glitch, 3, 'attack');
    expect(state.rolls.length).toBe(rollsBefore); // a GLITCHLING is neither
  });

  it('a shoot rolls once per unblocked attack dice, not once for the aggregated total', () => {
    const { ctx, state } = setup({ script: [4, 4, 1] });
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    // Pyregut standard: 3/3 Dmg. Two unblocked normal successes = 6 damage from two dice.
    shootAt(state, foe, mutant, {
      step: 'resolve',
      weaponName: 'Pyregut',
      profileName: 'standard',
      attack: [4, 5],
      hit: 2,
    });
    const before = mutant.wounds;
    inflictDamage(ctx, state, mutant, 6, 'attack');
    expect(state.rolls.filter((r) => r.kind === 'revoltinglyResilient').length).toBe(2);
    expect(mutant.wounds).toBe(before - 4); // 6 − 2 saved
  });
});

// ---------------------------------------------------------------------------
describe('strategy ploys', () => {
  it('PLAGUERIDDEN DETERMINATION offers a defence re-roll for an Engage-order operative, never for vermin', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    state.teams.p1.gambitsUsedTP.push(SP.plagueriddenDetermination);
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const grants = (target: OperativeState) => {
      shootAt(state, foe, target, { step: 'defenceRerolls', weaponName: 'Pyregut', profileName: 'standard' });
      return ctx.hooks
        .emit('onDefenceDice', state, {
          state,
          ctx: attackCtx(foe, target, profileOf(CARD.vulgrar, 'Pyregut', 'standard')),
          count: 0,
          coverSave: false,
          coverSaveAsCrit: false,
          extraCoverSaves: 0,
          mods: zeroStatMods(),
          rerolls: [],
        })
        .rerolls.map((r) => r.id);
    };
    hulk.order = 'engage';
    expect(grants(hulk)).toContain('gellerpox.plagueridden');
    hulk.order = 'conceal';
    expect(grants(hulk)).not.toContain('gellerpox.plagueridden');
    grub.order = 'engage';
    expect(grants(grub)).not.toContain('gellerpox.plagueridden'); // "(excluding MUTOID VERMIN)"
  });

  it('DRAWN TO THE HUM names an objective marker and adds 1" to a Reposition or Charge', () => {
    const { ctx, state } = setup();
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.drawnToTheHum }, ctx);
    expect(out.ok).toBe(true);
    const s = out.state;
    const hulk = s.operatives[opWith(s, 'p1', CARD.lumberghast)]!;
    s.activeOperativeId = hulk.id;
    const markerId = humMarkerId(s, 'p1');
    expect(markerId).toBeDefined();
    const marker = s.markers[markerId!]!;
    place(s, hulk.id, marker.pos.x - 5, marker.pos.y);
    const inches = (action: string) =>
      ctx.hooks.emit('onMoveDistance', s, { state: s, operative: hulk, action, inches: 5 }).inches;
    expect(inches('Reposition')).toBe(6);
    expect(inches('Charge')).toBe(6);
    expect(inches('Dash')).toBe(5); // only the two printed actions
    // Too far to reach the printed end position: the rule is not used.
    place(s, hulk.id, marker.pos.x - 20, marker.pos.y);
    expect(inches('Reposition')).toBe(5);
  });

  it('DRAWN TO THE HUM exports its unenforceable end-position clause as a predicate', () => {
    expect(ruleText(SP.drawnToTheHum)).toContain('it must end that move within 2" of that objective marker');
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.drawnToTheHum }, ctx).state;
    const hulk = s.operatives[opWith(s, 'p1', CARD.lumberghast)]!;
    const marker = s.markers[humMarkerId(s, 'p1')!]!;
    const T = hooksFor(ctx, 'p1');
    expect(drawnToTheHumEndLegal(T, s, hulk, { x: marker.pos.x + 1, y: marker.pos.y })).toBe(true);
    expect(drawnToTheHumEndLegal(T, s, hulk, { x: marker.pos.x + 9, y: marker.pos.y })).toBe(false);
  });

  it('BLESSINGS OF INFECTION: three or more fails — discard one to retain another as a normal success', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.blessingsOfInfection);
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const seq = fightAt(state, hulk, foe, {
      step: 'retention',
      attackerWeapon: 'Mutant claw',
      attackerDice: [1, 2, 3],
      attackerHit: 4,
    });
    effectiveRules(ctx, state, profileOf(CARD.lumberghast, 'Mutant claw'), {
      operative: hulk,
      target: foe,
      weaponName: 'Mutant claw',
    });
    expect(seq.attackerPool.dice.map((d) => d.state)).toEqual(['discarded', 'fail', 'normal']);
  });

  it('BLESSINGS OF INFECTION: three or more successes — a normal success becomes a critical success', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.blessingsOfInfection);
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const seq = fightAt(state, hulk, foe, {
      step: 'retention',
      attackerWeapon: 'Mutant claw',
      attackerDice: [2, 4, 5, 5],
      attackerHit: 4,
    });
    effectiveRules(ctx, state, profileOf(CARD.lumberghast, 'Mutant claw'), {
      operative: hulk,
      target: foe,
      weaponName: 'Mutant claw',
    });
    expect(seq.attackerPool.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'crit', 'normal']);
    // "you can do ONE of the following" — a second emit changes nothing.
    effectiveRules(ctx, state, profileOf(CARD.lumberghast, 'Mutant claw'), {
      operative: hulk,
      target: foe,
      weaponName: 'Mutant claw',
    });
    expect(seq.attackerPool.dice.filter((d) => d.state === 'crit').length).toBe(1);
  });

  it('BLESSINGS OF INFECTION reaches a RETALIATING operative too — the D-031 side-step', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.blessingsOfInfection);
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const seq = fightAt(state, foe, hulk, {
      step: 'retention',
      attackerWeapon: 'Fleshmelded weapons',
      defenderWeapon: 'Mutant claw',
      defenderDice: [1, 2, 3],
      defenderHit: 4,
    });
    effectiveRules(ctx, state, profileOf(CARD.lumberghast, 'Mutant claw'), {
      operative: hulk,
      target: foe,
      weaponName: 'Mutant claw',
      retaliating: true,
    });
    expect(seq.defenderPool.dice.map((d) => d.state)).toEqual(['discarded', 'fail', 'normal']);
  });

  it('RUST EMANATIONS: the opponent cannot retain results of 3 as successes while a HULK is fighting', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.rustEmanations);
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const run = (attacker: OperativeState, weapon: string) => {
      const seq = fightAt(state, attacker, foe, {
        step: 'defenderRerolls',
        attackerWeapon: weapon,
        defenderWeapon: 'Fleshmelded weapons',
        defenderDice: [3, 3, 5],
        defenderHit: 3,
      });
      effectiveRules(ctx, state, profileOf(CARD.vulgrar, 'Fleshmelded weapons'), {
        operative: foe,
        target: attacker,
        weaponName: 'Fleshmelded weapons',
        retaliating: true,
      });
      return seq.defenderPool.dice.map((d) => d.state);
    };
    expect(run(hulk, 'Mutant claw')).toEqual(['fail', 'fail', 'normal']);
    // Only a NIGHTMARE HULK, and only while it is the one FIGHTING.
    expect(run(mutant, 'Heavy axe')).toEqual(['normal', 'normal', 'normal']);
  });
});

// ---------------------------------------------------------------------------
describe('firefight ploys', () => {
  it('REVOLTING TECHNOLOGY gives the enemy shooter the Hot weapon rule for that sequence', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.revoltingTechnology }, ctx).state;
    const profile = profileOf(CARD.vulgrar, 'Pyregut', 'standard');
    shootAt(s, foe, hulk, { step: 'rollAttack', weaponName: 'Pyregut', profileName: 'standard' });
    // Nothing until the shot claims the ploy at Select Weapon.
    expect(effectiveRules(ctx, s, profile, { operative: foe, target: hulk, weaponName: 'Pyregut' }).map((r) => r.id)).not.toContain('Hot');
    ctx.hooks.emit('onSelectWeapon', s, {
      state: s,
      ctx: attackCtx(foe, hulk, profile),
      allowed: true,
      dryRun: false,
    });
    expect(effectiveRules(ctx, s, profile, { operative: foe, target: hulk, weaponName: 'Pyregut' }).map((r) => r.id)).toContain('Hot');
  });

  it('REVOLTING TECHNOLOGY is never claimed by the Shoot action’s dry run (D-032)', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.revoltingTechnology }, ctx).state;
    const profile = profileOf(CARD.vulgrar, 'Pyregut', 'standard');
    ctx.hooks.emit('onSelectWeapon', s, { state: s, ctx: attackCtx(foe, hulk, profile), allowed: true, dryRun: true });
    shootAt(s, foe, hulk, { step: 'rollAttack', weaponName: 'Pyregut', profileName: 'standard' });
    expect(effectiveRules(ctx, s, profile, { operative: foe, target: hulk, weaponName: 'Pyregut' }).map((r) => r.id)).not.toContain('Hot');
  });

  it('PUTRESCENT DEMISE bursts for 1, or D3 for a NIGHTMARE HULK, and never for a MUTOID VERMIN', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin], script: [1, 5] }); // Revoltingly Resilient's D6, then D3 = ceil(5/2) = 3
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [hulk.id, foeA.id, foeB.id]);
    place(state, hulk.id, 10, 10);
    place(state, foeA.id, 11.6, 10); // ≈0.03" gap
    place(state, foeB.id, 25, 10);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.putrescentDemise }, ctx).state;
    const a = s.operatives[foeA.id]!;
    const b = s.operatives[foeB.id]!;
    const beforeA = a.wounds;
    const beforeB = b.wounds;
    inflictDamage(ctx, s, s.operatives[hulk.id]!, 99, 'attack');
    expect(beforeA - a.wounds).toBe(3); // the scripted D3
    expect(b.wounds).toBe(beforeB); // out of the printed 2"
  });

  it('PUTRESCENT DEMISE is usable only while a non-vermin GELLERPOX INFECTED operative is alive', () => {
    const usable = gellerpoxInfected.ploys.find((p) => p.id === FP.putrescentDemise)!.usable!;
    const { state } = setup({ equipment: [EQ.mutoidVermin] });
    expect(usable(state, 'p1').ok).toBe(true);
    for (const id of state.teams.p1.operativeIds) {
      const op = state.operatives[id]!;
      if (![CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub].includes(op.datacardId as never)) op.removed = true;
    }
    expect(usable(state, 'p1').ok).toBe(false);
  });

  it('BARGE lets a NIGHTMARE HULK Reposition and Charge while engaged', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 11.6, 10);
    state.activeOperativeId = hulk.id;
    for (const id of [REPOSITION_BARGE, CHARGE_BARGE]) expect(getAction(id)!.available!(ctx, state, hulk)).toBe(false);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.barge }, ctx).state;
    const h = s.operatives[hulk.id]!;
    for (const id of [REPOSITION_BARGE, CHARGE_BARGE]) expect(getAction(id)!.available!(ctx, s, h)).toBe(true);
    // The universal Reposition still refuses; the carve-out does not, and it shares the
    // restriction key so it can never be used twice.
    expect(getAction('Reposition')!.check(ctx, s, h, { path: { points: [{ x: 15, y: 10 }] } }).ok).toBe(false);
    expect(getAction(REPOSITION_BARGE)!.check(ctx, s, h, { path: { points: [{ x: 15, y: 10 }] } }).ok).toBe(true);
    expect(getAction(REPOSITION_BARGE)!.treatedAs).toBe('Reposition');
    expect(getAction(CHARGE_BARGE)!.treatedAs).toBe('Charge');
  });

  it('BARGE’s "move through enemy operatives" clause is a no-op by construction', () => {
    // `validateMove` only tests the END of a path for base overlap and control range, so the
    // permission is already true for every operative in the game — a handler would be a
    // silent no-op (architecture rule 5).
    expect(REMINDER_ONLY[`${RULE.mutoidVermin}.moveThrough`]).toMatch(/validateMove only tests the END/);
    expect(ruleText(FP.barge)).toContain('It can move through enemy operatives and within control range of them.');
  });

  it('FRIGHTENING ONSLAUGHT is a free 0AP Fight that takes precedence over action restrictions', () => {
    const { ctx, state } = setup();
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 11.6, 10);
    let s = activate(ctx, state, hulk.id, 'engage');
    const usable = gellerpoxInfected.ploys.find((p) => p.id === FP.frighteningOnslaught)!.usable!;
    expect(usable(s, 'p1').ok).toBe(false); // "after … performs the Fight action"
    s = settle(ctx, act(ctx, s, hulk.id, 'Fight', { targetId: foe.id }).state);
    expect(usable(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.frighteningOnslaught }, ctx).state;
    const def = getAction(FIGHT_ONSLAUGHT)!;
    expect(def.ap).toBe(0);
    expect(def.treatedAs).toBeUndefined(); // its own restriction key, so a second Fight is legal
    expect(def.available!(ctx, s, s.operatives[hulk.id]!)).toBe(true);
    const out = act(ctx, s, hulk.id, FIGHT_ONSLAUGHT, { targetId: foe.id });
    expect({ ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
    expect(out.state.operatives[hulk.id]!.apSpent).toBe(1); // the second Fight was free
  });
});

// ---------------------------------------------------------------------------
describe('faction equipment', () => {
  it('MUTOID VERMIN tops the kill team up to four vermin, all three datacards fielded', () => {
    const { state } = setup({ equipment: [EQ.mutoidVermin] });
    const vermin = state.teams.p1.operativeIds
      .map((id) => state.operatives[id]!)
      .filter((o) => [CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub].includes(o.datacardId as never));
    expect(vermin.length).toBe(MUTOID_VERMIN_COUNT);
    expect(new Set(vermin.map((o) => o.datacardId))).toEqual(new Set(VERMIN_ROWS));
    // The opponent, who did not select it, gets none beyond the one printed selection row.
    const foeVermin = state.teams.p2.operativeIds
      .map((id) => state.operatives[id]!)
      .filter((o) => [CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub].includes(o.datacardId as never));
    expect(foeVermin.length).toBe(1);
  });

  it('MUTATED SYMPTOMS gives one operative a second, different TECHNO-CURSE for the turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutatedSymptoms] });
    setTechnoCurse(state, 'p1', 'barrelwarp');
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, foe.id]);
    place(state, hulk.id, 10, 10);
    place(state, foe.id, 12.2, 10); // ~0.6" gap: inside both curses' ranges
    const s = activate(ctx, state, hulk.id, 'engage');
    const T = hooksFor(ctx, 'p1');
    const verdict = curseVerdict(T, s, s.operatives[foe.id]!);
    expect([...verdict.curses].sort()).toEqual(['barrelwarp', 'rustspikes']);
    expect(ruleText(EQ.mutatedSymptoms)).toContain('it must be different from your existing TECHNO-CURSE');
  });

  it('MUTATED SYMPTOMS is once per battle', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutatedSymptoms] });
    setTechnoCurse(state, 'p1', 'barrelwarp');
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const other = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [hulk.id, other.id, foe.id]);
    place(state, foe.id, 10, 10);
    place(state, hulk.id, 12.2, 10);
    place(state, other.id, 12.2, 13);
    let s = activate(ctx, state, hulk.id, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: hulk.id }, ctx).state;
    s = activate(ctx, s, other.id, 'engage');
    expect(s.effects.filter((e) => e.rule === 'gellerpox-infected.additionalCurse').length).toBe(1);
  });

  it('POLLUTED STOCKPILE removes one of the opponent’s equipment options and bans it', () => {
    const ctx = teamContext([gellerpoxInfected], { script: [6, 6] }); // 2D6 = 12, a 7+
    const picks = defaultRoster(DATA);
    let state = battle({
      ctx,
      p1: { module: gellerpoxInfected, picks, equipment: [EQ.pollutedStockpile] },
      p2: { module: gellerpoxInfected, picks, equipment: [EQ.plagueBellows, EQ.mutatedSymptoms] },
    });
    expect(state.teams.p2.equipment).toEqual([EQ.mutatedSymptoms]); // the first of theirs went
    // "They cannot select that equipment again during the game sequence."
    state = reduce(state, { t: 'SelectEquipment', player: 'p2', equipment: [EQ.plagueBellows] }, ctx).state;
    expect(state.teams.p2.equipment).toEqual([]);
  });

  it('POLLUTED STOCKPILE is not rolled once the Select Operatives step is over', () => {
    const { ctx, state } = setup();
    state.setup.step = 'done';
    const before = state.teams.p2.equipment.length;
    const s = reduce(state, { t: 'SelectEquipment', player: 'p1', equipment: [EQ.pollutedStockpile] }, ctx).state;
    expect(s.rolls.some((r) => r.kind === 'pollutedStockpile')).toBe(false);
    expect(s.teams.p2.equipment.length).toBe(before);
    expect(ruleText(EQ.pollutedStockpile)).toContain('You cannot select this equipment option after the Select Operatives step');
  });

  it('PLAGUE BELLOWS retains one defence dice result of 3 as a normal success beyond 6"', () => {
    const { ctx, state } = setup({ equipment: [EQ.plagueBellows] });
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const promote = (distance: number, target: OperativeState) => {
      const seq = shootAt(state, foe, target, {
        step: 'defenceRerolls',
        weaponName: 'Pyregut',
        profileName: 'standard',
        defence: [3, 3, 6],
        save: 5,
      });
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(foe, target, profileOf(CARD.vulgrar, 'Pyregut', 'standard'), { distance }),
        count: 0,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
      return seq.defence.dice.map((d) => d.state);
    };
    expect(promote(8, hulk)).toEqual(['normal', 'fail', 'crit']); // exactly one, the printed maximum
    expect(promote(4, hulk)).toEqual(['fail', 'fail', 'crit']); // "more than 6" from it"
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    expect(promote(8, mutant)).toEqual(['fail', 'fail', 'crit']); // NIGHTMARE HULKs only
  });
});

// ---------------------------------------------------------------------------
describe('VULGRAR THRICE-CURSED', () => {
  it('Engineered slices its six printed improvements and takes a logged default (D-022)', () => {
    expect(ENGINEERED_OPTIONS.map((o) => o.id)).toEqual(['dmgN', 'dmgC', 'Balanced', 'Brutal', 'Lethal', 'Rending']);
    expect(ENGINEERED_OPTIONS.map((o) => o.label).join(', ')).toBe(
      'Add 1 to the Normal Dmg stat, add 1 to the Critical Dmg stat, Balanced, Brutal, Lethal 5+, Rending',
    );
    const { ctx, state } = setup();
    expect(engineeredOf(state, 'p1')).toEqual([]);
    const s = activate(ctx, state, opWith(state, 'p1', CARD.vulgrar));
    expect(engineeredOf(s, 'p1')).toEqual(ENGINEERED_DEFAULT);
    expect(s.log.some((l) => l.text.startsWith('Engineered: '))).toBe(true);
  });

  it('Engineered grants its weapon rules to the Fleshmelded weapons only, fighting and retaliating', () => {
    const { ctx, state } = setup();
    setEngineered(state, 'p1', ['Balanced', 'Rending']);
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.lumberghast)]!;
    const ids = (weapon: string, profile?: string, retaliating = false) =>
      effectiveRules(ctx, state, profileOf(CARD.vulgrar, weapon, profile), {
        operative: vulgrar,
        target: foe,
        weaponName: weapon,
        retaliating,
      }).map((r) => r.id);
    expect(ids('Fleshmelded weapons')).toEqual(expect.arrayContaining(['Balanced', 'Rending']));
    expect(ids('Fleshmelded weapons', undefined, true)).toEqual(expect.arrayContaining(['Balanced', 'Rending']));
    expect(ids('Pyregut', 'standard')).not.toContain('Balanced');
  });

  it('Engineered’s two Dmg bumps land at the moment of damage, never on the shared profile (D-019)', () => {
    const { ctx, state } = setup();
    setEngineered(state, 'p1', ['dmgN', 'dmgC']);
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.glitchling)]!;
    const profile = profileOf(CARD.vulgrar, 'Fleshmelded weapons');
    fightAt(state, vulgrar, foe, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, profile.dmgN, 'attack'); // a normal strike
    expect(before - foe.wounds).toBe(profile.dmgN + 1);
    expect(profileOf(CARD.vulgrar, 'Fleshmelded weapons').dmgN).toBe(4); // the catalogue is untouched
  });

  it('Spread the Glorious Gifts is a once-per-battle STRATEGIC GAMBIT on a controlled objective', () => {
    const { ctx, state } = setup();
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    isolate(state, [vulgrar.id]);
    const T = hooksFor(ctx, 'p1');
    expect(spreadTargets(T, state)).toEqual([]); // it controls nothing yet
    place(state, vulgrar.id, 15, 11); // the centre objective
    expect(spreadTargets(T, state)).toEqual(['centre']);
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SPREAD_GAMBIT);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SPREAD_GAMBIT }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'gellerpox-infected.technoCurseToken')).toBe(true);
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(SPREAD_GAMBIT); // once per battle
  });

  it('Spread the Glorious Gifts curses an enemy on the marker, and raises Rustspikes to 2 damage', () => {
    expect(GIFT_CLAUSE.barrelwarp).toBe('No additional effect.');
    expect(GIFT_CLAUSE.rustspikes).toBe('This TECHNO-CURSE inflicts 2 damage on that enemy operative (instead of 1).');
    const { ctx, state } = setup();
    setTechnoCurse(state, 'p1', 'rustspikes');
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [vulgrar.id, foe.id]);
    place(state, vulgrar.id, 15, 11);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SPREAD_GAMBIT }, ctx).state;
    // VULGRAR steps away; the enemy walks onto the cursed marker and is affected from there.
    place(s, vulgrar.id, 2, 2);
    place(s, foe.id, 15, 11);
    const T = hooksFor(ctx, 'p1');
    const verdict = curseVerdict(T, s, s.operatives[foe.id]!);
    expect(verdict.curses.has('rustspikes')).toBe(true);
    expect(verdict.viaToken).toBe(true);
    const f = s.operatives[foe.id]!;
    const before = f.wounds;
    fightAt(s, f, s.operatives[vulgrar.id]!, {
      step: 'retention',
      attackerWeapon: SWIPE_WEAPON,
      attackerProfile: 'slashing',
      attackerDice: [1, 5, 5],
      attackerHit: 4,
    });
    effectiveRules(ctx, s, profileOf(CARD.bloatspawn, SWIPE_WEAPON, 'slashing'), {
      operative: f,
      target: s.operatives[vulgrar.id]!,
      weaponName: SWIPE_WEAPON,
    });
    expect(before - f.wounds).toBe(2);
  });

  it('Spread the Glorious Gifts + Viral Vox-static subtracts 1 APL when that enemy is activated', () => {
    expect(GIFT_CLAUSE['vox-static']).toBe(
      'Whenever that enemy operative is activated, subtract 1 from its APL stat until the end of its activation.',
    );
    const { ctx, state } = setup();
    setTechnoCurse(state, 'p1', 'vox-static');
    const vulgrar = state.operatives[opWith(state, 'p1', CARD.vulgrar)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    isolate(state, [vulgrar.id, foe.id]);
    place(state, vulgrar.id, 15, 11);
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SPREAD_GAMBIT }, ctx).state;
    place(s, vulgrar.id, 2, 2);
    place(s, foe.id, 15, 11);
    s = activate(ctx, s, foe.id, 'engage');
    expect(aplOf(ctx, s, s.operatives[foe.id]!)).toBe(1);
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    expect(s.operatives[foe.id]!.aplMods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('BLOATSPAWN', () => {
  it('Tentacled Grasp stops a Fall Back on a 4+, adding 1 for a Wounds stat of 8 or less', () => {
    // The MUTANT has W7, so the printed +1 applies: a scripted 3 becomes 4 and the ban lands.
    const { ctx, state } = setup({ script: [3] });
    const bloat = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    isolate(state, [bloat.id, foe.id]);
    place(state, bloat.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const s = activate(ctx, state, foe.id, 'engage');
    expect(s.log.some((l) => /Tentacled Grasp: 4 — .* cannot Fall Back/.test(l.text))).toBe(true);
    const banned = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[foe.id]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(banned.allowed).toBe(false);
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[foe.id]!, action: 'Reposition', allowed: true })
        .allowed,
    ).toBe(true);
  });

  it('Tentacled Grasp lets the Fall Back through on a failed roll', () => {
    const { ctx, state } = setup({ script: [1] });
    const bloat = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!; // W21: no +1
    isolate(state, [bloat.id, foe.id]);
    place(state, bloat.id, 10, 10);
    place(state, foe.id, 11.6, 10);
    const s = activate(ctx, state, foe.id, 'engage');
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[foe.id]!, action: 'Fall Back', allowed: true })
        .allowed,
    ).toBe(true);
  });

  it('Swipe chains a free 0AP FIGHT against each enemy in control range, once each', () => {
    const { ctx, state } = setup();
    const bloat = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.lumberghast)]!;
    isolate(state, [bloat.id, foeA.id, foeB.id]);
    place(state, bloat.id, 10, 10);
    place(state, foeA.id, 11.6, 10);
    place(state, foeB.id, 10, 11.6);
    let s = activate(ctx, state, bloat.id, 'engage');
    // Nothing to chain from until a Fight is made with the printed profile.
    expect(getAction(FIGHT_SWIPE[0])!.check(ctx, s, s.operatives[bloat.id]!, {}).ok).toBe(false);
    s = settle(
      ctx,
      act(ctx, s, bloat.id, 'Fight', {
        targetId: foeA.id,
        meleeWeaponName: SWIPE_WEAPON,
        meleeProfileName: SWIPE_PROFILE,
      }).state,
    );
    expect(swipeLedger(s, s.operatives[bloat.id]!)).toEqual([foeA.id]);
    const def = getAction(FIGHT_SWIPE[0])!;
    expect(def.ap).toBe(0);
    expect(def.treatedAs).toBeUndefined();
    // The enemy already swiped cannot be selected again; the other one can.
    expect(def.check(ctx, s, s.operatives[bloat.id]!, { targetId: foeA.id }).ok).toBe(false);
    expect(def.check(ctx, s, s.operatives[bloat.id]!, { targetId: foeB.id }).ok).toBe(true);
    const out = act(ctx, s, bloat.id, FIGHT_SWIPE[0], { targetId: foeB.id });
    expect({ ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
    s = settle(ctx, out.state);
    expect(swipeLedger(s, s.operatives[bloat.id]!).sort()).toEqual([foeA.id, foeB.id].sort());
    expect(getAction(FIGHT_SWIPE[1])!.check(ctx, s, s.operatives[bloat.id]!, {}).ok).toBe(false);
  });

  it('Swipe is not armed by the OTHER profile of the same weapon', () => {
    const { ctx, state } = setup();
    const bloat = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [bloat.id, foe.id]);
    place(state, bloat.id, 10, 10);
    place(state, foe.id, 11.6, 10);
    let s = activate(ctx, state, bloat.id, 'engage');
    s = settle(
      ctx,
      act(ctx, s, bloat.id, 'Fight', { targetId: foe.id, meleeWeaponName: SWIPE_WEAPON, meleeProfileName: 'slashing' })
        .state,
    );
    expect(swipeLedger(s, s.operatives[bloat.id]!)).toEqual([]);
    expect(getAction(FIGHT_SWIPE[0])!.check(ctx, s, s.operatives[bloat.id]!, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FLESHSCREAMER, LUMBERGHAST, MUTANT, GLITCHLING and the MUTOID VERMIN', () => {
  it('Horrifying Shrieking costs an enemy within 3" 1 extra AP for Pick Up Marker and mission actions', () => {
    const { ctx, state } = setup();
    const screamer = state.operatives[opWith(state, 'p1', CARD.fleshscreamer)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [screamer.id, foe.id]);
    place(state, screamer.id, 10, 10);
    place(state, foe.id, 12, 10);
    const cost = (action: string) =>
      ctx.hooks.emit('onActionCost', state, { state, operative: foe, action, ap: 1 }).ap;
    expect(cost('Pick Up Marker')).toBe(2);
    expect(cost('Reposition')).toBe(1);
    place(state, foe.id, 20, 10);
    expect(cost('Pick Up Marker')).toBe(1);
  });

  it('Horrifying Shrieking treats the contesting enemy total APL as 1 lower', () => {
    const { ctx, state } = setup();
    const screamer = state.operatives[opWith(state, 'p1', CARD.fleshscreamer)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.glitchling)]!;
    isolate(state, [screamer.id, foeA.id, foeB.id]);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 10, y: 10 }, z: 0, flags: {} };
    place(state, foeA.id, 10.9, 10);
    place(state, foeB.id, 9.1, 10);
    place(state, screamer.id, 25, 25);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p2'); // 4 APL vs 0
    // Inside 3" of the FLESHSCREAMER the total is treated as 1 lower — still 3 vs 0 here, so
    // the read is pinned on the event itself.
    place(state, screamer.id, 13, 10);
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'obj',
      aplByPlayer: { p1: 0, p2: 4 },
    });
    expect(ev.aplByPlayer.p2).toBe(3);
    expect(abilityText(CARD.fleshscreamer, AB.horrifyingShrieking)).toContain('Note this isn’t a change to the APL stat');
  });

  it('Spiked Charger inflicts D3 on each enemy in control range after a Charge', () => {
    // The first draw is the enemy BLOATSPAWN's own Tentacled Grasp roll at this activation start.
    const { ctx, state } = setup({ script: [1, 6, 6] });
    const lumber = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [lumber.id, foeA.id, foeB.id]);
    place(state, lumber.id, 10, 10);
    place(state, foeA.id, 11.6, 10);
    place(state, foeB.id, 10, 11.6);
    const beforeA = foeA.wounds;
    const beforeB = foeB.wounds;
    let s = activate(ctx, state, lumber.id, 'engage');
    s.operatives[lumber.id]!.actionsThisActivation.push('Charge');
    s = reduce(s, { t: 'EndActivation', operativeId: lumber.id }, ctx).state;
    expect(beforeA - s.operatives[foeA.id]!.wounds).toBe(3); // ceil(6/2)
    expect(beforeB - s.operatives[foeB.id]!.wounds).toBe(3);
    expect(PARTIAL[`${AB.spikedCharger}.timing`]).toMatch(/nothing runs at the end of an action/);
  });

  it('Gellercaust Masks turns a critical strike into Normal Dmg for a MUTANT only', () => {
    const { ctx, state } = setup();
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const hulk = state.operatives[opWith(state, 'p1', CARD.lumberghast)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const profile = profileOf(CARD.vulgrar, 'Fleshmelded weapons'); // 4/5
    fightAt(state, foe, mutant, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const before = mutant.wounds;
    inflictDamage(ctx, state, mutant, profile.dmgC, 'attack');
    expect(before - mutant.wounds).toBe(profile.dmgN); // 4, not 5 — before Revoltingly Resilient rolls
    fightAt(state, foe, hulk, { step: 'resolve', attackerWeapon: 'Fleshmelded weapons' });
    const beforeHulk = hulk.wounds;
    inflictDamage(ctx, state, hulk, profile.dmgC, 'attack');
    expect(beforeHulk - hulk.wounds).toBeGreaterThanOrEqual(profile.dmgC - 1); // no Masks on a HULK
  });

  it('Gellercaust Masks reduces a shoot once per unblocked critical success', () => {
    const { ctx, state } = setup({ script: [1, 1] }); // both Revoltingly Resilient rolls fail
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
    const profile = profileOf(CARD.mutant, 'Heavy axe'); // 4/5, melee — used here as the shoot profile
    shootAt(state, foe, mutant, { step: 'resolve', weaponName: 'Heavy axe', attack: [6, 4], hit: 4 });
    const before = mutant.wounds;
    inflictDamage(ctx, state, mutant, profile.dmgC + profile.dmgN, 'attack'); // 5 + 4
    expect(before - mutant.wounds).toBe(profile.dmgN * 2); // the crit pays Normal Dmg instead
  });

  it('Daemonic makes an operative shooting a GLITCHLING ignore the Piercing weapon rule', () => {
    const { ctx, state } = setup();
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const mutant = state.operatives[opWith(state, 'p1', CARD.mutant)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const profile = profileOf(CARD.sludgeGrub, 'Acid spit'); // Piercing 1
    const ids = (target: OperativeState) =>
      effectiveRules(ctx, state, profile, { operative: foe, target, weaponName: 'Acid spit' }).map((r) => r.id);
    expect(ids(glitch)).not.toContain('Piercing');
    expect(ids(mutant)).toContain('Piercing');
  });

  it('Small stops a concealed GLITCHLING in cover being selected, except within 2"', () => {
    const light = heavyBlock('coverA', 14, 9, 1, 4, 3);
    const { ctx, state } = setup({ map: testMap({ features: [light] }) });
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    isolate(state, [glitch.id, foe.id]);
    glitch.order = 'conceal';
    place(state, glitch.id, 12.8, 11);
    place(state, foe.id, 22, 11);
    const verdict = (attacker: OperativeState) =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker,
        target: glitch,
        valid: true,
        ignoreCoverTerrain: 'none' as const,
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(verdict(foe)).toBe(false);
    place(state, foe.id, 14.0, 11); // "except being within 2""
    expect(verdict(foe)).toBe(true);
    glitch.order = 'engage';
    place(state, foe.id, 22, 11);
    expect(verdict(foe)).toBe(true);
  });

  it('Small and Mutoid Vermin both refuse a weapon that is not on the datacard', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const glitch = state.operatives[opWith(state, 'p1', CARD.glitchling)]!;
    const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const allowed = (op: OperativeState, weaponName: string) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, profileOf(CARD.glitchling, 'Diseased effluence'), { weaponName }),
        allowed: true,
        dryRun: true,
      }).allowed;
    expect(allowed(glitch, 'Diseased effluence')).toBe(true);
    expect(allowed(glitch, 'Frag grenade')).toBe(false);
    expect(allowed(grub, 'Bloodsucking proboscis')).toBe(true);
    expect(allowed(grub, 'Frag grenade')).toBe(false);
  });

  it('Feast adds 1 Atk and Lethal 5+ against a wounded operative, fighting and retaliating', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const mite = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const weapon = 'Bloodsucking proboscis';
    const profile = profileOf(CARD.cursemite, weapon);
    const ids = (retaliating = false) =>
      effectiveRules(ctx, state, profile, { operative: mite, target: foe, weaponName: weapon, retaliating }).map((r) => r.id);
    const atk = () =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(mite, foe, profile, { weaponName: weapon }),
        count: profile.atk,
        mods: zeroStatMods(),
      }).mods.atk;
    expect(ids()).not.toContain('Lethal');
    expect(atk()).toBe(0);
    foe.wounds -= 1; // "against a wounded operative"
    expect(ids()).toContain('Lethal');
    expect(ids(true)).toContain('Lethal');
    expect(atk()).toBe(1);
  });

  it('Caustic Demise rolls one D6 per enemy visible and within 2" and inflicts 1 on a 4+', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin], script: [5, 2] });
    const grub = state.operatives[opWith(state, 'p1', CARD.sludgeGrub)]!;
    const foeA = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
    const foeB = state.operatives[opWith(state, 'p2', CARD.bloatspawn)]!;
    isolate(state, [grub.id, foeA.id, foeB.id]);
    place(state, grub.id, 10, 10);
    place(state, foeA.id, 11.4, 10);
    place(state, foeB.id, 10, 11.4);
    const a = foeA.wounds;
    const b = foeB.wounds;
    inflictDamage(ctx, state, grub, 99, 'attack');
    expect([a - foeA.wounds, b - foeB.wounds].sort()).toEqual([0, 1]); // one 4+, one miss
  });

  it('Group Activation records the printed pairing as an effect for the UI/AI (the known partial)', () => {
    const { ctx, state } = setup({ equipment: [EQ.mutoidVermin] });
    const mutantIds = state.teams.p1.operativeIds.filter((id) => state.operatives[id]!.datacardId === CARD.mutant);
    expect(mutantIds.length).toBe(3);
    let s = activate(ctx, state, mutantIds[0]!, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: mutantIds[0]! }, ctx).state;
    const paired = s.effects.filter((e) => e.rule === GROUP_ACTIVATION);
    expect(paired.length).toBe(1);
    expect(mutantIds.slice(1)).toContain(paired[0]!.operativeId);
    // "you cannot activate more than two operatives in succession with this rule"
    let t = activate(ctx, s, paired[0]!.operativeId!, 'engage');
    t = reduce(t, { t: 'EndActivation', operativeId: paired[0]!.operativeId! }, ctx).state;
    expect(t.effects.filter((e) => e.rule === GROUP_ACTIVATION).length).toBe(1);
    expect(REMINDER_ONLY[`${AB.mutantGroupActivation}.pairing`]).toMatch(/activePlayer/);
  });

  it('each MUTOID VERMIN datacard prints the same Group Activation, scoped to MUTOID VERMIN', () => {
    for (const id of [CARD.cursemite, CARD.eyestinger, CARD.sludgeGrub])
      expect(abilityText(id, `${id}.group-activation`)).toContain('friendly GELLERPOX INFECTED MUTOID VERMIN operative');
    expect(abilityText(CARD.glitchling, AB.glitchlingGroupActivation)).toContain('GELLERPOX INFECTED GLITCHLING');
    expect(abilityText(CARD.mutant, AB.mutantGroupActivation)).toContain('GELLERPOX INFECTED MUTANT');
  });
});

// ---------------------------------------------------------------------------
describe('rare weapon rules', () => {
  it('all three resolve to this team’s own printed datacard abilities (D-033)', () => {
    expect(DATA.rareWeaponRules).toEqual(['Engineered', 'Feast', 'Swipe']);
    expect(rareWeaponRuleText('Engineered', DATA.id)).toBe(abilityText(CARD.vulgrar, AB.engineered));
    expect(rareWeaponRuleText('Feast', DATA.id)).toBe(abilityText(CARD.cursemite, AB.feast));
    expect(rareWeaponRuleText('Swipe', DATA.id)).toBe(abilityText(CARD.bloatspawn, AB.swipe));
  });

  it('each rare rule is footnoted on exactly the weapon profile it belongs to', () => {
    expect(profileOf(CARD.vulgrar, 'Fleshmelded weapons').rules.map((r) => r.raw)).toContain('Engineered*');
    expect(profileOf(CARD.cursemite, 'Bloodsucking proboscis').rules.map((r) => r.raw)).toContain('Feast*');
    expect(profileOf(CARD.bloatspawn, SWIPE_WEAPON, SWIPE_PROFILE).rules.map((r) => r.raw)).toContain('Swipe*');
    expect(profileOf(CARD.bloatspawn, SWIPE_WEAPON, 'slashing').rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('AI hints', () => {
  it('names a role for every datacard', () => {
    const roles = gellerpoxInfected.aiHints?.roles ?? {};
    expect(Object.keys(roles).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
  });

  it('prices all eight ploys plus the extra STRATEGIC GAMBIT — without it the AI never uses one', () => {
    const values = gellerpoxInfected.aiHints?.ployValue ?? {};
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(values[p.id]).toBeTypeOf('number');
    expect(values[SPREAD_GAMBIT]).toBeGreaterThan(1); // free, permanent and switches a curse on
  });

  it('prices all four equipment options', () => {
    const values = gellerpoxInfected.aiHints?.equipmentValue ?? {};
    expect(Object.keys(values).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });
});

// ---------------------------------------------------------------------------
describe('honesty: what is NOT implemented, and why', () => {
  it('every reminder-only clause names a real engine reason', () => {
    // docs/TEAM-STATUS.md is only worth anything if it is honest: a declared-but-unemitted hook
    // is the silent no-op architecture rule 5 forbids, so each of these registers NO handler.
    expect(Object.keys(REMINDER_ONLY).length).toBe(12);
    for (const [clause, reason] of Object.entries(REMINDER_ONLY)) {
      expect(clause.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(40);
    }
    expect(REMINDER_ONLY[`${RULE.mutoidVermin}.ops`]).toMatch(/src\/core\/ops/);
    expect(REMINDER_ONLY[`${AB.small}.melee`]).toMatch(/weaponsOf appends grantedWeapons/);
    expect(REMINDER_ONLY[`${FP.revoltingTechnology}.hotRoll`]).toMatch(/finishShoot/);
    expect(REMINDER_ONLY[`${SP.drawnToTheHum}.endPosition`]).toMatch(/no hook constrains where a move ENDS/);
  });

  it('every partial clause states the shift the engine forces', () => {
    expect(Object.keys(PARTIAL).length).toBe(14);
    for (const reason of Object.values(PARTIAL)) expect(reason.length).toBeGreaterThan(40);
    expect(PARTIAL[`${RULE.technoCurse}.choice`]).toMatch(/D-017/);
    expect(PARTIAL[`${EQ.mutoidVermin}.four`]).toMatch(/count: 1/);
  });

  it('the printed clauses that ARE covered are not also listed as reminder-only', () => {
    // The Hot GRANT, the marker-contest ban and the Fall Back discount are all live.
    expect(REMINDER_ONLY[FP.revoltingTechnology]).toBeUndefined();
    expect(REMINDER_ONLY[RULE.mutoidVermin]).toBeUndefined();
    expect(REMINDER_ONLY[RULE.nightmareHulks]).toBeUndefined();
    expect(REMINDER_ONLY[RULE.revoltinglyResilient]).toBeUndefined();
    expect(REMINDER_ONLY[RULE.technoCurse]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('action contract (D-026)', () => {
  /**
   * `src/ai/legal.ts` tries a small set of plausible params and offers anything whose `check`
   * passes, so a `perform` that then refuses is a REJECTED INTENT. This team prints no unique
   * actions, so the surface is its seven D-021 carve-outs.
   */
  it('every ActionDef this module registers completes whatever its `check` accepted', () => {
    const ids = [...FIGHT_SWIPE, FIGHT_ONSLAUGHT, REPOSITION_BARGE, CHARGE_BARGE, VERMIN_REPOSITION, VERMIN_DASH, VERMIN_CHARGE];
    const tried = new Map<string, number>();
    for (const actionId of ids) {
      const vermin = actionId.includes('Mutoid Vermin');
      const { ctx, state } = setup({ equipment: [EQ.mutoidVermin], seed: 5 });
      const bloat = state.operatives[opWith(state, 'p1', CARD.bloatspawn)]!;
      const grub = state.operatives[opWith(state, 'p1', CARD.cursemite)]!;
      const foeA = state.operatives[opWith(state, 'p2', CARD.vulgrar)]!;
      const foeB = state.operatives[opWith(state, 'p2', CARD.lumberghast)]!;
      const mutant = state.operatives[opWith(state, 'p2', CARD.mutant)]!;
      const mover = vermin ? mutant : bloat;
      isolate(state, [bloat.id, grub.id, foeA.id, foeB.id, mutant.id]);
      // A board where every printed trigger is reachable: the BLOATSPAWN engaged with two
      // enemies, and an enemy MUTANT held only by a MUTOID VERMIN with a friendly of its own
      // three inches away for the Charge to finish on.
      place(state, bloat.id, 10, 10);
      place(state, foeA.id, 11.6, 10);
      place(state, foeB.id, 10, 11.6);
      place(state, mutant.id, 20, 16);
      place(state, grub.id, 21.4, 16);
      if (!vermin) place(state, mutant.id, 25, 20);
      let s = state;
      s = activate(ctx, s, mover.id, 'engage');
      if (!vermin) {
        s = settle(
          ctx,
          act(ctx, s, bloat.id, 'Fight', {
            targetId: foeA.id,
            meleeWeaponName: SWIPE_WEAPON,
            meleeProfileName: SWIPE_PROFILE,
          }).state,
        );
        // Both ploys print "during/after" the operative's own activation, so they are used here.
        s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.frighteningOnslaught }, ctx).state;
        s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.barge }, ctx).state;
      }
      const op = s.operatives[mover.id]!;
      if (op.incapacitated || op.removed) continue;
      const def = getAction(actionId)!;
      if (def.available && !def.available(ctx, s, op)) continue;
      const attempts: Record<string, unknown>[] = [
        {},
        { path: { points: [{ x: op.pos.x + 3, y: op.pos.y }] } },
        { path: { points: [{ x: op.pos.x - 3, y: op.pos.y }] } },
        ...aliveOperatives(s).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
      ];
      // A destination that ends just inside an enemy's control range, so a Charge is reachable.
      for (const foe of aliveOperatives(s, op.player === 'p1' ? 'p2' : 'p1')) {
        const d = Math.hypot(foe.pos.x - op.pos.x, foe.pos.y - op.pos.y);
        if (d > 8) continue;
        // As close as the rules allow: within the enemy's control range with the bases
        // touching. A fixed 1.9" stand-off assumed 32mm bases and was inside a 40mm one, and
        // skipping enemies nearer than 2.2" left the BARGE carve-out — whose whole point is
        // Charging while ALREADY engaged — with no legal path to offer.
        attempts.push({ path: { points: [chargeTo(ctx, s, op.id, foe.id)] } });
      }
      for (const params of attempts) {
        if (!def.check(ctx, s, op, params).ok) continue;
        const out = act(ctx, s, op.id, actionId, params);
        tried.set(actionId, (tried.get(actionId) ?? 0) + 1);
        expect({ actionId, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    // None of the assertions above was vacuous: every carve-out was reachable on that board.
    expect(ids.filter((id) => !tried.has(id))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared
  // ring in tests/teams/soak.test.ts covers the batch; this mirror exercises the four MUTOID
  // VERMIN the equipment adds, POLLUTED STOCKPILE across both players' equipment steps and the
  // TECHNO-CURSE default, on an open and a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([gellerpoxInfected], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: {
            teamId: 'gellerpox-infected',
            operatives: roster(),
            equipment: [EQ.mutoidVermin, EQ.mutatedSymptoms, EQ.pollutedStockpile, EQ.plagueBellows],
          },
          p2: { teamId: 'gellerpox-infected', operatives: roster(), equipment: [EQ.plagueBellows, EQ.mutatedSymptoms] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 6000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The four MUTOID VERMIN joined and were deployed, and the mandatory curse was chosen.
      expect(result.state.teams.p1.operativeIds.length).toBe(15);
      expect(technoCurseOf(result.state, 'p1')).toBeDefined();
      expect(technoCurseOf(result.state, 'p2')).toBeDefined();
      expect(engineeredOf(result.state, 'p1').length).toBe(2);
      // POLLUTED STOCKPILE fired against the opponent's list.
      expect(result.state.log.some((l) => l.text.startsWith('POLLUTED STOCKPILE'))).toBe(true);
    }, 180000);
  }
});
