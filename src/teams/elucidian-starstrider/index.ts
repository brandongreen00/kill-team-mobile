/**
 * ELUCIDIAN STARSTRIDER — Rogue Trader Elucia Vhane's void-faring retinue.
 * https://wahapedia.ru/kill-team3/kill-teams/elucidian-starstrider/
 *
 * Seven datacards, sixteen abilities, five unique actions, two faction rules.
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read from `data/teams/elucidian-starstrider.json` at module load and never retyped. Two
 * printed structures have no ids of their own in the JSON and are therefore SLICED OUT of the
 * text they are printed inside (the same treatment the Kasrkin SKILL AT ARMS menu, the
 * Legionary Marks of Chaos and the Warpcoven BOONS needed):
 *
 *   1. the seven WARRANT OF TRADE sub-rules (`WARRANT_RULE`), and
 *   2. the five PRIVATEER SUPPORT ASSET weapon rules — the scraper parsed the stat line of
 *      each weapon into `factionRules[].weapons` but left `rules: []`, so the printed `WR`
 *      row is sliced from the rule text and parsed with the core weapon-rule parser
 *      (`PSA_WEAPONS`). See the data problems in the report.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { hasRule, successes } from '../../core/dice.ts';
import { baseGapToPoly, baseWhollyWithin } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  inControlRange,
  inflictDamage,
  log,
  recordRoll,
  saveOf,
} from '../../core/state.ts';
import { hasType } from '../../core/terrain.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import { isVisible } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { teamData, type TeamRuleText } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  catalogueCard,
  centroidOf,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantedWeapons,
  hasEquipment,
  isInjuredCard,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  posFromData,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';
import { supportDistance } from '../../core/equipment/index.ts';

const DATA = teamData('elucidian-starstrider');
const KW = 'ELUCIDIAN STARSTRIDER';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const C = {
  vhane: 'elucidian-starstrider.elucia-vhane',
  canid: 'elucidian-starstrider.canid',
  executioner: 'elucidian-starstrider.death-cult-executioner',
  lectroMaester: 'elucidian-starstrider.lectro-maester',
  rejuvenatAdept: 'elucidian-starstrider.rejuvenat-adept',
  voidmaster: 'elucidian-starstrider.voidmaster',
  voidsman: 'elucidian-starstrider.voidsman',
} as const;

const RULE = {
  warrant: 'elucidian-starstrider.rule.warrant-of-trade',
  psa: 'elucidian-starstrider.rule.privateer-support-assets',
} as const;

const SP = {
  lethalProximity: 'elucidian-starstrider.sp.lethal-proximity',
  stakeClaim: 'elucidian-starstrider.sp.stake-claim',
  undauntedExplorers: 'elucidian-starstrider.sp.undaunted-explorers',
  quickMarch: 'elucidian-starstrider.sp.quick-march',
} as const;

const FP = {
  combinedArms: 'elucidian-starstrider.fp.combined-arms',
  survivalist: 'elucidian-starstrider.fp.survivalist',
  greatEndurance: 'elucidian-starstrider.fp.great-endurance',
  wellDrilled: 'elucidian-starstrider.fp.well-drilled',
} as const;

const EQ = {
  armouredUndersuit: 'elucidian-starstrider.eq.armoured-undersuit',
  hotShot: 'elucidian-starstrider.eq.hot-shot-capacitor-packs',
  uplink: 'elucidian-starstrider.eq.improved-coordinates-uplink',
  rapidGunnery: 'elucidian-starstrider.eq.rapid-gunnery',
} as const;

const A = {
  digitalLasers: `${C.vhane}.digital-lasers`,
  merciless: `${C.vhane}.merciless`,
  disruptionField: `${C.vhane}.disruption-field`,
  reputation: `${C.vhane}.reputation-to-maintain`,
  beast: `${C.canid}.beast`,
  loyalCompanion: `${C.canid}.loyal-companion`,
  rapidReflexes: `${C.executioner}.rapid-reflexes`,
  bladedStance: `${C.executioner}.bladed-stance`,
  zealot: `${C.executioner}.zealot`,
  missionary: `${C.lectroMaester}.missionary-of-the-martian-creed`,
  voltaghiestArray: `${C.lectroMaester}.voltaghiest-array`,
  medic: `${C.rejuvenatAdept}.medic`,
  normaliserHelm: `${C.rejuvenatAdept}.normaliser-helm`,
  disciplinarian: `${C.voidmaster}.disciplinarian`,
  hardy: `${C.voidmaster}.hardy`,
  crewmen: `${C.voidsman}.crewmen`,
} as const;

export const ACT = {
  gather: `${C.canid}.act.gather`,
  trainedAssassin: `${C.executioner}.act.trained-assassin`,
  calibrate: `${C.lectroMaester}.act.calibrate-voltagheist`,
  healingSerum: `${C.rejuvenatAdept}.act.healing-serum`,
  uncompromisingFire: `${C.voidmaster}.act.uncompromising-fire`,
} as const;

/** The second free Shoot of UNCOMPROMISING FIRE, as its own 0AP ActionDef (D-021). */
export const SHOOT_UNCOMPROMISING = 'Shoot (Uncompromising Fire)';

// Effect / scratch keys — all namespaced, never module-level state (architecture rule 7).
const E_SURVIVALIST = 'es.survivalist';
const E_GREAT_ENDURANCE = 'es.greatEndurance';
const E_WELL_DRILLED = 'es.wellDrilled';
const E_HOT_SHOT = 'es.hotShot';
const E_MEDIC_SHIELD = 'es.medicShield';
const E_VOLTAGHEIST = 'es.voltagheist';
const E_UNCOMPROMISING = 'es.uncompromisingFire';

export const CLAIM_MARKER = (player: PlayerId): string => `elucidian-starstrider.claim.${player}`;

// ---------------------------------------------------------------------------
// WARRANT OF TRADE — the seven sub-rules, sliced out of the printed faction rule
// ---------------------------------------------------------------------------

export const WARRANTS = [
  'consideration',
  'coordinate',
  'coerce',
  'explore',
  'bribe',
  'seize',
  'adaptable-terms',
] as const;
export type Warrant = (typeof WARRANTS)[number];

/** The heading each block is printed under, in printed order. */
const WARRANT_HEADING: Record<Warrant, string> = {
  consideration: 'Consideration',
  coordinate: 'Coordinate',
  coerce: 'Coerce',
  explore: 'Explore',
  bribe: 'Bribe',
  seize: 'Seize',
  'adaptable-terms': 'Adaptable Terms',
};

/**
 * "Up to four times per battle, you can use a WARRANT OF TRADE rule (below)." The seven
 * sub-rules are printed as `\n<Name>\nWhen: …\n\nEffect: …` blocks with no id of their own, so
 * each is sliced out of the one printed faction rule rather than retyped.
 */
export const WARRANT_RULE: Record<Warrant, string> = (() => {
  const printed = text(RULE.warrant);
  const out = {} as Record<Warrant, string>;
  WARRANTS.forEach((w, i) => {
    const start = printed.indexOf(`\n${WARRANT_HEADING[w]}`);
    const next = WARRANTS[i + 1];
    const end = next ? printed.indexOf(`\n${WARRANT_HEADING[next]}`) : -1;
    if (start < 0) throw new Error(`No '${WARRANT_HEADING[w]}' block in ${RULE.warrant}`);
    out[w] = printed.slice(start + 1, end < 0 ? printed.length : end).trim();
  });
  return out;
})();

/** The base allowance, raised to five by ELUCIA VHANE's Reputation to Maintain. */
const WARRANT_BASE_USES = 4;

const warrantStore = (state: GameState, player: PlayerId): Record<string, unknown> =>
  bucket(state, `es.warrants.${player}`);

export function warrantsUsed(state: GameState, player: PlayerId): Warrant[] {
  return WARRANTS.filter((w) => Boolean(warrantStore(state, player)[w]));
}

export function warrantAllowance(state: GameState, player: PlayerId): number {
  return WARRANT_BASE_USES + (Number(warrantStore(state, player)['extra'] ?? 0) > 0 ? 1 : 0);
}

/**
 * The one entry point for a WARRANT OF TRADE rule.
 *
 * Six of the seven fire in steps the engine has no decision channel for (Select Operatives,
 * Set Up Operatives, the initiative roll-off, the activation order, and the Approved Ops op
 * swap), so this is a pure setter in the shape of docs/DECISIONS.md D-017: it enforces the
 * shared budget ("up to four times per battle … you cannot use the same one more than once")
 * and applies the effect where the engine can express it. `Coordinate` gains the CP;
 * `Explore` is registered as a real STRATEGIC GAMBIT and routes back through here. The other
 * five are recorded and logged as reminder-only — see the report.
 */
export function useWarrantOfTrade(state: GameState, player: PlayerId, warrant: Warrant): boolean {
  const store = warrantStore(state, player);
  if (store[warrant]) {
    log(state, { kind: 'system', player, text: `WARRANT OF TRADE: ${WARRANT_HEADING[warrant]} has already been used` });
    return false;
  }
  if (warrantsUsed(state, player).length >= warrantAllowance(state, player)) {
    log(state, {
      kind: 'system',
      player,
      text: `WARRANT OF TRADE: no uses left (${warrantAllowance(state, player)} per battle)`,
    });
    return false;
  }
  store[warrant] = true;
  if (warrant === 'coordinate') {
    state.teams[player].cp += 1; // "Effect: You gain 1 additional CP."
  }
  log(state, {
    kind: 'ploy',
    player,
    text: `WARRANT OF TRADE: ${WARRANT_HEADING[warrant]}`,
    data: { warrant, reminderOnly: warrant !== 'coordinate' && warrant !== 'explore' },
  });
  return true;
}

// ---------------------------------------------------------------------------
// PRIVATEER SUPPORT ASSETS
// ---------------------------------------------------------------------------

const psaHolder = DATA.factionRules.find((r) => r.id === RULE.psa) as TeamRuleText & { weapons?: Weapon[] };

/**
 * The five PRIVATEER SUPPORT ASSET weapons. The scraper captured their ATK/HIT/DMG but left
 * `rules: []`, so each weapon's printed `WR` row is sliced out of the faction-rule text and
 * parsed by the core parser. Profiles are cloned so nothing shares the catalogue objects
 * (docs/DECISIONS.md D-019).
 */
export const PSA_WEAPONS: Weapon[] = (() => {
  const printed = text(RULE.psa);
  const table = psaHolder?.weapons ?? [];
  if (table.length === 0) throw new Error(`No PRIVATEER SUPPORT ASSET weapon table in ${RULE.psa}`);
  const chunks = printed.split(/\n\s*WR\s*\n/);
  return table.map((w, i) => {
    const before = chunks[i];
    const after = chunks[i + 1];
    if (before === undefined || after === undefined || !before.includes(w.name))
      throw new Error(`No printed WR row for '${w.name}' in ${RULE.psa}`);
    const line = after.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
    const rules = parseWeaponRules(line);
    if (rules.length === 0) throw new Error(`Empty WR row for '${w.name}' in ${RULE.psa}`);
    return {
      name: w.name,
      profiles: w.profiles.map((p) => ({ ...structuredClone(p), rules: structuredClone(rules) })),
    };
  });
})();

const PSA_NAMES = new Set(PSA_WEAPONS.map((w) => w.name.toLowerCase()));
export const isPsaWeapon = (name: string): boolean => PSA_NAMES.has(name.trim().toLowerCase());

const psaPhaseKey = (player: PlayerId): string => `es.psaPhase:${player}`;
const rapidGunneryKey = (player: PlayerId): string => `es.rapidGunnery:${player}`;
const crewmenKey = (player: PlayerId): string => `es.crewmen:${player}`;

const psaUsedThisBattle = (state: GameState, player: PlayerId, name: string): boolean =>
  Boolean(bucket(state, 'es.psaUsed')[`${player}:${name.toLowerCase()}`]);

/** "Once per Firefight phase" — one Firefight phase per turning point. */
export const psaUsedThisTP = (state: GameState, player: PlayerId): boolean => usedThisTP(state, psaPhaseKey(player));

const rapidGunneryAvailable = (state: GameState, player: PlayerId): boolean =>
  hasEquipment(state, player, EQ.rapidGunnery) && !usedThisBattle(state, rapidGunneryKey(player));

/** "a friendly ELUCIDIAN STARSTRIDER NAVIS or ELUCIDIAN STARSTRIDER ELUCIA VHANE operative" */
const psaUser = (T: TeamHooks, op: OperativeState): boolean =>
  T.mineKw(op, KW) && (T.kw(op, 'NAVIS') || T.kw(op, 'ELUCIA VHANE'));

/**
 * Exactly which PRIVATEER SUPPORT ASSETs this operative may select right now.
 *
 * This is a pure query and it is what `availableWeapons` keeps `grantedWeapons` in sync with,
 * so the UI, the AI's `shotPlans` and `startShoot` all see the same set and an illegal one can
 * never be offered. The weapon of an in-flight sequence is always kept: `advanceShoot` looks
 * its weapon up out of `weaponsOf` on every step.
 */
export function psaAvailableTo(T: TeamHooks, state: GameState, op: OperativeState): string[] {
  if (!psaUser(T, op)) return [];
  const seq = state.sequence;
  const inFlight = seq && seq.kind === 'shoot' && seq.attackerId === op.id ? seq.weaponName.toLowerCase() : undefined;
  // QUICK MARCH: "…and cannot use a PRIVATEER SUPPORT ASSET during that activation."
  const quickMarched =
    quickMarchNominee(state, op) && op.actionsThisActivation.includes('Reposition');
  const phaseSpent = psaUsedThisTP(state, T.player);
  const rapid = rapidGunneryAvailable(state, T.player);
  const out: string[] = [];
  for (const w of PSA_WEAPONS) {
    if (inFlight !== undefined && w.name.toLowerCase() === inFlight) {
      out.push(w.name);
      continue;
    }
    if (quickMarched || phaseSpent) continue;
    if (!psaUsedThisBattle(state, T.player, w.name) || rapid) out.push(w.name);
  }
  return out;
}

/**
 * Keeps `op.grantedWeapons` equal to `psaAvailableTo`. Run from `availableWeapons`, which
 * `weaponsOf` emits BEFORE it reads `grantedWeapons` — so every reader gets the current set.
 * A fresh array is always assigned, never mutated in place, because `shotPlans` evaluates
 * hypothetical positions on a spread copy of the operative.
 */
function syncGrantedWeapons(T: TeamHooks, state: GameState, op: OperativeState): void {
  const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
  const current = holder.grantedWeapons ?? [];
  // CANID › Beast: "It cannot use any weapons that aren't on its datacard."
  if (op.datacardId === C.canid) {
    if (current.length > 0) holder.grantedWeapons = [];
    return;
  }
  const want = psaAvailableTo(T, state, op);
  const keep = current.filter((w) => !isPsaWeapon(w.name));
  const have = current.filter((w) => isPsaWeapon(w.name)).map((w) => w.name);
  if (have.length === want.length && want.every((n) => have.includes(n))) return;
  const granted = PSA_WEAPONS.filter((w) => want.includes(w.name)).map((w) => structuredClone(w));
  holder.grantedWeapons = [...keep, ...granted];
}

/** "the target has a cover save if any part of its base is underneath Vantage terrain" */
function underneathVantage(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const base = T.card(op)?.base ?? { shape: 'round' as const, mm: 32 };
  return terrain(ctx, state).parts.some(
    (p) => hasType(p, 'Vantage') && p.z0 > op.z + EPS && baseGapToPoly(op.pos, base, op.rot, p.poly) <= EPS,
  );
}

/**
 * CREWMEN: a VOIDSMAN counteracting with a Conceal order can only have got there through that
 * ability, so the counteraction is identified by its own shape rather than by a flag.
 */
function crewmenCounteracting(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return (
    op.player === T.player &&
    op.datacardId === C.voidsman &&
    op.order === 'conceal' &&
    state.opState['counteract']?.['operativeId'] === op.id
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

function d3(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d3() ?? 2;
  recordRoll(state, 'elucidian-starstrider', [roll], T.player, note);
  return roll;
}

function d6(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, 'elucidian-starstrider', [roll], T.player, note);
  return roll;
}

function heal(T: TeamHooks, op: OperativeState, amount: number): number {
  const max = T.card(op)?.wounds ?? op.wounds + amount;
  const before = op.wounds;
  op.wounds = Math.min(max, op.wounds + amount);
  return op.wounds - before;
}

function sees(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

function engagedWith(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

const isEngagedNow = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  T.ctx
    ? enemiesInControlRange(T.ctx, state, op).length > 0
    : T.enemies(state).some((e) => T.gap(op, e) <= 1 + EPS);

function profileOf(
  T: TeamHooks,
  op: OperativeState,
  weaponName: string,
  profileName?: string,
): WeaponProfile | undefined {
  const w = [...(T.card(op)?.weapons ?? []), ...grantedWeapons(op)].find((x) => x.name === weaponName);
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w.profiles[0];
}

interface AttackDie {
  dmg: number;
  crit: boolean;
}

/**
 * The attack dice behind one `onDamage` event, so per-dice rules ("the first time an attack
 * dice inflicts damage", "when an attack dice inflicts Normal Dmg", "+1 to both Dmg stats")
 * can be applied per dice rather than once to the lump a Shoot action inflicts.
 */
function incomingAttackDice(T: TeamHooks, state: GameState, target: OperativeState, amount: number): AttackDie[] {
  const seq = state.sequence;
  if (!seq) return [];
  if (seq.kind === 'shoot') {
    if (seq.targetId !== target.id) return [];
    const attacker = state.operatives[seq.attackerId];
    const profile = attacker ? profileOf(T, attacker, seq.weaponName, seq.profileName) : undefined;
    if (!profile) return [];
    const out: AttackDie[] = [];
    for (const die of seq.attack.dice) {
      if (die.state === 'crit') out.push({ dmg: profile.dmgC, crit: true });
      else if (die.state === 'normal') out.push({ dmg: profile.dmgN, crit: false });
    }
    return out;
  }
  if (seq.attackerId !== target.id && seq.defenderId !== target.id) return [];
  const strikerId = seq.attackerId === target.id ? seq.defenderId : seq.attackerId;
  const striker = state.operatives[strikerId];
  const name = strikerId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const pname = strikerId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const profile = striker ? profileOf(T, striker, name, pname) : undefined;
  if (!profile) return [];
  const crit = profile.dmgC !== profile.dmgN && amount === profile.dmgC;
  return [{ dmg: crit ? profile.dmgC : profile.dmgN, crit }];
}

/** The operative whose weapon is inflicting the damage in the sequence in flight. */
function attackerOf(state: GameState, target: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') return state.operatives[seq.attackerId];
  if (seq.attackerId === target.id) return state.operatives[seq.defenderId];
  if (seq.defenderId === target.id) return state.operatives[seq.attackerId];
  return undefined;
}

/** QUICK MARCH: which friendly operatives the ploy was used on this turning point. */
function quickMarchNominee(state: GameState, op: OperativeState): boolean {
  if (!gambitUsed(state, op.player, SP.quickMarch)) return false;
  const ids = bucket(state, 'es.quickMarch')[op.player];
  return Array.isArray(ids) && (ids as string[]).includes(op.id);
}

const dropZonePolys = (state: GameState, player: PlayerId): Vec2[][] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

const whollyInDropZone = (T: TeamHooks, state: GameState, op: OperativeState): boolean => {
  const base = T.card(op)?.base ?? { shape: 'round' as const, mm: 32 };
  return baseWhollyWithin(op.pos, base, op.rot, dropZonePolys(state, op.player));
};

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // WARRANT OF TRADE › Explore — "STRATEGIC GAMBIT in the first turning point"
  // =========================================================================
  const EXPLORE_GAMBIT = 'elucidian-starstrider.warrant.explore';
  reg.on('gambitOptions', T.bindText('es.warrant.explore', WARRANT_RULE.explore, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (warrantsUsed(ev.state, T.player).includes('explore')) return;
    if (warrantsUsed(ev.state, T.player).length >= warrantAllowance(ev.state, T.player)) return;
    if (T.friendlies(ev.state, KW).filter((o) => whollyInDropZone(T, ev.state, o)).length === 0) return;
    ev.options.push({
      id: EXPLORE_GAMBIT,
      label: 'WARRANT OF TRADE: Explore',
      sourceText: shortQuote(WARRANT_RULE.explore),
    });
  });
  reg.on('onPloyUsed', T.bindText('es.warrant.explore', WARRANT_RULE.explore, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EXPLORE_GAMBIT) return;
    if (!useWarrantOfTrade(ev.state, T.player, 'explore')) return;
    // "Perform a free Reposition action with D3 friendly ELUCIDIAN STARSTRIDER operatives that
    //  are wholly within your drop zone."
    const n = d3(T, ev.state, 'Explore D3 operatives');
    const eligible = T.friendlies(ev.state, KW)
      .filter((o) => whollyInDropZone(T, ev.state, o))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const op of eligible.slice(0, n)) {
      grantFreeAction(ev.state, op, {
        sourceId: EXPLORE_GAMBIT,
        sourceText: shortQuote(WARRANT_RULE.explore),
        threshold: currentApl(T, ev.state, op),
        only: ['Reposition'],
      });
    }
  });

  // =========================================================================
  // PRIVATEER SUPPORT ASSETS
  // =========================================================================
  // The weapons are granted through `availableWeapons`, which `weaponsOf` emits before it
  // reads `grantedWeapons`, so the offered set is always exactly the legal set.
  reg.on('availableWeapons', T.bind(RULE.psa, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    syncGrantedWeapons(T, ev.state, ev.operative);
    // CREWMEN: "…you must use a PRIVATEER SUPPORT ASSET to do so."
    if (!crewmenCounteracting(T, ev.state, ev.operative)) return;
    const card = T.card(ev.operative);
    const ranged = new Set(
      (card?.weapons ?? []).filter((w) => w.profiles.some((p) => p.type === 'ranged')).map((w) => w.name),
    );
    ev.weapons = ev.weapons.filter((n) => !ranged.has(n));
  });

  reg.on('onSelectWeapon', T.bind(RULE.psa, 12), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    const op = ev.ctx.attacker;
    if (op.player !== T.player) return;
    const name = ev.ctx.weaponName;
    if (!isPsaWeapon(name)) {
      if (crewmenCounteracting(T, ev.state, op)) {
        ev.allowed = false;
        ev.reason = 'Crewmen: it must use a PRIVATEER SUPPORT ASSET to do so';
      }
      return;
    }
    if (!psaUser(T, op)) {
      ev.allowed = false;
      ev.reason = 'only a friendly NAVIS or ELUCIA VHANE operative can use a PRIVATEER SUPPORT ASSET';
      return;
    }
    if (quickMarchNominee(ev.state, op) && op.actionsThisActivation.includes('Reposition')) {
      ev.allowed = false;
      ev.reason = 'QUICK MARCH: it cannot use a PRIVATEER SUPPORT ASSET during that activation';
      return;
    }
    if (psaUsedThisTP(ev.state, T.player)) {
      ev.allowed = false;
      ev.reason = 'a PRIVATEER SUPPORT ASSET has already been used this Firefight phase';
      return;
    }
    if (psaUsedThisBattle(ev.state, T.player, name)) {
      // RAPID GUNNERY: "Once per battle, when selecting a PRIVATEER SUPPORT ASSET, you can
      // select one that's already been used during the battle."
      if (!rapidGunneryAvailable(ev.state, T.player)) {
        ev.allowed = false;
        ev.reason = `${name} has already been used this battle`;
        return;
      }
      useOncePerBattle(ev.state, rapidGunneryKey(T.player));
      log(ev.state, { kind: 'ploy', player: T.player, text: `RAPID GUNNERY: ${name} fires again` });
    }
    useOncePerTP(ev.state, psaPhaseKey(T.player));
    bucket(ev.state, 'es.psaUsed')[`${T.player}:${name.toLowerCase()}`] = true;
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter} calls in the ${name}` });
  });

  // "Instead, the target has a cover save if any part of its base is underneath Vantage terrain."
  reg.on('onDefenceDice', T.bind(RULE.psa, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (!isPsaWeapon(ev.ctx.weaponName)) return;
    const target = ev.ctx.defender;
    if (!target) return;
    ev.coverSave = underneathVantage(T, ev.state, target) && !hasRule(ev.ctx.rules, 'Saturate');
  });

  // =========================================================================
  // ELUCIA VHANE
  // =========================================================================
  // Digital Lasers — "at the start of the Roll Attack Dice step, you can use this rule".
  // Free, so it is auto-used on the printed trigger (docs/DECISIONS.md D-022).
  reg.on('onCollectAttackDice', T.bind(A.digitalLasers, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || !T.ctx) return;
    const vhane = ev.ctx.attacker;
    if (vhane.player !== T.player || vhane.datacardId !== C.vhane) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== vhane.id) return; // "Whenever this operative performs the Fight action"
    const foe = ev.state.operatives[seq.defenderId];
    if (!foe || foe.removed) return;
    if (!useOncePerSequence(ev.state, `es.digitalLasers:${vhane.id}`)) return;
    inflictDamage(T.ctx, ev.state, foe, 1, 'other');
    log(ev.state, { kind: 'action', player: T.player, text: `${vhane.letter}: Digital Lasers (1 damage)` });
  });

  // Merciless — works when shooting, fighting AND retaliating: `onWeaponRules` is emitted by
  // `effectiveRules`, which both sequences read. Bound at priority 40 (after ploys at 20 and
  // equipment at 30) so that "if the weapon ALREADY has that weapon rule" sees every other
  // grant, which is the only way the printed Ceaseless upgrade can ever fire on this team —
  // no ELUCIDIAN STARSTRIDER weapon prints Balanced.
  reg.on('onWeaponRules', T.bind(A.merciless, 40), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.vhane) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player) return;
    // "an enemy operative that was already wounded when the action started" — a Shoot action
    // inflicts all its damage at the end of the sequence, so the current wound count is the
    // count the action started with in every case except a Devastating pre-payment.
    if (foe.wounds >= (T.card(foe)?.wounds ?? foe.wounds)) return;
    if (ev.rules.some((r) => r.id === 'Balanced'))
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Merciless)'));
    else ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Merciless)'));
  });

  // Disruption Field / Rapid Reflexes — "Whenever an operative is shooting this operative,
  // ignore the Piercing weapon rule."
  for (const [id, cardId] of [
    [A.disruptionField, C.vhane],
    [A.rapidReflexes, C.executioner],
  ] as const) {
    reg.on('onWeaponRules', T.bind(id, 12), (ev) => {
      if (ev.type !== 'ranged') return;
      const foe = ev.target;
      if (!foe || foe.player !== T.player || foe.datacardId !== cardId) return;
      if (!ev.rules.some((r) => r.id === 'Piercing')) return;
      ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
    });
  }

  // Reputation to Maintain — the choice is deterministic: the extra WARRANT OF TRADE use is
  // only worth anything once the printed four are spent, so it is taken then and 1CP otherwise.
  reg.on('onIncapacitated', T.bind(A.reputation, 12), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const vhane = attackerOf(ev.state, ev.operative);
    if (!vhane || vhane.player !== T.player || vhane.datacardId !== C.vhane) return;
    if (!useOncePerBattle(ev.state, `es.reputation:${T.player}`)) return;
    const store = warrantStore(ev.state, T.player);
    if (warrantsUsed(ev.state, T.player).length >= WARRANT_BASE_USES) {
      store['extra'] = 1; // "use an additional WARRANT OF TRADE rule (up to five uses per battle)"
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `${vhane.letter}: Reputation to Maintain — a fifth WARRANT OF TRADE use`,
      });
    } else {
      ev.state.teams[T.player].cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: `${vhane.letter}: Reputation to Maintain (+1CP)` });
    }
  });

  // =========================================================================
  // CANID
  // =========================================================================
  const BEAST_ACTIONS = new Set<string>([
    'Charge',
    'Dash',
    'Fall Back',
    'Fight',
    ACT.gather,
    'Guard',
    'Reposition',
    'Pick Up Marker',
    'Place Marker',
  ]);
  reg.on('canPerformAction', T.bind(A.beast, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.canid) return;
    if (BEAST_ACTIONS.has(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'Beast: it cannot perform any actions other than Charge, Dash, Fall Back, Fight, Gather, Guard, Reposition, Pick Up Marker and Place Marker';
  });

  // Loyal Companion, second clause. Nothing runs at the end of an action, so the free Charge
  // is granted at the end of the enemy's ACTIVATION (the smallest window the engine closes),
  // and lands on the CANID's next activation as one extra AP restricted to Charge (D-015).
  reg.on('onActivationEnd', T.bind(A.loyalCompanion, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || foe.removed) return;
    if (!foe.actionsThisActivation.includes('Charge')) return;
    for (const canid of T.friendlies(ev.state).filter((o) => o.datacardId === C.canid)) {
      if (isEngagedNow(T, ev.state, canid)) continue; // "if this operative isn't within control range of enemy operatives"
      if (effectOn(ev.state, canid.id, FREE_ACTION_RULE)) continue;
      const buddy = T.friendlies(ev.state, KW).find(
        (o) => o.id !== canid.id && engagedWith(T, ev.state, foe, o) && T.gap(o, canid) <= 3 + EPS,
      );
      if (!buddy) continue;
      grantFreeAction(ev.state, canid, {
        sourceId: A.loyalCompanion,
        sourceText: shortQuote(abilityText(C.canid, A.loyalCompanion)),
        kind: 'ability',
        threshold: currentApl(T, ev.state, canid),
        only: ['Charge'],
      });
    }
  });

  // =========================================================================
  // DEATH CULT EXECUTIONER
  // =========================================================================
  // Bladed Stance — "you can resolve one of your successes before the normal order". A
  // retaliating operative resolves second by default; the attacker already resolves first.
  reg.on('onCollectAttackDice', T.bind(A.bladedStance, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.executioner) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return;
    seq.turn = 'defender';
  });

  // Zealot — one unresolved success is struck with before the operative is removed.
  reg.on('onIncapacitated', T.bind(A.zealot, 13), (ev) => {
    const op = ev.operative;
    if (ev.prevented || op.player !== T.player || op.datacardId !== C.executioner || !T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === op.id ? 'attacker' : seq.defenderId === op.id ? 'defender' : undefined;
    if (!side) return;
    if (!useOncePerSequence(ev.state, `es.zealot:${op.id}`)) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = successes(pool).sort((a, b) => (a.state === b.state ? 0 : a.state === 'crit' ? -1 : 1))[0];
    if (!die) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed) return;
    const { profile } = sideWeapon(T.ctx, ev.state, seq, side);
    const dmg = die.state === 'crit' ? profile.dmgC : profile.dmgN;
    die.state = 'struck';
    log(ev.state, { kind: 'dice', player: T.player, text: `${op.letter}: Zealot strikes ${foe.letter} for ${dmg}` });
    inflictDamage(T.ctx, ev.state, foe, dmg, 'attack');
  });

  // =========================================================================
  // LECTRO-MAESTER
  // =========================================================================
  const CHEAP_ACTIONS = (action: string): boolean =>
    action === 'Pick Up Marker' || action === 'Place Marker' || getAction(action)?.type === 'mission';
  reg.on('onActionCost', T.bind(A.missionary, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.lectroMaester) return;
    if (!CHEAP_ACTIONS(ev.action)) return;
    // "Once during each of this operative's activations" — the first such action is the cheap one.
    if (op.actionsThisActivation.some((a) => CHEAP_ACTIONS(a))) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  reg.on('onDefenceDice', T.bind(A.voltaghiestArray, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || !T.kw(target, KW)) return;
    const maester = T.friendlies(ev.state).find(
      (o) => o.datacardId === C.lectroMaester && !o.incapacitated && T.gap(o, target) <= 4 + EPS,
    );
    if (!maester) return;
    ev.rerolls.push({
      id: 'es.voltaghiestArray',
      label: 'Voltaghiest Array: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: target.player,
      sourceText: shortQuote(abilityText(C.lectroMaester, A.voltaghiestArray)),
    });
  });

  // CALIBRATE VOLTAGHEIST › Charge — "This operative's voltaic pistol has the Lethal 4+ rule."
  reg.on('onWeaponRules', T.bindText(ACT.calibrate, actionText(C.lectroMaester, ACT.calibrate), 12), (ev) => {
    if (ev.operative.player !== T.player || ev.weaponName !== 'Voltaic pistol') return;
    if (voltagheistMode(ev.state, ev.operative) !== 'charge') return;
    ev.rules.push(ruleTag('Lethal', 4, 'Lethal 4+ (CALIBRATE VOLTAGHEIST: Charge)'));
  });

  // CALIBRATE VOLTAGHEIST › Field — nothing runs at the end of an action, so the D6 lands at
  // the end of the enemy's activation instead (bounded, once per activation).
  reg.on('onActivationEnd', T.bindText(ACT.calibrate, actionText(C.lectroMaester, ACT.calibrate), 13), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || foe.removed || !T.ctx) return;
    if (!foe.actionsThisActivation.some((a) => ['Charge', 'Dash', 'Fall Back', 'Reposition'].includes(a))) return;
    const maester = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === C.lectroMaester &&
        !o.incapacitated &&
        voltagheistMode(ev.state, o) === 'field' &&
        T.gap(o, foe) <= 4 + EPS &&
        sees(T, ev.state, o, foe),
    );
    if (!maester) return;
    const roll = d6(T, ev.state, 'CALIBRATE VOLTAGHEIST: Field D6');
    log(ev.state, { kind: 'action', player: T.player, text: `${maester.letter}: voltagheist field burns ${foe.letter}` });
    inflictDamage(T.ctx, ev.state, foe, roll, 'other');
  });
  // "…until the start of this operative's next activation."
  reg.on('onActivationStart', T.bindText(ACT.calibrate, actionText(C.lectroMaester, ACT.calibrate), 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E_VOLTAGHEIST && e.operativeId === ev.operative.id);
  });
  // "…until it's incapacitated."
  reg.on('onIncapacitated', T.bindText(ACT.calibrate, actionText(C.lectroMaester, ACT.calibrate), 14), (ev) => {
    if (ev.prevented || ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E_VOLTAGHEIST && e.operativeId === ev.operative.id);
  });

  // =========================================================================
  // REJUVENAT ADEPT
  // =========================================================================
  reg.on('onIncapacitated', T.bind(A.medic, 12), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW)) return;
    if (effectOn(ev.state, victim.id, E_MEDIC_SHIELD)) {
      // "…and cannot be incapacitated for the remainder of the action."
      ev.prevented = true;
      if (victim.wounds <= 0) victim.wounds = 1;
      return;
    }
    const adept = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === C.rejuvenatAdept &&
        o.id !== victim.id &&
        !o.incapacitated &&
        T.gap(o, victim) <= 3 + EPS &&
        sees(T, ev.state, o, victim) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        !isEngagedNow(T, ev.state, o) &&
        !isEngagedNow(T, ev.state, victim),
    );
    if (!adept) return;
    // "You cannot use this rule … if it's a Shoot action and this operative would be a primary
    //  or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === adept.id || seq.queue.includes(adept.id))) return;
    if (!useOncePerTP(ev.state, `es.medic:${adept.id}`)) return;

    ev.prevented = true;
    victim.wounds = 3; // "that friendly operative isn't incapacitated, has 3 wounds remaining"
    bucket(ev.state, 'es.medicUsed')[victim.id] = ev.state.turningPoint;
    effect(ev.state, {
      rule: E_MEDIC_SHIELD,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.rejuvenatAdept, A.medic)),
      operativeId: victim.id,
      player: T.player,
      // Nothing expires an `endOfAction` effect, so the shield is pinned to the activation in
      // flight — the smallest window the engine actually closes.
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? victim.id },
    });
    // "If this rule was used during that friendly operative's activation, that activation ends"
    // — modelled as spending the rest of its AP, leaving only the granted free Dash.
    if (ev.state.activeOperativeId === victim.id) victim.apSpent = currentApl(T, ev.state, victim);
    grantFreeAction(ev.state, victim, {
      sourceId: A.medic,
      sourceText: shortQuote(abilityText(C.rejuvenatAdept, A.medic)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, victim),
      only: ['Dash'],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${adept.letter}: Medic! saves ${victim.letter}` });
  });

  // Normaliser Helm — the two stat changes an injured operative suffers, cancelled where the
  // engine reads them: `moveOf` subtracts 2 and `hitOf` worsens the Hit stat by 1 (that is the
  // "including its weapons' stats" half). Both consult `statMods`.
  reg.on('onStatMod', T.bind(A.normaliserHelm, 12), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!isInjuredCard(T.card(op), op)) return;
    const adept = T.friendlies(ev.state).find(
      (o) => o.datacardId === C.rejuvenatAdept && !o.incapacitated && T.gap(o, op) <= 6 + EPS,
    );
    if (!adept) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // VOIDMASTER
  // =========================================================================
  // Bound at priority 40 for the same reason as Merciless: the Ceaseless upgrade has to see
  // Balanced granted by LETHAL PROXIMITY (20) as well as by the weapon itself.
  reg.on('onWeaponRules', T.bind(A.disciplinarian, 40), (ev) => {
    if (ev.type !== 'ranged') return;
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, 'NAVIS')) return;
    if (op.datacardId === C.voidmaster) return; // "another friendly NAVIS operative"
    if (isPsaWeapon(ev.weaponName)) return; // "(excluding PRIVATEER SUPPORT ASSET weapons)"
    const master = T.friendlies(ev.state).find((o) => {
      if (o.datacardId !== C.voidmaster || o.incapacitated) return false;
      const range = T.ctx ? supportDistance(T.ctx, ev.state, o, 3) : 3;
      return T.gap(o, op) <= range + EPS;
    });
    if (!master) return;
    if (ev.rules.some((r) => r.id === 'Balanced'))
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Disciplinarian)'));
    else ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Disciplinarian)'));
  });

  // Hardy — "Once per battle, when an attack dice inflicts Normal Dmg on this operative, you
  // can ignore that inflicted damage." Free but single-use, so it is spent on the stated
  // policy (D-022): a normal dice of 3+ damage, or one that would incapacitate the VOIDMASTER.
  reg.on('onDamage', T.bind(A.hardy, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const op = ev.target;
    if (op.player !== T.player || op.datacardId !== C.voidmaster) return;
    if (usedThisBattle(ev.state, `es.hardy:${op.id}`)) return;
    const normal = incomingAttackDice(T, ev.state, op, ev.amount).find((d) => !d.crit);
    if (!normal) return;
    if (normal.dmg < 3 && ev.amount < op.wounds) return;
    useOncePerBattle(ev.state, `es.hardy:${op.id}`);
    ev.amount = Math.max(0, ev.amount - normal.dmg);
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Hardy ignores ${normal.dmg} damage` });
  });

  // UNCOMPROMISING FIRE — "…or during an activation in which it performed the Shoot action
  // (or vice versa)." The action's own `check` owns the first half; this is the second.
  reg.on('canPerformAction', T.bindText(ACT.uncompromisingFire, actionText(C.voidmaster, ACT.uncompromisingFire), 12), (ev) => {
    if (ev.action !== 'Shoot' || ev.operative.player !== T.player) return;
    if (!ev.operative.actionsThisActivation.includes(ACT.uncompromisingFire)) return;
    ev.allowed = false;
    ev.reason = 'UNCOMPROMISING FIRE: not during an activation in which it performed that action';
  });

  // =========================================================================
  // VOIDSMAN › Crewmen
  // =========================================================================
  reg.on('onCounteract', T.bind(A.crewmen, 12), (ev) => {
    const op = ev.operative;
    if (ev.allowed || op.player !== T.player || op.datacardId !== C.voidsman) return;
    if (op.order !== 'conceal') return;
    // "if you haven't used a PRIVATEER SUPPORT ASSET during this turning point"
    if (psaUsedThisTP(ev.state, T.player) || usedThisTP(ev.state, crewmenKey(T.player))) return;
    if (psaAvailableTo(T, ev.state, op).length === 0) return;
    ev.allowed = true;
  });
  reg.on('canPerformAction', T.bind(A.crewmen, 13), (ev) => {
    if (!crewmenCounteracting(T, ev.state, ev.operative)) return;
    if (ev.action === 'Shoot') return;
    ev.allowed = false;
    ev.reason = 'Crewmen: it cannot perform any actions other than Shoot';
  });
  reg.on('onActivationEnd', T.bind(A.crewmen, 13), (ev) => {
    if (!crewmenCounteracting(T, ev.state, ev.operative)) return;
    useOncePerTP(ev.state, crewmenKey(T.player)); // "Once per turning point"
  });
}

/** Which CALIBRATE VOLTAGHEIST effect this operative currently has, if any. */
export function voltagheistMode(state: GameState, op: OperativeState): 'charge' | 'field' | undefined {
  const eff = state.effects.find((e) => e.rule === E_VOLTAGHEIST && e.operativeId === op.id);
  const mode = eff?.data?.['mode'];
  return mode === 'charge' || mode === 'field' ? mode : undefined;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- LETHAL PROXIMITY (strategy) ---------------------------------------
  reg.on('onWeaponRules', T.bind(SP.lethalProximity, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.lethalProximity)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (isPsaWeapon(ev.weaponName)) return; // "(excluding PRIVATEER SUPPORT ASSET weapons)"
    const foe = ev.target;
    if (!foe || T.gap(ev.operative, foe) > 6 + EPS) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (LETHAL PROXIMITY)'));
  });

  // ---- STAKE CLAIM (strategy) --------------------------------------------
  reg.on('onPloyUsed', T.bind(SP.stakeClaim, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.stakeClaim) return;
    // D-016: the position comes from the intent's `data`, with a deterministic, logged default.
    const pos = posFromData(ev.data, centroidOf(T.friendlies(ev.state, KW), { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 }));
    placeTeamMarker(ev.state, { id: CLAIM_MARKER(T.player), kind: 'generic', player: T.player, pos, flags: { claim: true } });
    log(ev.state, { kind: 'ploy', player: T.player, text: `STAKE CLAIM marker placed at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}` });
  });
  reg.on('onEndOfTP', T.bind(SP.stakeClaim, 20), (ev) => {
    // "At the end of the turning point, remove your Claim marker from the killzone."
    if (ev.state.markers[CLAIM_MARKER(T.player)]) removeMarker(ev.state, CLAIM_MARKER(T.player));
  });
  reg.on('onRollAttack', T.bind(SP.stakeClaim, 20), (ev) => {
    const marker = ev.state.markers[CLAIM_MARKER(T.player)];
    if (!marker) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    const foe = ev.ctx.defender;
    if (!foe || T.markerGap(foe, marker) > 3 + EPS) return;
    // Only `shoot.ts` emits `onRollAttack`; `fight.ts` builds its re-roll grants without a
    // hook, so the "fighting against or retaliating against" halves are out of reach (D-031).
    const seq = shootSeq(ev.state);
    if (!seq || seq.usedRerolls.includes('es.stakeClaim')) return;
    seq.usedRerolls.push('es.stakeClaim');
    // "you can retain one of your fails as a normal success instead of discarding it, or retain
    //  one of your normal successes as a critical success instead" — free, so it is auto-used
    //  on the stated policy (D-022): whichever of the two adds more damage.
    const profile = ev.ctx.profile;
    const fail = seq.attack.dice.find((d) => d.state === 'fail');
    const normal = seq.attack.dice.find((d) => d.state === 'normal');
    const gainFromFail = fail ? profile.dmgN : -1;
    const gainFromNormal = normal ? profile.dmgC - profile.dmgN : -1;
    const die = gainFromNormal > gainFromFail ? normal : fail;
    if (!die || Math.max(gainFromFail, gainFromNormal) <= 0) return;
    const promoted = die === normal ? 'crit' : 'normal';
    die.state = promoted;
    die.note = 'STAKE CLAIM';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `STAKE CLAIM: ${op.letter} retains a ${promoted === 'crit' ? 'normal success as a critical' : 'fail as a normal'} success`,
    });
  });

  // ---- UNDAUNTED EXPLORERS (strategy) ------------------------------------
  reg.on('onDamage', T.bind(SP.undauntedExplorers, 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, SP.undauntedExplorers)) return;
    if (!T.mineKw(ev.target, KW)) return;
    if (usedThisTP(ev.state, `es.undaunted:${ev.target.id}`)) return;
    // "The first time an attack dice inflicts damage on each friendly operative during the
    //  turning point": a Shoot action inflicts one lump, so the halving is applied to the first
    //  unblocked dice of that lump.
    const first = incomingAttackDice(T, ev.state, ev.target, ev.amount)[0];
    const dmg = first?.dmg ?? ev.amount;
    const halved = Math.min(dmg, Math.max(2, Math.ceil(dmg / 2))); // "rounding up, to a minimum of 2"
    const cut = dmg - halved;
    if (cut <= 0) return;
    useOncePerTP(ev.state, `es.undaunted:${ev.target.id}`);
    ev.amount = Math.max(0, ev.amount - cut);
    log(ev.state, { kind: 'action', player: T.player, text: `UNDAUNTED EXPLORERS: ${ev.target.letter} halves ${dmg} to ${halved}` });
  });

  // ---- QUICK MARCH (strategy) --------------------------------------------
  // "you can use this rule … but it … cannot use a PRIVATEER SUPPORT ASSET during that
  // activation". The nominated operatives come from the gambit's `data` (D-016); the
  // deterministic default nominates only operatives that could not use a PRIVATEER SUPPORT
  // ASSET anyway, so the auto-taken choice is always free (D-022).
  reg.on('onPloyUsed', T.bind(SP.quickMarch, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.quickMarch) return;
    const supplied = ev.data?.['operativeIds'];
    const ids = Array.isArray(supplied)
      ? T.friendlies(ev.state, KW).filter((o) => (supplied as unknown[]).includes(o.id)).map((o) => o.id)
      : T.friendlies(ev.state, KW).filter((o) => !psaUser(T, o)).map((o) => o.id);
    bucket(ev.state, 'es.quickMarch')[T.player] = ids;
    log(ev.state, { kind: 'ploy', player: T.player, text: `QUICK MARCH: +1" Move for ${ids.length} operatives` });
  });
  reg.on('onMoveDistance', T.bind(SP.quickMarch, 20), (ev) => {
    if (ev.action !== 'Reposition') return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!quickMarchNominee(ev.state, ev.operative)) return;
    ev.inches += 1; // "add 1\" to its Move stat until the end of that activation"
  });

  // ---- COMBINED ARMS (firefight) -----------------------------------------
  // Which enemy operatives a friendly ES operative has shot this turning point.
  reg.on('onCollectAttackDice', T.bind(FP.combinedArms, 21), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const op = ev.ctx.attacker;
    const foe = ev.ctx.defender;
    if (!foe || !T.mineKw(op, KW)) return;
    const b = bucket(ev.state, 'es.shotThisTP');
    const key = `${ev.state.turningPoint}:${foe.id}`;
    const seen = String(b[key] ?? '').split(',').filter(Boolean);
    if (!seen.includes(op.id)) b[key] = [...seen, op.id].join(',');
  });
  reg.on('onRollAttack', T.bind(FP.combinedArms, 21), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.combinedArms)) return;
    const op = ev.ctx.attacker;
    const foe = ev.ctx.defender;
    if (!foe || !T.mineKw(op, KW)) return;
    if (isPsaWeapon(ev.ctx.weaponName)) return; // "You cannot use this ploy while shooting with a PRIVATEER SUPPORT ASSET."
    if (!shotByAnotherFriendly(ev.state, op, foe)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.usedRerolls.includes('es.combinedArms')) return;
    if (usedThisTP(ev.state, `es.combinedArmsSpent:${T.player}`)) return;
    useOncePerTP(ev.state, `es.combinedArmsSpent:${T.player}`);
    ev.rerolls.push({
      id: 'es.combinedArms',
      label: 'COMBINED ARMS: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text(FP.combinedArms)),
    });
  });

  // ---- SURVIVALIST (firefight) -------------------------------------------
  reg.on('onPloyUsed', T.bind(FP.survivalist, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.survivalist) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = chosenOperative(
      ev.state,
      ev.data,
      active && T.mineKw(active, KW) ? [active] : T.friendlies(ev.state, KW),
    );
    if (!op) return;
    const gained = heal(T, op, d3(T, ev.state, 'SURVIVALIST D3+2') + 2);
    effect(ev.state, {
      rule: E_SURVIVALIST,
      source: { kind: 'ploy', id: FP.survivalist },
      sourceText: shortQuote(text(FP.survivalist)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `SURVIVALIST: ${op.letter} regains ${gained} wounds` });
  });
  // "…during that activation you can ignore any changes to its APL stat." `aplOf` reads
  // `op.aplMods` and `StatMods.apl` into the SAME clamp, and it reads the array before it
  // emits this hook — so the changes are cancelled through `mods.apl` rather than by wiping
  // the array, which would also throw the changes away for good.
  reg.on('onStatMod', T.bind(FP.survivalist, 21), (ev) => {
    if (ev.operative.player !== T.player) return; // both players register every handler
    if (!effectOn(ev.state, ev.operative.id, E_SURVIVALIST)) return;
    const raw = ev.operative.aplMods.reduce((a, b) => a + b, 0);
    if (raw !== 0) ev.mods.apl -= raw;
  });

  // ---- GREAT ENDURANCE (firefight) ---------------------------------------
  reg.on('onPloyUsed', T.bind(FP.greatEndurance, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.greatEndurance) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates =
      active && T.mineKw(active, KW) && T.kw(active, 'NAVIS') ? [active] : T.friendlies(ev.state, 'NAVIS');
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    effect(ev.state, {
      rule: E_GREAT_ENDURANCE,
      source: { kind: 'ploy', id: FP.greatEndurance },
      sourceText: shortQuote(text(FP.greatEndurance)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `GREAT ENDURANCE: ${op.letter} +1 APL` });
  });
  reg.on('onStatMod', T.bind(FP.greatEndurance, 21), (ev) => {
    if (ev.operative.player !== T.player) return; // both players register every handler
    if (!effectOn(ev.state, ev.operative.id, E_GREAT_ENDURANCE)) return;
    ev.mods.apl += 1; // "Until the end of the activation, add 1 to its APL stat."
  });

  // ---- WELL-DRILLED (firefight) ------------------------------------------
  // The engine alternates activations strictly, so the pairing is recorded as an effect the
  // UI/AI reads (the same partial as the Breachers' Breach and Clear).
  reg.on('onPloyUsed', T.bind(FP.wellDrilled, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.wellDrilled) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !T.mineKw(active, KW) || !T.kw(active, 'NAVIS')) return;
    const mates = T.friendlies(ev.state, 'NAVIS').filter(
      (o) => o.id !== active.id && o.ready && T.gap(active, o) <= 3 + EPS && sees(T, ev.state, active, o),
    );
    const other = chosenOperative(ev.state, ev.data, mates);
    if (!other) return;
    effect(ev.state, {
      rule: E_WELL_DRILLED,
      source: { kind: 'ploy', id: FP.wellDrilled },
      sourceText: shortQuote(text(FP.wellDrilled)),
      operativeId: other.id,
      player: T.player,
      data: { firstId: active.id, otherId: other.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `WELL-DRILLED: ${other.letter} activates immediately after ${active.letter}`,
    });
  });
}

const shotByAnotherFriendly = (state: GameState, op: OperativeState, foe: OperativeState): boolean => {
  const seen = String(bucket(state, 'es.shotThisTP')[`${state.turningPoint}:${foe.id}`] ?? '')
    .split(',')
    .filter(Boolean);
  return seen.some((id) => id !== op.id);
};

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

const HOT_SHOT_WEAPONS = /^(laspistol|lasgun|relic laspistol)$/i;

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- ARMOURED UNDERSUIT ------------------------------------------------
  // "you can retain one of your defence dice results of 4 as a normal success" is a retention
  // transform on the DEFENCE pool, which has no hook of its own — so the promotion is applied
  // directly in the `defenceRerolls` emit of `onDefenceDice`, the only hook that sees the
  // rolled pool. Free, so it is auto-used (D-022).
  reg.on('onDefenceDice', T.bind(EQ.armouredUndersuit, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.armouredUndersuit)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || !T.kw(target, KW)) return;
    if (T.kw(target, 'CANID')) return; // "(excluding CANID)"
    const save = T.ctx ? saveOf(T.ctx, ev.state, target) : (T.card(target)?.save ?? 5);
    if (save !== 5) return; // "that has a 5+ Save stat"
    const seq = shootSeq(ev.state);
    if (!seq || seq.defence.dice.length === 0) return;
    const stamp = `${seq.attackerId}:${seq.targetId}:${seq.resolvedTargets.length}`;
    const b = bucket(ev.state, 'es.undersuit');
    if (b[target.id] === stamp) return;
    const die = seq.defence.dice.find((d) => d.rolled && d.state === 'fail' && d.value === 4);
    if (!die) return;
    b[target.id] = stamp;
    die.state = 'normal';
    die.note = 'Armoured Undersuit';
    log(ev.state, { kind: 'dice', player: T.player, text: `${target.letter}: Armoured Undersuit retains a 4 as a normal success` });
  });

  // ---- HOT SHOT CAPACITOR PACKS ------------------------------------------
  // Not free — Hot can inflict up to 6 damage on the shooter — so it is auto-used on the
  // stated policy (D-022): only while the shooter has more than 6 wounds remaining, where the
  // printed risk cannot incapacitate it.
  reg.on('onSelectWeapon', T.bind(EQ.hotShot, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    if (!hasEquipment(ev.state, T.player, EQ.hotShot)) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    if (!HOT_SHOT_WEAPONS.test(ev.ctx.weaponName.trim())) return;
    if (op.wounds <= 6) return;
    if (hotShotEffect(ev.state, op, ev.ctx.weaponName)) return; // already armed this turning point
    const b = bucket(ev.state, 'es.hotShotUses');
    const key = `${T.player}:${ev.state.turningPoint}`;
    const used = Number(b[key] ?? 0);
    if (used >= 2) return; // "Up to twice per turning point"
    b[key] = used + 1;
    effect(ev.state, {
      rule: E_HOT_SHOT,
      source: { kind: 'equipment', id: EQ.hotShot },
      sourceText: shortQuote(text(EQ.hotShot)),
      operativeId: op.id,
      player: T.player,
      data: { weapon: ev.ctx.weaponName.toLowerCase() },
      expiry: { kind: 'endOfTurningPoint' }, // "until the end of the turning point"
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Hot Shot Capacitor Packs (${ev.ctx.weaponName})` });
  });
  reg.on('onWeaponRules', T.bind(EQ.hotShot, 31), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!hotShotEffect(ev.state, ev.operative, ev.weaponName)) return;
    ev.rules.push(
      ruleTag('Hot', undefined, 'Hot (Hot Shot Capacitor Packs)'),
      ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Hot Shot Capacitor Packs)'),
    );
  });
  reg.on('onDamage', T.bind(EQ.hotShot, 32), (ev) => {
    if (ev.kind !== 'attack') return;
    const attacker = attackerOf(ev.state, ev.target);
    if (!attacker || attacker.player !== T.player) return;
    const seq = ev.state.sequence;
    const name = seq?.kind === 'shoot' ? seq.weaponName : seq?.kind === 'fight' ? seq.attackerWeapon : '';
    if (!hotShotEffect(ev.state, attacker, name)) return;
    // "add 1 to both Dmg stats of that weapon" — per unblocked attack dice (D-019: the shared
    // catalogue profile is never rewritten).
    const dice = incomingAttackDice(T, ev.state, ev.target, ev.amount).length;
    if (dice > 0) ev.amount += dice;
  });

  // ---- IMPROVED COORDINATES UPLINK ---------------------------------------
  reg.on('onWeaponRules', T.bind(EQ.uplink, 30), (ev) => {
    if (!uplinkApplies(T, ev.state, ev.operative, ev.weaponName, ev.target)) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Improved Coordinates Uplink)'));
  });
  reg.on('onCollectAttackDice', T.bind(EQ.uplink, 30), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    if (!uplinkApplies(T, ev.state, ev.ctx.attacker, ev.ctx.weaponName, ev.ctx.defender)) return;
    seq.obscured = false; // "the target cannot be obscured"
  });

  // RAPID GUNNERY is enforced inside the PRIVATEER SUPPORT ASSET selection above: it is the
  // only rule that lets an already-used asset be selected, and it is spent when it does.
}

function hotShotEffect(state: GameState, op: OperativeState, weaponName: string): boolean {
  if (!weaponName) return false;
  return state.effects.some(
    (e) =>
      e.rule === E_HOT_SHOT &&
      e.operativeId === op.id &&
      String(e.data?.['weapon'] ?? '') === weaponName.trim().toLowerCase(),
  );
}

function uplinkApplies(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  weaponName: string,
  target: OperativeState | undefined,
): boolean {
  if (!hasEquipment(state, T.player, EQ.uplink)) return false;
  if (op.player !== T.player || !T.kw(op, KW)) return false;
  if (!isPsaWeapon(weaponName)) return false;
  if (!target) return false;
  return T.friendlies(state, 'NAVIS').some((o) => !o.incapacitated && T.gap(o, target) <= 6 + EPS);
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const catalogueKw = (op: OperativeState, keyword: string): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

function aplBefore(ctx: GameContext, state: GameState, op: OperativeState): number {
  const card = ctx.datacards.get(op.datacardId);
  const base = card?.apl ?? 2;
  const raw = op.aplMods.reduce((a, b) => a + b, 0);
  return Math.max(0, base + Math.max(-1, Math.min(1, raw)));
}

function actions(data: typeof DATA) {
  return [
    // ---- CANID › GATHER 1AP ---------------------------------------------
    uniqueAction(data, C.canid, ACT.gather, {
      check: (ctx, state, op) => {
        // The free move is a Dash or Reposition; neither is possible while engaged.
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (effectOn(state, op.id, FREE_ACTION_RULE))
          return { ok: false, reason: 'it already has a free action to spend' };
        return { ok: true };
      },
      perform: (ctx, state, op) => {
        grantFreeAction(state, op, {
          sourceId: ACT.gather,
          sourceText: shortQuote(actionText(C.canid, ACT.gather)),
          kind: 'ability',
          threshold: aplBefore(ctx, state, op),
          only: ['Dash', 'Reposition', 'Pick Up Marker', 'Place Marker'],
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: GATHER` });
        return { ok: true };
      },
    }),

    // ---- DEATH CULT EXECUTIONER › TRAINED ASSASSIN 1AP -------------------
    uniqueAction(data, C.executioner, ACT.trainedAssassin, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        op.order = op.order === 'engage' ? 'conceal' : 'engage';
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: TRAINED ASSASSIN — order is now ${op.order}` });
        return { ok: true };
      },
    }),

    // ---- LECTRO-MAESTER › CALIBRATE VOLTAGHEIST 0AP ----------------------
    uniqueAction(data, C.lectroMaester, ACT.calibrate, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op, params) => {
        // "Select one of the following effects" — from the intent, with a deterministic,
        // logged default (D-016). Charge is first as printed.
        const raw = String(params.choice ?? params.data?.['mode'] ?? '').toLowerCase();
        const mode = raw === 'field' ? 'field' : 'charge';
        dropEffects(state, (e) => e.rule === E_VOLTAGHEIST && e.operativeId === op.id);
        effect(state, {
          rule: E_VOLTAGHEIST,
          source: { kind: 'ability', id: ACT.calibrate },
          sourceText: shortQuote(actionText(C.lectroMaester, ACT.calibrate)),
          operativeId: op.id,
          player: op.player,
          data: { mode },
          // Cleared at the start of this operative's next activation, when it is incapacitated
          // and when it performs this action again; the expiry is the engine-side backstop.
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CALIBRATE VOLTAGHEIST (${mode})` });
        return { ok: true };
      },
    }),

    // ---- REJUVENAT ADEPT › HEALING SERUM 1AP -----------------------------
    // D-026: the whole legality lives in `check`, because `src/ai/legal.ts` offers friendly and
    // enemy targets alike and only re-runs `check`.
    uniqueAction(data, C.rejuvenatAdept, ACT.healingSerum, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return serumTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly ELUCIDIAN STARSTRIDER operative within this operative’s control range' };
      },
      perform: (ctx, state, op, params) => {
        const target = serumTarget(ctx, state, op, params.targetOperativeId)!;
        const roll = ctx.rng.d3();
        recordRoll(state, 'elucidian-starstrider', [roll], op.player, 'HEALING SERUM D3+3');
        const card = ctx.datacards.get(target.datacardId);
        const before = target.wounds;
        target.wounds = Math.min(card?.wounds ?? target.wounds + roll + 3, target.wounds + roll + 3);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: HEALING SERUM — ${target.letter} regains ${target.wounds - before} wounds`,
        });
        return { ok: true };
      },
    }),

    // ---- VOIDMASTER › UNCOMPROMISING FIRE 1AP ----------------------------
    uniqueAction(data, C.voidmaster, ACT.uncompromisingFire, {
      check: (ctx, state, op, params) => {
        if (op.order === 'conceal') return { ok: false, reason: 'it cannot perform this action while it has a Conceal order' };
        if (op.actionsThisActivation.includes('Shoot'))
          return { ok: false, reason: 'not during an activation in which it performed the Shoot action' };
        if (!uncompromisingTarget(ctx, state, op, 'Relic laspistol', undefined, params.targetId))
          return { ok: false, reason: 'no valid target for its relic laspistol' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = uncompromisingTarget(ctx, state, op, 'Relic laspistol', undefined, params.targetId)!;
        // "in any order" — the relic laspistol goes first, deterministically and logged.
        effect(state, {
          rule: E_UNCOMPROMISING,
          source: { kind: 'ability', id: ACT.uncompromisingFire },
          sourceText: shortQuote(actionText(C.voidmaster, ACT.uncompromisingFire)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: UNCOMPROMISING FIRE (relic laspistol first)` });
        return getAction('Shoot')!.perform(ctx, state, op, { weaponName: 'Relic laspistol', targetId: target.id });
      },
    }),
  ];
}

/** "Select one friendly ELUCIDIAN STARSTRIDER operative within this operative's control range" */
function serumTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  targetId: string | undefined,
): OperativeState | undefined {
  const medicUsedOn = (id: string): boolean => Number(bucket(state, 'es.medicUsed')[id]) === state.turningPoint;
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && catalogueKw(o, KW))
    .filter((o) => inControlRange(ctx, state, op, o))
    // "It cannot be an operative that the Medic! rule was used on during this turning point."
    .filter((o) => !medicUsedOn(o.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (targetId) return candidates.find((o) => o.id === targetId);
  return candidates[0];
}

function uncompromisingTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  weaponName: string,
  profileName: string | undefined,
  targetId: string | undefined,
): OperativeState | undefined {
  const card = ctx.datacards.get(op.datacardId);
  const weapon = card?.weapons.find((w) => w.name === weaponName);
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  if (!profile) return undefined;
  const valid = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1')
    .filter((foe) => {
      const rules = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName });
      return checkTarget(ctx, state, op, foe, profile, rules).valid;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (targetId) return valid.find((o) => o.id === targetId);
  return valid[0];
}

/**
 * The second half of UNCOMPROMISING FIRE: "Perform two free Shoot actions with this operative
 * (this takes precedence over action restrictions)." A 0AP `ActionDef` of its own, because
 * `canPerformAction` can only forbid and the universal Shoot's own restriction is the blocker
 * (docs/DECISIONS.md D-021).
 */
registerAction({
  id: SHOOT_UNCOMPROMISING,
  name: SHOOT_UNCOMPROMISING,
  ap: 0,
  type: 'unique',
  sourceText: actionText(C.voidmaster, ACT.uncompromisingFire),
  available: (_ctx, state, op) =>
    op.datacardId === C.voidmaster && state.effects.some((e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id))
      return { ok: false, reason: 'only as the second Shoot of UNCOMPROMISING FIRE' };
    const target = uncompromisingTarget(ctx, state, op, 'Artificer shotgun', 'close range', params.targetId);
    if (!target) return { ok: false, reason: 'no valid target for its artificer shotgun (close range)' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const target = uncompromisingTarget(ctx, state, op, 'Artificer shotgun', 'close range', params.targetId)!;
    dropEffects(state, (e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id);
    return getAction('Shoot')!.perform(ctx, state, op, {
      weaponName: 'Artificer shotgun',
      profileName: 'close range',
      targetId: target.id,
    });
  },
});

// ---------------------------------------------------------------------------
// Ploy windows
// ---------------------------------------------------------------------------

const activeFriendly = (state: GameState, player: PlayerId): OperativeState | undefined => {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return op && op.player === player && !op.removed ? op : undefined;
};

// ---------------------------------------------------------------------------

export const elucidianStarstrider = defineTeam({
  id: 'elucidian-starstrider',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy after rolling your attack dice for a friendly ELUCIDIAN
    //  STARSTRIDER operative, if it's shooting an enemy operative that's been shot by another
    //  friendly ELUCIDIAN STARSTRIDER operative during this turning point."
    [FP.combinedArms]: (state, player) => {
      const shot = bucket(state, 'es.shotThisTP');
      const any = Object.entries(shot).some(
        ([key, ids]) => key.startsWith(`${state.turningPoint}:`) && String(ids ?? '').split(',').filter(Boolean).length > 0,
      );
      return any
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative has been shot by a friendly ELUCIDIAN STARSTRIDER operative this turning point' };
    },
    // "Use this firefight ploy when a friendly ELUCIDIAN STARSTRIDER operative is activated."
    [FP.survivalist]: (state, player) =>
      activeFriendly(state, player) && catalogueKw(activeFriendly(state, player)!, KW)
        ? { ok: true }
        : { ok: false, reason: 'no friendly ELUCIDIAN STARSTRIDER operative is activated' },
    // "…during a friendly ELUCIDIAN STARSTRIDER NAVIS operative's activation."
    [FP.greatEndurance]: (state, player) => {
      const op = activeFriendly(state, player);
      return op && catalogueKw(op, KW) && catalogueKw(op, 'NAVIS')
        ? { ok: true }
        : { ok: false, reason: 'no friendly ELUCIDIAN STARSTRIDER NAVIS operative is activated' };
    },
    // "…when a friendly NAVIS operative is activated. Select one OTHER ready friendly NAVIS
    //  operative visible to and within 3" of that operative."
    [FP.wellDrilled]: (state, player) => {
      const op = activeFriendly(state, player);
      if (!op || !catalogueKw(op, KW) || !catalogueKw(op, 'NAVIS'))
        return { ok: false, reason: 'no friendly ELUCIDIAN STARSTRIDER NAVIS operative is activated' };
      const mate = aliveOperatives(state, player).some((o) => o.id !== op.id && o.ready && catalogueKw(o, 'NAVIS'));
      return mate ? { ok: true } : { ok: false, reason: 'no other ready friendly NAVIS operative' };
    },
  },
  aiHints: {
    roles: {
      [C.vhane]: 'leader',
      [C.canid]: 'melee',
      [C.executioner]: 'melee',
      [C.lectroMaester]: 'support',
      [C.rejuvenatAdept]: 'support',
      [C.voidmaster]: 'gunner',
      [C.voidsman]: 'gunner',
    },
    ployValue: {
      [SP.lethalProximity]: 0.6,
      [SP.stakeClaim]: 0.5,
      [SP.undauntedExplorers]: 0.6,
      [SP.quickMarch]: 0.4,
      [FP.combinedArms]: 0.6,
      [FP.survivalist]: 0.5,
      [FP.greatEndurance]: 0.5,
      [FP.wellDrilled]: 0.3,
    },
    equipmentValue: {
      [EQ.armouredUndersuit]: 0.5,
      [EQ.hotShot]: 0.6,
      [EQ.uplink]: 0.5,
      [EQ.rapidGunnery]: 0.4,
    },
  },
});

export default elucidianStarstrider;
