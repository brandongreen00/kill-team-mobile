/**
 * Universal equipment (11 options). Every test quotes the rule it pins.
 *
 * Universal Equipment: "The following equipment options are available to all kill teams,
 * alongside their faction equipment. You cannot select each option more than once per battle."
 */
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { readyStep, endTurningPoint } from '../src/core/phases.ts';
import { actionCost, getAction } from '../src/core/actions.ts';
import { validateMove } from '../src/core/movement.ts';
import { terrain } from '../src/core/context.ts';
import { hasEffect, zeroStatMods } from '../src/core/hooks.ts';
import { aplOf, body, weaponsOf } from '../src/core/state.ts';
import { hasType } from '../src/core/terrain.ts';
import {
  ALL_EQUIPMENT,
  GRENADE_WEAPON_NAMES,
  commsDeviceBonus,
  connectedBarricade,
  equipmentItems,
  equipmentMap,
  grenadesLeft,
  isItemPlaced,
  placeEquipment,
  supportDistance,
  validateEquipmentPlacement,
} from '../src/core/equipment/index.ts';
import { opsMap } from '../src/core/ops/index.ts';
import { smokeAreas } from '../src/core/sequences/shoot.ts';
import { whollyWithinSmoke } from '../src/core/visibility.ts';
import { heavyBlock, rect, testContext, testMap } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { ActionParams } from '../src/core/intents.ts';
import type { AttackContext } from '../src/core/hooks.ts';
import type { GameState, PlayerId, TerrainFeature, Vec2 } from '../src/core/types.ts';

interface Game {
  ctx: GameContext;
  state: GameState;
}

function makeGame(equipment: string[], opts: { script?: number[]; features?: TerrainFeature[] } = {}): Game {
  const ctx = testContext(opts.script ? { script: opts.script } : { seed: 3 });
  ctx.ops = opsMap();
  ctx.equipment = equipmentMap();
  let state = createBattle(ctx, { map: testMap(opts.features ? { features: opts.features } : {}), seed: 3 });
  const roster = Array.from({ length: 3 }, () => ({ datacardId: 'test.trooper' }));
  state = reduce(state, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: roster }, ctx).state;
  state = reduce(state, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: roster }, ctx).state;
  state.setup.dropZone = { p1: 'p1', p2: 'p2' };
  state.teams.p1.operativeIds.forEach((id, i) => {
    const o = state.operatives[id]!;
    o.pos = { x: 3, y: 3 + i * 3 };
    o.ready = true;
  });
  state.teams.p2.operativeIds.forEach((id, i) => {
    const o = state.operatives[id]!;
    o.pos = { x: 27, y: 3 + i * 3 };
    o.ready = true;
  });
  state = reduce(state, { t: 'SelectEquipment', player: 'p1', equipment }, ctx).state;
  state.setup.step = 'done';
  state.phase = 'firefight';
  state.turningPoint = 1;
  state.initiative = 'p1';
  state.activePlayer = 'p1';
  return { ctx, state };
}

function act(
  game: Game,
  operativeId: string,
  action: string,
  params: ActionParams = {},
  at?: Vec2,
): { ok: boolean; reason?: string } {
  const op = game.state.operatives[operativeId]!;
  if (at) op.pos = { ...at };
  game.state.phase = 'firefight';
  game.state.activePlayer = op.player;
  game.state.activeOperativeId = operativeId;
  op.apSpent = 0;
  op.actionsThisActivation = [];
  const out = reduce(game.state, { t: 'PerformAction', operativeId, action, params }, game.ctx);
  game.state = out.state;
  return { ok: out.ok, ...(out.reason ? { reason: out.reason } : {}) };
}

const place = (game: Game, equipmentId: string, itemIndex: number, pos: Vec2, rotDeg = 0) =>
  placeEquipment(game.ctx, game.state, { t: 'PlaceEquipment', player: 'p1', equipmentId, itemIndex, pos, rotDeg });

function attackContext(game: Game, attackerId: string, defenderId: string, weaponName = 'lasgun'): AttackContext {
  const attacker = game.state.operatives[attackerId]!;
  const defender = game.state.operatives[defenderId]!;
  return {
    attacker,
    defender,
    weaponName,
    profile: { type: 'ranged', atk: 4, hit: 4, dmgN: 2, dmgC: 3, rules: [] },
    rules: [],
    type: 'ranged',
    secondary: false,
    pointBlank: false,
    inCover: true,
    obscured: false,
    vantageAccurate: 0,
    distance: 6,
  };
}

/** A tower: solid to 3", with a standable Vantage top. */
const tower = (): TerrainFeature => ({
  id: 'tower',
  kind: 'test.tower',
  placement: { x: 10, y: 11, rotDeg: 0, flip: false },
  parts: [
    { id: 'tower.body', featureId: 'tower', poly: rect(10, 9, 3, 4), z0: 0, z1: 3, types: ['Heavy'], role: 'wall' },
    {
      id: 'tower.top',
      featureId: 'tower',
      poly: rect(10, 9, 3, 4),
      z0: 3,
      z1: 3,
      types: ['Vantage'],
      role: 'floor',
      standable: true,
      blocksVisibility: false,
      solid: false,
    },
  ],
});

// ---------------------------------------------------------------------------
describe('the universal equipment list', () => {
  it('has the eleven printed options, with 2x light barricades and 2x ladders', () => {
    expect(ALL_EQUIPMENT).toHaveLength(11);
    expect(equipmentItems('eq.lightBarricades')).toHaveLength(2);
    expect(equipmentItems('eq.ladders')).toHaveLength(2);
    expect(equipmentItems('eq.heavyBarricade')).toHaveLength(1);
    expect(equipmentItems('eq.breachingCharge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('Ammo Cache', () => {
  it('"you can set up one of your Ammo Cache markers wholly within your territory"', () => {
    const game = makeGame(['eq.ammoCache']);
    // p1's territory is x <= 15 on the test map.
    expect(validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.ammoCache', 0, { x: 20, y: 11 }).ok).toBe(false);
    expect(place(game, 'eq.ammoCache', 0, { x: 10, y: 11 }).ok).toBe(true);
    expect(isItemPlaced(game.state, 'p1', 'eq.ammoCache', 0)).toBe(true);
  });

  it('"AMMO RESUPPLY 0AP... whenever this operative is shooting with a weapon from its datacard, you can re-roll one of your attack dice"', () => {
    const game = makeGame(['eq.ammoCache']);
    place(game, 'eq.ammoCache', 0, { x: 10, y: 11 });
    const a = game.state.teams.p1.operativeIds[0]!;
    const markerId = 'equip.p1.eq.ammoCache.0';
    expect(actionCost(game.ctx, game.state, game.state.operatives[a]!, getAction('Ammo Resupply')!)).toBe(0);
    expect(act(game, a, 'Ammo Resupply', { markerId }, { x: 10, y: 11.7 }).ok).toBe(true);
    expect(hasEffect(game.state, 'ammoResupply', { operativeId: a })).toBe(true);
    const ev = game.ctx.hooks.emit('onRollAttack', game.state, {
      state: game.state,
      ctx: attackContext(game, a, game.state.teams.p2.operativeIds[0]!),
      dice: [],
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('ammoResupply');
    // "or if that marker has been used this turning point"
    expect(act(game, game.state.teams.p1.operativeIds[1]!, 'Ammo Resupply', { markerId }, { x: 10, y: 10.3 }).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
describe('Razor Wire', () => {
  it('"Razor wire is Exposed and Obstructing terrain" and costs "an additional 1"" to cross', () => {
    const game = makeGame(['eq.razorWire']);
    expect(place(game, 'eq.razorWire', 0, { x: 8, y: 11 }, 90).ok).toBe(true);
    const part = terrain(game.ctx, game.state).parts.find((p) => p.featureId === 'equip.p1.eq.razorWire.0')!;
    expect(hasType(part, 'Obstructing')).toBe(true);
    expect(hasType(part, 'Exposed')).toBe(true);
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    a.pos = { x: 6, y: 11 };
    const straight = validateMove(game.ctx, game.state, a, { points: [{ x: 10, y: 11 }] }, { action: 'Reposition' });
    expect(straight.total).toBe(5); // 4" of movement + 1" for the razor wire
  });
});

// ---------------------------------------------------------------------------
describe('Comms Device', () => {
  it('"While a friendly operative controls this marker, add 3" to the distance requirements of its SUPPORT rules"', () => {
    const game = makeGame(['eq.commsDevice']);
    expect(place(game, 'eq.commsDevice', 0, { x: 10, y: 11 }).ok).toBe(true);
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    expect(supportDistance(game.ctx, game.state, a, 6)).toBe(6);
    a.pos = { x: 10, y: 11.7 };
    expect(commsDeviceBonus(game.ctx, game.state, a)).toBe(3);
    expect(supportDistance(game.ctx, game.state, a, 6)).toBe(9);
    // "you cannot benefit from your opponent's Comms Device markers"
    const enemy = game.state.operatives[game.state.teams.p2.operativeIds[0]!]!;
    enemy.pos = { x: 10, y: 10.3 };
    expect(commsDeviceBonus(game.ctx, game.state, enemy)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Mines', () => {
  it('"more than 2" from other markers" and "the first time that marker is within an operative\'s control range... D3+3 damage"', () => {
    // Scripted d3: a rolled 4 halves (rounding up) to 2, so 2+3 = 5 damage.
    const game = makeGame(['eq.mines'], { script: [4] });
    // The test map's own objective marker sits at (8, 11).
    expect(validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.mines', 0, { x: 9, y: 11 }).ok).toBe(false);
    expect(place(game, 'eq.mines', 0, { x: 11.5, y: 11 }).ok).toBe(true);
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.operatives[a]!.pos = { x: 6, y: 11 };
    expect(act(game, a, 'Reposition', { path: { points: [{ x: 10.5, y: 11 }] } }).ok).toBe(true);
    expect(game.state.operatives[a]!.wounds).toBe(5);
    expect(game.state.markers['equip.p1.eq.mines.0']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('Barricades', () => {
  it('light barricades are Light terrain set up "more than 2" from other equipment terrain features"', () => {
    const game = makeGame(['eq.lightBarricades']);
    expect(place(game, 'eq.lightBarricades', 0, { x: 8, y: 11 }).ok).toBe(true);
    const second = validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.lightBarricades', 1, { x: 9, y: 11 });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('more than 2"');
    expect(place(game, 'eq.lightBarricades', 1, { x: 8, y: 15 }).ok).toBe(true);
    const parts = terrain(game.ctx, game.state).parts.filter((p) => p.featureId.includes('lightBarricades'));
    expect(parts.some((p) => hasType(p, 'Light'))).toBe(true);
    // "except the feet, which are Insignificant and Exposed"
    expect(parts.some((p) => hasType(p, 'Insignificant') && hasType(p, 'Exposed'))).toBe(true);
  });

  it('"A heavy barricade is Heavy terrain... set it up wholly within 4" of your drop zone"', () => {
    const game = makeGame(['eq.heavyBarricade']);
    // p1's drop zone is x 0..6, so 12" out is far too deep.
    expect(validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.heavyBarricade', 0, { x: 12, y: 11 }).ok).toBe(
      false,
    );
    expect(place(game, 'eq.heavyBarricade', 0, { x: 9, y: 11 }).ok).toBe(true);
    const part = terrain(game.ctx, game.state).parts.find((p) => p.featureId.includes('heavyBarricade'))!;
    expect(hasType(part, 'Heavy')).toBe(true);
    expect(part.z1).toBeCloseTo(45 / 25.4, 3);
  });
});

// ---------------------------------------------------------------------------
describe('Ladders', () => {
  it('"Upright against terrain that\'s at least 2" tall" and "more than 1" from doors and access points"', () => {
    const game = makeGame(['eq.ladders'], { features: [tower()] });
    // Out in the open: nothing to lean on.
    const open = validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.ladders', 0, { x: 5, y: 5 }, 90);
    expect(open.ok).toBe(false);
    expect(open.reason).toContain('2" tall');
    expect(place(game, 'eq.ladders', 0, { x: 9.85, y: 11 }, 90).ok).toBe(true);
    const feature = game.state.placedFeatures.find((f) => f.id === 'equip.p1.eq.ladders.0')!;
    // movement.ts keys the "treat the vertical distance as 1"" rule off this feature kind.
    expect(feature.kind).toBe('equipment.ladder');
    expect(feature.parts[0]!.z1).toBeCloseTo(95 / 25.4, 3);
    expect(feature.parts[0]!.types).toEqual(['Insignificant', 'Exposed']);
    // The second ladder must be more than 2" from the first.
    expect(validateEquipmentPlacement(game.ctx, game.state, 'p1', 'eq.ladders', 1, { x: 9.85, y: 12 }, 90).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
describe('Portable Barricade', () => {
  it('"MOVE WITH BARRICADE 1AP: ...can move no more than its Move stat minus 2"" and the barricade comes along', () => {
    const game = makeGame(['eq.portableBarricade']);
    expect(place(game, 'eq.portableBarricade', 0, { x: 6, y: 11 }).ok).toBe(true);
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.operatives[a]!.pos = { x: 5, y: 11 };
    expect(connectedBarricade(game.ctx, game.state, game.state.operatives[a]!)).toBeDefined();
    // Move 6" - 2" = 4" of budget: 5" is too far.
    expect(act(game, a, 'Move With Barricade', { path: { points: [{ x: 5, y: 6 }] } }).ok).toBe(false);
    expect(act(game, a, 'Move With Barricade', { path: { points: [{ x: 5, y: 8 }] } }).ok).toBe(true);
    const feature = game.state.placedFeatures.find((f) => f.id === 'equip.p1.eq.portableBarricade.0')!;
    expect(feature.placement.y).toBeCloseTo(8, 3); // it moved with its operative
    expect(connectedBarricade(game.ctx, game.state, game.state.operatives[a]!)).toBeDefined();
  });

  it('"Protective: While an operative is in cover from this terrain feature, improve its Save stat by 1"', () => {
    const game = makeGame(['eq.portableBarricade']);
    place(game, 'eq.portableBarricade', 0, { x: 6, y: 11 });
    const a = game.state.teams.p1.operativeIds[0]!;
    const enemy = game.state.teams.p2.operativeIds[0]!;
    game.state.operatives[a]!.pos = { x: 5, y: 11 };
    game.state.operatives[enemy]!.pos = { x: 12, y: 11 };
    const ev = game.ctx.hooks.emit('onDefenceDice', game.state, {
      state: game.state,
      ctx: attackContext(game, enemy, a),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.mods.save).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Utility Grenades', () => {
  it('"SMOKE GRENADE 1AP: Place one of your Smoke Grenade markers within 6" of this operative"', () => {
    const game = makeGame(['eq.utilityGrenades'], { script: [2] });
    const a = game.state.teams.p1.operativeIds[0]!;
    expect(act(game, a, 'Smoke Grenade', { targetPos: { x: 12, y: 11 } }, { x: 3, y: 11 }).ok).toBe(false); // 9" away
    expect(act(game, a, 'Smoke Grenade', { targetPos: { x: 8, y: 11 } }, { x: 3, y: 11 }).ok).toBe(true);
    const smoke = Object.values(game.state.markers).find((m) => m.kind === 'smoke')!;
    expect(smoke.pos).toEqual({ x: 8, y: 11 });
    // "In the Ready step of the next Strategy phase, roll one D3. Remove that marker after a
    // number of activations equal to that D3... or at the end of the turning point."
    game.state.turningPoint = 2;
    readyStep(game.ctx, game.state);
    expect(game.state.markers[smoke.id]!.flags['activationsLeft']).toBe(1); // scripted d3 of 2 -> 1
    endTurningPoint(game.ctx, game.state);
    expect(game.state.markers[smoke.id]).toBeUndefined();
  });

  it('"It must be visible to this operative, or on Vantage terrain of a terrain feature that\'s visible"', () => {
    // A 10"-tall Heavy wall between the thrower and the point. It is inside 6", and the old
    // check tested nothing but that range, so the grenade sailed straight through the wall.
    const game = makeGame(['eq.utilityGrenades'], { script: [2], features: [heavyBlock('wall', 5, 8, 1, 6, 10)] });
    const a = game.state.teams.p1.operativeIds[0]!;
    const behind = act(game, a, 'Smoke Grenade', { targetPos: { x: 8, y: 11 } }, { x: 3, y: 11 });
    expect(behind.ok).toBe(false);
    expect(behind.reason).toContain('visible');
    // Round the end of the wall and the same throw is legal.
    expect(act(game, a, 'Smoke Grenade', { targetPos: { x: 8, y: 4 } }, { x: 3, y: 4 }).ok).toBe(true);
  });

  it('"...an area of smoke 1" horizontally and unlimited height vertically from (but not below) it"', () => {
    // Smoke thrown from a 3" Vantage top onto the floor is measured from the FLOOR. The old
    // perform() stamped the thrower\'s own height on the marker, so smoke dropped off a gantry
    // started 3" up and did nothing at all to anyone standing in it.
    const game = makeGame(['eq.utilityGrenades'], { script: [2], features: [tower()] });
    const a = game.state.teams.p1.operativeIds[0]!;
    const thrower = game.state.operatives[a]!;
    thrower.z = 3;
    // At the east edge of the 3" tower (x 10-13), so the throw clears its own roofline.
    expect(act(game, a, 'Smoke Grenade', { targetPos: { x: 17.8, y: 11 } }, { x: 12.8, y: 11 }).ok).toBe(true);
    const smoke = Object.values(game.state.markers).find((m) => m.kind === 'smoke')!;
    expect(smoke.z).toBe(0);
    const victim = game.state.operatives[game.state.teams.p2.operativeIds[0]!]!;
    victim.pos = { x: 17.8, y: 11 };
    victim.z = 0;
    expect(whollyWithinSmoke(body(game.ctx, victim), smokeAreas(game.state))).toBe(true);
  });

  it('the Vantage clause: the rooftop is behind its own parapet, but the terrain feature is visible', () => {
    // The tower body is solid to 3", so a floor-level operative cannot see the marker resting
    // on its Vantage top — only the feature itself. `targetZ` names the level.
    const game = makeGame(['eq.utilityGrenades'], { script: [2], features: [tower()] });
    const a = game.state.teams.p1.operativeIds[0]!;
    const onTop = { targetPos: { x: 11, y: 11 }, targetZ: 3 };
    expect(act(game, a, 'Smoke Grenade', onTop, { x: 7, y: 11 }).ok).toBe(true);
    expect(Object.values(game.state.markers).find((m) => m.kind === 'smoke')!.z).toBe(3);
    // But `targetZ` still has to name a real surface at that point.
    const game2 = makeGame(['eq.utilityGrenades'], { script: [2], features: [tower()] });
    const b = game2.state.teams.p1.operativeIds[0]!;
    expect(act(game2, b, 'Smoke Grenade', { targetPos: { x: 11, y: 11 }, targetZ: 5 }, { x: 7, y: 11 }).ok).toBe(false);
  });

  it('"STUN GRENADE 1AP: ...on a 3+, subtract 1 from its APL stat", limited by the kill team\'s total uses', () => {
    // Two 4s: both stun tests pass.
    const game = makeGame(['eq.utilityGrenades'], { script: [4, 4] });
    const a = game.state.teams.p1.operativeIds[0]!;
    const enemy = game.state.teams.p2.operativeIds[0]!;
    const other = game.state.teams.p2.operativeIds[1]!;
    game.state.operatives[enemy]!.pos = { x: 8, y: 11 };
    game.state.operatives[other]!.pos = { x: 8, y: 12 }; // within 1" of the target
    expect(act(game, a, 'Stun Grenade', { targetOperativeId: enemy }, { x: 4, y: 11 }).ok).toBe(true);
    expect(aplOf(game.ctx, game.state, game.state.operatives[enemy]!)).toBe(1);
    expect(aplOf(game.ctx, game.state, game.state.operatives[other]!)).toBe(1);
    // The default selection is 1 smoke + 1 stun, so the kill team is out of stun grenades.
    expect(grenadesLeft(game.state, 'p1', 'eq.utilityGrenades', 'stun')).toBe(0);
    expect(act(game, game.state.teams.p1.operativeIds[1]!, 'Stun Grenade', { targetOperativeId: enemy }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Explosive Grenades', () => {
  it('frag is "ATK 4, HIT 4+, DMG 2/4, Range 6", Blast 2", Saturate" and krak "4/5, Range 6", Piercing 1, Saturate"', () => {
    const game = makeGame(['eq.explosiveGrenades']);
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    const weapons = weaponsOf(game.ctx, game.state, a, 'ranged');
    const frag = weapons.find((w) => w.name === 'Frag grenade')!;
    const krak = weapons.find((w) => w.name === 'Krak grenade')!;
    expect(frag.profiles[0]).toMatchObject({ atk: 4, hit: 4, dmgN: 2, dmgC: 4 });
    expect(frag.profiles[0]!.rules.map((r) => r.id).sort()).toEqual(['Blast', 'Range', 'Saturate']);
    expect(krak.profiles[0]).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 5 });
    expect(krak.profiles[0]!.rules.map((r) => r.id).sort()).toEqual(['Piercing', 'Range', 'Saturate']);
    expect(GRENADE_WEAPON_NAMES).toEqual(['Frag grenade', 'Krak grenade']);
  });

  it('"your kill team can only use that weapon a total number of times during the battle equal to your selection"', () => {
    const game = makeGame(['eq.explosiveGrenades']);
    const a = game.state.teams.p1.operativeIds[0]!;
    const enemy = game.state.teams.p2.operativeIds[0]!;
    expect(grenadesLeft(game.state, 'p1', 'eq.explosiveGrenades', 'frag')).toBe(1);
    // Collecting attack dice with the weapon spends the kill team's use of it.
    game.ctx.hooks.emit('onCollectAttackDice', game.state, {
      state: game.state,
      ctx: attackContext(game, a, enemy, 'Frag grenade'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(grenadesLeft(game.state, 'p1', 'eq.explosiveGrenades', 'frag')).toBe(0);
    const ev = game.ctx.hooks.emit('onSelectWeapon', game.state, {
      state: game.state,
      ctx: attackContext(game, a, enemy, 'Frag grenade'),
      allowed: true,
      dryRun: false,
    });
    expect(ev.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Breaching Charge', () => {
  it('"Once per battle... that operative can perform that action for 1 less AP (to a minimum of 1AP)"', () => {
    const game = makeGame(['eq.breachingCharge']);
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    const breach = getAction('Breach')!;
    expect(breach.ap).toBe(2);
    expect(actionCost(game.ctx, game.state, a, breach)).toBe(1);
    // Spent at the end of the activation in which a Breach was actually performed.
    a.actionsThisActivation = ['Breach'];
    game.ctx.hooks.emit('onActivationEnd', game.state, { state: game.state, operative: a });
    expect(actionCost(game.ctx, game.state, a, breach)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('set-up alternation', () => {
  it('"Each player alternates setting up an item of equipment... item by item, not option by option"', () => {
    const game = makeGame(['eq.lightBarricades', 'eq.ammoCache']);
    const items = ['eq.lightBarricades', 'eq.lightBarricades', 'eq.ammoCache'];
    expect(
      game.state.teams.p1.equipment.flatMap((id) => equipmentItems(id).map(() => id)),
    ).toEqual(items);
    expect(place(game, 'eq.lightBarricades', 0, { x: 8, y: 11 }).ok).toBe(true);
    // The same item cannot be set up twice.
    expect(place(game, 'eq.lightBarricades', 0, { x: 8, y: 16 }).ok).toBe(false);
    expect(game.state.setup.equipmentPlaced['p1' as PlayerId]).toBe(1);
  });
});
