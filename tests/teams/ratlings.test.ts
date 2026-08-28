/**
 * RATLINGS. Every test quotes the printed rule it pins, read out of
 * `data/teams/ratlings.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/ratlings/
 */
import { describe, expect, it } from 'vitest';
import { createGameContext } from '../../src/core/game.ts';
import { getAction } from '../../src/core/actions.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, saveOf, inflictDamage } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { kommandos } from '../../src/teams/kommandos/index.ts';
import {
  A,
  ACT,
  CARD,
  EFF,
  EQ,
  FP,
  HUNTER_CHARGE,
  LARCENOUS_PICK_UP,
  RULE,
  SNIPER_POSITIONS_SHOOT,
  SP,
  TRIPWIRE_MARKER,
  WELL_STOCKED_MARKER,
  isRifle,
  ratlings,
  scarperCandidates,
  scarperEndPositionLegal,
  shootAndHideCandidate,
} from '../../src/teams/ratlings/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { act, activate, battle, chargeTo, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('ratlings');

/** The `TeamHooks` facade the module's exported pure helpers take. */
const makeHooks = (ctx: GameContext, _state: GameState) => makeTeamHooks(DATA, 'p1', ctx);

const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, id: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === id)!.text;
const uniqueActionText = (cardId: string, id: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === id)!.text;

const EVERY_ROLE = [
  CARD.fixer,
  CARD.battlemutt,
  CARD.bullgryn,
  CARD.ogryn,
  CARD.bigShot,
  CARD.bomber,
  CARD.hardbit,
  CARD.raider,
  CARD.sneak,
  CARD.sniper,
  CARD.spotter,
  CARD.stashmaster,
  CARD.voxThief,
];

function setup(
  opts: { equipment?: string[]; map?: KillzoneMap; seed?: number; script?: number[] } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([ratlings, kommandos], {
    ...(opts.script ? { script: opts.script } : { seed: opts.seed ?? 13 }),
  });
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: ratlings, picks: rosterIncluding(ratlings, EVERY_ROLE), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: kommandos },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const data = cardId.startsWith('ratlings') ? DATA : teamData('kommandos');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

const setLoadout = (state: GameState, id: string, weapons: string[]): void => {
  const store = (state.opState['loadout'] ?? {}) as Record<string, string[]>;
  store[id] = weapons;
  state.opState['loadout'] = store;
};

const shootStub = (attackerId: string, targetId: string, weaponName: string, profileName?: string): GameState['sequence'] => ({
  kind: 'shoot',
  step: 'rollAttack',
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
  attack: { dice: [], nextId: 1 },
  defence: { dice: [], nextId: 1 },
  usedRerolls: [],
  usedRetention: [],
  damage: 0,
  useCounted: false,
  attacker: 'p1',
  defender: 'p2',
  free: false,
});

const mapWithHeavy = (): KillzoneMap => testMap({ features: [heavyBlock('heavyA', 10, 9, 4, 4, 3)] });

// ---------------------------------------------------------------------------
describe('RATLINGS data (pinned against data/teams/ratlings.json)', () => {
  it('has 13 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(13);
    const fixer = DATA.datacards.find((c) => c.id === CARD.fixer)!;
    expect(fixer).toMatchObject({ apl: 2, move: 5, save: 5, wounds: 7, base: { shape: 'round', mm: 25 } });
    expect(fixer.keywords).toEqual(['RATLING', 'IMPERIUM', 'ASTRA MILITARUM', 'LEADER', 'FIXER']);
    expect(DATA.datacards.find((c) => c.id === CARD.battlemutt)).toMatchObject({
      apl: 2,
      move: 6,
      save: 5,
      wounds: 4,
      base: { shape: 'round', mm: 25 },
    });
    expect(DATA.datacards.find((c) => c.id === CARD.bullgryn)).toMatchObject({
      apl: 2,
      move: 6,
      save: 4,
      wounds: 16,
      base: { shape: 'round', mm: 40 },
    });
    expect(DATA.datacards.find((c) => c.id === CARD.ogryn)).toMatchObject({
      apl: 2,
      move: 6,
      save: 5,
      wounds: 16,
      base: { shape: 'round', mm: 40 },
    });
    expect(DATA.datacards.find((c) => c.id === CARD.bigShot)).toMatchObject({
      apl: 2,
      move: 5,
      save: 5,
      wounds: 6,
      base: { shape: 'round', mm: 28 },
    });
    // Every RATLING except the BATTLEMUTT, BULLGRYN, OGRYN and BIG SHOT is a 25mm 6-wound body.
    for (const id of [CARD.bomber, CARD.hardbit, CARD.raider, CARD.sneak, CARD.sniper, CARD.spotter, CARD.stashmaster, CARD.voxThief]) {
      expect(DATA.datacards.find((c) => c.id === id)).toMatchObject({ apl: 2, move: 5, wounds: 6 });
    }
  });

  it('pins the six shared sniper-rifle datacards — (mobile) HIT 3, not the old app’s 4', () => {
    // docs/TEAM-DATA.md §7 records `Sniper rifle (mobile) HIT 4 (old) -> 3` for the BOMBER,
    // RAIDER, SNEAK, SPOTTER, STASHMASTER and VOX-THIEF. Any re-scrape that puts 4 back fails.
    const sniperRifleCards = [
      [CARD.bomber, 'Sniper rifle'],
      [CARD.raider, 'Suppressed sniper rifle'],
      [CARD.sneak, 'Suppressed sniper rifle'],
      [CARD.spotter, 'Sniper rifle'],
      [CARD.stashmaster, 'Sniper rifle'],
      [CARD.voxThief, 'Sniper rifle'],
    ] as const;
    for (const [cardId, weapon] of sniperRifleCards) {
      const mobile = profileOf(cardId, weapon, 'mobile');
      const stationary = profileOf(cardId, weapon, 'stationary');
      expect({ card: cardId, hit: mobile.hit }).toEqual({ card: cardId, hit: 3 });
      expect(mobile).toMatchObject({ atk: 4, dmgN: 3, dmgC: 4 });
      expect(stationary).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 3 });
      expect(stationary.rules.map((r) => r.id)).toContain('Heavy');
      expect(stationary.rules.map((r) => r.id)).toContain('Devastating');
    }
    // The FIXER's and the SNIPER's own sniper rifles are the 2+ stationary versions.
    for (const cardId of [CARD.fixer, CARD.sniper]) {
      expect(profileOf(cardId, 'Sniper rifle', 'mobile')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
      expect(profileOf(cardId, 'Sniper rifle', 'stationary')).toMatchObject({ atk: 4, hit: 2, dmgN: 3, dmgC: 3 });
    }
    // Both RAIDER/SNEAK profiles are Silent; only the RAIDER/SNEAK carry it printed.
    expect(profileOf(CARD.raider, 'Suppressed sniper rifle', 'mobile').rules.map((r) => r.id)).toContain('Silent');
  });

  it('pins the BULLGRYN’s four weapons — Brute shield and Slabshield the old app lacked', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat(CARD.bullgryn)).toEqual([
      'Grenadier gauntlet||ranged|4|4|3|5|Blast 2"',
      'Power maul||melee|4|3|4|6|Shock',
      'Brute shield||melee|4|3|3|4|',
      'Slabshield||melee|4|4|3|4|',
    ]);
    expect(flat(CARD.ogryn)).toEqual([
      'Ripper gun||ranged|4|3|4|5|Range 8"+Punishing',
      'Bayonet||melee|4|3|4|5|',
    ]);
    expect(flat(CARD.bigShot)).toEqual([
      'Tankstopper rifle|mobile|ranged|4|3|4|4|Devastating 1+Heavy (Dash only)+Piercing 1',
      'Tankstopper rifle|stationary|ranged|4|2|4|2|Devastating 4+Heavy+Piercing 1+Severe',
      'Fists||melee|3|5|1|2|',
    ]);
    expect(flat(CARD.bomber)[0]).toBe(
      'Explosive arsenal||ranged|5|3|4|5|Range 3"+Blast 1"+Heavy (Reposition only)+Limited 1+Piercing 1+Saturate',
    );
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys, 4 equipment, 18 abilities, 4 unique actions and no rare rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Scarper']);
    expect(ratlings.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(ratlings.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(ratlings.equipment).toHaveLength(4);
    expect(DATA.datacards.reduce((n, c) => n + c.abilities.length, 0)).toBe(18);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name).sort()).toEqual([
      'INTERCEPT COMMUNICATIONS',
      'OPTICS',
      'SLINGSHOT',
      'SPOT',
    ]);
    expect(DATA.rareWeaponRules).toEqual([]);
    // Every ploy id the AI can reach carries a value, or it would never be used.
    for (const p of ratlings.ploys) expect(ratlings.aiHints?.ployValue?.[p.id]).toBeGreaterThan(0);
    for (const e of ratlings.equipment) expect(ratlings.aiHints?.equipmentValue?.[e.id]).toBeGreaterThan(0);
    for (const c of DATA.datacards) expect(ratlings.aiHints?.roles?.[c.id]).toBeTruthy();
  });

  it('pins the selection block, including the "times" maxItem the scraper mis-parsed', () => {
    const sel = DATA.selection;
    expect(sel.leader).toMatchObject({ role: 'FIXER', datacardId: CARD.fixer, count: 1 });
    expect(sel.slots).toBe(10);
    expect(sel.totalOperatives).toBe(11);
    expect(sel.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['BULLGRYN', 'OGRYN', 'SNIPER'] },
      { kind: 'groupCap', group: '*', max: 3 },
      // DATA PROBLEM: "Up to three times, instead of selecting one of these operatives…" is
      // parsed as a maxItem whose item is the literal word "times". It is also unenforced (D-030).
      { kind: 'maxItem', item: 'times', max: 3 },
    ]);
    expect(sel.designerNotes?.[0]).toContain('rifle');
    expect(isRifle('Suppressed sniper rifle')).toBe(true);
    expect(isRifle('Grenadier gauntlet')).toBe(false);
  });

  it('the printed default roster is legal', () => {
    const picks = defaultRoster(DATA);
    const check = validateRosterFor(DATA, picks);
    expect(check.errors).toEqual([]);
    expect(picks).toHaveLength(11);
    expect(picks.filter((p) => p.datacardId === CARD.bullgryn)).toHaveLength(3); // the printed "*" cap
    expect(picks[0]!.datacardId).toBe(CARD.fixer);
  });
});

// ---------------------------------------------------------------------------
describe('Scarper — "After each enemy operative’s activation… you can perform a free Dash action"', () => {
  it('grants the free Dash when an enemy activation ends, once per operative per turning point', () => {
    expect(rule(RULE.scarper)).toContain('free Dash action with one friendly RATLING operative');
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', 'kommandos.boy');
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const granted = s.effects.filter((e) => e.rule === 'teamFreeAction' && e.source.id === RULE.scarper);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.data?.['only']).toEqual(['Dash']);
    const first = granted[0]!.operativeId!;
    // "Each friendly operative can only do this once per turning point."
    expect(scarperCandidates(makeHooks(ctx, s), s).map((o) => o.id)).not.toContain(first);
  });

  it('excludes BULLGRYN, OGRYN and SNEAK operatives', () => {
    expect(rule(RULE.scarper)).toContain('excluding BULLGRYN, OGRYN and SNEAK');
    const { ctx, state } = setup();
    const T = makeHooks(ctx, state);
    const excluded = [CARD.bullgryn, CARD.ogryn, CARD.sneak];
    const ids = scarperCandidates(T, state).map((o) => state.operatives[o.id]!.datacardId);
    for (const id of excluded) expect(ids).not.toContain(id);
    expect(ids).toContain(CARD.sniper);
  });

  it('"cannot do so after the final activation of the turning point"', () => {
    const { ctx, state } = setup();
    for (const op of Object.values(state.operatives)) op.ready = false;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    foe.ready = true;
    let s = activate(ctx, state, foe.id);
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    expect(s.effects.filter((e) => e.rule === 'teamFreeAction' && e.source.id === RULE.scarper)).toHaveLength(0);
  });

  it('REMINDER-ONLY clause: "cannot end that move within 3" of an enemy operative unless it’s not visible"', () => {
    const { ctx, state } = setup();
    const ratling = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    foe.pos = { x: 15, y: 11 };
    ratling.pos = { x: 10, y: 11 };
    expect(scarperEndPositionLegal(ctx, state, ratling, { x: 13.5, y: 11 })).toBe(false);
    expect(scarperEndPositionLegal(ctx, state, ratling, { x: 8, y: 11 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FIXER', () => {
  it('Target Designation: "whenever a friendly RATLING operative is shooting that enemy operative with a rifle, that weapon has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', 'kommandos.boy');
    const shooter = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const rifle = profileOf(CARD.sniper, 'Sniper rifle', 'mobile');
    const rulesNow = (s: GameState): string[] =>
      effectiveRules(ctx, s, rifle, {
        operative: s.operatives[shooter.id]!,
        target: s.operatives[foe]!,
        weaponName: 'Sniper rifle',
      }).map((r) => r.id);
    expect(rulesNow(state)).not.toContain('Lethal');
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: A.targetDesignation, data: { operativeId: foe } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === EFF.targetDesignation && e.operativeId === foe)).toBe(true);
    expect(rulesNow(out.state)).toContain('Lethal');
  });

  it('Target Designation is not offered without a FIXER in the killzone', () => {
    const { ctx, state } = setup();
    const fixer = state.operatives[opWith(state, 'p1', CARD.fixer)]!;
    fixer.removed = true;
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: A.targetDesignation }, ctx);
    expect(out.ok).toBe(false);
  });

  it('Munitorum Contacts is REMINDER-ONLY: the reducer caps equipment at four before any hook', () => {
    expect(ability(CARD.fixer, A.munitorumContacts)).toContain('one additional equipment option');
    const { ctx, state } = setup();
    const out = reduce(
      state,
      { t: 'SelectEquipment', player: 'p1', equipment: [EQ.purloinedRations, EQ.stolenGoods, EQ.luckyRound, EQ.improvisedArmour, 'eq.mines'] },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('four equipment options');
  });
});

// ---------------------------------------------------------------------------
describe('BATTLEMUTT', () => {
  it('Beast: "cannot perform any actions other than Charge, Dash, Fall Back, Fight and Reposition"', () => {
    expect(ability(CARD.battlemutt, A.beast)).toContain('cannot perform any actions other than');
    const { ctx, state } = setup();
    const mutt = state.operatives[opWith(state, 'p1', CARD.battlemutt)]!;
    const allowed = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: mutt, action, allowed: true }).allowed;
    expect(allowed('Dash')).toBe(true);
    expect(allowed('Charge')).toBe(true);
    expect(allowed('Fight')).toBe(true);
    expect(allowed('Shoot')).toBe(false);
    expect(allowed('Pick Up Marker')).toBe(false);
  });

  it('Early Warning: friendlies within 6" of the BATTLEMUTT and 2" of that enemy get a free Dash/Fall Back, capped at 3"', () => {
    expect(ability(CARD.battlemutt, A.earlyWarning)).toContain('free Dash or Fall Back action');
    const { ctx, state } = setup();
    const mutt = state.operatives[opWith(state, 'p1', CARD.battlemutt)]!;
    const mate = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    mutt.pos = { x: 12, y: 11 };
    mate.pos = { x: 13, y: 11 };
    foe.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, foe.id);
    const moved = act(ctx, s, foe.id, 'Reposition', { path: { points: [{ x: 15.5, y: 11 }] } });
    expect(moved.ok).toBe(true);
    s = moved.state;
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === A.earlyWarning);
    expect(grant).toBeDefined();
    expect(grant!.data?.['only']).toEqual(['Dash', 'Fall Back']);
    // "…but it cannot move more than 3" during that action."
    const holder = s.operatives[grant!.operativeId!]!;
    holder.apSpent = Number(grant!.data?.['threshold'] ?? 0);
    const ev = ctx.hooks.emit('onMoveDistance', s, { state: s, operative: holder, action: 'Fall Back', inches: 6 });
    expect(ev.inches).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('BULLGRYN and OGRYN', () => {
  it('Shield: "If this operative has a slabshield, it has a 3+ Save stat"', () => {
    expect(ability(CARD.bullgryn, A.bullgrynShield)).toContain('slabshield');
    const { ctx, state } = setup();
    const bull = state.operatives[opWith(state, 'p1', CARD.bullgryn)]!;
    setLoadout(state, bull.id, ['Grenadier gauntlet', 'Brute shield']);
    expect(saveOf(ctx, state, bull)).toBe(4);
    setLoadout(state, bull.id, ['Power maul', 'Slabshield']);
    expect(saveOf(ctx, state, bull)).toBe(3);
  });

  it('Shield: a brute shield lets "each of your blocks … block two unresolved successes"', () => {
    const { ctx, state } = setup();
    const bull = state.operatives[opWith(state, 'p1', CARD.bullgryn)]!;
    setLoadout(state, bull.id, ['Grenadier gauntlet', 'Brute shield']);
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: bull,
        defender: foe,
        weaponName: 'Brute shield',
        profile: profileOf(CARD.bullgryn, 'Brute shield'),
        rules: [],
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
    // A slabshield gets the 3+ Save instead, not the double block.
    setLoadout(state, bull.id, ['Power maul', 'Slabshield']);
    const ev2 = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: bull,
        defender: foe,
        weaponName: 'Slabshield',
        profile: profileOf(CARD.bullgryn, 'Slabshield'),
        rules: [],
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev2.blocks).toBe(1);
  });

  it('Brute: a Conceal-order OGRYN "cannot use Light terrain for cover" but keeps its cover save', () => {
    expect(ability(CARD.ogryn, A.ogrynBrute)).toContain('cannot use Light terrain for cover');
    const { ctx, state } = setup();
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    ogryn.order = 'conceal';
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: foe,
      target: ogryn,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('light');
    // With an Engage order the clause does not apply.
    ogryn.order = 'engage';
    const ev2 = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: foe,
      target: ogryn,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev2.ignoreCoverTerrain).toBe('none');
  });

  it('Brute: "it doesn’t remove its cover save (if any)" — the Light cover save is put back', () => {
    const light = heavyBlock('lightA', 14, 9, 1, 4, 1);
    light.parts[0]!.types = ['Light'];
    const { ctx, state } = setup({ map: testMap({ features: [light] }) });
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    ogryn.order = 'conceal';
    ogryn.pos = { x: 12.8, y: 11 };
    foe.pos = { x: 22, y: 11 };
    const seq = shootStub(foe.id, ogryn.id, 'Slugga')!;
    if (seq.kind === 'shoot') {
      seq.attacker = 'p2';
      seq.defender = 'p1';
      seq.step = 'rollDefence';
    }
    state.sequence = seq;
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: foe,
        defender: ogryn,
        weaponName: 'Slugga',
        profile: profileOf(CARD.ogryn, 'Ripper gun'),
        rules: [],
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 3,
      coverSave: false, // the core denied it, because Brute lifted Light terrain
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
  });

  it('Slow-witted: "1 additional AP … for the Pick Up Marker and mission actions (excluding Operate Hatch)"', () => {
    expect(ability(CARD.bullgryn, A.bullgrynSlowWitted)).toContain('Operate Hatch');
    const { ctx, state } = setup();
    const bull = state.operatives[opWith(state, 'p1', CARD.bullgryn)]!;
    const cost = (action: string, ap: number): number =>
      ctx.hooks.emit('onActionCost', state, { state, operative: bull, action, ap }).ap;
    expect(cost('Pick Up Marker', 1)).toBe(2);
    expect(cost('Operate Hatch', 1)).toBe(1);
    expect(cost('Reposition', 1)).toBe(1);
  });

  it('Bayonet Charge inflicts D3+1 on an enemy in control range after a Charge', () => {
    expect(ability(CARD.ogryn, A.bayonetCharge)).toContain('D3+1 damage');
    const { ctx, state } = setup({ script: [3, 3, 3, 3, 3, 3] });
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    ogryn.pos = { x: 12, y: 11 };
    foe.pos = { x: 15, y: 11 };
    const before = foe.wounds;
    let s = activate(ctx, state, ogryn.id);
    const charged = act(ctx, s, ogryn.id, 'Charge', { path: { points: [chargeTo(ctx, s, ogryn.id, foe.id)] } });
    expect(charged.ok).toBe(true);
    s = reduce(charged.state, { t: 'EndActivation', operativeId: ogryn.id }, ctx).state;
    expect(s.operatives[foe.id]!.wounds).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
describe('BOMBER', () => {
  it('Tripwire sets up two markers wholly within your territory, more than 2" from other markers', () => {
    expect(ability(CARD.bomber, A.tripwire)).toContain('two of your Tripwire markers');
    const { ctx, state } = setup();
    const bomber = state.operatives[opWith(state, 'p1', CARD.bomber)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: bomber });
    const markers = [0, 1].map((n) => state.markers[TRIPWIRE_MARKER('p1', n)]);
    expect(markers.filter(Boolean)).toHaveLength(2);
    for (const m of markers) expect(m!.pos.x).toBeLessThanOrEqual(15); // p1's territory
    const [a, b] = markers;
    expect(Math.hypot(a!.pos.x - b!.pos.x, a!.pos.y - b!.pos.y)).toBeGreaterThan(2);
  });

  it('Tripwire: "remove that marker, subtract 1 from that operative’s APL stat" (springs at the activation boundary)', () => {
    const { ctx, state } = setup();
    const bomber = state.operatives[opWith(state, 'p1', CARD.bomber)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: bomber });
    const marker = state.markers[TRIPWIRE_MARKER('p1', 0)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    foe.pos = { ...marker.pos };
    let s = activate(ctx, state, foe.id);
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    expect(s.markers[TRIPWIRE_MARKER('p1', 0)]).toBeUndefined();
    expect(s.operatives[foe.id]!.aplMods).toContain(-1);
    expect(s.effects.some((e) => e.rule === EFF.tripwireApl && e.operativeId === foe.id)).toBe(true);
  });

  it('Mine: "Mines you select from universal equipment inflict 2D3+3 damage instead"', () => {
    const { ctx, state } = setup({ script: [2, 2, 2, 2] });
    state.teams.p1.equipment = ['eq.mines']; // universal equipment is not in the test context
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    state.rolls.push({ seq: state.seq++, kind: 'mine', results: [2], player: 'p2', note: 'Mines D3+3' });
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, 5, 'mine'); // the core's D3+3 with a 2
    expect(before - state.operatives[foe.id]!.wounds).toBeGreaterThan(5);
  });

  it('Mine: "friendly RATLING operatives … cannot … take damage from them"', () => {
    const { ctx, state } = setup();
    state.teams.p1.equipment = ['eq.mines'];
    const mate = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    state.rolls.push({ seq: state.seq++, kind: 'mine', results: [2], player: 'p1', note: 'Mines D3+3' });
    const before = mate.wounds;
    inflictDamage(ctx, state, mate, 5, 'mine');
    expect(state.operatives[mate.id]!.wounds).toBe(before);
    // The BULLGRYN is printed out of the carve-out.
    const bull = state.operatives[opWith(state, 'p1', CARD.bullgryn)]!;
    state.rolls.push({ seq: state.seq++, kind: 'mine', results: [2], player: 'p1', note: 'Mines D3+3' });
    inflictDamage(ctx, state, bull, 5, 'mine');
    expect(state.operatives[bull.id]!.wounds).toBeLessThan(16);
  });
});

// ---------------------------------------------------------------------------
describe('HARDBIT', () => {
  it('Hunter: "can perform the Charge action while it has a Conceal order", adding Atk 1 and Brutal to its combat knife', () => {
    expect(ability(CARD.hardbit, A.hunter)).toContain('Charge action while it has a Conceal order');
    const { ctx, state } = setup();
    const hardbit = state.operatives[opWith(state, 'p1', CARD.hardbit)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    hardbit.pos = { x: 12, y: 11 };
    foe.pos = { x: 15, y: 11 };
    let s = activate(ctx, state, hardbit.id, 'conceal');
    // The universal Charge refuses a Conceal order.
    expect(act(ctx, s, hardbit.id, 'Charge', { path: { points: [{ x: 13.6, y: 11 }] } }).ok).toBe(false);
    const out = act(ctx, s, hardbit.id, HUNTER_CHARGE, { path: { points: [{ x: 13.6, y: 11 }] } });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.effects.some((e) => e.rule === EFF.hunterCharge && e.operativeId === hardbit.id)).toBe(true);
    const knife = profileOf(CARD.hardbit, 'Combat knife');
    const ids = effectiveRules(ctx, s, knife, {
      operative: s.operatives[hardbit.id]!,
      weaponName: 'Combat knife',
    }).map((r) => r.id);
    expect(ids).toContain('Brutal');
    const ev = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: {
        attacker: s.operatives[hardbit.id]!,
        defender: s.operatives[foe.id]!,
        weaponName: 'Combat knife',
        profile: knife,
        rules: [],
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      count: knife.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.atk).toBe(1);
  });

  it('Lie in Wait: retaliating beside Light or Heavy terrain, "you resolve the first attack dice"', () => {
    expect(ability(CARD.hardbit, A.lieInWait)).toContain('resolve the first attack dice');
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const hardbit = state.operatives[opWith(state, 'p1', CARD.hardbit)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    hardbit.pos = { x: 14.5, y: 11 }; // touching the Heavy block at x 10..14
    foe.pos = { x: 15.3, y: 11 };
    const s = activate(ctx, state, foe.id);
    const out = act(ctx, s, foe.id, 'Fight', { targetId: hardbit.id, meleeWeaponName: 'Choppa' });
    const seq = out.state.sequence;
    expect(seq?.kind).toBe('fight');
    expect(seq && seq.kind === 'fight' ? seq.turn : '').toBe('defender');
  });
});

// ---------------------------------------------------------------------------
describe('RAIDER, SNEAK, SPOTTER and VOX-THIEF unique actions', () => {
  it('SLINGSHOT moves the RAIDER to a legal spot near a terrain point and blocks a later Shoot', () => {
    expect(uniqueActionText(CARD.raider, ACT.slingshot)).toContain('Select a point on a terrain feature');
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const raider = state.operatives[opWith(state, 'p1', CARD.raider)]!;
    raider.pos = { x: 8, y: 11 };
    for (const o of Object.values(state.operatives)) if (o.id !== raider.id && o.player === 'p1') o.pos = { x: 1, y: 1 + Number(o.id.split('-')[1]) * 1.4 };
    const from = { ...raider.pos };
    let s = activate(ctx, state, raider.id);
    const out = act(ctx, s, raider.id, ACT.slingshot, {});
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[raider.id]!.pos).not.toEqual(from);
    // "…or during an activation in which it performed the … Shoot action (or vice versa)."
    expect(s.effects.some((e) => e.rule === EFF.slingshot && e.operativeId === raider.id)).toBe(true);
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[raider.id]!,
      action: 'Shoot',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
  });

  it('SLINGSHOT is refused while within control range of an enemy operative', () => {
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const raider = state.operatives[opWith(state, 'p1', CARD.raider)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    raider.pos = { x: 12, y: 11 };
    foe.pos = { x: 12.6, y: 11 };
    const s = activate(ctx, state, raider.id);
    expect(act(ctx, s, raider.id, ACT.slingshot, {}).ok).toBe(false);
  });

  it('OPTICS: "enemy operatives cannot be obscured and the stationary profile … has the Lethal 5+ weapon rule"', () => {
    expect(uniqueActionText(CARD.sneak, ACT.optics)).toContain('Lethal 5+');
    const { ctx, state } = setup();
    const sneak = state.operatives[opWith(state, 'p1', CARD.sneak)]!;
    let s = activate(ctx, state, sneak.id);
    s = act(ctx, s, sneak.id, ACT.optics, {}).state;
    expect(s.effects.some((e) => e.rule === EFF.optics && e.operativeId === sneak.id)).toBe(true);
    const stationary = profileOf(CARD.sneak, 'Suppressed sniper rifle', 'stationary');
    const ids = effectiveRules(ctx, s, stationary, {
      operative: s.operatives[sneak.id]!,
      weaponName: 'Suppressed sniper rifle',
    }).map((r) => r.id);
    expect(ids).toContain('Lethal');
    // The mobile profile does not get it.
    const mobile = profileOf(CARD.sneak, 'Suppressed sniper rifle', 'mobile');
    expect(
      effectiveRules(ctx, s, mobile, { operative: s.operatives[sneak.id]!, weaponName: 'Suppressed sniper rifle' }).map(
        (r) => r.id,
      ),
    ).not.toContain('Lethal');
    // "Until the start of this operative's next activation."
    const s2 = activate(ctx, { ...s, activeOperativeId: undefined }, sneak.id);
    expect(s2.effects.some((e) => e.rule === EFF.optics && e.operativeId === sneak.id)).toBe(false);
  });

  it('SPOT places the token on a visible enemy (its printed effect list is missing from the JSON)', () => {
    const printed = uniqueActionText(CARD.spotter, ACT.spot);
    expect(printed).toContain('Select one enemy operative visible to this operative');
    // DATA PROBLEM: the "If you do:" bullets are absent, so there is no effect to apply.
    expect(printed).toContain('If you do:');
    expect(printed.split('If you do:')[1]!.trim()).toBe(
      'This operative cannot perform this action while within control range of an enemy operative.',
    );
    const { ctx, state } = setup();
    const spotter = state.operatives[opWith(state, 'p1', CARD.spotter)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    spotter.pos = { x: 12, y: 11 };
    foe.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, spotter.id);
    s = act(ctx, s, spotter.id, ACT.spot, { targetOperativeId: foe.id }).state;
    expect(s.effects.some((e) => e.rule === EFF.spot && e.operativeId === foe.id)).toBe(true);
  });

  it('INTERCEPT COMMUNICATIONS: "add 1 to that operative’s APL stat" until the end of its next activation', () => {
    expect(uniqueActionText(CARD.voxThief, ACT.intercept)).toContain('add 1 to that operative’s APL stat');
    const { ctx, state } = setup();
    const vox = state.operatives[opWith(state, 'p1', CARD.voxThief)]!;
    const mate = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    vox.pos = { x: 12, y: 11 };
    mate.pos = { x: 14, y: 11 };
    let s = activate(ctx, state, vox.id);
    const out = act(ctx, s, vox.id, ACT.intercept, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[mate.id]!.aplMods).toContain(1);
    expect(s.effects.some((e) => e.rule === EFF.interceptApl && e.operativeId === mate.id)).toBe(true);
    // The +1 is un-done when the window closes, rather than leaking into `aplMods` for ever.
    s = reduce(s, { t: 'EndActivation', operativeId: vox.id }, ctx).state;
    s = activate(ctx, s, mate.id);
    s = reduce(s, { t: 'EndActivation', operativeId: mate.id }, ctx).state;
    expect(s.operatives[mate.id]!.aplMods).not.toContain(1);
  });
});

// ---------------------------------------------------------------------------
describe('STASHMASTER', () => {
  it('Light-fingered: "the Pick Up Marker, Place Marker or a mission action for 1 less AP", once per activation', () => {
    expect(ability(CARD.stashmaster, A.lightFingered)).toContain('1 less AP');
    const { ctx, state } = setup();
    const stash = state.operatives[opWith(state, 'p1', CARD.stashmaster)]!;
    const cost = (action: string): number =>
      ctx.hooks.emit('onActionCost', state, { state, operative: stash, action, ap: 1 }).ap;
    expect(cost('Pick Up Marker')).toBe(0);
    expect(cost('Place Marker')).toBe(0);
    expect(cost('Reposition')).toBe(1);
    // "Once during each of this operative's activations" — spent by the first such action.
    stash.actionsThisActivation.push('Pick Up Marker');
    expect(cost('Place Marker')).toBe(1);
  });

  it('Well Stocked: "you can set up an additional Ammo Cache marker"', () => {
    expect(ability(CARD.stashmaster, A.wellStocked)).toContain('additional Ammo Cache marker');
    const { ctx, state } = setup();
    state.teams.p1.equipment = ['eq.ammoCache'];
    const stash = state.operatives[opWith(state, 'p1', CARD.stashmaster)]!;
    ctx.hooks.emit('onDeploy', state, { state, operative: stash });
    const extra = state.markers[WELL_STOCKED_MARKER('p1')];
    expect(extra).toBeDefined();
    expect(extra!.kind).toBe('ammoCache');
    expect(extra!.owner).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('SNIPER POSITIONS: >6" from enemies and within 1" of Heavy terrain gives the stationary rifle Silent', () => {
    expect(rule(SP.sniperPositions)).toContain('Silent weapon rule');
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    sniper.pos = { x: 9.4, y: 11 }; // 0.x" from the Heavy block at x 10..14
    for (const e of Object.values(state.operatives)) if (e.player === 'p2') e.pos = { x: 28, y: 2 + Number(e.id.split('-')[1]) };
    const stationary = profileOf(CARD.sniper, 'Sniper rifle', 'stationary');
    const ids = (): string[] =>
      effectiveRules(ctx, state, stationary, { operative: sniper, weaponName: 'Sniper rifle' }).map((r) => r.id);
    expect(ids()).not.toContain('Silent');
    state.teams.p1.gambitsUsedTP.push(SP.sniperPositions);
    expect(ids()).toContain('Silent');
    // The mobile profile never gets it — "the stationary profile of its rifle".
    const mobile = profileOf(CARD.sniper, 'Sniper rifle', 'mobile');
    expect(effectiveRules(ctx, state, mobile, { operative: sniper, weaponName: 'Sniper rifle' }).map((r) => r.id)).not.toContain(
      'Silent',
    );
  });

  it('SNIPER POSITIONS: the Silent grant is a real Conceal-order Shoot action (D-021)', () => {
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    // Tucked against the corner of the Heavy block (x 10..14, y 9..13) with a clear line south.
    sniper.pos = { x: 9.4, y: 8.4 };
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    for (const e of Object.values(state.operatives)) if (e.player === 'p2') e.pos = { x: 27, y: 2 + Number(e.id.split('-')[1]) };
    foe.pos = { x: 20, y: 4 };
    state.teams.p1.gambitsUsedTP.push(SP.sniperPositions);
    const s = activate(ctx, state, sniper.id, 'conceal');
    // The universal Shoot refuses a Conceal order for a weapon without printed Silent.
    expect(act(ctx, s, sniper.id, 'Shoot', { weaponName: 'Sniper rifle', profileName: 'stationary', targetId: foe.id }).ok).toBe(
      false,
    );
    const out = act(ctx, s, sniper.id, SNIPER_POSITIONS_SHOOT, {
      weaponName: 'Sniper rifle',
      profileName: 'stationary',
      targetId: foe.id,
    });
    expect(out.ok).toBe(true);
  });

  it('SHIFTY: a concealed RATLING in cover "cannot be selected as a valid target … except being within 2""', () => {
    expect(rule(SP.shifty)).toContain('cannot be selected as a valid target');
    const { ctx, state } = setup({ map: mapWithHeavy() });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    sniper.order = 'conceal';
    sniper.pos = { x: 9.4, y: 11 };
    foe.pos = { x: 20, y: 11 };
    state.teams.p1.gambitsUsedTP.push(SP.shifty);
    const check = (): boolean =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target: sniper,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(check()).toBe(false);
    // "…except being within 2""
    foe.pos = { x: 10.5, y: 11 };
    sniper.pos = { x: 9.4, y: 11 };
    expect(check()).toBe(true);
  });

  it('CRACK SHOTS: Balanced beyond 6" only when the shooter has not moved, or is counteracting', () => {
    expect(rule(SP.crackShots)).toContain('Balanced weapon rule');
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    sniper.pos = { x: 8, y: 11 };
    foe.pos = { x: 20, y: 11 };
    state.teams.p1.gambitsUsedTP.push(SP.crackShots);
    const rifle = profileOf(CARD.sniper, 'Sniper rifle', 'mobile');
    const ids = (): string[] =>
      effectiveRules(ctx, state, rifle, { operative: sniper, target: foe, weaponName: 'Sniper rifle' }).map((r) => r.id);
    expect(ids()).toContain('Balanced');
    sniper.actionsThisActivation.push('Reposition');
    expect(ids()).not.toContain('Balanced');
    // "…or if it's a counteraction."
    state.opState['counteract'] = { operativeId: sniper.id, actionsUsed: 0 };
    expect(ids()).toContain('Balanced');
    // "…an enemy operative MORE THAN 6" from it"
    delete state.opState['counteract'];
    sniper.actionsThisActivation = [];
    foe.pos = { x: 11, y: 11 };
    expect(ids()).not.toContain('Balanced');
  });

  it('FRONTLINE ASSAULT: Balanced for a BULLGRYN/OGRYN in enemy territory or within 3" of an objective — shooting AND fighting', () => {
    expect(rule(SP.frontlineAssault)).toContain('shooting, fighting or retaliating');
    const { ctx, state } = setup();
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    ogryn.pos = { x: 4, y: 4 }; // p1 territory, far from every objective
    state.teams.p1.gambitsUsedTP.push(SP.frontlineAssault);
    const bayonet = profileOf(CARD.ogryn, 'Bayonet');
    const melee = (): string[] =>
      effectiveRules(ctx, state, bayonet, { operative: ogryn, weaponName: 'Bayonet' }).map((r) => r.id);
    expect(melee()).not.toContain('Balanced');
    ogryn.pos = { x: 20, y: 11 }; // p2's territory
    expect(melee()).toContain('Balanced');
    // "…or within 3" of an objective marker" — the p1 objective sits at (8, 11).
    ogryn.pos = { x: 8, y: 12.5 };
    expect(melee()).toContain('Balanced');
    const ripper = profileOf(CARD.ogryn, 'Ripper gun');
    expect(effectiveRules(ctx, state, ripper, { operative: ogryn, weaponName: 'Ripper gun' }).map((r) => r.id)).toContain(
      'Balanced',
    );
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('SURVIVAL INSTINCTS: "If it’s a normal success, it can block one unresolved critical success"', () => {
    expect(rule(FP.survivalInstincts)).toContain('block one unresolved critical success');
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe.id,
      defenderId: sniper.id,
      attackerWeapon: 'Choppa',
      defenderCanRetaliate: true,
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      turn: 'defender',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
      attackerAssists: 0,
      defenderAssists: 0,
      attacker: 'p2',
      defender: 'p1',
      free: false,
      hatchway: false,
    };
    state.teams.p1.ploysUsedTP.push(FP.survivalInstincts);
    const emit = () =>
      ctx.hooks.emit('onBlockAllocation', state, {
        state,
        ctx: {
          attacker: sniper,
          defender: foe,
          weaponName: 'Fists',
          profile: profileOf(CARD.sniper, 'Fists'),
          rules: [],
          type: 'melee',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 0,
        },
        brutal: false,
        blocks: 1,
        normalsCanBlockCrits: false,
      });
    expect(emit().normalsCanBlockCrits).toBe(true);
    // "…if it's a critical success, it can block two unresolved successes"
    state.log.push({ seq: state.seq++, tp: 1, kind: 'decision', player: 'p1', text: 'strikeOrBlock: Block with the critical success' });
    expect(emit().blocks).toBe(2);
  });

  it('LARCENOUS: the Pick Up Marker only needs to CONTEST the marker and ignores enemy control range', () => {
    expect(rule(FP.larcenous)).toContain('only needs to contest the marker');
    const { ctx, state } = setup();
    const stash = state.operatives[opWith(state, 'p1', CARD.stashmaster)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    stash.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.4, y: 11 }; // contesting the same marker and engaging the STASHMASTER
    state.markers['loot'] = {
      id: 'loot',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 15.2, y: 11 },
      z: 0,
      owner: 'p1',
      flags: { pickUpAllowed: true },
    };
    let s = activate(ctx, state, stash.id);
    // The universal Pick Up Marker refuses: engaged, and p1 does not control the marker.
    expect(act(ctx, s, stash.id, 'Pick Up Marker', { markerId: 'loot' }).ok).toBe(false);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.larcenous }, ctx).state;
    expect(s.effects.some((e) => e.rule === EFF.larcenous && e.operativeId === stash.id)).toBe(true);
    const out = act(ctx, s, stash.id, LARCENOUS_PICK_UP, { markerId: 'loot' });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[stash.id]!.carryingMarkerId).toBe('loot');
  });

  it('SHARPSHOT: "Having other friendly RATLING operatives within an enemy operative’s control range doesn’t prevent that enemy operative from being selected"', () => {
    expect(rule(FP.sharpshot)).toContain('doesn’t prevent that enemy operative from being selected');
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const mate = state.operatives[opWith(state, 'p1', CARD.hardbit)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    sniper.pos = { x: 8, y: 11 };
    foe.pos = { x: 16, y: 11 };
    mate.pos = { x: 15.5, y: 11 };
    const shoot = () =>
      act(ctx, activate(ctx, state, sniper.id), sniper.id, 'Shoot', {
        weaponName: 'Sniper rifle',
        profileName: 'mobile',
        targetId: foe.id,
      });
    expect(shoot().ok).toBe(false);
    state.teams.p1.ploysUsedTP.push(FP.sharpshot);
    expect(shoot().ok).toBe(true);
  });

  it('SHOOT AND HIDE: "you can change its order to Conceal" after an Engage-order rifle Shoot', () => {
    expect(rule(FP.shootAndHide)).toContain('change its order to Conceal');
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    sniper.pos = { x: 8, y: 11 };
    for (const e of Object.values(state.operatives)) if (e.player === 'p2') e.pos = { x: 26, y: 2 + Number(e.id.split('-')[1]) };
    foe.pos = { x: 20, y: 11 };
    let s = activate(ctx, state, sniper.id);
    s = act(ctx, s, sniper.id, 'Shoot', { weaponName: 'Sniper rifle', profileName: 'mobile', targetId: foe.id }).state;
    while (s.pending.length > 0) s = reduce(s, { t: 'PassDecision', decisionId: s.pending[0]!.id }, ctx).state;
    expect(shootAndHideCandidate(makeHooks(ctx, s), s)?.id).toBe(sniper.id);
    const out = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.shootAndHide }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[sniper.id]!.order).toBe('conceal');
  });

  it('SHOOT AND HIDE is not usable when the Shoot action did not use a rifle', () => {
    const { ctx, state } = setup();
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    state.activeOperativeId = ogryn.id;
    ogryn.actionsThisActivation.push('Shoot');
    const ploy = ratlings.ploys.find((p) => p.id === FP.shootAndHide)!;
    expect(ploy.usable?.(state, 'p1').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('PURLOINED RATIONS: "improve the Hit stat of its rifle by 1", applied to dice already rolled', () => {
    expect(rule(EQ.purloinedRations)).toContain('improve the Hit stat of its rifle by 1');
    const { ctx, state } = setup({ equipment: [EQ.purloinedRations] });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const profile = profileOf(CARD.sniper, 'Sniper rifle', 'mobile'); // Hit 3+
    const seq = shootStub(sniper.id, foe.id, 'Sniper rifle', 'mobile')!;
    if (seq.kind === 'shoot') seq.attack.dice = [{ id: 1, value: 2, state: 'fail', rolled: true }];
    state.sequence = seq;
    const ev = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: {
        attacker: sniper,
        defender: foe,
        weaponName: 'Sniper rifle',
        profile,
        rules: [],
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      dice: [],
      rerolls: [],
    });
    void ev;
    expect(state.sequence!.kind === 'shoot' && state.sequence.attack.dice[0]!.state).toBe('normal');
    // "…until the end of that sequence" — later re-rolls use the improved Hit stat.
    expect(hitOf(ctx, state, sniper, profile)).toBe(2);
  });

  it('LUCKY ROUND: "that weapon has the Severe weapon rule until the end of that sequence"', () => {
    expect(rule(EQ.luckyRound)).toContain('Severe weapon rule');
    const { ctx, state } = setup({ equipment: [EQ.luckyRound] });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const profile = profileOf(CARD.sniper, 'Sniper rifle', 'mobile');
    const seq = shootStub(sniper.id, foe.id, 'Sniper rifle', 'mobile')!;
    if (seq.kind === 'shoot') seq.attack.dice = [{ id: 1, value: 4, state: 'normal', rolled: true }];
    state.sequence = seq;
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: {
        attacker: sniper,
        defender: foe,
        weaponName: 'Sniper rifle',
        profile,
        rules: [],
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      dice: [],
      rerolls: [],
    });
    expect(state.effects.some((e) => e.rule === EFF.luckyRound)).toBe(true);
    expect(
      effectiveRules(ctx, state, profile, { operative: sniper, target: foe, weaponName: 'Sniper rifle' }).map((r) => r.id),
    ).toContain('Severe');
  });

  it('STOLEN GOODS: "roll one D3 … 2, you gain 1CP"', () => {
    expect(rule(EQ.stolenGoods)).toContain('you gain 1CP');
    const ctx = teamContext([ratlings, kommandos], { script: [4, 4, 4, 4, 4, 4, 4, 4] }); // D3 = ceil(4/2) = 2
    const state = battle({
      ctx,
      p1: { module: ratlings, equipment: [EQ.stolenGoods] },
      p2: { module: kommandos },
    });
    expect(state.rolls.some((r) => r.kind === 'stolenGoods')).toBe(true);
    expect(state.log.some((l) => l.text.startsWith('Stolen Goods'))).toBe(true);
  });

  it('IMPROVISED ARMOUR: "defence dice results of 5+ are critical successes" for a BULLGRYN or OGRYN', () => {
    expect(rule(EQ.improvisedArmour)).toContain('defence dice results of 5+ are critical successes');
    const { ctx, state } = setup({ equipment: [EQ.improvisedArmour] });
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const seq = shootStub(foe.id, ogryn.id, 'Choppa')!;
    if (seq.kind === 'shoot') {
      seq.step = 'defenceRerolls';
      seq.attacker = 'p2';
      seq.defender = 'p1';
      seq.defence.dice = [
        { id: 1, value: 5, state: 'normal', rolled: true },
        { id: 2, value: 3, state: 'fail', rolled: true },
        { id: 3, value: 0, state: 'normal', rolled: false, note: 'cover save' },
      ];
    }
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: foe,
        defender: ogryn,
        weaponName: 'Choppa',
        profile: profileOf(CARD.ogryn, 'Bayonet'),
        rules: [],
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    const dice = state.sequence!.kind === 'shoot' ? state.sequence.defence.dice : [];
    expect(dice[0]!.state).toBe('crit');
    expect(dice[1]!.state).toBe('fail');
    expect(dice[2]!.state).toBe('normal'); // an un-rolled cover save is not a 5+
  });
});

// ---------------------------------------------------------------------------
describe('Free-action book-keeping', () => {
  it('a Scarper grant is AP outside the APL stat, and it expires with the activation it is spent in', () => {
    // "you can perform a free Dash action with one friendly RATLING operative" grants an
    // action, not an APL stat change, so the APL stat is untouched and the operative simply has
    // one AP more than its APL to spend (docs/DECISIONS.md D-100).
    expect(rule(RULE.scarper)).toContain('you can perform a free Dash action with one friendly RATLING operative');
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', 'kommandos.boy');
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === RULE.scarper)!;
    const holder = grant.operativeId!;
    const apl = aplOf(ctx, s, s.operatives[holder]!);
    expect(s.operatives[holder]!.aplMods).toEqual([]);
    expect(freeApOf(s, s.operatives[holder]!)).toBe(1);
    expect(apBudgetOf(ctx, s, s.operatives[holder]!)).toBe(apl + 1);
    // The AP belongs to that one Dash: it goes away with the activation it is spent in, so a
    // team Scarper feeds after every enemy activation never accumulates AP.
    s = activate(ctx, s, holder);
    s = reduce(s, { t: 'EndActivation', operativeId: holder }, ctx).state;
    expect(freeApOf(s, s.operatives[holder]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[holder]!)).toBe(apl);
  });

  it('a Scarper grant nobody spent does not outlive its turning point', () => {
    // "Each friendly operative can only do this once per turning point, and cannot do so after
    //  the final activation of the turning point." The offer is made between activations, so an
    //  operative that is already expended has no activation left for the AP to expire with; the
    //  Ready step is what closes that window.
    expect(rule(RULE.scarper)).toContain('cannot do so after the final activation of the turning point');
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', 'kommandos.boy');
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === RULE.scarper)!;
    const holder = s.operatives[grant.operativeId!]!;
    holder.expended = true; // it had already activated when the offer was made
    holder.ready = false;
    expect(freeApOf(s, holder)).toBe(1);
    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 0 });
    expect(freeApOf(s, holder)).toBe(0);
    expect(apBudgetOf(ctx, s, holder)).toBe(aplOf(ctx, s, holder));
  });

  it('a Scarper free action can only be spent on a Dash', () => {
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', 'kommandos.boy');
    let s = activate(ctx, state, foe);
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.source.id === RULE.scarper)!;
    const op = s.operatives[grant.operativeId!]!;
    op.apSpent = Number(grant.data?.['threshold'] ?? 0);
    const ev = ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Shoot', allowed: true });
    expect(ev.allowed).toBe(false);
    const ok = ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Dash', allowed: true });
    expect(ok.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Registered actions', () => {
  it('registers the three D-021 carve-out actions with the right `treatedAs`', () => {
    expect(getAction(SNIPER_POSITIONS_SHOOT)?.treatedAs).toBe('Shoot');
    expect(getAction(HUNTER_CHARGE)?.treatedAs).toBe('Charge');
    expect(getAction(LARCENOUS_PICK_UP)?.treatedAs).toBe('Pick Up Marker');
    expect(getAction(ACT.slingshot)?.treatedAs).toBe('Reposition');
  });

  it('every unique action is registered and gated to its own datacard', () => {
    const { ctx, state } = setup();
    for (const [cardId, actionId] of [
      [CARD.raider, ACT.slingshot],
      [CARD.sneak, ACT.optics],
      [CARD.spotter, ACT.spot],
      [CARD.voxThief, ACT.intercept],
    ] as const) {
      const def = getAction(actionId)!;
      expect(def).toBeDefined();
      const mine = state.operatives[opWith(state, 'p1', cardId)]!;
      const other = state.operatives[opWith(state, 'p1', CARD.sniper)]!;
      expect(def.available?.(ctx, state, mine)).toBe(true);
      expect(def.available?.(ctx, state, other)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('RATLINGS bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(71),
        datacards: [...ratlings.datacards, ...kommandos.datacards],
        maps: [map],
        teams: [ratlings, kommandos],
      });
      for (const mod of [ratlings, kommandos]) for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const result = playGame({
        ctx,
        map,
        seed: 71,
        critOpId: 'crit.secure',
        rosters: {
          p1: {
            teamId: ratlings.id,
            operatives: defaultRoster(ratlings.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: ratlings.equipment.slice(0, 4).map((e) => e.id),
          },
          p2: {
            teamId: kommandos.id,
            operatives: defaultRoster(kommandos.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: kommandos.equipment.slice(0, 2).map((e) => e.id),
          },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
    }, 90_000);
  }
});

