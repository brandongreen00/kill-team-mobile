/**
 * FARSTALKER KINBAND. Every test quotes the printed rule it pins, read out of
 * `data/teams/farstalker-kinband.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/farstalker-kinband/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, apBudgetOf, aplOf, freeApOf, inflictDamage, markerContestedBy } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/farstalker-kinband.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  AB,
  ACT,
  BOUND_CHARGE,
  BOUND_FALL_BACK,
  BOUND_REPOSITION,
  C,
  CHANGE_ORDER_COUNTERACT,
  E,
  EQ,
  FP,
  KW,
  ORDER_DECISION,
  PECHRA_MARKER,
  POACH_PICK_UP,
  QUICK_DRAW_SHOOT,
  REMINDER_ONLY,
  RULE,
  SALVO_SHOOT,
  SAVAGE_FIGHT,
  SP,
  STALKER_CHARGE,
  ammoWeapon,
  farstalkerKinband,
  markOf,
  pechraMarker,
} from '../../src/teams/farstalker-kinband/index.ts';
import { act, activate, battle, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('farstalker-kinband');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

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

/** A Heavy block at x 12-15, y 8-11: the printed "Light or Heavy terrain" tests need one. */
const HEAVY_MAP = () => testMap({ features: [heavyBlock('kinband.heavy', 12, 8, 3, 3)] });
/** Beside that block, and clear of it: within 1" of Heavy terrain. */
const BESIDE_HEAVY = { x: 11, y: 9.5 };

function setup(opts: { equipment?: string[]; script?: number[]; seed?: number; heavy?: boolean } = {}): {
  ctx: GameContext;
  state: GameState;
} {
  const ctx = teamContext([farstalkerKinband], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.heavy ? { map: HEAVY_MAP() } : {}),
    p1: { module: farstalkerKinband, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: farstalkerKinband, picks },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Park everything else far away so a control-range / distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.4 + (n % 3) * 1.3, y: 20 + Math.floor(n / 3) * 1.3 };
    n++;
  }
}

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootSeq(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'retention',
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
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    free: false,
    ...over,
  };
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
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

const rulesFor = (
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  target: OperativeState,
  cardId: string,
  weapon: string,
  profileName?: string,
): string[] =>
  effectiveRules(ctx, state, profileOf(cardId, weapon, profileName), {
    operative: op,
    target,
    weaponName: weapon,
  }).map((r) => r.id);

// ---------------------------------------------------------------------------
describe('FARSTALKER KINBAND data (pinned against data/teams/farstalker-kinband.json)', () => {
  it('has 11 Kroot datacards, all APL 2 / Save 5+, the 32mm 9-wound KILL-BROKER apart', () => {
    expect(DATA.datacards).toHaveLength(11);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, save: 5 });
      expect(card.keywords).toContain(KW);
      expect(card.keywords).toContain('KROOT');
      expect(card.keywords).toContain('T’AU EMPIRE');
    }
    expect(DATA.datacards.find((c) => c.id === C.killBroker)).toMatchObject({
      wounds: 9,
      move: 6,
      base: { shape: 'round', mm: 32 },
      keywords: expect.arrayContaining(['LEADER']),
    });
    expect(DATA.datacards.filter((c) => c.base.mm !== 28).map((c) => c.id)).toEqual([C.killBroker]);
    // The COLD-BLOOD is the only 9-wound non-leader; the HOUND is the only M 8" / W 7 operative.
    expect(DATA.datacards.filter((c) => c.wounds === 9).map((c) => c.id).sort()).toEqual(
      [C.coldBlood, C.killBroker].sort(),
    );
    expect(DATA.datacards.find((c) => c.id === C.hound)).toMatchObject({ move: 8, wounds: 7 });
    expect(DATA.datacards.filter((c) => c.move !== 6).map((c) => c.id)).toEqual([C.hound]);
  });

  it('exposes 1 faction rule, 4+4 ploys, 4 equipment options, 13 abilities and 6 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Farstalker']);
    expect(farstalkerKinband.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(farstalkerKinband.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(farstalkerKinband.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(13);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(6);
    expect(NOTES).toEqual([]);
    // Every ploy costs 1CP and no name/id carries a glued-on "1CP" (the batch-4 scraper bug).
    for (const p of farstalkerKinband.ploys) {
      expect(p.cp).toBe(1);
      expect(p.name).not.toMatch(/1CP/i);
      expect(p.id).not.toMatch(/1cp/i);
    }
  });

  it('the two rare weapon rules are Concealed Position (hunting rifle) and Salvo (dual pistols)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['ConcealedPosition', 'Salvo']);
    expect(profileOf(C.longSight, 'Kroot hunting rifle', 'concealed').rules.map((r) => r.raw)).toEqual([
      'Heavy',
      'Devastating 3',
      'Silent',
      'Concealed Position*',
    ]);
    expect(profileOf(C.pistolier, 'Dual Kroot pistols', 'salvo').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Salvo*',
    ]);
    // D-033: each rule resolves against THIS team's own datacard ability, not the shared registry.
    expect(rareWeaponRuleText('ConcealedPosition', 'farstalker-kinband')).toBe(
      abilityText(C.longSight, AB.concealedPosition),
    );
    expect(rareWeaponRuleText('Salvo', 'farstalker-kinband')).toBe(abilityText(C.pistolier, AB.salvo));
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(C.killBroker, 'Kroot rifle')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(C.killBroker, 'Pulse weapon')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.killBroker, 'Ritual blade')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.cutSkin, "Cut-skin's blades").rules.map((r) => r.raw)).toEqual(['Ceaseless', 'Lethal 5+']);
    expect(profileOf(C.stalker, "Stalker's blade").rules.map((r) => r.raw)).toEqual(['Balanced', 'Rending']);
    expect(profileOf(C.hound, 'Ripping fangs')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    const bow = DATA.datacards.find((c) => c.id === C.bowHunter)!.weapons.find((w) => w.name === 'Accelerator bow')!;
    expect(bow.profiles.map((p) => p.name)).toEqual(['fused arrow', 'glide arrow', 'voltaic arrow']);
    expect(profileOf(C.longSight, 'Kroot hunting rifle', 'stationary')).toMatchObject({ atk: 4, hit: 2, dmgN: 3, dmgC: 3 });
  });

  it('docs/TEAM-DATA.md §7: the Dvorgite skinner gained Range 6" and the salvo profile gained Salvo', () => {
    expect(profileOf(C.heavyGunner, 'Dvorgite skinner').rules.map((r) => r.raw)).toEqual([
      'Range 6"',
      'Heavy (Reposition only)',
      'Piercing 2',
      'Torrent 2"',
    ]);
    expect(profileOf(C.heavyGunner, 'Londaxi tribalest').rules.map((r) => r.raw)).toEqual([
      'Heavy (Reposition only)',
      'Piercing 1',
      'Rending',
    ]);
    expect(profileOf(C.pistolier, 'Dual Kroot pistols', 'salvo').rules.some((r) => r.id === 'Salvo')).toBe(true);
  });

  it('docs/TEAM-DATA.md §7: the TRACKER and WARRIOR now carry a plain "Blade", not a Stalker’s blade', () => {
    for (const cardId of [C.tracker, C.warrior]) {
      const names = DATA.datacards.find((c) => c.id === cardId)!.weapons.map((w) => w.name);
      expect(names).toContain('Blade');
      expect(names).not.toContain("Stalker's blade");
      expect(profileOf(cardId, 'Blade')).toMatchObject({ atk: 3, hit: 3, dmgN: 3, dmgC: 5 });
      expect(profileOf(cardId, 'Blade').rules).toEqual([]);
    }
    // Only the STALKER keeps the Balanced/Rending blade.
    expect(DATA.datacards.filter((c) => c.weapons.some((w) => w.name === "Stalker's blade")).map((c) => c.id)).toEqual([
      C.stalker,
    ]);
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('during one climb up.')).toBe(true);
    expect(DATA.firefightPloys[3]!.text.endsWith('until that enemy operative is incapacitated.')).toBe(true);
    // The raw committed bytes still carry the overrun — a data problem, not a module one.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('DATA PROBLEM: the LONG-SIGHT action’s printed effect list is truncated out of the JSON', () => {
    const printed = actionOf(C.longSight, ACT.longSight);
    expect(printed.text).toContain('Until the start of this operative’s next activation:');
    // Nothing follows the colon except the action's own restriction line.
    const after = printed.text.split('next activation:')[1]!.trim();
    expect(after).toBe('This operative cannot perform this action while within control range of an enemy operative.');
    expect(REMINDER_ONLY[ACT.longSight]).toContain('truncated');
  });

  it('no faction rule or equipment entry hides a weapon table that parsed to rules: []', () => {
    const raw = rawJson as { factionRules: unknown[]; equipment: { weapons?: unknown[] }[] };
    for (const entry of [...raw.factionRules, ...raw.equipment] as { weapons?: { profiles: { rules: unknown[] }[] }[] }[]) {
      for (const w of entry.weapons ?? []) for (const p of w.profiles) expect(p.rules).not.toEqual([]);
    }
    // …and every rare weapon rule the datacards footnote is registered in `rareWeaponRules`.
    const footnoted = new Set<string>();
    for (const card of DATA.datacards)
      for (const w of card.weapons)
        for (const p of w.profiles)
          for (const r of p.rules) if (/[*^]/.test(r.raw)) footnoted.add(r.id);
    expect([...footnoted].sort()).toEqual(DATA.rareWeaponRules.slice().sort());
  });
});

// ---------------------------------------------------------------------------
describe('FARSTALKER KINBAND selection', () => {
  it('prints uniqueExcept HOUND/WARRIOR and "up to two HOUND operatives"', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['HOUND', 'WARRIOR'] },
      { kind: 'maxCount', role: 'HOUND', max: 2 },
    ]);
    expect(DATA.selection.rawText).toContain(
      'Other than HOUND and WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.rawText).toContain('Your kill team can only include up to two HOUND operatives.');
    // No `custom` constraint, so the shared validator covers this team completely.
    expect(DATA.selection.constraints.some((c) => c.kind === 'custom')).toBe(false);
  });

  it('every selection list row has a datacard, and defaultRoster fields all 11 datacards', () => {
    for (const entry of [...DATA.selection.leaderList, ...DATA.selection.list]) {
      expect(DATA.datacards.some((c) => c.id === entry.datacardId)).toBe(true);
    }
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(12); // 1 KILL-BROKER + 11 from the list
    expect(picks[0]!.datacardId).toBe(C.killBroker);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(new Set(picks.map((p) => p.datacardId)).size).toBe(11);
    expect(picks.filter((p) => p.datacardId === C.hound)).toHaveLength(2);
  });

  it('the shared validator enforces the HOUND cap and the uniqueExcept exemption', () => {
    const base = defaultRoster(DATA).filter((p) => p.datacardId !== C.hound);
    const hound = { datacardId: C.hound, entryId: 'farstalker-kinband.sel4.hound' };
    expect(validateRosterFor(DATA, [...base, hound, hound, hound]).codes).toContain('maxCount');
    // WARRIOR is exempt from "only once", so two of them is legal.
    const warrior = { datacardId: C.warrior, entryId: 'farstalker-kinband.sel10.warrior', loadoutIds: ['farstalker-kinband.g2e10.opt1'] };
    const twoWarriors = validateRosterFor(DATA, [...base, hound, warrior, warrior]);
    expect(twoWarriors.codes).not.toContain('uniqueExcept');
  });

  it('defaultRoster takes the first option on both choice rows, so two weapons are never fielded', () => {
    const weapons = validateRosterFor(DATA, defaultRoster(DATA)).weapons.flat();
    expect(weapons).toContain('Dvorgite skinner');
    expect(weapons).not.toContain('Londaxi tribalest'); // HEAVY GUNNER option 2
    expect(weapons.filter((w) => w === 'Kroot scattergun')).toHaveLength(1); // the STALKER's only
  });
});

// ---------------------------------------------------------------------------
describe('Farstalker — "In the Ready step of each Strategy phase, you can change the order of up to three friendly FARSTALKER KINBAND operatives that are not within control range of enemy operatives"', () => {
  it('the Ready step raises a real decision whose FIRST option declines', () => {
    const { ctx, state } = setup();
    state.pending = [];
    readyStep(ctx, state);
    const mine = state.pending.filter((d) => d.kind === ORDER_DECISION && d.who === 'p1');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.options[0]!.id).toBe('none');
    expect(mine[0]!.sourceText).toBeTruthy();
    expect(ruleText(RULE.farstalker)).toContain('you can change the order of up to three friendly');
  });

  it('resolving one option flips that operative’s order and re-offers, up to three times', () => {
    const { ctx, state } = setup();
    state.pending = [];
    readyStep(ctx, state);
    let s = state;
    const flipped: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = s.pending.find((x) => x.kind === ORDER_DECISION && x.who === 'p1');
      if (!d) break;
      const pick = d.options.find((o) => o.id !== 'none' && !flipped.includes(o.id));
      if (!pick) break;
      const before = s.operatives[pick.id]!.order;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: pick.id }, ctx).state;
      expect(s.operatives[pick.id]!.order).not.toBe(before);
      flipped.push(pick.id);
    }
    expect(flipped).toHaveLength(3); // "up to three"
    expect(s.pending.filter((x) => x.kind === ORDER_DECISION && x.who === 'p1')).toHaveLength(0);
  });

  it('an operative within control range of an enemy is never offered', () => {
    const { ctx, state } = setup();
    const stuck = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [stuck.id, foe.id]);
    place(state, stuck.id, 10, 10);
    place(state, foe.id, 10.5, 10);
    state.pending = [];
    readyStep(ctx, state);
    const d = state.pending.find((x) => x.kind === ORDER_DECISION && x.who === 'p1')!;
    expect(d.options.map((o) => o.id)).not.toContain(stuck.id);
  });

  it('declining ends the offer, so a bot game sees exactly one decision per Ready step', () => {
    const { ctx, state } = setup();
    state.pending = [];
    readyStep(ctx, state);
    const d = state.pending.find((x) => x.kind === ORDER_DECISION && x.who === 'p1')!;
    const after = reduce(state, { t: 'ResolveDecision', decisionId: d.id, optionId: 'none' }, ctx).state;
    expect(after.pending.filter((x) => x.kind === ORDER_DECISION && x.who === 'p1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('Farstalker — "Whenever it’s your turn to counteract, you can change the order of one friendly FARSTALKER KINBAND operative … instead"', () => {
  function counteractSetup(): { ctx: GameContext; state: GameState; op: OperativeState } {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    isolate(state, [op.id]);
    place(state, op.id, 10, 10);
    op.order = 'engage';
    op.ready = false;
    op.expended = true;
    op.counteractedThisTP = true;
    state.activeOperativeId = op.id;
    state.activePlayer = 'p1';
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    return { ctx, state, op };
  }

  it('changes the order of the counteracting operative and hands its counteraction back', () => {
    const { ctx, state, op } = counteractSetup();
    const r = act(ctx, state, op.id, CHANGE_ORDER_COUNTERACT, {});
    expect(r.ok).toBe(true);
    expect(r.state.operatives[op.id]!.order).toBe('conceal');
    // "…but doesn't count as that friendly operative's counteraction for this turning point."
    expect(r.state.operatives[op.id]!.counteractedThisTP).toBe(false);
    expect(ruleText(RULE.farstalker)).toContain('doesn’t count as that friendly operative’s counteraction');
  });

  it('it can change another friendly operative’s order, and refuses an ineligible target', () => {
    const { ctx, state, op } = counteractSetup();
    const mate = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    place(state, mate.id, 12, 10);
    mate.order = 'conceal';
    const enemy = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const def = getAction(CHANGE_ORDER_COUNTERACT)!;
    expect(def.check(ctx, state, op, { targetOperativeId: enemy.id }).ok).toBe(false);
    const r = act(ctx, state, op.id, CHANGE_ORDER_COUNTERACT, { targetOperativeId: mate.id });
    expect(r.ok).toBe(true);
    expect(r.state.operatives[mate.id]!.order).toBe('engage');
  });

  it('is only available while counteracting', () => {
    const { ctx, state, op } = counteractSetup();
    delete state.opState['counteract'];
    const def = getAction(CHANGE_ORDER_COUNTERACT)!;
    expect(def.available!(ctx, state, op)).toBe(false);
    expect(def.check(ctx, state, op, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('CUT-THROATS — "Add 1 to the Atk stat of friendly FARSTALKER KINBAND operatives’ melee weapons (to a maximum of 5)"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.cutSkin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const profile = profileOf(C.cutSkin, "Cut-skin's blades");
    const collect = (): number =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(op, foe, profile, "Cut-skin's blades", 'melee'),
        count: profile.atk,
        mods: zeroStatMods(),
      }).count;
    expect(collect()).toBe(4);
    state.teams.p1.gambitsUsedTP.push(SP.cutThroats);
    expect(collect()).toBe(5);
    // "(to a maximum of 5)" — a 5-Atk melee weapon gains nothing.
    const big: WeaponProfile = { ...profile, atk: 5 };
    expect(
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(op, foe, big, "Cut-skin's blades", 'melee'),
        count: big.atk,
        mods: zeroStatMods(),
      }).count,
    ).toBe(5);
    expect(ruleText(SP.cutThroats)).toContain('to a maximum of 5');
  });

  it('CUT-THROATS applies to a RETALIATING operative too (fight.ts collects both pools)', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 10, 10);
    place(state, foe.id, 10.6, 10);
    state.teams.p1.gambitsUsedTP.push(SP.cutThroats);
    expect(startFight(ctx, state, foe, 'Blade', undefined, mine.id).ok).toBe(true);
    advanceFight(ctx, state);
    const seq = state.sequence as FightSequence;
    // The retaliating STALKER's blade is Atk 4 → 5 dice.
    expect(seq.defenderPool.dice).toHaveLength(5);
  });

  it('PREY — Balanced + Severe, or Ceaseless + Severe when the weapon already has Balanced', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    state.teams.p1.gambitsUsedTP.push(SP.prey);
    expect(rulesFor(ctx, state, op, foe, C.warrior, 'Kroot rifle')).toEqual(['Balanced', 'Severe']);
    // Victory Shriek already grants Balanced → the upgrade branch.
    state.effects.push({
      id: 'vs1',
      rule: E.victoryShriek,
      source: { kind: 'ability', id: AB.victoryShriek },
      operativeId: op.id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    expect(rulesFor(ctx, state, op, foe, C.warrior, 'Kroot rifle')).toEqual(['Balanced', 'Ceaseless', 'Severe']);
    expect(ruleText(SP.prey)).toContain('it has the Ceaseless and Severe weapon rules instead');
  });

  it('PREY does nothing in an activation in which the operative moved', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    state.teams.p1.gambitsUsedTP.push(SP.prey);
    op.actionsThisActivation.push('Reposition');
    expect(rulesFor(ctx, state, op, foe, C.warrior, 'Kroot rifle')).toEqual([]);
    expect(ruleText(SP.prey)).toContain('hasn’t performed the Charge, Fall Back or Reposition action');
  });

  it('ROGUE — ignores Saturate and retains one additional cover save', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const target = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const profile: WeaponProfile = { ...profileOf(C.warrior, 'Kroot rifle'), rules: [{ id: 'Saturate', raw: 'Saturate' }] };
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Kroot rifle',
      step: 'rollDefence',
      inCover: true,
    });
    const emit = () =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: { ...attackCtx(shooter, target, profile, 'Kroot rifle'), inCover: true },
        count: 3,
        coverSave: false, // Saturate has already denied it
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    expect(emit().coverSave).toBe(false);
    state.teams.p1.gambitsUsedTP.push(SP.rogue);
    const after = emit();
    expect(after.coverSave).toBe(true);
    expect(after.extraCoverSaves).toBe(1);
    expect(ruleText(SP.rogue)).toContain('Ignore the Saturate weapon rule.');
  });

  it('ROGUE is not cumulative with improved cover saves from Vantage terrain', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const target = state.operatives[opWith(state, 'p1', C.warrior)]!;
    state.teams.p1.gambitsUsedTP.push(SP.rogue);
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Kroot rifle',
      step: 'rollDefence',
      inCover: true,
      vantageImprovedCover: true,
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, profileOf(C.warrior, 'Kroot rifle'), 'Kroot rifle'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(0);
    expect(ruleText(SP.rogue)).toContain('isn’t cumulative with improved cover saves from Vantage terrain');
  });

  it('BOUND — three sibling move actions, offered only after the gambit and only for a climb', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const ids = [BOUND_REPOSITION, BOUND_CHARGE, BOUND_FALL_BACK];
    for (const id of ids) expect(getAction(id)!.available!(ctx, state, op)).toBe(false);
    state.teams.p1.gambitsUsedTP.push(SP.bound);
    for (const id of ids) expect(getAction(id)!.available!(ctx, state, op)).toBe(true);
    // Each is `treatedAs` its universal action, so action restrictions stay shared.
    expect(ids.map((id) => getAction(id)!.treatedAs)).toEqual(['Reposition', 'Charge', 'Fall Back']);
    // A flat path includes no climb up, so the discounted variant refuses it.
    const flat = { path: { points: [{ x: op.pos.x + 2, y: op.pos.y }] } };
    expect(getAction(BOUND_REPOSITION)!.check(ctx, state, op, flat)).toMatchObject({
      ok: false,
      reason: 'this move includes no climb up',
    });
    expect(ruleText(SP.bound)).toContain('ignore the first vertical distance of 2" they move during one climb up');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('SAVAGE AMBUSH — "you resolve the first attack dice (i.e. defender instead of attacker)"', () => {
    const { ctx, state } = setup({ heavy: true });
    const mine = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y);
    place(state, foe.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y + 1.05);
    expect(startFight(ctx, state, foe, 'Blade', undefined, mine.id).ok).toBe(true);
    const before = (state.sequence as FightSequence).turn;
    expect(before).toBe('attacker');
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.savageAmbush }, ctx);
    expect(r.ok).toBe(true);
    expect((r.state.sequence as FightSequence).turn).toBe('defender');
    expect(ruleText(FP.savageAmbush)).toContain('you resolve the first attack dice');
  });

  it('SAVAGE AMBUSH refunds its CP when no terrain is within the defender’s control range', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 15, 8);
    place(state, foe.id, 15.6, 8);
    expect(startFight(ctx, state, foe, 'Blade', undefined, mine.id).ok).toBe(true);
    const cp = state.teams.p1.cp;
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.savageAmbush }, ctx);
    expect(r.ok).toBe(true);
    expect(r.state.teams.p1.cp).toBe(cp); // 1CP paid, 1CP refunded
    expect((r.state.sequence as FightSequence).turn).toBe('attacker');
  });

  it('SAVAGE AMBUSH cannot be used when none of your operatives is being fought against', () => {
    const { ctx, state } = setup();
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.savageAmbush }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no fight is in progress');
  });

  it('POACH — a Pick Up Marker that only needs to CONTEST the marker', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [op.id, foe.id]);
    // Both contest the marker (so nobody controls it) but they are 2.5" apart base to base.
    place(state, op.id, 11.8, 10);
    place(state, foe.id, 8.2, 10);
    state.markers['m1'] = {
      id: 'm1',
      kind: 'intelligence',
      diameterMm: 20,
      pos: { x: 10, y: 10 },
      z: 0,
      flags: { pickUpAllowed: true },
    };
    let s = activate(ctx, state, op.id);
    // The universal action refuses it: neither player controls a contested marker.
    expect(getAction('Pick Up Marker')!.check(ctx, s, s.operatives[op.id]!, { markerId: 'm1' }).ok).toBe(false);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.poach }, ctx).state;
    expect(s.effects.some((e) => e.rule === E.poach && e.operativeId === op.id)).toBe(true);
    const r = act(ctx, s, op.id, POACH_PICK_UP, { markerId: 'm1' });
    expect(r.ok).toBe(true);
    expect(r.state.operatives[op.id]!.carryingMarkerId).toBe('m1');
    expect(ruleText(FP.poach)).toContain('it only needs to contest the marker');
  });

  it('POACH’s mission-action half is reminder-only', () => {
    expect(ruleText(FP.poach)).toContain('or mission actions that usually require this');
    expect(REMINDER_ONLY[`${FP.poach}.mission`]).toContain('src/core/ops');
  });

  it('SLIP AWAY — "that operative can perform the Fall Back action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    let s = activate(ctx, state, op.id);
    expect(actionCost(ctx, s, s.operatives[op.id]!, getAction('Fall Back')!)).toBe(2);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.slipAway }, ctx).state;
    expect(actionCost(ctx, s, s.operatives[op.id]!, getAction('Fall Back')!)).toBe(1);
    expect(ruleText(FP.slipAway)).toContain('can perform the Fall Back action for 1 less AP');
  });

  it('VENGEANCE FOR THE KINBAND — Relentless against the killer, when shooting, fighting AND retaliating', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const killer = state.operatives[opWith(state, 'p2', C.cutSkin)]!;
    const avenger = state.operatives[opWith(state, 'p1', C.warrior)]!;
    isolate(state, [victim.id, killer.id, avenger.id]);
    place(state, victim.id, 10, 10);
    place(state, killer.id, 10.6, 10);
    expect(startFight(ctx, state, killer, "Cut-skin's blades", undefined, victim.id).ok).toBe(true);
    inflictDamage(ctx, state, victim, 99, 'attack');
    // Before the ploy, nothing is granted.
    expect(rulesFor(ctx, state, avenger, killer, C.warrior, 'Kroot rifle')).not.toContain('Relentless');
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.vengeance }, ctx);
    expect(r.ok).toBe(true);
    const s = r.state;
    expect(rulesFor(ctx, s, avenger, killer, C.warrior, 'Kroot rifle')).toContain('Relentless');
    expect(rulesFor(ctx, s, avenger, killer, C.warrior, 'Blade')).toContain('Relentless');
    // A different enemy gets nothing.
    const other = s.operatives[opWith(s, 'p2', C.warrior)]!;
    expect(rulesFor(ctx, s, avenger, other, C.warrior, 'Kroot rifle')).not.toContain('Relentless');
    expect(ruleText(FP.vengeance)).toContain('shooting against, fighting against or retaliating against');
  });

  it('VENGEANCE FOR THE KINBAND cannot be used again until that enemy operative is incapacitated', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const killer = state.operatives[opWith(state, 'p2', C.cutSkin)]!;
    isolate(state, [victim.id, killer.id]);
    place(state, victim.id, 10, 10);
    place(state, killer.id, 10.6, 10);
    expect(startFight(ctx, state, killer, "Cut-skin's blades", undefined, victim.id).ok).toBe(true);
    inflictDamage(ctx, state, victim, 99, 'attack');
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.vengeance }, ctx).state;
    s.teams.p1.ploysUsedTP = []; // a new turning point would clear the once-per-TP limit
    const again = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.vengeance }, ctx);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('until that enemy operative is incapacitated');
    expect(ruleText(FP.vengeance)).toContain('You cannot use this ploy again during the battle');
  });

  it('VENGEANCE FOR THE KINBAND refuses when no friendly operative has been incapacitated', () => {
    const { ctx, state } = setup();
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.vengeance }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no enemy operative has incapacitated');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('PIERCING SHOT / TOXIN SHOT only apply to a Kroot rifle, Kroot scattergun or dual Kroot pistols (focused)', () => {
    expect(ammoWeapon('Kroot rifle', undefined)).toBe(true);
    expect(ammoWeapon('Kroot scattergun', undefined)).toBe(true);
    expect(ammoWeapon('Dual Kroot pistols', 'focused')).toBe(true);
    expect(ammoWeapon('Dual Kroot pistols', 'salvo')).toBe(false);
    expect(ammoWeapon('Kroot hunting rifle', 'stationary')).toBe(false);
    expect(ruleText(EQ.piercingShot)).toContain('a Kroot rifle, Kroot scattergun or dual Kroot pistols (focused)');
  });

  it('TOXIN SHOT is loaded on the first qualifying Shoot action and grants Lethal 5+ and Stun', () => {
    const { ctx, state } = setup({ equipment: [EQ.piercingShot, EQ.toxinShot] });
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 16, 10);
    const profile = profileOf(C.warrior, 'Kroot rifle');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(op, foe, profile, 'Kroot rifle'),
      allowed: true,
      dryRun: false,
    });
    const eff = state.effects.find((e) => e.rule === E.ammo && e.operativeId === op.id);
    expect(eff?.data?.['equipmentId']).toBe(EQ.toxinShot);
    const rules = rulesFor(ctx, state, op, foe, C.warrior, 'Kroot rifle');
    expect(rules).toContain('Lethal');
    expect(rules).toContain('Stun');
    expect(rules).not.toContain('Piercing');
    expect(ruleText(EQ.toxinShot)).toContain('that weapon has the Lethal 5+ and Stun weapon rules');
  });

  it('a dry-run onSelectWeapon never changes state (D-032)', () => {
    const { ctx, state } = setup({ equipment: [EQ.toxinShot] });
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(op, foe, profileOf(C.warrior, 'Kroot rifle'), 'Kroot rifle'),
      allowed: true,
      dryRun: true,
    });
    expect(state.effects.some((e) => e.rule === E.ammo)).toBe(false);
  });

  it('the two ammunition rules are never used in the same action, and each is once per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.piercingShot, EQ.toxinShot] });
    const one = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const two = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const fire = (op: OperativeState): void => {
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, profileOf(C.warrior, 'Kroot rifle'), 'Kroot rifle'),
        allowed: true,
        dryRun: false,
      });
    };
    fire(one);
    expect(state.effects.find((e) => e.rule === E.ammo && e.operativeId === one.id)?.data?.['equipmentId']).toBe(
      EQ.toxinShot,
    );
    fire(two);
    expect(state.effects.find((e) => e.rule === E.ammo && e.operativeId === two.id)?.data?.['equipmentId']).toBe(
      EQ.piercingShot,
    );
    const three = state.operatives[opWith(state, 'p1', C.tracker)]!;
    fire(three);
    expect(state.effects.some((e) => e.rule === E.ammo && e.operativeId === three.id)).toBe(false);
    expect(ruleText(EQ.piercingShot)).toContain('You cannot use the Piercing Shot and Toxin Shot rule during the same action');
  });

  it('PIERCING SHOT is preferred when the profile already has Lethal 5+ (dual Kroot pistols, focused)', () => {
    const { ctx, state } = setup({ equipment: [EQ.piercingShot, EQ.toxinShot] });
    const op = state.operatives[opWith(state, 'p1', C.pistolier)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(op, foe, profileOf(C.pistolier, 'Dual Kroot pistols', 'focused'), 'Dual Kroot pistols'),
      allowed: true,
      dryRun: false,
    });
    expect(state.effects.find((e) => e.rule === E.ammo && e.operativeId === op.id)?.data?.['equipmentId']).toBe(
      EQ.piercingShot,
    );
  });

  it('MEAT — "that friendly operative regains up to D3+1 lost wounds", once per turning point, excluding HOUND', () => {
    const { ctx, state } = setup({ equipment: [EQ.meat], script: [5, 5, 5, 5] }); // d3 = ceil(5/2) = 3
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const hound = state.operatives[opWith(state, 'p1', C.hound)]!;
    isolate(state, [op.id, hound.id]);
    place(state, op.id, 10, 10);
    place(state, hound.id, 13, 10);
    hound.wounds = 2;
    op.wounds = 2;
    let s = activate(ctx, state, hound.id);
    expect(s.operatives[hound.id]!.wounds).toBe(2); // "(excluding HOUND)"
    s = reduce(s, { t: 'EndActivation', operativeId: hound.id }, ctx).state;
    s = activate(ctx, s, op.id);
    expect(s.operatives[op.id]!.wounds).toBe(2 + 3 + 1);
    expect(ruleText(EQ.meat)).toContain('regains up to D3+1 lost wounds');
  });

  it('MEAT is not used while within control range of an enemy operative', () => {
    const { ctx, state } = setup({ equipment: [EQ.meat], script: [5, 5, 5, 5] });
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 10.5, 10);
    op.wounds = 3;
    const s = activate(ctx, state, op.id);
    expect(s.operatives[op.id]!.wounds).toBe(3);
    expect(ruleText(EQ.meat)).toContain('if it’s not within control range of enemy operatives');
  });

  it('TROPHY — "add 1 to that friendly operative’s APL stat until the end of its activation", once per battle', () => {
    const { ctx, state } = setup({ equipment: [EQ.trophy] });
    const op = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const mate = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    isolate(state, [op.id, mate.id]);
    place(state, op.id, 10, 10);
    place(state, mate.id, 14, 10);
    let s = activate(ctx, state, op.id);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(3);
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2); // "until the end of its activation"
    s = activate(ctx, s, mate.id);
    expect(aplOf(ctx, s, s.operatives[mate.id]!)).toBe(2); // "Once per battle"
    expect(ruleText(EQ.trophy)).toContain('add 1 to that friendly operative’s APL stat until the end of its activation');
  });

  it('Ready for Anything — "Doing so doesn’t count for its once per turning point limit"', () => {
    const { ctx, state } = setup({ equipment: [EQ.toxinShot] });
    const first = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    const warrior = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const fire = (op: OperativeState): void => {
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, profileOf(C.warrior, 'Kroot rifle'), 'Kroot rifle'),
        allowed: true,
        dryRun: false,
      });
    };
    fire(first); // spends the equipment's own once-per-turning-point use
    expect(state.effects.some((e) => e.rule === E.ammo && e.operativeId === first.id)).toBe(true);
    state.activeOperativeId = warrior.id; // "during a friendly WARRIOR operative's activation"
    fire(warrior);
    expect(state.effects.some((e) => e.rule === E.ammo && e.operativeId === warrior.id)).toBe(true);
    expect(abilityText(C.warrior, AB.readyForAnything)).toContain('doesn’t count for its once per turning point limit');
  });
});

// ---------------------------------------------------------------------------
describe('KILL-BROKER — Call The Kill and Victory Shriek', () => {
  it('Call The Kill is a 0CP STRATEGIC GAMBIT that marks one enemy operative for the turning point', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(AB.callTheKill);
    const foe = state.operatives[opWith(state, 'p2', C.stalker)]!;
    const cp = state.teams.p1.cp;
    const r = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: AB.callTheKill, data: { operativeId: foe.id } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.state.teams.p1.cp).toBe(cp); // a datacard gambit, not a ploy — no CP
    expect(markOf(r.state, 'p1')).toBe(foe.id);
    expect(abilityText(C.killBroker, AB.callTheKill)).toContain('STRATEGIC GAMBIT if this operative is in the killzone');
  });

  it('Call The Kill grants Balanced when shooting, fighting or retaliating against your mark', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const mark = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const other = state.operatives[opWith(state, 'p2', C.tracker)]!;
    setMarkFor(state, 'p1', mark.id);
    expect(rulesFor(ctx, state, shooter, mark, C.warrior, 'Kroot rifle')).toContain('Balanced');
    expect(rulesFor(ctx, state, shooter, mark, C.warrior, 'Blade')).toContain('Balanced');
    expect(rulesFor(ctx, state, shooter, other, C.warrior, 'Kroot rifle')).not.toContain('Balanced');
  });

  it('when the mark is incapacitated a new mark is selected, and Victory Shriek fires first', () => {
    const { ctx, state } = setup();
    const broker = state.operatives[opWith(state, 'p1', C.killBroker)]!;
    const mate = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const mark = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [broker.id, mate.id, mark.id]);
    place(state, broker.id, 10, 10);
    place(state, mate.id, 12, 10);
    place(state, mark.id, 20, 10);
    setMarkFor(state, 'p1', mark.id);
    inflictDamage(ctx, state, mark, 99, 'attack');
    // Victory Shriek picked a friendly within 6" of the KILL-BROKER…
    const shrieked = state.effects.filter((e) => e.rule === E.victoryShriek && e.player === 'p1');
    expect(shrieked).toHaveLength(1);
    expect(shrieked[0]!.operativeId).toBe(broker.id < mate.id ? broker.id : mate.id);
    // …and Call The Kill re-marked a different enemy operative.
    expect(markOf(state, 'p1')).not.toBe(mark.id);
    expect(markOf(state, 'p1')).toBeTruthy();
    expect(abilityText(C.killBroker, AB.callTheKill)).toContain('you can select a new enemy operative to be your mark');
  });

  it('Victory Shriek — "Each friendly operative can only be selected for this rule once per battle"', () => {
    const { ctx, state } = setup();
    const broker = state.operatives[opWith(state, 'p1', C.killBroker)]!;
    const mate = state.operatives[opWith(state, 'p1', C.warrior)]!;
    isolate(state, [broker.id, mate.id]);
    place(state, broker.id, 10, 10);
    place(state, mate.id, 12, 10);
    const foes = aliveOperatives(state, 'p2');
    for (let i = 0; i < 3; i++) {
      const victim = foes[i]!;
      place(state, victim.id, 25, 3 + i);
      setMarkFor(state, 'p1', victim.id);
      inflictDamage(ctx, state, victim, 99, 'attack');
    }
    const chosen = state.effects.filter((e) => e.rule === E.victoryShriek && e.player === 'p1');
    expect(chosen).toHaveLength(2); // only the two friendlies within 6"
    expect(new Set(chosen.map((e) => e.operativeId)).size).toBe(2);
    // "Until the end of the battle, that operative's weapons have the Balanced weapon rule."
    const target = state.operatives[opWith(state, 'p2', C.stalker)]!;
    expect(rulesFor(ctx, state, mate, target, C.warrior, 'Kroot rifle')).toContain('Balanced');
    expect(abilityText(C.killBroker, AB.victoryShriek)).toContain('once per battle');
  });
});

// ---------------------------------------------------------------------------
describe('COLD-BLOOD — Hardy and Cold-blooded', () => {
  it('Hardy — "you can choose for that attack dice to inflict Normal Dmg instead" (a fight)', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    const striker = state.operatives[opWith(state, 'p2', C.killBroker)]!;
    isolate(state, [victim.id, striker.id]);
    place(state, victim.id, 10, 10);
    place(state, striker.id, 10.6, 10);
    expect(startFight(ctx, state, striker, 'Ritual blade', undefined, victim.id).ok).toBe(true);
    const before = victim.wounds;
    // The ritual blade's Critical Dmg is 5 and its Normal Dmg 4.
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(before - state.operatives[victim.id]!.wounds).toBe(4);
    expect(abilityText(C.coldBlood, AB.hardy)).toContain('to inflict Normal Dmg instead');
  });

  it('Hardy applies per retained critical success in a shoot', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.killBroker)]!;
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: victim.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Kroot rifle',
      step: 'resolve',
      attack: pool([6, 6, 4, 2], 3), // two crits + one normal
    });
    const before = victim.wounds;
    // Kroot rifle: Normal 3 / Critical 4 → 2×4 + 1×3 = 11, Hardy makes it 3×3 = 9.
    inflictDamage(ctx, state, victim, 11, 'attack');
    expect(before - state.operatives[victim.id]!.wounds).toBe(9);
  });

  it('Cold-blooded — Lethal 5+ against a wounded enemy, plus Rending when it is also injured', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    expect(rulesFor(ctx, state, op, foe, C.coldBlood, 'Kroot rifle')).toEqual([]);
    foe.wounds = 7; // wounded (8 starting), not injured
    expect(rulesFor(ctx, state, op, foe, C.coldBlood, 'Kroot rifle')).toEqual(['Lethal']);
    foe.wounds = 3; // injured (< half of 8)
    expect(rulesFor(ctx, state, op, foe, C.coldBlood, 'Kroot rifle')).toEqual(['Lethal', 'Rending']);
    // "…shooting against, fighting against or retaliating against" — melee too.
    expect(rulesFor(ctx, state, op, foe, C.coldBlood, 'Blade')).toEqual(['Lethal', 'Rending']);
    expect(abilityText(C.coldBlood, AB.coldBlooded)).toContain('this operative’s weapons have the Lethal 5+ weapon rule');
  });
});

// ---------------------------------------------------------------------------
describe('CUT-SKIN — Vicious Duellist and Savage Assault', () => {
  it('Vicious Duellist — "for each attack dice your opponent discards as a fail, inflict 1 damage"', () => {
    const { ctx, state } = setup();
    const cutSkin = state.operatives[opWith(state, 'p1', C.cutSkin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [cutSkin.id, foe.id]);
    place(state, cutSkin.id, 10, 10);
    place(state, foe.id, 10.6, 10);
    const before = foe.wounds;
    const seq: FightSequence = {
      kind: 'fight',
      step: 'retention',
      attackerId: cutSkin.id,
      defenderId: foe.id,
      attackerWeapon: "Cut-skin's blades",
      defenderWeapon: 'Blade',
      defenderCanRetaliate: true,
      attackerPool: pool([6, 5, 4, 2], 3),
      defenderPool: pool([1, 2, 5, 6], 3), // two fails
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
      attackerAssists: 0,
      defenderAssists: 0,
      attacker: 'p1',
      defender: 'p2',
      free: false,
      hatchway: false,
    };
    state.sequence = seq;
    effectiveRules(ctx, state, profileOf(C.cutSkin, "Cut-skin's blades"), {
      operative: cutSkin,
      target: foe,
      weaponName: "Cut-skin's blades",
    });
    expect(before - state.operatives[foe.id]!.wounds).toBe(2);
    // It fires once per sequence, not once per read.
    effectiveRules(ctx, state, profileOf(C.cutSkin, "Cut-skin's blades"), {
      operative: cutSkin,
      target: foe,
      weaponName: "Cut-skin's blades",
    });
    expect(before - state.operatives[foe.id]!.wounds).toBe(2);
    expect(abilityText(C.cutSkin, AB.viciousDuellist)).toContain('inflict 1 damage on the enemy operative');
  });

  it('Savage Assault — an extra AP restricted to Fight (Savage Assault), locked to the same enemy', () => {
    const { ctx, state } = setup();
    const cutSkin = state.operatives[opWith(state, 'p1', C.cutSkin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const other = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [cutSkin.id, foe.id, other.id]);
    place(state, cutSkin.id, 10, 10);
    place(state, foe.id, 10.6, 10);
    place(state, other.id, 10, 10.6);
    let s = activate(ctx, state, cutSkin.id);
    // "…can immediately perform a free FIGHT action afterwards" — D-100: free AP, not an APL
    // stat change, so the APL stat is untouched and the activation has one more AP to spend.
    expect(aplOf(ctx, s, s.operatives[cutSkin.id]!)).toBe(2);
    expect(apBudgetOf(ctx, s, s.operatives[cutSkin.id]!)).toBe(3);
    // The free FIGHT is illegal until the first Fight has happened.
    expect(getAction(SAVAGE_FIGHT)!.check(ctx, s, s.operatives[cutSkin.id]!, {}).ok).toBe(false);
    const first = act(ctx, s, cutSkin.id, 'Fight', { meleeWeaponName: "Cut-skin's blades", targetId: foe.id });
    expect(first.ok).toBe(true);
    s = settle(ctx, first.state);
    if (!s.operatives[foe.id]!.incapacitated) {
      const def = getAction(SAVAGE_FIGHT)!;
      expect(def.check(ctx, s, s.operatives[cutSkin.id]!, { targetId: other.id })).toMatchObject({ ok: false });
      expect(def.check(ctx, s, s.operatives[cutSkin.id]!, { targetId: foe.id }).ok).toBe(true);
      // And the AP really is extra: with both of its own AP spent the reducer's AP gate still
      // lets the free FIGHT through, because it checks `apBudgetOf`, not the APL stat.
      s.operatives[cutSkin.id]!.apSpent = 2;
      const free = act(ctx, s, cutSkin.id, SAVAGE_FIGHT, { meleeWeaponName: "Cut-skin's blades", targetId: foe.id });
      expect(free.ok).toBe(true);
      expect(free.state.operatives[cutSkin.id]!.apSpent).toBe(3);
    }
    expect(abilityText(C.cutSkin, AB.savageAssault)).toContain('This takes precedence over action restrictions');
  });

  it('Savage Assault’s free AP expires with the activation and never touches the APL stat', () => {
    const { ctx, state } = setup();
    const cutSkin = state.operatives[opWith(state, 'p1', C.cutSkin)]!;
    isolate(state, [cutSkin.id]);
    place(state, cutSkin.id, 10, 10);
    let s = activate(ctx, state, cutSkin.id);
    // "…can immediately perform a free FIGHT action afterwards" grants AP, not APL: the stat
    // marker control totals is untouched, and no modifier is left on the operative to leak.
    expect(s.operatives[cutSkin.id]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s, s.operatives[cutSkin.id]!)).toBe(2);
    expect(freeApOf(s, s.operatives[cutSkin.id]!)).toBe(1);
    expect(apBudgetOf(ctx, s, s.operatives[cutSkin.id]!)).toBe(3);
    // The grant lasts "during each of its activations", so it goes when the activation does.
    s = reduce(s, { t: 'EndActivation', operativeId: cutSkin.id }, ctx).state;
    expect(freeApOf(s, s.operatives[cutSkin.id]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[cutSkin.id]!)).toBe(2);
    expect(abilityText(C.cutSkin, AB.savageAssault)).toContain('immediately perform a free FIGHT action');
  });
});

// ---------------------------------------------------------------------------
describe('HOUND — Beast and Bad-tempered', () => {
  it('Beast — "cannot perform any actions other than Charge, Dash, Fall Back, Fight, Gather, Guard, Reposition, Pick Up Marker and Place Marker"', () => {
    const { ctx, state } = setup();
    const hound = state.operatives[opWith(state, 'p1', C.hound)]!;
    isolate(state, [hound.id]);
    place(state, hound.id, 10, 10);
    const s = activate(ctx, state, hound.id);
    const offered = availableActions(ctx, s, s.operatives[hound.id]!);
    const allowedIds = offered.filter((a) => a.ok || !a.reason?.includes('Beast')).map((a) => a.def.id);
    expect(allowedIds).not.toContain('Shoot');
    expect(offered.find((a) => a.def.id === 'Shoot')!.reason).toContain('Beast');
    expect(allowedIds).toContain('Reposition');
    expect(allowedIds).toContain(ACT.gather);
    expect(abilityText(C.hound, AB.beast)).toContain('Charge, Dash, Fall Back, Fight, Gather, Guard, Reposition');
  });

  it('Beast — "It cannot use any weapons that aren’t on its datacard"', () => {
    const { ctx, state } = setup();
    const hound = state.operatives[opWith(state, 'p1', C.hound)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const grafted: WeaponProfile = { type: 'ranged', atk: 4, hit: 3, dmgN: 3, dmgC: 4, rules: [] };
    const ev = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(hound, foe, grafted, 'Frag grenade'),
      allowed: true,
      dryRun: true,
    });
    expect(ev.allowed).toBe(false);
    const own = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(hound, foe, profileOf(C.hound, 'Ripping fangs'), 'Ripping fangs', 'melee'),
      allowed: true,
      dryRun: true,
    });
    expect(own.allowed).toBe(true);
    // `availableWeapons` cannot reach a granted weapon, and a fight picks its melee weapon with
    // no hook at all — the ban is ranged-only, which is recorded rather than pretended.
    expect(REMINDER_ONLY[`${AB.beast}.melee`]).toContain('ranged weapons only');
  });

  it('Bad-tempered — the free Charge is granted when an enemy ends a Charge next to a nearby kinsman', () => {
    const { ctx, state } = setup();
    const hound = state.operatives[opWith(state, 'p1', C.hound)]!;
    const mate = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const enemy = state.operatives[opWith(state, 'p2', C.stalker)]!;
    isolate(state, [hound.id, mate.id, enemy.id]);
    place(state, hound.id, 10, 10);
    place(state, mate.id, 12, 10);
    place(state, enemy.id, 12.6, 10);
    hound.order = 'conceal';
    let s = activate(ctx, state, enemy.id);
    s.operatives[enemy.id]!.actionsThisActivation.push('Charge');
    s = reduce(s, { t: 'EndActivation', operativeId: enemy.id }, ctx).state;
    const after = s.operatives[hound.id]!;
    expect(after.order).toBe('engage'); // "(you can change its order to Engage to do so)"
    // The free Charge is an extra AP on the HOUND's own next activation, never an APL change.
    expect(aplOf(ctx, s, after)).toBe(2);
    expect(apBudgetOf(ctx, s, after)).toBe(3);
    expect(abilityText(C.hound, AB.badTempered)).toContain('this operative can immediately perform a free Charge action');
  });

  it('Bad-tempered’s taunt half and the free Charge’s end-of-move clause are reminder-only', () => {
    expect(abilityText(C.hound, AB.badTempered)).toContain('you can force them to select this operative to fight against instead');
    expect(REMINDER_ONLY[`${AB.badTempered}.taunt`]).toContain('no target-substitution seam for fights');
    expect(REMINDER_ONLY[`${AB.badTempered}.charge`]).toContain('where a move ENDS');
  });
});

// ---------------------------------------------------------------------------
describe('LONG-SIGHT — Concealed Position (rare weapon rule)', () => {
  it('the concealed profile is refused once the operative has shot, and the others are not', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', C.longSight)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const concealed = profileOf(C.longSight, 'Kroot hunting rifle', 'concealed');
    const stationary = profileOf(C.longSight, 'Kroot hunting rifle', 'stationary');
    const ask = (p: WeaponProfile, dryRun: boolean) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(sniper, foe, p, 'Kroot hunting rifle'),
        allowed: true,
        dryRun,
      });
    expect(ask(concealed, true).allowed).toBe(true);
    // The shot itself is recorded when the attack dice are collected.
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(sniper, foe, concealed, 'Kroot hunting rifle'),
      count: concealed.atk,
      mods: zeroStatMods(),
    });
    expect(ask(concealed, true).allowed).toBe(false);
    expect(ask(concealed, false).reason).toContain('Concealed Position');
    expect(ask(stationary, true).allowed).toBe(true); // a PROFILE-level restriction, not a weapon one
    expect(abilityText(C.longSight, AB.concealedPosition)).toContain(
      'only use this weapon the first time it’s performing the Shoot action during the battle',
    );
  });
});

// ---------------------------------------------------------------------------
describe('PISTOLIER — Quick Draw and Salvo', () => {
  it('Quick Draw arms a free Shoot (Quick Draw) locked to the enemy that selected it as a target', () => {
    const { ctx, state } = setup();
    const pistolier = state.operatives[opWith(state, 'p1', C.pistolier)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const other = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [pistolier.id, shooter.id, other.id]);
    place(state, pistolier.id, 10, 10);
    place(state, shooter.id, 14, 10);
    place(state, other.id, 16, 10);
    ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: shooter,
      target: pistolier,
      weaponName: 'Kroot rifle',
      profile: profileOf(C.warrior, 'Kroot rifle'),
      rules: [],
    });
    const eff = state.effects.find((e) => e.rule === E.quickDraw && e.operativeId === pistolier.id);
    expect(eff?.data?.['enemyId']).toBe(shooter.id);
    const def = getAction(QUICK_DRAW_SHOOT)!;
    expect(def.check(ctx, state, pistolier, { targetId: other.id }).ok).toBe(false);
    // Once per turning point.
    ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: other,
      target: pistolier,
      weaponName: 'Kroot rifle',
      profile: profileOf(C.tracker, 'Kroot rifle'),
      rules: [],
    });
    expect(
      state.effects.filter((e) => e.rule === E.quickDraw && e.operativeId === pistolier.id),
    ).toHaveLength(1);
    expect(abilityText(C.pistolier, AB.quickDraw)).toContain('Once per turning point');
  });

  it('Quick Draw does nothing for an expended PISTOLIER ("if this operative is ready")', () => {
    const { ctx, state } = setup();
    const pistolier = state.operatives[opWith(state, 'p1', C.pistolier)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.warrior)]!;
    pistolier.ready = false;
    ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: shooter,
      target: pistolier,
      weaponName: 'Kroot rifle',
      profile: profileOf(C.warrior, 'Kroot rifle'),
      rules: [],
    });
    expect(state.effects.some((e) => e.rule === E.quickDraw)).toBe(false);
  });

  it('Salvo — a second free Shoot action that must select a DIFFERENT valid target', () => {
    const { ctx, state } = setup();
    const pistolier = state.operatives[opWith(state, 'p1', C.pistolier)]!;
    const a = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const b = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [pistolier.id, a.id, b.id]);
    place(state, pistolier.id, 10, 10);
    place(state, a.id, 14, 10);
    place(state, b.id, 14, 14);
    const s = activate(ctx, state, pistolier.id);
    const salvo = profileOf(C.pistolier, 'Dual Kroot pistols', 'salvo');
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: { ...attackCtx(s.operatives[pistolier.id]!, a, salvo, 'Dual Kroot pistols'), defender: a },
      count: salvo.atk,
      mods: zeroStatMods(),
    });
    const eff = s.effects.find((e) => e.rule === E.salvo && e.operativeId === pistolier.id);
    expect(eff?.data?.['firstTargetId']).toBe(a.id);
    // "Shoot with this weapon against both of them" — the second shot rides free AP, so it is
    // still there when the PISTOLIER has spent all of its own.
    expect(aplOf(ctx, s, s.operatives[pistolier.id]!)).toBe(2);
    expect(apBudgetOf(ctx, s, s.operatives[pistolier.id]!)).toBe(3);
    const def = getAction(SALVO_SHOOT)!;
    expect(def.check(ctx, s, s.operatives[pistolier.id]!, { targetId: a.id })).toMatchObject({
      ok: false,
      reason: 'Salvo: select two DIFFERENT valid targets',
    });
    expect(def.check(ctx, s, s.operatives[pistolier.id]!, { targetId: b.id }).ok).toBe(true);
    expect(abilityText(C.pistolier, AB.salvo)).toContain('Select up to two different valid targets');
  });
});

// ---------------------------------------------------------------------------
describe('STALKER — Stalker and STEALTH ATTACK', () => {
  it('Stalker — "This operative can perform the Charge action while it has a Conceal order"', () => {
    const { ctx, state } = setup();
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [stalker.id, foe.id]);
    place(state, stalker.id, 10, 10);
    place(state, foe.id, 13, 10);
    stalker.order = 'conceal';
    const path = { points: [{ x: 12.4, y: 10 }] };
    expect(getAction('Charge')!.check(ctx, state, stalker, { path })).toMatchObject({
      ok: false,
      reason: 'cannot Charge with a Conceal order',
    });
    expect(getAction(STALKER_CHARGE)!.check(ctx, state, stalker, { path }).ok).toBe(true);
    expect(getAction(STALKER_CHARGE)!.treatedAs).toBe('Charge');
    expect(getAction(STALKER_CHARGE)!.available!(ctx, state, foe)).toBe(false);
    expect(abilityText(C.stalker, AB.stalker)).toContain('can perform the Charge action while it has a Conceal order');
  });

  it('STEALTH ATTACK refuses an Engage order and a spot away from Light or Heavy terrain', () => {
    const { ctx, state } = setup({ heavy: true });
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [stalker.id, foe.id]);
    place(state, stalker.id, 22, 4); // away from the Heavy block
    place(state, foe.id, 26, 4);
    const def = getAction(ACT.stealthAttack)!;
    expect(def.ap).toBe(2);
    stalker.order = 'engage';
    expect(def.check(ctx, state, stalker, {})).toMatchObject({ ok: false, reason: expect.stringContaining('Engage order') });
    stalker.order = 'conceal';
    expect(def.check(ctx, state, stalker, {})).toMatchObject({
      ok: false,
      reason: 'it is not within 1" of Light or Heavy terrain',
    });
    // …and while within control range of an enemy operative.
    place(state, stalker.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y);
    place(state, foe.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y + 1.05);
    expect(def.check(ctx, state, stalker, {})).toMatchObject({
      ok: false,
      reason: 'within control range of an enemy operative',
    });
    expect(actionOf(C.stalker, ACT.stealthAttack).text).toContain('if it isn’t within 1" of Light or Heavy terrain');
  });

  it('STEALTH ATTACK charges and immediately fights, resolving a second success as a strike', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1] });
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [stalker.id, foe.id]);
    state.map = HEAVY_MAP();
    place(state, stalker.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y);
    place(state, foe.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y + 4);
    stalker.order = 'conceal';
    const s = activate(ctx, state, stalker.id, 'conceal');
    const before = s.operatives[foe.id]!.wounds;
    const r = act(ctx, s, stalker.id, ACT.stealthAttack, {
      path: { points: [{ x: BESIDE_HEAVY.x, y: BESIDE_HEAVY.y + 3.1 }] },
      meleeWeaponName: "Stalker's blade",
      targetId: foe.id,
    });
    expect(r.ok).toBe(true);
    expect(r.state.operatives[stalker.id]!.pos.y).toBeCloseTo(BESIDE_HEAVY.y + 3.1, 5);
    const done = settle(ctx, r.state);
    // Two critical successes resolved back to back before the defender: 5 + 5 damage.
    expect(done.log.some((l) => l.text.includes('immediately strikes again'))).toBe(true);
    expect(before - done.operatives[foe.id]!.wounds).toBeGreaterThanOrEqual(10);
    expect(done.rejected).toEqual([]);
    expect(actionOf(C.stalker, ACT.stealthAttack).text).toContain('you can immediately resolve another of your successes as a strike');
    expect(REMINDER_ONLY[`${ACT.stealthAttack}.block`]).toContain('strike/block options');
  });

  it('STEALTH ATTACK’s move does not gain the Charge action’s extra 2"', () => {
    const { ctx, state } = setup({ heavy: true });
    const stalker = state.operatives[opWith(state, 'p1', C.stalker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [stalker.id, foe.id]);
    place(state, stalker.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y);
    place(state, foe.id, BESIDE_HEAVY.x, BESIDE_HEAVY.y + 7.5);
    stalker.order = 'conceal';
    const def = getAction(ACT.stealthAttack)!;
    // Move 6": a 7" charge is legal for the STALKER's own Conceal-order Charge (6+2) but not here.
    const long = { path: { points: [{ x: BESIDE_HEAVY.x, y: BESIDE_HEAVY.y + 6.6 }] } };
    expect(getAction(STALKER_CHARGE)!.check(ctx, state, stalker, long).ok).toBe(true);
    expect(def.check(ctx, state, stalker, long).ok).toBe(false);
    expect(actionOf(C.stalker, ACT.stealthAttack).text).toContain('don’t exceed its Move stat');
  });
});

// ---------------------------------------------------------------------------
describe('Unique actions — BOW-HUNTER, HOUND and TRACKER', () => {
  it('ENERGISE — "all profiles of its accelerator bow have the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup();
    const bow = state.operatives[opWith(state, 'p1', C.bowHunter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [bow.id, foe.id]);
    place(state, bow.id, 10, 10);
    place(state, foe.id, 16, 10);
    const s = activate(ctx, state, bow.id);
    const r = act(ctx, s, bow.id, ACT.energise, {});
    expect(r.ok).toBe(true);
    for (const p of ['fused arrow', 'glide arrow', 'voltaic arrow']) {
      expect(rulesFor(ctx, r.state, r.state.operatives[bow.id]!, foe, C.bowHunter, 'Accelerator bow', p)).toContain('Lethal');
    }
    expect(actionOf(C.bowHunter, ACT.energise).text).toContain('all profiles of its accelerator bow have the Lethal 5+');
  });

  it('ENERGISE ends once the operative has shot with its accelerator bow', () => {
    const { ctx, state } = setup();
    const bow = state.operatives[opWith(state, 'p1', C.bowHunter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [bow.id, foe.id]);
    place(state, bow.id, 10, 10);
    place(state, foe.id, 16, 10);
    let s = activate(ctx, state, bow.id);
    s = act(ctx, s, bow.id, ACT.energise, {}).state;
    const profile = profileOf(C.bowHunter, 'Accelerator bow', 'fused arrow');
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[bow.id]!, foe, profile, 'Accelerator bow'),
      count: profile.atk,
      mods: zeroStatMods(),
    });
    s = reduce(s, { t: 'EndActivation', operativeId: bow.id }, ctx).state;
    expect(rulesFor(ctx, s, s.operatives[bow.id]!, foe, C.bowHunter, 'Accelerator bow', 'fused arrow')).not.toContain('Lethal');
  });

  it('ENERGISE cannot be performed while within control range of an enemy operative', () => {
    const { ctx, state } = setup();
    const bow = state.operatives[opWith(state, 'p1', C.bowHunter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [bow.id, foe.id]);
    place(state, bow.id, 10, 10);
    place(state, foe.id, 10.5, 10);
    expect(getAction(ACT.energise)!.check(ctx, state, bow, {}).ok).toBe(false);
    expect(actionOf(C.bowHunter, ACT.energise).text).toContain('cannot perform this action while within control range');
  });

  it('GATHER — a free Dash or Reposition plus a free Pick Up / Place Marker action', () => {
    const { ctx, state } = setup();
    const hound = state.operatives[opWith(state, 'p1', C.hound)]!;
    isolate(state, [hound.id]);
    place(state, hound.id, 10, 10);
    let s = activate(ctx, state, hound.id);
    const r = act(ctx, s, hound.id, ACT.gather, { path: { points: [{ x: 13, y: 10 }] } });
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.operatives[hound.id]!.pos.x).toBeCloseTo(13, 5);
    // The free move still counts as that action for action restrictions.
    expect(s.operatives[hound.id]!.actionsThisActivation).toContain('Reposition');
    // "it can perform a free Pick Up Marker or Place Marker action" — free AP on top of the
    // HOUND's own two, not an APL stat change.
    expect(aplOf(ctx, s, s.operatives[hound.id]!)).toBe(2);
    expect(apBudgetOf(ctx, s, s.operatives[hound.id]!)).toBe(3);
    expect(
      getAction('Charge')!.check(ctx, s, s.operatives[hound.id]!, { path: { points: [{ x: 15, y: 10 }] } }),
    ).toMatchObject({ ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' });
    expect(actionOf(C.hound, ACT.gather).text).toContain('Perform a free Dash or Reposition action');
    expect(REMINDER_ONLY[`${ACT.gather}.remainder`]).toContain('atomic');
  });

  it('LONG-SIGHT — the printed restriction is enforced but its truncated benefit is reminder-only', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', C.longSight)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [sniper.id, foe.id]);
    place(state, sniper.id, 10, 10);
    place(state, foe.id, 10.5, 10);
    expect(getAction(ACT.longSight)!.check(ctx, state, sniper, {}).ok).toBe(false);
    place(state, foe.id, 18, 10);
    let s = activate(ctx, state, sniper.id);
    s = act(ctx, s, sniper.id, ACT.longSight, {}).state;
    expect(s.effects.some((e) => e.rule === E.longSight && e.operativeId === sniper.id)).toBe(true);
    expect(REMINDER_ONLY[ACT.longSight]).toContain('truncated');
  });

  it('MARKED FOR THE HUNT — places the Pech’ra marker and grants Seek Light against operatives contesting it', () => {
    const { ctx, state } = setup();
    const tracker = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const shooter = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const other = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [tracker.id, shooter.id, foe.id, other.id]);
    place(state, tracker.id, 10, 10);
    place(state, shooter.id, 11, 12);
    place(state, foe.id, 16, 10);
    place(state, other.id, 20, 4);
    let s = activate(ctx, state, tracker.id);
    const r = act(ctx, s, tracker.id, ACT.markedForTheHunt, { targetPos: { x: foe.pos.x, y: foe.pos.y } });
    expect(r.ok).toBe(true);
    s = r.state;
    const marker = pechraMarker(s, 'p1')!;
    expect(marker.id).toBe(PECHRA_MARKER('p1'));
    expect(markerContestedBy(ctx, s, marker, s.operatives[foe.id]!)).toBe(true);
    expect(rulesFor(ctx, s, s.operatives[shooter.id]!, s.operatives[foe.id]!, C.warrior, 'Kroot rifle')).toContain('SeekLight');
    expect(rulesFor(ctx, s, s.operatives[shooter.id]!, s.operatives[other.id]!, C.warrior, 'Kroot rifle')).not.toContain('SeekLight');
    // Melee weapons are untouched ("that friendly operative's RANGED weapons").
    expect(rulesFor(ctx, s, s.operatives[shooter.id]!, s.operatives[foe.id]!, C.warrior, 'Blade')).not.toContain('SeekLight');
    expect(actionOf(C.tracker, ACT.markedForTheHunt).text).toContain('have the Seek Light weapon rule');
  });

  it('the Pech’ra marker is removed at the start of the TRACKER’s next activation', () => {
    const { ctx, state } = setup();
    const tracker = state.operatives[opWith(state, 'p1', C.tracker)]!;
    isolate(state, [tracker.id]);
    place(state, tracker.id, 10, 10);
    let s = activate(ctx, state, tracker.id);
    s = act(ctx, s, tracker.id, ACT.markedForTheHunt, { targetPos: { x: 10.5, y: 10.5 } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: tracker.id }, ctx).state;
    expect(pechraMarker(s, 'p1')).toBeTruthy(); // not at the END of the activation it was placed in
    s.operatives[tracker.id]!.ready = true;
    s.operatives[tracker.id]!.expended = false;
    s.activePlayer = 'p1';
    s = activate(ctx, s, tracker.id);
    expect(pechraMarker(s, 'p1')).toBeUndefined();
    expect(actionOf(C.tracker, ACT.markedForTheHunt).text).toContain('At the start of this operative’s next activation');
  });

  it('FROM THE EYE ABOVE — SUPPORT, +1 APL until the end of that operative’s next activation', () => {
    const { ctx, state } = setup();
    const tracker = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const mate = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const far = state.operatives[opWith(state, 'p1', C.coldBlood)]!;
    isolate(state, [tracker.id, mate.id, far.id]);
    place(state, tracker.id, 10, 10);
    place(state, mate.id, 13, 10);
    place(state, far.id, 22, 10);
    const def = getAction(ACT.fromTheEyeAbove)!;
    expect(def.check(ctx, state, tracker, { targetOperativeId: far.id }).ok).toBe(false);
    expect(def.check(ctx, state, tracker, { targetOperativeId: tracker.id }).ok).toBe(false); // "one OTHER"
    let s = activate(ctx, state, tracker.id);
    s = act(ctx, s, tracker.id, ACT.fromTheEyeAbove, { targetOperativeId: mate.id }).state;
    expect(aplOf(ctx, s, s.operatives[mate.id]!)).toBe(3);
    expect(actionOf(C.tracker, ACT.fromTheEyeAbove).text).toContain('add 1 to its APL stat');
  });
});

// ---------------------------------------------------------------------------
describe('End to end through the reducer (no rejected intents)', () => {
  it('a real Shoot action loads TOXIN SHOT at the Select Weapon step and resolves', () => {
    const { ctx, state } = setup({ equipment: [EQ.toxinShot] });
    const shooter = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 10, 10);
    place(state, foe.id, 16, 10);
    let s = activate(ctx, state, shooter.id);
    const r = act(ctx, s, shooter.id, 'Shoot', { weaponName: 'Kroot rifle', targetId: foe.id });
    expect(r.ok).toBe(true);
    s = settle(ctx, r.state);
    expect(s.effects.find((e) => e.rule === E.ammo && e.operativeId === shooter.id)?.data?.['equipmentId']).toBe(
      EQ.toxinShot,
    );
    expect(s.rejected).toEqual([]);
  });

  it('Concealed Position is refused by the Shoot action’s own check, so the AI never commits it (D-032)', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', C.longSight)]!;
    const foe = state.operatives[opWith(state, 'p2', C.warrior)]!;
    const next = state.operatives[opWith(state, 'p2', C.tracker)]!;
    isolate(state, [sniper.id, foe.id, next.id]);
    place(state, sniper.id, 10, 10);
    place(state, foe.id, 18, 10);
    place(state, next.id, 18, 14);
    const params = { weaponName: 'Kroot hunting rifle', profileName: 'concealed', targetId: foe.id };
    let s = activate(ctx, state, sniper.id, 'conceal'); // the concealed profile is Silent
    expect(getAction('Shoot')!.check(ctx, s, s.operatives[sniper.id]!, params).ok).toBe(true);
    const r = act(ctx, s, sniper.id, 'Shoot', params);
    expect(r.ok).toBe(true);
    s = settle(ctx, r.state);
    const again = { ...params, targetId: next.id };
    expect(getAction('Shoot')!.check(ctx, s, s.operatives[sniper.id]!, again)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Concealed Position'),
    });
    // The mobile profile is untouched — a PROFILE-level restriction, not a weapon one.
    expect(
      getAction('Shoot')!.check(ctx, s, s.operatives[sniper.id]!, { ...again, profileName: 'mobile' }).ok,
    ).toBe(true);
    expect(s.rejected).toEqual([]);
  });

  it('a Farstalker order change through the reducer leaves nothing rejected', () => {
    const { ctx, state } = setup();
    state.pending = [];
    readyStep(ctx, state);
    let s = state;
    for (const who of ['p1', 'p2'] as PlayerId[]) {
      const d = s.pending.find((x) => x.kind === ORDER_DECISION && x.who === who);
      if (!d) continue;
      const pick = d.options.find((o) => o.id !== 'none')!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: pick.id }, ctx).state;
    }
    s = settle(ctx, s);
    expect(s.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('AI hints and module wiring', () => {
  it('every datacard has a role, every ploy a value, every equipment option a value', () => {
    const hints = farstalkerKinband.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(farstalkerKinband.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });

  it('exposes its faction equipment as EquipmentDefs and validates a roster', () => {
    expect(farstalkerKinband.equipmentDefs.map((e) => e.id).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
    for (const e of farstalkerKinband.equipmentDefs) expect(e).toMatchObject({ scope: 'faction', teamId: DATA.id });
    expect(farstalkerKinband.validateRoster(defaultRoster(DATA)).ok).toBe(true);
  });

  it('registers every extra ActionDef the printed rules need', () => {
    for (const id of [
      CHANGE_ORDER_COUNTERACT,
      POACH_PICK_UP,
      STALKER_CHARGE,
      SAVAGE_FIGHT,
      QUICK_DRAW_SHOOT,
      SALVO_SHOOT,
      BOUND_REPOSITION,
      BOUND_CHARGE,
      BOUND_FALL_BACK,
      ...Object.values(ACT),
    ]) {
      expect(getAction(id), id).toBeTruthy();
      expect(getAction(id)!.sourceText.length).toBeGreaterThan(0);
    }
  });

  it('a hook binding exists for every faction rule, ploy, equipment option and datacard ability', () => {
    const { ctx } = setup();
    const bound = new Set(ctx.hooks.bindings().map((b) => b.id.replace(/\.(p1|p2)$/, '')));
    const expected = [
      RULE.farstalker,
      ...Object.values(SP),
      ...Object.values(FP),
      ...Object.values(EQ),
      ...Object.values(AB),
    ];
    const missing = expected.filter((id) => !bound.has(id));
    // Beast/Stalker/Ready for Anything have no hook of their own where an ActionDef carries the
    // rule instead; every other printed rule must be bound.
    expect(missing).toEqual([AB.stalker, AB.readyForAnything]);
  });
});

// ---------------------------------------------------------------------------
// helpers used by several tests
// ---------------------------------------------------------------------------

function setMarkFor(state: GameState, player: PlayerId, enemyId: string): void {
  state.effects = state.effects.filter((e) => !(e.rule === E.mark && e.player === player));
  state.effects.push({
    id: `mark-${state.seq++}`,
    rule: E.mark,
    source: { kind: 'ability', id: AB.callTheKill },
    player,
    data: { operativeId: enemyId },
    expiry: { kind: 'endOfTurningPoint' },
  });
}

