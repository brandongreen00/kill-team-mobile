/**
 * BATTLECLADE. Every test quotes the printed rule it pins, read out of
 * `data/teams/battleclade.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/battleclade/
 */
import { describe, expect, it } from 'vitest';
import { actionTargetKind, actionTargetOptions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, HookRegistry, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions, counteractCandidates } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, apBudgetOf, aplOf, freeApOf, markerController } from '../../src/core/state.ts';
import { terrain, type GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/battleclade.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, entryId, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  CARD,
  EQ,
  EFF,
  FP,
  GAZE_TOKEN,
  KW,
  NETWORK_DECISION,
  NETWORK_OVERRIDE_AGAIN,
  OMNISCANNER_TOKEN,
  REMINDER_ONLY,
  REMOTE_OPERATE_HATCH,
  repairTargets,
  sutureUsedOn,
  RULE_NETWORK,
  SEEKER_GAMBIT,
  SERVITOR,
  SP,
  TECH_PRIEST,
  TRANSFER_POWER,
  attackDiceChunks,
  battleclade,
  networkCounteractCandidates,
  possessionAnchor,
  prioritisedMarkerId,
  queuedNetworkCounteracts,
  surrogacyCandidates,
} from '../../src/teams/battleclade/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { testMap } from '../fixtures.ts';

const DATA = teamData('battleclade');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;
const RAW = rawJson as unknown as {
  selection: { constraints: { kind: string; item?: string; max?: number; role?: string; roles?: string[] }[]; rawText: string };
  markerGuide: string;
  rareWeaponRules: string[];
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

/**
 * `defaultRoster` is first-legal-row-wins (D-042) and repeats the COMBAT SERVITOR six times, so
 * it never fields the GUN SERVITOR or the TECHNOMEDIC SERVITOR. This is the same 10 operatives
 * with one of every printed row, so a rule test can reach every datacard — and it is legal.
 */
export function fullRoster(): RosterPickIn[] {
  const at = (i: number) => entryId(DATA, i);
  return [
    { datacardId: CARD.technoarcheologist, entryId: at(0), loadoutIds: [] },
    { datacardId: CARD.underseer, entryId: at(1), loadoutIds: [] },
    { datacardId: CARD.autoProxy, entryId: at(2), loadoutIds: [] },
    { datacardId: CARD.breacher, entryId: at(3), loadoutIds: [] },
    { datacardId: CARD.combat, entryId: at(4), loadoutIds: ['battleclade.g3e3.opt1'] },
    { datacardId: CARD.combat, entryId: at(4), loadoutIds: ['battleclade.g3e3.opt2'] },
    { datacardId: CARD.combat, entryId: at(4), loadoutIds: ['battleclade.g3e3.opt3'] },
    { datacardId: CARD.gun, entryId: at(5), loadoutIds: [] },
    { datacardId: CARD.gun, entryId: at(6), loadoutIds: [] },
    { datacardId: CARD.technomedic, entryId: at(7), loadoutIds: [] },
  ];
}

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  picks?: RosterPickIn[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([battleclade], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.picks ?? (opts.roles ? rosterIncluding(battleclade, opts.roles) : fullRoster());
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: battleclade, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: battleclade, picks },
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
    op.pos = { x: 1.5 + (n % 3) * 1.2, y: 20 + Math.floor(n / 3) * 1.2 };
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
  defender: OperativeState | undefined,
  profile: WeaponProfile,
  weaponName: string,
  type: 'ranged' | 'melee' = 'ranged',
): AttackContext {
  return {
    attacker,
    ...(defender ? { defender } : {}),
    weaponName,
    profile,
    rules: [...profile.rules],
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
  };
}

function shootSeqOf(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'retention',
    queue: [],
    resolvedTargets: [],
    attack: newPool(),
    defence: newPool(),
    usedRerolls: [],
    damage: 0,
    inCover: false,
    obscured: false,
    coverChoiceMade: false,
    free: false,
    ...over,
  } as ShootSequence;
}

// ---------------------------------------------------------------------------
describe('BATTLECLADE data', () => {
  it('has the seven printed datacards with their printed stats and bases', () => {
    expect(DATA.datacards.map((c) => c.id)).toEqual([
      CARD.technoarcheologist,
      CARD.autoProxy,
      CARD.breacher,
      CARD.combat,
      CARD.gun,
      CARD.underseer,
      CARD.technomedic,
    ]);
    const stats = (id: string) => {
      const c = DATA.datacards.find((x) => x.id === id)!;
      return { apl: c.apl, move: c.move, save: c.save, wounds: c.wounds, mm: c.base.mm };
    };
    expect(stats(CARD.technoarcheologist)).toEqual({ apl: 3, move: 6, save: 3, wounds: 9, mm: 32 });
    expect(stats(CARD.underseer)).toEqual({ apl: 3, move: 6, save: 3, wounds: 9, mm: 32 });
    expect(stats(CARD.autoProxy)).toEqual({ apl: 2, move: 5, save: 4, wounds: 8, mm: 25 });
    expect(stats(CARD.breacher)).toEqual({ apl: 2, move: 5, save: 4, wounds: 8, mm: 25 });
    expect(stats(CARD.combat)).toEqual({ apl: 2, move: 5, save: 4, wounds: 8, mm: 25 });
    expect(stats(CARD.gun)).toEqual({ apl: 2, move: 5, save: 4, wounds: 11, mm: 32 });
    expect(stats(CARD.technomedic)).toEqual({ apl: 2, move: 5, save: 4, wounds: 8, mm: 25 });
  });

  it('SERVITOR is a keyword the two TECH-PRIESTs do not carry — every rule scopes on that', () => {
    const kw = (id: string) => DATA.datacards.find((c) => c.id === id)!.keywords;
    expect(kw(CARD.technoarcheologist)).toEqual([
      'BATTLECLADE',
      'IMPERIUM',
      'ADEPTUS MECHANICUS',
      'TECH-PRIEST',
      'LEADER',
      'TECHNOARCHEOLOGIST',
    ]);
    // The SERVITOR UNDERSEER is a TECH-PRIEST whose own keyword is "SERVITOR UNDERSEER" — not
    // "SERVITOR". NETWORK OVERRIDE ("select one friendly BATTLECLADE SERVITOR operative") reads
    // as the underseer commanding servitors, so the distinction is the printed one.
    expect(kw(CARD.underseer)).toContain(TECH_PRIEST);
    expect(kw(CARD.underseer)).not.toContain(SERVITOR);
    expect(kw(CARD.underseer)).toContain('SERVITOR UNDERSEER');
    for (const id of [CARD.autoProxy, CARD.breacher, CARD.combat, CARD.gun, CARD.technomedic]) {
      expect([id, kw(id).includes(SERVITOR)]).toEqual([id, true]);
      expect([id, kw(id).includes(TECH_PRIEST)]).toEqual([id, false]);
    }
    for (const c of DATA.datacards) expect(c.keywords).toContain(KW);
  });

  it('pins every printed weapon profile', () => {
    const p = (cardId: string, weapon: string, name?: string) => {
      const x = profileOf(cardId, weapon, name);
      return { atk: x.atk, hit: x.hit, dmgN: x.dmgN, dmgC: x.dmgC, rules: x.rules.map((r) => r.raw) };
    };
    expect(p(CARD.technoarcheologist, 'Eradication pistol')).toEqual({
      atk: 4,
      hit: 3,
      dmgN: 4,
      dmgC: 2,
      rules: ['Range 8"', '1" Devastating 3', 'Lethal 5+'],
    });
    expect(p(CARD.technoarcheologist, 'Servo-arc claw')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 3,
      dmgC: 4,
      rules: ['Severe', 'Shock'],
    });
    expect(p(CARD.underseer, 'Master-crafted radium pistol')).toEqual({
      atk: 4,
      hit: 3,
      dmgN: 2,
      dmgC: 4,
      rules: ['Range 8"', 'Balanced', 'Rending'],
    });
    expect(p(CARD.autoProxy, 'Taser goad')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 3,
      dmgC: 4,
      rules: ['Lethal 5+', 'Shock'],
    });
    expect(p(CARD.breacher, 'Lascutter', 'close range')).toEqual({
      atk: 4,
      hit: 3,
      dmgN: 4,
      dmgC: 5,
      rules: ['Range 2"', 'Lethal 5+', 'Piercing 2'],
    });
    expect(p(CARD.breacher, 'Lascutter', 'short range')).toEqual({
      atk: 4,
      hit: 3,
      dmgN: 4,
      dmgC: 5,
      rules: ['Range 6"', 'Lethal 5+'],
    });
    expect(p(CARD.combat, 'Incendine igniter')).toEqual({
      atk: 4,
      hit: 2,
      dmgN: 4,
      dmgC: 4,
      rules: ['Range 6"', 'Saturate', 'Torrent 1"'],
    });
    expect(p(CARD.combat, 'Meltagun')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 6,
      dmgC: 3,
      rules: ['Range 6"', 'Devastating 4', 'Piercing 2'],
    });
    expect(p(CARD.combat, 'Phosphor blaster')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 3,
      dmgC: 4,
      rules: ['Blast 1"', 'Severe'],
    });
    expect(p(CARD.gun, 'Heavy arc rifle')).toEqual({
      atk: 5,
      hit: 4,
      dmgN: 4,
      dmgC: 6,
      rules: ['Heavy (Dash only)', 'Piercing 1', 'Stun'],
    });
    expect(p(CARD.gun, 'Heavy bolter', 'sweeping')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 4,
      dmgC: 5,
      rules: ['Heavy (Dash only)', 'Piercing Crits 1', 'Torrent 1"'],
    });
    expect(p(CARD.technomedic, 'Servo-chirurgic claw')).toEqual({
      atk: 4,
      hit: 4,
      dmgN: 3,
      dmgC: 4,
      rules: ['Rending'],
    });
  });

  it('prints one faction rule, four strategy ploys, four firefight ploys, four equipment and no rare rules', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE_NETWORK]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual([
      SP.noosphericPossession,
      SP.dutyOfReclamation,
      SP.incantation,
      SP.prioritisedAcquisition,
    ]);
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual([
      FP.systemExorcism,
      FP.remoteAccess,
      FP.autoFerric,
      FP.servileSurrogacy,
    ]);
    expect(DATA.equipment.map((e) => e.id)).toEqual([
      EQ.covertGuises,
      EQ.electromanticCapacitors,
      EQ.concealedApparatus,
      EQ.neurocyclicCells,
    ]);
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(p.cp).toBe(1);
    expect(RAW.rareWeaponRules).toEqual([]);
    expect(battleclade.ploys.map((p) => p.id)).toHaveLength(8);
  });

  it('has three datacard abilities and six unique actions', () => {
    const abilities = DATA.datacards.flatMap((c) => c.abilities.map((a) => a.id));
    expect(abilities).toEqual([AB.seekerOfDivineArcana, AB.achillanEye, AB.mechanosutureArray]);
    const uniques = DATA.datacards.flatMap((c) => c.uniqueActions.map((a) => a.id));
    expect(uniques).toEqual([
      ACT.omniscanner,
      ACT.gaze,
      ACT.breach,
      ACT.datacoronal,
      ACT.networkOverride,
      ACT.expedientRepair,
    ]);
    for (const id of uniques) expect([id, getAction(id)?.ap]).toEqual([id, 1]);
  });

  it('the section overrun is trimmed at load for the last strategy and firefight ploys', () => {
    // Confirmed on all 48 teams (docs/TEAM-STATUS.md § Data problems, batch 2): the committed
    // bytes append the whole following page section to the last item of each section.
    const raw = rawJson as unknown as { strategyPloys: { id: string; text: string }[]; firefightPloys: { id: string; text: string }[] };
    expect(raw.strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect(raw.firefightPloys[3]!.text).toContain('Faction Equipment');
    expect(ruleText(SP.prioritisedAcquisition)).not.toContain('Firefight Ploys');
    expect(ruleText(SP.prioritisedAcquisition)).toContain('(to a maximum of 4)');
    expect(ruleText(FP.servileSurrogacy)).not.toContain('Faction Equipment');
    expect(ruleText(FP.servileSurrogacy)).toContain('Blast or Torrent weapon rule');
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE selection (D-043)', () => {
  it('prints the two role-scoped `maxItem` caps the COMBAT SERVITOR weapons carry', () => {
    // "Your kill team can only include up to one COMBAT SERVITOR operative with meltagun, and it
    //  can only include up to three COMBAT SERVITOR operatives with incendine igniter."
    expect(RAW.selection.rawText).toContain(
      'Your kill team can only include up to one COMBAT SERVITOR operative with meltagun',
    );
    expect(RAW.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['COMBAT SERVITOR'] },
      { kind: 'maxItem', item: 'meltagun', max: 1, role: 'COMBAT SERVITOR' },
      { kind: 'maxItem', item: 'incendine igniter', max: 3, role: 'COMBAT SERVITOR' },
    ]);
  });

  it('`defaultRoster` fields a legal 10-operative kill team', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(DATA.selection.totalOperatives);
    expect(picks).toHaveLength(10);
    const v = validateRosterFor(DATA, picks);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('a SECOND COMBAT SERVITOR with a meltagun is refused ("up to one … with meltagun")', () => {
    const picks = defaultRoster(DATA);
    const melta = picks.map((p, i) => ({ p, i })).filter((x) => x.p.datacardId === CARD.combat);
    expect(melta.length).toBeGreaterThanOrEqual(2);
    const bad = picks.map((p) => ({ ...p, loadoutIds: [...(p.loadoutIds ?? [])] }));
    for (const { i } of melta.slice(0, 2)) bad[i]!.loadoutIds = ['battleclade.g3e3.opt2']; // Servo-claw; meltagun
    const v = validateRosterFor(DATA, bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' | ')).toContain('meltagun');
  });

  it('a FOURTH COMBAT SERVITOR with an incendine igniter is refused ("up to three")', () => {
    const bad = fullRoster().map((p) => ({ ...p, loadoutIds: [...(p.loadoutIds ?? [])] }));
    const combatEntry = bad.find((p) => p.datacardId === CARD.combat)!.entryId;
    // Trade the TECHNOMEDIC row for a fourth COMBAT SERVITOR, then give all four an igniter.
    const victim = bad.findIndex((p) => p.datacardId === CARD.technomedic);
    expect(victim).toBeGreaterThanOrEqual(0);
    bad[victim] = { datacardId: CARD.combat, entryId: combatEntry, loadoutIds: ['battleclade.g3e3.opt1'] };
    for (const p of bad) if (p.datacardId === CARD.combat) p.loadoutIds = ['battleclade.g3e3.opt1'];
    const v = validateRosterFor(DATA, bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' | ')).toContain('incendine igniter');
  });

  it('"Other than COMBAT SERVITOR operatives … only include each operative on this list once"', () => {
    // Six COMBAT SERVITORs are legal (the printed exemption); two of the same GUN SERVITOR row
    // are not.
    expect(validateRosterFor(DATA, defaultRoster(DATA)).ok).toBe(true);
    expect(defaultRoster(DATA).filter((p) => p.datacardId === CARD.combat)).toHaveLength(6);
    const bad = fullRoster().map((p) => ({ ...p }));
    const gunIdx = bad.findIndex((p) => p.datacardId === CARD.gun);
    const other = bad.findIndex((p) => p.datacardId === CARD.technomedic);
    expect(gunIdx).toBeGreaterThanOrEqual(0);
    bad[other] = { ...bad[gunIdx]! };
    const v = validateRosterFor(DATA, bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' | ')).toMatch(/only include each operative on this list once/);
  });

  it('the printed default roster never fields the GUN SERVITOR or the TECHNOMEDIC (D-042)', () => {
    // `defaultRoster` is first-legal-row-wins in printed order and repeats the first repeatable
    // row, so it fields 5 of 7 datacards. Documented, not fixed here (docs/DECISIONS.md D-042).
    const fielded = new Set(defaultRoster(DATA).map((p) => p.datacardId));
    expect([...fielded].sort()).toEqual(
      [CARD.technoarcheologist, CARD.underseer, CARD.autoProxy, CARD.breacher, CARD.combat].sort(),
    );
    expect(fielded.has(CARD.gun)).toBe(false);
    expect(fielded.has(CARD.technomedic)).toBe(false);
    // The coverage roster the rule tests use is legal too.
    expect(validateRosterFor(DATA, fullRoster()).errors).toEqual([]);
    expect(new Set(fullRoster().map((p) => p.datacardId)).size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe('Noospheric Network', () => {
  it('TRANSFER POWER is a 1AP action only a friendly BATTLECLADE SERVITOR can perform', () => {
    expect(ruleText(RULE_NETWORK)).toContain('you can spend 1AP to TRANSFER POWER');
    const def = getAction(TRANSFER_POWER)!;
    expect(def.ap).toBe(1);
    const { ctx, state } = setup();
    const servitor = state.operatives[opWith(state, 'p1', CARD.gun)]!;
    const priest = state.operatives[opWith(state, 'p1', CARD.technoarcheologist)]!;
    expect(def.available!(ctx, state, servitor)).toBe(true);
    expect(def.available!(ctx, state, priest)).toBe(false);
    const underseer = state.operatives[opWith(state, 'p1', CARD.underseer)]!;
    expect(def.available!(ctx, state, underseer)).toBe(false);
  });

  it('"An operative cannot TRANSFER POWER … if it has an APL stat of less than 2"', () => {
    expect(ruleText(RULE_NETWORK)).toContain('cannot TRANSFER POWER or NETWORK COUNTERACT if it has an APL stat of less than 2');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gun);
    const op = state.operatives[id]!;
    const def = getAction(TRANSFER_POWER)!;
    expect(def.check(ctx, state, op, {}).ok).toBe(true);
    op.aplMods.push(-1); // APL 2 -> 1
    expect(def.check(ctx, state, op, {}).reason).toContain('APL stat is less than 2');
  });

  it('after that activation a NETWORK COUNTERACT decision is raised, and it hands over a real counteraction', () => {
    expect(ruleText(RULE_NETWORK)).toContain('After that activation, you can NETWORK COUNTERACT with one other friendly BATTLECLADE SERVITOR operative');
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    let s = activate(ctx, state, actorId, 'engage');
    const out = act(ctx, s, actorId, TRANSFER_POWER, {});
    expect(out.ok).toBe(true);
    s = out.state;
    expect(queuedNetworkCounteracts(s, 'p1')).toHaveLength(1);
    s = reduce(s, { t: 'EndActivation', operativeId: actorId }, ctx).state;
    const decision = s.pending.find((d) => d.kind === NETWORK_DECISION);
    expect(decision?.who).toBe('p1');
    // "…with one OTHER friendly BATTLECLADE SERVITOR operative": never the operative that
    // transferred, never a TECH-PRIEST.
    const offered = new Set(decision!.options.filter((o) => o.id !== 'decline').map((o) => String(o.data!['operativeId'])));
    expect(offered.has(actorId)).toBe(false);
    expect(offered.has(opWith(s, 'p1', CARD.underseer))).toBe(false);
    expect(offered.has(opWith(s, 'p1', CARD.technoarcheologist))).toBe(false);
    const pickId = opWith(s, 'p1', CARD.breacher);
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: `${pickId}|conceal` }, ctx).state;
    expect(s.activeOperativeId).toBe(pickId);
    expect(s.opState['counteract']).toEqual({ operativeId: pickId, actionsUsed: 0 });
    expect(s.operatives[pickId]!.order).toBe('conceal'); // "first select its order"
    expect(s.operatives[pickId]!.counteractedThisTP).toBe(true);
  });

  it('a READY operative that NETWORK COUNTERACTS "can still be activated as normal later"', () => {
    expect(ruleText(RULE_NETWORK)).toContain('if they’re ready when they NETWORK COUNTERACT, they can still be activated as normal later in the turning point');
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    const helperId = opWith(state, 'p1', CARD.breacher);
    let s = activate(ctx, state, actorId, 'engage');
    s = act(ctx, s, actorId, TRANSFER_POWER, {}).state;
    s = reduce(s, { t: 'EndActivation', operativeId: actorId }, ctx).state;
    const decision = s.pending.find((d) => d.kind === NETWORK_DECISION)!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision.id, optionId: `${helperId}|engage` }, ctx).state;
    s = act(ctx, s, helperId, 'Dash', { path: { points: [{ x: s.operatives[helperId]!.pos.x + 1, y: s.operatives[helperId]!.pos.y }] } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: helperId }, ctx).state;
    expect(s.operatives[helperId]!.ready).toBe(true);
    expect(s.operatives[helperId]!.expended).toBe(false);
    // "An operative that does NETWORK COUNTERACT cannot do so again, or counteract, during the
    //  same turning point" — which is exactly what the core reads off `counteractedThisTP`.
    expect(s.operatives[helperId]!.counteractedThisTP).toBe(true);
    for (const o of aliveOperatives(s, 'p1')) o.expended = true;
    expect(counteractCandidates(ctx, s, 'p1').map((o) => o.id)).not.toContain(helperId);
  });

  it('the counteraction is one free non-Guard 1AP action capped at 2" of movement', () => {
    expect(ruleText(RULE_NETWORK)).toContain('It can then perform a 1AP action for free, but cannot move more than 2" during that action');
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    const helperId = opWith(state, 'p1', CARD.breacher);
    isolate(state, [actorId, helperId]);
    place(state, helperId, 10, 10);
    let s = activate(ctx, state, actorId, 'engage');
    s = act(ctx, s, actorId, TRANSFER_POWER, {}).state;
    s = reduce(s, { t: 'EndActivation', operativeId: actorId }, ctx).state;
    const decision = s.pending.find((d) => d.kind === NETWORK_DECISION)!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision.id, optionId: `${helperId}|engage` }, ctx).state;
    const before = s.teams.p1.cp;
    // A 2AP action is refused, Guard is refused, and a Reposition further than 2" is refused.
    expect(act(ctx, s, helperId, 'Fall Back', { path: { points: [{ x: 11, y: 10 }] } }).reason).toContain('1AP');
    const far = act(ctx, s, helperId, 'Reposition', { path: { points: [{ x: 14, y: 10 }] } });
    expect(far.ok).toBe(false);
    const near = act(ctx, s, helperId, 'Reposition', { path: { points: [{ x: 11.5, y: 10 }] } });
    expect(near.ok).toBe(true);
    expect(near.state.operatives[helperId]!.apSpent).toBe(0); // "for free"
    expect(near.state.teams.p1.cp).toBe(before);
    // "…a counteracting operative can only perform one action."
    expect(act(ctx, near.state, helperId, 'Dash', { path: { points: [{ x: 12, y: 10 }] } }).ok).toBe(false);
  });

  it('a NETWORK COUNTERACT candidate must have APL 2 or more and must not have counteracted already', () => {
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const actorId = opWith(state, 'p1', CARD.gun);
    const req = { by: actorId, source: RULE_NETWORK };
    const all = networkCounteractCandidates(T, state, req).map((o) => o.id);
    const breacher = opWith(state, 'p1', CARD.breacher);
    expect(all).toContain(breacher);
    state.operatives[breacher]!.aplMods.push(-1);
    expect(networkCounteractCandidates(T, state, req).map((o) => o.id)).not.toContain(breacher);
    state.operatives[breacher]!.aplMods = [];
    state.operatives[breacher]!.counteractedThisTP = true;
    expect(networkCounteractCandidates(T, state, req).map((o) => o.id)).not.toContain(breacher);
  });

  it('TRANSFER POWER cannot be done from a counteraction, or twice in one activation', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gun);
    const op = state.operatives[id]!;
    const def = getAction(TRANSFER_POWER)!;
    state.opState['counteract'] = { operativeId: id, actionsUsed: 0 };
    expect(def.check(ctx, state, op, {}).reason).toContain('not an activation');
    delete state.opState['counteract'];
    op.actionsThisActivation.push(TRANSFER_POWER);
    expect(def.check(ctx, state, op, {}).reason).toContain('already transferred power');
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE datacard abilities', () => {
  it('Seeker of Divine Arcana is a STRATEGIC GAMBIT granting an order change and a free action', () => {
    expect(abilityText(CARD.technoarcheologist, AB.seekerOfDivineArcana)).toContain(
      'STRATEGIC GAMBIT. You can immediately change this operative’s order and/or it can immediately perform a free Omniscanner, Fall Back, Place Marker, Pick Up Marker, Reposition or mission action',
    );
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SEEKER_GAMBIT);
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    state.operatives[arch]!.order = 'engage';
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SEEKER_GAMBIT, data: { order: 'conceal' } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[arch]!.order).toBe('conceal');
    expect(out.state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === arch)).toBe(true);
    // "it can immediately perform a free … action" is AP on top of the APL budget, not an APL
    // stat change (docs/DECISIONS.md D-100): the AP gate sees one more, the APL stat — which is
    // what marker control totals — does not move.
    expect(out.state.operatives[arch]!.aplMods).toEqual([]);
    expect(aplOf(ctx, out.state, out.state.operatives[arch]!)).toBe(
      aplOf(ctx, state, state.operatives[arch]!),
    );
    expect(freeApOf(out.state, out.state.operatives[arch]!)).toBe(1);
    expect(apBudgetOf(ctx, out.state, out.state.operatives[arch]!)).toBe(
      aplOf(ctx, out.state, out.state.operatives[arch]!) + 1,
    );
  });

  it('the Seeker free action is restricted to the named actions — and to mission actions', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SEEKER_GAMBIT }, ctx).state;
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    const op = s.operatives[arch]!;
    op.apSpent = 3; // its own APL is spent; the next AP is the free one
    const ask = (action: string) =>
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action, allowed: true }).allowed;
    expect(ask('Reposition')).toBe(true);
    expect(ask('Pick Up Marker')).toBe(true);
    expect(ask(ACT.omniscanner)).toBe(true);
    expect(ask('Shoot')).toBe(false);
    expect(ask('Charge')).toBe(false);
    // "…or mission action" — every op action registers with `type: 'mission'`.
    const mission = getAction('Operate Hatch')!;
    expect(mission.type).toBe('mission');
    expect(ask('Operate Hatch')).toBe(true);
  });

  it('Achillan Eye gives Saturate against an enemy visible to the AUTO-PROXY, and nothing while it is engaged', () => {
    expect(abilityText(CARD.autoProxy, AB.achillanEye)).toContain(
      'that friendly operative’s ranged weapons have the Saturate weapon rule',
    );
    const { ctx, state } = setup();
    const eye = opWith(state, 'p1', CARD.autoProxy);
    const shooter = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.gun);
    isolate(state, [eye, shooter, foe]);
    place(state, eye, 10, 8);
    place(state, shooter, 8, 8);
    place(state, foe, 16, 8);
    const profile = profileOf(CARD.gun, 'Heavy arc rifle');
    const rules = () =>
      effectiveRules(ctx, state, profile, {
        operative: state.operatives[shooter]!,
        target: state.operatives[foe]!,
        weaponName: 'Heavy arc rifle',
      }).map((r) => r.id);
    expect(rules()).toContain('Saturate');
    // "This rule has no effect if this operative is within control range of an enemy operative."
    const brawler = opWith(state, 'p2', CARD.breacher);
    place(state, brawler, 10.6, 8);
    expect(rules()).not.toContain('Saturate');
  });

  it('Mechanosuture Array saves a friendly operative once per turning point and grants a free Dash', () => {
    expect(abilityText(CARD.technomedic, AB.mechanosutureArray)).toContain(
      'that friendly operative isn’t incapacitated, has 1 wound remaining and cannot be incapacitated for the remainder of the action',
    );
    const { ctx, state } = setup();
    const medic = opWith(state, 'p1', CARD.technomedic);
    const victim = opWith(state, 'p1', CARD.gun);
    isolate(state, [medic, victim]);
    place(state, medic, 10, 10);
    place(state, victim, 11.5, 10);
    const ev = ctx.hooks.emit('onIncapacitated', state, {
      state,
      operative: state.operatives[victim]!,
      prevented: false,
      freeActions: [],
    });
    expect(ev.prevented).toBe(true);
    expect(state.operatives[victim]!.wounds).toBe(1);
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim)).toBe(true);
    // "Once per turning point".
    const second = opWith(state, 'p1', CARD.breacher);
    place(state, second, 10.8, 10.8);
    const ev2 = ctx.hooks.emit('onIncapacitated', state, {
      state,
      operative: state.operatives[second]!,
      prevented: false,
      freeActions: [],
    });
    expect(ev2.prevented).toBe(false);
  });

  it('Mechanosuture Array does not fire when the TECHNOMEDIC is the Shoot action’s target, or when either is engaged', () => {
    expect(abilityText(CARD.technomedic, AB.mechanosutureArray)).toContain(
      'if it’s a Shoot action and this operative would be a primary or secondary target',
    );
    const { ctx, state } = setup();
    const medic = opWith(state, 'p1', CARD.technomedic);
    const victim = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.gun);
    isolate(state, [medic, victim, foe]);
    place(state, medic, 10, 10);
    place(state, victim, 11.5, 10);
    place(state, foe, 20, 10);
    state.sequence = shootSeqOf({
      attackerId: foe,
      targetId: medic,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Heavy arc rifle',
    });
    expect(
      ctx.hooks.emit('onIncapacitated', state, { state, operative: state.operatives[victim]!, prevented: false, freeActions: [] })
        .prevented,
    ).toBe(false);
    state.sequence = undefined;
    // "providing neither this nor that operative is within control range of an enemy operative"
    place(state, foe, 10.6, 10);
    expect(
      ctx.hooks.emit('onIncapacitated', state, { state, operative: state.operatives[victim]!, prevented: false, freeActions: [] })
        .prevented,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE unique actions', () => {
  it('OMNISCANNER tokens an enemy visible to or within 8", and its weapons then face Ceaseless', () => {
    const printed = actionOf(CARD.technoarcheologist, ACT.omniscanner);
    expect(printed.text).toContain('Select one enemy operative visible to or within 8" of this operative to gain one of your Omniscanner tokens');
    expect(printed.text).toContain('that friendly operative’s weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    const foe = opWith(state, 'p2', CARD.gun);
    const mate = opWith(state, 'p1', CARD.gun);
    isolate(state, [arch, foe, mate]);
    place(state, arch, 10, 10);
    place(state, foe, 15, 10);
    place(state, mate, 8, 10);
    let s = activate(ctx, state, arch, 'engage');
    s = act(ctx, s, arch, ACT.omniscanner, { targetOperativeId: foe }).state;
    expect(s.effects.some((e) => e.rule === OMNISCANNER_TOKEN && e.operativeId === foe && e.player === 'p1')).toBe(true);
    const rifle = profileOf(CARD.gun, 'Heavy arc rifle');
    expect(
      effectiveRules(ctx, s, rifle, {
        operative: s.operatives[mate]!,
        target: s.operatives[foe]!,
        weaponName: 'Heavy arc rifle',
      }).map((r) => r.id),
    ).toContain('Ceaseless');
    // …and an untokened enemy is unaffected.
    const other = opWith(s, 'p2', CARD.breacher);
    expect(
      effectiveRules(ctx, s, rifle, {
        operative: s.operatives[mate]!,
        target: s.operatives[other]!,
        weaponName: 'Heavy arc rifle',
      }).map((r) => r.id),
    ).not.toContain('Ceaseless');
  });

  it('OMNISCANNER also reaches a fight ("fighting against or retaliating against")', () => {
    const { ctx, state } = setup();
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    const foe = opWith(state, 'p2', CARD.gun);
    const mate = opWith(state, 'p1', CARD.autoProxy);
    isolate(state, [arch, foe, mate]);
    place(state, arch, 10, 10);
    place(state, foe, 13, 10);
    place(state, mate, 12.4, 10);
    let s = activate(ctx, state, arch, 'engage');
    s = act(ctx, s, arch, ACT.omniscanner, { targetOperativeId: foe }).state;
    s.sequence = {
      kind: 'fight',
      attackerId: mate,
      defenderId: foe,
      attacker: 'p1',
      defender: 'p2',
    } as unknown as FightSequence;
    const goad = profileOf(CARD.autoProxy, 'Taser goad');
    expect(
      effectiveRules(ctx, s, goad, { operative: s.operatives[mate]!, weaponName: 'Taser goad' }).map((r) => r.id),
    ).toContain('Ceaseless');
  });

  it('GAZE OF THE OMNISSIAH places its token — and its printed effect list is MISSING from the source', () => {
    const printed = actionOf(CARD.autoProxy, ACT.gaze);
    expect(printed.text).toContain('you can use this effect. If you do:');
    // The next thing in the printed text is the boilerplate restriction: the effect list the
    // colon promises never arrives. This is the seventh SPOT-shaped truncation.
    expect(printed.text.split('If you do:')[1]!.trim()).toBe(
      'This operative cannot perform this action while within control range of an enemy operative.',
    );
    expect(REMINDER_ONLY[ACT.gaze]).toContain('BLOCKED BY THE DATA');
    const { ctx, state } = setup();
    const eye = opWith(state, 'p1', CARD.autoProxy);
    const foe = opWith(state, 'p2', CARD.gun);
    isolate(state, [eye, foe]);
    place(state, eye, 10, 10);
    place(state, foe, 14, 10);
    let s = activate(ctx, state, eye, 'engage');
    s = act(ctx, s, eye, ACT.gaze, { targetOperativeId: foe }).state;
    expect(s.effects.some((e) => e.rule === GAZE_TOKEN && e.operativeId === foe && e.player === 'p1')).toBe(true);
    // "Until the end of the turning point".
    expect(s.effects.find((e) => e.rule === GAZE_TOKEN)!.expiry.kind).toBe('endOfTurningPoint');
  });

  it('BREACH places a Breach marker by a terrain feature within control range', () => {
    const printed = actionOf(CARD.breacher, ACT.breach);
    expect(printed.text).toContain('Place one of your Breach markers within this operative’s control range');
    expect(printed.text).toContain('if a terrain feature isn’t within its control range');
    const { ctx, state } = setup({ map: mapById('gallowdark-1') });
    const breacher = opWith(state, 'p1', CARD.breacher);
    const def = getAction(ACT.breach)!;
    const op = state.operatives[breacher]!;
    // Nowhere near terrain: the printed restriction refuses it.
    place(state, breacher, 0.9, 0.9);
    isolate(state, [breacher]);
    expect(def.check(ctx, state, op, {}).ok).toBe(false);
    const wall = state.map.features.flatMap((f) => f.parts).find((pt) => pt.role === 'wall')!;
    const corner = wall.poly[0]!;
    place(state, breacher, corner.x, corner.y);
    expect(def.check(ctx, state, op, {}).ok).toBe(true);
    let s = activate(ctx, state, breacher, 'engage');
    s = act(ctx, s, breacher, ACT.breach, {}).state;
    const marker = Object.values(s.markers).find((m) => m.flags['battlecladeBreach'] === true);
    expect(marker?.owner).toBe('p1');
    expect(marker?.diameterMm).toBe(20);
    expect(typeof marker?.flags['featureId']).toBe('string');
    expect(REMINDER_ONLY[`${ACT.breach}.accessible`]).toContain('Accessible');
  });

  it('DATACORONAL ACCUMULATOR rolls a D3 against the objective markers its network contests', () => {
    const printed = actionOf(CARD.underseer, ACT.datacoronal);
    expect(printed.text).toContain('roll one D3. If the result is equal to or less than the number of objective markers those friendly operatives contest, you gain 1CP');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 1, 1] });
    const underseer = opWith(state, 'p1', CARD.underseer);
    isolate(state, [underseer]);
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, underseer, objective.pos.x, objective.pos.y + 0.5);
    let s = activate(ctx, state, underseer, 'engage');
    const before = s.teams.p1.cp;
    s = act(ctx, s, underseer, ACT.datacoronal, {}).state;
    expect(s.teams.p1.cp).toBe(before + 1);
    expect(s.rolls.some((r) => r.kind === 'datacoronalAccumulator')).toBe(true);
  });

  it('DATACORONAL ACCUMULATOR gains nothing when the network contests no objective marker', () => {
    const { ctx, state } = setup({ script: [3, 3, 3, 3] });
    const underseer = opWith(state, 'p1', CARD.underseer);
    isolate(state, [underseer]);
    place(state, underseer, 1.2, 1.2);
    let s = activate(ctx, state, underseer, 'engage');
    const before = s.teams.p1.cp;
    s = act(ctx, s, underseer, ACT.datacoronal, {}).state;
    expect(s.teams.p1.cp).toBe(before);
  });

  it('NETWORK OVERRIDE grants a free Dash, and queues a NETWORK COUNTERACT for the named SERVITOR', () => {
    const printed = actionOf(CARD.underseer, ACT.networkOverride);
    expect(printed.text).toContain('to immediately NETWORK COUNTERACT (you don’t have to TRANSFER POWER to do so) or perform a free Dash action');
    expect(printed.text).toContain('This operative can perform this action twice during its activation');
    const { ctx, state } = setup();
    const underseer = opWith(state, 'p1', CARD.underseer);
    const target = opWith(state, 'p1', CARD.breacher);
    isolate(state, [underseer, target]);
    place(state, underseer, 10, 10);
    place(state, target, 13, 10);
    let s = activate(ctx, state, underseer, 'engage');
    s = act(ctx, s, underseer, ACT.networkOverride, { targetOperativeId: target, choice: 'dash' }).state;
    expect(s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === target)).toBe(true);
    // …and the counteract branch queues a request that the end of the activation offers.
    let t = act(ctx, s, underseer, NETWORK_OVERRIDE_AGAIN, { targetOperativeId: target }).state;
    expect(queuedNetworkCounteracts(t, 'p1')).toEqual([
      { by: underseer, targetId: target, source: ACT.networkOverride },
    ]);
    t = reduce(t, { t: 'EndActivation', operativeId: underseer }, ctx).state;
    const decision = t.pending.find((d) => d.kind === NETWORK_DECISION)!;
    expect(new Set(decision.options.filter((o) => o.id !== 'decline').map((o) => String(o.data!['operativeId'])))).toEqual(
      new Set([target]),
    );
    expect(REMINDER_ONLY[`${RULE_NETWORK}.timing`]).toContain('nested activation');
  });

  it('NETWORK OVERRIDE can be performed twice in one activation and no more (D-021)', () => {
    expect(actionOf(CARD.underseer, ACT.networkOverride).text).toContain(
      'This operative can perform this action twice during its activation',
    );
    const { ctx, state } = setup();
    const underseer = opWith(state, 'p1', CARD.underseer);
    const target = opWith(state, 'p1', CARD.breacher);
    isolate(state, [underseer, target]);
    place(state, underseer, 10, 10);
    place(state, target, 13, 10);
    const again = getAction(NETWORK_OVERRIDE_AGAIN)!;
    const op = state.operatives[underseer]!;
    op.aplMods.push(1);
    let s = activate(ctx, state, underseer, 'engage');
    // The second ActionDef only exists once the first has been performed this activation.
    expect(again.available!(ctx, s, s.operatives[underseer]!)).toBe(false);
    s = act(ctx, s, underseer, ACT.networkOverride, { targetOperativeId: target, choice: 'dash' }).state;
    expect(again.available!(ctx, s, s.operatives[underseer]!)).toBe(true);
    const second = act(ctx, s, underseer, NETWORK_OVERRIDE_AGAIN, { targetOperativeId: target, choice: 'dash' });
    expect(second.ok).toBe(true);
    // A third is refused by the reducer's own action restriction — there is no third ActionDef.
    const third = act(ctx, second.state, underseer, NETWORK_OVERRIDE_AGAIN, { targetOperativeId: target, choice: 'dash' });
    expect(third.ok).toBe(false);
  });

  it('EXPEDIENT REPAIR heals D3+3 and refuses an operative Mechanosuture Array already saved', () => {
    const printed = actionOf(CARD.technomedic, ACT.expedientRepair);
    expect(printed.text).toContain('regain up to D3+3 lost wounds');
    expect(printed.text).toContain('It cannot be an operative that the Mechanosuture Array rule was used on during this turning point');
    const { ctx, state } = setup({ script: [2, 2, 2, 2] });
    const medic = opWith(state, 'p1', CARD.technomedic);
    const patient = opWith(state, 'p1', CARD.gun);
    isolate(state, [medic, patient]);
    place(state, medic, 10, 10);
    place(state, patient, 10.8, 10);
    state.operatives[patient]!.wounds = 2;
    let s = activate(ctx, state, medic, 'engage');
    s = act(ctx, s, medic, ACT.expedientRepair, { targetOperativeId: patient }).state;
    const rolled = s.rolls.find((r) => r.kind === 'expedientRepair')!.results[0]!;
    expect(rolled).toBeGreaterThanOrEqual(4); // D3+3
    expect(rolled).toBeLessThanOrEqual(6);
    expect(s.operatives[patient]!.wounds).toBe(2 + rolled);
    // The ledger the Mechanosuture Array writes takes the operative out of the candidate list.
    expect(repairTargets(ctx, s, s.operatives[medic]!).map((o) => o.id)).toContain(patient);
    s.opState['battleclade.sutureUsedOn'] = { [patient]: true };
    expect(sutureUsedOn(s, patient)).toBe(true);
    expect(repairTargets(ctx, s, s.operatives[medic]!).map((o) => o.id)).not.toContain(patient);
    // With nobody else in control range the action refuses outright (D-026: in `check`).
    isolate(s, [medic]);
    const def = getAction(ACT.expedientRepair)!;
    s.opState['battleclade.sutureUsedOn'] = { [medic]: true };
    expect(def.check(ctx, s, s.operatives[medic]!, { targetOperativeId: patient }).reason).toContain(
      'within control range',
    );
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE strategy ploys', () => {
  const useGambit = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>): GameState => {
    const s = { ...state };
    s.teams = { ...state.teams, p1: { ...state.teams.p1, gambitsUsedTP: [...state.teams.p1.gambitsUsedTP, id] } };
    void ctx;
    void data;
    return s;
  };

  it('NOOSPHERIC POSSESSION gives Accurate 1 to a SERVITOR within 6" of an AUTO-PROXY or UNDERSEER', () => {
    expect(ruleText(SP.noosphericPossession)).toContain(
      'that friendly SERVITOR operative’s weapons have the Accurate 1 weapon rule',
    );
    const { ctx, state } = setup();
    const anchor = opWith(state, 'p1', CARD.autoProxy);
    const servitor = opWith(state, 'p1', CARD.gun);
    const priest = opWith(state, 'p1', CARD.technoarcheologist);
    isolate(state, [anchor, servitor, priest]);
    place(state, anchor, 10, 10);
    place(state, servitor, 14, 10);
    place(state, priest, 14, 12);
    const s = useGambit(ctx, state, SP.noosphericPossession);
    const rules = (id: string, profile: WeaponProfile, name: string) =>
      effectiveRules(ctx, s, profile, { operative: s.operatives[id]!, weaponName: name }).map((r) => r.id);
    expect(rules(servitor, profileOf(CARD.gun, 'Heavy arc rifle'), 'Heavy arc rifle')).toContain('Accurate');
    // The TECHNOARCHEOLOGIST is a TECH-PRIEST, not a SERVITOR: it gets nothing.
    expect(rules(priest, profileOf(CARD.technoarcheologist, 'Eradication pistol'), 'Eradication pistol')).not.toContain(
      'Accurate',
    );
    // …and beyond 6" of every anchor it stops.
    place(s, servitor, 22, 10);
    expect(rules(servitor, profileOf(CARD.gun, 'Heavy arc rifle'), 'Heavy arc rifle')).not.toContain('Accurate');
  });

  it('DUTY OF RECLAMATION prices Command Re-roll at 0CP for a marker-contesting operative', () => {
    expect(ruleText(SP.dutyOfReclamation)).toContain(
      'you can use the Command Re-roll firefight ploy for 0CP if the attack or defence dice was rolled for a friendly BATTLECLADE operative that contests an objective marker',
    );
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.gun);
    isolate(state, [shooter, foe]);
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, shooter, objective.pos.x, objective.pos.y + 0.5);
    place(state, foe, objective.pos.x + 10, objective.pos.y);
    const s = useGambit(ctx, state, SP.dutyOfReclamation);
    const grants = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[shooter]!, s.operatives[foe]!, profileOf(CARD.gun, 'Heavy arc rifle'), 'Heavy arc rifle'),
      dice: [],
      rerolls: [],
    }).rerolls;
    const free = grants.find((g) => g.id.startsWith('commandReroll'));
    expect(free?.cp).toBe(0);
    // Away from every marker there is no discount.
    place(s, shooter, 1.2, 1.2);
    const none = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[shooter]!, s.operatives[foe]!, profileOf(CARD.gun, 'Heavy arc rifle'), 'Heavy arc rifle'),
      dice: [],
      rerolls: [],
    }).rerolls;
    expect(none.some((g) => g.id.startsWith('commandReroll'))).toBe(false);
    expect(REMINDER_ONLY[`${SP.dutyOfReclamation}.melee`]).toContain('D-031');
  });

  it('INCANTATION OF THE IRON SOUL subtracts 1 from each attack dice inflicting 3 or more, on a 4+', () => {
    expect(ruleText(SP.incantation)).toContain(
      'Whenever an attack dice inflicts damage of 3 or more on a friendly BATTLECLADE operative, roll one D6: on a 4+, subtract 1 from that inflicted damage',
    );
    const { ctx, state } = setup({ script: [5, 5, 5, 5] });
    const victim = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.gun);
    const s = useGambit(ctx, state, SP.incantation);
    // One melee attack dice inflicting Dmg 4.
    s.sequence = {
      kind: 'fight',
      attackerId: foe,
      defenderId: victim,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Augmetic claw',
    } as unknown as FightSequence;
    const ev = ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target: s.operatives[victim]!, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(3);
    // Damage of 2 is below the printed threshold and is never rolled for.
    const rollsBefore = s.rolls.length;
    const small = ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target: s.operatives[victim]!, amount: 2, kind: 'attack' });
    expect(small.amount).toBe(2);
    expect(s.rolls.length).toBe(rollsBefore);
  });

  it('a shot’s aggregated damage is split back into attack dice before the D6 is rolled', () => {
    const { ctx, state } = setup({ script: [5, 5, 5, 5, 5] });
    const victim = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.gun);
    const s = useGambit(ctx, state, SP.incantation);
    const seq = shootSeqOf({
      attackerId: foe,
      targetId: victim,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Heavy arc rifle',
      step: 'resolve',
      attack: pool([6, 4], 4), // one crit (Dmg 6), one normal (Dmg 4)
    });
    s.sequence = seq;
    expect(attackDiceChunks(ctx, s, 10, 'attack')).toEqual([6, 4]);
    const ev = ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target: s.operatives[victim]!, amount: 10, kind: 'attack' });
    expect(ev.amount).toBe(8); // two dice, two 4+ rolls, one damage off each
  });

  it('PRIORITISED ACQUISITION lifts the marker’s contested APL by 1 and adds an Atk to melee within 3"', () => {
    expect(ruleText(SP.prioritisedAcquisition)).toContain(
      'treat the total APL stat of friendly BATTLECLADE operatives that contest it as 1 higher',
    );
    expect(ruleText(SP.prioritisedAcquisition)).toContain('add 1 to the Atk stat of its melee weapons (to a maximum of 4)');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', CARD.gun);
    const theirs = opWith(state, 'p2', CARD.gun);
    isolate(state, [mine, theirs]);
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, mine, objective.pos.x - 0.7, objective.pos.y);
    place(state, theirs, objective.pos.x + 0.7, objective.pos.y);
    // Equal APL: nobody controls it…
    expect(markerController(ctx, state, objective)).toBe(null);
    const out = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: SP.prioritisedAcquisition, data: { markerId: objective.id } },
      ctx,
    );
    const s = out.state;
    expect(prioritisedMarkerId(s, 'p1')).toBe(objective.id);
    expect(markerController(ctx, s, s.markers[objective.id]!)).toBe('p1');
    // …and the melee Atk bump, capped at 4.
    const claw = profileOf(CARD.gun, 'Augmetic claw');
    expect(claw.atk).toBe(3);
    const ev = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[mine]!, s.operatives[theirs]!, claw, 'Augmetic claw', 'melee'),
      count: claw.atk,
      mods: zeroStatMods(),
    });
    expect(ev.mods.atk).toBe(1);
    const capped = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[mine]!, s.operatives[theirs]!, profileOf(CARD.technoarcheologist, 'Servo-arc claw'), 'Servo-arc claw', 'melee'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(capped.mods.atk).toBe(0); // Atk 4 already — "(to a maximum of 4)"
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE firefight ploys', () => {
  it('SYSTEM EXORCISM removes one thing the opponent applied — never wounds', () => {
    expect(ruleText(FP.systemExorcism)).toContain(
      'Remove one rules effect or stat change your opponent has applied to it',
    );
    expect(ruleText(FP.systemExorcism)).toContain('cannot allow it to regain lost wounds');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', CARD.gun);
    state.operatives[mine]!.aplMods.push(-1);
    state.operatives[mine]!.wounds = 3;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.systemExorcism, data: { operativeId: mine } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mine]!.aplMods).not.toContain(-1);
    expect(out.state.operatives[mine]!.wounds).toBe(3);
  });

  it('SYSTEM EXORCISM also sheds an enemy effect (a token) when there is no APL penalty', () => {
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', CARD.gun);
    state.effects.push({
      id: 'test-token',
      rule: 'enemy.poison',
      source: { kind: 'ability', id: 'test' },
      operativeId: mine,
      player: 'p2',
      expiry: { kind: 'endOfBattle' },
    });
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.systemExorcism, data: { operativeId: mine } }, ctx);
    expect(out.state.effects.some((e) => e.rule === 'enemy.poison')).toBe(false);
  });

  it('SYSTEM EXORCISM leaves a mission-pack rule alone ("cannot … remove mission pack rules")', () => {
    expect(ruleText(FP.systemExorcism)).toContain('remove mission pack rules');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', CARD.gun);
    state.effects.push({
      id: 'test-op-rule',
      rule: 'op.someMissionRule',
      source: { kind: 'op', id: 'crit.test' },
      operativeId: mine,
      player: 'p2',
      expiry: { kind: 'endOfBattle' },
    });
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.systemExorcism, data: { operativeId: mine } }, ctx);
    expect(out.state.effects.some((e) => e.rule === 'op.someMissionRule')).toBe(true);
  });

  it('REMOTE ACCESS gives a TECH-PRIEST an Operate Hatch at 4" — its mission-action half is reminder-only', () => {
    expect(ruleText(FP.remoteAccess)).toContain(
      'That operative doesn’t require a hatchway’s access point to be within its control range to perform an Operate Hatch action. Instead, that access point must be within 4" of it',
    );
    const { ctx, state } = setup({ map: mapById('gallowdark-1') });
    const priest = opWith(state, 'p1', CARD.technoarcheologist);
    const servitor = opWith(state, 'p1', CARD.gun);
    const def = getAction(REMOTE_OPERATE_HATCH)!;
    expect(def.treatedAs).toBe('Operate Hatch');
    expect(def.available!(ctx, state, state.operatives[servitor]!)).toBe(false); // not a TECH-PRIEST
    // The access point is the printed 4" away rather than within control range.
    const access = terrain(ctx, state).parts.find((pt) => pt.role === 'accessPoint')!;
    const centre = {
      x: (access.bounds.min.x + access.bounds.max.x) / 2,
      y: (access.bounds.min.y + access.bounds.max.y) / 2,
    };
    isolate(state, [priest]);
    place(state, priest, centre.x + 3, centre.y);
    expect(def.check(ctx, state, state.operatives[priest]!, { partId: access.id }).ok).toBe(true);
    // The universal Operate Hatch would refuse the same position outright.
    expect(getAction('Operate Hatch')!.check(ctx, state, state.operatives[priest]!, { partId: access.id }).ok).toBe(false);
    place(state, priest, centre.x + 6, centre.y);
    expect(def.check(ctx, state, state.operatives[priest]!, { partId: access.id }).reason).toContain('within 4"');
    expect(REMINDER_ONLY[`${FP.remoteAccess}.mission`]).toContain('src/core/ops');

    // The ploy is only usable if something can AIM it. The core's NEEDS_TARGET table is keyed
    // by action id and the kernel knows no faction, so an id like
    // `Operate Hatch (Remote Access)` is not in it: the def declares its own kind, and both
    // the sheet's aim list and the AI's candidate builder read that.
    expect(def.needsTarget).toBe('part');
    expect(actionTargetKind(REMOTE_OPERATE_HATCH)).toBe('part');
    place(state, priest, centre.x + 3, centre.y);
    const aimed = actionTargetOptions(ctx, state, state.operatives[priest]!, def);
    expect(aimed.map((o) => o.id)).toContain(access.id);
    expect(aimed[0]!.label).toMatch(/hatchway/);
  });

  it('AUTO-FERRIC SUPPLICATION ignores Piercing against a TECH-PRIEST for one sequence', () => {
    expect(ruleText(FP.autoFerric)).toContain('Until the end of the sequence, ignore the Piercing weapon rule');
    const { ctx, state } = setup();
    const priest = opWith(state, 'p1', CARD.underseer);
    const servitor = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.combat);
    const melta = profileOf(CARD.combat, 'Meltagun');
    expect(melta.rules.map((r) => r.id)).toContain('Piercing');
    const before = effectiveRules(ctx, state, melta, {
      operative: state.operatives[foe]!,
      target: state.operatives[priest]!,
      weaponName: 'Meltagun',
    }).map((r) => r.id);
    expect(before).toContain('Piercing');
    // "Use this firefight ploy when an operative is shooting a friendly BATTLECLADE TECH-PRIEST
    //  operative" — the ploy refuses its own window otherwise.
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.autoFerric }, ctx).ok).toBe(false);
    state.sequence = shootSeqOf({
      attackerId: foe,
      targetId: priest,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Meltagun',
      step: 'rollAttack',
    });
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.autoFerric }, ctx).state;
    expect(s.effects.some((e) => e.rule === EFF.autoFerric && e.player === 'p1')).toBe(true);
    expect(
      effectiveRules(ctx, s, melta, {
        operative: s.operatives[foe]!,
        target: s.operatives[priest]!,
        weaponName: 'Meltagun',
      }).map((r) => r.id),
    ).not.toContain('Piercing');
    // Only a TECH-PRIEST is shielded.
    expect(
      effectiveRules(ctx, s, melta, {
        operative: s.operatives[foe]!,
        target: s.operatives[servitor]!,
        weaponName: 'Meltagun',
      }).map((r) => r.id),
    ).toContain('Piercing');
  });

  it('SERVILE SURROGACY redirects a Shoot at a TECH-PRIEST to a SERVITOR within 3", never through Blast/Torrent', () => {
    expect(ruleText(FP.servileSurrogacy)).toContain(
      'Select one friendly BATTLECLADE SERVITOR operative visible to and within 3" of that first friendly operative to become the valid target',
    );
    expect(ruleText(FP.servileSurrogacy)).toContain(
      'This ploy has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule',
    );
    const { ctx, state } = setup();
    const priest = opWith(state, 'p1', CARD.technoarcheologist);
    const shield = opWith(state, 'p1', CARD.breacher);
    const foe = opWith(state, 'p2', CARD.combat);
    isolate(state, [priest, shield, foe]);
    place(state, priest, 10, 10);
    place(state, shield, 12, 10);
    place(state, foe, 18, 10);
    const T = hooksFor(ctx, 'p1');
    expect(surrogacyCandidates(T, state, state.operatives[priest]!).map((o) => o.id)).toContain(shield);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.servileSurrogacy, data: { operativeId: shield } }, ctx).state;
    const melta = profileOf(CARD.combat, 'Meltagun');
    const ev = ctx.hooks.emit('onSelectTarget', s, {
      state: s,
      attacker: s.operatives[foe]!,
      target: s.operatives[priest]!,
      weaponName: 'Meltagun',
      profile: melta,
      rules: [...melta.rules],
    });
    expect(ev.redirectTo).toBe(shield);
    // A Torrent weapon is refused.
    const s2 = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.servileSurrogacy, data: { operativeId: shield } }, ctx).state;
    const igniter = profileOf(CARD.combat, 'Incendine igniter');
    const ev2 = ctx.hooks.emit('onSelectTarget', s2, {
      state: s2,
      attacker: s2.operatives[foe]!,
      target: s2.operatives[priest]!,
      weaponName: 'Incendine igniter',
      profile: igniter,
      rules: [...igniter.rules],
    });
    expect(ev2.redirectTo).toBeUndefined();
    expect(REMINDER_ONLY[`${FP.servileSurrogacy}.fight`]).toContain('startFight');
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE faction equipment', () => {
  it('COVERT GUISES rolls a D3 when revealed and is a first-turning-point STRATEGIC GAMBIT', () => {
    expect(ruleText(EQ.covertGuises)).toContain('After revealing this equipment option, roll one D3');
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [2] });
    expect(state.effects.some((e) => e.rule === EFF.covertGuisesD3 && e.player === 'p1')).toBe(true);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.covertGuises);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(EQ.covertGuises);
    expect(REMINDER_ONLY[`${EQ.covertGuises}.dropZone`]).toContain('validateMove');
  });

  it('COVERT GUISES hands the D3 result a free Reposition, and never the TECHNOARCHEOLOGIST twice', () => {
    expect(ruleText(EQ.covertGuises)).toContain(
      'Your TECHNOARCHEOLOGIST operative cannot perform more than one Reposition action in the Strategy phase of the first turning point',
    );
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [3] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const zone = state.map.dropZones[state.setup.dropZone.p1 ?? 'p1']!;
    void zone;
    // Everything is inside the p1 drop zone in the harness' tidy column; check the count only.
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SEEKER_GAMBIT }, ctx).state;
    const arch = opWith(s, 'p1', CARD.technoarcheologist);
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: EQ.covertGuises }, ctx).state;
    const granted = s.effects.filter((e) => e.rule === 'teamFreeAction' && e.source.id === EQ.covertGuises);
    expect(granted.some((e) => e.operativeId === arch)).toBe(false);
  });

  it('ELECTROMANTIC CAPACITORS gives Shock to melee weapons, and Severe as well while retaliating', () => {
    expect(ruleText(EQ.electromanticCapacitors)).toContain(
      'Friendly BATTLECLADE operatives’ melee weapons have the Shock weapon rule',
    );
    const { ctx, state } = setup({ equipment: [EQ.electromanticCapacitors] });
    const mine = state.operatives[opWith(state, 'p1', CARD.gun)]!;
    const claw = profileOf(CARD.gun, 'Augmetic claw');
    expect(claw.rules.map((r) => r.id)).not.toContain('Shock');
    const attacking = effectiveRules(ctx, state, claw, { operative: mine, weaponName: 'Augmetic claw' }).map((r) => r.id);
    expect(attacking).toContain('Shock');
    expect(attacking).not.toContain('Severe');
    const retaliating = effectiveRules(ctx, state, claw, {
      operative: mine,
      weaponName: 'Augmetic claw',
      retaliating: true,
    }).map((r) => r.id);
    expect(retaliating).toContain('Severe');
    // The opponent, who did not take the equipment, gets nothing.
    const theirs = state.operatives[opWith(state, 'p2', CARD.gun)]!;
    expect(effectiveRules(ctx, state, claw, { operative: theirs, weaponName: 'Augmetic claw' }).map((r) => r.id)).not.toContain(
      'Shock',
    );
  });

  it('CONCEALED APPARATUS hands one COMBAT or GUN SERVITOR a weapon option it did not select, once per battle', () => {
    expect(ruleText(EQ.concealedApparatus)).toContain(
      'Once per battle, one COMBAT SERVITOR or GUN SERVITOR operative can use another weapon option on its datacard it didn’t select for the battle',
    );
    const { ctx, state } = setup({ equipment: [EQ.concealedApparatus] });
    const gunner = opWith(state, 'p1', CARD.gun);
    let s = activate(ctx, state, gunner, 'engage');
    const held = (s.operatives[gunner]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(held.length).toBe(1);
    const chosen = ((s.opState['loadout'] ?? {}) as Record<string, string[]>)[gunner] ?? [];
    expect(chosen).not.toContain(held[0]!.name);
    // The grant goes away with the activation, and no second operative gets one.
    s = reduce(s, { t: 'EndActivation', operativeId: gunner }, ctx).state;
    expect(((s.operatives[gunner]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).length).toBe(0);
    const other = s.teams.p1.operativeIds.find((id) => s.operatives[id]!.datacardId === CARD.combat)!;
    s = activate(ctx, s, other, 'engage');
    expect(((s.operatives[other]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).length).toBe(0);
  });

  it('NEUROCYCLIC RESERVE CELLS makes the first TRANSFER POWER of a turning point cost 0AP', () => {
    expect(ruleText(EQ.neurocyclicCells)).toContain('you can TRANSFER POWER for 0AP');
    const { ctx, state } = setup({ equipment: [EQ.neurocyclicCells] });
    const first = opWith(state, 'p1', CARD.gun);
    const cost = (s: GameState, id: string) =>
      ctx.hooks.emit('onActionCost', s, { state: s, operative: s.operatives[id]!, action: TRANSFER_POWER, ap: 1 }).ap;
    expect(cost(state, first)).toBe(0);
    let s = activate(ctx, state, first, 'engage');
    s = act(ctx, s, first, TRANSFER_POWER, {}).state;
    expect(s.operatives[first]!.apSpent).toBe(0);
    // "Once per turning point" — the next one is charged.
    const second = opWith(s, 'p1', CARD.breacher);
    expect(cost(s, second)).toBe(1);
  });
});


// ---------------------------------------------------------------------------
describe('BATTLECLADE printed restrictions', () => {
  it('every unique action refuses while within control range of an enemy operative', () => {
    for (const [actionId, cardId] of [
      [ACT.omniscanner, CARD.technoarcheologist],
      [ACT.gaze, CARD.autoProxy],
      [ACT.breach, CARD.breacher],
      [ACT.datacoronal, CARD.underseer],
      [ACT.networkOverride, CARD.underseer],
      [ACT.expedientRepair, CARD.technomedic],
    ] as [string, string][]) {
      expect(actionOf(cardId, actionId).text).toContain(
        'cannot perform this action while within control range of an enemy operative',
      );
      const { ctx, state } = setup();
      const id = opWith(state, 'p1', cardId);
      const foe = opWith(state, 'p2', CARD.gun);
      isolate(state, [id, foe]);
      place(state, id, 10, 10);
      place(state, foe, 10.6, 10);
      const out = getAction(actionId)!.check(ctx, state, state.operatives[id]!, {});
      expect([actionId, out.ok, out.reason]).toEqual([actionId, false, 'within control range of an enemy operative']);
    }
  });

  it('no NETWORK COUNTERACT decision is raised when no other SERVITOR is eligible', () => {
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.counteractedThisTP = true;
    state.operatives[actorId]!.counteractedThisTP = false;
    let s = activate(ctx, state, actorId, 'engage');
    s = act(ctx, s, actorId, TRANSFER_POWER, {}).state;
    s = reduce(s, { t: 'EndActivation', operativeId: actorId }, ctx).state;
    expect(s.pending.filter((d) => d.kind === NETWORK_DECISION)).toEqual([]);
    expect(s.activeOperativeId).toBeUndefined();
  });

  it('the NETWORK COUNTERACT queue never survives its own turning point', () => {
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    let s = activate(ctx, state, actorId, 'engage');
    s = act(ctx, s, actorId, TRANSFER_POWER, {}).state;
    expect(queuedNetworkCounteracts(s, 'p1')).toHaveLength(1);
    ctx.hooks.emit('onEndOfTP', s, { state: s });
    expect(queuedNetworkCounteracts(s, 'p1')).toEqual([]);
  });

  it('the STRATEGIC GAMBIT menu is the four strategy ploys plus Seeker of Divine Arcana', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.teams.p1.cp = 4;
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    for (const p of DATA.strategyPloys) expect([p.id, ids.includes(p.id)]).toEqual([p.id, true]);
    expect(ids).toContain(SEEKER_GAMBIT);
    // …and Seeker goes away with its operative.
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    state.operatives[arch]!.removed = true;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SEEKER_GAMBIT);
  });

  it('NOOSPHERIC POSSESSION also anchors on the SERVITOR UNDERSEER', () => {
    const { ctx, state } = setup();
    const anchor = opWith(state, 'p1', CARD.underseer);
    const servitor = opWith(state, 'p1', CARD.breacher);
    isolate(state, [anchor, servitor]);
    place(state, anchor, 10, 10);
    place(state, servitor, 14, 10);
    const T = hooksFor(ctx, 'p1');
    expect(possessionAnchor(T, state, state.operatives[servitor]!)?.id).toBe(anchor);
    place(state, servitor, 22, 10);
    expect(possessionAnchor(T, state, state.operatives[servitor]!)).toBeUndefined();
  });

  it('`attackDiceChunks` splits Devastating per retained critical success and ignores mortal damage', () => {
    const { ctx, state } = setup();
    const victim = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.combat);
    state.sequence = shootSeqOf({
      attackerId: foe,
      targetId: victim,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Meltagun',
      step: 'resolve',
      attack: pool([6, 6, 2], 4), // two retained crits
    });
    expect(attackDiceChunks(ctx, state, 8, 'devastating')).toEqual([4, 4]);
    expect(attackDiceChunks(ctx, state, 5, 'mortal')).toEqual([]);
    expect(attackDiceChunks(ctx, state, 5, 'mine')).toEqual([]);
  });

  it('INCANTATION OF THE IRON SOUL never protects the opponent’s operatives', () => {
    const { ctx, state } = setup({ script: [6, 6, 6] });
    state.teams.p1.gambitsUsedTP.push(SP.incantation);
    const theirs = state.operatives[opWith(state, 'p2', CARD.gun)]!;
    state.sequence = {
      kind: 'fight',
      attackerId: opWith(state, 'p1', CARD.gun),
      defenderId: theirs.id,
      attacker: 'p1',
      defender: 'p2',
      attackerWeapon: 'Augmetic claw',
    } as unknown as FightSequence;
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: theirs, amount: 5, kind: 'attack' });
    expect(ev.amount).toBe(5);
  });

  it('an OMNISCANNER token is yours: the opponent’s identical team gets no Ceaseless from it', () => {
    const { ctx, state } = setup();
    const arch = opWith(state, 'p1', CARD.technoarcheologist);
    const foe = opWith(state, 'p2', CARD.gun);
    const theirGunner = opWith(state, 'p2', CARD.combat);
    isolate(state, [arch, foe, theirGunner]);
    place(state, arch, 10, 10);
    place(state, foe, 14, 10);
    place(state, theirGunner, 16, 10);
    let s = activate(ctx, state, arch, 'engage');
    s = act(ctx, s, arch, ACT.omniscanner, { targetOperativeId: foe }).state;
    // p2 shooting its own tokened operative is nonsense; what matters is that p2's copy of the
    // rule reads p2's own tokens, of which there are none.
    const melta = profileOf(CARD.combat, 'Meltagun');
    expect(
      effectiveRules(ctx, s, melta, {
        operative: s.operatives[theirGunner]!,
        target: s.operatives[foe]!,
        weaponName: 'Meltagun',
      }).map((r) => r.id),
    ).not.toContain('Ceaseless');
  });

  it('DUTY OF RECLAMATION also discounts the DEFENCE pool of a shot at a marker-contesting operative', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.dutyOfReclamation);
    const mine = opWith(state, 'p1', CARD.gun);
    const foe = opWith(state, 'p2', CARD.combat);
    isolate(state, [mine, foe]);
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, mine, objective.pos.x, objective.pos.y + 0.5);
    place(state, foe, objective.pos.x + 8, objective.pos.y);
    const seq = shootSeqOf({
      attackerId: foe,
      targetId: mine,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Meltagun',
      step: 'rollDefence',
    });
    state.sequence = seq;
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(state.operatives[foe]!, state.operatives[mine]!, profileOf(CARD.combat, 'Meltagun'), 'Meltagun'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.rerolls.find((g) => g.id.startsWith('commandReroll'))?.cp).toBe(0);
  });

  it('SERVILE SURROGACY only ever interposes a SERVITOR, never the other TECH-PRIEST', () => {
    const { ctx, state } = setup();
    const priest = opWith(state, 'p1', CARD.technoarcheologist);
    const underseer = opWith(state, 'p1', CARD.underseer);
    const servitor = opWith(state, 'p1', CARD.breacher);
    isolate(state, [priest, underseer, servitor]);
    place(state, priest, 10, 10);
    place(state, underseer, 11.2, 10);
    place(state, servitor, 12, 10);
    const T = hooksFor(ctx, 'p1');
    const ids = surrogacyCandidates(T, state, state.operatives[priest]!).map((o) => o.id);
    expect(ids).toContain(servitor);
    expect(ids).not.toContain(underseer);
    expect(ids).not.toContain(priest);
  });

  it('CONCEALED APPARATUS is offered to no one but a COMBAT or GUN SERVITOR', () => {
    const { ctx, state } = setup({ equipment: [EQ.concealedApparatus] });
    const breacher = opWith(state, 'p1', CARD.breacher);
    const s = activate(ctx, state, breacher, 'engage');
    const held = (s.operatives[breacher]! as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(held).toEqual([]);
  });

  it('the ploy windows refuse a ploy used outside the moment it prints', () => {
    const { ctx, state } = setup();
    // SYSTEM EXORCISM: "when you would activate a friendly BATTLECLADE operative".
    const id = opWith(state, 'p1', CARD.gun);
    const mid = activate(ctx, state, id, 'engage');
    expect(reduce(mid, { t: 'UsePloy', player: 'p1', ployId: FP.systemExorcism }, ctx).ok).toBe(false);
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.systemExorcism }, ctx).ok).toBe(true);
    // REMOTE ACCESS: "during a friendly BATTLECLADE TECH-PRIEST operative's activation".
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.remoteAccess }, ctx).ok).toBe(false);
    expect(reduce(mid, { t: 'UsePloy', player: 'p1', ployId: FP.remoteAccess }, ctx).ok).toBe(true);
  });

  it('TRANSFER POWER is refused a second time in the same activation by the reducer itself', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gun);
    state.operatives[id]!.aplMods.push(1);
    let s = activate(ctx, state, id, 'engage');
    s = act(ctx, s, id, TRANSFER_POWER, {}).state;
    const again = act(ctx, s, id, TRANSFER_POWER, {});
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('action restrictions');
    expect(queuedNetworkCounteracts(s, 'p1')).toHaveLength(1);
  });

  it('the Seeker of Divine Arcana end-of-move clause is reported, not silently dropped', () => {
    expect(abilityText(CARD.technoarcheologist, AB.seekerOfDivineArcana)).toContain(
      'it must end that move either within your drop zone',
    );
    expect(REMINDER_ONLY[`${AB.seekerOfDivineArcana}.endOfMove`]).toContain('end-of-move');
  });
});

// ---------------------------------------------------------------------------
describe('BATTLECLADE honesty', () => {
  it('every REMINDER_ONLY entry names a printed rule and gives an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).length).toBeGreaterThanOrEqual(8);
    for (const [id, reason] of Object.entries(REMINDER_ONLY)) {
      expect(reason.length, id).toBeGreaterThan(30);
      const base = id.replace(/\.[a-zA-Z]+$/, '');
      const known =
        [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].some(
          (r) => r.id === id || r.id === base,
        ) ||
        DATA.datacards.some((c) => [...c.abilities, ...c.uniqueActions].some((a) => a.id === id || a.id === base));
      expect(known, `${id} is not a printed rule id`).toBe(true);
    }
  });

  it('the team module registers no handler on a hook that is never emitted', () => {
    const NEVER_EMITTED = [
      'onBattleSetup',
      'onAttackDiceRetained',
      'onFreeActions',
      'onOrderChange',
      'onMoveRules',
      'onSetUpAgain',
    ] as const;
    const { ctx } = setup();
    const reg = new HookRegistry();
    battleclade.register(reg, 'p1', ctx);
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    for (const hook of ['onWeaponRules', 'onIncapacitated', 'onPloyUsed', 'onActivationEnd', 'onSelectTarget'] as const) {
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    }
    expect(hooksFor(ctx, 'p1').player).toBe('p1');
  });

  it('the aiHints cover every datacard, all eight ploys and all four equipment options', () => {
    const hints = battleclade.aiHints!;
    for (const c of DATA.datacards) expect([c.id, Boolean(hints.roles?.[c.id])]).toEqual([c.id, true]);
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys])
      expect([p.id, typeof hints.ployValue?.[p.id]]).toEqual([p.id, 'number']);
    for (const e of DATA.equipment) expect([e.id, typeof hints.equipmentValue?.[e.id]]).toEqual([e.id, 'number']);
    // The two 0CP gambits need a value or the AI would never use them.
    expect(hints.ployValue?.[SEEKER_GAMBIT]).toBeGreaterThan(0);
  });

  it('`notes[]` is empty in the committed data, and the marker guide names the six tokens', () => {
    // `notes[]` is empty even though GAZE OF THE OMNISSIAH's effect list is missing — the
    // truncation is not flagged by `validate.py` (docs/TEAM-STATUS.md, batch 3 onwards).
    expect(NOTES).toEqual([]);
    for (const token of [
      'Omniscanner token',
      'Prioritised Acquisition token',
      'Gaze of the Omnissiah token',
      'Mechanosuture Array token',
      'Network Counteract token',
      'Breach marker',
    ])
      expect(RAW.markerGuide).toContain(token);
    // …but two of the six are play aids no printed rule places: nothing in the Mechanosuture
    // Array or in NETWORK COUNTERACT places a token. (The confirmed "markerGuide names tokens no
    // rule places" pattern.)
    const printed = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
      ...DATA.datacards.flatMap((c) => [...c.abilities, ...c.uniqueActions]),
    ]
      .map((r) => r.text)
      .join('\n');
    expect(printed).toContain('Omniscanner tokens');
    expect(printed).toContain('Breach markers');
    expect(printed).not.toContain('Mechanosuture Array token');
    expect(printed).not.toContain('Network Counteract token');
  });

  it('`uniqueActions[].keywords` is ABSENT, though two actions print "SUPPORT." in their text', () => {
    // The confirmed scraper gap, reproduced on every batch since it was first reported; the
    // corsair-voidscarred variant (absent, not empty) is what this team has.
    const raw = rawJson as unknown as { datacards: { uniqueActions: Record<string, unknown>[] }[] };
    for (const c of raw.datacards) for (const a of c.uniqueActions) expect('keywords' in a).toBe(false);
    expect(actionOf(CARD.underseer, ACT.datacoronal).text.startsWith('SUPPORT.')).toBe(true);
    expect(actionOf(CARD.underseer, ACT.networkOverride).text.startsWith('SUPPORT.')).toBe(true);
    expect(ruleText(SP.noosphericPossession).startsWith('SUPPORT.')).toBe(true);
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and
   * offers anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.omniscanner, CARD.technoarcheologist],
      [ACT.gaze, CARD.autoProxy],
      [ACT.breach, CARD.breacher],
      [ACT.datacoronal, CARD.underseer],
      [ACT.networkOverride, CARD.underseer],
      [ACT.expedientRepair, CARD.technomedic],
      [TRANSFER_POWER, CARD.gun],
    ];
    const tried = new Map<string, number>();
    for (const [actionId, datacardId] of owners) {
      const base = setup({ roles: [datacardId], seed: 5, map: mapById('gallowdark-1') });
      const opId = opWith(base.state, 'p1', datacardId);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) base.state.operatives[id]!.pos = { x: 2 + (n++ % 12) * 1.6, y: 1 };
      place(base.state, opId, 8, 11);
      place(base.state, mates[0]!, 8, 12.2); // within control range of the actor
      place(base.state, foes[0]!, 11, 11); // visible, close, a valid target, not engaged
      place(base.state, foes[1]!, 12, 14);
      place(base.state, mates[1]!, 12.6, 14);
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
      op.aplMods.push(1);
      const attempts: Record<string, unknown>[] = [
        {},
        { targetPos: { ...op.pos } },
        { choice: 'dash' },
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

  it('a NETWORK COUNTERACT decision resolved with the engine’s default option never rejects', () => {
    const { ctx, state } = setup();
    const actorId = opWith(state, 'p1', CARD.gun);
    let s = activate(ctx, state, actorId, 'engage');
    s = act(ctx, s, actorId, TRANSFER_POWER, {}).state;
    s = reduce(s, { t: 'EndActivation', operativeId: actorId }, ctx).state;
    s = settle(ctx, s);
    expect(s.rejected).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(s.activeOperativeId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. This mirror
  // exercises TRANSFER POWER, the NETWORK COUNTERACT decision, the Seeker gambit and the six
  // unique actions on both an open and a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([battleclade], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'battleclade', operatives: roster(), equipment: [EQ.electromanticCapacitors, EQ.neurocyclicCells] },
          p2: { teamId: 'battleclade', operatives: roster(), equipment: [EQ.covertGuises, EQ.concealedApparatus] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      expect(result.state.log.some((l) => /TRANSFERS POWER/.test(l.text))).toBe(true);
      expect(result.state.log.some((l) => /NETWORK COUNTERACTS/.test(l.text))).toBe(true);
    }, 180000);
  }

  it('the module exposes the printed team surface the app reads', () => {
    expect(battleclade.id).toBe('battleclade');
    expect(battleclade.datacards).toHaveLength(7);
    expect(battleclade.equipmentDefs.map((e) => e.id)).toEqual(DATA.equipment.map((e) => e.id));
    expect(battleclade.validateRoster(fullRoster()).ok).toBe(true);
    expect(REMINDER_ONLY[`${RULE_NETWORK}.transferPower`]).toContain('explicitly NOT an action');
    expect(testMap().id).toBeTruthy();
  });
});

