/**
 * CHAOS CULT. Every test quotes the printed rule it pins, read out of
 * `data/teams/chaos-cult.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/chaos-cult/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, HookRegistry, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { effectiveRules, startShoot } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  hitOf,
  inflictDamage,
  markerController,
  moveOf,
  saveOf,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/chaos-cult.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import {
  AB,
  ACT,
  CARD,
  EQ,
  FIGHT_DAEMON,
  FP,
  GIFTS,
  GIFT_LABEL,
  GIFT_NAME,
  GIFT_TEXT,
  KW,
  MUTATE_GAMBIT,
  PARTIAL,
  REMINDER_ONLY,
  RULE,
  SP,
  VORTEX_MARKER,
  WINGS_CHARGE,
  WINGS_DASH,
  WINGS_FALL_BACK,
  WINGS_REPOSITION,
  availableGifts,
  chaosCult,
  giftsFor,
  giftsOf,
  hasGift,
  mutateAllowance,
  mutateOperative,
  mutateOptions,
  mutatedThisTP,
  setAccursedGift,
} from '../../src/teams/chaos-cult/index.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, KillzoneMap, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { testMap, vantagePlatform } from '../fixtures.ts';

const DATA = teamData('chaos-cult');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const RAW = rawJson as unknown as {
  notes: string[];
  markerGuide: string;
  rareWeaponRules: string[];
  selection: { constraints: unknown[]; totalOperatives: number; list: { role: string; datacardId: string }[] };
  datacards: {
    id: string;
    apl: number;
    move: number;
    save: number;
    wounds: number;
    base: { shape: string; mm: number };
    keywords: string[];
    weapons: { name: string; profiles: WeaponProfile[] }[];
  }[];
};

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

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([chaosCult], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.roles ? rosterIncluding(chaosCult, opts.roles) : defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: chaosCult, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: chaosCult, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a control-range / distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    op.z = 0;
    n++;
  }
}

/** All of a player's operatives, by datacard. */
const idsOf = (state: GameState, player: 'p1' | 'p2', datacardId: string): string[] =>
  state.teams[player].operativeIds.filter((id) => state.operatives[id]!.datacardId === datacardId);

/** A Vantage platform the Deformed Wings tests climb, and the path they climb it by. */
const WINGS_MAP = (): KillzoneMap => testMap({ features: [vantagePlatform('tower', 12, 9, 4, 4, 3)] });
const WINGS_PATH = {
  points: [
    { x: 13, y: 8.5 },
    { x: 13, y: 9.2 },
    { x: 13, y: 12.2 },
  ],
  zs: [undefined, 3, 3],
} as unknown as never;

const pool = (values: number[], hit: number): DicePool => {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
};

const hooksFor = (ctx: GameContext, player: 'p1' | 'p2'): HookRegistry => {
  const reg = new HookRegistry();
  chaosCult.register(reg, player, ctx);
  return reg;
};

const meleeCtx = (attacker: OperativeState, defender: OperativeState, profile: WeaponProfile, weaponName: string): AttackContext => ({
  attacker,
  defender,
  weaponName,
  profile,
  rules: profile.rules,
  type: 'melee',
  secondary: false,
  pointBlank: false,
  inCover: false,
  obscured: false,
  vantageAccurate: 0,
  distance: 0,
});

// ===========================================================================
describe('CHAOS CULT — data is pinned to data/teams/chaos-cult.json', () => {
  it('identifies the team', () => {
    expect(chaosCult.id).toBe('chaos-cult');
    expect(DATA.name).toBe('Chaos Cult');
    expect(KW).toBe('CHAOS CULT');
    expect(DATA.sourceUrl).toContain('chaos-cult');
  });

  it('has 7 datacards, 2 faction rules, 4+4 ploys, 4 equipment, 9 abilities and 5 unique actions', () => {
    expect(DATA.datacards.map((c) => c.id).sort()).toEqual(
      [CARD.blessedBlade, CARD.demagogue, CARD.devotee, CARD.iconarch, CARD.mindwitch, CARD.mutant, CARD.torment].sort(),
    );
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE.accursedGifts, RULE.mutation]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual([
      SP.exaltationInPain,
      SP.ferventOnslaught,
      SP.creaturesOfNightmare,
      SP.sickeningAura,
    ]);
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual([
      FP.faithfulFollower,
      FP.abhorrentMutation,
      FP.frenziedDemise,
      FP.unleashTheDaemon,
    ]);
    expect(DATA.equipment.map((e) => e.id)).toEqual([
      EQ.balefulScript,
      EQ.covertGuises,
      EQ.unholyTalisman,
      EQ.vileBlessing,
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities).length).toBe(9);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).length).toBe(5);
  });

  it('pins every datacard’s stats, base and keywords', () => {
    for (const raw of RAW.datacards) {
      const card = DATA.datacards.find((c) => c.id === raw.id)!;
      expect([card.id, card.apl, card.move, card.save, card.wounds]).toEqual([
        raw.id,
        raw.apl,
        raw.move,
        raw.save,
        raw.wounds,
      ]);
      expect(card.base).toEqual(raw.base);
      expect(card.keywords).toEqual(raw.keywords);
      expect(card.keywords).toContain(KW);
    }
    // The two datacards a kill team can only ever reach through Mutation.
    expect(DATA.datacards.find((c) => c.id === CARD.mutant)!.wounds).toBe(7);
    expect(DATA.datacards.find((c) => c.id === CARD.torment)!.wounds).toBe(13);
    expect(DATA.datacards.find((c) => c.id === CARD.torment)!.base).toEqual({ shape: 'round', mm: 40 });
  });

  it('pins the weapon profiles the rules read', () => {
    const blade = profileOf(CARD.blessedBlade, 'Commune blade');
    expect([blade.atk, blade.hit, blade.dmgN, blade.dmgC]).toEqual([4, 4, 4, 6]);
    expect(blade.rules.map((r) => r.raw)).toEqual(['Lethal 5+']);

    const gaze = profileOf(CARD.mindwitch, 'Infernal gaze');
    expect([gaze.atk, gaze.hit, gaze.dmgN, gaze.dmgC]).toEqual([5, 3, 0, 0]);
    expect(gaze.rules.map((r) => r.id)).toEqual(['PSYCHIC', 'Range', 'Devastating', 'Lethal']);

    const censer = profileOf(CARD.iconarch, 'Burning censer');
    expect(censer.rules.map((r) => r.raw)).toEqual(['Range 5"', 'Saturate', 'Torrent 2"']);

    const appendages = profileOf(CARD.mutant, 'Blasphemous appendages');
    expect([appendages.atk, appendages.hit, appendages.dmgN, appendages.dmgC]).toEqual([4, 4, 3, 4]);
    expect(appendages.rules.map((r) => r.id)).toEqual(['Ceaseless', 'Rending']);

    const mutations = profileOf(CARD.torment, 'Hideous mutations');
    expect([mutations.atk, mutations.hit, mutations.dmgN, mutations.dmgC]).toEqual([5, 4, 4, 5]);
    expect(mutations.rules.map((r) => r.id)).toEqual(['Ceaseless', 'Rending']);

    const stave = profileOf(CARD.demagogue, 'Diabolical stave', 'melee');
    expect(stave.rules.map((r) => r.id)).toEqual(['Shock', 'Stun']);
  });

  it('registers its one rare weapon rule, PSYCHIC, through rareRuleTextFor (D-033)', () => {
    expect(RAW.rareWeaponRules).toEqual(['PSYCHIC']);
    // PSYCHIC is a weapon keyword the source defines nowhere; nothing in this team's JSON
    // redefines it, so the registry fallback stands.
    expect(rareWeaponRuleText('PSYCHIC')).toContain('PSYCHIC');
    expect(profileOf(CARD.mindwitch, 'Infernal gaze').rules.some((r) => r.id === 'PSYCHIC')).toBe(true);
  });

  it('DATA PROBLEM — RUINOUS ICON’s printed effect list is truncated out of the JSON', () => {
    const printed = actionOf(CARD.iconarch, ACT.ruinousIcon).text;
    // The text stops at its lead-in colon and jumps straight to the restriction line.
    expect(printed).toContain('Select one of the following effects to last until');
    expect(printed).toContain('(whichever comes first):');
    const afterColon = printed.slice(printed.indexOf('(whichever comes first):') + '(whichever comes first):'.length);
    expect(afterColon.trim()).toBe(
      'This operative cannot perform this action while within control range of an enemy operative.',
    );
    expect(REMINDER_ONLY[ACT.ruinousIcon]).toContain('truncated');
  });

  it('DATA PROBLEM — uniqueActions[].keywords is absent, though three actions print "PSYCHIC."', () => {
    const rawActions = (rawJson as unknown as { datacards: { uniqueActions: Record<string, unknown>[] }[] }).datacards
      .flatMap((c) => c.uniqueActions);
    expect(rawActions.length).toBe(5);
    for (const a of rawActions) expect(Object.keys(a)).toEqual(['id', 'name', 'ap', 'text']);
    expect(rawActions.filter((a) => String(a['text']).startsWith('PSYCHIC.')).length).toBe(3);
    expect(rawActions.filter((a) => String(a['text']).startsWith('SUPPORT.')).length).toBe(2);
  });

  it('DATA PROBLEM — notes[] and markerGuide are both empty though MALEFIC VORTEX places a marker', () => {
    expect(RAW.notes).toEqual([]);
    expect(RAW.markerGuide).toBe('');
    expect(actionOf(CARD.mindwitch, ACT.maleficVortex).text).toContain('Malefic Vortex marker');
  });

  it('DATA — the section overrun is repaired at load for the last strategy and firefight ploys', () => {
    // The committed JSON appends the whole following section to those two ploys.
    expect((rawJson as unknown as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain(
      'Firefight Ploys',
    );
    expect(ruleText(SP.sickeningAura)).not.toContain('Firefight Ploys');
    expect(ruleText(FP.unleashTheDaemon)).not.toContain('Faction Equipment');
  });
});

// ===========================================================================
describe('CHAOS CULT — selection', () => {
  it('the printed roster is a fixed 14 operatives and defaultRoster fields it legally', () => {
    const picks = defaultRoster(DATA);
    expect(picks.length).toBe(14);
    expect(RAW.selection.totalOperatives).toBe(14);
    const v = validateRosterFor(DATA, picks);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p.datacardId, (counts.get(p.datacardId) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      [CARD.demagogue]: 1,
      [CARD.blessedBlade]: 2,
      [CARD.devotee]: 9,
      [CARD.iconarch]: 1,
      [CARD.mindwitch]: 1,
    });
  });

  it('CHAOS MUTANT and CHAOS TORMENT have no selection row at all — they exist only through Mutation', () => {
    const rows = [...DATA.selection.leaderList, ...DATA.selection.list].map((e) => e.datacardId);
    expect(rows).not.toContain(CARD.mutant);
    expect(rows).not.toContain(CARD.torment);
    expect(defaultRoster(DATA).some((p) => p.datacardId === CARD.mutant || p.datacardId === CARD.torment)).toBe(false);
  });

  it('prints no selection constraints, so nothing is silently unenforced', () => {
    expect(RAW.selection.constraints).toEqual([]);
    expect(DATA.selection.leader.role).toBe('CULT DEMAGOGUE');
    expect(DATA.selection.leader.datacardId).toBe(CARD.demagogue);
  });

  it('rejects a kill team without its CULT DEMAGOGUE', () => {
    const picks = defaultRoster(DATA).filter((p) => p.datacardId !== CARD.demagogue);
    expect(validateRosterFor(DATA, picks).ok).toBe(false);
  });
});

// ===========================================================================
describe('Mutation (faction rule)', () => {
  it('is offered as a STRATEGIC GAMBIT and its allowance follows the printed table', () => {
    expect(ruleText(RULE.mutation)).toContain('TP1 = 2, TP2 = 2, TP3 = 3, TP4+ = 4');
    expect([1, 2, 3, 4, 5].map(mutateAllowance)).toEqual([2, 2, 3, 4, 4]);
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(MUTATE_GAMBIT);
  });

  it('turns a DEVOTEE into a MUTANT, keeping its id and letter — "it’s still the same operative"', () => {
    expect(ruleText(RULE.mutation)).toContain('It’s still the same operative for any rules it’s already been selected for');
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const before = { id: state.operatives[id]!.id, letter: state.operatives[id]!.letter };
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'mutant').ok).toBe(true);
    const after = state.operatives[id]!;
    expect(after.datacardId).toBe(CARD.mutant);
    expect([after.id, after.letter]).toEqual([before.id, before.letter]);
    expect(after.wounds).toBe(7);
  });

  it('"the new operative type loses a number of wounds equal to the lost wounds of its preceding type"', () => {
    expect(ruleText(RULE.mutation)).toContain(
      'The new operative type loses a number of wounds equal to the lost wounds of its preceding operative type',
    );
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    state.operatives[id]!.wounds = 3; // a DEVOTEE has 7 wounds, so 4 are lost
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'mutant').ok).toBe(true);
    expect(state.operatives[id]!.wounds).toBe(3); // MUTANT 7 - 4
    // …and again, MUTANT (7) -> TORMENT (13) with 4 lost.
    state.turningPoint = 2;
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'torment').ok).toBe(true);
    expect(state.operatives[id]!.datacardId).toBe(CARD.torment);
    expect(state.operatives[id]!.wounds).toBe(9); // TORMENT 13 - 4
  });

  it('"Each operative cannot MUTATE more than once per turning point"', () => {
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'mutant').ok).toBe(true);
    expect(mutatedThisTP(state, state.operatives[id]!)).toBe(true);
    const second = mutateOperative(ctx, state, state.operatives[id]!, 'torment');
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already MUTATED this turning point');
    state.turningPoint = 2;
    expect(mutatedThisTP(state, state.operatives[id]!)).toBe(false);
  });

  it('"You cannot have more than five MUTANT operatives and three TORMENT operatives at once"', () => {
    expect(ruleText(RULE.mutation)).toContain(
      'You cannot have more than five MUTANT operatives and three TORMENT operatives at once',
    );
    const { ctx, state } = setup();
    const devotees = idsOf(state, 'p1', CARD.devotee);
    for (let i = 0; i < 5; i++) expect(mutateOperative(ctx, state, state.operatives[devotees[i]!]!, 'mutant').ok).toBe(true);
    expect(mutateOptions(state, state.operatives[devotees[5]!]!)).toEqual(['wounds']);
    expect(mutateOperative(ctx, state, state.operatives[devotees[5]!]!, 'mutant').ok).toBe(false);
  });

  it('MUTANT → TORMENT is capped at twice per turning point', () => {
    expect(ruleText(RULE.mutation)).toContain('turn it into a TORMENT operative (max twice per turning point)');
    const { ctx, state } = setup();
    const devotees = idsOf(state, 'p1', CARD.devotee).slice(0, 3);
    for (const id of devotees) expect(mutateOperative(ctx, state, state.operatives[id]!, 'mutant').ok).toBe(true);
    state.turningPoint = 2;
    expect(mutateOperative(ctx, state, state.operatives[devotees[0]!]!, 'torment').ok).toBe(true);
    expect(mutateOperative(ctx, state, state.operatives[devotees[1]!]!, 'torment').ok).toBe(true);
    expect(mutateOptions(state, state.operatives[devotees[2]!]!)).toEqual(['wounds']);
  });

  it('"It can regain up to D3+1 lost wounds" rolls through the injected RNG', () => {
    expect(ruleText(RULE.mutation)).toContain('It can regain up to D3+1 lost wounds');
    const { ctx, state } = setup({ script: [6] }); // D3 = ceil(6/2) = 3, +1 = 4
    const id = idsOf(state, 'p1', CARD.demagogue)[0]!;
    state.operatives[id]!.wounds = 2;
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'wounds').ok).toBe(true);
    expect(state.operatives[id]!.wounds).toBe(6);
    expect(state.rolls.some((r) => r.kind === 'mutate')).toBe(true);
  });

  it('the STRATEGIC GAMBIT mutates the printed number on the deterministic default (D-016)', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: MUTATE_GAMBIT }, ctx);
    expect(out.ok).toBe(true);
    expect(idsOf(out.state, 'p1', CARD.mutant).length).toBe(2); // TP1 = 2
    expect(out.state.teams.p1.cp).toBe(state.teams.p1.cp); // a 0CP gambit
  });

  it('the gambit honours an explicit `data.mutations` list', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const chosen = idsOf(state, 'p1', CARD.devotee).slice(4, 6);
    const out = reduce(
      state,
      {
        t: 'UseGambit',
        player: 'p1',
        gambitId: MUTATE_GAMBIT,
        data: { mutations: chosen.map((operativeId) => ({ operativeId, choice: 'mutant' })) },
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(idsOf(out.state, 'p1', CARD.mutant).sort()).toEqual([...chosen].sort());
  });

  it('a DEVOTEE that incapacitates an enemy in its control range earns a MUTATE (applied at the activation boundary)', () => {
    expect(ruleText(RULE.mutation)).toContain(
      'Whenever a friendly DEVOTEE operative incapacitates an enemy operative within its control range, it can MUTATE',
    );
    const { ctx, state } = setup();
    const killer = idsOf(state, 'p1', CARD.devotee)[0]!;
    const victim = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [killer, victim]);
    place(state, killer, 10, 11);
    place(state, victim, 10.6, 11);
    state.operatives[victim]!.wounds = 1;
    let s = activate(ctx, state, killer, 'engage');
    expect(startFight(ctx, s, s.operatives[killer]!, 'Crude melee weapon', undefined, victim).ok).toBe(true);
    // A strike lands while the sequence is still in flight, which is exactly where the datacard
    // may not be swapped: the MUTATE is recorded and applied at the activation boundary.
    inflictDamage(ctx, s, s.operatives[victim]!, 5, 'attack');
    expect(s.operatives[victim]!.incapacitated).toBe(true);
    expect(s.operatives[killer]!.datacardId).toBe(CARD.devotee);
    expect(s.effects.some((e) => e.rule === 'chaos-cult.pendingMutation' && e.operativeId === killer)).toBe(true);
    delete (s as { sequence?: unknown }).sequence;
    s = reduce(s, { t: 'EndActivation', operativeId: killer }, ctx).state;
    expect(s.operatives[killer]!.datacardId).toBe(CARD.mutant);
    expect(PARTIAL[`${RULE.mutation}.killTrigger`]).toContain('advanceShoot');
  });

  it('the default mutation policy prefers DEVOTEE → MUTANT, then MUTANT → TORMENT, then healing', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    // Fill the MUTANT cap first, so the next gambit has to promote instead.
    const devotees = idsOf(state, 'p1', CARD.devotee);
    for (let i = 0; i < 5; i++) mutateOperative(ctx, state, state.operatives[devotees[i]!]!, 'mutant');
    state.turningPoint = 3;
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: MUTATE_GAMBIT }, ctx);
    expect(out.ok).toBe(true);
    expect(idsOf(out.state, 'p1', CARD.torment).length).toBe(2); // the printed "max twice per turning point"
    expect(out.state.log.some((l) => /Mutation: \d of up to 3/.test(l.text))).toBe(true);
  });

  it('a TORMENT’s 40mm base is placed as close as possible to the old centre', () => {
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [id]);
    place(state, id, 12, 11);
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'mutant').ok).toBe(true);
    state.turningPoint = 2;
    expect(mutateOperative(ctx, state, state.operatives[id]!, 'torment').ok).toBe(true);
    expect(state.operatives[id]!.pos).toEqual({ x: 12, y: 11 });
    expect(REMINDER_ONLY[`${RULE.mutation}.miniature`]).toContain('40mm');
  });
});

// ===========================================================================
describe('Accursed Gifts (faction rule)', () => {
  it('slices all six gifts out of the one printed faction rule, rule text only', () => {
    const whole = ruleText(RULE.accursedGifts);
    expect(GIFTS.length).toBe(6);
    for (const gift of GIFTS) {
      expect(whole).toContain(GIFT_NAME[gift]);
      expect(whole).toContain(GIFT_TEXT[gift]);
      // The flavour paragraph is dropped: no gift's rule text is its fluff.
      expect(GIFT_TEXT[gift].length).toBeGreaterThan(20);
    }
    expect(GIFT_TEXT.fleet).toBe('Add 1" to this operative’s Move stat.');
    expect(GIFT_TEXT.chitinous).toBe('Improve this operative’s Save stat by 1.');
  });

  it('the primary is selected the first time a DEVOTEE becomes a MUTANT', () => {
    expect(ruleText(RULE.accursedGifts)).toContain(
      'The first time a friendly DEVOTEE operative turns into a MUTANT operative during the battle, select your primary ACCURSED GIFT',
    );
    const { ctx, state } = setup();
    expect(giftsFor(state, 'p1').primary).toBeUndefined();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    expect(giftsFor(state, 'p1').primary).toBe('deformed-wings'); // the logged D-016 default
    expect(giftsOf(state, state.operatives[id]!)).toEqual(['deformed-wings']);
  });

  it('the secondary is selected the first time a MUTANT becomes a TORMENT, and a TORMENT has both', () => {
    expect(ruleText(RULE.accursedGifts)).toContain(
      'All friendly MUTANT operatives have your primary ACCURSED GIFT, and all friendly TORMENT operatives have your primary and secondary ACCURSED GIFTS',
    );
    const { ctx, state } = setup();
    setAccursedGift(state, 'p1', 'primary', 'fleet');
    const [a, b] = idsOf(state, 'p1', CARD.devotee);
    mutateOperative(ctx, state, state.operatives[a!]!, 'mutant');
    mutateOperative(ctx, state, state.operatives[b!]!, 'mutant');
    state.turningPoint = 2;
    mutateOperative(ctx, state, state.operatives[a!]!, 'torment', { secondaryGift: 'chitinous' });
    expect(giftsOf(state, state.operatives[a!]!)).toEqual(['fleet', 'chitinous']);
    expect(giftsOf(state, state.operatives[b!]!)).toEqual(['fleet']); // every MUTANT shares the primary
  });

  it('"You cannot select the same ACCURSED GIFT more than once per battle"', () => {
    expect(ruleText(RULE.accursedGifts)).toContain('You cannot select the same ACCURSED GIFT more than once per battle');
    const { state } = setup();
    expect(setAccursedGift(state, 'p1', 'primary', 'horned').ok).toBe(true);
    const again = setAccursedGift(state, 'p1', 'secondary', 'horned');
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('more than once per battle');
    expect(availableGifts(state, 'p1')).not.toContain('horned');
  });

  it('2. Fleet — "Add 1" to this operative’s Move stat."', () => {
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    setAccursedGift(state, 'p1', 'primary', 'fleet');
    const before = moveOf(ctx, state, state.operatives[id]!);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    expect(moveOf(ctx, state, state.operatives[id]!)).toBe(before + 1);
  });

  it('3. Chitinous — "Improve this operative’s Save stat by 1."', () => {
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    setAccursedGift(state, 'p1', 'primary', 'chitinous');
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    expect(saveOf(ctx, state, state.operatives[id]!)).toBe(4); // printed 5+
  });

  it('4. Horned — a Charge gores one enemy in control range (1 damage, D3 for a TORMENT)', () => {
    expect(GIFT_TEXT.horned).toContain('you can inflict 1 damage on one enemy operative within its control range');
    const { ctx, state } = setup();
    setAccursedGift(state, 'p1', 'primary', 'horned');
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 12, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    let s = activate(ctx, state, id, 'engage');
    const before = s.operatives[foe]!.wounds;
    const charged = act(ctx, s, id, 'Charge', { path: { points: [{ x: 10, y: 11 }, { x: 11.1, y: 11 }] } });
    expect(charged.ok).toBe(true);
    s = reduce(charged.state, { t: 'EndActivation', operativeId: id }, ctx).state;
    expect(s.operatives[foe]!.wounds).toBe(before - 1);
    expect(PARTIAL[`${RULE.accursedGifts}.horned`]).toContain('end of an action');
  });

  it('5. Sinewed — melee weapons gain Brutal and ignore the injured Hit change', () => {
    expect(GIFT_TEXT.sinewed).toContain('This operative’s melee weapons have the Brutal weapon rule');
    const { ctx, state } = setup();
    setAccursedGift(state, 'p1', 'primary', 'sinewed');
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 10.6, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const op = state.operatives[id]!;
    const profile = profileOf(CARD.mutant, 'Blasphemous appendages');
    const rules = effectiveRules(ctx, state, profile, { operative: op, weaponName: 'Blasphemous appendages' });
    expect(rules.some((r) => r.id === 'Brutal')).toBe(true);
    // Injured: hitOf would worsen by 1; inside a fight the gift cancels it exactly.
    op.wounds = 2;
    expect(startFight(ctx, state, op, 'Blasphemous appendages', undefined, foe).ok).toBe(true);
    expect(hitOf(ctx, state, op, profile)).toBe(profile.hit);
  });

  it('6. Barbed — enemy operatives cannot assist, and the first strike splashes the rest', () => {
    expect(GIFT_TEXT.barbed).toContain('Enemy operatives cannot assist.');
    const { ctx, state } = setup();
    setAccursedGift(state, 'p1', 'primary', 'barbed');
    const barbed = idsOf(state, 'p1', CARD.devotee)[0]!;
    const [foeA, foeB, foeC] = idsOf(state, 'p2', CARD.devotee);
    isolate(state, [barbed, foeA!, foeB!, foeC!]);
    place(state, barbed, 10, 11);
    place(state, foeA!, 10.6, 11);
    place(state, foeB!, 10, 11.6);
    place(state, foeC!, 9.4, 11);
    mutateOperative(ctx, state, state.operatives[barbed]!, 'mutant');
    const s = activate(ctx, state, foeA!, 'engage');
    expect(startFight(ctx, s, s.operatives[foeA!]!, 'Crude melee weapon', undefined, barbed).ok).toBe(true);
    // Two other enemies are within control range of the barbed MUTANT and would assist; Barbed
    // cancels that (the Hearthkyn Brawler seam) — the fight's dice were rolled at the printed Hit.
    const seq = s.sequence as FightSequence;
    expect(seq.attackerAssists).toBeGreaterThan(0);
    const woundsBefore = [foeB!, foeC!].map((id) => s.operatives[id]!.wounds);
    advanceFight(ctx, s);
    const done = settle(ctx, s);
    expect(done.log.some((l) => /Barbed: enemy operatives cannot assist/.test(l.text))).toBe(true);
    const woundsAfter = [foeB!, foeC!].map((id) => done.operatives[id]!.wounds);
    expect(woundsAfter.some((w, i) => w < woundsBefore[i]!)).toBe(true);
  });

  it('1. Deformed Wings — four sibling move actions (D-021) that refund the vertical distance', () => {
    expect(GIFT_TEXT['deformed-wings']).toContain('you can treat the vertical distance as 2"');
    for (const id of [WINGS_REPOSITION, WINGS_DASH, WINGS_CHARGE, WINGS_FALL_BACK]) {
      const def = getAction(id)!;
      expect(def).toBeDefined();
      expect(def.treatedAs).toBeDefined();
    }
    const { ctx, state } = setup({ map: WINGS_MAP() });
    setAccursedGift(state, 'p1', 'primary', 'deformed-wings');
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [id]);
    place(state, id, 13, 8.5);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const s = activate(ctx, state, id, 'engage');
    // The path costs 7" (a 3" climb, then 1" and 3" along the platform); the MUTANT's Move
    // stat is 6", so the universal Reposition cannot afford it and treating the climb as 2" can.
    expect(getAction('Reposition')!.check(ctx, s, s.operatives[id]!, { path: WINGS_PATH }).ok).toBe(false);
    expect(getAction(WINGS_REPOSITION)!.check(ctx, s, s.operatives[id]!, { path: WINGS_PATH }).ok).toBe(true);
    const out = act(ctx, s, id, WINGS_REPOSITION, { path: WINGS_PATH });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.z).toBe(3);
    expect(out.state.operatives[id]!.pos).toEqual({ x: 13, y: 12.2 });
    expect(out.state.operatives[id]!.actionsThisActivation).toContain('Reposition');
  });

  it('Deformed Wings refuses a move with no climb or drop to ignore', () => {
    const { ctx, state } = setup();
    setAccursedGift(state, 'p1', 'primary', 'deformed-wings');
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [id]);
    place(state, id, 10, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const s = activate(ctx, state, id, 'engage');
    const r = getAction(WINGS_REPOSITION)!.check(ctx, s, s.operatives[id]!, {
      path: { points: [{ x: 10, y: 11 }, { x: 12, y: 11 }] },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no climb up or drop');
  });
});

// ===========================================================================
describe('Datacard abilities', () => {
  it('BLESSED BLADE › Cut Them Down inflicts D3+1 on an enemy that falls back (2D3+2 for two blades)', () => {
    expect(abilityText(CARD.blessedBlade, AB.cutThemDown)).toContain('inflict D3+1 damage on that enemy operative');
    const { ctx, state } = setup({ script: [4] }); // D3 = 2 -> 3 damage
    const blade = idsOf(state, 'p1', CARD.blessedBlade)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [blade, foe]);
    place(state, blade, 10, 11);
    place(state, foe, 10.6, 11);
    const before = state.operatives[foe]!.wounds;
    let s = activate(ctx, state, foe, 'engage');
    const moved = act(ctx, s, foe, 'Fall Back', { path: { points: [{ x: 10.6, y: 11 }, { x: 15, y: 11 }] } });
    expect(moved.ok).toBe(true);
    s = reduce(moved.state, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.operatives[foe]!.wounds).toBe(before - 3);
    expect(PARTIAL[`${AB.cutThemDown}.timing`]).toContain('before it moves');
  });

  it('Cut Them Down does not fire when the enemy did not Fall Back', () => {
    const { ctx, state } = setup();
    const blade = idsOf(state, 'p1', CARD.blessedBlade)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [blade, foe]);
    place(state, blade, 10, 11);
    place(state, foe, 10.6, 11);
    const before = state.operatives[foe]!.wounds;
    let s = activate(ctx, state, foe, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.operatives[foe]!.wounds).toBe(before);
  });

  it('ICONARCH › Icon Bearer treats its APL as 1 higher when determining marker control', () => {
    expect(abilityText(CARD.iconarch, AB.iconBearer)).toContain('treat this operative’s APL stat as 1 higher');
    const { ctx, state } = setup();
    const icon = idsOf(state, 'p1', CARD.iconarch)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [icon, foe]);
    const marker = Object.values(state.markers)[0]!;
    place(state, icon, marker.pos.x + 0.6, marker.pos.y);
    place(state, foe, marker.pos.x - 0.6, marker.pos.y);
    // Both are APL 2 and contest it; the Icon Bearer's +1 breaks the tie.
    expect(aplOf(ctx, state, state.operatives[icon]!)).toBe(2);
    expect(markerController(ctx, state, marker)).toBe('p1');
  });

  it('CHAOS MUTANT › Accursed Mutant bans unique actions and charges 1 extra AP for Pick Up Marker', () => {
    expect(abilityText(CARD.mutant, AB.accursedMutant)).toContain('This operative cannot perform unique actions');
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const op = state.operatives[id]!;
    expect(actionCost(ctx, state, op, getAction('Pick Up Marker')!)).toBe(2);
    expect(actionCost(ctx, state, op, getAction('Operate Hatch')!)).toBe(getAction('Operate Hatch')!.ap);
    const ev = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: op,
      action: ACT.maleficVortex,
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
  });

  it('CHAOS TORMENT › Accursed Torment bans Pick Up Marker, unique and mission actions but not Operate Hatch', () => {
    expect(abilityText(CARD.torment, AB.accursedTorment)).toContain(
      'perform the Pick Up Marker, unique or mission actions (excluding Operate Hatch)',
    );
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.turningPoint = 2;
    mutateOperative(ctx, state, state.operatives[id]!, 'torment');
    const op = state.operatives[id]!;
    const ask = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    expect(ask('Pick Up Marker')).toBe(false);
    expect(ask('Operate Hatch')).toBe(true);
    expect(ask('Fight')).toBe(true);
    expect(REMINDER_ONLY[`${AB.accursedTorment}.melee`]).toContain('grantedWeapons');
  });

  it('Unnatural Regeneration subtracts 1 from an attack dice of 3+ on a 5+', () => {
    expect(abilityText(CARD.mutant, AB.mutantRegeneration)).toBe(
      abilityText(CARD.torment, AB.tormentRegeneration),
    );
    const { ctx, state } = setup({ script: [6] }); // the D6 shrug
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.blessedBlade)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 10.6, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    // A melee strike IS one attack dice, so `amount` is exactly the weapon's Dmg.
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe,
      defenderId: id,
      attackerWeapon: 'Commune blade',
      defenderWeapon: 'Blasphemous appendages',
      attackerPool: newPool(),
      defenderPool: newPool(),
      attackerAssists: 0,
      defenderAssists: 0,
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
    } as unknown as FightSequence;
    const before = state.operatives[id]!.wounds;
    inflictDamage(ctx, state, state.operatives[id]!, 4, 'attack');
    expect(state.operatives[id]!.wounds).toBe(before - 3);
    expect(state.rolls.some((r) => r.kind === 'regeneration')).toBe(true);
  });

  it('Unnatural Regeneration does not roll for damage below 3', () => {
    const { ctx, state } = setup({ script: [6] });
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: idsOf(state, 'p2', CARD.devotee)[0]!,
      defenderId: id,
      attackerWeapon: 'Crude melee weapon',
      attackerPool: newPool(),
      defenderPool: newPool(),
      attackerAssists: 0,
      defenderAssists: 0,
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
    } as unknown as FightSequence;
    const before = state.operatives[id]!.wounds;
    inflictDamage(ctx, state, state.operatives[id]!, 2, 'attack');
    expect(state.operatives[id]!.wounds).toBe(before - 2);
    expect(state.rolls.some((r) => r.kind === 'regeneration')).toBe(false);
  });

  it('CHAOS TORMENT › Brute lifts Light cover for targeting but keeps the cover save', () => {
    expect(abilityText(CARD.torment, AB.brute)).toContain('it cannot use Light terrain for cover');
    const { ctx } = setup();
    const reg = hooksFor(ctx, 'p1');
    const { state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.turningPoint = 2;
    mutateOperative(ctx, state, state.operatives[id]!, 'torment');
    const torment = state.operatives[id]!;
    torment.order = 'conceal';
    const ev = reg.emit('onValidTarget', state, {
      state,
      attacker: state.operatives[idsOf(state, 'p2', CARD.devotee)[0]!]!,
      target: torment,
      valid: false,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('light');
  });

  it('Group Activation and Attuned In Purpose record the pairing as an effect (the Breach and Clear partial)', () => {
    expect(abilityText(CARD.devotee, AB.groupActivation)).toContain(
      'you must then activate one other ready friendly CHAOS CULT DEVOTEE operative',
    );
    const { ctx, state } = setup();
    const [a, b] = idsOf(state, 'p1', CARD.devotee);
    let s = activate(ctx, state, a!, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: a! }, ctx).state;
    const paired = s.effects.find((e) => e.rule === 'chaos-cult.groupActivation');
    expect(paired).toBeDefined();
    expect(paired!.operativeId).not.toBe(a);
    expect(s.operatives[paired!.operativeId!]!.datacardId).toBe(CARD.devotee);
    expect(idsOf(s, 'p1', CARD.devotee)).toContain(b);
    expect(REMINDER_ONLY[`${AB.groupActivation}.pairing`]).toContain('activePlayer');

    const blades = idsOf(state, 'p1', CARD.blessedBlade);
    isolate(state, blades);
    place(state, blades[0]!, 10, 11);
    place(state, blades[1]!, 12, 11);
    const t = activate(ctx, state, blades[0]!, 'engage');
    expect(t.effects.some((e) => e.rule === 'chaos-cult.groupActivation' && e.operativeId === blades[1])).toBe(true);
    expect(REMINDER_ONLY[`${AB.attunedInPurpose}.pairing`]).toContain('Breach and Clear');
  });
});

// ===========================================================================
describe('Unique actions', () => {
  it('INCITE SLAUGHTER grants a free Fight to one other friendly CHAOS CULT operative within 9"', () => {
    const printed = actionOf(CARD.demagogue, ACT.inciteSlaughter);
    expect(printed.ap).toBe(1);
    expect(printed.text).toContain('can immediately perform a free Fight action');
    const { ctx, state } = setup();
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const mate = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [boss, mate]);
    place(state, boss, 10, 11);
    place(state, mate, 14, 11);
    const s = activate(ctx, state, boss, 'engage');
    const out = act(ctx, s, boss, ACT.inciteSlaughter, { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    // "a free Fight action" is AP outside the recipient's APL budget, not an APL stat change
    // (docs/DECISIONS.md D-100) — the APL stat is untouched and only the AP gate sees the extra.
    expect(out.state.operatives[mate]!.aplMods).toEqual([]);
    expect(aplOf(ctx, out.state, out.state.operatives[mate]!)).toBe(2);
    expect(freeApOf(out.state, out.state.operatives[mate]!)).toBe(1);
    expect(apBudgetOf(ctx, out.state, out.state.operatives[mate]!)).toBe(3);
    const free = out.state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === mate);
    expect(free?.data?.['only']).toEqual(['Fight', FIGHT_DAEMON]);
  });

  it('INCITE SLAUGHTER refuses an enemy target and a target out of the printed 9"', () => {
    const { ctx, state } = setup();
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    const far = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [boss, foe, far]);
    place(state, boss, 4, 11);
    place(state, foe, 6, 11);
    place(state, far, 24, 11);
    const def = getAction(ACT.inciteSlaughter)!;
    expect(def.check(ctx, state, state.operatives[boss]!, { targetOperativeId: foe }).ok).toBe(false);
    expect(def.check(ctx, state, state.operatives[boss]!, { targetOperativeId: far }).ok).toBe(false);
  });

  it('INCITE URGENCY caps the granted Charge at 3"', () => {
    expect(actionOf(CARD.demagogue, ACT.inciteUrgency).text).toContain('it cannot move more than 3"');
    const { ctx, state } = setup();
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const mate = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [boss, mate]);
    place(state, boss, 10, 11);
    place(state, mate, 13, 11);
    const s = activate(ctx, state, boss, 'engage');
    const out = act(ctx, s, boss, ACT.inciteUrgency, { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    const free = out.state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === mate);
    expect(free?.data?.['only']).toContain('Charge');
    const capped = out.state.effects.find(
      (e) => e.rule === 'chaos-cult.inciteUrgencyCharge' && e.operativeId === mate,
    );
    expect(capped).toBeDefined();
    const ev = ctx.hooks.emit('onMoveDistance', out.state, {
      state: out.state,
      operative: out.state.operatives[mate]!,
      action: 'Charge',
      inches: 8,
    });
    expect(ev.inches).toBe(3);
  });

  it('both SUPPORT actions refuse to be performed while engaged, as printed', () => {
    for (const id of [ACT.inciteSlaughter, ACT.inciteUrgency]) {
      expect(actionOf(CARD.demagogue, id).text).toContain(
        'This operative cannot perform this action while within control range of an enemy operative',
      );
    }
    const { ctx, state } = setup();
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    const mate = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [boss, foe, mate]);
    place(state, boss, 10, 11);
    place(state, foe, 10.6, 11);
    place(state, mate, 12, 11);
    for (const id of [ACT.inciteSlaughter, ACT.inciteUrgency]) {
      const r = getAction(id)!.check(ctx, state, state.operatives[boss]!, { targetOperativeId: mate });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('control range');
    }
  });

  it('HEINOUS DELUGE subtracts 1 APL from a valid enemy target until the end of its next activation', () => {
    expect(actionOf(CARD.mindwitch, ACT.heinousDeluge).text).toContain('subtract 1 from its APL stat');
    const { ctx, state } = setup();
    const witch = idsOf(state, 'p1', CARD.mindwitch)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [witch, foe]);
    place(state, witch, 10, 11);
    place(state, foe, 14, 11); // within the Infernal gaze's Range 6"
    const before = aplOf(ctx, state, state.operatives[foe]!);
    const s = activate(ctx, state, witch, 'engage');
    const out = act(ctx, s, witch, ACT.heinousDeluge, { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[foe]!)).toBe(before - 1);
  });

  it('HEINOUS DELUGE refuses an enemy that is not a valid target (out of Range 6")', () => {
    const { ctx, state } = setup();
    const witch = idsOf(state, 'p1', CARD.mindwitch)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [witch, foe]);
    place(state, witch, 4, 11);
    place(state, foe, 24, 11);
    expect(getAction(ACT.heinousDeluge)!.check(ctx, state, state.operatives[witch]!, { targetOperativeId: foe }).ok).toBe(
      false,
    );
  });

  it('MALEFIC VORTEX places one marker, damages enemies within 2" and does so again each Ready step', () => {
    const printed = actionOf(CARD.mindwitch, ACT.maleficVortex).text;
    expect(printed).toContain('Inflict 1 damage on each enemy operative within 2" of that marker');
    expect(printed).toContain('in the Ready step of each Strategy phase');
    const { ctx, state } = setup();
    const witch = idsOf(state, 'p1', CARD.mindwitch)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [witch, foe]);
    place(state, witch, 10, 11);
    place(state, foe, 14, 11);
    const before = state.operatives[foe]!.wounds;
    const s = activate(ctx, state, witch, 'engage');
    const out = act(ctx, s, witch, ACT.maleficVortex, { markerPos: { x: 14, y: 11 } });
    expect(out.ok).toBe(true);
    expect(out.state.markers[VORTEX_MARKER('p1')]).toBeDefined();
    expect(out.state.operatives[foe]!.wounds).toBe(before - 1);
    // The Ready step half.
    const ready = ctx.hooks.emit('onReadyStep', out.state, { state: out.state, player: 'p1', cp: 1 });
    expect(ready.state.operatives[foe]!.wounds).toBe(before - 2);
  });

  it('MALEFIC VORTEX removes the previous marker before placing the new one', () => {
    expect(actionOf(CARD.mindwitch, ACT.maleficVortex).text).toContain(
      'Remove your Malefic Vortex marker from the killzone (if any)',
    );
    const { ctx, state } = setup();
    const witch = idsOf(state, 'p1', CARD.mindwitch)[0]!;
    isolate(state, [witch]);
    place(state, witch, 10, 11);
    let s = activate(ctx, state, witch, 'engage');
    s = act(ctx, s, witch, ACT.maleficVortex, { markerPos: { x: 11, y: 11 } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: witch }, ctx).state;
    s.operatives[witch]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, witch, 'engage');
    s = act(ctx, s, witch, ACT.maleficVortex, { markerPos: { x: 12, y: 11 } }).state;
    const vortexes = Object.values(s.markers).filter((m) => m.flags['maleficVortex']);
    expect(vortexes.length).toBe(1);
    expect(vortexes[0]!.pos.x).toBe(12);
  });

  it('RUINOUS ICON is registered with its printed restriction, but its effect list is missing from the data', () => {
    const printed = actionOf(CARD.iconarch, ACT.ruinousIcon);
    expect(printed.ap).toBe(1);
    expect(printed.text.startsWith('PSYCHIC.')).toBe(true);
    const { ctx, state } = setup();
    const icon = idsOf(state, 'p1', CARD.iconarch)[0]!;
    isolate(state, [icon]);
    place(state, icon, 10, 11);
    const s = activate(ctx, state, icon, 'engage');
    const out = act(ctx, s, icon, ACT.ruinousIcon, {});
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === 'chaos-cult.ruinousIcon' && e.operativeId === icon)).toBe(true);
    expect(out.state.log.some((l) => l.data?.['dataBlocked'] === true)).toBe(true);
  });
});

// ===========================================================================
describe('Strategy ploys', () => {
  it('EXALTATION IN PAIN ignores the injured Hit change and offers a defence re-roll', () => {
    const printed = ruleText(SP.exaltationInPain);
    expect(printed).toContain('You can ignore any changes to the Hit stat of friendly CHAOS CULT operatives');
    expect(printed).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const op = state.operatives[id]!;
    op.wounds = 2; // injured (7 wounds printed)
    const profile = profileOf(CARD.devotee, 'Pistol');
    expect(hitOf(ctx, state, op, profile)).toBe(profile.hit + 1);
    state.teams.p1.gambitsUsedTP.push(SP.exaltationInPain);
    expect(hitOf(ctx, state, op, profile)).toBe(profile.hit);

    const foe = state.operatives[idsOf(state, 'p2', CARD.devotee)[0]!]!;
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: meleeCtx(foe, op, profile, 'Pistol'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('chaos-cult.exaltation');
  });

  it('FERVENT ONSLAUGHT gives melee weapons Accurate 1, or Accurate 2 for a MUTANT or TORMENT', () => {
    expect(ruleText(SP.ferventOnslaught)).toContain(
      'or the Accurate 2 weapon rule if that friendly operative is a MUTANT or TORMENT operative',
    );
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.ferventOnslaught);
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const crude = profileOf(CARD.devotee, 'Crude melee weapon');
    const before = effectiveRules(ctx, state, crude, {
      operative: state.operatives[id]!,
      weaponName: 'Crude melee weapon',
    });
    expect(before.filter((r) => r.id === 'Accurate').map((r) => r.x)).toEqual([1]);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const appendages = profileOf(CARD.mutant, 'Blasphemous appendages');
    const after = effectiveRules(ctx, state, appendages, {
      operative: state.operatives[id]!,
      weaponName: 'Blasphemous appendages',
    });
    expect(after.filter((r) => r.id === 'Accurate').map((r) => r.x)).toEqual([2]);
  });

  it('FERVENT ONSLAUGHT does not touch a ranged weapon', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.ferventOnslaught);
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const pistol = profileOf(CARD.devotee, 'Pistol');
    const rules = effectiveRules(ctx, state, pistol, { operative: state.operatives[id]!, weaponName: 'Pistol' });
    expect(rules.some((r) => r.id === 'Accurate')).toBe(false);
  });

  it('CREATURES OF NIGHTMARE lowers the contesting enemies’ total APL by 1', () => {
    expect(ruleText(SP.creaturesOfNightmare)).toContain('treat the total APL stat of enemy operatives that contest it as 1 lower');
    const { ctx, state } = setup();
    const marker = Object.values(state.markers)[0]!;
    const mutant = idsOf(state, 'p1', CARD.devotee)[0]!;
    const holder = idsOf(state, 'p1', CARD.devotee)[1]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [mutant, holder, foe]);
    place(state, foe, marker.pos.x + 0.6, marker.pos.y);
    place(state, holder, marker.pos.x - 0.6, marker.pos.y);
    place(state, mutant, marker.pos.x + 2.6, marker.pos.y);
    mutateOperative(ctx, state, state.operatives[mutant]!, 'mutant');
    expect(markerController(ctx, state, marker)).toBeNull(); // 2 APL each
    state.teams.p1.gambitsUsedTP.push(SP.creaturesOfNightmare);
    expect(markerController(ctx, state, marker)).toBe('p1');
  });

  it('SICKENING AURA worsens a nearby enemy’s Hit by 1, and is not cumulative with being injured', () => {
    expect(ruleText(SP.sickeningAura)).toContain('This isn’t cumulative with being injured');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.sickeningAura);
    const mutant = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [mutant, foe]);
    place(state, mutant, 10, 11);
    place(state, foe, 11.5, 11);
    mutateOperative(ctx, state, state.operatives[mutant]!, 'mutant');
    const profile = profileOf(CARD.devotee, 'Pistol');
    expect(hitOf(ctx, state, state.operatives[foe]!, profile)).toBe(profile.hit + 1);
    // Injured already worsens by 1 — the aura adds nothing on top.
    state.operatives[foe]!.wounds = 2;
    expect(hitOf(ctx, state, state.operatives[foe]!, profile)).toBe(profile.hit + 1);
  });
});

// ===========================================================================
describe('Firefight ploys', () => {
  it('FAITHFUL FOLLOWER substitutes a non-DARK COMMUNE operative for the DARK COMMUNE target', () => {
    const printed = ruleText(FP.faithfulFollower);
    expect(printed).toContain('to become the valid target or to be fought against (as appropriate) instead');
    const { ctx, state } = setup();
    state.teams.p1.ploysUsedTP.push(FP.faithfulFollower);
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const shield = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [boss, shield, foe]);
    place(state, boss, 12, 11);
    place(state, shield, 13, 11);
    place(state, foe, 16, 11);
    const started = startShoot(ctx, state, state.operatives[foe]!, 'Pistol', undefined, boss);
    expect(started.ok).toBe(true);
    expect((state.sequence as ShootSequence).targetId).toBe(shield);
    expect(REMINDER_ONLY[`${FP.faithfulFollower}.fight`]).toContain('startFight');
  });

  it('FAITHFUL FOLLOWER "has no effect if … the ranged weapon has the Blast or Torrent weapon rule"', () => {
    expect(ruleText(FP.faithfulFollower)).toContain(
      'This ploy has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule',
    );
    const { ctx, state } = setup();
    state.teams.p1.ploysUsedTP.push(FP.faithfulFollower);
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const shield = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.iconarch)[0]!; // Burning censer: Torrent 2"
    isolate(state, [boss, shield, foe]);
    place(state, boss, 12, 11);
    place(state, shield, 13, 11);
    place(state, foe, 16.5, 11);
    const started = startShoot(ctx, state, state.operatives[foe]!, 'Burning censer', undefined, boss);
    expect(started.ok).toBe(true);
    expect((state.sequence as ShootSequence).targetId).toBe(boss);
  });

  it('ABHORRENT MUTATION gives the activated operative an extra ACCURSED GIFT, once each per battle', () => {
    const printed = ruleText(FP.abhorrentMutation);
    expect(printed).toContain('Select an ACCURSED GIFT for that operative to gain');
    expect(printed).toContain('Each friendly operative cannot be selected for this ploy more than once per battle');
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const s = activate(ctx, state, id, 'engage');
    const out = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.abhorrentMutation, data: { gift: 'fleet' } }, ctx);
    expect(out.ok).toBe(true);
    expect(giftsOf(out.state, out.state.operatives[id]!)).toEqual(['fleet']);
    expect(moveOf(ctx, out.state, out.state.operatives[id]!)).toBe(7);
    // …and it survives the operative turning into a different one.
    mutateOperative(ctx, out.state, out.state.operatives[id]!, 'mutant');
    expect(hasGift(out.state, out.state.operatives[id]!, 'fleet')).toBe(true);
    // Second use on the same operative is refused by `usable`.
    out.state.teams.p1.ploysUsedTP = [];
    const again = reduce(out.state, { t: 'UsePloy', player: 'p1', ployId: FP.abhorrentMutation }, ctx);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('already been selected');
  });

  it('ABHORRENT MUTATION refuses a DARK COMMUNE operative', () => {
    expect(ruleText(FP.abhorrentMutation)).toContain('friendly CHAOS CULT operative (excluding DARK COMMUNE)');
    const { ctx, state } = setup();
    const boss = idsOf(state, 'p1', CARD.demagogue)[0]!;
    const s = activate(ctx, state, boss, 'engage');
    const out = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.abhorrentMutation }, ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('excluding DARK COMMUNE');
  });

  it('FRENZIED DEMISE is declared in advance and fires when a MUTANT is incapacitated', () => {
    expect(ruleText(FP.frenziedDemise)).toContain(
      'Inflict D3 damage (or D6 damage instead if that friendly operative is a TORMENT)',
    );
    const { ctx, state } = setup({ script: [4] }); // D3 = 2
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 11, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const used = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.frenziedDemise }, ctx);
    expect(used.ok).toBe(true);
    const before = used.state.operatives[foe]!.wounds;
    inflictDamage(ctx, used.state, used.state.operatives[id]!, 99, 'other');
    expect(used.state.operatives[foe]!.wounds).toBe(before - 2);
    expect(PARTIAL[FP.frenziedDemise]).toContain('declared in advance');
  });

  it('FRENZIED DEMISE rolls a D6 instead when the dying operative is a TORMENT', () => {
    const { ctx, state } = setup({ script: [5] });
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 11.2, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.turningPoint = 2;
    mutateOperative(ctx, state, state.operatives[id]!, 'torment');
    const used = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.frenziedDemise }, ctx);
    const before = used.state.operatives[foe]!.wounds;
    inflictDamage(ctx, used.state, used.state.operatives[id]!, 99, 'other');
    expect(used.state.operatives[foe]!.wounds).toBe(before - 5); // the raw D6, not a D3
  });

  it('FRENZIED DEMISE cannot be used without a MUTANT or TORMENT in the killzone', () => {
    const { ctx, state } = setup();
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.frenziedDemise }, ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('MUTANT or CHAOS CULT TORMENT');
  });

  it('UNLEASH THE DAEMON grants a second, free Fight action', () => {
    expect(ruleText(FP.unleashTheDaemon)).toContain('that operative can perform two Fight actions, and one of them can be free');
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 10.6, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    let s = activate(ctx, state, id, 'engage');
    const aplBefore = aplOf(ctx, s, s.operatives[id]!);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.unleashTheDaemon }, ctx).state;
    // "one of them can be free": the second Fight is paid for with AP outside the APL budget
    // (docs/DECISIONS.md D-100), so the APL stat does not move and the budget does.
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(aplBefore);
    expect(apBudgetOf(ctx, s, s.operatives[id]!)).toBe(aplBefore + 1);
    // Pretend the first Fight has resolved: the second Fight is a separate ActionDef with its
    // own restriction key, so action restrictions do not refuse it.
    s.operatives[id]!.actionsThisActivation.push('Fight');
    s.operatives[id]!.apSpent = 1;
    const def = getAction(FIGHT_DAEMON)!;
    expect(def.available!(ctx, s, s.operatives[id]!)).toBe(true);
    expect(def.check(ctx, s, s.operatives[id]!, {}).ok).toBe(true);
    const second = act(ctx, s, id, FIGHT_DAEMON, {});
    expect(second.ok).toBe(true);
    expect(second.state.operatives[id]!.apSpent).toBe(2); // the printed "one of them can be free"
  });

  it('Accursed Mutant and Accursed Torment do not ban this module’s own Fight carve-out', () => {
    // "This operative cannot perform unique actions" is about the printed datacard actions, not
    // about a second Fight the engine can only express as its own ActionDef (D-021).
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const ask = (op: OperativeState): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action: FIGHT_DAEMON, allowed: true }).allowed;
    expect(ask(state.operatives[id]!)).toBe(true);
    expect(actionCost(ctx, state, state.operatives[id]!, getAction(FIGHT_DAEMON)!)).toBe(1);
    state.turningPoint = 2;
    mutateOperative(ctx, state, state.operatives[id]!, 'torment');
    expect(ask(state.operatives[id]!)).toBe(true);
  });

  it('Fight (Unleash the Daemon) refuses an operative the ploy was not used on', () => {
    const { ctx, state } = setup();
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 10.6, 11);
    const s = activate(ctx, state, id, 'engage');
    const def = getAction(FIGHT_DAEMON)!;
    expect(def.available!(ctx, s, s.operatives[id]!)).toBe(false);
    expect(def.check(ctx, s, s.operatives[id]!, {}).ok).toBe(false);
  });
});

// ===========================================================================
describe('Faction equipment', () => {
  it('BALEFUL SCRIPT is a once-per-battle STRATEGIC GAMBIT that changes one ACCURSED GIFT', () => {
    expect(ruleText(EQ.balefulScript)).toContain('Once per battle STRATEGIC GAMBIT. Change one of your ACCURSED GIFTS');
    const { ctx, state } = setup({ equipment: [EQ.balefulScript] });
    setAccursedGift(state, 'p1', 'primary', 'fleet');
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.balefulScript);
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: EQ.balefulScript, data: { slot: 'primary', gift: 'chitinous' } },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(giftsFor(out.state, 'p1').primary).toBe('chitinous');
    out.state.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, out.state, 'p1').map((o) => o.id)).not.toContain(EQ.balefulScript);
    expect(REMINDER_ONLY[`${EQ.balefulScript}.perOperative`]).toContain('Abhorrent Mutation');
  });

  it('COVERT GUISES rolls a D3 on reveal and grants that many free Repositions in TP1', () => {
    expect(ruleText(EQ.covertGuises)).toContain('After revealing this equipment option, roll one D3');
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [6] }); // D3 = 3
    expect(state.effects.some((e) => e.rule === 'chaos-cult.covertGuisesD3' && e.player === 'p1')).toBe(true);
    for (const id of idsOf(state, 'p1', CARD.devotee)) place(state, id, 3, 4 + (idsOf(state, 'p1', CARD.devotee).indexOf(id) % 8) * 2);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.covertGuises);
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.covertGuises }, ctx);
    expect(out.ok).toBe(true);
    const granted = out.state.effects.filter((e) => e.rule === 'teamFreeAction' && e.source.id === EQ.covertGuises);
    expect(granted.length).toBe(3);
    expect(REMINDER_ONLY[`${EQ.covertGuises}.dropZone`]).toContain('ENDS');
  });

  it('UNHOLY TALISMAN retains one normal defence success as a critical, once per turning point', () => {
    expect(ruleText(EQ.unholyTalisman)).toContain(
      'you can retain one of your normal successes as a critical success instead',
    );
    const { ctx, state } = setup({ equipment: [EQ.unholyTalisman] });
    const target = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.devotee)[0]!;
    isolate(state, [target, foe]);
    place(state, target, 10, 11);
    place(state, foe, 14, 11);
    const seq: ShootSequence = {
      kind: 'shoot',
      step: 'defenceRerolls',
      attackerId: foe,
      targetId: target,
      weaponName: 'Pistol',
      queue: [],
      resolvedTargets: [],
      secondary: false,
      pointBlank: false,
      inCover: false,
      obscured: false,
      coverChoiceMade: true,
      vantageAccurate: 0,
      vantageImprovedCover: false,
      attack: newPool(),
      defence: pool([5, 2, 3], 5),
      usedRerolls: [],
      usedRetention: [],
      damage: 0,
      useCounted: false,
      attacker: 'p2',
      defender: 'p1',
      free: false,
    } as unknown as ShootSequence;
    state.sequence = seq;
    const profile = profileOf(CARD.devotee, 'Pistol');
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: meleeCtx(state.operatives[foe]!, state.operatives[target]!, profile, 'Pistol'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.filter((d) => d.state === 'crit').length).toBe(1);
    // Once per turning point: a second emit changes nothing.
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: meleeCtx(state.operatives[foe]!, state.operatives[target]!, profile, 'Pistol'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.filter((d) => d.state === 'crit').length).toBe(1);
  });

  it('VILE BLESSING ignores one attack dice’s Normal Dmg once per battle, excluding a DEVOTEE', () => {
    const printed = ruleText(EQ.vileBlessing);
    expect(printed).toContain('you can ignore that inflicted damage');
    expect(printed).toContain('(excluding DEVOTEE)');
    const { ctx, state } = setup({ equipment: [EQ.vileBlessing] });
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.blessedBlade)[0]!;
    isolate(state, [id, foe]);
    place(state, id, 10, 11);
    place(state, foe, 10.6, 11);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe,
      defenderId: id,
      attackerWeapon: 'Commune blade',
      attackerPool: newPool(),
      defenderPool: newPool(),
      attackerAssists: 0,
      defenderAssists: 0,
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
    } as unknown as FightSequence;
    const before = state.operatives[id]!.wounds;
    inflictDamage(ctx, state, state.operatives[id]!, 4, 'attack'); // the Commune blade's Normal Dmg
    expect(state.operatives[id]!.wounds).toBe(before);
    // Once per battle.
    inflictDamage(ctx, state, state.operatives[id]!, 4, 'attack');
    expect(state.operatives[id]!.wounds).toBeLessThan(before);
  });

  it('VILE BLESSING and Unnatural Regeneration are never used on the same attack dice', () => {
    expect(ruleText(EQ.vileBlessing)).toContain('you must use one or the other');
    const { ctx, state } = setup({ equipment: [EQ.vileBlessing], script: [6, 6, 6] });
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    const foe = idsOf(state, 'p2', CARD.blessedBlade)[0]!;
    isolate(state, [id, foe]);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe,
      defenderId: id,
      attackerWeapon: 'Commune blade',
      attackerPool: newPool(),
      defenderPool: newPool(),
      attackerAssists: 0,
      defenderAssists: 0,
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
    } as unknown as FightSequence;
    const before = state.operatives[id]!.wounds;
    inflictDamage(ctx, state, state.operatives[id]!, 4, 'attack');
    expect(state.operatives[id]!.wounds).toBe(before);
    // Vile Blessing spared the only dice, so no Unnatural Regeneration D6 was rolled for it.
    expect(state.rolls.some((r) => r.kind === 'regeneration')).toBe(false);
  });

  it('COVERT GUISES: "can immediately perform a free Reposition action" is one AP, for one activation', () => {
    expect(ruleText(EQ.covertGuises)).toContain('can immediately perform a free Reposition action');
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [2] }); // D3 = 1
    const devotees = idsOf(state, 'p1', CARD.devotee);
    devotees.forEach((id, i) => place(state, id, 3, 3 + (i % 8) * 2));
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.covertGuises }, ctx).state;
    const lucky = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === EQ.covertGuises)!.operativeId!;
    // The DEVOTEE's APL stat — the number that totals for marker control — never moves; only the
    // AP it may spend in that activation does (docs/DECISIONS.md D-100).
    expect(s.operatives[lucky]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s, s.operatives[lucky]!)).toBe(2);
    expect(apBudgetOf(ctx, s, s.operatives[lucky]!)).toBe(3);
    s.phase = 'firefight';
    s = activate(ctx, s, lucky, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: lucky }, ctx).state;
    expect(freeApOf(s, s.operatives[lucky]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[lucky]!)).toBe(2);
  });

  it('COVERT GUISES: a free Reposition nobody spent does not survive the turning point', () => {
    expect(ruleText(EQ.covertGuises)).toContain('immediately');
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [2] }); // D3 = 1
    const devotees = idsOf(state, 'p1', CARD.devotee);
    devotees.forEach((id, i) => place(state, id, 3, 3 + (i % 8) * 2));
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.covertGuises }, ctx).state;
    const lucky = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === EQ.covertGuises)!.operativeId!;
    expect(freeApOf(s, s.operatives[lucky]!)).toBe(1);
    // The DEVOTEE never activates. Its activation therefore never ends, so nothing expires the
    // grant on its own — and "immediately" cannot mean "at any point in a later turning point".
    s.turningPoint += 1;
    readyStep(ctx, s);
    expect(freeApOf(s, s.operatives[lucky]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[lucky]!)).toBe(2);
  });

  it('every equipment option carries an aiHints.equipmentValue and every ploy a ployValue', () => {
    const hints = chaosCult.aiHints!;
    for (const e of DATA.equipment) expect(hints.equipmentValue?.[e.id], e.id).toBeTypeOf('number');
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys])
      expect(hints.ployValue?.[p.id], p.id).toBeTypeOf('number');
    expect(hints.ployValue?.[MUTATE_GAMBIT]).toBeGreaterThan(1);
    for (const c of DATA.datacards) expect(hints.roles?.[c.id], c.id).toBeTypeOf('string');
  });
});

// ===========================================================================
describe('CHAOS CULT honesty', () => {
  it('every REMINDER_ONLY and PARTIAL entry names a printed rule and gives an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).length).toBeGreaterThanOrEqual(7);
    const known = (id: string): boolean => {
      const base = id.replace(/\.[a-zA-Z]+$/, '');
      return (
        [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].some(
          (r) => r.id === id || r.id === base,
        ) ||
        DATA.datacards.some((c) => [...c.abilities, ...c.uniqueActions].some((a) => a.id === id || a.id === base))
      );
    };
    for (const [id, reason] of Object.entries({ ...REMINDER_ONLY, ...PARTIAL })) {
      expect(reason.length, id).toBeGreaterThan(30);
      expect(known(id), `${id} is not a printed rule id`).toBe(true);
    }
  });

  it('registers no handler on a hook that is never emitted', () => {
    // "Declared but never emitted" (docs/TEAM-STATUS.md § Known engine gaps): a handler there
    // would be the silent no-op CLAUDE.md architecture rule 5 forbids.
    const NEVER_EMITTED = [
      'onBattleSetup',
      'onAttackDiceRetained',
      'onFreeActions',
      'onOrderChange',
      'onMoveRules',
      'onSetUpAgain',
    ] as const;
    const { ctx } = setup();
    const reg = hooksFor(ctx, 'p1');
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    for (const hook of ['onStatMod', 'onWeaponRules', 'onIncapacitated', 'onMarkerControl', 'onDamage'] as const) {
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    }
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and
   * offers anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.inciteSlaughter, CARD.demagogue],
      [ACT.inciteUrgency, CARD.demagogue],
      [ACT.ruinousIcon, CARD.iconarch],
      [ACT.heinousDeluge, CARD.mindwitch],
      [ACT.maleficVortex, CARD.mindwitch],
    ];
    const tried = new Map<string, number>();
    for (const [actionId, datacardId] of owners) {
      const base = setup({ seed: 5 });
      const opId = opWith(base.state, 'p1', datacardId);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) place(base.state, id, 2 + (n++ % 12) * 1.6, 1);
      place(base.state, opId, 8, 11);
      place(base.state, mates[0]!, 8, 12.2); // a friendly within control range
      place(base.state, foes[0]!, 11, 11); // visible, a valid target, not engaged
      place(base.state, foes[1]!, 12, 14);
      place(base.state, mates[1]!, 12.6, 14);
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
      const attempts: Record<string, unknown>[] = [
        {},
        { targetPos: { ...op.pos }, markerPos: { ...op.pos } },
        ...aliveOperatives(base.state).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
      ];
      const def = getAction(actionId)!;
      for (const params of attempts) {
        if (def.available && !def.available(base.ctx, base.state, op)) continue;
        if (!def.check(base.ctx, base.state, op, params).ok) continue;
        const s = activate(base.ctx, base.state, opId, 'engage');
        const out = act(base.ctx, s, opId, actionId, params);
        tried.set(actionId, (tried.get(actionId) ?? 0) + 1);
        expect({ actionId, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });

  it('the four Deformed Wings siblings never refuse in `perform` what `check` accepted (D-026)', () => {
    const { ctx, state } = setup({ map: WINGS_MAP() });
    setAccursedGift(state, 'p1', 'primary', 'deformed-wings');
    const id = idsOf(state, 'p1', CARD.devotee)[0]!;
    isolate(state, [id]);
    place(state, id, 13, 8.5);
    mutateOperative(ctx, state, state.operatives[id]!, 'mutant');
    const s = activate(ctx, state, id, 'engage');
    const path = WINGS_PATH;
    let reached = 0;
    for (const actionId of [WINGS_REPOSITION, WINGS_DASH, WINGS_CHARGE, WINGS_FALL_BACK]) {
      const def = getAction(actionId)!;
      if (!def.available!(ctx, s, s.operatives[id]!)) continue;
      if (!def.check(ctx, s, s.operatives[id]!, { path }).ok) continue;
      reached++;
      expect(def.perform(ctx, structuredClone(s), structuredClone(s).operatives[id]!, { path }).ok).toBe(true);
    }
    expect(reached).toBeGreaterThan(0);
  });

  it('lists the ACCURSED GIFTS the engine can express, and names the one that needed its own actions', () => {
    // Five gifts are plain hooks; Deformed Wings needed four `ActionDef`s because `onMoveRules`
    // is declared and never emitted (D-021, the Farstalker BOUND precedent).
    const { ctx } = setup();
    const reg = hooksFor(ctx, 'p1');
    expect(reg.has('onStatMod')).toBe(true);
    expect(reg.has('onFightAssist')).toBe(false); // Barbed rides onCollectAttackDice instead
    expect(reg.has('onCollectAttackDice')).toBe(true);
    for (const gift of GIFTS) expect(GIFT_LABEL[gift].length).toBeGreaterThan(3);
    expect(getAction(WINGS_REPOSITION)!.sourceText).toBe(GIFT_TEXT['deformed-wings']);
  });
});

// ===========================================================================
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md § Architecture 1): zero rejected intents and no exceptions. The shared
  // ring in tests/teams/soak.test.ts covers the batch; this mirror exercises the Mutation
  // gambit, the two extra datacards it puts on the table and the ACCURSED GIFTS they carry, on
  // both an open and a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([chaosCult], { seed: 4141 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4141,
        rosters: {
          p1: { teamId: 'chaos-cult', operatives: roster(), equipment: [EQ.unholyTalisman, EQ.vileBlessing] },
          p2: { teamId: 'chaos-cult', operatives: roster(), equipment: [EQ.covertGuises, EQ.balefulScript] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The Mutation gambit actually fired, so the MUTANT datacard reached the table.
      // Both datacards a kill team can never select reached the table, and an ACCURSED GIFT was
      // chosen for each of them — the two rules the printed roster cannot exercise on its own.
      expect(result.state.log.some((l) => /MUTATES into a Chaos Mutant/.test(l.text))).toBe(true);
      expect(result.state.log.some((l) => /MUTATES into a Chaos Torment/.test(l.text))).toBe(true);
      expect(result.state.log.some((l) => /primary ACCURSED GIFT/.test(l.text))).toBe(true);
      expect(result.state.log.some((l) => /secondary ACCURSED GIFT/.test(l.text))).toBe(true);
    }, 180000);
  }
});
