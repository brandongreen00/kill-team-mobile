/**
 * HIEROTEK CIRCLE — Necrons. https://wahapedia.ru/kill-team3/kill-teams/hierotek-circle/
 * Rule text is read from `data/teams/hierotek-circle.json`.
 *
 * Reanimation Protocols is the spine of the team: an incapacitated operative leaves a
 * Reanimation marker, and the Ready step of each Strategy phase offers the player a choice of
 * marker to roll for — a real reactive decision, raised through `GameContext.decisionHandlers`.
 */
import { getAction } from '../../core/actions.ts';
import { terrain } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card,
  enemiesInControlRange,
  inflictDamage,
  log,
  recordRoll,
  settleZ,
} from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import type { GameContext } from '../../core/context.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import type { GameState, MarkerState, OperativeState, PendingDecision, PlayerId, WeaponProfile } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('hierotek-circle');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const KW = 'HIEROTEK CIRCLE';
export const REANIMATION_DECISION = 'hierotek.reanimation';
const REANIMATION_FLAG = 'reanimation';
const DEATHMARKED = 'hierotek.deathmarked';
const MADNESS = 'hierotek.madness';

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

// ---------------------------------------------------------------------------
// Reanimation Protocols
// ---------------------------------------------------------------------------

export const reanimationMarkers = (state: GameState, player: PlayerId): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.flags[REANIMATION_FLAG] === true && m.owner === player);

/** "The FIRST time each friendly HIEROTEK CIRCLE operative is incapacitated…" */
function markerAlreadyUsed(state: GameState, operativeId: string): boolean {
  return Boolean((state.opState['hierotek.reanimated'] as Record<string, boolean> | undefined)?.[operativeId]);
}
function markReanimationUsed(state: GameState, operativeId: string): void {
  const b = (state.opState['hierotek.reanimated'] ?? {}) as Record<string, boolean>;
  b[operativeId] = true;
  state.opState['hierotek.reanimated'] = b;
}

/** "Set up the operative that Reanimation marker was placed for (it's no longer incapacitated)." */
function reanimate(
  ctx: GameContext | undefined,
  state: GameState,
  marker: MarkerState,
  order: 'engage' | 'conceal',
  opts: { expended?: boolean } = {},
): boolean {
  const opId = String(marker.flags['forOperative'] ?? '');
  const op = state.operatives[opId];
  if (!op || !ctx) return false;
  // "It must be placed within 3" of that Reanimation marker and not within control range of
  //  enemy operatives (if you cannot do so, treat the roll as 1-2 instead)."
  const spot = reanimationSpot(ctx, state, marker, op);
  if (!spot) return false;
  op.removed = false;
  op.incapacitated = false;
  op.pos = spot;
  settleZ(ctx, state, op);
  op.wounds = 1; // "It has 1 wound remaining."
  op.order = order; // "It has an order of your choice and is ready."
  op.ready = !opts.expended;
  op.expended = Boolean(opts.expended);
  op.apSpent = 0;
  op.actionsThisActivation = [];
  op.aplMods = [];
  op.onGuard = false;
  removeMarker(state, marker.id);
  log(state, { kind: 'action', player: op.player, text: `${op.name} is REANIMATED (1 wound, ${order})` });
  // Living Metal resolves "after resolving all other rules in this step", so an operative
  // reanimated during the Ready step still regains its D3+1.
  if (livingMetalDone(state, op.player)) livingMetal(ctx, state, op);
  return true;
}

function reanimationSpot(
  ctx: GameContext,
  state: GameState,
  marker: MarkerState,
  op: OperativeState,
): { x: number; y: number } | undefined {
  const clear = (p: { x: number; y: number }): boolean => {
    const probe: OperativeState = { ...op, pos: p, removed: false, incapacitated: false };
    if (enemiesInControlRange(ctx, state, probe).length > 0) return false;
    return aliveOperatives(state).every((o) => o.id === op.id || dist(o.pos, p) > 1.2);
  };
  const candidates = [marker.pos];
  for (let r = 1; r <= 3; r++) {
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      candidates.push({ x: marker.pos.x + Math.cos(ang) * r, y: marker.pos.y + Math.sin(ang) * r });
    }
  }
  return candidates.find(
    (p) => p.x > 0 && p.y > 0 && p.x < state.map.board.w && p.y < state.map.board.h && clear(p),
  );
}

function livingMetalDone(state: GameState, player: PlayerId): boolean {
  const b = (state.opState['hierotek.livingMetal'] ?? {}) as Record<string, number>;
  return b[player] === state.turningPoint;
}
function markLivingMetal(state: GameState, player: PlayerId): void {
  const b = (state.opState['hierotek.livingMetal'] ?? {}) as Record<string, number>;
  b[player] = state.turningPoint;
  state.opState['hierotek.livingMetal'] = b;
}

/** "…each friendly HIEROTEK CIRCLE operative regains up to D3+1 lost wounds." */
function livingMetal(ctx: GameContext, state: GameState, op: OperativeState): void {
  const heal = ctx.rng.d3() + 1;
  recordRoll(state, 'livingMetal', [heal], op.player, 'Living Metal D3+1');
  const max = card(ctx, op).wounds;
  if (op.wounds >= max) return;
  op.wounds = Math.min(max, op.wounds + heal);
}

/** The Ready-step decision: which Reanimation marker to roll for. */
function offerReanimation(T: TeamHooks, state: GameState, tried: string[]): void {
  const markers = reanimationMarkers(state, T.player).filter((m) => !tried.includes(m.id));
  if (markers.length === 0) return;
  const options: PendingDecision['options'] = [];
  for (const m of markers.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const opId = String(m.flags['forOperative'] ?? '');
    const name = state.operatives[opId]?.name ?? '?';
    for (const order of ['engage', 'conceal'] as const) {
      options.push({
        id: `${m.id}|${order}`,
        label: `Roll for ${name}'s Reanimation marker (${order})`,
        data: { markerId: m.id, order, tried },
      });
    }
  }
  state.pending.push({
    id: `reanimate-${state.seq++}`,
    who: T.player,
    kind: REANIMATION_DECISION,
    prompt: 'Reanimation Protocols: select one of your Reanimation markers and roll one D6',
    sourceText: shortQuote(text('hierotek-circle.rule.reanimation-protocols')),
    options,
  });
}

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== REANIMATION_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const markerId = String(payload['markerId'] ?? '');
  const order = (payload['order'] === 'engage' ? 'engage' : 'conceal') as 'engage' | 'conceal';
  const tried = [...((payload['tried'] as string[] | undefined) ?? []), markerId];
  const marker = state.markers[markerId];
  const player = decision.who;
  if (!marker) return true;
  const roll = ctx.rng.d6();
  recordRoll(state, 'reanimation', [roll], player, 'Reanimation Protocols 3+');
  // "on a 1-2, leave that Reanimation marker in the killzone and repeat this process with a
  //  different one of your Reanimation markers (if any); on a 3+, an operative is REANIMATED."
  const revived = roll >= 3 && reanimate(ctx, state, marker, order);
  if (revived) return true;
  const T = { player } as TeamHooks;
  offerReanimation(T, state, tried);
  return true;
}

// ---------------------------------------------------------------------------
// Magnify (rare weapon rule)
// ---------------------------------------------------------------------------

const isMagnify = (profile: WeaponProfile): boolean => profile.rules.some((r) => r.id === 'Magnify');

/**
 * "…another friendly HIEROTEK CIRCLE APPRENTEK or HIEROTEK CIRCLE CRYPTEK operative that has
 * an Engage order and isn't within control range of enemy operatives is visible to this
 * operative … treat that operative as the active operative for the purposes of determining a
 * valid target, cover and obscured."
 *
 * MAGNIFICATION CONDUITS widens the proxy to any friendly HIEROTEK CIRCLE operative (excluding
 * PLASMACYTE) once per turning point.
 */
export function magnifyProxy(
  T: TeamHooks,
  state: GameState,
  shooter: OperativeState,
  target: OperativeState,
): OperativeState | undefined {
  if (!T.ctx) return undefined;
  const index = terrain(T.ctx, state);
  const conduits =
    hasEquipment(state, T.player, 'hierotek-circle.eq.magnification-conduits') &&
    !usedThisTP(state, `hierotek.conduits:${T.player}`);
  const eligible = T.friendlies(state, KW).filter((o) => {
    if (o.id === shooter.id || o.order !== 'engage') return false;
    if (enemiesInControlRange(T.ctx!, state, o).length > 0) return false;
    const canal = T.kw(o, 'APPRENTEK') || T.kw(o, 'CRYPTEK');
    if (!canal && !(conduits && !T.kw(o, 'PLASMACYTE'))) return false;
    if (!isVisible(index, body(T.ctx!, shooter), body(T.ctx!, o)).visible) return false;
    return isVisible(index, body(T.ctx!, o), body(T.ctx!, target)).visible;
  });
  return eligible.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Reanimation Protocols ---------------------------------------------
  reg.on('onIncapacitated', T.bind('hierotek-circle.rule.reanimation-protocols', 11), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || ev.prevented) return;
    if (markerAlreadyUsed(ev.state, op.id)) return;
    markReanimationUsed(ev.state, op.id);
    const id = `hierotek.reanimation.${T.player}.${op.id}`;
    placeTeamMarker(ev.state, {
      id,
      kind: 'generic',
      player: T.player,
      pos: { ...op.pos },
      z: op.z,
      flags: { [REANIMATION_FLAG]: true, forOperative: op.id },
    });
    // "…also removing any tokens and rules effects it had."
    dropEffects(ev.state, (e) => e.operativeId === op.id);
    op.aplMods = [];
    log(ev.state, { kind: 'action', player: T.player, text: `${op.name} leaves a Reanimation marker` });
  });
  reg.on('onReadyStep', T.bind('hierotek-circle.rule.reanimation-protocols', 12), (ev) => {
    if (ev.player !== T.player) return;
    offerReanimation(T, ev.state, []);
  });

  // ---- Living Metal -------------------------------------------------------
  reg.on('onReadyStep', T.bind('hierotek-circle.rule.living-metal', 13), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    for (const op of T.friendlies(ev.state, KW)) livingMetal(T.ctx, ev.state, op);
    markLivingMetal(ev.state, T.player);
  });

  // ---- Magnify ------------------------------------------------------------
  reg.on('onValidTarget', T.bind('hierotek-circle.rule.magnify', 12), (ev) => {
    if (ev.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    const profile = seq ? weaponProfile(T, ev.attacker, seq.weaponName, seq.profileName) : undefined;
    if (!profile || !isMagnify(profile)) return;
    if (!T.ctx) return;
    // "…if the target is visible to this operative" — Magnify never creates a shot the
    // operative could not otherwise see.
    const index = terrain(T.ctx, ev.state);
    if (!isVisible(index, body(T.ctx, ev.attacker), body(T.ctx, ev.target)).visible) return;
    const proxy = magnifyProxy(T, ev.state, ev.attacker, ev.target);
    if (!proxy) return;
    ev.viewFrom = proxy;
  });
  reg.on('onWeaponRules', T.bind('hierotek-circle.rule.magnify', 13), (ev) => {
    if (!isMagnify(ev.profile) || !T.mine(ev.operative) || !ev.target) return;
    if (!magnifyProxy(T, ev.state, ev.operative, ev.target)) return;
    // "…this weapon has the Ceaseless weapon rule until the end of that action."
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Magnify)'));
  });
  reg.on('onCollectAttackDice', T.bind('hierotek-circle.eq.magnification-conduits', 14), (ev) => {
    // The conduits' once-per-turning-point use is spent the first time it actually matters.
    if (ev.ctx.attacker.player !== T.player || ev.ctx.type !== 'ranged') return;
    if (!isMagnify(ev.ctx.profile) || !ev.ctx.defender) return;
    if (!hasEquipment(ev.state, T.player, 'hierotek-circle.eq.magnification-conduits')) return;
    const proxy = magnifyProxy(T, ev.state, ev.ctx.attacker, ev.ctx.defender);
    if (!proxy || T.kw(proxy, 'APPRENTEK') || T.kw(proxy, 'CRYPTEK')) return;
    useOncePerTP(ev.state, `hierotek.conduits:${T.player}`);
  });

  // ---- APPRENTEK › Apprentek Assistance (once per turning point) ----------
  reg.on('canPerformAction', T.bind('hierotek-circle.apprentek.apprentek-assistance', 12), (ev) => {
    if (ev.operative.datacardId !== 'hierotek-circle.apprentek' || ev.operative.player !== T.player) return;
    if (!CRYPTEK_ACTION_IDS.has(ev.action)) return;
    if (usedThisTP(ev.state, `hierotek.apprentek:${ev.operative.id}`)) {
      ev.allowed = false;
      ev.reason = 'it can only perform one CRYPTEK unique action per turning point';
    }
  });

  // ---- IMMORTAL › Steadfast ----------------------------------------------
  reg.on('onMarkerControl', T.bind('hierotek-circle.immortal-guardian.steadfast', 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    for (const op of T.friendlies(ev.state, 'IMMORTAL')) {
      if (T.markerGap(op, marker) > 1 + 1e-6) continue;
      // "you can treat this operative's APL stat as 3 … any changes to its APL stat are ignored"
      ev.aplByPlayer[T.player] += 3 - aplOf(T.ctx, ev.state, op);
    }
  });

  // ---- DEATHMARK › Deathmarked -------------------------------------------
  reg.on('onStrikeResolved', T.bind('hierotek-circle.deathmark.deathmarked', 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.datacardId !== 'hierotek-circle.deathmark') return;
    if (ev.ctx.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary) return; // "(the primary target, if relevant)"
    if (ev.struck.incapacitated || ev.struck.removed) return; // "if it wasn't incapacitated"
    if (effectOn(ev.state, ev.struck.id, DEATHMARKED)) return;
    effect(ev.state, {
      rule: DEATHMARKED,
      source: { kind: 'ability', id: 'hierotek-circle.deathmark.deathmarked' },
      sourceText: shortQuote(abilityText('hierotek-circle.deathmark', 'hierotek-circle.deathmark.deathmarked')),
      operativeId: ev.struck.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.struck.name} gains a DEATHMARKed token` });
  });
  reg.on('onWeaponRules', T.bind('hierotek-circle.deathmark.deathmarked', 13), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.datacardId !== 'hierotek-circle.deathmark') return;
    if (!T.mine(ev.operative) || !ev.target) return;
    const token = effectOn(ev.state, ev.target.id, DEATHMARKED);
    if (!token || token.player !== T.player) return;
    ev.rules.push(ruleTag('Seek', undefined, 'Seek (Deathmarked)'));
  });
  // MULTI-DIMENSIONAL VISION: "whenever it's shooting, enemy operatives cannot be obscured".
  reg.on('onCollectAttackDice', T.bind('hierotek-circle.deathmark.act.multi-dimensional-vision', 14), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, 'hierotek.multiDimensionalVision')) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false;
  });

  // ---- PLASMACYTE › Scuttler ---------------------------------------------
  reg.on('canPerformAction', T.bind('hierotek-circle.plasmacyte-accelerator.scuttler', 12), (ev) => {
    if (!PLASMACYTES.includes(ev.operative.datacardId) || ev.operative.player !== T.player) return;
    const own = ev.operative.datacardId === 'hierotek-circle.plasmacyte-accelerator' ? ACCELERATE : REANIMATE_ACTIONS;
    const allowed = ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot', 'Pick Up Marker', 'Place Marker', ...own];
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a PLASMACYTE cannot perform that unique action';
    }
  });
  reg.on('onActionCost', T.bind('hierotek-circle.plasmacyte-accelerator.scuttler', 13), (ev) => {
    if (!PLASMACYTES.includes(ev.operative.datacardId) || ev.operative.player !== T.player) return;
    if (ev.action === 'Fall Back') ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onValidTarget', T.bind('hierotek-circle.plasmacyte-accelerator.scuttler', 14), (ev) => {
    if (!PLASMACYTES.includes(ev.target.datacardId) || ev.target.player !== T.player) return;
    if (ev.target.order !== 'conceal' || !T.ctx) return;
    if (T.gap(ev.attacker, ev.target) <= 2 + 1e-6) return; // "except being within 2""
    const index = terrain(T.ctx, ev.state);
    const a = body(T.ctx, ev.attacker);
    const t = body(T.ctx, ev.target);
    // Scuttler needs it to be in cover; the engine's own cover test decides that.
    const parts = index.parts.filter((p) => p.types.includes('Heavy') || p.types.includes('Light'));
    const inCover = parts.some(
      (p) => dist({ x: (p.bounds.min.x + p.bounds.max.x) / 2, y: (p.bounds.min.y + p.bounds.max.y) / 2 }, t.pos) <= 1 + 1e-6,
    );
    if (!inCover) return;
    void a;
    ev.valid = false;
    ev.reason = 'Scuttler: the PLASMACYTE is concealed in cover';
  });

  // ---- PSYCHOMANCER › Vision of Madness (the token's activation test) ----
  reg.on('onActivationStart', T.bind('hierotek-circle.psychomancer.act.vision-of-madness', 12), (ev) => {
    const token = effectOn(ev.state, ev.operative.id, MADNESS);
    if (!token || token.player !== T.player || !T.ctx) return;
    // "you can roll one D6: if the result is equal to or higher than that enemy operative's
    //  APL, they cannot activate it during this activation." Rolled here and logged; the
    //  engine has no way to hand the activation back, so a failed activation is recorded and
    //  the token is removed (see docs/TEAM-STATUS.md).
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'visionOfMadness', [roll], T.player, 'VISION OF MADNESS');
    if (roll >= aplOf(T.ctx, ev.state, ev.operative)) {
      ev.operative.aplMods.push(-1);
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.name} is gripped by madness (-1 APL)` });
    }
    dropEffects(ev.state, (e) => e === token);
  });

  // ---- CHRONOMANCER › Chronometron / Countertemporal Nanomine -------------
  reg.on('onCollectAttackDice', T.bind('hierotek-circle.chronomancer.act.chronometron', 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !effectOn(ev.state, target.id, 'hierotek.chronometron')) return;
    ev.count = Math.max(0, ev.count - 1); // "subtract 1 from the Atk stat of an operative's weapons"
  });
  reg.on('onStatMod', T.bind('hierotek-circle.chronomancer.act.countertemporal-nanomine', 13), (ev) => {
    if (ev.operative.player === T.player) return;
    const marker = Object.values(ev.state.markers).find(
      (m) => m.flags['nanomine'] === true && m.owner === T.player,
    );
    if (!marker) return;
    if (dist(marker.pos, ev.operative.pos) > 4 + 1e-6) return;
    ev.mods.move -= 2; // "subtract 2" from its Move stat"
  });

  // ---- PSYCHOMANCER › Harbinger of Despair / Nightmare Shroud ------------
  reg.on('onActionCost', T.bind('hierotek-circle.psychomancer.act.harbinger-of-despair', 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const marker = Object.values(ev.state.markers).find((m) => m.flags['despair'] === true && m.owner === T.player);
    if (!marker) return;
    if (dist(marker.pos, ev.operative.pos) > 2 + 1e-6) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    ev.ap += 1; // "your opponent must spend 1 additional AP"
  });
  reg.on('onMarkerControl', T.bind('hierotek-circle.psychomancer.act.harbinger-of-despair', 13), (ev) => {
    const despair = Object.values(ev.state.markers).find((m) => m.flags['despair'] === true && m.owner === T.player);
    const marker = ev.state.markers[ev.markerId];
    if (!despair || !marker) return;
    const foe = T.player === 'p1' ? 'p2' : 'p1';
    const near = T.enemies(ev.state).some(
      (e) => T.markerGap(e, marker) <= 1 + 1e-6 && dist(despair.pos, e.pos) <= 2 + 1e-6,
    );
    if (near) ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });
  reg.on('onRollAttack', T.bind('hierotek-circle.psychomancer.act.nightmare-shroud', 14), (ev) => {
    if (ev.ctx.attacker.player === T.player) return;
    const shroud = T.friendlies(ev.state).find(
      (o) => effectOn(ev.state, o.id, 'hierotek.nightmareShroud') && T.gap(o, ev.ctx.attacker) <= 4 + 1e-6,
    );
    if (!shroud) return;
    ev.rerolls = []; // "your opponent cannot re-roll their attack dice"
  });
  reg.on('onWeaponRules', T.bind('hierotek-circle.psychomancer.act.nightmare-shroud', 15), (ev) => {
    if (T.mine(ev.operative)) return;
    const shroud = T.friendlies(ev.state).find(
      (o) => effectOn(ev.state, o.id, 'hierotek.nightmareShroud') && T.gap(o, ev.operative) <= 4 + 1e-6,
    );
    if (!shroud) return;
    // "…cannot retain attack dice results of less than 6 as critical successes."
    ev.rules = ev.rules.filter((r) => !['Lethal', 'Rending', 'Severe'].includes(r.id));
  });

  // ---- TECHNOMANCER › Augment Weapon / Reinforce Metal -------------------
  reg.on('onWeaponRules', T.bind('hierotek-circle.technomancer.act.augment-weapon', 12), (ev) => {
    const augment = effectOn(ev.state, ev.operative.id, 'hierotek.augmentWeapon');
    if (!augment || augment.player !== T.player) return;
    if (augment.data?.['weapon'] !== ev.weaponName) return;
    for (const id of (augment.data?.['rules'] as string[] | undefined) ?? []) {
      if (id === 'Lethal') ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Augment Weapon)'));
      else ev.rules.push(ruleTag(id, undefined, `${id} (Augment Weapon)`));
    }
  });
  reg.on('onDamage', T.bind('hierotek-circle.technomancer.act.reinforce-metal', 13), (ev) => {
    if (ev.kind !== 'attack' || ev.amount < 3) return;
    if (!effectOn(ev.state, ev.target.id, 'hierotek.reinforceMetal')) return;
    ev.amount -= 1; // "subtract 1 from that inflicted damage"
  });
}

const PLASMACYTES = ['hierotek-circle.plasmacyte-accelerator', 'hierotek-circle.plasmacyte-reanimator'];
const ACCELERATE = ['hierotek-circle.plasmacyte-accelerator.act.accelerate'];
const REANIMATE_ACTIONS = [
  'hierotek-circle.plasmacyte-reanimator.act.reanimate',
  'hierotek-circle.plasmacyte-reanimator.act.reanimate-certain',
];

function weaponProfile(
  T: TeamHooks,
  op: OperativeState,
  weaponName: string,
  profileName?: string,
): WeaponProfile | undefined {
  const weapon = T.card(op)?.weapons.find((w) => w.name === weaponName);
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // RELENTLESS ONSLAUGHT (strategy)
  reg.on('onWeaponRules', T.bind('hierotek-circle.sp.relentless-onslaught', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'hierotek-circle.sp.relentless-onslaught')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    // "Note that when you're using the Magnify weapon rule, this operative must still be
    //  within 8" of the target to use this rule."
    if (T.gap(ev.operative, ev.target) > 8 + 1e-6) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Relentless Onslaught)'));
  });

  // UNDYING ANDROIDS (strategy)
  reg.on('onDefenceDice', T.bind('hierotek-circle.sp.undying-androids', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'hierotek-circle.sp.undying-androids')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.state.sequence?.kind !== 'shoot') return;
    if (ev.coverSave) return; // "if you cannot retain any cover saves"
    ev.coverSave = true; // one auto-retained normal success
  });

  // METHODICAL ELIMINATION (strategy)
  reg.on('onWeaponRules', T.bind('hierotek-circle.sp.methodical-elimination', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'hierotek-circle.sp.methodical-elimination')) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    const moved = ev.operative.actionsThisActivation.some((a) => ['Charge', 'Reposition', 'Fall Back'].includes(a));
    const x = ev.retaliating || !moved ? 2 : 1;
    ev.rules.push(ruleTag('Accurate', x, `Accurate ${x} (Methodical Elimination)`));
  });

  // COMMAND UNDERLINGS (strategy)
  reg.on('onPloyUsed', T.bind('hierotek-circle.sp.command-underlings', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'hierotek-circle.sp.command-underlings') return;
    const viaApprentek = ev.data?.['choice'] === 'apprentek';
    const anchors = T.friendlies(ev.state, viaApprentek ? 'APPRENTEK' : 'CRYPTEK');
    const range = viaApprentek ? 3 : 6;
    for (const op of T.friendlies(ev.state, KW)) {
      if (anchors.some((a) => a.id === op.id)) continue; // "each OTHER friendly operative"
      if (viaApprentek && T.kw(op, 'CRYPTEK')) continue;
      if (!anchors.some((a) => T.gap(a, op) <= range + 1e-6)) continue;
      grantFreeAction(ev.state, op, {
        sourceId: 'hierotek-circle.sp.command-underlings',
        sourceText: shortQuote(text('hierotek-circle.sp.command-underlings')),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
  });

  // CORTICAL CONTROL (firefight)
  reg.on('onSupportDistance', T.bind('hierotek-circle.fp.cortical-control', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'hierotek-circle.fp.cortical-control')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!T.kw(ev.operative, 'APPRENTEK') && !T.kw(ev.operative, 'CRYPTEK')) return;
    ev.inches = 1000; // "ignore the distance requirement (only visibility is a requirement)"
  });

  // REANIMATED FUNCTION (firefight)
  reg.on('onPloyUsed', T.bind('hierotek-circle.fp.reanimated-function', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'hierotek-circle.fp.reanimated-function') return;
    const markers = reanimationMarkers(ev.state, T.player);
    const chosen = (ev.data?.['markerId'] as string | undefined) ?? markers[0]?.id;
    if (!chosen) return;
    const store = (ev.state.opState['hierotek.reanimatedFunction'] ?? {}) as Record<string, string>;
    store[T.player] = chosen;
    ev.state.opState['hierotek.reanimatedFunction'] = store;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Reanimated Function: a Reanimation marker holds the objective' });
  });
  reg.on('onMarkerControl', T.bind('hierotek-circle.fp.reanimated-function', 21), (ev) => {
    const store = (ev.state.opState['hierotek.reanimatedFunction'] ?? {}) as Record<string, string>;
    const chosen = store[T.player];
    const marker = ev.state.markers[ev.markerId];
    const reanim = chosen ? ev.state.markers[chosen] : undefined;
    if (!marker || !reanim) return;
    if (dist(marker.pos, reanim.pos) > 1 + marker.diameterMm / 2 / 25.4 + 1e-6) return;
    ev.aplByPlayer[T.player] += 1; // "…a friendly operative that has an APL stat of 1"
  });

  // LIVING LIGHTNING (firefight)
  reg.on('onWeaponRules', T.bind('hierotek-circle.fp.living-lightning', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'hierotek-circle.fp.living-lightning')) return;
    if (!T.mineKw(ev.operative, 'IMMORTAL') || !/tesla carbine/i.test(ev.weaponName)) return;
    ev.rules = ev.rules.map((r) =>
      r.id === 'Devastating' && r.dist !== undefined ? { id: 'Devastating', x: r.x ?? 1, raw: `Devastating ${r.x ?? 1}` } : r,
    );
    ev.rules.push(ruleTag('Blast', 2, 'Blast 2"'));
  });

  // DIMENSIONAL AMBUSH (firefight)
  reg.on('canPerformAction', T.bind('hierotek-circle.fp.dimensional-ambush', 20), (ev) => {
    if (ev.action !== 'Guard') return;
    if (ev.operative.datacardId !== 'hierotek-circle.deathmark' || ev.operative.player !== T.player) return;
    if (!ployUsed(ev.state, T.player, 'hierotek-circle.fp.dimensional-ambush')) return;
    ev.allowed = true;
    ev.reason = undefined as unknown as string | undefined;
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // PHASE SHIFTER — "worsen the x of the Piercing weapon rule by 1 (if any)", once per TP.
  reg.on('onDefenceDice', T.bind('hierotek-circle.eq.phase-shifter', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'hierotek-circle.eq.phase-shifter')) return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || !T.kw(target, 'CRYPTEK')) return;
    if (ev.count <= 0) return;
    const piercing = ev.ctx.rules.find((r) => r.id === 'Piercing');
    if (!piercing) return;
    if (!useOncePerTP(ev.state, `hierotek.phaseShifter:${T.player}`)) return;
    ev.count += 1;
  });

  // TESSERACT CUBE — "In the Ready step of each Strategy phase, when you gain CP…"
  reg.on('onReadyStep', T.bind('hierotek-circle.eq.tesseract-cube', 31), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, 'hierotek-circle.eq.tesseract-cube')) return;
    const store = (ev.state.opState['hierotek.tesseract'] ?? {}) as Record<string, { gained: number; dead: boolean }>;
    const mine = store[T.player] ?? { gained: 0, dead: false };
    if (mine.dead || mine.gained >= 2) return;
    const cryptek = T.friendlies(ev.state, 'CRYPTEK').find(
      (o) => !o.incapacitated && enemiesInControlRange(T.ctx!, ev.state, o).length === 0,
    );
    if (!cryptek) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'tesseractCube', [roll], T.player, 'Tesseract Cube');
    if (roll === 1) mine.dead = true; // "on a 1, you cannot use this rule for the rest of the battle"
    else if (roll >= 4) {
      ev.cp += 1;
      mine.gained += 1;
    }
    store[T.player] = mine;
    ev.state.opState['hierotek.tesseract'] = store;
  });

  // TESLA WEAVE — "when an enemy operative ends the Charge action with friendly HIEROTEK
  // CIRCLE operatives within its control range … inflict D3+1 damage", once per turning point.
  reg.on('onActivationEnd', T.bind('hierotek-circle.eq.tesla-weave', 32), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'hierotek-circle.eq.tesla-weave')) return;
    if (ev.operative.player === T.player || !T.ctx) return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    if (!T.friendlies(ev.state, KW).some((o) => T.gap(o, ev.operative) <= 1 + 1e-6)) return;
    if (!useOncePerTP(ev.state, `hierotek.teslaWeave:${T.player}`)) return;
    const dmg = T.ctx.rng.d3() + 1;
    recordRoll(ev.state, 'teslaWeave', [dmg], T.player, 'Tesla Weave D3+1');
    inflictDamage(T.ctx, ev.state, ev.operative, dmg, 'other');
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const CRYPTEKS = ['hierotek-circle.chronomancer', 'hierotek-circle.psychomancer', 'hierotek-circle.technomancer'];
const CRYPTEK_ACTION_IDS = new Set<string>();

/**
 * A CRYPTEK unique action. APPRENTEK Assistance: "This operative has the same unique actions as
 * your CRYPTEK operative selected for the battle" — so the APPRENTEK may perform it too, once
 * per turning point (enforced by `canPerformAction` above).
 */
function cryptekAction(
  cardId: string,
  actionId: string,
  impl: Parameters<typeof uniqueAction>[3],
) {
  CRYPTEK_ACTION_IDS.add(actionId);
  const def = uniqueAction(DATA, cardId, actionId, impl);
  return {
    ...def,
    available: (ctx: GameContext, state: GameState, op: OperativeState): boolean => {
      if (op.datacardId === cardId) return true;
      if (op.datacardId !== 'hierotek-circle.apprentek') return false;
      return aliveOperatives(state, op.player).some((o) => o.datacardId === cardId);
    },
    perform: (ctx: GameContext, state: GameState, op: OperativeState, params: Parameters<typeof def.perform>[3]) => {
      const res = def.perform(ctx, state, op, params);
      if (res.ok && op.datacardId === 'hierotek-circle.apprentek') useOncePerTP(state, `hierotek.apprentek:${op.id}`);
      return res;
    },
  };
}

function actions(data: typeof DATA) {
  const out = [];

  // INTERSTITIAL COMMAND 1AP (SUPPORT) — every CRYPTEK and the IMMORTAL DESPOTEK.
  for (const cardId of [...CRYPTEKS, 'hierotek-circle.immortal-despotek']) {
    const printed = data.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.name === 'INTERSTITIAL COMMAND');
    if (!printed) continue;
    const impl = {
      check: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (state.opState['counteract']?.['operativeId'] === op.id)
          return { ok: false, reason: 'this operative cannot perform this action while counteracting' };
        return interstitialTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly HIEROTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
        const target = interstitialTarget(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(1);
        effect(state, {
          rule: 'hierotek.interstitialCommand',
          source: { kind: 'ability', id: printed.id },
          sourceText: shortQuote(printed.text),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: target.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: INTERSTITIAL COMMAND (${target.name})` });
        return { ok: true };
      },
    };
    out.push(cardId === 'hierotek-circle.immortal-despotek' ? uniqueAction(data, cardId, printed.id, impl) : cryptekAction(cardId, printed.id, impl));
  }

  // CHRONOMANCER
  out.push(
    cryptekAction('hierotek-circle.chronomancer', 'hierotek-circle.chronomancer.act.timesplinter', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (state.turningPoint <= 1) return { ok: false, reason: 'not during the first turning point' };
        if (usedThisTP(state, `hierotek.timesplinter:${op.player}`))
          return { ok: false, reason: 'a friendly operative has already performed this action this turning point' };
        return timesplinterTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one expended friendly operative visible to and within 5"' };
      },
      perform: (ctx, state, op, params) => {
        const target = timesplinterTarget(ctx, state, op, params.targetOperativeId)!;
        useOncePerTP(state, `hierotek.timesplinter:${op.player}`);
        const spot = params.targetPos ?? { x: op.pos.x + 1.5, y: op.pos.y };
        target.pos = { ...spot };
        settleZ(ctx, state, target);
        log(state, { kind: 'action', player: op.player, text: `${op.name}: TIMESPLINTER moves ${target.name}` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.chronomancer', 'hierotek-circle.chronomancer.act.countertemporal-nanomine', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op, params) => {
        for (const m of Object.values(state.markers)) if (m.flags['nanomine'] === true && m.owner === op.player) removeMarker(state, m.id);
        placeTeamMarker(state, {
          id: `hierotek.nanomine.${op.player}`,
          kind: 'generic',
          player: op.player,
          pos: params.targetPos ?? { ...op.pos },
          z: op.z,
          flags: { nanomine: true },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: COUNTERTEMPORAL NANOMINE` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.chronomancer', 'hierotek-circle.chronomancer.act.chronometron', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return supportTarget(ctx, state, op, params.targetOperativeId, true)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly HIEROTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = supportTarget(ctx, state, op, params.targetOperativeId, true)!;
        dropEffects(state, (e) => e.rule === 'hierotek.chronometron' && e.player === op.player);
        effect(state, {
          rule: 'hierotek.chronometron',
          source: { kind: 'ability', id: 'hierotek-circle.chronomancer.act.chronometron' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: CHRONOMETRON on ${target.name}` });
        return { ok: true };
      },
    }),
  );

  // PSYCHOMANCER
  out.push(
    cryptekAction('hierotek-circle.psychomancer', 'hierotek-circle.psychomancer.act.harbinger-of-despair', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op, params) => {
        for (const m of Object.values(state.markers)) if (m.flags['despair'] === true && m.owner === op.player) removeMarker(state, m.id);
        placeTeamMarker(state, {
          id: `hierotek.despair.${op.player}`,
          kind: 'generic',
          player: op.player,
          pos: params.targetPos ?? { ...op.pos },
          z: op.z,
          flags: { despair: true },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: HARBINGER OF DESPAIR` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.psychomancer', 'hierotek-circle.psychomancer.act.nightmare-shroud', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === 'hierotek.nightmareShroud' && e.player === op.player);
        effect(state, {
          rule: 'hierotek.nightmareShroud',
          source: { kind: 'ability', id: 'hierotek-circle.psychomancer.act.nightmare-shroud' },
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: NIGHTMARE SHROUD` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.psychomancer', 'hierotek-circle.psychomancer.act.vision-of-madness', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return visibleEnemy(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = visibleEnemy(ctx, state, op, params.targetOperativeId)!;
        dropEffects(state, (e) => e.rule === MADNESS && e.player === op.player);
        effect(state, {
          rule: MADNESS,
          source: { kind: 'ability', id: 'hierotek-circle.psychomancer.act.vision-of-madness' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: VISION OF MADNESS on ${target.name}` });
        return { ok: true };
      },
    }),
  );

  // TECHNOMANCER
  out.push(
    cryptekAction('hierotek-circle.technomancer', 'hierotek-circle.technomancer.act.canoptek-repair', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `hierotek.repair:${op.player}`))
          return { ok: false, reason: 'a friendly operative has already performed this action this turning point' };
        return supportTarget(ctx, state, op, params.targetOperativeId, true)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly HIEROTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = supportTarget(ctx, state, op, params.targetOperativeId, true)!;
        useOncePerTP(state, `hierotek.repair:${op.player}`);
        const heal = ctx.rng.d3() + ctx.rng.d3();
        recordRoll(state, 'canoptekRepair', [heal], op.player, 'CANOPTEK REPAIR 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.name}: CANOPTEK REPAIR (+${heal})` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.technomancer', 'hierotek-circle.technomancer.act.augment-weapon', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return supportTarget(ctx, state, op, params.targetOperativeId, true)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly HIEROTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = supportTarget(ctx, state, op, params.targetOperativeId, true)!;
        const weapon = ctx.datacards.get(target.datacardId)?.weapons[0];
        if (!weapon) return { ok: false, reason: 'that operative has no weapon to augment' };
        // "select two of the following weapon rules … Lethal 5+, Rending, Saturate, Severe"
        const picked = (params.choice ?? 'Lethal,Rending').split(',').filter((r) => ['Lethal', 'Rending', 'Saturate', 'Severe'].includes(r));
        const chosenRules = picked.length === 2 ? picked : ['Lethal', 'Rending'];
        dropEffects(state, (e) => e.rule === 'hierotek.augmentWeapon' && e.player === op.player);
        effect(state, {
          rule: 'hierotek.augmentWeapon',
          source: { kind: 'ability', id: 'hierotek-circle.technomancer.act.augment-weapon' },
          operativeId: target.id,
          player: op.player,
          data: { weapon: weapon.name, rules: chosenRules },
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: AUGMENT WEAPON (${chosenRules.join(' + ')})` });
        return { ok: true };
      },
    }),
    cryptekAction('hierotek-circle.technomancer', 'hierotek-circle.technomancer.act.reinforce-metal', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return supportTarget(ctx, state, op, params.targetOperativeId, true)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly HIEROTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = supportTarget(ctx, state, op, params.targetOperativeId, true)!;
        dropEffects(state, (e) => e.rule === 'hierotek.reinforceMetal' && e.player === op.player);
        effect(state, {
          rule: 'hierotek.reinforceMetal',
          source: { kind: 'ability', id: 'hierotek-circle.technomancer.act.reinforce-metal' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: REINFORCE METAL on ${target.name}` });
        return { ok: true };
      },
    }),
  );

  // DEATHMARK › MULTI-DIMENSIONAL VISION 1AP
  out.push(
    uniqueAction(data, 'hierotek-circle.deathmark', 'hierotek-circle.deathmark.act.multi-dimensional-vision', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        effect(state, {
          rule: 'hierotek.multiDimensionalVision',
          source: { kind: 'ability', id: 'hierotek-circle.deathmark.act.multi-dimensional-vision' },
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: MULTI-DIMENSIONAL VISION` });
        return { ok: true };
      },
    }),
  );

  // PLASMACYTE ACCELERATOR › ACCELERATE 1AP
  out.push(
    uniqueAction(data, 'hierotek-circle.plasmacyte-accelerator', 'hierotek-circle.plasmacyte-accelerator.act.accelerate', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return accelerateTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly DEATHMARK or IMMORTAL operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = accelerateTarget(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(1);
        effect(state, {
          rule: 'hierotek.accelerate',
          source: { kind: 'ability', id: 'hierotek-circle.plasmacyte-accelerator.act.accelerate' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: ACCELERATE (${target.name} +1 APL)` });
        return { ok: true };
      },
    }),
  );

  // PLASMACYTE REANIMATOR › REANIMATE 2AP (and the 3AP automatic version)
  out.push(
    uniqueAction(data, 'hierotek-circle.plasmacyte-reanimator', 'hierotek-circle.plasmacyte-reanimator.act.reanimate', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return reanimateMarker(state, op, params.markerId)
          ? { ok: true }
          : { ok: false, reason: 'select one of your Reanimation markers visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const marker = reanimateMarker(state, op, params.markerId)!;
        const roll = ctx.rng.d6();
        recordRoll(state, 'reanimate', [roll], op.player, 'REANIMATE 3+');
        if (roll >= 3) reanimate(ctx, state, marker, params.choice === 'engage' ? 'engage' : 'conceal', { expended: true });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: REANIMATE (${roll})` });
        return { ok: true };
      },
    }),
  );

  return out;
}

function interstitialTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen?: string,
): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 6);
  const mates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => {
      const kws = ctx.datacards.get(o.datacardId)?.keywords ?? [];
      return !kws.includes('APPRENTEK') && !kws.includes('CRYPTEK');
    })
    .filter((o) => inSupportReach(ctx, state, op, o, range))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function inSupportReach(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  other: OperativeState,
  range: number,
): boolean {
  const gap = Math.max(0, dist(op.pos, other.pos) - 1.6);
  if (gap > range + 1e-6) return false;
  return isVisible(terrain(ctx, state), body(ctx, op), body(ctx, other)).visible;
}

function supportTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen: string | undefined,
  includeSelf: boolean,
): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 6);
  const mates = aliveOperatives(state, op.player)
    .filter((o) => includeSelf || o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => o.id === op.id || inSupportReach(ctx, state, op, o, range))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function timesplinterTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen?: string,
): OperativeState | undefined {
  const mates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && o.expended)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => inSupportReach(ctx, state, op, o, supportDistance(ctx, state, op, 5)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function visibleEnemy(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const enemies = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1')
    .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return enemies.find((e) => e.id === chosen) ?? enemies[0];
}

function accelerateTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen?: string,
): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 6);
  const mates = aliveOperatives(state, op.player)
    .filter((o) => {
      const kws = ctx.datacards.get(o.datacardId)?.keywords ?? [];
      return kws.includes('DEATHMARK') || kws.includes('IMMORTAL');
    })
    .filter((o) => inSupportReach(ctx, state, op, o, range))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function reanimateMarker(state: GameState, op: OperativeState, chosen?: string): MarkerState | undefined {
  const markers = reanimationMarkers(state, op.player)
    .filter((m) => dist(m.pos, op.pos) <= 6 + 1.6)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return markers.find((m) => m.id === chosen) ?? markers[0];
}

// ---------------------------------------------------------------------------

export const hierotekCircle = defineTeam({
  id: 'hierotek-circle',
  rareRules: ['Magnify'],
  rules: (reg, T) => {
    rules(reg, T);
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  aiHints: {
    roles: {
      'hierotek-circle.chronomancer': 'leader',
      'hierotek-circle.psychomancer': 'leader',
      'hierotek-circle.technomancer': 'leader',
      'hierotek-circle.apprentek': 'support',
      'hierotek-circle.deathmark': 'sniper',
      'hierotek-circle.immortal-despotek': 'objective',
      'hierotek-circle.immortal-guardian': 'objective',
      'hierotek-circle.plasmacyte-accelerator': 'support',
      'hierotek-circle.plasmacyte-reanimator': 'support',
    },
    ployValue: {
      'hierotek-circle.sp.relentless-onslaught': 0.6,
      'hierotek-circle.sp.undying-androids': 0.6,
      'hierotek-circle.sp.methodical-elimination': 0.5,
      'hierotek-circle.sp.command-underlings': 0.4,
      'hierotek-circle.fp.cortical-control': 0.3,
      'hierotek-circle.fp.reanimated-function': 0.5,
      'hierotek-circle.fp.living-lightning': 0.5,
      'hierotek-circle.fp.dimensional-ambush': 0.3,
    },
    equipmentValue: {
      'hierotek-circle.eq.magnification-conduits': 0.5,
      'hierotek-circle.eq.phase-shifter': 0.4,
      'hierotek-circle.eq.tesseract-cube': 0.5,
      'hierotek-circle.eq.tesla-weave': 0.5,
    },
  },
});

export default hierotekCircle;
