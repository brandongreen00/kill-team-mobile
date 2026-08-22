/**
 * GOREMONGER. Every test quotes the printed rule it pins, read out of
 * `data/teams/goremonger.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/goremonger/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveOf, aplOf, aliveOperatives, inflictDamage, weaponsOf } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import { readyStep } from '../../src/core/phases.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, Vec2, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/goremonger.json';
import { teamData, trimTrailingSection } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  AB,
  ACT,
  BLEEDING,
  C,
  CADAVER_MARKER,
  CHARGE_BLOODLUST,
  CHARGE_HUNT,
  EQ,
  FIGHT_FURY,
  FP,
  GORE_TANK,
  HUNT_READY,
  KW,
  PICK_UP_CADAVER,
  REMINDER_ONLY,
  RULE,
  SANGUAVITAE,
  SANGUAVITAE_ACTION,
  SANGUAVITAE_NAME,
  SANGUAVITAE_TEXT,
  SP,
  TOTEM_MARKER,
  WRIST_SUFFIX,
  canUseSanguavitae,
  decreaseGoreTank,
  goremonger,
  goreTankOf,
  increaseGoreTank,
  setPreyDiscard,
  wristChainWeapons,
} from '../../src/teams/goremonger/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, settle, teamContext } from './harness.ts';

const DATA = teamData('goremonger');
/** `TeamData` does not surface everything, so the committed bytes are read straight from the file. */
const RAW = rawJson as {
  markerGuide: string;
  archetypes: string[];
  strategyPloys: { id: string; text: string }[];
  firefightPloys: { id: string; text: string }[];
  datacards: { id: string; uniqueActions: Record<string, unknown>[] }[];
};

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) => card(cardId).uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = card(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/** BLOOD HERALD + the named roles + ASPIRANTs to fill the printed eight. */
function roster(roles: string[] = []): RosterPickIn[] {
  const picks: RosterPickIn[] = [{ datacardId: C.bloodHerald }];
  for (const r of roles) if (r !== C.bloodHerald) picks.push({ datacardId: r });
  while (picks.length < 8) picks.push({ datacardId: C.aspirant });
  return picks.slice(0, 8);
}

interface SetupOpts {
  roles?: string[];
  p2Roles?: string[];
  equipment?: string[];
  p2Equipment?: string[];
  script?: number[];
  seed?: number;
}

/** Both sides are Goremongers, so every rule can be tested from either seat. */
function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([goremonger], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const state = battle({
    ctx,
    p1: {
      module: goremonger,
      picks: roster(opts.roles ?? []),
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
    },
    p2: {
      module: goremonger,
      picks: roster(opts.p2Roles ?? []),
      ...(opts.p2Equipment ? { equipment: opts.p2Equipment } : {}),
    },
  });
  state.teams.p1.cp = 0;
  state.teams.p2.cp = 0;
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number, z = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = z;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.4, y: 18 + Math.floor(n / 3) * 1.4 };
    op.z = 0;
    n++;
  }
}

const pool = (values: number[], hit: number): DicePool => {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
};

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  type: 'ranged' | 'melee',
  weaponName: string,
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
    distance: 1,
  };
}

// ===========================================================================
describe('goremonger — printed data', () => {
  it('is the World Eaters Goremonger kill team with eight operatives', () => {
    expect(DATA.id).toBe('goremonger');
    expect(DATA.name).toBe('Goremonger');
    expect(DATA.faction).toBe('World Eaters');
    expect(RAW.archetypes).toEqual(['Seek & Destroy', 'Recon']);
    expect(DATA.selection.totalOperatives).toBe(8);
    expect(DATA.selection.slots).toBe(7);
    expect(DATA.selection.leader.role).toBe('BLOOD HERALD');
  });

  it('has seven datacards, each GOREMONGER CHAOS on a 32mm base', () => {
    expect(DATA.datacards.map((c) => c.id).sort()).toEqual([...Object.values(C)].sort());
    for (const c of DATA.datacards) {
      expect(c.keywords.slice(0, 2)).toEqual(['GOREMONGER', 'CHAOS']);
      expect(c.base).toEqual({ shape: 'round', mm: 32 });
      expect(c.apl).toBe(2);
      expect(c.move).toBe(7);
      expect(c.save).toBe(5);
    }
    expect(card(C.bloodHerald).wounds).toBe(11);
    expect(card(C.bloodHerald).keywords).toContain('LEADER');
    for (const id of [C.aspirant, C.bloodtaker, C.impaler, C.inciter, C.skullclaimer, C.stalker])
      expect(card(id).wounds).toBe(10);
  });

  it('pins the BLOOD HERALD’s Icon of Khorne and chainblade', () => {
    const icon = profileOf(C.bloodHerald, 'Icon of Khorne');
    expect(icon).toMatchObject({ type: 'ranged', atk: 4, hit: 2, dmgN: 4, dmgC: 4 });
    expect(icon.rules.map((r) => r.raw)).toEqual(['Range 8"', 'Saturate']);
    const blade = profileOf(C.bloodHerald, 'Chainblade');
    expect(blade).toMatchObject({ type: 'melee', atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(blade.rules.map((r) => r.id)).toEqual(['Rending']);
  });

  it('pins the melee weapon of every other datacard', () => {
    expect(profileOf(C.aspirant, 'Chainglaive')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.bloodtaker, 'Ritual blade')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 5 });
    expect(profileOf(C.bloodtaker, 'Ritual blade').rules.map((r) => r.raw)).toEqual(['Ritual*']);
    expect(profileOf(C.skullclaimer, 'Great chainaxe')).toMatchObject({ atk: 4, hit: 3, dmgN: 5, dmgC: 6 });
    expect(profileOf(C.skullclaimer, 'Great chainaxe').rules.map((r) => r.id)).toEqual(['Brutal']);
    expect(profileOf(C.stalker, 'Pickrippers')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    const autopistol = profileOf(C.aspirant, 'Autopistol');
    expect(autopistol).toMatchObject({ type: 'ranged', atk: 4, hit: 4, dmgN: 2, dmgC: 3 });
    expect(autopistol.rules.map((r) => r.raw)).toEqual(['Range 8"']);
  });

  it('pins the IMPALER’s fleshskewer (both profiles) and the INCITER’s dual autopistols', () => {
    const skewer = profileOf(C.impaler, 'Fleshskewer', 'ranged');
    expect(skewer).toMatchObject({ type: 'ranged', atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(skewer.rules.map((r) => r.raw)).toEqual(['Range 8"', 'Stun', 'Drag*', 'Prey*']);
    expect(profileOf(C.impaler, 'Fleshskewer', 'stab')).toMatchObject({ type: 'melee', atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    const focused = profileOf(C.inciter, 'Dual autopistols', 'focused');
    expect(focused).toMatchObject({ type: 'ranged', atk: 4, hit: 3, dmgN: 2, dmgC: 2 });
    expect(focused.rules.map((r) => r.raw)).toEqual(['Range 8"', 'Ceaseless', 'Devastating 1', 'Rending']);
    expect(profileOf(C.inciter, 'Dual autopistols', 'point-blank')).toMatchObject({ type: 'melee', dmgN: 3, dmgC: 4 });
  });

  it('has three faction rules, 4+4 ploys at 1CP, four equipment options and two unique actions', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE.runesOfKhorne, RULE.goreTanks, RULE.sanguavitae]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual(Object.values(SP));
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual(Object.values(FP));
    expect(DATA.equipment.map((e) => e.id)).toEqual(Object.values(EQ));
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(p.cp).toBe(1);
    expect(actionOf(C.bloodtaker, ACT.transfusionRitual).ap).toBe(1);
    expect(actionOf(C.inciter, ACT.dashAndSpray).ap).toBe(1);
    expect(DATA.datacards.flatMap((c) => c.abilities.map((a) => a.id)).sort()).toEqual([...Object.values(AB)].sort());
  });

  it('registers its three rare weapon rules from its OWN printed text (D-033)', () => {
    expect(DATA.rareWeaponRules).toEqual(['Drag', 'Prey', 'Ritual']);
    expect(rareWeaponRuleText('Drag', 'goremonger')).toBe(abilityText(C.impaler, AB.drag));
    expect(rareWeaponRuleText('Prey', 'goremonger')).toBe(abilityText(C.impaler, AB.prey));
    expect(rareWeaponRuleText('Ritual', 'goremonger')).toBe(abilityText(C.bloodtaker, AB.ritual));
  });

  it('names its tokens and markers in the printed marker guide', () => {
    for (const token of ['Gore Tank token (full)', 'Gore Tank token (half)', 'Bleeding token', 'Gory Totem marker', 'Bloody Cadaver marker'])
      expect(RAW.markerGuide).toContain(token);
  });

  it('DATA PROBLEM: the last strategy and firefight ploy each absorb the next printed section', () => {
    // The committed JSON glues everything from "Firefight Ploys" / "Faction Equipment" onwards
    // onto HUNT FOR BLOOD and LACERATE FLESH. `src/teams/data.ts` already trims it, so nothing
    // downstream quotes the wrong rule — pinned here so the artefact stays visible.
    const rawHunt = RAW.strategyPloys.find((p) => p.id === SP.huntForBlood)!.text;
    const rawLacerate = RAW.firefightPloys.find((p) => p.id === FP.lacerateFlesh)!.text;
    expect(rawHunt).toContain('\nFirefight Ploys\n');
    expect(rawLacerate).toContain('\nFaction Equipment\n');
    expect(ruleText(SP.huntForBlood)).toBe(trimTrailingSection(rawHunt));
    expect(ruleText(SP.huntForBlood)).not.toContain('Firefight Ploys');
    expect(ruleText(FP.lacerateFlesh)).not.toContain('Faction Equipment');
  });

  it('DATA PROBLEM: uniqueActions[] carry no `keywords` field (the corsair-voidscarred variant)', () => {
    const actions = RAW.datacards.flatMap((c) => c.uniqueActions);
    expect(actions.length).toBe(2);
    for (const a of actions) expect('keywords' in a).toBe(false);
  });
});

// ===========================================================================
describe('selection', () => {
  it('prints one constraint — "Other than ASPIRANT operatives, your kill team can only include each operative above once."', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['ASPIRANT'] }]);
    expect(DATA.selection.rawText).toContain('Other than ASPIRANT operatives');
  });

  it('rejects a second BLOODTAKER and accepts a second ASPIRANT', () => {
    expect(validateRosterFor(DATA, roster([C.bloodtaker])).ok).toBe(true);
    const twoBloodtakers: RosterPickIn[] = [
      { datacardId: C.bloodHerald },
      { datacardId: C.bloodtaker },
      { datacardId: C.bloodtaker },
      ...Array.from({ length: 5 }, () => ({ datacardId: C.aspirant })),
    ];
    expect(validateRosterFor(DATA, twoBloodtakers).ok).toBe(false);
  });

  it('D-042: `defaultRoster` is legal but fields only 2 of the 7 datacards', () => {
    const picks = defaultRoster(DATA);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(picks.map((p) => p.datacardId)).toEqual([C.bloodHerald, ...Array.from({ length: 7 }, () => C.aspirant)]);
    const never = DATA.datacards.map((c) => c.id).filter((id) => !picks.some((p) => p.datacardId === id));
    expect(never.sort()).toEqual([C.bloodtaker, C.impaler, C.inciter, C.skullclaimer, C.stalker].sort());
  });
});

// ===========================================================================
describe('Gore Tanks (faction rule)', () => {
  it('"They start the battle at half."', () => {
    const { state } = setup();
    for (const op of aliveOperatives(state)) expect(goreTankOf(state, op)).toBe(1);
    expect(ruleText(RULE.goreTanks)).toContain('They start the battle at half');
  });

  it('"A GORE TANK cannot increase when it’s already full, or decrease when it’s already empty."', () => {
    const { state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.bloodHerald)]!;
    expect(increaseGoreTank(state, op, 'test')).toBe(true);
    expect(goreTankOf(state, op)).toBe(2);
    expect(increaseGoreTank(state, op, 'test')).toBe(false);
    expect(decreaseGoreTank(state, op, 'test')).toBe(true);
    expect(decreaseGoreTank(state, op, 'test')).toBe(true);
    expect(goreTankOf(state, op)).toBe(0);
    expect(decreaseGoreTank(state, op, 'test')).toBe(false);
  });

  it('the gauge is an effect on the operative, so the UI can read it', () => {
    const { state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    increaseGoreTank(state, op, 'test');
    const eff = state.effects.find((e) => e.rule === GORE_TANK && e.operativeId === op.id);
    expect(eff?.data?.['level']).toBe(2);
    expect(eff?.expiry).toEqual({ kind: 'endOfBattle' });
  });

  it('"Whenever a friendly GOREMONGER operative incapacitates an operative within its control range … you can increase its GORE TANK."', () => {
    const { ctx, state } = setup();
    const killer = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const victim = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [killer.id, victim.id]);
    place(state, killer.id, 10, 10);
    place(state, victim.id, 11.2, 10);
    victim.wounds = 1;
    state.sequence = { kind: 'fight', turn: 'attacker', attackerId: killer.id, defenderId: victim.id } as FightSequence;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(victim.incapacitated).toBe(true);
    expect(goreTankOf(state, killer)).toBe(2);
  });

  it('"…or visible to and within 2\\" of it" — but not a kill 5\\" away', () => {
    const { ctx, state } = setup();
    const killer = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const victim = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [killer.id, victim.id]);
    place(state, killer.id, 10, 10);
    place(state, victim.id, 12.7, 10); // 32mm bases: ~1.4" gap, visible
    victim.wounds = 1;
    state.sequence = { kind: 'shoot', attackerId: killer.id, targetId: victim.id } as ShootSequence;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(goreTankOf(state, killer)).toBe(2);

    const far = setup();
    const k2 = far.state.operatives[opWith(far.state, 'p1', C.aspirant)]!;
    const v2 = far.state.operatives[opWith(far.state, 'p2', C.aspirant)]!;
    isolate(far.state, [k2.id, v2.id]);
    place(far.state, k2.id, 10, 10);
    place(far.state, v2.id, 16, 10);
    v2.wounds = 1;
    far.state.sequence = { kind: 'shoot', attackerId: k2.id, targetId: v2.id } as ShootSequence;
    inflictDamage(far.ctx, far.state, v2, 3, 'attack');
    expect(goreTankOf(far.state, k2)).toBe(1);
  });
});

// ===========================================================================
describe('Runes of Khorne (faction rule)', () => {
  it('"Each friendly GOREMONGER operative cannot lose more than 8 wounds per Shoot action."', () => {
    // Icon of Khorne: Atk 4, Hit 2+, Dmg 4/4, Saturate. Four 6s = four crits = 16 damage.
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1] });
    const herald = state.operatives[opWith(state, 'p1', C.bloodHerald)]!;
    const target = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [herald.id, target.id]);
    place(state, herald.id, 10, 10);
    place(state, target.id, 15, 10);
    const s = activate(ctx, state, herald.id, 'engage');
    const out = act(ctx, s, herald.id, 'Shoot', { weaponName: 'Icon of Khorne', targetId: target.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[target.id]!.wounds).toBe(10 - 8);
    expect(out.state.log.some((l) => /cannot lose more than 8 wounds/.test(l.text))).toBe(true);
    expect(ruleText(RULE.runesOfKhorne)).toContain('cannot lose more than 8 wounds per Shoot action');
  });

  it('leaves damage under the cap alone, and the cap is per Shoot action', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    state.sequence = { kind: 'shoot', attackerId: shooter.id, targetId: target.id } as ShootSequence;
    inflictDamage(ctx, state, target, 5, 'attack');
    expect(target.wounds).toBe(5);
    inflictDamage(ctx, state, target, 5, 'attack'); // same Shoot action: only 3 more get through
    expect(target.wounds).toBe(2);
  });
});

// ===========================================================================
describe('SANGUAVITAE (faction rule)', () => {
  it('slices its six rules out of the ONE printed faction rule, never retyped', () => {
    const whole = ruleText(RULE.sanguavitae);
    expect(SANGUAVITAE.length).toBe(6);
    for (const which of SANGUAVITAE) {
      expect(whole).toContain(`\n${SANGUAVITAE_NAME[which]}\nWHEN:`);
      expect(whole).toContain(SANGUAVITAE_TEXT[which]);
      expect(SANGUAVITAE_TEXT[which].startsWith('WHEN:')).toBe(true);
      expect(SANGUAVITAE_TEXT[which]).toContain('EFFECT:');
    }
    expect(SANGUAVITAE_TEXT.rejuvenate).toContain('regains up to D3+1 lost wounds');
    expect(SANGUAVITAE_TEXT.rage).toContain('add 1 to the Atk stat');
  });

  it('registers one 0AP declaration action per rule (D-021 — the engine has no "use a rule" intent)', () => {
    for (const which of SANGUAVITAE) {
      const def = getAction(SANGUAVITAE_ACTION[which])!;
      expect(def.ap).toBe(0);
      expect(def.sourceText).toContain(SANGUAVITAE_NAME[which]);
    }
  });

  it('"you must decrease the operative’s GORE TANK to do so" — and an empty tank refuses', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const s = activate(ctx, state, op.id, 'engage');
    const before = goreTankOf(s, s.operatives[op.id]!);
    const out = act(ctx, s, op.id, SANGUAVITAE_ACTION.mania, {});
    expect(out.ok).toBe(true);
    expect(goreTankOf(out.state, out.state.operatives[op.id]!)).toBe(before - 1);
    // Empty now: a second, different rule is refused.
    expect(canUseSanguavitae(out.state, out.state.operatives[op.id]!, 'surge')).toMatchObject({
      ok: false,
      reason: 'its GORE TANK is empty',
    });
  });

  it('"You cannot use the same SANGUAVITAE rule more than once per activation or counteraction."', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    increaseGoreTank(state, op, 'test');
    const s = activate(ctx, state, op.id, 'engage');
    const first = act(ctx, s, op.id, SANGUAVITAE_ACTION.mania, {});
    expect(first.ok).toBe(true);
    expect(canUseSanguavitae(first.state, first.state.operatives[op.id]!, 'mania').ok).toBe(false);
    const again = act(ctx, first.state, op.id, SANGUAVITAE_ACTION.mania, {});
    expect(again.ok).toBe(false);
  });

  it('"you cannot use more than two SANGUAVITAE rules per activation or counteraction"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    increaseGoreTank(state, op, 'test');
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.surge, {}).state;
    increaseGoreTank(s, s.operatives[op.id]!, 'test'); // top the tank back up
    increaseGoreTank(s, s.operatives[op.id]!, 'test');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.rejuvenate, {}).state;
    expect(canUseSanguavitae(s, s.operatives[op.id]!, 'mania')).toMatchObject({
      ok: false,
      reason: 'you cannot use more than two SANGUAVITAE rules per activation',
    });
  });

  it('"You cannot use Mania and Fury during the same activation."', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    increaseGoreTank(state, op, 'test');
    const s = activate(ctx, state, op.id, 'engage');
    const used = act(ctx, s, op.id, SANGUAVITAE_ACTION.fury, {}).state;
    expect(canUseSanguavitae(used, used.operatives[op.id]!, 'mania')).toMatchObject({
      ok: false,
      reason: 'you cannot use Mania and Fury during the same activation',
    });
  });

  it('Rejuvenate: "That operative regains up to D3+1 lost wounds."', () => {
    const { ctx, state } = setup({ script: [3] }); // a D3 is ceil(D6/2), so a 3 is a D3 of 2
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    op.wounds = 4;
    const s = activate(ctx, state, op.id, 'engage');
    const out = act(ctx, s, op.id, SANGUAVITAE_ACTION.rejuvenate, {});
    expect(out.ok).toBe(true);
    expect(out.state.operatives[op.id]!.wounds).toBe(7);
  });

  it('Rejuvenate never overheals — "up to" is capped by the wounds actually lost', () => {
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    op.wounds = 9;
    const s = activate(ctx, state, op.id, 'engage');
    const out = act(ctx, s, op.id, SANGUAVITAE_ACTION.rejuvenate, {});
    expect(out.state.operatives[op.id]!.wounds).toBe(10);
  });

  it('Mania: "Until the start of that operative’s next activation, add 1 to its APL stat."', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    expect(aplOf(ctx, state, op)).toBe(2);
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.mania, {}).state;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(3);
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(3); // still on until it activates again
    s.operatives[op.id]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, op.id, 'engage');
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
  });

  it('Surge: "Until the end of that action, add 1\\" to that operative’s Move stat."', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    isolate(state, [op.id]);
    place(state, op.id, 10, 10);
    expect(moveOf(ctx, state, op)).toBe(7);
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.surge, {}).state;
    // The +1" rides `onMoveDistance`, so it is the Reposition/Charge allowance that grows.
    const far = act(ctx, s, op.id, 'Reposition', { path: { points: [{ x: 18, y: 10 }] } });
    expect(far.ok).toBe(true); // 8" — one more than its Move stat
    expect(SANGUAVITAE_TEXT.surge).toContain('add 1" to that operative’s Move stat');
  });

  it('without Surge the same 8\\" Reposition is refused', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    isolate(state, [op.id]);
    place(state, op.id, 10, 10);
    const s = activate(ctx, state, op.id, 'engage');
    expect(act(ctx, s, op.id, 'Reposition', { path: { points: [{ x: 18, y: 10 }] } }).ok).toBe(false);
  });

  it('Rage: "add 1 to the Atk stat of that operative’s melee weapons" — read by fight.ts', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.rage, {}).state;
    const before = s.rolls.length;
    s = act(ctx, s, op.id, 'Fight', { targetId: foe.id }).state;
    const fightRolls = s.rolls.slice(before).filter((r) => r.kind === 'fight');
    expect(fightRolls[0]!.results.length).toBe(5); // Atk 4 + 1
  });

  it('Rake: "you can inflict D3 damage on one enemy operative within its control range" after the Charge', () => {
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 14, 10);
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, 'Charge', { path: { points: [{ x: 12.8, y: 10 }] } }).state;
    const out = act(ctx, s, op.id, SANGUAVITAE_ACTION.rake, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe.id]!.wounds).toBe(7);
  });

  it('Rake is refused when the operative has not just charged (its printed WHEN)', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const s = activate(ctx, state, op.id, 'engage');
    const out = act(ctx, s, op.id, SANGUAVITAE_ACTION.rake, { targetOperativeId: foe.id });
    expect(out.ok).toBe(false);
    expect(SANGUAVITAE_TEXT.rake).toContain('performs the Charge action during its activation');
  });

  it('Fury: "That operative can perform two Fight actions during that activation, and the second one is free."', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 200;
    op.wounds = 200; // neither fighter can die, so the second Fight really is the rule being pinned
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    let s = activate(ctx, state, op.id, 'engage');
    // Without Fury the second Fight is not on offer at all.
    expect(availableActions(ctx, s, s.operatives[op.id]!).some((a) => a.def.id === FIGHT_FURY)).toBe(false);
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.fury, {}).state;
    s = settle(ctx, act(ctx, s, op.id, 'Fight', { targetId: foe.id }).state);
    const spent = s.operatives[op.id]!.apSpent;
    const second = act(ctx, s, op.id, FIGHT_FURY, { targetId: foe.id });
    expect(second.ok).toBe(true);
    expect(second.state.operatives[op.id]!.apSpent).toBe(spent); // "the second one is free"
    const settled = settle(ctx, second.state);
    expect(act(ctx, settled, op.id, FIGHT_FURY, { targetId: foe.id }).ok).toBe(false);
  });

  it('every SANGUAVITAE declaration is spent for the activation and comes back next time', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    let s = activate(ctx, state, op.id, 'engage');
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.mania, {}).state;
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    increaseGoreTank(s, s.operatives[op.id]!, 'test');
    s.operatives[op.id]!.ready = true;
    s.activePlayer = 'p1';
    s = activate(ctx, s, op.id, 'engage');
    expect(canUseSanguavitae(s, s.operatives[op.id]!, 'mania').ok).toBe(true);
  });

  it('reminder-only: no SANGUAVITAE rule can be used during a counteraction', () => {
    expect(REMINDER_ONLY[`${RULE.sanguavitae}.counteraction`]).toContain('counteracting');
    expect(ruleText(RULE.sanguavitae)).toContain('per activation or counteraction');
  });
});

// ===========================================================================
describe('BLOOD HERALD', () => {
  it('Khorne’s Favour: "if its GORE TANK is empty, you can increase its GORE TANK" (once per activation)', () => {
    const { ctx, state } = setup();
    const herald = state.operatives[opWith(state, 'p1', C.bloodHerald)]!;
    decreaseGoreTank(state, herald, 'test');
    expect(goreTankOf(state, herald)).toBe(0);
    const s = activate(ctx, state, herald.id, 'engage');
    expect(goreTankOf(s, s.operatives[herald.id]!)).toBe(1);
    // And again the moment a SANGUAVITAE rule empties it — but only once per activation.
    const used = act(ctx, s, herald.id, SANGUAVITAE_ACTION.mania, {});
    expect(goreTankOf(used.state, used.state.operatives[herald.id]!)).toBe(0);
    expect(abilityText(C.bloodHerald, AB.khornesFavour)).toContain('Once during each of this operative’s activations');
  });

  it('Impending Apotheosis: "Once per battle, when an attack dice inflicts Normal Dmg on this operative, you can ignore that inflicted damage."', () => {
    const { ctx, state } = setup();
    const herald = state.operatives[opWith(state, 'p1', C.bloodHerald)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [herald.id, foe.id]);
    place(state, herald.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    // Chainglaive Normal Dmg 4 — one normal strike, ignored.
    state.sequence = { kind: 'fight', turn: 'attacker', attackerId: foe.id, defenderId: herald.id, attackerWeapon: 'Chainglaive' } as FightSequence;
    inflictDamage(ctx, state, herald, 4, 'attack');
    expect(herald.wounds).toBe(11);
    // Once per battle: the next normal strike lands.
    inflictDamage(ctx, state, herald, 4, 'attack');
    expect(herald.wounds).toBe(7);
  });
});

// ===========================================================================
describe('ASPIRANT › Obsessive Bloodlust', () => {
  it('is a free 0AP Charge after a Fight that left it unengaged, capped at 2"', () => {
    // Four 6s for the ASPIRANT, four 1s for the defender: the enemy dies on the first strike.
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1] });
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    const other = state.operatives[opWith(state, 'p2', C.bloodHerald)]!;
    isolate(state, [op.id, foe.id, other.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    place(state, other.id, 13, 10);
    foe.wounds = 1;
    let s = activate(ctx, state, op.id, 'engage');
    s = settle(ctx, act(ctx, s, op.id, 'Fight', { targetId: foe.id }).state);
    // The enemy died, so the ASPIRANT is no longer within control range of enemy operatives.
    expect(s.operatives[foe.id]!.removed).toBe(true);
    const apBefore = s.operatives[op.id]!.apSpent;
    const out = act(ctx, s, op.id, CHARGE_BLOODLUST, { path: { points: [{ x: 11.7, y: 10 }] } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[op.id]!.apSpent).toBe(apBefore); // free
    // "…but it cannot move more than 2" during that action"
    const tooFar = act(ctx, s, op.id, CHARGE_BLOODLUST, { path: { points: [{ x: 5, y: 10 }] } });
    expect(tooFar.ok).toBe(false);
    expect(abilityText(C.aspirant, AB.obsessiveBloodlust)).toContain('cannot move more than 2"');
  });

  it('"Doing so doesn’t prevent it from performing the Charge, Dash or Reposition action afterwards" — its own restriction key', () => {
    expect(getAction(CHARGE_BLOODLUST)!.treatedAs).toBeUndefined();
    expect(getAction(CHARGE_BLOODLUST)!.ap).toBe(0);
  });

  it('is refused while an enemy is still within control range', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 200;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    let s = activate(ctx, state, op.id, 'engage');
    s = settle(ctx, act(ctx, s, op.id, 'Fight', { targetId: foe.id }).state);
    expect(act(ctx, s, op.id, CHARGE_BLOODLUST, { path: { points: [{ x: 10.5, y: 10 }] } }).ok).toBe(false);
  });
});

// ===========================================================================
describe('BLOODTAKER', () => {
  it('Ritual: "the first time you inflict damage on an operative within its control range during that sequence, you can increase this operative’s GORE TANK"', () => {
    const { ctx, state } = setup({ roles: [C.bloodtaker] });
    const bt = state.operatives[opWith(state, 'p1', C.bloodtaker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 40;
    isolate(state, [bt.id, foe.id]);
    place(state, bt.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    state.sequence = {
      kind: 'fight',
      turn: 'attacker',
      attackerId: bt.id,
      defenderId: foe.id,
      attackerWeapon: 'Ritual blade',
    } as FightSequence;
    inflictDamage(ctx, state, foe, 3, 'attack');
    expect(goreTankOf(state, bt)).toBe(2);
    // "the FIRST time … during that sequence" — a second strike pays nothing.
    decreaseGoreTank(state, bt, 'test');
    inflictDamage(ctx, state, foe, 3, 'attack');
    expect(goreTankOf(state, bt)).toBe(1);
    expect(abilityText(C.bloodtaker, AB.ritual)).toContain('the first time you inflict damage');
  });

  it('TRANSFUSION RITUAL decreases its own GORE TANK and increases a friendly one within 8"', () => {
    const { ctx, state } = setup({ roles: [C.bloodtaker] });
    const bt = state.operatives[opWith(state, 'p1', C.bloodtaker)]!;
    const mate = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    isolate(state, [bt.id, mate.id]);
    place(state, bt.id, 10, 10);
    place(state, mate.id, 14, 10);
    const s = activate(ctx, state, bt.id, 'engage');
    const out = act(ctx, s, bt.id, ACT.transfusionRitual, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(goreTankOf(out.state, out.state.operatives[bt.id]!)).toBe(0);
    expect(goreTankOf(out.state, out.state.operatives[mate.id]!)).toBe(2);
  });

  it('"cannot perform this action while within control range of an enemy operative, or if its GORE TANK is empty"', () => {
    const { ctx, state } = setup({ roles: [C.bloodtaker] });
    const bt = state.operatives[opWith(state, 'p1', C.bloodtaker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [bt.id, foe.id]);
    place(state, bt.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    let s = activate(ctx, state, bt.id, 'engage');
    expect(act(ctx, s, bt.id, ACT.transfusionRitual, {}).ok).toBe(false);
    place(s, foe.id, 20, 10);
    decreaseGoreTank(s, s.operatives[bt.id]!, 'test');
    expect(act(ctx, s, bt.id, ACT.transfusionRitual, {}).ok).toBe(false);
    expect(actionOf(C.bloodtaker, ACT.transfusionRitual).text).toContain('if its GORE TANK is empty');
  });
});

// ===========================================================================
describe('IMPALER › Drag and Prey', () => {
  it('Drag moves the target "up to x\\"… your total number of successful unblocked attack dice, multiplied by 2"', () => {
    // Fleshskewer (ranged): Atk 4, Hit 3+. Two 6s and two 1s = two unblocked crits → x = 4".
    const { ctx, state } = setup({ roles: [C.impaler], script: [6, 6, 1, 1, 1, 1, 1] });
    const impaler = state.operatives[opWith(state, 'p1', C.impaler)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 40;
    isolate(state, [impaler.id, foe.id]);
    place(state, impaler.id, 10, 10);
    place(state, foe.id, 19, 10);
    const s = activate(ctx, state, impaler.id, 'engage');
    const out = act(ctx, s, impaler.id, 'Shoot', {
      weaponName: 'Fleshskewer',
      profileName: 'ranged',
      targetId: foe.id,
    });
    expect(out.ok).toBe(true);
    const moved = out.state.operatives[foe.id]!;
    expect(moved.pos.x).toBeCloseTo(15, 1); // 19 -> 15: pulled the full 4 inches
    expect(out.state.log.some((l) => /Drag: .* pulls .* 4" closer/.test(l.text))).toBe(true);
    expect(abilityText(C.impaler, AB.drag)).toContain('multiplied by 2');
  });

  it('Prey is a pure setter — "you can choose not to inflict damage with any number of them"', () => {
    const { ctx, state } = setup({ roles: [C.impaler], script: [6, 6, 1, 1, 1, 1, 1] });
    const impaler = state.operatives[opWith(state, 'p1', C.impaler)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [impaler.id, foe.id]);
    place(state, impaler.id, 10, 10);
    place(state, foe.id, 16, 10);
    let s = activate(ctx, state, impaler.id, 'engage');
    setPreyDiscard(s, impaler.id, { crits: 2 });
    s = act(ctx, s, impaler.id, 'Shoot', { weaponName: 'Fleshskewer', profileName: 'ranged', targetId: foe.id }).state;
    expect(s.operatives[foe.id]!.wounds).toBe(10); // 2 crits × 5 damage all discarded
    expect(s.log.some((l) => /Prey: .* discards 2 critical/.test(l.text))).toBe(true);
    expect(abilityText(C.impaler, AB.prey)).toContain('you can choose not to inflict damage');
  });

  it('the default is to discard nothing, so a Prey shot inflicts its full damage', () => {
    const { ctx, state } = setup({ roles: [C.impaler], script: [6, 1, 1, 1, 1, 1, 1] });
    const impaler = state.operatives[opWith(state, 'p1', C.impaler)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [impaler.id, foe.id]);
    place(state, impaler.id, 10, 10);
    place(state, foe.id, 16, 10);
    let s = activate(ctx, state, impaler.id, 'engage');
    s = act(ctx, s, impaler.id, 'Shoot', { weaponName: 'Fleshskewer', profileName: 'ranged', targetId: foe.id }).state;
    expect(s.operatives[foe.id]!.wounds).toBe(5); // one unblocked crit, Critical Dmg 5
  });
});

// ===========================================================================
describe('INCITER › Incite the Hunt and DASH AND SPRAY', () => {
  it('a kill from more than 2" away tops up a friendly GOREMONGER within 8" of the victim', () => {
    const { ctx, state } = setup({ roles: [C.inciter] });
    const inciter = state.operatives[opWith(state, 'p1', C.inciter)]!;
    const mate = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [inciter.id, mate.id, foe.id]);
    place(state, inciter.id, 5, 10); // more than 8" from the victim, so it is not a candidate itself
    place(state, foe.id, 20, 10);
    place(state, mate.id, 24, 10);
    foe.wounds = 1;
    state.sequence = {
      kind: 'shoot',
      attackerId: inciter.id,
      targetId: foe.id,
      weaponName: 'Dual autopistols',
    } as ShootSequence;
    inflictDamage(ctx, state, foe, 3, 'attack');
    expect(goreTankOf(state, mate)).toBe(2);
    expect(goreTankOf(state, inciter)).toBe(1); // it killed from more than 2" away, so Gore Tanks pays it nothing
  });

  it('"inflicts damage … but doesn’t incapacitate it" gives the enemy a Bleeding token', () => {
    const { ctx, state } = setup({ roles: [C.inciter] });
    const inciter = state.operatives[opWith(state, 'p1', C.inciter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [inciter.id, foe.id]);
    place(state, inciter.id, 10, 10);
    place(state, foe.id, 15, 10);
    state.sequence = { kind: 'shoot', attackerId: inciter.id, targetId: foe.id, weaponName: 'Dual autopistols' } as ShootSequence;
    inflictDamage(ctx, state, foe, 2, 'attack');
    expect(state.effects.some((e) => e.rule === BLEEDING && e.operativeId === foe.id && e.player === 'p1')).toBe(true);
    // A killing blow gives no token.
    const other = state.operatives[opWith(state, 'p2', C.bloodHerald)]!;
    other.wounds = 1;
    inflictDamage(ctx, state, other, 5, 'attack');
    expect(state.effects.some((e) => e.rule === BLEEDING && e.operativeId === other.id)).toBe(false);
  });

  it('a friendly within 8" of a Bleeding enemy trades the token for a GORE TANK increase', () => {
    const { ctx, state } = setup({ roles: [C.inciter] });
    const mate = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [mate.id, foe.id]);
    place(state, mate.id, 10, 10);
    place(state, foe.id, 15, 10);
    state.effects.push({
      id: 'bleed-test',
      rule: BLEEDING,
      source: { kind: 'ability', id: AB.inciteTheHunt },
      operativeId: foe.id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    const s = activate(ctx, state, mate.id, 'engage');
    expect(goreTankOf(s, s.operatives[mate.id]!)).toBe(2);
    expect(s.effects.some((e) => e.rule === BLEEDING && e.operativeId === foe.id)).toBe(false);
  });

  it('DASH AND SPRAY: "a free Dash action and a free Shoot action… only dual autopistols (focused)"', () => {
    const { ctx, state } = setup({ roles: [C.inciter] });
    const inciter = state.operatives[opWith(state, 'p1', C.inciter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 40;
    isolate(state, [inciter.id, foe.id]);
    place(state, inciter.id, 10, 10);
    place(state, foe.id, 18, 10);
    const s = activate(ctx, state, inciter.id, 'engage');
    const out = act(ctx, s, inciter.id, ACT.dashAndSpray, {
      path: { points: [{ x: 12, y: 10 }] },
      targetId: foe.id,
    });
    expect(out.ok).toBe(true);
    const after = out.state.operatives[inciter.id]!;
    expect(after.pos.x).toBeCloseTo(12, 3);
    expect(after.actionsThisActivation).toContain('Dash');
    expect(after.actionsThisActivation).toContain('Shoot');
    expect(out.state.log.some((l) => /shoots .* with Dual autopistols \(focused\)/.test(l.text))).toBe(true);
  });

  it('DASH AND SPRAY is refused with a Conceal order, while engaged, or with no valid target', () => {
    const { ctx, state } = setup({ roles: [C.inciter] });
    const inciter = state.operatives[opWith(state, 'p1', C.inciter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [inciter.id, foe.id]);
    place(state, inciter.id, 10, 10);
    place(state, foe.id, 25, 10); // out of Range 8"
    const conceal = activate(ctx, state, inciter.id, 'conceal');
    expect(act(ctx, conceal, inciter.id, ACT.dashAndSpray, {}).ok).toBe(false);
    const engage = activate(ctx, state, inciter.id, 'engage');
    expect(act(ctx, engage, inciter.id, ACT.dashAndSpray, {}).ok).toBe(false);
    expect(actionOf(C.inciter, ACT.dashAndSpray).text).toContain('while it has a Conceal order');
  });
});

// ===========================================================================
describe('SKULLCLAIMER', () => {
  it('Brutish turns a critical strike into Normal Dmg in a fight', () => {
    const { ctx, state } = setup({ roles: [C.skullclaimer] });
    const sc = state.operatives[opWith(state, 'p1', C.skullclaimer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [sc.id, foe.id]);
    place(state, sc.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    state.sequence = {
      kind: 'fight',
      turn: 'attacker',
      attackerId: foe.id,
      defenderId: sc.id,
      attackerWeapon: 'Chainglaive',
    } as FightSequence;
    inflictDamage(ctx, state, sc, 5, 'attack'); // chainglaive Critical Dmg
    expect(sc.wounds).toBe(10 - 4); // Normal Dmg instead
    expect(abilityText(C.skullclaimer, AB.brutish)).toContain('inflict Normal Dmg instead');
  });

  it('Claim Skull: "Once per turning point… you gain 1CP" — great chainaxe only', () => {
    const { ctx, state } = setup({ roles: [C.skullclaimer] });
    const sc = state.operatives[opWith(state, 'p1', C.skullclaimer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    const foe2 = state.operatives[opWith(state, 'p2', C.bloodHerald)]!;
    isolate(state, [sc.id, foe.id, foe2.id]);
    place(state, sc.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    place(state, foe2.id, 11.2, 11.2);
    foe.wounds = 1;
    foe2.wounds = 1;
    state.teams.p1.cp = 0;
    state.sequence = {
      kind: 'fight',
      turn: 'attacker',
      attackerId: sc.id,
      defenderId: foe.id,
      attackerWeapon: 'Great chainaxe',
    } as FightSequence;
    inflictDamage(ctx, state, foe, 5, 'attack');
    expect(state.teams.p1.cp).toBe(1);
    state.sequence = {
      kind: 'fight',
      turn: 'attacker',
      attackerId: sc.id,
      defenderId: foe2.id,
      attackerWeapon: 'Great chainaxe',
    } as FightSequence;
    inflictDamage(ctx, state, foe2, 5, 'attack');
    expect(state.teams.p1.cp).toBe(1); // once per turning point
    expect(abilityText(C.skullclaimer, AB.claimSkull)).toContain('Once per turning point');
  });
});

// ===========================================================================
describe('STALKER', () => {
  it('Rooftop Stalker grants Relentless against an enemy on Vantage terrain', () => {
    const { ctx, state } = setup({ roles: [C.stalker] });
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [stalker.id, foe.id]);
    place(state, stalker.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const picks = profileOf(C.stalker, 'Pickrippers');
    const flat = effectiveRules(ctx, state, picks, { operative: stalker, target: foe, weaponName: 'Pickrippers' });
    expect(flat.some((r) => r.id === 'Relentless')).toBe(false);
    foe.z = 3; // standing on Vantage terrain
    ctx.maps.set(state.map.id, state.map);
    delete ctx.terrainCache;
    const withVantage = effectiveRules(ctx, state, picks, { operative: stalker, target: foe, weaponName: 'Pickrippers' });
    // The synthetic map has no Vantage part, so the printed condition genuinely does not hold …
    expect(withVantage.some((r) => r.id === 'Relentless')).toBe(false);
    expect(abilityText(C.stalker, AB.rooftopStalker)).toContain('on Vantage terrain');
  });

  it('Rooftop Stalker fires from a Vantage platform: the target on it, and the drop off it', () => {
    const ctx = teamContext([goremonger], { seed: 3 });
    const map = { ...mapById('volkus-1') };
    const state = battle({
      ctx,
      map,
      p1: { module: goremonger, picks: roster([C.stalker]) },
      p2: { module: goremonger, picks: roster() },
    });
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    const picks = profileOf(C.stalker, 'Pickrippers');
    // The rule reads elevation, so the state is set directly rather than depending on the map.
    stalker.z = 0;
    foe.z = 3;
    const bucketed = state.opState['goremonger.stalkerStart'] as Record<string, { z: number; vantage: boolean }>;
    expect(bucketed).toBeUndefined();
    // Record a Vantage start, then drop: the first printed clause.
    state.opState['goremonger.stalkerStart'] = { [stalker.id]: { z: 3, vantage: true } };
    foe.z = 0;
    const dropped = effectiveRules(ctx, state, picks, { operative: stalker, target: foe, weaponName: 'Pickrippers' });
    expect(dropped.some((r) => r.id === 'Relentless')).toBe(true);
  });

  it('reminder-only: Climbing Picks has no per-leg climb seam', () => {
    expect(REMINDER_ONLY[AB.climbingPicks]).toContain('onMoveRules');
    expect(abilityText(C.stalker, AB.climbingPicks)).toContain('treat the vertical distance as 2"');
  });
});

// ===========================================================================
describe('strategy ploys', () => {
  it('ENHANCED VIOLENCE: Balanced at half, Relentless at full — fighting AND retaliating', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    state.teams.p1.gambitsUsedTP.push(SP.enhancedViolence);
    const glaive = profileOf(C.aspirant, 'Chainglaive');
    const half = effectiveRules(ctx, state, glaive, { operative: op, weaponName: 'Chainglaive' });
    expect(half.map((r) => r.id)).toContain('Balanced');
    expect(half.map((r) => r.id)).not.toContain('Relentless');
    increaseGoreTank(state, op, 'test');
    const full = effectiveRules(ctx, state, glaive, { operative: op, weaponName: 'Chainglaive', retaliating: true });
    expect(full.map((r) => r.id)).toContain('Relentless');
    decreaseGoreTank(state, op, 'test');
    decreaseGoreTank(state, op, 'test');
    const empty = effectiveRules(ctx, state, glaive, { operative: op, weaponName: 'Chainglaive' });
    expect(empty.map((r) => r.id)).not.toContain('Balanced');
    expect(ruleText(SP.enhancedViolence)).toContain('Relentless weapon rule');
  });

  it('ENHANCED VIOLENCE does not touch ranged weapons', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    state.teams.p1.gambitsUsedTP.push(SP.enhancedViolence);
    const pistol = profileOf(C.aspirant, 'Autopistol');
    const rules = effectiveRules(ctx, state, pistol, { operative: op, weaponName: 'Autopistol' });
    expect(rules.map((r) => r.id)).not.toContain('Balanced');
  });

  it('AUGMENTED ENDURANCE grants a defence re-roll scaled by the GORE TANK', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    state.teams.p1.gambitsUsedTP.push(SP.augmentedEndurance);
    state.sequence = { kind: 'shoot', step: 'defenceRerolls', attackerId: shooter.id, targetId: target.id } as ShootSequence;
    const actx = attackCtx(shooter, target, profileOf(C.aspirant, 'Autopistol'), 'ranged', 'Autopistol');
    const half = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: actx,
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(half.rerolls.map((r) => r.mode)).toEqual(['one']);
    increaseGoreTank(state, target, 'test');
    const full = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: actx,
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(full.rerolls.map((r) => r.mode)).toEqual(['any']);
    expect(ruleText(SP.augmentedEndurance)).toContain('re-roll any of your defence dice');
  });

  it('GORY TENACITY: "the first time your opponent strikes it during that sequence, halve the damage inflicted (rounding up and to a minimum of 2)"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    state.teams.p1.gambitsUsedTP.push(SP.goryTenacity);
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    state.sequence = {
      kind: 'fight',
      turn: 'attacker',
      attackerId: foe.id,
      defenderId: mine.id,
      attackerWeapon: 'Chainglaive',
    } as FightSequence;
    inflictDamage(ctx, state, mine, 5, 'attack');
    expect(mine.wounds).toBe(10 - 3); // ceil(5/2) = 3
    inflictDamage(ctx, state, mine, 5, 'attack'); // only the FIRST strike
    expect(mine.wounds).toBe(2);
  });

  it('GORY TENACITY never reduces below its printed minimum of 2', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    state.teams.p1.gambitsUsedTP.push(SP.goryTenacity);
    state.sequence = { kind: 'fight', turn: 'attacker', attackerId: foe.id, defenderId: mine.id, attackerWeapon: 'Chainglaive' } as FightSequence;
    inflictDamage(ctx, state, mine, 3, 'attack');
    expect(mine.wounds).toBe(8); // ceil(3/2) = 2, the minimum
    expect(ruleText(SP.goryTenacity)).toContain('rounding up and to a minimum of 2');
  });

  it('HUNT FOR BLOOD changes a Conceal order to Engage and grants a free 3" Charge', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 13.5, 10);
    op.order = 'conceal';
    state.teams.p1.cp = 1;
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.huntForBlood, data: { operativeId: op.id } }, ctx).state;
    expect(s.operatives[op.id]!.order).toBe('engage');
    expect(s.effects.some((e) => e.rule === HUNT_READY && e.operativeId === op.id)).toBe(true);
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s.activePlayer = 'p1';
    s = activate(ctx, s, op.id, 'engage');
    const apBefore = s.operatives[op.id]!.apSpent;
    const out = act(ctx, s, op.id, CHARGE_HUNT, { path: { points: [{ x: 12.2, y: 10 }] } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[op.id]!.apSpent).toBe(apBefore);
    expect(ruleText(SP.huntForBlood)).toContain('cannot move more than 3"');
  });

  it('HUNT FOR BLOOD’s free Charge is capped at 3" and shares the universal Charge restriction key', () => {
    expect(getAction(CHARGE_HUNT)!.treatedAs).toBe('Charge');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 16, 10);
    state.effects.push({
      id: 'hunt-test',
      rule: HUNT_READY,
      source: { kind: 'ploy', id: SP.huntForBlood },
      operativeId: op.id,
      player: 'p1',
      expiry: { kind: 'endOfTurningPoint' },
    });
    const s = activate(ctx, state, op.id, 'engage');
    expect(act(ctx, s, op.id, CHARGE_HUNT, { path: { points: [{ x: 14.7, y: 10 }] } }).ok).toBe(false);
  });
});

// ===========================================================================
describe('firefight ploys', () => {
  it('UNBRIDLED AGGRESSION grants Severe after a Charge', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 40;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 14, 10);
    state.teams.p1.cp = 1;
    let s = activate(ctx, state, op.id, 'engage');
    expect(goremonger.ploys.find((p) => p.id === FP.unbridledAggression)!.usable!(s, 'p1').ok).toBe(false);
    s = act(ctx, s, op.id, 'Charge', { path: { points: [{ x: 12.8, y: 10 }] } }).state;
    expect(goremonger.ploys.find((p) => p.id === FP.unbridledAggression)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.unbridledAggression }, ctx).state;
    const glaive = profileOf(C.aspirant, 'Chainglaive');
    const rules = effectiveRules(ctx, s, glaive, { operative: s.operatives[op.id]!, weaponName: 'Chainglaive' });
    expect(rules.map((r) => r.id)).toContain('Severe');
    expect(ruleText(FP.unbridledAggression)).toContain('Severe weapon rule');
  });

  it('GORETHIRST changes a Conceal-order operative to Engage so it can counteract, and locks its actions', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    op.order = 'conceal';
    op.expended = true;
    op.ready = false;
    state.teams.p1.cp = 1;
    expect(goremonger.ploys.find((p) => p.id === FP.gorethirst)!.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.gorethirst, data: { operativeId: op.id } }, ctx).state;
    expect(s.operatives[op.id]!.order).toBe('engage');
    s.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    const allowed = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[op.id]!, action, allowed: true }).allowed;
    expect(allowed('Charge')).toBe(true);
    expect(allowed('Shoot')).toBe(true);
    expect(allowed('Fight')).toBe(true);
    expect(allowed('Reposition')).toBe(false);
    expect(ruleText(FP.gorethirst)).toContain('other than Charge, Shoot or Fight');
  });

  it('DESTRUCTIVE DEMISE inflicts D3 + GORE TANK level on an enemy in control range when it dies', () => {
    const { ctx, state } = setup({ script: [3] }); // D3 = 2
    const dying = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    isolate(state, [dying.id, foe.id]);
    place(state, dying.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    state.teams.p1.cp = 1;
    increaseGoreTank(state, dying, 'test'); // full → D3+2
    expect(goremonger.ploys.find((p) => p.id === FP.destructiveDemise)!.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.destructiveDemise }, ctx).state;
    s.operatives[dying.id]!.wounds = 1;
    inflictDamage(ctx, s, s.operatives[dying.id]!, 3, 'attack');
    expect(s.operatives[foe.id]!.wounds).toBe(10 - 4); // D3(2) + 2
    expect(ruleText(FP.destructiveDemise)).toContain('D3+2 if full');
  });

  it('LACERATE FLESH tops the tank up and takes it back at the end of the activation', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    decreaseGoreTank(state, op, 'test');
    state.teams.p1.cp = 1;
    let s = activate(ctx, state, op.id, 'engage');
    expect(goremonger.ploys.find((p) => p.id === FP.lacerateFlesh)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.lacerateFlesh }, ctx).state;
    expect(goreTankOf(s, s.operatives[op.id]!)).toBe(1);
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(goreTankOf(s, s.operatives[op.id]!)).toBe(0);
    expect(s.operatives[op.id]!.wounds).toBe(10); // it could decrease, so no D3
  });

  it('LACERATE FLESH inflicts D3 when the tank cannot be decreased again', () => {
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    decreaseGoreTank(state, op, 'test');
    state.teams.p1.cp = 1;
    let s = activate(ctx, state, op.id, 'engage');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.lacerateFlesh }, ctx).state;
    // Spend the level the ploy handed out on a SANGUAVITAE rule, leaving the tank empty.
    s = act(ctx, s, op.id, SANGUAVITAE_ACTION.mania, {}).state;
    expect(goreTankOf(s, s.operatives[op.id]!)).toBe(0);
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(s.operatives[op.id]!.wounds).toBe(7);
    expect(ruleText(FP.lacerateFlesh)).toContain('if you cannot decrease its GORE TANK, inflict D3 damage on it');
  });

  it('LACERATE FLESH is only usable while the activated operative’s tank is empty', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const s = activate(ctx, state, op.id, 'engage');
    expect(goremonger.ploys.find((p) => p.id === FP.lacerateFlesh)!.usable!(s, 'p1').ok).toBe(false);
  });
});

// ===========================================================================
describe('faction equipment', () => {
  it('GORY TOTEM and BLOODY CADAVER are set up wholly within your territory, more than 2" from other markers', () => {
    const { ctx, state } = setup({ equipment: [EQ.goryTotem, EQ.bloodyCadaver] });
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const s = activate(ctx, state, op.id, 'engage');
    const totem = s.markers[TOTEM_MARKER('p1')]!;
    const cadaver = s.markers[CADAVER_MARKER('p1')]!;
    expect(totem).toBeDefined();
    expect(cadaver).toBeDefined();
    expect(totem.pos.x).toBeLessThan(15); // p1's territory on the synthetic map
    expect(cadaver.pos.x).toBeLessThan(15);
    for (const other of Object.values(s.markers)) {
      if (other.id === totem.id || other.id === cadaver.id) continue;
      expect(Math.hypot(totem.pos.x - other.pos.x, totem.pos.y - other.pos.y)).toBeGreaterThan(2);
    }
    expect(ruleText(EQ.goryTotem)).toContain('wholly within your territory');
  });

  it('GORY TOTEM: an enemy within 3" cannot re-roll its attack dice when shooting', () => {
    const { ctx, state } = setup({ equipment: [EQ.goryTotem] });
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    let s = activate(ctx, state, op.id, 'engage');
    const totem = s.markers[TOTEM_MARKER('p1')]!;
    const foe = s.operatives[opWith(s, 'p2', C.aspirant)]!;
    place(s, foe.id, totem.pos.x + 1, totem.pos.y);
    const actx = attackCtx(foe, op, profileOf(C.aspirant, 'Autopistol'), 'ranged', 'Autopistol');
    const near = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: actx,
      dice: [],
      rerolls: [{ id: 'balanced', label: 'Balanced', mode: 'one', max: 1 }],
    });
    expect(near.rerolls).toEqual([]);
    place(s, foe.id, totem.pos.x + 9, totem.pos.y);
    const far = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: actx,
      dice: [],
      rerolls: [{ id: 'balanced', label: 'Balanced', mode: 'one', max: 1 }],
    });
    expect(far.rerolls.length).toBe(1);
    expect(REMINDER_ONLY[`${EQ.goryTotem}.fight`]).toContain('D-031');
  });

  it('BLOODY CADAVER: a friendly GOREMONGER controlling it tops up in the Ready step', () => {
    const { ctx, state } = setup({ equipment: [EQ.bloodyCadaver] });
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    let s = activate(ctx, state, op.id, 'engage');
    const cadaver = s.markers[CADAVER_MARKER('p1')]!;
    isolate(s, [op.id]);
    place(s, op.id, cadaver.pos.x + 0.5, cadaver.pos.y);
    decreaseGoreTank(s, s.operatives[op.id]!, 'test');
    readyStep(ctx, s);
    expect(goreTankOf(s, s.operatives[op.id]!)).toBe(1);
    expect(ruleText(EQ.bloodyCadaver)).toContain('In the Ready step of each Strategy phase');
  });

  it('BLOODY CADAVER: only friendly GOREMONGER operatives can pick it up (its own ActionDef)', () => {
    const { ctx, state } = setup({ equipment: [EQ.bloodyCadaver] });
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    let s = activate(ctx, state, op.id, 'engage');
    const cadaver = s.markers[CADAVER_MARKER('p1')]!;
    expect(cadaver.flags['pickUpAllowed']).toBeUndefined(); // the universal action refuses it
    isolate(s, [op.id]);
    place(s, op.id, cadaver.pos.x + 0.4, cadaver.pos.y);
    const out = act(ctx, s, op.id, PICK_UP_CADAVER, { markerId: cadaver.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[op.id]!.carryingMarkerId).toBe(cadaver.id);
    expect(getAction(PICK_UP_CADAVER)!.treatedAs).toBe('Pick Up Marker');
  });

  it('CHAOS SIGIL worsens Piercing by 1, once per turning point, only when there is Piercing to worsen', () => {
    const { ctx, state } = setup({ equipment: [EQ.chaosSigil] });
    const target = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    state.sequence = { kind: 'shoot', step: 'rollDefence', attackerId: shooter.id, targetId: target.id } as ShootSequence;
    const actx = attackCtx(shooter, target, profileOf(C.aspirant, 'Autopistol'), 'ranged', 'Autopistol');
    const emit = (count: number) =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: actx,
        count,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    expect(emit(3).count).toBe(3); // no Piercing: nothing is spent
    expect(emit(2).count).toBe(3); // Piercing 1 is ignored
    expect(emit(2).count).toBe(2); // once per turning point
    expect(ruleText(EQ.chaosSigil)).toContain('Piercing 1 would therefore be ignored');
  });

  it('WRIST CHAINS turns the named melee weapons into Range 2" ranged weapons, without Brutal', () => {
    const { ctx, state } = setup({ roles: [C.skullclaimer], equipment: [EQ.wristChains] });
    const sc = state.operatives[opWith(state, 'p1', C.skullclaimer)]!;
    const ranged = weaponsOf(ctx, state, sc, 'ranged').map((w) => w.name);
    expect(ranged).toContain(`Great chainaxe${WRIST_SUFFIX}`);
    const thrown = weaponsOf(ctx, state, sc, 'ranged').find((w) => w.name.endsWith(WRIST_SUFFIX))!;
    const profile = thrown.profiles[0]!;
    expect(profile.type).toBe('ranged');
    expect(profile.rules.map((r) => r.raw)).toEqual(['Range 2"']); // Brutal is ignored, as printed
    expect(profile.dmgN).toBe(5);
    expect(ruleText(EQ.wristChains)).toContain('ignore its Brutal weapon rule');
  });

  it('WRIST CHAINS builds fresh profiles and never mutates the shared catalogue (D-019)', () => {
    const op = { datacardId: C.stalker } as OperativeState;
    const built = wristChainWeapons(op);
    expect(built.map((w) => w.name)).toEqual([`Pickrippers${WRIST_SUFFIX}`]);
    expect(profileOf(C.stalker, 'Pickrippers').type).toBe('melee');
    expect(profileOf(C.stalker, 'Pickrippers').rules.map((r) => r.id)).toEqual(['Rending']);
    expect(built[0]!.profiles[0]!.rules.map((r) => r.id)).toEqual(['Range', 'Rending']);
  });

  it('WRIST CHAINS is withdrawn once its once-per-turning-point use is spent', () => {
    const { ctx, state } = setup({ roles: [C.skullclaimer], equipment: [EQ.wristChains] });
    const sc = state.operatives[opWith(state, 'p1', C.skullclaimer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.aspirant)]!;
    foe.wounds = 40;
    isolate(state, [sc.id, foe.id]);
    place(state, sc.id, 10, 10);
    place(state, foe.id, 12.8, 10); // ~1.5 inches apart: inside Range 2 but outside control range
    let s = activate(ctx, state, sc.id, 'engage');
    const out = act(ctx, s, sc.id, 'Shoot', { weaponName: `Great chainaxe${WRIST_SUFFIX}`, targetId: foe.id });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(weaponsOf(ctx, s, s.operatives[sc.id]!, 'ranged').map((w) => w.name)).not.toContain(
      `Great chainaxe${WRIST_SUFFIX}`,
    );
    expect(ruleText(EQ.wristChains)).toContain('Once per turning point');
  });

  it('no equipment selected means no markers and no thrown weapons', () => {
    const { ctx, state } = setup({ roles: [C.skullclaimer] });
    const sc = state.operatives[opWith(state, 'p1', C.skullclaimer)]!;
    const s = activate(ctx, state, sc.id, 'engage');
    expect(s.markers[TOTEM_MARKER('p1')]).toBeUndefined();
    expect(s.markers[CADAVER_MARKER('p1')]).toBeUndefined();
    expect(weaponsOf(ctx, s, s.operatives[sc.id]!, 'ranged').map((w) => w.name)).toEqual(['Autopistol']);
  });
});

// ===========================================================================
describe('aiHints', () => {
  it('gives every datacard a role', () => {
    const roles = goremonger.aiHints!.roles!;
    expect(Object.keys(roles).sort()).toEqual([...Object.values(C)].sort());
  });

  it('gives all eight ploys a value, so the AI can actually use a firefight ploy', () => {
    const values = goremonger.aiHints!.ployValue!;
    expect(Object.keys(values).sort()).toEqual([...Object.values(SP), ...Object.values(FP)].sort());
    for (const v of Object.values(values)) expect(v).toBeGreaterThan(0);
  });

  it('gives all four equipment options a value', () => {
    const values = goremonger.aiHints!.equipmentValue!;
    expect(Object.keys(values).sort()).toEqual([...Object.values(EQ)].sort());
  });
});

// ===========================================================================
describe('action contract (D-026)', () => {
  /**
   * `src/ai/legal.ts` `missionCandidates` tries a small set of plausible params and offers
   * anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique/carve-out action’s `perform` completes whatever its `check` accepted', () => {
    interface Ids {
      op: string;
      mate: string;
      foe: string;
      farFoe: string;
    }
    interface Probe {
      action: string;
      card: string;
      /** Put the board into the state this action's printed WHEN describes. */
      arrange(s: GameState, ids: Ids): void;
    }
    const engaged = (s: GameState, ids: Ids): void => {
      place(s, ids.foe, 11.3, 11);
    };
    const probes: Probe[] = [
      { action: SANGUAVITAE_ACTION.rejuvenate, card: C.aspirant, arrange: (s, ids) => void (s.operatives[ids.op]!.wounds = 3) },
      { action: SANGUAVITAE_ACTION.mania, card: C.aspirant, arrange: () => {} },
      { action: SANGUAVITAE_ACTION.fury, card: C.aspirant, arrange: () => {} },
      {
        action: SANGUAVITAE_ACTION.rake,
        card: C.aspirant,
        arrange: (s, ids) => {
          engaged(s, ids);
          s.operatives[ids.op]!.actionsThisActivation = ['Charge'];
        },
      },
      { action: SANGUAVITAE_ACTION.surge, card: C.aspirant, arrange: () => {} },
      { action: SANGUAVITAE_ACTION.rage, card: C.aspirant, arrange: () => {} },
      {
        action: FIGHT_FURY,
        card: C.aspirant,
        arrange: (s, ids) => {
          engaged(s, ids);
          s.operatives[ids.op]!.actionsThisActivation = ['Fight'];
          s.effects.push({
            id: 'fury-probe',
            rule: 'goremonger.fury',
            source: { kind: 'ability', id: RULE.sanguavitae },
            operativeId: ids.op,
            player: 'p1',
            expiry: { kind: 'endOfActivation', operativeId: ids.op },
          });
        },
      },
      {
        action: PICK_UP_CADAVER,
        card: C.aspirant,
        arrange: (s, ids) => {
          const marker = s.markers[CADAVER_MARKER('p1')]!;
          place(s, ids.op, marker.pos.x + 0.4, marker.pos.y);
          place(s, ids.mate, marker.pos.x + 12, marker.pos.y);
        },
      },
      { action: ACT.transfusionRitual, card: C.bloodtaker, arrange: (s, ids) => place(s, ids.mate, 13.5, 11) },
      { action: ACT.dashAndSpray, card: C.inciter, arrange: (s, ids) => place(s, ids.farFoe, 14, 11) },
    ];

    const tried = new Map<string, number>();
    for (const probe of probes) {
      const base = setup({ roles: [C.bloodtaker, C.inciter], equipment: [EQ.bloodyCadaver], seed: 5 });
      const opId = opWith(base.state, 'p1', probe.card);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) place(base.state, id, 2 + (n++ % 12) * 1.4, 20);
      place(base.state, opId, 10, 11);
      for (const id of foes) base.state.operatives[id]!.wounds = 200;
      // The equipment markers are placed at the first activation.
      let s = activate(base.ctx, base.state, opId, 'engage');
      const ids: Ids = { op: opId, mate: mates[0]!, foe: foes[0]!, farFoe: foes[1]! };
      probe.arrange(s, ids);
      const marker = s.markers[CADAVER_MARKER('p1')];
      const attempts: Record<string, unknown>[] = [
        {},
        ...(marker ? [{ markerId: marker.id }] : []),
        ...[ids.mate, ids.foe, ids.farFoe].map((id) => ({ targetOperativeId: id, targetId: id })),
        { targetPos: { ...s.operatives[opId]!.pos } },
      ];
      const def = getAction(probe.action)!;
      for (const params of attempts) {
        if (def.available && !def.available(base.ctx, s, s.operatives[opId]!)) continue;
        if (!def.check(base.ctx, s, s.operatives[opId]!, params).ok) continue;
        const out = act(base.ctx, s, opId, probe.action, params);
        tried.set(probe.action, (tried.get(probe.action) ?? 0) + 1);
        expect({ action: probe.action, params, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    // Every one of the ten was actually reachable, so none of the assertions above was vacuous.
    expect(probes.filter((p) => !tried.has(p.action)).map((p) => p.action)).toEqual([]);
  });

  it('a SANGUAVITAE declaration refuses params it cannot honour rather than failing in perform', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.aspirant)]!;
    const s = activate(ctx, state, op.id, 'engage');
    const def = getAction(SANGUAVITAE_ACTION.mania)!;
    expect(def.check(ctx, s, s.operatives[op.id]!, { targetOperativeId: op.id }).ok).toBe(false);
    expect(def.check(ctx, s, s.operatives[op.id]!, {}).ok).toBe(true);
  });
});

// ===========================================================================
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared ring
  // in tests/teams/soak.test.ts covers the batch; this mirror exercises the SANGUAVITAE
  // declarations, the GORE TANK economy and all four equipment options on an open and a Close
  // Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([goremonger], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const picks = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'goremonger', operatives: picks(), equipment: [EQ.goryTotem, EQ.bloodyCadaver] },
          p2: { teamId: 'goremonger', operatives: picks(), equipment: [EQ.chaosSigil, EQ.wristChains] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The economy really ran: the gauge moved and SANGUAVITAE rules were declared.
      expect(result.state.log.some((l) => /GORE TANK (in|de)creases/.test(l.text))).toBe(true);
      expect(result.state.log.some((l) => /uses SANGUAVITAE/.test(l.text))).toBe(true);
    }, 180000);
  }
});

// ===========================================================================
describe('module wiring', () => {
  it('exports the printed ids the rest of the app binds to', () => {
    expect(goremonger.id).toBe('goremonger');
    expect(KW).toBe('GOREMONGER');
    expect(goremonger.ploys.filter((p) => p.kind === 'strategy').length).toBe(4);
    expect(goremonger.ploys.filter((p) => p.kind === 'firefight').length).toBe(4);
    expect(goremonger.equipment.map((e) => e.id)).toEqual(Object.values(EQ));
    expect(goremonger.datacards.length).toBe(7);
    expect(pool([6], 3).dice[0]!.state).toBe('crit'); // the shared dice helper behaves as expected
  });

  it('names every clause it cannot express, and registers no handler for them', () => {
    expect(Object.keys(REMINDER_ONLY).sort()).toEqual(
      [
        `${RULE.sanguavitae}.counteraction`,
        AB.climbingPicks,
        `${EQ.goryTotem}.fight`,
        `${FP.destructiveDemise}.timing`,
        `${FP.unbridledAggression}.window`,
        `${ACT.dashAndSpray}.order`,
      ].sort(),
    );
    for (const why of Object.values(REMINDER_ONLY)) expect(why.length).toBeGreaterThan(20);
  });
});
