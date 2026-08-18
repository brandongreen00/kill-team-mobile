/**
 * The toolbox every kill-team module is built from.
 *
 * A team module NEVER reaches into a sequence: it registers typed handlers on the hook points
 * in `src/core/hooks.ts`, each carrying a `RuleBinding` with a short verbatim quote of the
 * printed rule (the UI shows those as tooltips) and the Wahapedia URL.
 *
 * Hook handlers are not given a `GameContext`, so `register(reg, player, ctx)` captures it in
 * a small `TeamHooks` facade (`T`) that every rule uses for datacards and geometry. When no
 * context is supplied the facade falls back to the static datacard catalogue built from
 * `data/teams/*.json` — a catalogue, not game state.
 */
import { registerAction, type ActionDef } from '../core/actions.ts';
import type { EquipmentDef, GameContext } from '../core/context.ts';
import { baseGap } from '../core/geometry.ts';
import { HookRegistry, type PloyDef, type RuleBinding, type TeamEquipmentDef, type TeamModule } from '../core/hooks.ts';
import {
  addEffect,
  aliveOperatives,
  aplOf,
  enemiesInControlRange,
  log,
} from '../core/state.ts';
import { registerRareWeaponRule } from '../core/weaponRules.ts';
import type {
  ActiveEffect,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponRule,
  WeaponRuleId,
} from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';
import { TEAM_DATA, teamData, type TeamData, type TeamRuleText } from './data.ts';
import { validateRosterFor, type RosterPickIn, type RosterValidation } from './selection.ts';
import rareRulesJson from '../../data/teams/_rare-weapon-rules.json';

// ---------------------------------------------------------------------------
// Static datacard catalogue
// ---------------------------------------------------------------------------

const CATALOGUE = new Map<string, Datacard>();
for (const data of Object.values(TEAM_DATA)) for (const c of data.datacards) CATALOGUE.set(c.id, c);

export function catalogueCard(datacardId: string): Datacard | undefined {
  return CATALOGUE.get(datacardId);
}

export const ruleTag = (id: string, x?: number, raw?: string): WeaponRule => ({
  id: id as WeaponRuleId,
  ...(x !== undefined ? { x } : {}),
  raw: raw ?? (x !== undefined ? `${id} ${x}` : id),
});

// ---------------------------------------------------------------------------
// The per-registration facade
// ---------------------------------------------------------------------------

export interface TeamHooks {
  player: PlayerId;
  data: TeamData;
  ctx?: GameContext;
  /** The datacard behind an operative, from the battle context or the static catalogue. */
  card(op: OperativeState): Datacard | undefined;
  /** Does the operative have this keyword? */
  kw(op: OperativeState, keyword: string): boolean;
  /** Is this one of MY operatives? */
  mine(op: OperativeState): boolean;
  /** Friendly + keyword, the shape almost every faction rule is written in. */
  mineKw(op: OperativeState, keyword: string): boolean;
  /** Base-to-base distance in inches (core rules › Distances). */
  gap(a: OperativeState, b: OperativeState): number;
  /** Base-to-marker distance in inches. */
  markerGap(op: OperativeState, marker: MarkerState): number;
  /** Every friendly operative still in the killzone, optionally filtered by keyword. */
  friendlies(state: GameState, keyword?: string): OperativeState[];
  enemies(state: GameState): OperativeState[];
  /** A RuleBinding from a printed rule id in the team JSON. */
  bind(ruleId: string, priority?: number): RuleBinding;
  /** A RuleBinding with explicit text, for datacard abilities. */
  bindText(id: string, text: string, priority?: number): RuleBinding;
}

function baseOf(card: Datacard | undefined): Datacard['base'] {
  return card?.base ?? { shape: 'round', mm: 32 };
}

export function makeTeamHooks(data: TeamData, player: PlayerId, ctx?: GameContext): TeamHooks {
  const card = (op: OperativeState): Datacard | undefined =>
    ctx?.datacards.get(op.datacardId) ?? CATALOGUE.get(op.datacardId);
  const kw = (op: OperativeState, keyword: string): boolean =>
    (card(op)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());
  const texts = new Map<string, TeamRuleText>();
  for (const r of [...data.factionRules, ...data.strategyPloys, ...data.firefightPloys, ...data.equipment])
    texts.set(r.id, r);
  for (const c of data.datacards) {
    for (const a of c.abilities) texts.set(a.id, a);
    for (const a of c.uniqueActions) texts.set(a.id, { id: a.id, name: a.name, text: a.text });
  }
  return {
    player,
    data,
    ...(ctx ? { ctx } : {}),
    card,
    kw,
    mine: (op) => op.player === player,
    mineKw: (op, keyword) => op.player === player && kw(op, keyword),
    gap: (a, b) => baseGap(a.pos, baseOf(card(a)), a.rot, b.pos, baseOf(card(b)), b.rot),
    markerGap: (op, marker) =>
      baseGap(op.pos, baseOf(card(op)), op.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0),
    friendlies: (state, keyword) =>
      aliveOperatives(state, player).filter((o) => keyword === undefined || kw(o, keyword)),
    enemies: (state) => aliveOperatives(state, otherPlayer(player)),
    bind: (ruleId, priority = 10) => {
      const r = texts.get(ruleId);
      if (!r) throw new Error(`No printed rule '${ruleId}' in data/teams/${data.id}.json`);
      return { id: `${ruleId}.${player}`, sourceText: shortQuote(r.text), sourceUrl: data.sourceUrl, priority, player };
    },
    bindText: (id, text, priority = 10) => ({
      id: `${id}.${player}`,
      sourceText: shortQuote(text),
      sourceUrl: data.sourceUrl,
      priority,
      player,
    }),
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

// ---------------------------------------------------------------------------
// Small predicates
// ---------------------------------------------------------------------------

export function horizontal(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isInjuredCard(card: Datacard | undefined, op: OperativeState): boolean {
  return card !== undefined && op.wounds < card.wounds / 2;
}

export const ployUsed = (state: GameState, player: PlayerId, ployId: string): boolean =>
  state.teams[player].ploysUsedTP.includes(ployId);

export const gambitUsed = (state: GameState, player: PlayerId, gambitId: string): boolean =>
  state.teams[player].gambitsUsedTP.includes(gambitId);

export const gambitsWithPrefix = (state: GameState, player: PlayerId, prefix: string): string[] =>
  state.teams[player].gambitsUsedTP.filter((g) => g.startsWith(prefix));

export function hasEquipment(state: GameState, player: PlayerId, id: string): boolean {
  return state.teams[player].equipment.includes(id);
}

// ---------------------------------------------------------------------------
// Namespaced scratch space (never module-level state — architecture rule 7)
// ---------------------------------------------------------------------------

export function bucket(state: GameState, key: string): Record<string, unknown> {
  const b = (state.opState[key] ?? {}) as Record<string, unknown>;
  state.opState[key] = b;
  return b;
}

/** "Once per turning point" — true the first time it is claimed in this turning point. */
export function useOncePerTP(state: GameState, key: string): boolean {
  const b = bucket(state, 'teamOnce');
  const stamp = `${state.turningPoint}`;
  if (b[key] === stamp) return false;
  b[key] = stamp;
  return true;
}

export function usedThisTP(state: GameState, key: string): boolean {
  return bucket(state, 'teamOnce')[key] === `${state.turningPoint}`;
}

/** "Once during the battle". */
export function useOncePerBattle(state: GameState, key: string): boolean {
  const b = bucket(state, 'teamOnceBattle');
  if (b[key]) return false;
  b[key] = true;
  return true;
}

export function usedThisBattle(state: GameState, key: string): boolean {
  return Boolean(bucket(state, 'teamOnceBattle')[key]);
}

/** "Once during this sequence" — cleared whenever a new shoot/fight sequence starts. */
export function useOncePerSequence(state: GameState, key: string): boolean {
  const seq = state.sequence;
  const stamp = seq ? `${seq.kind}:${seq.attackerId}:${(seq as { targetId?: string; defenderId?: string }).targetId ?? (seq as { defenderId?: string }).defenderId}` : 'none';
  const b = bucket(state, 'teamSeqOnce');
  if (b[key] === stamp) return false;
  b[key] = stamp;
  return true;
}

// ---------------------------------------------------------------------------
// Effects and tokens
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

export function effectsOn(state: GameState, operativeId: string, rule: string): ActiveEffect[] {
  return state.effects.filter((e) => e.rule === rule && e.operativeId === operativeId);
}

export function effectFor(state: GameState, player: PlayerId, rule: string): ActiveEffect | undefined {
  return state.effects.find((e) => e.rule === rule && e.player === player);
}

export function dropEffects(state: GameState, pred: (e: ActiveEffect) => boolean): void {
  state.effects = state.effects.filter((e) => !pred(e));
}

/** Team tokens (Poison, Scan, Markerlight…) are effects on the operative that holds them. */
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
  dropEffects(state, (e) => e.rule === token && e.operativeId === operativeId);
}

// ---------------------------------------------------------------------------
// "…can immediately perform a free action"
// ---------------------------------------------------------------------------

export const FREE_ACTION_RULE = 'teamFreeAction';

/**
 * "…can immediately perform a free 1AP action" is modelled as one extra AP for that
 * operative, restricted to the actions the rule names. The bonus is always the LAST AP the
 * operative spends, so `canPerformAction` refuses anything outside `only` (and any move
 * action when the rule says it cannot move) once the operative is spending it.
 *
 * The engine has no intent for performing an action outside an activation, so a grant made in
 * the Strategy phase lands on that operative's next activation rather than resolving on the
 * spot (docs/DECISIONS.md D-013).
 */
export function grantFreeAction(
  state: GameState,
  op: OperativeState,
  spec: {
    sourceId: string;
    sourceText: string;
    threshold: number;
    kind?: ActiveEffect['source']['kind'];
    only?: string[];
    noMove?: boolean;
  },
): void {
  op.aplMods.push(1);
  effect(state, {
    rule: FREE_ACTION_RULE,
    source: { kind: spec.kind ?? 'ploy', id: spec.sourceId },
    sourceText: spec.sourceText,
    operativeId: op.id,
    player: op.player,
    data: {
      threshold: spec.threshold,
      ...(spec.only ? { only: spec.only } : {}),
      ...(spec.noMove ? { noMove: true } : {}),
    },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `${op.letter} gains a free ${spec.only ? spec.only.join('/') : '1AP'} action`,
    data: { operativeId: op.id, source: spec.sourceId },
  });
}

/** APL the operative has right now — the threshold `grantFreeAction` needs. */
export function currentApl(T: TeamHooks, state: GameState, op: OperativeState): number {
  if (T.ctx) return aplOf(T.ctx, state, op);
  const base = T.card(op)?.apl ?? 2;
  const raw = op.aplMods.reduce((a, b) => a + b, 0);
  return Math.max(0, base + Math.max(-1, Math.min(1, raw)));
}

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/** Registers the restriction half of `grantFreeAction`. Installed once per team module. */
export function registerFreeActionEngine(reg: HookRegistry, T: TeamHooks): void {
  const binding: RuleBinding = {
    id: `teams.freeAction.${T.player}`,
    sourceText: 'One friendly operative can immediately perform a 1AP action for free.',
    sourceUrl: T.data.sourceUrl,
    priority: 5,
    player: T.player,
  };
  reg.on('canPerformAction', binding, (ev) => {
    if (ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE);
    if (!eff) return;
    if (ev.operative.apSpent < Number(eff.data?.['threshold'] ?? 0)) return; // still spending its own AP
    const only = eff.data?.['only'] as string[] | undefined;
    if (only && !only.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = `the free action must be ${only.join(' or ')}`;
    } else if (Boolean(eff.data?.['noMove']) && MOVE_ACTIONS.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'it cannot move during that action';
    }
  });
}

// ---------------------------------------------------------------------------
// Markers a team places
// ---------------------------------------------------------------------------

export function placeTeamMarker(
  state: GameState,
  spec: {
    id: string;
    kind: MarkerState['kind'];
    player: PlayerId;
    pos: Vec2;
    z?: number;
    diameterMm?: number;
    flags?: Record<string, string | number | boolean>;
  },
): MarkerState {
  const marker: MarkerState = {
    id: spec.id,
    kind: spec.kind,
    diameterMm: spec.diameterMm ?? 20,
    pos: { ...spec.pos },
    z: spec.z ?? 0,
    owner: spec.player,
    flags: spec.flags ?? {},
  };
  state.markers[marker.id] = marker;
  return marker;
}

export function removeMarker(state: GameState, id: string): void {
  delete state.markers[id];
}

/** A deterministic default position when a rule needs one and the player supplied none. */
export function centroidOf(ops: OperativeState[], fallback: Vec2): Vec2 {
  if (ops.length === 0) return { ...fallback };
  const sum = ops.reduce((a, o) => ({ x: a.x + o.pos.x, y: a.y + o.pos.y }), { x: 0, y: 0 });
  return { x: sum.x / ops.length, y: sum.y / ops.length };
}

export function posFromData(data: Record<string, unknown> | undefined, fallback: Vec2): Vec2 {
  const p = data?.['pos'] as Vec2 | undefined;
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : { ...fallback };
}

/** Pick the operative a ploy names, or a deterministic default from the candidates. */
export function chosenOperative(
  state: GameState,
  data: Record<string, unknown> | undefined,
  candidates: OperativeState[],
): OperativeState | undefined {
  const id = data?.['operativeId'];
  if (typeof id === 'string') {
    const found = candidates.find((o) => o.id === id);
    if (found) return found;
  }
  return [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
}

// ---------------------------------------------------------------------------
// Weapon granting
// ---------------------------------------------------------------------------

/** Equipment that says "friendly X operatives have the following weapon". */
export function grantWeapon(op: OperativeState, weapon: Weapon): void {
  const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
  holder.grantedWeapons = holder.grantedWeapons ?? [];
  if (!holder.grantedWeapons.some((w) => w.name === weapon.name)) holder.grantedWeapons.push(weapon);
}

export function grantedWeapons(op: OperativeState): Weapon[] {
  return (op as OperativeState & { grantedWeapons?: Weapon[] }).grantedWeapons ?? [];
}

/** "…add 1 to both Dmg stats of this weapon" — profiles are shared data, so copy first. */
export function bumpDamage(profile: { dmgN: number; dmgC: number }, n: number): void {
  profile.dmgN += n;
  profile.dmgC += n;
}

// ---------------------------------------------------------------------------
// Unique-action scaffolding
// ---------------------------------------------------------------------------

export function notEngaged(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): { ok: boolean; reason?: string } {
  return enemiesInControlRange(ctx, state, op).length > 0
    ? { ok: false, reason: 'within control range of an enemy operative' }
    : { ok: true };
}

/** Build a unique action from the datacard's printed entry; only that datacard may do it. */
export function uniqueAction(
  data: TeamData,
  datacardId: string,
  actionId: string,
  impl: {
    check: ActionDef['check'];
    perform: ActionDef['perform'];
    available?: ActionDef['available'];
    treatedAs?: string;
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
    sourceText: `${printed.name} ${printed.ap}AP: ${printed.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, state, op) => op.datacardId === datacardId && (impl.available?.(ctx, state, op) ?? true),
    check: impl.check,
    perform: impl.perform,
    ...(impl.treatedAs ? { treatedAs: impl.treatedAs } : {}),
  };
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
  datacards: Datacard[];
  /** Faction equipment as `EquipmentDef`s, for `GameContext.equipment`. */
  equipmentDefs: EquipmentDef[];
  /** Pure selection-rule check against the team's printed selection requirements. */
  validateRoster(picks: RosterPickIn[]): RosterValidation;
}

export interface TeamSpec {
  id: string;
  /** Faction rules, datacard abilities and rare weapon rules. */
  rules(reg: HookRegistry, T: TeamHooks): void;
  /** The mechanical effect of each strategy and firefight ploy. */
  ploys(reg: HookRegistry, T: TeamHooks): void;
  /** The mechanical effect of each faction equipment option. */
  equipment(reg: HookRegistry, T: TeamHooks): void;
  /** Unique actions, registered once at module load and gated by `available`. */
  actions?(data: TeamData): ActionDef[];
  rareRules?: string[];
  ployUsable?: Record<string, PloyDef['usable']>;
  aiHints?: TeamAiHints;
  /** Override which STRATEGIC GAMBITs are offered (default: the four strategy ploys). */
  gambits?(reg: HookRegistry, T: TeamHooks): void;
}

export function defineTeam(spec: TeamSpec): KtTeamModule {
  const data = teamData(spec.id);

  const ploys: PloyDef[] = [
    ...data.strategyPloys.map((p): PloyDef => ployDef(p, 'strategy', spec)),
    ...data.firefightPloys.map((p): PloyDef => ployDef(p, 'firefight', spec)),
  ];

  for (const id of spec.rareRules ?? data.rareWeaponRules) registerRareWeaponRule(id, rareRuleTextFor(data, id), data.id);
  for (const def of spec.actions?.(data) ?? []) registerAction(def);

  const register = (reg: HookRegistry, player: PlayerId, ctx?: GameContext): void => {
    const T = makeTeamHooks(data, player, ctx);
    registerFreeActionEngine(reg, T);
    spec.rules(reg, T);
    spec.ploys(reg, T);
    spec.equipment(reg, T);
    if (spec.gambits) spec.gambits(reg, T);
    else defaultGambits(reg, T);
  };

  return {
    id: data.id,
    data,
    datacards: data.datacards,
    register,
    ploys,
    equipment: data.equipment.map((e): TeamEquipmentDef => ({ id: e.id, name: e.name, text: e.text })),
    equipmentDefs: data.equipment.map(
      (e): EquipmentDef => ({ id: e.id, name: e.name, text: e.text, scope: 'faction', teamId: data.id }),
    ),
    validateRoster: (picks: RosterPickIn[]) => validateRosterFor(data, picks),
    ...(spec.aiHints ? { aiHints: spec.aiHints } : {}),
  };
}

function ployDef(p: { id: string; name: string; cp: number; text: string }, kind: 'strategy' | 'firefight', spec: TeamSpec): PloyDef {
  return {
    id: p.id,
    name: p.name,
    kind,
    cp: p.cp,
    text: p.text,
    ...(spec.ployUsable?.[p.id] ? { usable: spec.ployUsable[p.id] } : {}),
  };
}

/**
 * "STRATEGIC GAMBIT" — strategy ploys are used in the Gambit step of the Strategy phase,
 * and only offered when the player can pay for them.
 */
export function defaultGambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
}

/**
 * The verbatim rare-rule definitions, read out of the generated registry
 * `data/teams/_rare-weapon-rules.json` — never retyped (CLAUDE.md: rules as data).
 *
 * `PSYCHIC` is the one rule the source defines nowhere: it is a weapon keyword other rules
 * read (docs/TEAM-DATA.md §3), so its registry entry carries `referencedIn` instead of a
 * definition and the fallback below states exactly that.
 */
const RARE_RULE_REGISTRY: Record<string, string> = Object.fromEntries(
  (rareRulesJson as { rules: { id: string; definition: string; referencedIn?: string[] }[] }).rules.map((r) => [
    r.id,
    r.definition.trim().length > 0
      ? r.definition
      : `${r.id} — a weapon keyword with no printed definition; it is read by other rules (${(r.referencedIn ?? []).length} of them).`,
  ]),
);

export function rareRuleText(id: string): string {
  const t = RARE_RULE_REGISTRY[id];
  if (!t)
    throw new Error(
      `No verbatim text for rare weapon rule '${id}' — it is not in data/teams/_rare-weapon-rules.json (re-run pnpm teams:normalise)`,
    );
  return t;
}

/** The printed NAME of a rare rule ('AntiPSYKER' -> 'Anti-PSYKER'), for locating a team's own copy. */
const RARE_RULE_NAME: Record<string, string> = Object.fromEntries(
  (rareRulesJson as { rules: { id: string; name: string }[] }).rules.map((r) => [r.id, r.name]),
);

/**
 * The definition of a rare weapon rule **as this kill team prints it**.
 *
 * The generated registry stores one definition per rule id, taken from whichever team the
 * normaliser resolved it from — but teams genuinely differ (docs/DECISIONS.md D-025: Anti-PSYKER
 * adds a Dmg bump on the Novitiates' Condemnor and does not on the Celestian Insidiants' own
 * footnote). Resolution order mirrors the normaliser's, against THIS team's data first:
 * a datacard ability of that name, then a faction rule of that name, then a `*Name:` footnote
 * line inside any faction rule, and only then the shared registry.
 */
export function rareRuleTextFor(data: TeamData, id: string): string {
  const name = RARE_RULE_NAME[id] ?? id;
  const lower = name.toLowerCase();
  for (const card of data.datacards) {
    const ability = card.abilities.find((a) => a.name.trim().toLowerCase() === lower);
    if (ability) return ability.text;
  }
  const rule = data.factionRules.find((r) => r.name.trim().toLowerCase() === lower);
  if (rule) return rule.text;
  // "*Anti-PSYKER: Whenever this weapon is being used against…" — a footnote inside a rule.
  const marker = new RegExp(`^\\s*[*^]\\d*\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'im');
  for (const r of data.factionRules) {
    const m = marker.exec(r.text);
    if (m?.[1]) return m[1].trim();
  }
  return rareRuleText(id);
}

export { aliveOperatives, log, enemiesInControlRange, aplOf, otherPlayer };
export type { RosterPickIn, RosterValidation };
