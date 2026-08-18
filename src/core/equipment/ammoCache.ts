/**
 * 1X AMMO CACHE.
 *
 * "Before the battle, you can set up one of your Ammo Cache markers wholly within your
 * territory... AMMO RESUPPLY 0AP: One of your Ammo Cache markers the active operative controls
 * is used during this turning point. Until the start of the next turning point, whenever this
 * operative is shooting with a weapon from its datacard, you can re-roll one of your attack
 * dice."
 */
import { registerAction } from '../actions.ts';
import { hasEffect } from '../hooks.ts';
import { addEffect, enemiesInControlRange, log, markerContestedBy } from '../state.ts';
import { equipmentText } from './text.ts';
import { GRENADE_WEAPON_NAMES } from './grenades.ts';
import type { EquipmentModule } from './kit.ts';

export const ID = 'eq.ammoCache';
const EFFECT = 'ammoResupply';

registerAction({
  id: 'Ammo Resupply',
  name: 'Ammo Resupply',
  ap: 0,
  type: 'mission',
  sourceText: equipmentText(ID),
  available: (_ctx, state, op) => state.teams[op.player].equipment.includes(ID),
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker || marker.kind !== 'ammoCache') return { ok: false, reason: 'select an Ammo Cache marker' };
    if (marker.owner !== op.player) return { ok: false, reason: 'that marker is not yours' };
    if (marker.flags['usedTP'] === state.turningPoint)
      return { ok: false, reason: 'that marker has been used this turning point' };
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'the active operative does not control that marker' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags['usedTP'] = state.turningPoint;
    addEffect(state, {
      rule: EFFECT,
      source: { kind: 'equipment', id: ID },
      sourceText: equipmentText(ID),
      player: op.player,
      operativeId: op.id,
      // "Until the start of the next turning point"
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(state, { kind: 'action', player: op.player, text: `${op.name} resupplies from an Ammo Cache` });
    return { ok: true };
  },
});

export const ammoCacheEquipment: EquipmentModule = {
  id: ID,
  name: 'Ammo Cache',
  scope: 'universal',
  text: equipmentText(ID),
  items: [{ kind: 'marker', markerKind: 'ammoCache', constraints: ['whollyWithinTerritory'] }],
  register(reg, player) {
    reg.on(
      'onRollAttack',
      { id: `${ID}.reroll`, sourceText: equipmentText(ID), player, priority: 30 },
      (ev, b) => {
        const attacker = ev.ctx.attacker;
        if (attacker.player !== b.player) return;
        if (ev.ctx.type !== 'ranged') return;
        // "with a weapon from its datacard" — not the equipment grenades.
        if (GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
        if (!hasEffect(ev.state, EFFECT, { operativeId: attacker.id })) return;
        ev.rerolls.push({
          id: 'ammoResupply',
          label: 'Ammo Cache: re-roll one of your attack dice',
          mode: 'one',
          max: 1,
          sourceText: equipmentText(ID),
          player: b.player,
        });
      },
    );
  },
};
