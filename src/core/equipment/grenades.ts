/**
 * UTILITY GRENADES (smoke / stun) and EXPLOSIVE GRENADES (frag / krak).
 *
 * "When you select this equipment, select two utility grenades (2 smoke, 2 stun, or 1 smoke and
 * 1 stun). Each selection is a unique action your operatives can perform, but your kill team
 * can only perform that action a total number of times during the battle equal to your
 * selection." — the same shape for explosive grenades, which are ranged weapons instead.
 */
import { registerAction } from '../actions.ts';
import { terrain } from '../context.ts';
import { baseGap, dist } from '../geometry.ts';
import {
  addEffect,
  aliveOperatives,
  body,
  card,
  enemiesInControlRange,
  gapBetween,
  inflictDamage,
  log,
  recordRoll,
} from '../state.ts';
import { isVisible } from '../visibility.ts';
import { parseWeaponRules } from '../weaponRules.ts';
import { equipmentText, grenadeProfile } from './text.ts';
import type { EquipmentModule } from './kit.ts';
import type { GameState, PlayerId, Weapon } from '../types.ts';

export const UTILITY_ID = 'eq.utilityGrenades';
export const EXPLOSIVE_ID = 'eq.explosiveGrenades';

export const GRENADE_WEAPON_NAMES = ['Frag grenade', 'Krak grenade'];

// ---------------------------------------------------------------------------
// Selections and the kill-team-wide use counts
// ---------------------------------------------------------------------------

const allowanceKey = (equipmentId: string, choice: string): string => `${equipmentId}:${choice}`;
const usedKey = (equipmentId: string, choice: string): string => `used:${equipmentId}:${choice}`;

export function selectUtilityGrenades(state: GameState, player: PlayerId, smoke: number, stun: number): void {
  if (smoke + stun !== 2) throw new Error('Select exactly two utility grenades (2 smoke, 2 stun, or 1 of each).');
  const uses = state.teams[player].equipmentUses;
  uses[allowanceKey(UTILITY_ID, 'smoke')] = smoke;
  uses[allowanceKey(UTILITY_ID, 'stun')] = stun;
}

export function selectExplosiveGrenades(state: GameState, player: PlayerId, frag: number, krak: number): void {
  if (frag + krak !== 2) throw new Error('Select exactly two explosive grenades (2 frag, 2 krak, or 1 of each).');
  const uses = state.teams[player].equipmentUses;
  uses[allowanceKey(EXPLOSIVE_ID, 'frag')] = frag;
  uses[allowanceKey(EXPLOSIVE_ID, 'krak')] = krak;
}

export const grenadeAllowance = (state: GameState, player: PlayerId, equipmentId: string, choice: string): number =>
  state.teams[player].equipmentUses[allowanceKey(equipmentId, choice)] ?? 0;

export const grenadeUses = (state: GameState, player: PlayerId, equipmentId: string, choice: string): number =>
  state.teams[player].equipmentUses[usedKey(equipmentId, choice)] ?? 0;

export const grenadesLeft = (state: GameState, player: PlayerId, equipmentId: string, choice: string): number =>
  grenadeAllowance(state, player, equipmentId, choice) - grenadeUses(state, player, equipmentId, choice);

function spendGrenade(state: GameState, player: PlayerId, equipmentId: string, choice: string): void {
  const uses = state.teams[player].equipmentUses;
  uses[usedKey(equipmentId, choice)] = grenadeUses(state, player, equipmentId, choice) + 1;
}

/** The default split when a player selects the equipment without naming their two grenades. */
function defaultSelection(state: GameState, player: PlayerId, equipmentId: string, a: string, b: string): void {
  const uses = state.teams[player].equipmentUses;
  if (uses[allowanceKey(equipmentId, a)] === undefined && uses[allowanceKey(equipmentId, b)] === undefined) {
    uses[allowanceKey(equipmentId, a)] = 1;
    uses[allowanceKey(equipmentId, b)] = 1;
  }
}

// ---------------------------------------------------------------------------
// Utility grenades
// ---------------------------------------------------------------------------

registerAction({
  id: 'Smoke Grenade',
  name: 'Smoke Grenade',
  ap: 1,
  type: 'unique',
  sourceText: equipmentText(UTILITY_ID),
  available: (_ctx, state, op) =>
    state.teams[op.player].equipment.includes(UTILITY_ID) && grenadeAllowance(state, op.player, UTILITY_ID, 'smoke') > 0,
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (grenadesLeft(state, op.player, UTILITY_ID, 'smoke') <= 0)
      return { ok: false, reason: 'you have reached the total number of times your kill team can perform this action' };
    const pos = params.targetPos ?? params.markerPos;
    if (!pos) return { ok: false, reason: 'select where to place the Smoke Grenade marker' };
    if (dist(op.pos, pos) > 6 + 1e-6) return { ok: false, reason: 'the marker must be within 6" of this operative' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const pos = (params.targetPos ?? params.markerPos)!;
    const id = `smoke-${state.seq++}`;
    // The D3 that ends the marker is rolled here rather than in the next Ready step (the Ready
    // hook has no RNG); the value is applied at that Ready step. See docs/OPS.md.
    const d3 = ctx.rng.d3();
    recordRoll(state, 'smoke', [d3], op.player, 'Smoke Grenade duration');
    state.markers[id] = {
      id,
      kind: 'smoke',
      diameterMm: 20,
      pos: { ...pos },
      z: op.z,
      owner: op.player,
      flags: { activationsLeft: 999, d3, armed: false },
    };
    spendGrenade(state, op.player, UTILITY_ID, 'smoke');
    log(state, { kind: 'action', player: op.player, text: `${op.letter} throws a smoke grenade` });
    return { ok: true };
  },
});

registerAction({
  id: 'Stun Grenade',
  name: 'Stun Grenade',
  ap: 1,
  type: 'unique',
  sourceText: equipmentText(UTILITY_ID),
  available: (_ctx, state, op) =>
    state.teams[op.player].equipment.includes(UTILITY_ID) && grenadeAllowance(state, op.player, UTILITY_ID, 'stun') > 0,
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (grenadesLeft(state, op.player, UTILITY_ID, 'stun') <= 0)
      return { ok: false, reason: 'you have reached the total number of times your kill team can perform this action' };
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative' };
    if (gapBetween(ctx, op, target) > 6 + 1e-6) return { ok: false, reason: 'that operative is more than 6" away' };
    if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
      return { ok: false, reason: 'that operative is not visible' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const target = state.operatives[params.targetOperativeId!]!;
    spendGrenade(state, op.player, UTILITY_ID, 'stun');
    // "That operative and each other operative within 1" of it takes a stun test."
    const inBlast = aliveOperatives(state).filter(
      (o) =>
        o.id === target.id ||
        baseGap(o.pos, card(ctx, o).base, o.rot, target.pos, card(ctx, target).base, target.rot) <= 1 + 1e-6,
    );
    for (const victim of inBlast) {
      const roll = ctx.rng.d6();
      recordRoll(state, 'stun', [roll], op.player, `stun test vs ${victim.letter}`);
      // Rules that add to a stun test (Celestian Insidiants' PSYK-OUT GRENADES) read the
      // unmodified result and push damage of their own.
      const extra = ctx.hooks.emit('onStunTest', state, { state, thrower: op, target: victim, roll, damage: 0 }).damage;
      if (extra > 0) inflictDamage(ctx, state, victim, extra, 'other');
      if (roll < 3) continue;
      victim.aplMods.push(-1);
      addEffect(state, {
        rule: 'stunGrenade',
        source: { kind: 'equipment', id: UTILITY_ID },
        sourceText: equipmentText(UTILITY_ID),
        operativeId: victim.id,
        expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
      });
      log(state, { kind: 'action', player: victim.player, text: `${victim.letter} is stunned (-1 APL)` });
    }
    log(state, { kind: 'action', player: op.player, text: `${op.letter} throws a stun grenade` });
    return { ok: true };
  },
});

export const utilityGrenadesEquipment: EquipmentModule = {
  id: UTILITY_ID,
  name: 'Utility Grenades',
  scope: 'universal',
  text: equipmentText(UTILITY_ID),
  register(reg, player) {
    reg.on(
      'onSelectEquipment',
      { id: `${UTILITY_ID}.select`, sourceText: equipmentText(UTILITY_ID), player, priority: 10 },
      (ev, b) => {
        if (b.player !== ev.player) return;
        defaultSelection(ev.state, ev.player, UTILITY_ID, 'smoke', 'stun');
      },
    );
    // "In the Ready step of the next Strategy phase, roll one D3. Remove that Smoke Grenade
    // marker after a number of activations equal to that D3 have been completed..."
    reg.on(
      'onReadyStep',
      { id: `${UTILITY_ID}.smokeTimer`, sourceText: equipmentText(UTILITY_ID), player, priority: 10 },
      (ev, b) => {
        if (b.player !== ev.player) return;
        for (const marker of Object.values(ev.state.markers)) {
          if (marker.kind !== 'smoke' || marker.flags['armed']) continue;
          marker.flags['armed'] = true;
          marker.flags['activationsLeft'] = Number(marker.flags['d3'] ?? 1);
        }
      },
    );
    // "...or at the end of the turning point (whichever comes first)."
    reg.on(
      'onEndOfTP',
      { id: `${UTILITY_ID}.smokeEnd`, sourceText: equipmentText(UTILITY_ID), player, priority: 10 },
      (ev) => {
        for (const marker of Object.values(ev.state.markers)) {
          if (marker.kind === 'smoke' && marker.flags['armed']) delete ev.state.markers[marker.id];
        }
      },
    );
    // Smoke softens Piercing 2 / Piercing Crits 2 into Piercing 1 / Piercing Crits 1, which is
    // exactly one more defence die for the target.
    reg.on(
      'onDefenceDice',
      { id: `${UTILITY_ID}.piercing`, sourceText: equipmentText(UTILITY_ID), player, priority: 30 },
      (ev, b) => {
        const target = ev.ctx?.defender;
        if (!target || target.player !== b.player) return;
        if (ev.count <= 0) return;
        const piercing = ev.ctx.rules.find((r) => r.id === 'Piercing' || r.id === 'PiercingCrits');
        if (!piercing || (piercing.x ?? 0) < 2) return;
        if (ev.ctx.distance <= 2 + 1e-6) return; // "unless they're within 2" of each other"
        const inSmoke = Object.values(ev.state.markers).some(
          (m) => m.kind === 'smoke' && dist(m.pos, target.pos) <= 1 + 1e-6,
        );
        if (!inSmoke) return;
        ev.count += 1;
      },
    );
  },
};

// ---------------------------------------------------------------------------
// Explosive grenades
// ---------------------------------------------------------------------------

export function grenadeWeapon(id: 'frag' | 'krak'): Weapon {
  const p = grenadeProfile(id);
  return {
    name: p.name,
    profiles: [
      { type: 'ranged', atk: p.atk, hit: p.hit, dmgN: p.dmgN, dmgC: p.dmgC, rules: parseWeaponRules(p.rules) },
    ],
  };
}

const choiceOf = (weaponName: string): 'frag' | 'krak' => (weaponName === 'Krak grenade' ? 'krak' : 'frag');

/** Hand the selected grenades to every operative of that player. */
export function grantGrenades(state: GameState, player: PlayerId): void {
  const weapons: Weapon[] = [];
  if (grenadeAllowance(state, player, EXPLOSIVE_ID, 'frag') > 0) weapons.push(grenadeWeapon('frag'));
  if (grenadeAllowance(state, player, EXPLOSIVE_ID, 'krak') > 0) weapons.push(grenadeWeapon('krak'));
  if (weapons.length === 0) return;
  for (const op of aliveOperatives(state, player)) {
    const carrier = op as typeof op & { grantedWeapons?: Weapon[] };
    const have = new Set((carrier.grantedWeapons ?? []).map((w) => w.name));
    carrier.grantedWeapons = [...(carrier.grantedWeapons ?? []), ...weapons.filter((w) => !have.has(w.name))];
  }
}

export const explosiveGrenadesEquipment: EquipmentModule = {
  id: EXPLOSIVE_ID,
  name: 'Explosive Grenades',
  scope: 'universal',
  text: equipmentText(EXPLOSIVE_ID),
  register(reg, player) {
    reg.on(
      'onSelectEquipment',
      { id: `${EXPLOSIVE_ID}.select`, sourceText: equipmentText(EXPLOSIVE_ID), player, priority: 10 },
      (ev, b) => {
        if (b.player !== ev.player) return;
        defaultSelection(ev.state, ev.player, EXPLOSIVE_ID, 'frag', 'krak');
        grantGrenades(ev.state, ev.player);
      },
    );
    reg.on(
      'onDeploy',
      { id: `${EXPLOSIVE_ID}.grant`, sourceText: equipmentText(EXPLOSIVE_ID), player, priority: 10 },
      (ev, b) => {
        if (ev.operative.player !== b.player) return;
        grantGrenades(ev.state, b.player);
      },
    );
    reg.on(
      'onSelectWeapon',
      { id: `${EXPLOSIVE_ID}.limit`, sourceText: equipmentText(EXPLOSIVE_ID), player, priority: 10 },
      (ev, b) => {
        if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
        if (ev.ctx.attacker.player !== b.player) return;
        if (grenadesLeft(ev.state, b.player, EXPLOSIVE_ID, choiceOf(ev.ctx.weaponName)) > 0) return;
        ev.allowed = false;
        ev.reason = `your kill team has used every ${ev.ctx.weaponName}`;
      },
    );
    reg.on(
      'onCollectAttackDice',
      { id: `${EXPLOSIVE_ID}.spend`, sourceText: equipmentText(EXPLOSIVE_ID), player, priority: 10 },
      (ev, b) => {
        if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
        if (ev.ctx.attacker.player !== b.player) return;
        if (ev.ctx.secondary) return; // Blast secondaries are the same use of the weapon
        spendGrenade(ev.state, b.player, EXPLOSIVE_ID, choiceOf(ev.ctx.weaponName));
      },
    );
  },
};
