/**
 * The toolbox every kill-team module is built from.
 *
 * A team module NEVER reaches into a sequence: it registers typed handlers on the hook
 * points in `src/core/hooks.ts`, each carrying a `RuleBinding` with a short verbatim quote
 * of the printed rule (the UI shows those as tooltips) and the Wahapedia URL.
 */
import { registerAction, type ActionDef } from '../core/actions.ts';
import type { EquipmentDef, GameContext } from '../core/context.ts';
import { HookRegistry, type PloyDef, type RuleBinding, type TeamEquipmentDef, type TeamModule } from '../core/hooks.ts';
import {
  addEffect,
  aliveOperatives,
  card,
  gapBetween,
  log,
  operative,
  weaponsOf,
} from '../core/state.ts';
import { registerRareWeaponRule } from '../core/weaponRules.ts';
import type {
  ActiveEffect,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Weapon,
  WeaponRule,
  WeaponRuleId,
} from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';
import {
  selectionEntries,
  teamData,
  type TeamData,
  type TeamPloyText,
  type TeamRuleText,
} from './data.ts';
import { validateRosterFor, type RosterPickIn, type RosterValidation } from './selection.ts';

// ---------------------------------------------------------------------------
// Small predicates
// ---------------------------------------------------------------------------

export const ruleTag = (id: string, x?: number, raw?: string): WeaponRule => ({
  id: id as WeaponRuleId,
  ...(x !== undefined ? { x } : {}),
  raw: raw ?? (x !== undefined ? `${id} ${x}` : id),
});

export function keywordsOf(ctx: GameContext, op: OperativeState): string[] {
  return card(ctx, op).keywords;
}

export function hasKeyword(ctx: GameContext, op: OperativeState, keyword: string): boolean {
  return card(ctx, op).keywords.some((k) => k.toUpperCase() === keyword.toUpperCase());
}

/** "friendly <KEYWORD> operative" from the point of view of the rule's owner. */
export function isFriendlyKw(ctx: GameContext, op: OperativeState, player: PlayerId, keyword: string): boolean {
  return op.player === player && hasKeyword(ctx, op, keyword);
}

export function friendliesWithKeyword(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  keyword: string,
): OperativeState[] {
  return aliveOperatives(state, player).filter((o) => hasKeyword(ctx, o, keyword));
}

export function enemies(state: GameState, player: PlayerId): OperativeState[] {
  return aliveOperatives(state, otherPlayer(player));
}

export function isDatacard(ctx: GameContext, op: OperativeState, datacardId: string): boolean {
  return op.datacardId === datacardId;
}

/** Base-to-base distance; every team rule that says a number in inches uses this. */
export function apart(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  return gapBetween(ctx, a, b);
}

export function within(ctx: GameContext, a: OperativeState, b: OperativeState, inches: number): boolean {
  return gapBetween(ctx, a, b) <= inches + 1e-6;
}

/** Distance from an operative's base to a marker (markers are 20mm unless objectives). */
export function markerGap(ctx: GameContext, op: OperativeState, marker: MarkerState): number {
  const c = card(ctx, op);
  const dx = op.pos.x - marker.pos.x;
  const dy = op.pos.y - marker.pos.y;
  const centre = Math.hypot(dx, dy);
  const r = c.base.shape === 'round' ? c.base.mm / 2 / 25.4 : Math.max(c.base.mm[0], c.base.mm[1]) / 2 / 25.4;
  return Math.max(0, centre - r - marker.diameterMm / 2 / 25.4);
}

/** Horizontal distance between two points, for rules that say "horizontally". */
export function horizontal(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isInjured(ctx: GameContext, op: OperativeState): boolean {
  return op.wounds < card(ctx, op).wounds / 2;
}

// ---------------------------------------------------------------------------
// Ploy / gambit state
// ---------------------------------------------------------------------------

export const ployUsed = (state: GameState, player: PlayerId, ployId: string): boolean =>
  state.teams[player].ploysUsedTP.includes(ployId);

export const gambitUsed = (state: GameState, player: PlayerId, gambitId: string): boolean =>
  state.teams[player].gambitsUsedTP.includes(gambitId);

export const anyGambitUsed = (state: GameState, player: PlayerId, prefix: string): string[] =>
  state.teams[player].gambitsUsedTP.filter((g) => g.startsWith(prefix));

/** A namespaced, serialisable counter bucket. Nothing lives in module variables (rule 7). */
export function bucket(state: GameState, key: string): Record<string, unknown> {
  const b = (state.opState[key] ?? {}) as Record<string, unknown>;
  state.opState[key] = b;
  return b;
}

/** "Once per turning point" — true the first time it is asked in this turning point. */
export function useOncePerTP(state: GameState, key: string): boolean {
  const b = bucket(state, 'teamOnce');
  const stamp = `${state.turningPoint}`;
  if (b[key] === stamp) return false;
  b[key] = stamp;
  return true;
}

export function usedThisTP(state: GameState, key: string): boolean {
  return (bucket(state, 'teamOnce') as Record<string, unknown>)[key] === `${state.turningPoint}`;
}

/** "Once per battle". */
export function useOncePerBattle(state: GameState, key: string): boolean {
  const b = bucket(state, 'teamOnceBattle');
  if (b[key]) return false;
  b[key] = true;
  return true;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface EffectSpec {
  rule: string;
  source: ActiveEffect['source'];
  sourceText?: string;
  player?: PlayerId;
  operativeId?: string;
  data?: Record<string, unknown>;
  expiry?: ActiveEffect['expiry'];
}

export function effect(state: GameState, spec: EffectSpec): ActiveEffect {
  return addEffect(state, {
    rule: spec.rule,
    source: spec.source,
    ...(spec.sourceText ? { sourceText: spec.sourceText } : {}),
    ...(spec.player ? { player: spec.player } : {}),
    ...(spec.operativeId ? { operativeId: spec.operativeId } : {}),
    ...(spec.data ? { data: spec.data } : {}),
    expiry: spec.expiry ?? { kind: 'endOfTurningPoint' },
  });
}

export function effectOn(state: GameState, operativeId: string, rule: string): ActiveEffect | undefined {
  return state.effects.find((e) => e.rule === rule && e.operativeId === operativeId);
}

export function effectFor(state: GameState, player: PlayerId, rule: string): ActiveEffect | undefined {
  return state.effects.find((e) => e.rule === rule && e.player === player);
}

export function clearEffects(state: GameState, rule: string): void {
  state.effects = state.effects.filter((e) => e.rule !== rule);
}

// ---------------------------------------------------------------------------
// "…can immediately perform a free action"
// ---------------------------------------------------------------------------

export const FREE_ACTION_RULE = 'teamFreeAction';

/**
 * Kill Team's "perform a free 1AP action" is modelled as one extra AP for that operative,
 * restricted to the actions the rule names. The bonus is always the LAST AP the operative
 * spends, so `canPerformAction` refuses anything outside `only` (and any move action when
 * the rule says it cannot move) once the operative is spending it.
 *
 * The engine has no intent for "perform an action outside your activation", so a grant made
 * during the Strategy phase lands on that operative's next activation instead of resolving
 * immediately (docs/DECISIONS.md D-013).
 */
export function grantFreeAction(
  state: GameState,
  op: OperativeState,
  spec: { sourceId: string; sourceText: string; kind?: ActiveEffect['source']['kind']; only?: string[]; noMove?: boolean },
): void {
  op.aplMods.push(1);
  effect(state, {
    rule: FREE_ACTION_RULE,
    source: { kind: spec.kind ?? 'ploy', id: spec.sourceId },
    sourceText: spec.sourceText,
    operativeId: op.id,
    player: op.player,
    data: { ...(spec.only ? { only: spec.only } : {}), ...(spec.noMove ? { noMove: true } : {}) },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `${op.letter} gains a free ${spec.only ? spec.only.join('/') : '1AP'} action`,
    data: { operativeId: op.id, source: spec.sourceId },
  });
}

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/** Registers the restriction half of `grantFreeAction`. Called once per team module. */
export function registerFreeActionEngine(reg: HookRegistry, player: PlayerId, sourceUrl: string): void {
  const binding: RuleBinding = {
    id: `core.freeAction.${player}`,
    sourceText: 'One friendly operative can immediately perform a 1AP action for free.',
    sourceUrl,
    priority: 5,
    player,
  };
  reg.on('canPerformAction', binding, (ev) => {
    if (ev.operative.player !== player) return;
    const eff = effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE);
    if (!eff) return;
    const base = card2(ev.state, ev.operative);
    // Only bites once the operative is spending the bonus AP.
    if (ev.operative.apSpent < base) return;
    const only = (eff.data?.['only'] as string[] | undefined) ?? undefined;
    const noMove = Boolean(eff.data?.['noMove']);
    if (only && !only.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = `the free action must be ${only.join(' or ')}`;
    } else if (noMove && MOVE_ACTIONS.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'it cannot move during that action';
    }
  });
}

/** APL the operative would have without the free-action bonus. */
function card2(state: GameState, op: OperativeState): number {
  const bonus = op.aplMods.filter((m) => m > 0).length > 0 ? 1 : 0;
  const raw = op.aplMods.reduce((a, b) => a + b, 0);
  const clamped = Math.max(-1, Math.min(1, raw));
  // apSpent is compared against (APL - 1); we only need the threshold, not the card.
  return Math.max(0, clamped + 2 - bonus);
}

// ---------------------------------------------------------------------------
// Tokens and markers a team places
// ---------------------------------------------------------------------------

/** Team tokens (Poison, Scan, Marker Light…) live on the operative as an effect. */
export function tokenCount(state: GameState, operativeId: string, token: string): number {
  return state.effects.filter((e) => e.rule === token && e.operativeId === operativeId).length;
}

export function hasToken(state: GameState, operativeId: string, token: string, player?: PlayerId): boolean {
  return state.effects.some(
    (e) => e.rule === token && e.operativeId === operativeId && (player === undefined || e.player === player),
  );
}

export function giveToken(
  state: GameState,
  op: OperativeState,
  token: string,
  spec: { sourceId: string; sourceText: string; player: PlayerId; expiry?: ActiveEffect['expiry'] },
): void {
  if (hasToken(state, op.id, token, spec.player)) return;
  effect(state, {
    rule: token,
    source: { kind: 'ability', id: spec.sourceId },
    sourceText: spec.sourceText,
    operativeId: op.id,
    player: spec.player,
    expiry: spec.expiry ?? { kind: 'endOfBattle' },
  });
  log(state, { kind: 'action', player: spec.player, text: `${op.letter} gains a ${token} token` });
}

export function removeToken(state: GameState, operativeId: string, token: string): void {
  state.effects = state.effects.filter((e) => !(e.rule === token && e.operativeId === operativeId));
}

/** Place one of a player's own markers (Clearance Sweep, Mine, Scan…). */
export function placeMarker(
  state: GameState,
  spec: { id: string; kind: MarkerState['kind']; player: PlayerId; pos: { x: number; y: number }; z?: number; diameterMm?: number },
): MarkerState {
  const marker: MarkerState = {
    id: spec.id,
    kind: spec.kind,
    diameterMm: spec.diameterMm ?? 20,
    pos: { ...spec.pos },
    z: spec.z ?? 0,
    owner: spec.player,
    flags: {},
  };
  state.markers[marker.id] = marker;
  return marker;
}

export function removeMarker(state: GameState, id: string): void {
  delete state.markers[id];
}

export function ownMarker(state: GameState, id: string): MarkerState | undefined {
  return state.markers[id];
}

// ---------------------------------------------------------------------------
// Weapon granting
// ---------------------------------------------------------------------------

/** Equipment that says "friendly X operatives have the following melee weapon". */
export function grantWeapon(state: GameState, op: OperativeState, weapon: Weapon): void {
  const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
  holder.grantedWeapons = holder.grantedWeapons ?? [];
  if (!holder.grantedWeapons.some((w) => w.name === weapon.name)) holder.grantedWeapons.push(weapon);
}

export function hasWeaponNamed(ctx: GameContext, state: GameState, op: OperativeState, needle: string): boolean {
  return weaponsOf(ctx, state, op).some((w) => w.name.toLowerCase().includes(needle.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Team module assembly
// ---------------------------------------------------------------------------

export interface TeamAiHints {
  roles?: Record<string, 'leader' | 'sniper' | 'gunner' | 'melee' | 'support' | 'objective' | 'scout'>;
  ployValue?: Record<string, number>;
  equipmentValue?: Record<string, number>;
}

export interface KtTeamModule extends TeamModule {
  data: TeamData;
  /** Faction equipment as `EquipmentDef`s, for `GameContext.equipment`. */
  equipmentDefs: EquipmentDef[];
  /** Pure selection-rule check, per the team's printed selection requirements. */
  validateRoster(picks: RosterPickIn[]): RosterValidation;
  datacards: Datacard[];
}

export interface TeamSpec {
  id: string;
  /** Registers faction rules, abilities and unique-action hooks. */
  rules(reg: HookRegistry, player: PlayerId, data: TeamData): void;
  /** Registers the mechanical effect of each ploy (strategy + firefight). */
  ploys(reg: HookRegistry, player: PlayerId, data: TeamData): void;
  /** Registers the mechanical effect of each faction equipment option. */
  equipment(reg: HookRegistry, player: PlayerId, data: TeamData, selected: string[]): void;
  /** Unique actions; registered once at module load, gated by `available`. */
  actions?(data: TeamData): ActionDef[];
  /** Rare weapon rules used by this team's datacards. */
  rareRules?: string[];
  /** Extra ploy legality beyond CP and once-per-turning-point. */
  ployUsable?: Record<string, PloyDef['usable']>;
  aiHints?: TeamAiHints;
  /** Which strategy ploys are offered as STRATEGIC GAMBITs (default: all four). */
  gambits?(reg: HookRegistry, player: PlayerId, data: TeamData): void;
}

/** Which equipment options a player selected, as ids on their TeamState. */
export function selectedEquipment(state: GameState, player: PlayerId): string[] {
  return state.teams[player].equipment;
}

export function hasEquipment(state: GameState, player: PlayerId, id: string): boolean {
  return state.teams[player].equipment.includes(id);
}

export function bindingFor(data: TeamData, rule: TeamRuleText, player: PlayerId, priority = 10): RuleBinding {
  return {
    id: `${rule.id}.${player}`,
    sourceText: shortQuote(rule.text),
    sourceUrl: data.sourceUrl,
    priority,
    player,
  };
}

/** Rule tooltips want a sentence, not a page. */
export function shortQuote(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut) + '…';
}

/**
 * Build the `TeamModule`. Ploys, equipment and gambit offers are derived from the JSON so a
 * data refresh cannot desynchronise the printed text from the mechanics.
 */
export function defineTeam(spec: TeamSpec): KtTeamModule {
  const data = teamData(spec.id);
  const ploys: PloyDef[] = [
    ...data.strategyPloys.map(
      (p): PloyDef => ({
        id: p.id,
        name: p.name,
        kind: 'strategy',
        cp: p.cp,
        text: p.text,
        ...(spec.ployUsable?.[p.id] ? { usable: spec.ployUsable[p.id] } : {}),
      }),
    ),
    ...data.firefightPloys.map(
      (p): PloyDef => ({
        id: p.id,
        name: p.name,
        kind: 'firefight',
        cp: p.cp,
        text: p.text,
        ...(spec.ployUsable?.[p.id] ? { usable: spec.ployUsable[p.id] } : {}),
      }),
    ),
  ];

  const equipment: TeamEquipmentDef[] = data.equipment.map((e) => ({ id: e.id, name: e.name, text: e.text }));

  // Rare weapon rules must be registered before any datacard using them is linted.
  for (const id of spec.rareRules ?? data.rareWeaponRules) {
    registerRareWeaponRule(id, rareRuleText(id), data.id);
  }

  // Unique actions live in the global action registry; each is gated to its own datacard.
  for (const def of spec.actions?.(data) ?? []) registerAction(def);

  const register = (reg: HookRegistry, player: PlayerId): void => {
    registerFreeActionEngine(reg, player, data.sourceUrl);
    spec.rules(reg, player, data);
    spec.ploys(reg, player, data);
    spec.equipment(reg, player, data, []);
    if (spec.gambits) spec.gambits(reg, player, data);
    else defaultGambits(reg, player, data);
  };

  return {
    id: data.id,
    data,
    datacards: data.datacards,
    register,
    ploys,
    equipment,
    equipmentDefs: data.equipment.map((e) => ({
      id: e.id,
      name: e.name,
      text: e.text,
      scope: 'faction' as const,
      teamId: data.id,
    })),
    validateRoster: (picks: RosterPickIn[]) => validateRosterFor(data, picks),
    ...(spec.aiHints ? { aiHints: spec.aiHints } : {}),
  };
}

/**
 * "STRATEGIC GAMBIT" — strategy ploys are used in the Gambit step of the Strategy phase.
 * Offered only when the player can pay for them.
 */
export function defaultGambits(reg: HookRegistry, player: PlayerId, data: TeamData): void {
  for (const ploy of data.strategyPloys) {
    reg.on(
      'gambitOptions',
      bindingFor(data, ploy, player, 20),
      (ev) => {
        if (ev.player !== player) return;
        if (ev.state.teams[player].cp < ploy.cp) return;
        ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
      },
    );
  }
}

/** The verbatim rare-rule definitions, from data/teams/_rare-weapon-rules.json. */
const RARE_RULE_TEXT: Record<string, string> = {
  AntiPSYKER:
    'Whenever this weapon is being used against an operative that has the PSYKER keyword, add 1 to both Dmg stats of this weapon and it has the Lethal 5+ weapon rule.',
  ConcealedPosition: 'This operative can only use this weapon the first time it’s performing the Shoot action during the battle.',
  Detonate:
    'Don’t select a valid target. Instead, shoot against each operative within 2" of your Mine marker, unless Heavy terrain is wholly intervening between that operative and that marker. Each of those operatives cannot be in cover or obscured. Roll each sequence separately in an order of your choice. This weapon cannot be selected if your Mine marker isn’t in the killzone. At the end of the action, remove your Mine marker from the killzone. In a killzone that uses the close quarters rules (e.g. Killzone: Tomb World), this weapon has the Lethal 5+ weapon rule.',
  Explosive:
    'This operative can perform the Shoot action with this weapon while within control range of an enemy operative. Don’t select a valid target. Instead, this operative is always the primary target and cannot be in cover or obscured.',
  Magnify:
    'Whenever this operative is performing the Shoot action with this weapon, if the target is visible to this operative, and another friendly HIEROTEK CIRCLE APPRENTEK or HIEROTEK CIRCLE CRYPTEK operative that has an Engage order and isn’t within control range of enemy operatives is visible to this operative, you can use this rule. If you do, treat that operative as the active operative for the purposes of determining a valid target, cover and obscured. If you do, this weapon has the Ceaseless weapon rule until the end of that action.',
  PSYCHIC: 'PSYCHIC: a weapon keyword; rules that refer to PSYCHIC weapons and actions use it.',
  Poison:
    'In the Resolve Attack Dice step, if you inflict damage with any successes, the operative this weapon is being used against (excluding friendly PLAGUE MARINE operatives) gains one of your Poison tokens (if it doesn’t already have one). Whenever an operative that has one of your Poison tokens is activated, inflict 1 damage on it.',
  Shield:
    'Whenever this operative is fighting or retaliating with this weapon, each of your blocks can be allocated to block two unresolved successes (instead of one).',
  Toxic:
    'Whenever this operative is using this weapon against an enemy operative that has one of your Poison tokens, add 1 to both Dmg stats of this weapon.',
};

export function rareRuleText(id: string): string {
  const t = RARE_RULE_TEXT[id];
  if (!t) throw new Error(`No verbatim text for rare weapon rule '${id}' — add it to RARE_RULE_TEXT`);
  return t;
}

// ---------------------------------------------------------------------------
// Unique-action scaffolding
// ---------------------------------------------------------------------------

/** Build a unique action from the datacard's printed entry; only that datacard may do it. */
export function uniqueAction(
  data: TeamData,
  datacardId: string,
  actionId: string,
  impl: Omit<ActionDef, 'id' | 'name' | 'ap' | 'type' | 'sourceText' | 'available'> & {
    available?: ActionDef['available'];
  },
): ActionDef {
  const cardDef = data.datacards.find((c) => c.id === datacardId);
  const printed = cardDef?.uniqueActions.find((a) => a.id === actionId);
  if (!cardDef || !printed) throw new Error(`No unique action '${actionId}' on '${datacardId}'`);
  return {
    id: printed.id,
    name: printed.name,
    ap: printed.ap,
    type: 'unique',
    sourceText: `${printed.name} ${printed.ap}AP: ${printed.text}`,
    available: (ctx, state, op) => op.datacardId === datacardId && (impl.available?.(ctx, state, op) ?? true),
    check: impl.check,
    perform: impl.perform,
    ...(impl.treatedAs ? { treatedAs: impl.treatedAs } : {}),
  };
}

/** Actions that may not be performed within control range of an enemy — a very common rider. */
export function notEngaged(ctx: GameContext, state: GameState, op: OperativeState): { ok: boolean; reason?: string } {
  const engaged = enemies(state, op.player).some((e) => {
    const idx = require0(ctx, state, op, e);
    return idx;
  });
  return engaged ? { ok: false, reason: 'within control range of an enemy operative' } : { ok: true };
}

function require0(ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean {
  // Local import avoids a cycle with state.ts's control-range helper set.
  return inControl(ctx, state, a, b);
}

let inControlImpl: ((ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState) => boolean) | null = null;
export function setControlRangeImpl(fn: typeof inControlImpl): void {
  inControlImpl = fn;
}
function inControl(ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean {
  return inControlImpl ? inControlImpl(ctx, state, a, b) : false;
}

export { operative, aliveOperatives, card, log, weaponsOf };
