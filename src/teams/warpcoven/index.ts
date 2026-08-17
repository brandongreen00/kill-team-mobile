/**
 * WARPCOVEN — Thousand Sons. https://wahapedia.ru/kill-team3/kill-teams/warpcoven/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is read
 * from `data/teams/warpcoven.json`, never retyped. The nine BOONS OF TZEENTCH are printed as
 * one faction rule with no per-boon ids, so each boon's rule text is sliced out of that one
 * string at module load (`BOON_TEXT`) rather than being copied into this file.
 *
 * Data notes (`warpcoven.json › notes`):
 *  - "no datacard in this team carries the LEADER keyword" — `selection.leader.count` is 0 and
 *    the shared validator's leader check passes trivially. Nothing here assumes a LEADER.
 *  - footnote ^1 ("With force stave, PSYCHIC weapons on their datacard and one of the following
 *    options") is already resolved by the normaliser into each SORCERER entry's
 *    `alwaysWeapons` (force stave + that sorcerer's PSYCHIC weapons), so no module-side
 *    loadout fix-up is needed. `PSYCHIC weapons on their datacard` is read here from the
 *    profiles' PSYCHIC rule, never from a weapon name.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext, type DecisionHandler } from '../../core/context.ts';
import { classify, rerollDie } from '../../core/dice.ts';
import {
  baseGap,
  baseRadius,
  baseWithin,
  dist,
  segmentCrossesPoly,
} from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import type { ActionParams } from '../../core/intents.ts';
import {
  aliveOperatives,
  body,
  card as cardOfOp,
  enemiesInControlRange,
  findProfile,
  hitOf,
  inControlRange,
  log,
  markerContestedBy,
  markerController,
  modelHeight,
  moveOf,
  recordRoll,
  settleZ,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, surfaceAt } from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import { loadoutOf } from '../selection.ts';
import {
  bucket,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantWeapon,
  grantedWeapons,
  hasEquipment,
  hasToken,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

/** Actions this module registers on top of the printed unique actions. */
export const ASTARTES_SHOOT = 'Shoot (Astartes, Warpcoven)';
export const ASTARTES_FIGHT = 'Fight (Astartes, Warpcoven)';
export const SAVAGE_BRUTALITY_FIGHT = 'Fight (Savage Brutality)';
export const CAPRICIOUS_DASH = 'Dash (Capricious Plan)';
export const MUTANT_PICK_UP = 'Pick Up Marker (Mutant Appendage)';
export const FLIGHT_REPOSITION = 'Reposition (Immaterial Flight)';
export const FLIGHT_CHARGE = 'Charge (Immaterial Flight)';

const DATA = teamData('warpcoven');
const KW = 'WARPCOVEN';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

const CARD = {
  destiny: 'warpcoven.sorcerer-of-destiny',
  tempyrion: 'warpcoven.sorcerer-of-tempyrion',
  warpfire: 'warpcoven.sorcerer-of-warpfire',
  gunner: 'warpcoven.rubric-marine-gunner',
  rubricIcon: 'warpcoven.rubric-marine-icon-bearer',
  rubricWarrior: 'warpcoven.rubric-marine-warrior',
  champion: 'warpcoven.tzaangor-champion',
  hornBearer: 'warpcoven.tzaangor-horn-bearer',
  tzaangorIcon: 'warpcoven.tzaangor-icon-bearer',
  tzaangorWarrior: 'warpcoven.tzaangor-warrior',
} as const;

const ACT = {
  protectedByFate: 'warpcoven.sorcerer-of-destiny.act.protected-by-fate',
  ravageDestiny: 'warpcoven.sorcerer-of-destiny.act.ravage-destiny',
  reconstitutionRitual: 'warpcoven.sorcerer-of-tempyrion.act.reconstitution-ritual',
  temporalFlux: 'warpcoven.sorcerer-of-tempyrion.act.temporal-flux',
  alight: 'warpcoven.sorcerer-of-warpfire.act.alight',
  brayhorn: 'warpcoven.tzaangor-horn-bearer.act.brayhorn',
} as const;

/** Effect / token / scratch keys, all namespaced. */
const PROTECTED = 'warpcoven.protectedByFate';
const RAVAGED = 'warpcoven.ravageDestiny';
const ALIGHT_TOKEN = 'warpcoven.alight';
const MINDBURN_TOKEN = 'warpcoven.mindburn';
const BRAYHORN_EFFECT = 'warpcoven.brayhorn';
const AUTOMATA_EFFECT = 'warpcoven.sorcerousAutomata';
const CAPRICIOUS_EFFECT = 'warpcoven.capriciousPlan';
const MUTANT_HERD_EFFECT = 'warpcoven.mutantHerd';
const CABAL_GRANT = 'warpcoven.cabalGrant';
const CABAL_LOCK = 'warpcoven.cabalLock';
const LAST_RANGED = 'warpcoven.lastRanged';
const PSYCHIC_USED = 'warpcoven.psychicUsedThisActivation';
const FATE_DICE = 'warpcoven.fateDice';
const FATE_KEY = 'warpcoven.fateItselfIsMyWeapon';
const RAVAGE_KEY = 'warpcoven.ravageSixes';
const TEMPORAL_MARKER = (player: PlayerId): string => `warpcoven.temporalFlux.${player}`;
const SCROLLS_DECISION = 'warpcoven.sorcerousScrolls';

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Boons of Tzeentch (faction rule 1)
// ---------------------------------------------------------------------------

export const BOONS = [
  'incorporeal-sight',
  'time-walk',
  'echoes-from-the-warp',
  'warp-swell',
  'mutant-appendage',
  'immaterial-flight',
  'twist-of-fate',
  'astral-bombardment',
  'master-of-the-immaterium',
] as const;
export type Boon = (typeof BOONS)[number];

/** The printed heading of each BOON OF TZEENTCH, in printed order. Names, not rule text. */
export const BOON_NAME: Record<Boon, string> = {
  'incorporeal-sight': 'Incorporeal Sight',
  'time-walk': 'Time-Walk',
  'echoes-from-the-warp': 'Echoes from the Warp',
  'warp-swell': 'Warp Swell',
  'mutant-appendage': 'Mutant Appendage',
  'immaterial-flight': 'Immaterial Flight',
  'twist-of-fate': 'Twist of Fate',
  'astral-bombardment': 'Astral Bombardment',
  'master-of-the-immaterium': 'Master of the Immaterium',
};

/**
 * The nine boons are printed inside the one BOONS OF TZEENTCH faction rule and the scrape has
 * no per-boon ids, so each boon's rule text is sliced out of that string here (CLAUDE.md: rule
 * text is data, never retyped). Each boon is `<heading>\n\n<flavour>\n\n<rule>`; the flavour
 * paragraph is dropped.
 */
export const BOON_TEXT: Record<Boon, string> = sliceBoonTexts();

function sliceBoonTexts(): Record<Boon, string> {
  const whole = text('warpcoven.rule.boons-of-tzeentch');
  const marks = BOONS.map((b) => ({ boon: b, at: whole.indexOf(`\n${BOON_NAME[b]}\n`) }));
  const out = {} as Record<Boon, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0)
      throw new Error(`BOON OF TZEENTCH '${BOON_NAME[mark.boon]}' is not in data/teams/warpcoven.json`);
    const from = mark.at + 1 + BOON_NAME[mark.boon].length;
    const to = marks[i + 1]?.at ?? whole.length;
    const paragraphs = whole
      .slice(from, to)
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    out[mark.boon] = (paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs).join('\n\n');
  });
  return out;
}

interface BoonRecord {
  boon: Boon;
  /** ASTRAL BOMBARDMENT: "Select one of this operative's PSYCHIC ranged weapons." */
  weapon?: string;
  /** ASTRAL BOMBARDMENT on firestorm/mindburn: Seek Light or Devastating 1, per Shoot action. */
  astral?: 'seek-light' | 'devastating';
}

function boonStore(state: GameState): Record<string, BoonRecord> {
  return bucket(state, 'warpcoven.boons') as Record<string, BoonRecord>;
}

export function boonOf(state: GameState, op: OperativeState): Boon | undefined {
  return boonStore(state)[op.id]?.boon;
}

export function boonRecord(state: GameState, op: OperativeState): BoonRecord | undefined {
  return boonStore(state)[op.id];
}

const isSorcererCard = (datacardId: string): boolean =>
  (DATA.datacards.find((c) => c.id === datacardId)?.keywords ?? []).includes('SORCERER');

/**
 * "Whenever you select a SORCERER operative for the battle, you must select a BOON OF TZEENTCH
 * (below) for it to have for the battle. You cannot select each BOON OF TZEENTCH more than once
 * per battle."
 *
 * Select Operatives has no decision channel (docs/TEAM-STATUS.md › Known engine gaps), so the
 * choice is made through this pure setter — the UI, the tests and a roster spec all call it.
 * Nothing applies until a boon is chosen.
 */
export function setBoon(
  state: GameState,
  operativeId: string,
  boon: Boon,
  opts: { weapon?: string } = {},
): { ok: boolean; reason?: string } {
  const op = state.operatives[operativeId];
  if (!op) return { ok: false, reason: 'no such operative' };
  if (!isSorcererCard(op.datacardId)) return { ok: false, reason: 'only a SORCERER operative has a BOON OF TZEENTCH' };
  const store = boonStore(state);
  for (const [id, rec] of Object.entries(store)) {
    if (id === operativeId) continue;
    const other = state.operatives[id];
    if (other && other.player === op.player && rec.boon === boon)
      return { ok: false, reason: `you cannot select ${BOON_NAME[boon]} more than once per battle` };
  }
  const weapon = opts.weapon ?? defaultAstralWeapon(op);
  store[operativeId] = { boon, ...(weapon ? { weapon } : {}), astral: 'devastating' };
  log(state, { kind: 'system', player: op.player, text: `${op.letter} has the ${BOON_NAME[boon]} BOON OF TZEENTCH` });
  return { ok: true };
}

/**
 * ASTRAL BOMBARDMENT on firestorm/mindburn: "whenever that operative performs the Shoot action,
 * select the Seek Light or Devastating 1 weapon rule for that weapon to have until the end of
 * the action (it cannot have both)". The Shoot intent carries no per-action rule choice, so the
 * pick is a stored, logged, deterministic setting that defaults to Devastating 1 (D-016).
 */
export function setAstralChoice(state: GameState, operativeId: string, choice: 'seek-light' | 'devastating'): void {
  const rec = boonStore(state)[operativeId];
  if (!rec) return;
  rec.astral = choice;
  const op = state.operatives[operativeId];
  if (op) log(state, { kind: 'system', player: op.player, text: `${op.letter}: Astral Bombardment — ${choice}` });
}

function defaultAstralWeapon(op: OperativeState): string | undefined {
  const card = DATA.datacards.find((c) => c.id === op.datacardId);
  return card?.weapons.find(isPsychicRangedWeapon)?.name;
}

function hasBoon(T: TeamHooks, state: GameState, op: OperativeState, boon: Boon): boolean {
  return op.player === T.player && boonOf(state, op) === boon;
}

/** Boon lookup that does not need a `TeamHooks` (unique actions and registered ActionDefs). */
const opHasBoon = (state: GameState, op: OperativeState, boon: Boon): boolean => boonOf(state, op) === boon;

/** MASTER OF THE IMMATERIUM: "Add 3" to the distance requirements of this operative's PSYCHIC
 *  actions that have a distance requirement." */
const psychicRange = (state: GameState, op: OperativeState, printed: number): number =>
  printed + (opHasBoon(state, op, 'master-of-the-immaterium') ? 3 : 0);

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const isPsychicProfile = (p: WeaponProfile): boolean => p.rules.some((r) => r.id === 'PSYCHIC');
const isPsychicRangedWeapon = (w: Weapon): boolean =>
  w.profiles.some((p) => p.type === 'ranged' && isPsychicProfile(p));

/** The PSYCHIC unique actions, read from the datacards (each prints "PSYCHIC." first). */
const PSYCHIC_ACTIONS: string[] = DATA.datacards.flatMap((c) =>
  c.uniqueActions.filter((a) => /^PSYCHIC\b/.test(a.text.trim())).map((a) => a.id),
);

/** Datacards that print the Sorcerous Automata ability. */
const AUTOMATA_CARDS: string[] = DATA.datacards
  .filter((c) => c.abilities.some((a) => a.id.endsWith('.sorcerous-automata')))
  .map((c) => c.id);

/** "a soulreaper cannon or a warpflamer" (Astartes' additional-AP clause). */
const isAstartesHeavy = (name: string): boolean => /^(soulreaper cannon|warpflamer)$/i.test(name.trim());

/** ENSORCELLED ROUNDS: "inferno boltguns, inferno bolt pistols and autopistols". */
const isEnsorcelled = (name: string): boolean =>
  /^(inferno boltgun|inferno bolt pistol|autopistol)$/i.test(name.trim());

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

function visible(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

function visibleFrom(ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean {
  return isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;
}

const gapOf = (ctx: GameContext, a: OperativeState, b: OperativeState): number =>
  baseGap(a.pos, cardOfOp(ctx, a).base, a.rot, b.pos, cardOfOp(ctx, b).base, b.rot);

/** "within your opponent's territory" (TZAANGOR WARRIOR › Relic Hunters). */
function inEnemyTerritory(ctx: GameContext, state: GameState, op: OperativeState): boolean {
  const polys = state.map.territories[otherPlayer(op.player)];
  return baseWithin(op.pos, cardOfOp(ctx, op).base, op.rot, polys);
}

/** Is this operative currently counteracting? */
const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

/**
 * The attack dice that are inflicting the damage `onDamage` is carrying right now.
 *
 * Shooting resolves the whole pool in one lump (`unblockedCrits * dmgC + unblockedNormals *
 * dmgN`), so the retained-and-unblocked dice are read straight off the pool. A fight resolves
 * one die at a time, so the die is identified from the amount. Rules that key off "an attack
 * dice inflicts Normal/Critical Dmg" (ALL IS DUST, Herd Banner, ARCANE ROBES, Warp Swell) all
 * read this.
 */
interface DamageDice {
  profile: WeaponProfile;
  attacker: OperativeState;
  normals: number;
  crits: number;
  type: 'ranged' | 'melee';
}

function damageDice(ctx: GameContext | undefined, state: GameState, target: OperativeState, amount: number): DamageDice | undefined {
  if (!ctx) return undefined;
  const shoot = shootSeq(state);
  if (shoot) {
    if (shoot.targetId !== target.id) return undefined;
    const attacker = state.operatives[shoot.attackerId];
    if (!attacker) return undefined;
    const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === shoot.weaponName);
    const profile = w ? findProfile(w, shoot.profileName) : undefined;
    if (!profile) return undefined;
    return {
      profile,
      attacker,
      type: 'ranged',
      normals: shoot.attack.dice.filter((d) => d.state === 'normal').length,
      crits: shoot.attack.dice.filter((d) => d.state === 'crit').length,
    };
  }
  const fight = fightSeq(state);
  if (!fight) return undefined;
  const strikerId = target.id === fight.defenderId ? fight.attackerId : fight.defenderId;
  if (target.id !== fight.defenderId && target.id !== fight.attackerId) return undefined;
  const striker = state.operatives[strikerId];
  if (!striker) return undefined;
  const name = strikerId === fight.attackerId ? fight.attackerWeapon : (fight.defenderWeapon ?? '');
  const profileName = strikerId === fight.attackerId ? fight.attackerProfile : fight.defenderProfile;
  const melee = weaponsOf(ctx, state, striker, 'melee');
  const w = melee.find((x) => x.name === name) ?? melee[0];
  const profile = w ? (findProfile(w, profileName) ?? w.profiles[0]) : undefined;
  if (!profile) return undefined;
  // A fight strikes one dice at a time, so the dice is identified from the amount. It is
  // compared with `>=` rather than `===` because an earlier handler (Warp Swell) may already
  // have added to it.
  const crit = profile.dmgC !== profile.dmgN && amount >= profile.dmgC;
  const normal = !crit && amount >= profile.dmgN;
  return { profile, attacker: striker, type: 'melee', normals: normal ? 1 : 0, crits: crit ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// PSYCHIC weapon bookkeeping (Astartes + PSYCHIC CABAL)
// ---------------------------------------------------------------------------

/** "You cannot select the same PSYCHIC ranged weapon more than once per activation." */
function psychicUsedThisActivation(state: GameState, op: OperativeState, weaponName: string): boolean {
  return state.effects.some(
    (e) => e.rule === PSYCHIC_USED && e.operativeId === op.id && String(e.data?.['weapon'] ?? '').toLowerCase() === weaponName.toLowerCase(),
  );
}

/** PSYCHIC CABAL: "a PSYCHIC ranged weapon that has been used … during this turning point". */
function psychicUsesThisTP(state: GameState): Record<string, string[]> {
  return bucket(state, 'warpcoven.psychicUsesTP') as Record<string, string[]>;
}

function recordPsychicUse(state: GameState, op: OperativeState, weaponName: string): void {
  const store = psychicUsesThisTP(state);
  const key = `${state.turningPoint}:${op.id}`;
  const list = store[key] ?? [];
  if (!list.some((n) => n.toLowerCase() === weaponName.toLowerCase())) list.push(weaponName);
  store[key] = list;
}

function usedPsychicThisTP(state: GameState, op: OperativeState, weaponName: string): boolean {
  const list = psychicUsesThisTP(state)[`${state.turningPoint}:${op.id}`] ?? [];
  return list.some((n) => n.toLowerCase() === weaponName.toLowerCase());
}

const hasCabalAction = (state: GameState, op: OperativeState, actionId: string): boolean =>
  state.effects.some((e) => e.rule === CABAL_GRANT && e.operativeId === op.id && e.data?.['actionId'] === actionId);

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  boons(reg, T);
  astartes(reg, T);
  abilities(reg, T);
}

function boons(reg: HookRegistry, T: TeamHooks): void {
  const bind = (boon: Boon, priority = 11) =>
    T.bindText(`warpcoven.boon.${boon}`, `${BOON_NAME[boon]}: ${BOON_TEXT[boon]}`, priority);

  // ---- Incorporeal Sight -------------------------------------------------
  reg.on('onWeaponRules', bind('incorporeal-sight'), (ev) => {
    if (ev.type !== 'ranged' || !hasBoon(T, ev.state, ev.operative, 'incorporeal-sight')) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Incorporeal Sight)'));
  });
  reg.on('onCollectAttackDice', bind('incorporeal-sight', 12), (ev) => {
    // "Whenever this operative is shooting, enemy operatives cannot be obscured."
    if (ev.ctx.type !== 'ranged' || !hasBoon(T, ev.state, ev.ctx.attacker, 'incorporeal-sight')) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false;
  });

  // ---- Time-Walk ---------------------------------------------------------
  reg.on('onStatMod', bind('time-walk'), (ev) => {
    if (!hasBoon(T, ev.state, ev.operative, 'time-walk')) return;
    ev.mods.move += 1;
  });

  // ---- Warp Swell --------------------------------------------------------
  reg.on('onDamage', bind('warp-swell'), (ev) => {
    if (ev.kind !== 'attack') return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.type !== 'melee' || dice.normals !== 1) return;
    if (!hasBoon(T, ev.state, dice.attacker, 'warp-swell')) return;
    ev.amount += 1; // "Add 1 to the Normal Dmg stat of this operative's melee weapons."
  });

  // ---- Mutant Appendage --------------------------------------------------
  reg.on('onActionCost', bind('mutant-appendage'), (ev) => {
    if (!hasBoon(T, ev.state, ev.operative, 'mutant-appendage')) return;
    if (!isDiscountableAction(ev.action)) return;
    // "Once per activation" — the discount is the FIRST such action of the activation.
    if (ev.operative.actionsThisActivation.some(isDiscountableAction)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- Twist of Fate -----------------------------------------------------
  reg.on('onWeaponRules', bind('twist-of-fate'), (ev) => {
    if (ev.type !== 'ranged' || !isPsychicProfile(ev.profile)) return;
    if (!hasBoon(T, ev.state, ev.operative, 'twist-of-fate')) return;
    ev.rules.push(ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Twist of Fate)'));
  });

  // ---- Astral Bombardment ------------------------------------------------
  reg.on('onWeaponRules', bind('astral-bombardment'), (ev) => {
    if (ev.type !== 'ranged' || !isPsychicProfile(ev.profile)) return;
    if (!hasBoon(T, ev.state, ev.operative, 'astral-bombardment')) return;
    const rec = boonRecord(ev.state, ev.operative);
    if (!rec?.weapon || rec.weapon.toLowerCase() !== ev.weaponName.toLowerCase()) return;
    const name = ev.weaponName.toLowerCase();
    if (name === 'doombolt') {
      // "If you select a doombolt, it has the 2" Devastating 2 weapon rule instead of Devastating 2."
      ev.rules = ev.rules.filter((r) => r.id !== 'Devastating');
      ev.rules.push({ id: 'Devastating', x: 2, dist: 2, raw: '2" Devastating 2 (Astral Bombardment)' });
      return;
    }
    if (name === 'firestorm' || name === 'mindburn') {
      // "select the Seek Light or Devastating 1 weapon rule … (it cannot have both)"
      if ((rec.astral ?? 'devastating') === 'seek-light') {
        ev.rules = ev.rules.filter((r) => r.id !== 'Devastating');
        if (!ev.rules.some((r) => r.id === 'SeekLight')) ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Astral Bombardment)'));
      } else {
        ev.rules = ev.rules.filter((r) => r.id !== 'SeekLight');
        ev.rules.push(ruleTag('Devastating', 1, 'Devastating 1 (Astral Bombardment)'));
      }
      return;
    }
    ev.rules.push(ruleTag('Devastating', 1, 'Devastating 1 (Astral Bombardment)'));
  });

  // Immaterial Flight and Master of the Immaterium live in the actions they modify:
  // `Reposition (Immaterial Flight)` / `Charge (Immaterial Flight)` and `psychicRange`.
  //
  // ECHOES FROM THE WARP is REMINDER-ONLY. "Once per battle, when you counteract with this
  // operative, you can change its order, and it can perform an additional 1AP action for free
  // during that counteraction": `reduce`'s PerformAction refuses a counteracting operative's
  // second action outright (`counteract.actionsUsed > 0`) and `counteractCandidates` filters on
  // the order before any hook is emitted, so neither half has a seam.
}

const DISCOUNTABLE = new Set<string>(['Pick Up Marker', 'Place Marker', MUTANT_PICK_UP]);
/** "the Pick Up Marker, Place Marker or a mission action". */
function isDiscountableAction(action: string): boolean {
  if (DISCOUNTABLE.has(action)) return true;
  return getAction(action)?.type === 'mission';
}

function astartes(reg: HookRegistry, T: TeamHooks): void {
  // "Each friendly WARPCOVEN HERETIC ASTARTES operative can counteract regardless of its order."
  //
  // NOTE: `counteractCandidates` (src/core/phases.ts) filters `o.order === 'engage'` BEFORE it
  // emits `onCounteract`, so today this grant cannot reach a Conceal operative. Registered so it
  // becomes live the moment that order test moves inside the hook; reported as a needed seam.
  reg.on('onCounteract', T.bind('warpcoven.rule.astartes', 12), (ev) => {
    if (T.mineKw(ev.operative, 'HERETIC ASTARTES') && T.kw(ev.operative, KW)) ev.allowed = true;
  });

  // Remember the ranged weapon used, so the Astartes second Shoot can be validated, and record
  // PSYCHIC uses for "not the same PSYCHIC ranged weapon more than once per activation" and for
  // PSYCHIC CABAL's per-turning-point restriction.
  reg.on('onCollectAttackDice', T.bind('warpcoven.rule.astartes', 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const attacker = ev.ctx.attacker;
    const existing = effectOn(ev.state, attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'warpcoven.rule.astartes' },
        operativeId: attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: attacker.id },
      });
    if (!isPsychicProfile(ev.ctx.profile)) return;
    recordPsychicUse(ev.state, attacker, ev.ctx.weaponName);
    if (psychicUsedThisActivation(ev.state, attacker, ev.ctx.weaponName)) return;
    effect(ev.state, {
      rule: PSYCHIC_USED,
      source: { kind: 'core', id: 'warpcoven.rule.astartes' },
      operativeId: attacker.id,
      player: T.player,
      data: { weapon: ev.ctx.weaponName },
      expiry: { kind: 'endOfActivation', operativeId: attacker.id },
    });
  });
}

function abilities(reg: HookRegistry, T: TeamHooks): void {
  // ---- SORCERER WARPFIRE › Mindburn (rare weapon rule) --------------------
  const mindburnBind = (p: number) => T.bindText('warpcoven.mindburn', abilityText(CARD.warpfire, 'warpcoven.sorcerer-of-warpfire.mindburn'), p);
  reg.on('onCollectAttackDice', mindburnBind(12), (ev) => {
    // "…or until a friendly operative uses this weapon again."
    if (!ev.ctx.rules.some((r) => r.id === 'Mindburn')) return;
    if (ev.ctx.attacker.player !== T.player) return;
    removeMindburn(ev.state, T.player);
  });
  reg.on('onStrikeResolved', mindburnBind(12), (ev) => {
    // "In the Resolve Attack Dice step, if you inflict damage with any critical successes, the
    //  operative this weapon is being used against gains one of your Mindburn tokens."
    if (!ev.ctx.rules.some((r) => r.id === 'Mindburn')) return;
    if (ev.ctx.attacker.player !== T.player || !ev.crit) return;
    if (hasToken(ev.state, ev.struck.id, MINDBURN_TOKEN, T.player)) return;
    effect(ev.state, {
      rule: MINDBURN_TOKEN,
      source: { kind: 'weapon', id: 'Mindburn' },
      sourceText: shortQuote(abilityText(CARD.warpfire, 'warpcoven.sorcerer-of-warpfire.mindburn')),
      operativeId: ev.struck.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: ev.struck.id, armed: false },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.struck.letter} gains a Mindburn token` });
  });
  reg.on('onStatMod', mindburnBind(12), (ev) => {
    // "Whenever an operative has one of your Mindburn tokens, worsen the Hit stat of its weapons
    //  by 1 (this isn't cumulative with being injured)."
    if (!hasToken(ev.state, ev.operative.id, MINDBURN_TOKEN, T.player)) return;
    const card = T.card(ev.operative);
    if (card && ev.operative.wounds < card.wounds / 2) return; // already worsened by being injured
    ev.mods.hit -= 1;
  });

  // ---- RUBRIC MARINE › Sorcerous Automata --------------------------------
  for (const cardId of AUTOMATA_CARDS) {
    const bind = (p: number) => T.bindText(`${cardId}.sorcerous-automata`, abilityText(cardId, `${cardId}.sorcerous-automata`), p);
    reg.on('onActivationStart', bind(11), (ev) => {
      if (ev.operative.datacardId !== cardId || ev.operative.player !== T.player) return;
      // "unless a friendly WARPCOVEN SORCERER operative is within 9" of it"
      const near = T.friendlies(ev.state, 'SORCERER').some(
        (s) => T.kw(s, KW) && s.id !== ev.operative.id && T.gap(s, ev.operative) <= 9 + EPS,
      );
      if (near) return;
      effect(ev.state, {
        rule: AUTOMATA_EFFECT,
        source: { kind: 'ability', id: `${cardId}.sorcerous-automata` },
        operativeId: ev.operative.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
      });
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter}: Sorcerous Automata (-1 APL)` });
    });
    reg.on('onStatMod', bind(11), (ev) => {
      if (ev.operative.datacardId !== cardId || ev.operative.player !== T.player) return;
      if (!effectOn(ev.state, ev.operative.id, AUTOMATA_EFFECT)) return;
      ev.mods.apl -= 1;
    });
  }

  // ---- Icon Bearer (RUBRIC MARINE and TZAANGOR) --------------------------
  for (const cardId of [CARD.rubricIcon, CARD.tzaangorIcon]) {
    reg.on('onMarkerControl', T.bindText(`${cardId}.icon-bearer`, abilityText(cardId, `${cardId}.icon-bearer`), 12), (ev) => {
      const marker = ev.state.markers[ev.markerId];
      if (!marker || !T.ctx) return;
      for (const op of T.friendlies(ev.state)) {
        if (op.datacardId !== cardId) continue;
        if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
        ev.aplByPlayer[T.player] += 1;
      }
    });
  }

  // ---- RUBRIC MARINE WARRIOR › Slow and Purposeful -----------------------
  reg.on(
    'onWeaponRules',
    T.bindText('warpcoven.rubric-marine-warrior.slow-and-purposeful', abilityText(CARD.rubricWarrior, 'warpcoven.rubric-marine-warrior.slow-and-purposeful'), 12),
    (ev) => {
      if (ev.type !== 'ranged' || ev.retaliating) return;
      if (ev.operative.datacardId !== CARD.rubricWarrior || ev.operative.player !== T.player) return;
      const moved = ev.operative.actionsThisActivation.some((a) => a === 'Charge' || a === 'Reposition');
      if (moved && !counteracting(ev.state, ev.operative)) return;
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Slow and Purposeful)'));
    },
  );

  // ---- TZAANGOR ICON BEARER › Herd Banner --------------------------------
  reg.on('onDamage', T.bindText('warpcoven.tzaangor-icon-bearer.herd-banner', abilityText(CARD.tzaangorIcon, 'warpcoven.tzaangor-icon-bearer.herd-banner'), 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!T.mineKw(ev.target, 'TZAANGOR') || !T.kw(ev.target, KW)) return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.normals <= 0 || dice.profile.dmgN < 3) return;
    const banner = T.friendlies(ev.state).some(
      (o) =>
        o.datacardId === CARD.tzaangorIcon &&
        o.id !== ev.target.id &&
        T.gap(o, ev.target) <= 3 + EPS &&
        visible(T, ev.state, o, ev.target),
    );
    if (!banner) return;
    ev.amount = Math.max(0, ev.amount - dice.normals); // "subtract 1 from that inflicted damage"
  });

  // ---- TZAANGOR WARRIOR › Relic Hunters ----------------------------------
  const relicKey = `warpcoven.relicHunters:${T.player}`;
  reg.on('onActionCost', T.bindText('warpcoven.tzaangor-warrior.relic-hunters', abilityText(CARD.tzaangorWarrior, 'warpcoven.tzaangor-warrior.relic-hunters'), 12), (ev) => {
    if (!T.mineKw(ev.operative, 'TZAANGOR') || !T.kw(ev.operative, 'WARRIOR')) return;
    if (!isDiscountableAction(ev.action)) return;
    if (usedThisBattle(ev.state, relicKey)) return;
    if (ev.operative.actionsThisActivation.some(isDiscountableAction)) return; // once, not once per activation
    if (!T.ctx || !inEnemyTerritory(T.ctx, ev.state, ev.operative)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onActivationEnd', T.bindText('warpcoven.tzaangor-warrior.relic-hunters', abilityText(CARD.tzaangorWarrior, 'warpcoven.tzaangor-warrior.relic-hunters'), 13), (ev) => {
    // `onActionCost` is emitted speculatively (the action sheet prices every action), so the
    // once-per-battle budget is only spent once the discounted action really happened.
    if (!T.mineKw(ev.operative, 'TZAANGOR') || !T.kw(ev.operative, 'WARRIOR')) return;
    if (!ev.operative.actionsThisActivation.some(isDiscountableAction)) return;
    if (!T.ctx || !inEnemyTerritory(T.ctx, ev.state, ev.operative)) return;
    useOncePerBattle(ev.state, relicKey);
  });

  // ---- TZAANGOR WARRIOR › Shield (rare weapon rule) ----------------------
  const shieldText = abilityText(CARD.tzaangorWarrior, 'warpcoven.tzaangor-warrior.shield');
  reg.on('onStatMod', T.bindText('warpcoven.tzaangor-warrior.shield', shieldText, 12), (ev) => {
    // "This operative has a 4+ Save stat" — the datacard prints 5+, the shield option improves it.
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.tzaangorWarrior) return;
    const carried = loadoutOf(ev.state, ev.operative.id) ?? [];
    if (!carried.some((n) => n.toLowerCase() === 'tzaangor blade & shield')) return;
    ev.mods.save += 1;
  });
  reg.on('onBlockAllocation', T.bindText('warpcoven.tzaangor-warrior.shield', shieldText, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Shield')) return;
    ev.blocks = 2; // "each of your blocks can be allocated to block two unresolved successes"
  });

  // ---- PROTECTED BY FATE / RAVAGE DESTINY / ALIGHT (unique-action effects) ----
  reg.on('onDefenceDice', T.bindText(ACT.protectedByFate, actionText(CARD.destiny, ACT.protectedByFate), 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    if (!effectOn(ev.state, target.id, PROTECTED)) return;
    ev.rerolls.push({
      id: PROTECTED,
      label: 'Protected by Fate: re-roll any of your defence dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(actionText(CARD.destiny, ACT.protectedByFate)),
    });
  });

  reg.on('onRollAttack', T.bindText(ACT.ravageDestiny, actionText(CARD.destiny, ACT.ravageDestiny), 12), (ev) => {
    // "your opponent must re-roll their attack dice results of 6" — a FORCED re-roll, which a
    // `RerollGrant` cannot express (every grant is offered as an optional decision), so the pool
    // is re-rolled here through the injected RNG.
    if (!T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const attacker = ev.ctx.attacker;
    if (attacker.player === T.player) return;
    if (!hasToken(ev.state, attacker.id, RAVAGED, T.player)) return;
    if (seq.usedRerolls.includes(RAVAGE_KEY)) return;
    seq.usedRerolls.push(RAVAGE_KEY);
    const sixes = seq.attack.dice.filter((d) => d.rolled && d.value === 6 && d.state !== 'discarded');
    if (sixes.length === 0) return;
    const hit = hitOf(T.ctx, ev.state, attacker, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    const lethal = ev.ctx.rules.find((r) => r.id === 'Lethal')?.x;
    const rolled: number[] = [];
    for (const die of sixes) {
      const v = T.ctx.rng.d6();
      rolled.push(v);
      rerollDie(die, v, hit, lethal !== undefined ? { lethal } : {});
    }
    recordRoll(ev.state, 'ravageDestiny', rolled, otherPlayer(T.player), 'RAVAGE DESTINY: re-roll results of 6');
    log(ev.state, {
      kind: 'dice',
      player: otherPlayer(T.player),
      text: `Ravage Destiny forces ${rolled.length} re-roll(s) of 6 → ${rolled.join(', ')}`,
    });
  });

  reg.on('onMarkerControl', T.bindText(ACT.ravageDestiny, actionText(CARD.destiny, ACT.ravageDestiny), 12), (ev) => {
    // "whenever determining control of a marker, treat that enemy operative's APL stat as 1 lower"
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    const foe = otherPlayer(T.player);
    for (const op of T.enemies(ev.state)) {
      if (!hasToken(ev.state, op.id, RAVAGED, T.player)) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      ev.aplByPlayer[foe] -= 1;
    }
  });

  reg.on('onWeaponRules', T.bindText(ACT.alight, actionText(CARD.warpfire, ACT.alight), 12), (ev) => {
    // "Whenever a friendly WARPCOVEN operative is shooting against, fighting against or
    //  retaliating against an enemy operative that has one of your Alight tokens, that friendly
    //  operative's weapons have the Ceaseless weapon rule."
    if (!ev.target || !T.mineKw(ev.operative, KW)) return;
    if (!hasToken(ev.state, ev.target.id, ALIGHT_TOKEN, T.player)) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Alight)'));
  });

  // ---- TZAANGOR HORN BEARER › BRAYHORN -----------------------------------
  reg.on('onStatMod', T.bindText(ACT.brayhorn, actionText(CARD.hornBearer, ACT.brayhorn), 12), (ev) => {
    if (!T.mineKw(ev.operative, 'TZAANGOR') || !T.kw(ev.operative, KW)) return;
    if (!ev.state.effects.some((e) => e.rule === BRAYHORN_EFFECT && e.player === T.player)) return;
    ev.mods.move += 1;
  });
}

function removeMindburn(state: GameState, player: PlayerId): void {
  dropEffects(state, (e) => e.rule === MINDBURN_TOKEN && e.player === player);
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  strategyPloys(reg, T);
  firefightPloys(reg, T);
}

function strategyPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- AETHERIAL WARDING (1CP) -------------------------------------------
  reg.on('onWeaponRules', T.bind('warpcoven.sp.aetherial-warding', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'warpcoven.sp.aetherial-warding')) return;
    if (ev.type !== 'ranged' || !ev.target) return;
    if (!T.mineKw(ev.target, KW)) return;
    if (!ev.rules.some((r) => r.id === 'Piercing' && (r.x ?? 0) === 1)) return;
    ev.rules = ev.rules.filter((r) => !(r.id === 'Piercing' && (r.x ?? 0) === 1));
    ev.rules.push(ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Aetherial Warding)'));
  });

  // ---- FATE ITSELF IS MY WEAPON (1CP) ------------------------------------
  reg.on('onPloyUsed', T.bind('warpcoven.sp.fate-itself-is-my-weapon', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'warpcoven.sp.fate-itself-is-my-weapon' || !T.ctx) return;
    const a = T.ctx.rng.d6();
    const b = T.ctx.rng.d6();
    recordRoll(ev.state, 'fateItself', [a, b], T.player, 'FATE ITSELF IS MY WEAPON — two reserved D6');
    effect(ev.state, {
      rule: FATE_DICE,
      source: { kind: 'ploy', id: 'warpcoven.sp.fate-itself-is-my-weapon' },
      sourceText: shortQuote(text('warpcoven.sp.fate-itself-is-my-weapon')),
      player: T.player,
      data: { dice: [a, b], sum: a + b },
      // "Discard any remaining reserved dice at the end of the turning point."
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Fate Itself Is My Weapon: reserved ${a} and ${b}` });
  });
  reg.on('onRollAttack', T.bind('warpcoven.sp.fate-itself-is-my-weapon', 21), (ev) => {
    if (!T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.usedRerolls.includes(FATE_KEY)) return; // "no more than one reserved dice per sequence"
    const reserve = ev.state.effects.find((e) => e.rule === FATE_DICE && e.player === T.player);
    const dice = (reserve?.data?.['dice'] as number[] | undefined) ?? [];
    if (!reserve || dice.length === 0) return;
    const attacker = ev.ctx.attacker;
    const mine = attacker.player === T.player;
    const hit = hitOf(T.ctx, ev.state, attacker, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    const lethal = ev.ctx.rules.find((r) => r.id === 'Lethal')?.x;
    const opts = lethal !== undefined ? { lethal } : {};
    const rank = (s: string): number => (s === 'crit' ? 2 : s === 'normal' ? 1 : 0);
    const candidates = seq.attack.dice.filter((d) => d.rolled && d.state !== 'discarded');
    if (candidates.length === 0) return;
    // Deterministic, logged use (D-016): which dice to replace has no decision channel, so a
    // reserved dice is spent only when it strictly helps — the best reserved dice improves one
    // of my dice, or the worst reserved dice downgrades one of my opponent's.
    const order = [...dice].sort((x, y) => (mine ? y - x : x - y));
    let bestIndex = -1;
    let bestValue = 0;
    let bestGain = 0;
    for (const value of order) {
      const after = rank(classify(value, hit, opts));
      for (const die of candidates) {
        const gain = mine ? after - rank(die.state) : rank(die.state) - after;
        if (gain <= 0 || gain <= bestGain) continue;
        bestIndex = die.id;
        bestValue = value;
        bestGain = gain;
      }
      if (bestGain > 0) break;
    }
    const chosen = candidates.find((d) => d.id === bestIndex);
    if (!chosen) return;
    seq.usedRerolls.push(FATE_KEY);
    const was = chosen.value;
    rerollDie(chosen, bestValue, hit, opts);
    // "that replacement dice cannot be re-rolled" — an unrolled dice is never offered for one.
    chosen.rolled = false;
    chosen.note = 'Fate Itself Is My Weapon';
    const at = dice.indexOf(bestValue);
    const left = dice.filter((_, i) => i !== at);
    const sum = Number(reserve.data?.['sum'] ?? 0);
    // "Then, if the combined result of both reserved dice was less than 9, discard the other dice."
    reserve.data = { ...(reserve.data ?? {}), dice: sum < 9 ? [] : left };
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Fate Itself Is My Weapon replaces a ${was} with the reserved ${bestValue}${sum < 9 ? ' (the other reserved dice is discarded)' : ''}`,
    });
  });

  // ---- BROTHERHOOD OF SORCERERS (1CP) ------------------------------------
  reg.on('onWeaponRules', T.bind('warpcoven.sp.brotherhood-of-sorcerers', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'warpcoven.sp.brotherhood-of-sorcerers')) return;
    if (!isPsychicProfile(ev.profile)) return;
    if (!T.mineKw(ev.operative, 'SORCERER') || !T.kw(ev.operative, KW)) return;
    const brother = T.friendlies(ev.state, 'SORCERER').some(
      (o) => o.id !== ev.operative.id && T.kw(o, KW) && T.gap(o, ev.operative) <= 9 + EPS,
    );
    ev.rules.push(
      brother
        ? ruleTag('Ceaseless', undefined, 'Ceaseless (Brotherhood of Sorcerers)')
        : ruleTag('Balanced', undefined, 'Balanced (Brotherhood of Sorcerers)'),
    );
  });

  // ---- SAVAGE HERD (1CP) --------------------------------------------------
  reg.on('onWeaponRules', T.bind('warpcoven.sp.savage-herd', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'warpcoven.sp.savage-herd')) return;
    if (ev.type !== 'melee') return;
    if (!T.mineKw(ev.operative, 'TZAANGOR') || !T.kw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Savage Herd)'));
    const seq = fightSeq(ev.state);
    const assisted =
      seq !== undefined &&
      ((seq.attackerId === ev.operative.id && seq.attackerAssists > 0) ||
        (seq.defenderId === ev.operative.id && seq.defenderAssists > 0));
    const sorcererNear =
      !ev.retaliating &&
      T.friendlies(ev.state, 'SORCERER').some(
        (s) => T.kw(s, KW) && T.gap(s, ev.operative) <= 6 + EPS && visible(T, ev.state, s, ev.operative),
      );
    if (assisted || sorcererNear) ev.rules.push(ruleTag('Severe', undefined, 'Severe (Savage Herd)'));
  });
}

function firefightPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- ALL IS DUST (1CP) --------------------------------------------------
  reg.on('onDamage', T.bind('warpcoven.fp.all-is-dust', 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!ployUsed(ev.state, T.player, 'warpcoven.fp.all-is-dust')) return;
    if (!T.mineKw(ev.target, 'RUBRIC MARINE') || !T.kw(ev.target, KW)) return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.normals <= 0 || dice.profile.dmgN <= 1) return;
    // The ploy is spent on ONE attack dice, and only once per turning point.
    if (!useOncePerTP(ev.state, `warpcoven.allIsDust:${T.player}`)) return;
    ev.amount = Math.max(0, ev.amount - (dice.profile.dmgN - 1));
  });

  // ---- CAPRICIOUS PLAN (1CP) ----------------------------------------------
  reg.on('onPloyUsed', T.bind('warpcoven.fp.capricious-plan', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'warpcoven.fp.capricious-plan') return;
    const sorcerers = T.friendlies(ev.state, 'SORCERER').filter((o) => T.kw(o, KW));
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = active && sorcerers.some((o) => o.id === active.id) ? [active] : sorcerers;
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    if (String(ev.data?.['mode'] ?? 'dash') === 'order') {
      op.order = op.order === 'engage' ? 'conceal' : 'engage';
      log(ev.state, { kind: 'ploy', player: T.player, text: `Capricious Plan: ${op.letter} changes its order to ${op.order}` });
      return;
    }
    effect(ev.state, {
      rule: CAPRICIOUS_EFFECT,
      source: { kind: 'ploy', id: 'warpcoven.fp.capricious-plan' },
      sourceText: shortQuote(text('warpcoven.fp.capricious-plan')),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Capricious Plan: ${op.letter} can perform a free Dash` });
  });

  // ---- PSYCHIC CABAL (1CP) ------------------------------------------------
  reg.on('onPloyUsed', T.bind('warpcoven.fp.psychic-cabal', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'warpcoven.fp.psychic-cabal') return;
    const sorcerers = T.friendlies(ev.state, 'SORCERER').filter((o) => T.kw(o, KW));
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const receiver = active && sorcerers.some((o) => o.id === active.id) ? active : chosenOperative(ev.state, ev.data, sorcerers);
    if (!receiver) return;
    const donors = sorcerers.filter(
      (o) => o.id !== receiver.id && T.gap(o, receiver) <= 9 + EPS && visible(T, ev.state, o, receiver),
    );
    const donor = chosenOperative(ev.state, { operativeId: ev.data?.['donorId'] }, donors);
    if (!donor) return;
    const donorCard = T.card(donor);
    // "You cannot select a PSYCHIC ranged weapon that has been used by that other friendly
    //  operative during this turning point."
    const weapons = (donorCard?.weapons ?? []).filter(
      (w) => isPsychicRangedWeapon(w) && !usedPsychicThisTP(ev.state, donor, w.name),
    );
    const actions = (donorCard?.uniqueActions ?? []).filter((a) => PSYCHIC_ACTIONS.includes(a.id));
    const wanted = ev.data?.['choice'];
    const wantedWeapon = typeof wanted === 'string' ? weapons.find((w) => w.name.toLowerCase() === wanted.toLowerCase()) : undefined;
    const wantedAction = typeof wanted === 'string' ? actions.find((a) => a.id === wanted) : undefined;
    const weapon = wantedWeapon ?? (wantedAction ? undefined : weapons[0]);
    const action = wantedAction ?? (weapon ? undefined : actions[0]);
    if (!weapon && !action) return;
    effect(ev.state, {
      rule: CABAL_GRANT,
      source: { kind: 'ploy', id: 'warpcoven.fp.psychic-cabal' },
      sourceText: shortQuote(text('warpcoven.fp.psychic-cabal')),
      operativeId: receiver.id,
      player: T.player,
      data: { ...(weapon ? { weaponName: weapon.name } : {}), ...(action ? { actionId: action.id } : {}), donorId: donor.id },
      expiry: { kind: 'endOfActivation', operativeId: receiver.id },
    });
    if (weapon) {
      grantWeapon(receiver, structuredClone(weapon)); // D-019: profiles are shared catalogue data
      // "that other friendly operative cannot use the selected weapon during this turning point"
      effect(ev.state, {
        rule: CABAL_LOCK,
        source: { kind: 'ploy', id: 'warpcoven.fp.psychic-cabal' },
        operativeId: donor.id,
        player: T.player,
        data: { weapon: weapon.name },
        expiry: { kind: 'endOfTurningPoint' },
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Psychic Cabal: ${receiver.letter} gains ${weapon ? weapon.name : (action?.name ?? '')} from ${donor.letter}`,
    });
  });
  reg.on('availableWeapons', T.bind('warpcoven.fp.psychic-cabal', 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    const locks = ev.state.effects.filter((e) => e.rule === CABAL_LOCK && e.operativeId === ev.operative.id);
    if (locks.length === 0) return;
    const seq = shootSeq(ev.state);
    for (const lock of locks) {
      const name = String(lock.data?.['weapon'] ?? '');
      // Never remove a weapon from under an in-flight sequence: `advanceShoot` re-reads the
      // operative's weapons at every step and asserts the named one is still there.
      if (seq && seq.attackerId === ev.operative.id && seq.weaponName === name) continue;
      ev.weapons = ev.weapons.filter((n) => n !== name);
    }
  });
  reg.on('onActivationEnd', T.bind('warpcoven.fp.psychic-cabal', 21), (ev) => {
    // "…for that first friendly operative to have until the end of its activation."
    if (ev.operative.player !== T.player) return;
    const grant = effectOn(ev.state, ev.operative.id, CABAL_GRANT);
    const name = grant?.data?.['weaponName'];
    if (typeof name !== 'string') return;
    const list = grantedWeapons(ev.operative);
    const i = list.findIndex((w) => w.name === name);
    if (i >= 0) list.splice(i, 1);
  });

  // ---- MUTANT HERD (1CP) --------------------------------------------------
  reg.on('onPloyUsed', T.bind('warpcoven.fp.mutant-herd', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'warpcoven.fp.mutant-herd') return;
    const tzaangor = T.friendlies(ev.state, 'TZAANGOR').filter((o) => T.kw(o, KW));
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const first = active && tzaangor.some((o) => o.id === active.id) ? active : chosenOperative(ev.state, ev.data, tzaangor);
    if (!first) return;
    const partners = tzaangor.filter(
      (o) => o.id !== first.id && o.ready && T.gap(o, first) <= 2 + EPS && visible(T, ev.state, o, first),
    );
    const partner = chosenOperative(ev.state, { operativeId: ev.data?.['partnerId'] }, partners);
    if (!partner) return;
    // The engine alternates activations strictly, so the pairing is recorded for the UI/AI to
    // offer the back-to-back activation (same shape as the Breachers' Breach and Clear).
    effect(ev.state, {
      rule: MUTANT_HERD_EFFECT,
      source: { kind: 'ploy', id: 'warpcoven.fp.mutant-herd' },
      sourceText: shortQuote(text('warpcoven.fp.mutant-herd')),
      operativeId: first.id,
      player: T.player,
      data: { partnerId: partner.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Mutant Herd: ${first.letter} and ${partner.letter} activate at the same time`,
    });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- ENSORCELLED ROUNDS -------------------------------------------------
  reg.on('onWeaponRules', T.bind('warpcoven.eq.ensorcelled-rounds', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'warpcoven.eq.ensorcelled-rounds')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!isEnsorcelled(ev.weaponName)) return;
    ev.rules.push(ruleTag('Devastating', 1, 'Devastating 1 (Ensorcelled Rounds)'));
  });

  // ---- DAEMONMAW WEAPONS --------------------------------------------------
  reg.on('onCollectAttackDice', T.bind('warpcoven.eq.daemonmaw-weapons', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'warpcoven.eq.daemonmaw-weapons')) return;
    if (ev.ctx.type !== 'melee') return;
    if (!T.mineKw(ev.ctx.attacker, 'RUBRIC MARINE') || !T.kw(ev.ctx.attacker, KW)) return;
    ev.count += 1; // "Add 1 to the Atk stat of friendly WARPCOVEN RUBRIC MARINE operatives' melee weapons."
  });
  reg.on('onWeaponRules', T.bind('warpcoven.eq.daemonmaw-weapons', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'warpcoven.eq.daemonmaw-weapons')) return;
    if (ev.type !== 'melee' || !ev.retaliating) return;
    if (!T.mineKw(ev.operative, 'RUBRIC MARINE') || !T.kw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Daemonmaw Weapons)'));
  });

  // ---- ARCANE ROBES -------------------------------------------------------
  reg.on('onDamage', T.bind('warpcoven.eq.arcane-robes', 30), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasEquipment(ev.state, T.player, 'warpcoven.eq.arcane-robes')) return;
    if (!T.mineKw(ev.target, 'SORCERER') || !T.kw(ev.target, KW)) return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.crits <= 0 || dice.profile.dmgC <= dice.profile.dmgN) return;
    if (!useOncePerTP(ev.state, `warpcoven.arcaneRobes:${T.player}`)) return;
    // "that attack dice inflicts Normal Dmg instead" — one dice.
    ev.amount = Math.max(0, ev.amount - (dice.profile.dmgC - dice.profile.dmgN));
  });

  // ---- SORCEROUS SCROLLS --------------------------------------------------
  reg.on('onActivationStart', T.bind('warpcoven.eq.sorcerous-scrolls', 30), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, 'warpcoven.eq.sorcerous-scrolls')) return;
    if (!T.kw(ev.operative, 'SORCERER') || !T.kw(ev.operative, KW)) return;
    if (usedThisBattle(ev.state, `warpcoven.scrolls:${T.player}`)) return;
    const taken = new Set(
      T.friendlies(ev.state)
        .filter((o) => o.id !== ev.operative.id)
        .map((o) => boonOf(ev.state, o))
        .filter((b): b is Boon => Boolean(b)),
    );
    const current = boonOf(ev.state, ev.operative);
    const options: PendingDecision['options'] = [
      { id: 'decline', label: 'Keep the current BOON OF TZEENTCH' },
      ...BOONS.filter((b) => b !== current && !taken.has(b)).map((b) => ({
        id: b,
        label: `Sorcerous Scrolls: ${BOON_NAME[b]}`,
        data: { operativeId: ev.operative.id, boon: b },
      })),
    ];
    if (options.length <= 1) return;
    ev.state.pending.push({
      id: `scrolls-${ev.state.seq++}`,
      who: T.player,
      kind: SCROLLS_DECISION,
      prompt: `${ev.operative.letter}: select a different BOON OF TZEENTCH (Sorcerous Scrolls)`,
      optional: true,
      sourceText: shortQuote(text('warpcoven.eq.sorcerous-scrolls')),
      options,
      ctx: { operativeId: ev.operative.id },
    });
  });
}

/** SORCEROUS SCROLLS owns its own decision kind, claimed through `GameContext.decisionHandlers`. */
const decisionHandler: DecisionHandler = (_ctx, state, decision, optionId, data) => {
  if (decision.kind !== SCROLLS_DECISION) return false;
  if (optionId === 'decline' || optionId === 'keep' || optionId === 'skip') return true;
  const option = decision.options.find((o) => o.id === optionId);
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const operativeId = String(payload['operativeId'] ?? decision.ctx?.['operativeId'] ?? '');
  const boon = String(payload['boon'] ?? optionId) as Boon;
  if (!BOONS.includes(boon)) return true;
  const op = state.operatives[operativeId];
  if (!op || op.removed) return true;
  // "it loses any it previously had" — `setBoon` overwrites the record.
  delete boonStore(state)[operativeId];
  const r = setBoon(state, operativeId, boon);
  if (r.ok) useOncePerBattle(state, `warpcoven.scrolls:${op.player}`);
  return true;
};

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** PSYCHIC CABAL can hand a PSYCHIC unique action to another SORCERER for its activation. */
function cabalShareable(def: ActionDef): ActionDef {
  const base = def.available;
  return {
    ...def,
    available: (ctx, state, op) => (base?.(ctx, state, op) ?? true) || hasCabalAction(state, op, def.id),
  };
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- PROTECTED BY FATE 1AP — SORCERER DESTINY ------------------------
    cabalShareable(
      uniqueAction(data, CARD.destiny, ACT.protectedByFate, {
        check: (ctx, state, op, params) => {
          const eng = notEngaged(ctx, state, op);
          if (!eng.ok) return eng;
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player !== op.player || target.id === op.id)
            return { ok: false, reason: 'select one friendly WARPCOVEN operative visible to this operative' };
          if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
            return { ok: false, reason: 'select one friendly WARPCOVEN operative' };
          if (!visibleFrom(ctx, state, op, target)) return { ok: false, reason: 'that operative is not visible to this operative' };
          return { ok: true };
        },
        perform: (_ctx, state, op, params) => {
          const target = state.operatives[params.targetOperativeId!]!;
          // "…or until this action is performed again by a friendly operative."
          dropEffects(state, (e) => e.rule === PROTECTED && e.player === op.player);
          effect(state, {
            rule: PROTECTED,
            source: { kind: 'ability', id: ACT.protectedByFate },
            sourceText: shortQuote(actionText(CARD.destiny, ACT.protectedByFate)),
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
          });
          log(state, { kind: 'action', player: op.player, text: `${op.letter}: PROTECTED BY FATE on ${target.letter}` });
          return { ok: true };
        },
      }),
    ),

    // ---- RAVAGE DESTINY 1AP — SORCERER DESTINY ---------------------------
    cabalShareable(
      uniqueAction(data, CARD.destiny, ACT.ravageDestiny, {
        check: (ctx, state, op, params) => {
          const eng = notEngaged(ctx, state, op);
          if (!eng.ok) return eng;
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player === op.player)
            return { ok: false, reason: 'select one enemy operative visible to and within 9" of this operative' };
          const range = psychicRange(state, op, 9);
          if (gapOf(ctx, op, target) > range + EPS) return { ok: false, reason: `that operative is more than ${range}" away` };
          if (!visibleFrom(ctx, state, op, target)) return { ok: false, reason: 'that operative is not visible to this operative' };
          return { ok: true };
        },
        perform: (_ctx, state, op, params) => {
          const target = state.operatives[params.targetOperativeId!]!;
          dropEffects(state, (e) => e.rule === RAVAGED && e.player === op.player);
          effect(state, {
            rule: RAVAGED,
            source: { kind: 'ability', id: ACT.ravageDestiny },
            sourceText: shortQuote(actionText(CARD.destiny, ACT.ravageDestiny)),
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
          });
          log(state, { kind: 'action', player: op.player, text: `${op.letter}: RAVAGE DESTINY on ${target.letter}` });
          return { ok: true };
        },
      }),
    ),

    // ---- RECONSTITUTION RITUAL 1AP — SORCERER TEMPYRION ------------------
    cabalShareable(
      uniqueAction(data, CARD.tempyrion, ACT.reconstitutionRitual, {
        check: (ctx, state, op, params) => {
          const eng = notEngaged(ctx, state, op);
          if (!eng.ok) return eng;
          // "…or if a friendly operative has already performed this action during this turning point."
          if (usedThisTP(state, `warpcoven.reconstitution:${op.player}`))
            return { ok: false, reason: 'a friendly operative has already performed this action during this turning point' };
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player !== op.player || target.id === op.id)
            return { ok: false, reason: 'select one friendly WARPCOVEN operative visible to and within 6" of this operative' };
          if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
            return { ok: false, reason: 'select one friendly WARPCOVEN operative' };
          const range = psychicRange(state, op, 6);
          if (gapOf(ctx, op, target) > range + EPS) return { ok: false, reason: `that operative is more than ${range}" away` };
          if (!visibleFrom(ctx, state, op, target)) return { ok: false, reason: 'that operative is not visible to this operative' };
          return { ok: true };
        },
        perform: (ctx, state, op, params) => {
          const target = state.operatives[params.targetOperativeId!]!;
          useOncePerTP(state, `warpcoven.reconstitution:${op.player}`);
          const heal = ctx.rng.d3() + ctx.rng.d3(); // "regains up to 2D3 lost wounds"
          recordRoll(state, 'reconstitutionRitual', [heal], op.player, 'RECONSTITUTION RITUAL 2D3');
          const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
          target.wounds = Math.min(max, target.wounds + heal);
          log(state, {
            kind: 'action',
            player: op.player,
            text: `${op.letter}: RECONSTITUTION RITUAL restores ${heal} wounds to ${target.letter}`,
          });
          return { ok: true };
        },
      }),
    ),

    // ---- TEMPORAL FLUX 1AP — SORCERER TEMPYRION --------------------------
    cabalShareable(
      uniqueAction(data, CARD.tempyrion, ACT.temporalFlux, {
        check: (ctx, state, op, params) => {
          const eng = notEngaged(ctx, state, op);
          if (!eng.ok) return eng;
          // "…or if your Temporal Flux marker is currently in the killzone."
          if (state.markers[TEMPORAL_MARKER(op.player)])
            return { ok: false, reason: 'your Temporal Flux marker is already in the killzone' };
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player !== op.player || target.id === op.id)
            return { ok: false, reason: 'select one friendly WARPCOVEN operative visible to and within 6" of this operative' };
          if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
            return { ok: false, reason: 'select one friendly WARPCOVEN operative' };
          // MASTER OF THE IMMATERIUM: "this boon only affects the distance in the first effect".
          const range = psychicRange(state, op, 6);
          if (gapOf(ctx, op, target) > range + EPS) return { ok: false, reason: `that operative is more than ${range}" away` };
          if (!visibleFrom(ctx, state, op, target)) return { ok: false, reason: 'that operative is not visible to this operative' };
          return { ok: true };
        },
        perform: (ctx, state, op, params) => {
          const target = state.operatives[params.targetOperativeId!]!;
          const pos = params.markerPos && withinControl(ctx, target, params.markerPos) ? params.markerPos : target.pos;
          placeTeamMarker(state, {
            id: TEMPORAL_MARKER(op.player),
            kind: 'generic',
            player: op.player,
            pos: { ...pos },
            z: target.z,
            flags: { targetId: target.id },
          });
          log(state, { kind: 'action', player: op.player, text: `${op.letter}: TEMPORAL FLUX marker placed by ${target.letter}` });
          return { ok: true };
        },
      }),
    ),

    // ---- ALIGHT 1AP — SORCERER WARPFIRE ----------------------------------
    cabalShareable(
      uniqueAction(data, CARD.warpfire, ACT.alight, {
        check: (ctx, state, op, params) => {
          const eng = notEngaged(ctx, state, op);
          if (!eng.ok) return eng;
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player === op.player)
            return { ok: false, reason: 'select one enemy operative visible to this operative' };
          if (!visibleFrom(ctx, state, op, target)) return { ok: false, reason: 'that operative is not visible to this operative' };
          return { ok: true };
        },
        perform: (_ctx, state, op, params) => {
          const target = state.operatives[params.targetOperativeId!]!;
          dropEffects(state, (e) => e.rule === ALIGHT_TOKEN && e.player === op.player);
          effect(state, {
            rule: ALIGHT_TOKEN,
            source: { kind: 'ability', id: ACT.alight },
            sourceText: shortQuote(actionText(CARD.warpfire, ACT.alight)),
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
          });
          log(state, { kind: 'action', player: op.player, text: `${op.letter}: ALIGHT — ${target.letter} gains an Alight token` });
          return { ok: true };
        },
      }),
    ),

    // ---- BRAYHORN 0AP — TZAANGOR HORN BEARER -----------------------------
    uniqueAction(data, CARD.hornBearer, ACT.brayhorn, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === BRAYHORN_EFFECT && e.player === op.player);
        effect(state, {
          rule: BRAYHORN_EFFECT,
          source: { kind: 'ability', id: ACT.brayhorn },
          sourceText: shortQuote(actionText(CARD.hornBearer, ACT.brayhorn)),
          player: op.player,
          // "Until the Ready step of the next Strategy phase."
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: BRAYHORN (+1" Move for friendly TZAANGOR)` });
        return { ok: true };
      },
    }),
  ];
}

const withinControl = (ctx: GameContext, op: OperativeState, pos: Vec2): boolean =>
  baseGap(op.pos, cardOfOp(ctx, op).base, op.rot, pos, { shape: 'round', mm: 20 }, 0) <= 1 + EPS;

// ---------------------------------------------------------------------------
// TEMPORAL FLUX's second effect (end of the selected operative's next activation)
// ---------------------------------------------------------------------------

function temporalFlux(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onActivationEnd', T.bindText(ACT.temporalFlux, actionText(CARD.tempyrion, ACT.temporalFlux), 12), (ev) => {
    const marker = ev.state.markers[TEMPORAL_MARKER(T.player)];
    if (!marker || !T.ctx) return;
    if (String(marker.flags['targetId'] ?? '') !== ev.operative.id) return;
    const op = ev.operative;
    const card = T.card(op);
    const wholly =
      !op.removed &&
      !op.incapacitated &&
      card !== undefined &&
      dist(op.pos, marker.pos) + baseRadius(card.base) <= 6 + EPS;
    if (!wholly) {
      // "If that operative isn't wholly within 6" … remove that marker from the killzone."
      removeMarker(ev.state, marker.id);
      log(ev.state, { kind: 'action', player: T.player, text: 'Temporal Flux marker removed' });
      return;
    }
    const spot = placementNear(T.ctx, ev.state, op, marker.pos);
    if (spot) {
      op.pos = { ...spot };
      settleZ(T.ctx, ev.state, op);
      op.onGuard = false;
      const carried = op.carryingMarkerId ? ev.state.markers[op.carryingMarkerId] : undefined;
      if (carried) {
        carried.pos = { ...op.pos };
        carried.z = op.z;
      }
      log(ev.state, { kind: 'action', player: T.player, text: `${op.letter} is removed and set back up by the Temporal Flux marker` });
    }
    removeMarker(ev.state, marker.id);
  });
}

/**
 * "…set it back up in a location it can be placed; when it's set back up, it must have your
 * Temporal Flux marker within its control range (or as close as possible)."
 */
function placementNear(ctx: GameContext, state: GameState, op: OperativeState, at: Vec2): Vec2 | undefined {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return undefined;
  const step = 0.5;
  for (let radius = 0; radius <= 4 + EPS; radius += step) {
    const spokes = radius === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * radius) / step));
    for (let i = 0; i < spokes; i++) {
      const angle = (2 * Math.PI * i) / spokes;
      const pos: Vec2 = { x: at.x + radius * Math.cos(angle), y: at.y + radius * Math.sin(angle) };
      if (canPlaceAt(ctx, state, op, pos)) return pos;
    }
  }
  return undefined;
}

/** Set-up legality for a removed-and-set-up-again operative. */
function canPlaceAt(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2): boolean {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return false;
  const index = terrain(ctx, state);
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, card.base, op.rot, z, modelHeight(card))) return false;
  if (baseTouchesHazardous(index, pos, card.base, op.rot)) return false;
  const r = baseRadius(card.base);
  const { w, h } = state.map.board;
  if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS) return false;
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (Math.abs(other.z - z) > 1) continue;
    if (baseGap(pos, card.base, op.rot, other.pos, oc.base, other.rot) < -1e-4) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Astartes: the second Shoot / Fight action of an activation
// ---------------------------------------------------------------------------

/**
 * "During each friendly HERETIC ASTARTES operative's activation, it can perform either two Shoot
 * actions or two Fight actions. If it's two Shoot actions and a soulreaper cannon or a warpflamer
 * is selected for both, 1 additional AP must be spent for the second action. You cannot select the
 * same PSYCHIC ranged weapon more than once per activation."
 *
 * Action restrictions forbid repeating an action, so the second one is its own `ActionDef` that
 * resolves through the universal action (D-021).
 */
const isHereticAstartes = (ctx: GameContext, op: OperativeState): boolean => {
  const kws = ctx.datacards.get(op.datacardId)?.keywords ?? [];
  return kws.includes('HERETIC ASTARTES') && kws.includes(KW);
};

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'warpcoven.rule.astartes')!.text,
  available: (ctx, _state, op) => isHereticAstartes(ctx, op),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const name = params.weaponName ?? '';
    const w = weaponsOf(ctx, state, op, 'ranged').find((x) => x.name === name);
    if (w && isPsychicRangedWeapon(w) && psychicUsedThisActivation(state, op, name))
      return { ok: false, reason: 'you cannot select the same PSYCHIC ranged weapon more than once per activation' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    // "1 additional AP must be spent for the second action" when both are a soulreaper cannon
    // or a warpflamer. The reducer adds the def's own AP after `perform`, so the extra is
    // charged here (the same shape the Angels of Death module uses).
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    if (isAstartesHeavy(first) && isAstartesHeavy(second)) op.apSpent += 1;
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'warpcoven.rule.astartes')!.text,
  available: (ctx, _state, op) => isHereticAstartes(ctx, op),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// TZAANGOR CHAMPION › Savage Brutality
// ---------------------------------------------------------------------------

/**
 * "The first time this operative performs the Fight action during each of its activations, if it
 * isn't incapacitated, it can immediately perform a free Fight action afterwards … This takes
 * precedence over action restrictions."
 *
 * A free action is 0AP, so it needs no APL grant (`grantFreeAction` pushes a +1 `aplMods` the
 * engine never pops, which would leave the CHAMPION permanently on APL 3). Its own id carries
 * its own action restriction, so it can be performed once per activation and no more.
 */
registerAction({
  id: SAVAGE_BRUTALITY_FIGHT,
  name: 'Fight (Savage Brutality)',
  ap: 0,
  type: 'unique',
  sourceText: abilityText(CARD.champion, 'warpcoven.tzaangor-champion.savage-brutality'),
  available: (_ctx, _state, op) => op.datacardId === CARD.champion,
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'the free Fight follows the first Fight action of the activation' };
    if (op.incapacitated) return { ok: false, reason: 'this operative is incapacitated' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// CAPRICIOUS PLAN's free Dash
// ---------------------------------------------------------------------------

/**
 * "That friendly operative can immediately perform a free Dash action (even if it's performed an
 * action that prevents it from performing the Dash action)". 0AP with its own restriction key, so
 * a Charge (or an earlier Dash) cannot block it.
 */
registerAction({
  id: CAPRICIOUS_DASH,
  name: 'Dash (Capricious Plan)',
  ap: 0,
  type: 'unique',
  sourceText: DATA.firefightPloys.find((p) => p.id === 'warpcoven.fp.capricious-plan')!.text,
  available: (_ctx, state, op) =>
    state.effects.some((e) => e.rule === CAPRICIOUS_EFFECT && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === CAPRICIOUS_EFFECT && e.operativeId === op.id))
      return { ok: false, reason: 'Capricious Plan has not been used on this operative' };
    // A ghost without the blocking actions: "even if it's performed an action that prevents it
    // from performing the Dash action".
    const ghost: OperativeState = {
      ...op,
      actionsThisActivation: op.actionsThisActivation.filter((a) => a !== 'Charge' && a !== 'Dash'),
    };
    return getAction('Dash')!.check(ctx, state, ghost, params);
  },
  perform: (ctx, state, op, params) => getAction('Dash')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// MUTANT APPENDAGE's Pick Up Marker
// ---------------------------------------------------------------------------

/**
 * "Having an enemy operative within this operative's control range doesn't prevent it from
 * performing the Pick Up Marker or mission actions." `canPerformAction` can only forbid, never
 * permit (D-021), so the permitted form is its own action treated as Pick Up Marker.
 *
 * The "or mission actions" half is REMINDER-ONLY: mission actions are registered by
 * `src/core/ops/**` at runtime and a team module cannot wrap an action it does not own.
 */
registerAction({
  id: MUTANT_PICK_UP,
  name: 'Pick Up Marker (Mutant Appendage)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: `${BOON_NAME['mutant-appendage']}: ${BOON_TEXT['mutant-appendage']}`,
  available: (_ctx, state, op) => opHasBoon(state, op, 'mutant-appendage'),
  check(ctx, state, op, params) {
    if (!opHasBoon(state, op, 'mutant-appendage'))
      return { ok: false, reason: 'this operative does not have the Mutant Appendage boon' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker) return { ok: false, reason: 'no such marker' };
    if (!marker.flags['pickUpAllowed']) return { ok: false, reason: 'this marker cannot be picked up' };
    if (!markerContestedBy(ctx, state, marker, op)) return { ok: false, reason: 'that marker is not within control range' };
    // Only the engaged restriction is lifted; the marker must still be controlled.
    if (markerController(ctx, state, marker) !== op.player)
      return { ok: false, reason: 'your operatives do not control that marker' };
    return { ok: true };
  },
  perform: (ctx, state, op, params) => getAction('Pick Up Marker')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// IMMATERIAL FLIGHT
// ---------------------------------------------------------------------------

const flightKey = (op: OperativeState): string => `warpcoven.immaterialFlight:${op.id}`;

interface FlightPlan {
  ok: boolean;
  reason?: string;
  dest?: Vec2;
}

/**
 * "Once per turning point, when this operative is performing the Charge or Reposition action
 * during its activation, it can FLY. If it does, don't move it. Instead, remove it from the
 * killzone and set it back up wholly within a distance equal to its Move stat horizontally of its
 * original location… Note that it gains no additional distance when performing the Charge action.
 * It must be set up in a location it can be placed, and unless it's the Charge action, it cannot
 * be set up within control range of an enemy operative."
 *
 * Pure: `check` and `perform` both run this, so whatever `check` accepts, `perform` completes
 * (D-026).
 */
function planFlight(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  base: 'Reposition' | 'Charge',
): FlightPlan {
  if (!opHasBoon(state, op, 'immaterial-flight'))
    return { ok: false, reason: 'this operative does not have the Immaterial Flight boon' };
  if (usedThisTP(state, flightKey(op))) return { ok: false, reason: 'Immaterial Flight is once per turning point' };
  const engaged = enemiesInControlRange(ctx, state, op).length > 0;
  if (base === 'Reposition') {
    if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.actionsThisActivation.includes('Fall Back') || op.actionsThisActivation.includes('Charge'))
      return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
  } else {
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
    if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
    if (
      op.actionsThisActivation.includes('Reposition') ||
      op.actionsThisActivation.includes('Dash') ||
      op.actionsThisActivation.includes('Fall Back')
    )
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
  }
  const dest = params.targetPos;
  if (!dest) return { ok: false, reason: 'select the location to FLY to' };
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  // "a distance equal to its Move stat horizontally" — no additional 2" for the Charge action.
  const budget = moveOf(ctx, state, op);
  const travelled = dist(op.pos, dest);
  if (travelled > budget + EPS) return { ok: false, reason: `a ${budget}" FLY cannot reach there` };
  // A FLY that does not move the operative would spend 1AP and the once-per-turning-point use
  // for nothing, so it is refused rather than offered (the same bar the Murderwing BOOST sets).
  if (travelled < 1 - EPS) return { ok: false, reason: 'a FLY must move the operative at least 1"' };
  if (!canPlaceAt(ctx, state, op, dest)) return { ok: false, reason: 'it cannot be set up there' };
  if (state.map.closeQuarters) {
    const index = terrain(ctx, state);
    if (index.walls.some((wall) => segmentCrossesPoly(op.pos, dest, wall.poly)))
      return { ok: false, reason: 'this distance cannot be measured over or through Wall terrain' };
    if (index.parts.some((p) => p.role === 'accessPoint' && segmentCrossesPoly(op.pos, dest, p.poly)))
      return { ok: false, reason: 'it cannot be set up on the other side of an access point' };
  }
  const ghost: OperativeState = { ...op, pos: dest, z: surfaceAt(terrain(ctx, state), dest) };
  const engagedAtEnd = aliveOperatives(state, otherPlayer(op.player)).filter((e) => inControlRange(ctx, state, ghost, e));
  if (base === 'Reposition' && engagedAtEnd.length > 0)
    return { ok: false, reason: 'unless it’s the Charge action, it cannot be set up within control range of an enemy operative' };
  if (base === 'Charge' && engagedAtEnd.length === 0)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  return { ok: true, dest };
}

function applyFlight(ctx: GameContext, state: GameState, op: OperativeState, plan: FlightPlan, base: 'Reposition' | 'Charge'): void {
  useOncePerTP(state, flightKey(op));
  op.pos = { ...plan.dest! };
  settleZ(ctx, state, op);
  op.onGuard = false;
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
  if (base === 'Charge') {
    const sticky = enemiesInControlRange(ctx, state, op).filter(
      (e) =>
        !aliveOperatives(state, op.player).some(
          (f) => f.id !== op.id && enemiesInControlRange(ctx, state, f).some((x) => x.id === e.id),
        ),
    );
    op.stickyEngagedWith = sticky.map((e) => e.id);
  }
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} FLIES (${base}, Immaterial Flight) to ${op.pos.x.toFixed(1)},${op.pos.y.toFixed(1)}`,
  });
}

for (const base of ['Reposition', 'Charge'] as const) {
  registerAction({
    id: base === 'Reposition' ? FLIGHT_REPOSITION : FLIGHT_CHARGE,
    name: `${base} (Immaterial Flight)`,
    ap: 1,
    type: 'unique',
    treatedAs: base,
    sourceText: `${BOON_NAME['immaterial-flight']}: ${BOON_TEXT['immaterial-flight']}`,
    available: (_ctx, state, op) => opHasBoon(state, op, 'immaterial-flight'),
    check: (ctx, state, op, params) => {
      const plan = planFlight(ctx, state, op, params, base);
      return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'it cannot FLY there' };
    },
    perform: (ctx, state, op, params) => {
      const plan = planFlight(ctx, state, op, params, base);
      if (!plan.ok) return { ok: false, reason: plan.reason ?? 'it cannot FLY there' };
      applyFlight(ctx, state, op, plan, base);
      return { ok: true };
    },
  });
}

// ---------------------------------------------------------------------------

/** "Use this firefight ploy when a friendly WARPCOVEN <X> operative is …" */
function needs(keyword: string, count: number, label: string) {
  return (state: GameState, player: PlayerId): { ok: boolean; reason?: string } => {
    const n = aliveOperatives(state, player).filter((o) => {
      const kws = DATA.datacards.find((c) => c.id === o.datacardId)?.keywords ?? [];
      return kws.includes(KW) && kws.includes(keyword);
    }).length;
    return n >= count ? { ok: true } : { ok: false, reason: `this ploy needs ${label} in the killzone` };
  };
}

export const warpcoven = defineTeam({
  id: 'warpcoven',
  rules: (reg, T) => {
    rules(reg, T);
    temporalFlux(reg, T);
    // SORCEROUS SCROLLS raises its own BOON-swap decision; the handler is installed once per
    // GameContext (`decisionHandler` is a stable reference).
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // Each firefight ploy names the operative whose window it is; without one in the killzone
    // the ploy has nothing to attach to, so it is refused rather than burning the CP.
    'warpcoven.fp.all-is-dust': needs('RUBRIC MARINE', 1, 'a friendly WARPCOVEN RUBRIC MARINE operative'),
    'warpcoven.fp.capricious-plan': needs('SORCERER', 1, 'a friendly WARPCOVEN SORCERER operative'),
    'warpcoven.fp.psychic-cabal': needs('SORCERER', 2, 'two friendly WARPCOVEN SORCERER operatives'),
    'warpcoven.fp.mutant-herd': needs('TZAANGOR', 2, 'two friendly WARPCOVEN TZAANGOR operatives'),
  },
  aiHints: {
    roles: {
      [CARD.destiny]: 'leader',
      [CARD.tempyrion]: 'support',
      [CARD.warpfire]: 'gunner',
      [CARD.gunner]: 'gunner',
      [CARD.rubricIcon]: 'objective',
      [CARD.rubricWarrior]: 'objective',
      [CARD.champion]: 'melee',
      [CARD.hornBearer]: 'support',
      [CARD.tzaangorIcon]: 'objective',
      [CARD.tzaangorWarrior]: 'melee',
    },
    ployValue: {
      'warpcoven.sp.aetherial-warding': 0.5,
      'warpcoven.sp.fate-itself-is-my-weapon': 0.5,
      'warpcoven.sp.brotherhood-of-sorcerers': 0.7,
      'warpcoven.sp.savage-herd': 0.5,
      'warpcoven.fp.all-is-dust': 0.7,
      'warpcoven.fp.capricious-plan': 0.4,
      'warpcoven.fp.psychic-cabal': 0.5,
      'warpcoven.fp.mutant-herd': 0.3,
    },
    equipmentValue: {
      'warpcoven.eq.ensorcelled-rounds': 0.6,
      'warpcoven.eq.daemonmaw-weapons': 0.4,
      'warpcoven.eq.arcane-robes': 0.6,
      'warpcoven.eq.sorcerous-scrolls': 0.4,
    },
  },
});

export default warpcoven;
