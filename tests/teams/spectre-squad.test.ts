/**
 * SPECTRE SQUAD (Astra Militarum). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/spectre-squad/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { counteractCandidates } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { checkTarget, effectiveRules } from '../../src/core/sequences/shoot.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, inflictDamage, markerController } from '../../src/core/state.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import {
  ACT,
  ADVANCED_CAMOUFLAGE_ACTION,
  C,
  EQ,
  FIELDCRAFT_SHOOT,
  FP,
  KW,
  MELTA_MARKER,
  MINE_PICK_UP,
  MINE_PLACE,
  RULE,
  SILENT_CHARGE,
  SNIPER_OVERWATCH_WEAPON,
  SP,
  STARSHELL_STUN,
  fieldcraftPoints,
  isValidTargetForEnemies,
  spectreSquad,
} from '../../src/teams/spectre-squad/index.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { activate, battle, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('spectre-squad');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  picks?: string[];
  equipment?: string[];
  map?: ReturnType<typeof testMap>;
  script?: number[];
  seed?: number;
  cp?: number;
}

function setup(opts: SetupOpts = {}): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([spectreSquad, kasrkin], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.picks ? opts.picks.map((datacardId) => ({ datacardId })) : defaultRoster(spectreSquad.data);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: spectreSquad, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: kasrkin },
  });
  state.teams.p1.cp = opts.cp ?? 6;
  state.teams.p2.cp = opts.cp ?? 6;
  return { ctx, state };
}

/** Park a player's operatives out of the way, keeping the named ones where they are. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    state.operatives[id]!.pos = { x: player === 'p1' ? 0.6 : 29.4, y: 0.6 + i * 1.6 };
  });
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

/** A shoot sequence parked mid-flight, so a rule that reads `state.sequence` can be pinned. */
function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  opts: { obscured?: boolean; inCover?: boolean; vantageImprovedCover?: boolean; profileName?: string } = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'done',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: opts.inCover ?? false,
    obscured: opts.obscured ?? false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: opts.vantageImprovedCover ?? false,
    attack: { dice: [], nextId: 1 },
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

function fakeFight(
  state: GameState,
  attackerId: string,
  defenderId: string,
  attackerWeapon: string,
  opts: { attackerDice?: { value: number; state: 'crit' | 'normal' }[] } = {},
): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    defenderCanRetaliate: true,
    attackerPool: {
      dice: (opts.attackerDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.attackerDice ?? []).length + 1,
    },
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

const ready = (ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId): void => {
  ctx.hooks.emit('onReadyStep', state, { state, player, cp: 1 });
};

// ---------------------------------------------------------------------------
describe('SPECTRE SQUAD data (pinned against data/teams/spectre-squad.json)', () => {
  it('has 12 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(12);
    const sergeant = DATA.datacards.find((c) => c.id === C.sergeant)!;
    expect(sergeant).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 9, base: { shape: 'round', mm: 28 } });
    expect(sergeant.keywords).toEqual(['SPECTRE SQUAD', 'IMPERIUM', 'ASTRA MILITARUM', 'LEADER', 'VETERAN SERGEANT']);
    for (const card of DATA.datacards.filter((c) => c.id !== C.sergeant && c.id !== C.beacon)) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8, base: { shape: 'round', mm: 28 } });
      expect(card.keywords[0]).toBe(KW);
    }
  });

  it('the VOX-RELAY BEACON is the one operative in the game with a Move stat of 0"', () => {
    const beacon = DATA.datacards.find((c) => c.id === C.beacon)!;
    expect(beacon).toMatchObject({ apl: 1, move: 0, save: 5, wounds: 3, base: { shape: 'round', mm: 25 } });
    expect(beacon.weapons).toEqual([]);
    // It never moves: "This operative cannot perform any actions other than Signal."
    expect(ability(C.beacon, `${C.beacon}.expendable`)).toContain('cannot perform any actions other than Signal');
  });

  it('pins every weapon profile of the SHARPSHOOTER, STUB-GUNNER, GUNNER and HEAVY GUNNER', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat(C.sharpshooter)).toEqual([
      'Long-las|concealed|ranged|4|2|3|3',
      'Long-las|mobile|ranged|4|3|3|4',
      'Long-las|stationary|ranged|4|2|3|3',
      'Gun butt||melee|3|4|2|3',
    ]);
    expect(flat(C.stubGunner)).toEqual([
      'Autostubber|focused|ranged|5|3|3|4',
      'Autostubber|suppressive|ranged|5|5|0|0',
      'Autostubber|sweeping|ranged|4|3|3|4',
      'Fists||melee|3|4|2|3',
    ]);
    expect(flat(C.gunner)).toEqual([
      'Meltagun||ranged|4|3|6|3',
      'Plasma gun|standard|ranged|4|3|4|6',
      'Plasma gun|supercharge|ranged|4|3|5|6',
      'Gun butt||melee|3|4|2|3',
    ]);
    expect(flat(C.heavyGunner)).toEqual([
      'Laspistol||ranged|4|3|2|3',
      'Missile launcher|frag|ranged|4|3|3|5',
      'Missile launcher|krak|ranged|4|3|5|7',
      'Fists||melee|3|4|2|3',
    ]);
    expect(profileOf(C.sergeant, 'Scoped lascarbine').rules.map((r) => r.raw)).toEqual(['Lethal 5+', 'Rending']);
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment, 13 abilities and 5 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Elite Fieldcraft', 'Camo Cloaks']);
    expect(spectreSquad.ploys.filter((p) => p.kind === 'strategy').map((p) => p.name)).toEqual([
      'DISAPPEAR',
      'HIDDEN ENGAGEMENT',
      'AMBUSHING VOLLEY',
      'PATIENCE',
    ]);
    expect(spectreSquad.ploys.filter((p) => p.kind === 'firefight').map((p) => p.name)).toEqual([
      'DODGE',
      'SILENT KILLERS',
      'SHARP REACTIONS',
      'PREPARED DEFENCE',
    ]);
    expect(spectreSquad.equipment.map((e) => e.id)).toEqual([
      EQ.sniperOverwatch,
      EQ.tvidFeed,
      EQ.starshellFlare,
      EQ.advancedCamouflage,
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(13);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'ISSUE MISSION',
      'SIGNAL',
      'MEDIKIT',
      'LOAD WEAPON',
      'SIGNAL',
    ]);
    expect(DATA.rareWeaponRules).toEqual(['ConcealedPosition']);
  });

  it('the printed default roster is legal, and every datacard, ploy and equipment has an AI hint', () => {
    const picks = defaultRoster(spectreSquad.data);
    expect(spectreSquad.validateRoster(picks).ok).toBe(true);
    // "1 SPECTRE SQUAD VETERAN SERGEANT", "1 SPECTRE SQUAD VOX-RELAY BEACON", "9 … operatives"
    expect(picks).toHaveLength(11);
    expect(picks[0]!.datacardId).toBe(C.sergeant);
    expect(picks.map((p) => p.datacardId)).toContain(C.beacon);
    for (const card of DATA.datacards) expect(spectreSquad.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of spectreSquad.ploys) expect(spectreSquad.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of spectreSquad.equipment) expect(spectreSquad.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
    // "Other than TROOPER operatives, your kill team can only include each operative once."
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['TROOPER'] }]);
  });
});

// ---------------------------------------------------------------------------
describe('Elite Fieldcraft — the Fieldcraft point economy', () => {
  it('"you gain 1 Fieldcraft point, or 2 if a friendly … VOX-OPERATOR operative is in the killzone"', () => {
    expect(rule(RULE.eliteFieldcraft)).toContain('you gain 1 Fieldcraft point, or 2 if a friendly');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    ready(ctx, state, 'p1');
    expect(fieldcraftPoints(state, 'p1')).toBe(1);

    const withVox = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(withVox.ctx, withVox.state, 'p1');
    expect(fieldcraftPoints(withVox.state, 'p1')).toBe(2);
  });

  it('"…and isn\'t within control range of enemy operatives" — an engaged VOX-OPERATOR gives 1', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    const vox = state.operatives[opWith(state, 'p1', C.voxOperator)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    foe.pos = { x: vox.pos.x + 0.5, y: vox.pos.y };
    ready(ctx, state, 'p1');
    expect(fieldcraftPoints(state, 'p1')).toBe(1);
  });

  it('"At the end of each turning point, discard your Fieldcraft points."', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    expect(fieldcraftPoints(state, 'p1')).toBe(2);
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(fieldcraftPoints(state, 'p1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Elite Fieldcraft — the interrupt', () => {
  /** Activate an enemy operative and end that activation, which is where the interrupt lands. */
  function enemyActivation(
    ctx: ReturnType<typeof teamContext>,
    state: GameState,
    order: 'engage' | 'conceal' = 'engage',
  ): GameState {
    const enemyId = state.teams.p2.operativeIds[0]!;
    let s = activate(ctx, state, enemyId, order);
    s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    return s;
  }

  it('spends 1 point after an Engage-order enemy activation and grants a free Shoot/Dash/Reposition', () => {
    expect(rule(RULE.eliteFieldcraft)).toContain(
      'you can spend 1 of your Fieldcraft points to interrupt that activation',
    );
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    expect(fieldcraftPoints(state, 'p1')).toBe(2);
    const s = enemyActivation(ctx, state);
    expect(fieldcraftPoints(s, 'p1')).toBe(1);
    const granted = s.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(granted).toHaveLength(1);
    expect(granted[0]!.data?.['only']).toEqual(['Shoot', FIELDCRAFT_SHOOT, 'Dash', 'Reposition']);
    // "…can immediately perform a free Shoot, Dash or Reposition action": AP outside the APL
    // budget (D-100), so the interrupting operative's printed APL 2 is untouched and it gets a
    // third point to spend on that activation.
    const chosen = s.operatives[granted[0]!.operativeId!]!;
    expect(chosen.aplMods).toEqual([]);
    expect(aplOf(ctx, s, chosen)).toBe(2);
    expect(freeApOf(s, chosen)).toBe(1);
    expect(apBudgetOf(ctx, s, chosen)).toBe(3);
  });

  it('"You cannot interrupt each enemy operative\'s activation more than once per activation"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    const enemyId = state.teams.p2.operativeIds[0]!;
    let s = activate(ctx, state, enemyId, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    const after = fieldcraftPoints(s, 'p1');
    // Re-emitting the same activation-end window must not spend a second point.
    ctx.hooks.emit('onActivationEnd', s, { state: s, operative: s.operatives[enemyId]! });
    expect(fieldcraftPoints(s, 'p1')).toBe(after);
  });

  it('"each friendly operative cannot perform more than one free action per turning point"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant] });
    ready(ctx, state, 'p1');
    ready(ctx, state, 'p1'); // 2 points, one operative
    expect(fieldcraftPoints(state, 'p1')).toBe(2);
    let s = state;
    for (const enemyId of state.teams.p2.operativeIds.slice(0, 2)) {
      s = activate(ctx, s, enemyId, 'engage');
      s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    }
    expect(fieldcraftPoints(s, 'p1')).toBe(1); // only the first interrupt was possible
    expect(s.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1')).toHaveLength(1);
  });

  it('does not fire against a Conceal-order enemy until SHARP REACTIONS is used', () => {
    expect(rule(FP.sharpReactions)).toContain('regardless of that enemy operative’s order');
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    const s = enemyActivation(ctx, state, 'conceal');
    expect(fieldcraftPoints(s, 'p1')).toBe(2);

    const second = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(second.ctx, second.state, 'p1');
    // "…if it's within 8" of a friendly SPECTRE SQUAD operative."
    const enemyId = second.state.teams.p2.operativeIds[0]!;
    second.state.operatives[enemyId]!.pos = { x: 9, y: 2 };
    let s2 = activate(second.ctx, second.state, enemyId, 'conceal');
    s2 = reduce(s2, { t: 'UsePloy', player: 'p1', ployId: FP.sharpReactions }, second.ctx).state;
    expect(fieldcraftPoints(s2, 'p1')).toBe(1);
  });

  it('"You cannot select any other enemy operative as a valid target during that action."', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    let s = enemyActivation(ctx, state);
    const grant = s.effects.find((e) => e.rule === 'spectre.eliteFieldcraft.interrupt')!;
    const shooter = s.operatives[grant.operativeId!]!;
    const lockedId = String(grant.data?.['enemyId']);
    shooter.apSpent = Number(grant.data?.['threshold'] ?? 0); // now spending the free action
    const other = s.teams.p2.operativeIds.find((id) => id !== lockedId)!;
    for (const id of [lockedId, other]) s.operatives[id]!.pos = { x: 8, y: 11 + (id === other ? 2 : 0) };
    shooter.pos = { x: 5, y: 11 };
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    expect(checkTarget(ctx, s, shooter, s.operatives[lockedId]!, profile, profile.rules).valid).toBe(true);
    const blocked = checkTarget(ctx, s, shooter, s.operatives[other]!, profile, profile.rules);
    expect(blocked.valid).toBe(false);
    expect(blocked.reason).toContain('only the interrupted enemy operative');
    void s;
  });

  it('the free action is restricted to Shoot (excluding Guard), Dash or Reposition', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    let s = enemyActivation(ctx, state);
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.player === 'p1')!;
    const op = s.operatives[grant.operativeId!]!;
    s = activate(ctx, s, op.id, 'engage');
    op.apSpent = Number(grant.data?.['threshold'] ?? 0);
    const fight = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: op,
      action: 'Fight',
      allowed: true,
    });
    expect(fight.allowed).toBe(false);
    const dash = ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Dash', allowed: true });
    expect(dash.allowed).toBe(true);
  });

  it('the free Shoot changes the operative\'s order and is a point-blank shot while engaged with that enemy', () => {
    expect(rule(RULE.eliteFieldcraft)).toContain('follow the rules for a point-blank shot from the Guard action');
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    const enemyId = state.teams.p2.operativeIds[0]!;
    banish(state, 'p2', [enemyId]);
    let s = activate(ctx, state, enemyId, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'spectre.eliteFieldcraft.interrupt')!;
    const shooter = s.operatives[grant.operativeId!]!;
    shooter.pos = { x: 10, y: 11 };
    s.operatives[enemyId]!.pos = { x: 10.6, y: 11 }; // within control range of that enemy only
    s = activate(ctx, s, shooter.id, 'conceal');
    // The universal Shoot refuses both the Conceal order and being engaged; this action does not.
    const params = { weaponName: 'Scoped lascarbine', targetId: enemyId };
    expect(getAction('Shoot')!.check(ctx, s, s.operatives[shooter.id]!, params).ok).toBe(false);
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: shooter.id, action: FIELDCRAFT_SHOOT, params },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.state.operatives[shooter.id]!.order).toBe('engage');
    expect(res.state.rejected).toHaveLength(0);
  });

  it('TROOPER › Cool-Headed: "can interrupt … for 0 Fieldcraft points"', () => {
    expect(ability(C.trooper, `${C.trooper}.cool-headed`)).toContain('for 0 Fieldcraft points');
    const { ctx, state } = setup({ picks: [C.trooper] });
    expect(fieldcraftPoints(state, 'p1')).toBe(0);
    const enemyId = state.teams.p2.operativeIds[0]!;
    let s = activate(ctx, state, enemyId, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    expect(fieldcraftPoints(s, 'p1')).toBe(0);
    expect(s.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1')).toHaveLength(1);
  });

  it('VETERAN SERGEANT › ISSUE MISSION lets an expended operative interrupt, and it cannot then counteract', () => {
    expect(uniqueActionText(C.sergeant, ACT.issueMission)).toContain('even though it’s expended');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    ready(ctx, state, 'p1');
    const sergeant = opWith(state, 'p1', C.sergeant);
    const trooper = state.operatives[opWith(state, 'p1', C.trooper)]!;
    trooper.expended = true;
    trooper.ready = false;
    trooper.order = 'engage';
    state.operatives[sergeant]!.ready = false;
    state.operatives[sergeant]!.expended = true;
    let s = activate(ctx, state, sergeant, 'engage');
    // ISSUE MISSION is performed from the SERGEANT's own activation.
    s.operatives[sergeant]!.ready = true;
    s.operatives[sergeant]!.expended = false;
    s.activeOperativeId = sergeant;
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: ACT.issueMission, params: { targetOperativeId: trooper.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    s = res.state;
    expect(s.effects.some((e) => e.rule === 'spectre.issueMission' && e.operativeId === trooper.id)).toBe(true);
    s.operatives[sergeant]!.ready = false;
    s.operatives[sergeant]!.expended = true;
    const enemyId = s.teams.p2.operativeIds[0]!;
    s.activeOperativeId = undefined;
    s.activePlayer = 'p2';
    let s2 = activate(ctx, s, enemyId, 'engage');
    s2 = reduce(s2, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    expect(s2.operatives[trooper.id]!.counteractedThisTP).toBe(true);
    expect(counteractCandidates(ctx, s2, 'p1').map((o) => o.id)).not.toContain(trooper.id);
  });
});

// ---------------------------------------------------------------------------
describe('Camo Cloaks', () => {
  it('"you can retain one additional cover save" for a SPECTRE SQUAD operative in cover', () => {
    expect(rule(RULE.camoCloaks)).toContain('you can retain one additional cover save');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const target = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const shooter = state.operatives[state.teams.p2.operativeIds[0]!]!;
    fakeShoot(state, shooter.id, target.id, 'Lasgun', { inCover: true });
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Lasgun', profile),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(1);
  });

  it('"This isn\'t cumulative with improved cover saves from Vantage terrain", and excludes the BEACON', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon, C.trooper] });
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const shooter = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const emit = (target: OperativeState) =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, target, 'Lasgun', profile),
        count: 3,
        coverSave: true,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });

    const trooper = state.operatives[opWith(state, 'p1', C.trooper)]!;
    fakeShoot(state, shooter.id, trooper.id, 'Lasgun', { inCover: true, vantageImprovedCover: true });
    expect(emit(trooper).extraCoverSaves).toBe(0);

    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    fakeShoot(state, shooter.id, beacon.id, 'Lasgun', { inCover: true });
    expect(emit(beacon).extraCoverSaves).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('VOX-RELAY BEACON › Expendable', () => {
  it('"cannot perform any actions other than Signal"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    const s = activate(ctx, state, beacon.id, 'engage');
    const ids = availableActions(ctx, s, beacon)
      .filter((a) => a.ok)
      .map((a) => a.def.id);
    expect(ids).toEqual([ACT.beaconSignal]);
  });

  it('"It cannot counteract, retaliate or assist in a fight."', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    beacon.expended = true;
    beacon.ready = false;
    beacon.order = 'engage';
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(beacon.id);
    // "retaliate" — startFight reads the core `cannotRetaliate` effect.
    ctx.hooks.emit('onActivationStart', state, { state, operative: beacon });
    expect(state.effects.some((e) => e.rule === 'cannotRetaliate' && e.operativeId === beacon.id)).toBe(true);
    // "assist" — the BEACON is subtracted from the assist count.
    const sergeant = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    foe.pos = { x: 10, y: 11 };
    sergeant.pos = { x: 10.9, y: 11 };
    beacon.pos = { x: 9.1, y: 11 };
    const ev = ctx.hooks.emit('onFightAssist', state, { state, operative: sergeant, assists: 1 });
    expect(ev.assists).toBe(0);
  });

  it('"This operative cannot contest markers"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    banish(state, 'p1', [beacon.id]);
    banish(state, 'p2');
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    beacon.pos = { ...marker.pos };
    expect(markerController(ctx, state, marker)).toBeNull();
  });

  it('"you can ignore this operative\'s control range" when selecting a valid target', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const shooter = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [target.id]);
    shooter.pos = { x: 6, y: 11 };
    target.pos = { x: 12, y: 11 };
    beacon.pos = { x: 11.2, y: 11 }; // within the target's control range
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    expect(checkTarget(ctx, state, shooter, target, profile, profile.rules).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Datacard abilities', () => {
  it('FIELD MEDICAE › Medic!: the operative "isn\'t incapacitated, has 1 wound remaining"', () => {
    expect(ability(C.medicae, `${C.medicae}.medic`)).toContain('has 1 wound remaining');
    const { ctx, state } = setup({ picks: [C.sergeant, C.medicae, C.trooper] });
    banish(state, 'p2');
    const medic = state.operatives[opWith(state, 'p1', C.medicae)]!;
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    medic.pos = { x: 6, y: 11 };
    victim.pos = { x: 8, y: 11 };
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(1);
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations"
    expect(medic.aplMods).toContain(-1);
    expect(victim.aplMods).toContain(-1);
    // "The first time during each turning point…" — a second victim gets nothing.
    const other = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    other.pos = { x: 7, y: 11 };
    other.wounds = 2;
    inflictDamage(ctx, state, other, 5, 'attack');
    expect(other.incapacitated).toBe(true);
  });

  it('Medic! is refused while either operative is within an enemy operative\'s control range', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.medicae, C.trooper] });
    const medic = state.operatives[opWith(state, 'p1', C.medicae)]!;
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    medic.pos = { x: 6, y: 11 };
    victim.pos = { x: 8, y: 11 };
    foe.pos = { x: 8.6, y: 11 };
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(true);
  });

  it('GRENADIER › Grenadier: frag and krak grenades are granted, and improve their Hit stat by 1', () => {
    expect(ability(C.grenadier, `${C.grenadier}.grenadier`)).toContain('improve the Hit stat of that weapon by 1');
    const { ctx, state } = setup({ picks: [C.sergeant, C.grenadier] });
    const gren = state.operatives[opWith(state, 'p1', C.grenadier)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: gren });
    const names = (gren as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons!.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Frag grenade', 'Krak grenade']));
    const frag = (gren as OperativeState & { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] })
      .grantedWeapons!.find((w) => w.name === 'Frag grenade')!.profiles[0]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    fakeShoot(state, gren.id, target.id, 'Frag grenade');
    const improved = hitOf(ctx, state, gren, frag);
    fakeShoot(state, gren.id, target.id, 'Lasrifle');
    expect(improved).toBe(hitOf(ctx, state, gren, frag) - 1);
  });

  it('GRENADIER › Melta Mine is a carried marker with its own Place action and a free Dash', () => {
    expect(ability(C.grenadier, `${C.grenadier}.melta-mine`)).toContain('carrying your Melta Mine marker');
    const { ctx, state } = setup({ picks: [C.sergeant, C.grenadier] });
    const gren = state.operatives[opWith(state, 'p1', C.grenadier)]!;
    banish(state, 'p2');
    let s = activate(ctx, state, gren.id, 'engage');
    expect(s.markers[MELTA_MARKER('p1')]?.carriedBy).toBe(gren.id);
    const res = reduce(s, { t: 'PerformAction', operativeId: gren.id, action: MINE_PLACE, params: {} }, ctx);
    expect(res.ok).toBe(true);
    s = res.state;
    expect(s.markers[MELTA_MARKER('p1')]?.carriedBy).toBeUndefined();
    const dash = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === gren.id);
    expect(dash?.data?.['only']).toEqual(['Dash']);
    // "It can perform the Pick Up Marker action on that marker"
    expect(getAction(MINE_PICK_UP)!.check(ctx, s, s.operatives[gren.id]!, {}).ok).toBe(true);
  });

  it('"That marker cannot be placed within an enemy operative\'s control range"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.grenadier] });
    const gren = state.operatives[opWith(state, 'p1', C.grenadier)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    gren.pos = { x: 10, y: 11 };
    foe.pos = { x: 11.4, y: 11 };
    const s = activate(ctx, state, gren.id, 'engage');
    const check = getAction(MINE_PLACE)!.check(ctx, s, s.operatives[gren.id]!, {});
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('within an enemy operative');
  });

  it('GRENADIER › Proximity Mine inflicts 2D6+3 on the first operative to reach the marker', () => {
    expect(ability(C.grenadier, `${C.grenadier}.proximity-mine`)).toContain('inflict 2D6+3 damage on that operative');
    const { ctx, state } = setup({ picks: [C.sergeant, C.grenadier], script: [4, 4] });
    const gren = state.operatives[opWith(state, 'p1', C.grenadier)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    ctx.hooks.emit('onActivationStart', state, { state, operative: gren });
    state.markers[MELTA_MARKER('p1')] = {
      id: MELTA_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 15, y: 11 },
      z: 0,
      owner: 'p1',
      flags: {},
    };
    gren.carryingMarkerId = undefined;
    foe.pos = { x: 15, y: 11 };
    const before = foe.wounds;
    ctx.hooks.emit('onActivationEnd', state, { state, operative: foe });
    expect(before - foe.wounds).toBe(11); // 4 + 4 + 3
    expect(state.markers[MELTA_MARKER('p1')]).toBeUndefined();
  });

  it('GUIDE › Scout Terrain: "Perform the Operate Hatch action for 1 less AP"', () => {
    expect(ability(C.guide, `${C.guide}.scout-terrain`)).toContain('Operate Hatch action for 1 less AP');
    const { ctx, state } = setup({ picks: [C.sergeant, C.guide] });
    const guide = state.operatives[opWith(state, 'p1', C.guide)]!;
    const sergeant = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    guide.pos = { x: 20, y: 11 }; // out of your territory (x < 15) so only the 3" half can fire
    sergeant.pos = { x: 21, y: 11 };
    const near = ctx.hooks.emit('onActionCost', state, {
      state,
      operative: sergeant,
      action: 'Operate Hatch',
      ap: 1,
    });
    expect(near.ap).toBe(0);
    sergeant.pos = { x: 26, y: 11 };
    const far = ctx.hooks.emit('onActionCost', state, {
      state,
      operative: sergeant,
      action: 'Operate Hatch',
      ap: 1,
    });
    expect(far.ap).toBe(1);
  });

  it('HEAVY GUNNER › Weapons Team swaps Heavy for Heavy (Dash only) with a LOADER in control range', () => {
    expect(ability(C.heavyGunner, `${C.heavyGunner}.weapons-team`)).toContain(
      'have the Heavy (Dash only) weapon rule instead of the Heavy weapon rule',
    );
    const { ctx, state } = setup({ picks: [C.sergeant, C.heavyGunner, C.loader] });
    const heavy = state.operatives[opWith(state, 'p1', C.heavyGunner)]!;
    const loader = state.operatives[opWith(state, 'p1', C.loader)]!;
    heavy.pos = { x: 6, y: 11 };
    loader.pos = { x: 7, y: 11 };
    const krak = profileOf(C.heavyGunner, 'Missile launcher', 'krak');
    expect(effectiveRules(ctx, state, krak, { operative: heavy, weaponName: 'Missile launcher' }).map((r) => r.raw)).toContain(
      'Heavy',
    );
    ctx.hooks.emit('onActivationStart', state, { state, operative: heavy });
    const after = effectiveRules(ctx, state, krak, { operative: heavy, weaponName: 'Missile launcher' });
    expect(after.map((r) => r.raw)).toContain('Heavy (Dash only)');
    expect(after.filter((r) => r.id === 'Heavy')).toHaveLength(1);
  });

  it('LOADER › Weapon Assist offers a re-roll while a friendly operative is shooting', () => {
    expect(ability(C.loader, `${C.loader}.weapon-assist`)).toContain('you can re-roll one of your attack dice');
    const { ctx, state } = setup({ picks: [C.sergeant, C.loader] });
    const sergeant = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const loader = state.operatives[opWith(state, 'p1', C.loader)]!;
    sergeant.pos = { x: 6, y: 11 };
    loader.pos = { x: 7, y: 11 };
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const ev = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(sergeant, target, 'Scoped lascarbine', profile),
      dice: [1, 2, 3, 4],
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('spectre.weaponAssist');
    loader.pos = { x: 12, y: 11 };
    const away = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(sergeant, target, 'Scoped lascarbine', profile),
      dice: [1, 2, 3, 4],
      rerolls: [],
    });
    expect(away.rerolls).toHaveLength(0);
  });

  it('SHARPSHOOTER › Concealed Position: the concealed profile is only usable for the first Shoot', () => {
    expect(ability(C.sharpshooter, `${C.sharpshooter}.concealed-position`)).toContain(
      'the first time it’s performing the Shoot action during the battle',
    );
    const { ctx, state } = setup({ picks: [C.sergeant, C.sharpshooter] });
    const sniper = state.operatives[opWith(state, 'p1', C.sharpshooter)]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const concealed = profileOf(C.sharpshooter, 'Long-las', 'concealed');
    expect(concealed.rules.map((r) => r.id)).toContain('ConcealedPosition');
    const emit = () =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(sniper, target, 'Long-las', concealed),
        allowed: true,
      dryRun: false,
      });
    expect(emit().allowed).toBe(true);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(sniper, target, 'Long-las', profileOf(C.sharpshooter, 'Long-las', 'mobile')),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(emit().allowed).toBe(false);
    // The other profiles stay available.
    const mobile = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(sniper, target, 'Long-las', profileOf(C.sharpshooter, 'Long-las', 'mobile')),
      allowed: true,
      dryRun: false,
    });
    expect(mobile.allowed).toBe(true);
  });

  it('STUB-GUNNER › Suppressive Fire subtracts 1 from the Atk stat of a nearby enemy\'s weapons', () => {
    expect(ability(C.stubGunner, `${C.stubGunner}.suppressive-fire`)).toContain(
      'subtract 1 from the Atk stat of that enemy operative’s weapons',
    );
    const { ctx, state } = setup({ picks: [C.sergeant, C.stubGunner] });
    const stub = state.operatives[opWith(state, 'p1', C.stubGunner)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    stub.pos = { x: 10, y: 11 };
    stub.order = 'engage';
    foe.pos = { x: 12, y: 11 };
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const emit = () =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(foe, stub, 'Hot-shot lasgun', profile),
        count: 4,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      });
    expect(emit().count).toBe(3);
    stub.order = 'conceal'; // "if this operative has an Engage order"
    expect(emit().count).toBe(4);
  });
  it('Suppressive Fire "has no effect if this operative performed the Charge action during this turning point"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.stubGunner] });
    const stub = state.operatives[opWith(state, 'p1', C.stubGunner)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    stub.pos = { x: 10, y: 11 };
    stub.order = 'engage';
    foe.pos = { x: 12, y: 11 };
    stub.actionsThisActivation = ['Charge'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: stub });
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const ev = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(foe, stub, 'Hot-shot lasgun', profile),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.count).toBe(4);
  });

  it('Scout Terrain also scouts "terrain features within your territory"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.guide] });
    const guide = state.operatives[opWith(state, 'p1', C.guide)]!;
    const sergeant = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    guide.pos = { x: 26, y: 2 }; // far away
    sergeant.pos = { x: 8, y: 11 }; // p1 territory is x < 15 on the test map
    const ev = ctx.hooks.emit('onActionCost', state, {
      state,
      operative: sergeant,
      action: 'Operate Hatch',
      ap: 1,
    });
    expect(ev.ap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  const gambit = (ctx: ReturnType<typeof teamContext>, state: GameState, id: string): GameState => {
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    return reduce(state, { t: 'UseGambit', player: 'p1', gambitId: id }, ctx).state;
  };

  it('DISAPPEAR: "can immediately perform a free Reposition action"', () => {
    expect(rule(SP.disappear)).toContain('free Reposition action');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const s = gambit(ctx, state, SP.disappear);
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(grant?.data?.['only']).toEqual(['Reposition']);
    expect(s.effects.some((e) => e.rule === 'spectre.disappear')).toBe(true);
  });

  it('"it cannot perform that action again during the turning point"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    let s = gambit(ctx, state, SP.disappear);
    const op = s.operatives[s.effects.find((e) => e.rule === 'spectre.disappear')!.operativeId!]!;
    s.phase = 'firefight';
    op.actionsThisActivation = ['Reposition'];
    ctx.hooks.emit('onActivationEnd', s, { state: s, operative: op });
    const ev = ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Reposition', allowed: true });
    expect(ev.allowed).toBe(false);
    expect(ev.reason).toContain('again during this turning point');
    void s;
  });

  it('HIDDEN ENGAGEMENT: Balanced "if it\'s in cover from the target\'s perspective"', () => {
    expect(rule(SP.hiddenEngagement)).toContain('if it’s in cover from the target’s perspective');
    const map = testMap({ features: [heavyBlock('cover', 7, 10.4, 1, 1.2, 1)] });
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper], map });
    const shooter = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [target.id]);
    shooter.pos = { x: 6, y: 11 };
    target.pos = { x: 16, y: 11 };
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const before = effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: 'Scoped lascarbine' });
    expect(before.map((r) => r.id)).not.toContain('Balanced');
    const s = gambit(ctx, state, SP.hiddenEngagement);
    const after = effectiveRules(ctx, s, profile, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[target.id]!,
      weaponName: 'Scoped lascarbine',
    });
    expect(after.map((r) => r.id)).toContain('Balanced');
  });

  it('AMBUSHING VOLLEY: Devastating 1, or +1 to an existing Devastating x', () => {
    expect(rule(SP.ambushingVolley)).toContain('add 1 to the x of its Devastating x weapon rule instead');
    const map = testMap({ features: [heavyBlock('divider', 14, 0, 2, 22, 8)] });
    const { ctx, state } = setup({ picks: [C.sergeant, C.sharpshooter, C.stubGunner], map });
    banish(state, 'p2');
    let s = gambit(ctx, state, SP.ambushingVolley);
    s.phase = 'firefight';
    const sniper = s.operatives[opWith(s, 'p1', C.sharpshooter)]!;
    s = activate(ctx, s, sniper.id, 'engage');
    expect(s.effects.some((e) => e.rule === 'spectre.ambushingVolley' && e.operativeId === sniper.id)).toBe(true);
    const stationary = profileOf(C.sharpshooter, 'Long-las', 'stationary'); // Devastating 3
    const bumped = effectiveRules(ctx, s, stationary, { operative: s.operatives[sniper.id]!, weaponName: 'Long-las' });
    expect(bumped.find((r) => r.id === 'Devastating')?.x).toBe(4);
    const butt = profileOf(C.sharpshooter, 'Gun butt');
    expect(
      effectiveRules(ctx, s, butt, { operative: s.operatives[sniper.id]!, weaponName: 'Gun butt' }).map((r) => r.id),
    ).not.toContain('Devastating'); // ranged weapons only
  });

  it('AMBUSHING VOLLEY excludes "the suppressive profile of an autostubber", and needs >3" and no valid target', () => {
    const map = testMap({ features: [heavyBlock('divider', 14, 0, 2, 22, 8)] });
    const { ctx, state } = setup({ picks: [C.sergeant, C.stubGunner], map });
    banish(state, 'p2');
    let s = gambit(ctx, state, SP.ambushingVolley);
    s.phase = 'firefight';
    const stub = s.operatives[opWith(s, 'p1', C.stubGunner)]!;
    s = activate(ctx, s, stub.id, 'engage');
    const suppressive = profileOf(C.stubGunner, 'Autostubber', 'suppressive');
    expect(
      effectiveRules(ctx, s, suppressive, { operative: s.operatives[stub.id]!, weaponName: 'Autostubber' }).map((r) => r.id),
    ).not.toContain('Devastating');
    const focused = profileOf(C.stubGunner, 'Autostubber', 'focused');
    expect(
      effectiveRules(ctx, s, focused, { operative: s.operatives[stub.id]!, weaponName: 'Autostubber' }).map((r) => r.id),
    ).toContain('Devastating');
  });

  it('AMBUSHING VOLLEY does not fire when the operative is already a valid target for the enemy', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.stubGunner] });
    const stub = state.operatives[opWith(state, 'p1', C.stubGunner)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    stub.pos = { x: 10, y: 11 };
    foe.pos = { x: 16, y: 11 };
    stub.order = 'engage';
    // Recorded as the order it carries into the activation ("before determining its order").
    ctx.hooks.emit('onActivationEnd', state, { state, operative: stub });
    stub.ready = true;
    stub.expended = false;
    expect(isValidTargetForEnemies(makeTeamHooks(DATA, 'p1', ctx), state, stub)).toBe(true);
    let s = gambit(ctx, state, SP.ambushingVolley);
    s.phase = 'firefight';
    s = activate(ctx, s, stub.id, 'conceal');
    expect(s.effects.some((e) => e.rule === 'spectre.ambushingVolley')).toBe(false);
  });

  it('PATIENCE: Relentless for "the last friendly operative to be activated during this turning point"', () => {
    expect(rule(SP.patience)).toContain('its weapons have the Relentless weapon rule for that action');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    banish(state, 'p2');
    let s = gambit(ctx, state, SP.patience);
    s.phase = 'firefight';
    const sergeant = s.operatives[opWith(s, 'p1', C.sergeant)]!;
    const trooper = s.operatives[opWith(s, 'p1', C.trooper)]!;
    s = activate(ctx, s, sergeant.id, 'engage');
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    expect(
      effectiveRules(ctx, s, profile, { operative: s.operatives[sergeant.id]!, weaponName: 'Scoped lascarbine' }).map(
        (r) => r.id,
      ),
    ).not.toContain('Relentless'); // the TROOPER is still ready
    s.operatives[trooper.id]!.ready = false;
    expect(
      effectiveRules(ctx, s, profile, { operative: s.operatives[sergeant.id]!, weaponName: 'Scoped lascarbine' }).map(
        (r) => r.id,
      ),
    ).toContain('Relentless');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('DODGE: "that operative can perform the Fall Back action for 1 less AP"', () => {
    expect(rule(FP.dodge)).toContain('Fall Back action for 1 less AP');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const op = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    let s = activate(ctx, state, op.id, 'engage');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.dodge }, ctx).state;
    const ev = ctx.hooks.emit('onActionCost', s, { state: s, operative: s.operatives[op.id]!, action: 'Fall Back', ap: 2 });
    expect(ev.ap).toBe(1);
  });

  it('SILENT KILLERS: Charge with a Conceal order, +3 damage on the first strike, no other successes', () => {
    expect(rule(FP.silentKillers)).toContain('it can perform the Charge action while it has a Conceal order');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const op = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 6, y: 11 };
    foe.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, op.id, 'conceal');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.silentKillers }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'spectre.silentKillers' && e.operativeId === op.id)).toBe(true);
    // The universal Charge refuses a Conceal order; the ploy's own Charge does not.
    expect(getAction('Charge')!.check(ctx, s, s.operatives[op.id]!, { path: { points: [{ x: 7, y: 11 }] } }).ok).toBe(false);
    expect(getAction(SILENT_CHARGE)!.check(ctx, s, s.operatives[op.id]!, { path: { points: [{ x: 7, y: 11 }] } }).reason)
      .not.toContain('Conceal');

    // "the first time it strikes you can inflict 3 additional damage"
    foe.pos = { x: 6.9, y: 11 };
    fakeFight(s, op.id, foe.id, 'Bionic arm', { attackerDice: [] });
    foe.wounds = 5;
    inflictDamage(ctx, s, foe, 3, 'attack');
    expect(foe.wounds).toBe(-1); // 3 + 3
  });

  it('SILENT KILLERS discards the striker\'s remaining successes after that strike', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const op = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 6, y: 11 };
    foe.pos = { x: 6.9, y: 11 };
    let s = activate(ctx, state, op.id, 'conceal');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.silentKillers }, ctx).state;
    fakeFight(s, op.id, foe.id, 'Bionic arm', { attackerDice: [{ value: 5, state: 'normal' }] });
    s.operatives[foe.id]!.wounds = 4;
    inflictDamage(ctx, s, s.operatives[foe.id]!, 3, 'attack'); // 3 + 3 >= 4 → the killing blow
    const profile = profileOf(C.sergeant, 'Bionic arm');
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(s.operatives[op.id]!, s.operatives[foe.id]!, 'Bionic arm', profile, 'melee'),
      crit: false,
      struck: s.operatives[foe.id]!,
    });
    const seq = s.sequence as { attackerPool: { dice: { state: string }[] } };
    expect(seq.attackerPool.dice.every((d) => d.state === 'discarded')).toBe(true);
  });

  it('PREPARED DEFENCE: "that block can be allocated to block two unresolved successes"', () => {
    expect(rule(FP.preparedDefence)).toContain('block two unresolved successes');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper] });
    const mine = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    mine.pos = { x: 10, y: 11 };
    foe.pos = { x: 10.9, y: 11 };
    let s = activate(ctx, state, foe.id, 'engage');
    fakeFight(s, foe.id, mine.id, 'Hot-shot lasgun');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.preparedDefence }, ctx).state;
    const profile = profileOf(C.sergeant, 'Bionic arm');
    const ev = ctx.hooks.emit('onBlockAllocation', s, {
      state: s,
      ctx: attackCtx(s.operatives[mine.id]!, s.operatives[foe.id]!, 'Bionic arm', profile, 'melee'),
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
  });

  it('PREPARED DEFENCE cannot be used "during an activation in which you\'ve interrupted"', () => {
    expect(rule(FP.preparedDefence)).toContain('You cannot use this ploy during an activation in which you’ve interrupted');
    const { ctx, state } = setup({ picks: [C.sergeant, C.voxOperator] });
    ready(ctx, state, 'p1');
    const enemyId = state.teams.p2.operativeIds[0]!;
    let s = activate(ctx, state, enemyId, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: enemyId }, ctx).state;
    const mine = s.operatives[opWith(s, 'p1', C.sergeant)]!;
    const foe = s.operatives[s.teams.p2.operativeIds[1]!]!;
    s = activate(ctx, s, foe.id, 'engage');
    fakeFight(s, foe.id, mine.id, 'Hot-shot lasgun');
    const res = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.preparedDefence }, ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('interrupted');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('SNIPER OVERWATCH grants the printed weapon, once per turning point', () => {
    expect(rule(EQ.sniperOverwatch)).toContain('Devastating 2, Heavy (Dash only), Saturate, Silent');
    expect(SNIPER_OVERWATCH_WEAPON.profiles[0]!.rules.map((r) => r.raw)).toEqual([
      'Devastating 2',
      'Heavy (Dash only)',
      'Saturate',
      'Silent',
    ]);
    expect(SNIPER_OVERWATCH_WEAPON.profiles[0]).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 3 });
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper], equipment: [EQ.sniperOverwatch] });
    const op = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    const granted = (op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted.map((w) => w.name)).toContain('Sniper Overwatch');
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const profile = SNIPER_OVERWATCH_WEAPON.profiles[0]!;
    const pick = () =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, target, 'Sniper Overwatch', profile),
        allowed: true,
      dryRun: false,
      });
    expect(pick().allowed).toBe(true);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, target, 'Sniper Overwatch', profile),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(pick().allowed).toBe(false);
  });

  it('TVID-FEED TRIANGULATION: "that target cannot be obscured" near a friendly VOX-RELAY BEACON', () => {
    expect(rule(EQ.tvidFeed)).toContain('It’s within 6" of a friendly VOX-RELAY BEACON operative');
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon], equipment: [EQ.tvidFeed] });
    const shooter = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [target.id]);
    shooter.pos = { x: 6, y: 11 };
    target.pos = { x: 16, y: 11 };
    beacon.pos = { x: 13, y: 11 };
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    fakeShoot(state, shooter.id, target.id, 'Scoped lascarbine', { obscured: true });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Scoped lascarbine', profile),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect((state.sequence as { obscured: boolean }).obscured).toBe(false);
    // "Once per turning point"
    fakeShoot(state, shooter.id, target.id, 'Scoped lascarbine', { obscured: true });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Scoped lascarbine', profile),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect((state.sequence as { obscured: boolean }).obscured).toBe(true);
  });

  it('STARSHELL FLARE is a STRATEGIC GAMBIT granting a free Stun Grenade action', () => {
    expect(rule(EQ.starshellFlare)).toContain('free Stun Grenade action');
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper], equipment: [EQ.starshellFlare] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const res = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.starshellFlare }, ctx);
    expect(res.ok).toBe(true);
    const grant = res.state.effects.find((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(grant?.data?.['only']).toEqual([STARSHELL_STUN]);
  });

  it('STARSHELL FLARE\'s Stun Grenade does not count towards the kill team\'s grenade budget', () => {
    expect(rule(EQ.starshellFlare)).toContain('doesn’t count towards its action limits');
    const { ctx, state } = setup({
      picks: [C.sergeant, C.trooper],
      equipment: [EQ.starshellFlare],
      script: [5, 5, 5, 5],
    });
    const op = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 10, y: 11 };
    foe.pos = { x: 14, y: 11 };
    const before = { ...state.teams.p1.equipmentUses };
    const s = activate(ctx, state, op.id, 'engage');
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: op.id, action: STARSHELL_STUN, params: { targetOperativeId: foe.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.state.teams.p1.equipmentUses).toEqual(before);
    expect(res.state.operatives[foe.id]!.aplMods).toContain(-1);
    // "you cannot use this equipment for the rest of the battle"
    res.state.phase = 'strategy';
    res.state.strategyStep = 'gambit';
    const again = reduce(res.state, { t: 'UseGambit', player: 'p1', gambitId: EQ.starshellFlare }, ctx);
    expect(again.ok).toBe(false);
  });

  it('ADVANCED CAMOUFLAGE: "it cannot be selected as a valid target … except being within 2"', () => {
    expect(rule(EQ.advancedCamouflage)).toContain('taking precedence over all other rules');
    const map = testMap({ features: [heavyBlock('cover', 7, 10.4, 1, 1.2, 1)] });
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper], equipment: [EQ.advancedCamouflage], map });
    const hider = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    hider.pos = { x: 6, y: 11 };
    foe.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, hider.id, 'conceal');
    const res = reduce(s, { t: 'PerformAction', operativeId: hider.id, action: ADVANCED_CAMOUFLAGE_ACTION }, ctx);
    expect(res.ok).toBe(true);
    s = res.state;
    const profile = profileOf(C.sergeant, 'Scoped lascarbine');
    const check = checkTarget(ctx, s, s.operatives[foe.id]!, s.operatives[hider.id]!, profile, [
      { id: 'Seek', raw: 'Seek' },
    ]);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('ADVANCED CAMOUFLAGE');
  });

  it('ADVANCED CAMOUFLAGE cannot be performed "while visible to and within 3" of an enemy operative"', () => {
    const { ctx, state } = setup({ picks: [C.sergeant, C.trooper], equipment: [EQ.advancedCamouflage] });
    const hider = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [foe.id]);
    hider.pos = { x: 10, y: 11 };
    foe.pos = { x: 12, y: 11 };
    const s = activate(ctx, state, hider.id, 'conceal');
    const check = getAction(ADVANCED_CAMOUFLAGE_ACTION)!.check(ctx, s, s.operatives[hider.id]!, {});
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('within 3"');
  });
});

// ---------------------------------------------------------------------------
describe('Unique actions', () => {
  it('VOX-RELAY BEACON › SIGNAL adds 1 to a friendly operative\'s APL within 6"', () => {
    expect(uniqueActionText(C.beacon, ACT.beaconSignal)).toContain('add 1 to its APL stat');
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    const target = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    banish(state, 'p2');
    beacon.pos = { x: 6, y: 11 };
    target.pos = { x: 9, y: 11 };
    let s = activate(ctx, state, beacon.id, 'engage');
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: beacon.id, action: ACT.beaconSignal, params: { targetOperativeId: target.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.state.operatives[target.id]!.aplMods).toContain(1);
    // "…within 6" of this operative"
    s = res.state;
    s.operatives[target.id]!.pos = { x: 20, y: 11 };
    const far = getAction(ACT.beaconSignal)!.check(ctx, s, s.operatives[beacon.id]!, { targetOperativeId: target.id });
    expect(far.ok).toBe(false);
  });

  it('VOX-OPERATOR › SIGNAL is a SUPPORT action that excludes the VOX-RELAY BEACON', () => {
    expect(uniqueActionText(C.voxOperator, ACT.voxSignal)).toContain('SUPPORT.');
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon, C.voxOperator] });
    const vox = state.operatives[opWith(state, 'p1', C.voxOperator)]!;
    const beacon = state.operatives[opWith(state, 'p1', C.beacon)]!;
    const sergeant = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    banish(state, 'p2');
    const s = activate(ctx, state, vox.id, 'engage');
    expect(
      getAction(ACT.voxSignal)!.check(ctx, s, s.operatives[vox.id]!, { targetOperativeId: beacon.id }).ok,
    ).toBe(false);
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: vox.id, action: ACT.voxSignal, params: { targetOperativeId: sergeant.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.state.operatives[sergeant.id]!.aplMods).toContain(1);
  });

  it('FIELD MEDICAE › MEDIKIT restores 2D3 lost wounds within control range', () => {
    expect(uniqueActionText(C.medicae, ACT.medikit)).toContain('regain up to 2D3 lost wounds');
    const { ctx, state } = setup({ picks: [C.sergeant, C.medicae], script: [3, 5] });
    const medic = state.operatives[opWith(state, 'p1', C.medicae)]!;
    const target = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    banish(state, 'p2');
    medic.pos = { x: 6, y: 11 };
    target.pos = { x: 6.9, y: 11 };
    target.wounds = 2;
    const s = activate(ctx, state, medic.id, 'engage');
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: medic.id, action: ACT.medikit, params: { targetOperativeId: target.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.state.operatives[target.id]!.wounds).toBe(7);
  });

  it('LOADER › LOAD WEAPON grants a free Shoot action and can change that operative\'s order', () => {
    expect(uniqueActionText(C.loader, ACT.loadWeapon)).toContain('free Shoot action (excluding Guard)');
    const { ctx, state } = setup({ picks: [C.sergeant, C.loader] });
    const loader = state.operatives[opWith(state, 'p1', C.loader)]!;
    const target = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    banish(state, 'p2');
    loader.pos = { x: 6, y: 11 };
    target.pos = { x: 6.9, y: 11 };
    target.order = 'conceal';
    let s = activate(ctx, state, loader.id, 'engage');
    const res = reduce(
      s,
      { t: 'PerformAction', operativeId: loader.id, action: ACT.loadWeapon, params: { targetOperativeId: target.id } },
      ctx,
    );
    expect(res.ok).toBe(true);
    s = res.state;
    expect(s.operatives[target.id]!.order).toBe('engage');
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === target.id);
    expect(grant?.data?.['only']).toEqual(['Shoot']);
    // "…or during an activation in which it performed the Charge, Dash or Shoot action"
    s.operatives[loader.id]!.actionsThisActivation = ['Dash'];
    expect(getAction(ACT.loadWeapon)!.check(ctx, s, s.operatives[loader.id]!, { targetOperativeId: target.id }).ok).toBe(
      false,
    );
  });

  it('every unique action refuses a target its perform could not handle (D-026)', () => {
    const { ctx, state } = setup({
      picks: [C.sergeant, C.beacon, C.medicae, C.loader, C.voxOperator],
    });
    const ids = [ACT.issueMission, ACT.beaconSignal, ACT.medikit, ACT.loadWeapon, ACT.voxSignal];
    for (const id of ids) {
      const def = getAction(id)!;
      const owner = state.teams.p1.operativeIds
        .map((x) => state.operatives[x]!)
        .find((o) => def.available!(ctx, state, o))!;
      // An enemy operative is offered by `src/ai/legal.ts`; every action must refuse it in check.
      const enemy = state.teams.p2.operativeIds[0]!;
      expect(def.check(ctx, state, owner, { targetOperativeId: enemy }).ok).toBe(false);
      expect(def.check(ctx, state, owner, {}).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Reminder-only clauses are honestly reported', () => {
  it('Pre-Deploy cannot be honoured: the drop-zone test runs before onDeploy is emitted', () => {
    expect(ability(C.beacon, `${C.beacon}.pre-deploy`)).toContain('can be set up outside of your drop zone');
    const { ctx, state } = setup({ picks: [C.sergeant, C.beacon] });
    const beacon = opWith(state, 'p1', C.beacon);
    state.setup.step = 'deploy';
    const res = reduce(
      state,
      { t: 'DeployOperative', player: 'p1', operativeId: beacon, pos: { x: 12, y: 11 } },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('drop zone');
  });

  it('Prepared Killzone cannot be honoured: a fifth equipment option is refused by the reducer', () => {
    expect(ability(C.guide, `${C.guide}.prepared-killzone`)).toContain('one additional equipment option');
    const { ctx, state } = setup({ picks: [C.sergeant, C.guide] });
    const res = reduce(
      state,
      {
        t: 'SelectEquipment',
        player: 'p1',
        equipment: [EQ.sniperOverwatch, EQ.tvidFeed, EQ.starshellFlare, EQ.advancedCamouflage, 'eq.ammoCache'],
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('four equipment options');
  });
});

// ---------------------------------------------------------------------------
describe('A whole activation runs without rejected intents', () => {
  it('shoots, fights and ends cleanly with every rule live', () => {
    const { ctx, state } = setup({ equipment: [EQ.sniperOverwatch, EQ.tvidFeed, EQ.advancedCamouflage] });
    ready(ctx, state, 'p1');
    const shooter = state.operatives[opWith(state, 'p1', C.sergeant)]!;
    const target = state.operatives[state.teams.p2.operativeIds[0]!]!;
    banish(state, 'p2', [target.id]);
    shooter.pos = { x: 6, y: 11 };
    target.pos = { x: 12, y: 11 };
    let s = activate(ctx, state, shooter.id, 'engage');
    const res = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: shooter.id,
        action: 'Shoot',
        params: { weaponName: 'Scoped lascarbine', targetId: target.id },
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    s = settle(ctx, res.state);
    s = reduce(s, { t: 'EndActivation', operativeId: shooter.id }, ctx).state;
    expect(s.rejected).toHaveLength(0);
  });
});
