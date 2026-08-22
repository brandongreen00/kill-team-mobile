/**
 * CHAOS CULT. https://wahapedia.ru/kill-team3/kill-teams/chaos-cult/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read out of `data/teams/chaos-cult.json` and never retyped (CLAUDE.md: rules as data).
 *
 * The team is two interlocking faction rules:
 *
 *  - **Mutation** turns a friendly operative into a DIFFERENT operative type mid-battle — the
 *    only rule in the game that swaps an operative's datacard. It is a 0CP STRATEGIC GAMBIT of
 *    its own (the Wolf Scouts' Elemental Storm / Raveners' Tunnel shape) plus a kill trigger,
 *    and it is what puts the CHAOS MUTANT and CHAOS TORMENT datacards on the table: neither has
 *    a selection row, so a kill team NEVER starts with one.
 *
 *  - **Accursed Gifts** is a MENU of six gifts with no ids of their own, so each gift's rule
 *    text is sliced out of that one printed string at module load (`GIFT_TEXT`) — the Warpcoven
 *    BOONS OF TZEENTCH / Legionary Marks of Chaos treatment. The primary is chosen the first
 *    time a DEVOTEE becomes a MUTANT and the secondary the first time a MUTANT becomes a
 *    TORMENT; both moments are reachable, so the pick comes from the gambit/ploy `data` with a
 *    deterministic logged default (D-016) and the pure setter `setAccursedGift` for the UI.
 *
 * Rare weapon rules: `PSYCHIC` — a weapon keyword with no printed definition, resolved through
 * `rareRuleTextFor` (D-033).
 *
 * Data problem, reported loudly: **RUINOUS ICON's printed effect list is truncated out of the
 * JSON** (the text stops at "…until it performs this action again (whichever comes first):"),
 * so the action is registered and its restriction enforced but its whole benefit is
 * reminder-only — the SEVENTH rule blocked by that one scraper defect.
 */
import { allActions, getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseRadius, baseWhollyWithin, basesOverlap, dist } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import type { ActionParams } from '../../core/intents.ts';
import { validateMove, type MoveOptions } from '../../core/movement.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  findProfile,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
  settleZ,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous } from '../../core/terrain.ts';
import { coverAndObscured, isVisible, type Body } from '../../core/visibility.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PlayerId,
  Poly,
  Vec2,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  FREE_ACTION_RULE,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
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

const DATA = teamData('chaos-cult');
export const KW = 'CHAOS CULT';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

export const RULE = {
  accursedGifts: 'chaos-cult.rule.accursed-gifts',
  mutation: 'chaos-cult.rule.mutation',
} as const;

export const CARD = {
  demagogue: 'chaos-cult.cult-demagogue',
  blessedBlade: 'chaos-cult.blessed-blade',
  iconarch: 'chaos-cult.iconarch',
  mindwitch: 'chaos-cult.mindwitch',
  devotee: 'chaos-cult.devotee',
  mutant: 'chaos-cult.mutant',
  torment: 'chaos-cult.torment',
} as const;

export const AB = {
  cutThemDown: 'chaos-cult.blessed-blade.cut-them-down',
  attunedInPurpose: 'chaos-cult.blessed-blade.attuned-in-purpose',
  iconBearer: 'chaos-cult.iconarch.icon-bearer',
  groupActivation: 'chaos-cult.devotee.group-activation',
  accursedMutant: 'chaos-cult.mutant.accursed-mutant',
  mutantRegeneration: 'chaos-cult.mutant.unnatural-regeneration',
  accursedTorment: 'chaos-cult.torment.accursed-torment',
  brute: 'chaos-cult.torment.brute',
  tormentRegeneration: 'chaos-cult.torment.unnatural-regeneration',
} as const;

export const ACT = {
  inciteSlaughter: 'chaos-cult.cult-demagogue.act.incite-slaughter',
  inciteUrgency: 'chaos-cult.cult-demagogue.act.incite-urgency',
  ruinousIcon: 'chaos-cult.iconarch.act.ruinous-icon',
  heinousDeluge: 'chaos-cult.mindwitch.act.heinous-deluge',
  maleficVortex: 'chaos-cult.mindwitch.act.malefic-vortex',
} as const;

export const SP = {
  exaltationInPain: 'chaos-cult.sp.exaltation-in-pain',
  ferventOnslaught: 'chaos-cult.sp.fervent-onslaught',
  creaturesOfNightmare: 'chaos-cult.sp.creatures-of-nightmare',
  sickeningAura: 'chaos-cult.sp.sickening-aura',
} as const;

export const FP = {
  faithfulFollower: 'chaos-cult.fp.faithful-follower',
  abhorrentMutation: 'chaos-cult.fp.abhorrent-mutation',
  frenziedDemise: 'chaos-cult.fp.frenzied-demise',
  unleashTheDaemon: 'chaos-cult.fp.unleash-the-daemon',
} as const;

export const EQ = {
  balefulScript: 'chaos-cult.eq.baleful-script',
  covertGuises: 'chaos-cult.eq.covert-guises',
  unholyTalisman: 'chaos-cult.eq.unholy-talisman',
  vileBlessing: 'chaos-cult.eq.vile-blessing',
} as const;

/** STRATEGIC GAMBITs this team offers beyond its four strategy ploys. */
export const MUTATE_GAMBIT = 'chaos-cult.gambit.mutation';

/** Extra `ActionDef`s a rule grants that a universal action forbids (D-021). */
export const FIGHT_DAEMON = 'Fight (Unleash the Daemon)';
export const WINGS_REPOSITION = 'Reposition (Deformed Wings)';
export const WINGS_DASH = 'Dash (Deformed Wings)';
export const WINGS_CHARGE = 'Charge (Deformed Wings)';
export const WINGS_FALL_BACK = 'Fall Back (Deformed Wings)';

/** Effect / token / scratch keys, all namespaced (never module-level state — rule 7). */
const GIFT_BAG = 'chaos-cult.gifts';
const MUTATE_BAG = 'chaos-cult.mutatedTP';
const TORMENT_BAG = 'chaos-cult.tormentsTP';
const ABHORRENT_BAG = 'chaos-cult.abhorrentUsed';
const PENDING_MUTATION = 'chaos-cult.pendingMutation';
const CUT_THEM_DOWN_WATCH = 'chaos-cult.cutThemDownWatch';
const GROUP_ACTIVATION = 'chaos-cult.groupActivation';
const GROUP_ACTIVATION_USED = 'chaos-cult.groupActivation.used';
const DAEMON_EFFECT = 'chaos-cult.unleashTheDaemon';
const HEINOUS_EFFECT = 'chaos-cult.heinousDeluge';
const RUINOUS_EFFECT = 'chaos-cult.ruinousIcon';
const URGENCY_CHARGE_CAP = 'chaos-cult.inciteUrgencyCharge';
const FRENZIED_ARMED = 'chaos-cult.frenziedDemiseArmed';
const COVERT_GUISES_D3 = 'chaos-cult.covertGuisesD3';
const VILE_BLESSING_USED = 'chaos-cult.vileBlessingUsedThisDamage';

export const VORTEX_MARKER = (player: PlayerId): string => `chaos-cult.maleficVortex.${player}`;

/**
 * The `ActionDef`s this module registers on top of the printed unique actions (D-021). They are
 * the universal action wearing a different id, so the CHAOS MUTANT / CHAOS TORMENT bans on
 * "unique actions" must not reach them.
 */
const TEAM_CARVE_OUTS = new Set<string>([
  FIGHT_DAEMON,
  WINGS_REPOSITION,
  WINGS_DASH,
  WINGS_CHARGE,
  WINGS_FALL_BACK,
]);

/** Every rule of this team that hands out a `grantFreeAction`, for the `aplMods` upkeep. */
const FREE_ACTION_SOURCES = new Set<string>([
  ACT.inciteSlaughter,
  ACT.inciteUrgency,
  FP.unleashTheDaemon,
  EQ.covertGuises,
]);

/**
 * Printed clauses this module does NOT implement, each with the engine reason. Exported so the
 * tests can pin every one of them — `docs/TEAM-STATUS.md` is only worth anything if it is
 * honest, and a declared-but-unemitted hook would be the silent no-op rule 5 forbids.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [ACT.ruinousIcon]:
    'DATA: the printed effect list is truncated out of the JSON — the text stops at "Select one of the following effects to last until … (whichever comes first):" with the list absent, so the action, its PSYCHIC tag, its duration and its control-range restriction are real but the effect carries no payload (the seventh SPOT-shaped truncation)',
  [`${RULE.mutation}.miniature`]:
    'the printed "swap the miniatures … if the old miniature was [within control range of enemy operatives], the new miniature must be if possible" cannot be honoured when a 40mm TORMENT base does not fit: the module keeps the old centre when it can and otherwise takes the nearest legal spot, so the control-range clause is a consequence rather than a constraint',
  [`${AB.accursedTorment}.melee`]:
    'weaponsOf appends grantedWeapons AFTER availableWeapons filters the datacard and startFight picks the melee weapon with no hook, so "cannot use any weapons that aren\'t on its datacard" reaches ranged weapons only (through onSelectWeapon); it bites on nothing today because this team grants no weapon',
  [`${AB.attunedInPurpose}.pairing`]:
    'EndActivation sets activePlayer to the opponent AFTER onActivationEnd fires and nothing runs later, so the simultaneous activation is recorded as an effect for the UI/AI (the Breach and Clear / Group Activation partial)',
  [`${AB.groupActivation}.pairing`]:
    'EndActivation sets activePlayer to the opponent AFTER onActivationEnd fires, so "you must then activate one other ready friendly CHAOS CULT DEVOTEE operative" is recorded as an effect for the UI/AI only',
  [`${FP.faithfulFollower}.fight`]:
    'startFight takes its defender straight from the intent and emits nothing beforehand, so only the Shoot half has a target-substitution seam (onSelectTarget); the Fight half and its "treat that other operative as being within the fighting operative\'s control range" have none',
  [`${EQ.covertGuises}.dropZone`]:
    'no hook constrains where a move ENDS (onMoveRules is never emitted and onMoveDistance only scales the allowance), so "must end that move wholly within 3\\" of your drop zone" is not enforced',
  [`${EQ.balefulScript}.perOperative`]:
    'an ACCURSED GIFT gained from the Abhorrent Mutation ploy is stored per operative, and BALEFUL SCRIPT changes one of the two kill-team-wide gifts; "if it\'s an ACCURSED GIFT an operative has from the Abhorrent Mutation firefight ploy, only that operative benefits from this" would need a per-operative swap channel the gambit intent does not carry',
};

/** Clauses that are implemented, but at a moment or in a form the engine shifts. */
export const PARTIAL: Record<string, string> = {
  [`${RULE.mutation}.killTrigger`]:
    'advanceShoot non-null-asserts the attacker\'s weapon on every pass, so swapping a datacard mid-sequence would crash it; a MUTATE earned by "incapacitates an enemy operative within its control range" is therefore recorded and applied at the next activation boundary',
  [`${AB.cutThemDown}.timing`]:
    'canPerformAction and onMoveDistance are pure queries the AI runs many times per activation, so the BLESSED BLADEs in control range are snapshotted at the enemy\'s onActivationStart and the damage lands at its onActivationEnd if it performed Fall Back — "before it moves" is lost (the Nemesis Claw CHAIN SNARE precedent)',
  [`${RULE.accursedGifts}.horned`]:
    'nothing runs at the end of an action, so "whenever this operative ends its move during the Charge action" lands at the end of the activation the Charge happened in (the Nemesis Claw WE HAVE COME FOR YOU precedent)',
  [FP.frenziedDemise]:
    'the engine opens no ploy window inside a sequence, so the ploy is declared in advance and fires on its printed trigger at onIncapacitated (the Mandrakes SHADOW\'S BITE / Celestian GLORIOUS MARTYRDOM shape)',
  [`${AB.mutantRegeneration}.shoot`]:
    'inflictDamage is called once per shoot with an aggregated total, so "whenever an attack dice inflicts damage of 3 or more" is counted per unblocked attack dice off the resolved pool (the Raveners Reinforced Carapace read); a fight strike IS one dice and is exact',
};

// ---------------------------------------------------------------------------
// ACCURSED GIFTS — the six gifts, sliced out of the one printed faction rule
// ---------------------------------------------------------------------------

export const GIFTS = ['deformed-wings', 'fleet', 'chitinous', 'horned', 'sinewed', 'barbed'] as const;
export type Gift = (typeof GIFTS)[number];

/** The printed heading of each ACCURSED GIFT, in printed order. Names, not rule text. */
export const GIFT_NAME: Record<Gift, string> = {
  'deformed-wings': '1. Deformed Wings',
  fleet: '2. Fleet',
  chitinous: '3. Chitinous',
  horned: '4. Horned',
  sinewed: '5. Sinewed',
  barbed: '6. Barbed',
};

export const GIFT_LABEL: Record<Gift, string> = {
  'deformed-wings': 'Deformed Wings',
  fleet: 'Fleet',
  chitinous: 'Chitinous',
  horned: 'Horned',
  sinewed: 'Sinewed',
  barbed: 'Barbed',
};

/**
 * The six gifts are printed inside the one ACCURSED GIFTS faction rule and the scrape has no
 * per-gift ids, so each gift's rule text is sliced out of that string here (CLAUDE.md: rule
 * text is data, never retyped). Each gift is `<n>. <Name>\n\n<flavour>\n\n<rule…>`; the
 * flavour paragraph is dropped.
 */
export const GIFT_TEXT: Record<Gift, string> = sliceGiftTexts();

function sliceGiftTexts(): Record<Gift, string> {
  const whole = text(RULE.accursedGifts);
  const marks = GIFTS.map((g) => ({ gift: g, at: whole.indexOf(`\n${GIFT_NAME[g]}\n`) }));
  const out = {} as Record<Gift, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0)
      throw new Error(`ACCURSED GIFT '${GIFT_NAME[mark.gift]}' is not in data/teams/chaos-cult.json`);
    const from = mark.at + 1 + GIFT_NAME[mark.gift].length;
    const to = marks[i + 1]?.at ?? whole.length;
    const paragraphs = whole
      .slice(from, to)
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    out[mark.gift] = (paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs).join('\n\n');
  });
  return out;
}

interface GiftRecord {
  primary?: Gift;
  secondary?: Gift;
  /** ABHORRENT MUTATION: "This is in addition to any ACCURSED GIFTS it already has." */
  extra?: Record<string, Gift>;
}

function giftBag(state: GameState): Record<string, GiftRecord> {
  return bucket(state, GIFT_BAG) as Record<string, GiftRecord>;
}

export function giftsFor(state: GameState, player: PlayerId): GiftRecord {
  const bag = giftBag(state);
  bag[player] = bag[player] ?? {};
  return bag[player]!;
}

const isMutantCard = (op: OperativeState): boolean => op.datacardId === CARD.mutant;
const isTormentCard = (op: OperativeState): boolean => op.datacardId === CARD.torment;
const isDevoteeCard = (op: OperativeState): boolean => op.datacardId === CARD.devotee;

/**
 * "All friendly MUTANT operatives have your primary ACCURSED GIFT, and all friendly TORMENT
 * operatives have your primary and secondary ACCURSED GIFTS" — plus anything ABHORRENT
 * MUTATION handed that particular operative, which survives a Mutation by construction because
 * it is keyed by the operative's own id.
 */
export function giftsOf(state: GameState, op: OperativeState): Gift[] {
  const rec = giftBag(state)[op.player];
  if (!rec) return [];
  const out: Gift[] = [];
  if ((isMutantCard(op) || isTormentCard(op)) && rec.primary) out.push(rec.primary);
  if (isTormentCard(op) && rec.secondary && !out.includes(rec.secondary)) out.push(rec.secondary);
  const extra = rec.extra?.[op.id];
  if (extra && !out.includes(extra)) out.push(extra);
  return out;
}

export const hasGift = (state: GameState, op: OperativeState, gift: Gift): boolean =>
  giftsOf(state, op).includes(gift);

/** "You cannot select the same ACCURSED GIFT more than once per battle." */
export function giftTaken(state: GameState, player: PlayerId, gift: Gift): boolean {
  const rec = giftBag(state)[player];
  if (!rec) return false;
  if (rec.primary === gift || rec.secondary === gift) return true;
  return Object.values(rec.extra ?? {}).includes(gift);
}

export function availableGifts(state: GameState, player: PlayerId): Gift[] {
  return GIFTS.filter((g) => !giftTaken(state, player, g));
}

/**
 * The pure setter the UI (and a test) uses to declare an ACCURSED GIFT ahead of the moment the
 * printed rule asks for it. Both printed moments — the first DEVOTEE→MUTANT and the first
 * MUTANT→TORMENT — are reachable in the reducer, so an unset slot is filled from the intent's
 * `data` or, failing that, by a deterministic logged default (D-016) rather than being left
 * switched off.
 */
export function setAccursedGift(
  state: GameState,
  player: PlayerId,
  slot: 'primary' | 'secondary',
  gift: Gift,
): { ok: boolean; reason?: string } {
  const rec = giftsFor(state, player);
  if (rec[slot] === gift) return { ok: true };
  if (giftTaken(state, player, gift))
    return { ok: false, reason: `you cannot select ${GIFT_LABEL[gift]} more than once per battle` };
  rec[slot] = gift;
  log(state, { kind: 'system', player, text: `${slot} ACCURSED GIFT: ${GIFT_LABEL[gift]}` });
  return { ok: true };
}

function pickGift(
  state: GameState,
  player: PlayerId,
  asked: unknown,
): Gift | undefined {
  const free = availableGifts(state, player);
  if (free.length === 0) return undefined;
  if (typeof asked === 'string' && (GIFTS as readonly string[]).includes(asked) && free.includes(asked as Gift))
    return asked as Gift;
  return free[0];
}

/** Fill a gift slot at the printed moment, from `data` or the deterministic default (D-016). */
function claimGiftSlot(
  state: GameState,
  player: PlayerId,
  slot: 'primary' | 'secondary',
  data: Record<string, unknown> | undefined,
): void {
  const rec = giftsFor(state, player);
  if (rec[slot]) return;
  const gift = pickGift(state, player, data?.[`${slot}Gift`]);
  if (!gift) return;
  rec[slot] = gift;
  log(state, {
    kind: 'system',
    player,
    text: `Accursed Gifts: ${slot} ACCURSED GIFT is ${GIFT_LABEL[gift]}`,
    data: { gift },
  });
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

const keywordsOf = (op: OperativeState, ctx?: GameContext): string[] =>
  (ctx?.datacards.get(op.datacardId) ?? catalogueCard(op.datacardId))?.keywords ?? [];
const hasKw = (op: OperativeState, keyword: string, ctx?: GameContext): boolean =>
  keywordsOf(op, ctx).some((k) => k.toUpperCase() === keyword.toUpperCase());
const isCultOp = (op: OperativeState, ctx?: GameContext): boolean => hasKw(op, KW, ctx);
const isDarkCommune = (op: OperativeState, ctx?: GameContext): boolean => hasKw(op, 'DARK COMMUNE', ctx);
/** "friendly CHAOS CULT MUTANT or CHAOS CULT TORMENT operatives". */
const isAccursed = (op: OperativeState): boolean => isMutantCard(op) || isTormentCard(op);

function injuredNow(op: OperativeState, ctx?: GameContext): boolean {
  const card = ctx?.datacards.get(op.datacardId) ?? catalogueCard(op.datacardId);
  return card !== undefined && op.wounds < card.wounds / 2;
}

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

function visibleBetween(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

/** Every marker but an objective is 20mm (core rules › Markers). */
const MARKER_BASE = { shape: 'round', mm: 20 } as const;

const markerBodyAt = (pos: Vec2, z: number): Body => ({
  id: 'chaos-cult.probe',
  pos,
  z,
  rot: 0,
  base: MARKER_BASE,
  height: 0.2,
});

const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

/** Is the melee half of a sequence in flight for this operative (fighting or retaliating)? */
function inMeleeFor(state: GameState, op: OperativeState): boolean {
  const seq = fightSeq(state);
  return seq !== undefined && (seq.attackerId === op.id || seq.defenderId === op.id);
}

/** "…a location it can be placed" — the printed placement test, for a datacard swap. */
function canStandAt(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2, card: Datacard): boolean {
  const r = baseRadius(card.base);
  const { w, h } = state.map.board;
  if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS) return false;
  const index = terrain(ctx, state);
  if (baseTouchesHazardous(index, pos, card.base, op.rot)) return false;
  if (baseBlockedByTerrain(index, pos, card.base, op.rot, 0, modelHeight(card))) return false;
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (Math.abs(other.z - op.z) > 1) continue;
    if (basesOverlap(pos, card.base, op.rot, other.pos, oc.base, other.rot)) return false;
  }
  return true;
}

/**
 * "…ensuring the centre of the new miniature's base is as close as possible to where the centre
 * of the old miniature's base was." A DEVOTEE and a MUTANT share a 25mm base, so this only
 * matters for a TORMENT's 40mm one; the ring search is deterministic (D-016).
 */
function nearestStandingSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  card: Datacard,
): Vec2 | undefined {
  if (canStandAt(ctx, state, op, op.pos, card)) return { ...op.pos };
  for (let radius = 0.25; radius <= 2 + EPS; radius += 0.25) {
    for (let step = 0; step < 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      const p = {
        x: Math.round((op.pos.x + Math.cos(angle) * radius) * 1000) / 1000,
        y: Math.round((op.pos.y + Math.sin(angle) * radius) * 1000) / 1000,
      };
      if (canStandAt(ctx, state, op, p, card)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MUTATION — the faction rule that swaps a datacard
// ---------------------------------------------------------------------------

export type MutateChoice = 'mutant' | 'torment' | 'wounds';

const mutatedBag = (state: GameState): Record<string, number> =>
  bucket(state, MUTATE_BAG) as Record<string, number>;
const tormentBag = (state: GameState): Record<string, { tp: number; count: number }> =>
  bucket(state, TORMENT_BAG) as Record<string, { tp: number; count: number }>;

/** "Each operative cannot MUTATE more than once per turning point." */
export const mutatedThisTP = (state: GameState, op: OperativeState): boolean =>
  mutatedBag(state)[op.id] === state.turningPoint;

/** "…max twice per turning point" for MUTANT → TORMENT. */
function tormentsThisTP(state: GameState, player: PlayerId): number {
  const rec = tormentBag(state)[player];
  return rec && rec.tp === state.turningPoint ? rec.count : 0;
}

const countCards = (state: GameState, player: PlayerId, datacardId: string): number =>
  aliveOperatives(state, player).filter((o) => o.datacardId === datacardId).length;

/**
 * "Whenever a friendly operative MUTATES, select one of the following: … turn it into a MUTANT
 * … turn it into a TORMENT (max twice per turning point) … It can regain up to D3+1 lost
 * wounds." — with "You cannot have more than five MUTANT operatives and three TORMENT
 * operatives at once."
 */
export function mutateOptions(state: GameState, op: OperativeState): MutateChoice[] {
  if (!isCultOp(op)) return [];
  const out: MutateChoice[] = [];
  if (isDevoteeCard(op) && countCards(state, op.player, CARD.mutant) < 5) out.push('mutant');
  if (isMutantCard(op) && countCards(state, op.player, CARD.torment) < 3 && tormentsThisTP(state, op.player) < 2)
    out.push('torment');
  out.push('wounds');
  return out;
}

/**
 * Turn one operative into another operative type. The operative keeps its id, letter, orders
 * and position — "It's still the same operative for any rules it's already been selected for.
 * The operative is simply a new operative type."
 */
export function mutateOperative(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  choice: MutateChoice,
  data?: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  if (op.removed || op.incapacitated) return { ok: false, reason: 'that operative is not in the killzone' };
  if (!isCultOp(op, ctx)) return { ok: false, reason: 'only a friendly CHAOS CULT operative can MUTATE' };
  if (mutatedThisTP(state, op)) return { ok: false, reason: 'it has already MUTATED this turning point' };
  if (!mutateOptions(state, op).includes(choice)) return { ok: false, reason: `it cannot MUTATE into a ${choice}` };

  if (choice === 'wounds') {
    const card = ctx.datacards.get(op.datacardId);
    const roll = ctx.rng.d3() + 1;
    recordRoll(state, 'mutate', [roll], op.player, `${op.letter} regains up to D3+1 wounds`);
    const before = op.wounds;
    op.wounds = card ? Math.min(card.wounds, op.wounds + roll) : op.wounds + roll;
    mutatedBag(state)[op.id] = state.turningPoint;
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} MUTATES: regains ${op.wounds - before} lost wounds`,
      data: { operativeId: op.id, choice },
    });
    return { ok: true };
  }

  const newCardId = choice === 'mutant' ? CARD.mutant : CARD.torment;
  const oldCard = ctx.datacards.get(op.datacardId);
  const newCard = ctx.datacards.get(newCardId);
  if (!oldCard || !newCard) return { ok: false, reason: `unknown datacard '${newCardId}'` };

  const lost = Math.max(0, oldCard.wounds - op.wounds);
  const previousId = op.datacardId;
  op.datacardId = newCardId;
  const spot = nearestStandingSpot(ctx, state, op, newCard);
  if (!spot) {
    op.datacardId = previousId;
    return { ok: false, reason: 'the new miniature cannot be placed as close as possible to the old one' };
  }
  op.pos = spot;
  // "The new operative type loses a number of wounds equal to the lost wounds of its preceding
  // operative type." Nothing in the printed rule incapacitates through a Mutation.
  op.wounds = Math.max(1, newCard.wounds - lost);
  // The recorded loadout names the OLD card's weapons; `weaponsOf` would fall back to the whole
  // new card anyway, but leaving a stale entry behind is exactly the sort of hidden state
  // architecture rule 7 forbids.
  const loadouts = state.opState['loadout'] as Record<string, string[]> | undefined;
  if (loadouts) delete loadouts[op.id];
  settleZ(ctx, state, op);
  mutatedBag(state)[op.id] = state.turningPoint;
  if (choice === 'torment') {
    const bag = tormentBag(state);
    const rec = bag[op.player];
    bag[op.player] = rec && rec.tp === state.turningPoint ? { tp: rec.tp, count: rec.count + 1 } : { tp: state.turningPoint, count: 1 };
  }
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} MUTATES into a ${newCard.name} (${op.wounds}/${newCard.wounds} wounds)`,
    data: { operativeId: op.id, choice, datacardId: newCardId },
  });
  // "The first time a friendly DEVOTEE operative turns into a MUTANT operative during the
  // battle, select your primary ACCURSED GIFT. The first time a friendly MUTANT operative turns
  // into a TORMENT operative during the battle, select your secondary ACCURSED GIFT."
  claimGiftSlot(state, op.player, choice === 'mutant' ? 'primary' : 'secondary', data);
  return { ok: true };
}

/** "TP1 = 2, TP2 = 2, TP3 = 3, TP4+ = 4." */
export function mutateAllowance(turningPoint: number): number {
  if (turningPoint <= 2) return 2;
  if (turningPoint === 3) return 3;
  return 4;
}

/**
 * The deterministic default (D-016) when the gambit names no operatives: turn DEVOTEEs into
 * MUTANTs while the printed cap allows, then MUTANTs into TORMENTs, and otherwise heal the
 * friendly operative that has lost the most wounds. Written next to the rule it governs and
 * logged whenever it fires.
 */
function defaultMutations(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  count: number,
): { op: OperativeState; choice: MutateChoice }[] {
  const out: { op: OperativeState; choice: MutateChoice }[] = [];
  const taken = new Set<string>();
  const eligible = (): OperativeState[] =>
    aliveOperatives(state, player)
      .filter((o) => isCultOp(o, ctx) && !mutatedThisTP(state, o) && !taken.has(o.id))
      .sort(byId);
  for (let n = 0; n < count; n++) {
    const devotee = eligible().find((o) => mutateOptions(state, o).includes('mutant'));
    if (devotee) {
      out.push({ op: devotee, choice: 'mutant' });
      taken.add(devotee.id);
      continue;
    }
    const mutant = eligible().find((o) => mutateOptions(state, o).includes('torment'));
    if (mutant) {
      out.push({ op: mutant, choice: 'torment' });
      taken.add(mutant.id);
      continue;
    }
    const hurt = eligible()
      .map((o) => ({ o, lost: Math.max(0, (ctx.datacards.get(o.datacardId)?.wounds ?? 0) - o.wounds) }))
      .filter((x) => x.lost > 0)
      .sort((a, b) => b.lost - a.lost || byId(a.o, b.o))[0];
    if (!hurt) break;
    out.push({ op: hurt.o, choice: 'wounds' });
    taken.add(hurt.o.id);
  }
  return out;
}

/** Can anything MUTATE right now? Gates the STRATEGIC GAMBIT so it is never offered for nothing. */
function anyCanMutate(state: GameState, player: PlayerId): boolean {
  return aliveOperatives(state, player).some(
    (o) => isCultOp(o) && !mutatedThisTP(state, o) && mutateOptions(state, o).length > 0,
  );
}

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => op.player === T.player;

  // =========================================================================
  // Mutation (faction rule)
  // =========================================================================
  /*
   * "As a STRATEGIC GAMBIT, you can MUTATE a number of friendly CHAOS CULT operatives based on
   *  the turning point as follows: TP1 = 2, TP2 = 2, TP3 = 3, TP4+ = 4."
   *
   * A 0CP gambit of its own (the Wolf Scouts' Elemental Storm / Raveners' Tunnel shape), because
   * `gambitsUsedTP` is the only channel that records a once-per-turning-point pick. Which
   * operatives MUTATE, and into what, come from the gambit's `data.mutations`, else the
   * deterministic logged default above (D-016).
   */
  reg.on('gambitOptions', T.bind(RULE.mutation, 10), (ev) => {
    if (ev.player !== T.player || !anyCanMutate(ev.state, T.player)) return;
    ev.options.push({
      id: MUTATE_GAMBIT,
      label: `Mutation: MUTATE up to ${mutateAllowance(ev.state.turningPoint)} friendly CHAOS CULT operatives`,
      sourceText: shortQuote(text(RULE.mutation)),
    });
  });
  reg.on('onPloyUsed', T.bind(RULE.mutation, 11), (ev) => {
    if (ev.player !== T.player || ev.ployId !== MUTATE_GAMBIT || !T.ctx) return;
    const ctx = T.ctx;
    const allowance = mutateAllowance(ev.state.turningPoint);
    const asked = Array.isArray(ev.data?.['mutations'])
      ? (ev.data!['mutations'] as { operativeId?: string; choice?: MutateChoice }[])
      : [];
    let done = 0;
    for (const wanted of asked.slice(0, allowance)) {
      const op = wanted.operativeId ? ev.state.operatives[wanted.operativeId] : undefined;
      if (!op || op.player !== T.player) continue;
      const choice = wanted.choice ?? mutateOptions(ev.state, op)[0];
      if (!choice) continue;
      if (mutateOperative(ctx, ev.state, op, choice, ev.data).ok) done++;
    }
    if (done === 0) {
      for (const plan of defaultMutations(ctx, ev.state, T.player, allowance)) {
        if (mutateOperative(ctx, ev.state, plan.op, plan.choice, ev.data).ok) done++;
      }
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Mutation: ${done} of up to ${allowance} friendly CHAOS CULT operatives MUTATE`,
    });
  });

  /*
   * "Whenever a friendly DEVOTEE operative incapacitates an enemy operative within its control
   *  range, it can MUTATE."
   *
   * PARTIAL (see `PARTIAL`): `advanceShoot` re-reads the attacker's weapon by name with a
   * non-null assertion on every pass, so swapping the datacard from inside `onIncapacitated`
   * would crash the sequence that is still resolving. The MUTATE is recorded here and applied
   * at the next activation boundary, where no sequence is in flight. It is free and strictly
   * beneficial, so it is auto-used (D-022).
   */
  reg.on('onIncapacitated', T.bind(RULE.mutation, 12), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const victim = ev.operative;
    if (victim.player === T.player) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const ids = seq.kind === 'shoot' ? [seq.attackerId] : [seq.attackerId, seq.defenderId];
    const killer = ids
      .map((id) => ev.state.operatives[id])
      .find((o): o is OperativeState => Boolean(o) && o!.player === T.player && isDevoteeCard(o!));
    if (!killer) return;
    if (!inCR(T, ev.state, killer, victim)) return;
    if (mutatedThisTP(ev.state, killer)) return;
    if (effectOn(ev.state, killer.id, PENDING_MUTATION)) return;
    effect(ev.state, {
      rule: PENDING_MUTATION,
      source: { kind: 'ability', id: RULE.mutation },
      sourceText: shortQuote(text(RULE.mutation)),
      operativeId: killer.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${killer.letter} has earned a MUTATE (it incapacitated ${victim.letter} within its control range)`,
      data: { operativeId: killer.id },
    });
  });
  /*
   * D-022: "it can MUTATE" is free and strictly beneficial, so the earned MUTATE is auto-used on
   * a stated policy — the first option `mutateOptions` offers, which is the printed promotion
   * while the caps allow it and "regain up to D3+1 lost wounds" otherwise.
   */
  const flushPendingMutations = (state: GameState): void => {
    if (!T.ctx) return;
    for (const op of aliveOperatives(state, T.player).sort(byId)) {
      const pending = effectOn(state, op.id, PENDING_MUTATION);
      if (!pending) continue;
      dropEffects(state, (e) => e === pending);
      const choice = mutateOptions(state, op)[0];
      if (choice) mutateOperative(T.ctx, state, op, choice);
    }
  };
  reg.on('onActivationEnd', T.bind(RULE.mutation, 80), (ev) => flushPendingMutations(ev.state));
  reg.on('onReadyStep', T.bind(RULE.mutation, 80), (ev) => {
    if (ev.player === T.player) flushPendingMutations(ev.state);
  });

  // =========================================================================
  // Accursed Gifts (faction rule) — six gifts, sliced out of the printed text
  // =========================================================================

  // 2. Fleet — "Add 1" to this operative's Move stat."
  reg.on('onStatMod', T.bindText(`${RULE.accursedGifts}.fleet`, GIFT_TEXT.fleet, 10), (ev) => {
    if (!mine(ev.operative) || !hasGift(ev.state, ev.operative, 'fleet')) return;
    ev.mods.move += 1;
  });

  // 3. Chitinous — "Improve this operative's Save stat by 1."
  reg.on('onStatMod', T.bindText(`${RULE.accursedGifts}.chitinous`, GIFT_TEXT.chitinous, 10), (ev) => {
    if (!mine(ev.operative) || !hasGift(ev.state, ev.operative, 'chitinous')) return;
    ev.mods.save += 1;
  });

  /*
   * 4. Horned — "Whenever this operative ends its move during the Charge action, you can inflict
   *  1 damage on one enemy operative within its control range, or D3 damage instead if this
   *  operative is a TORMENT."
   *
   * PARTIAL: nothing runs at the end of an action, so the damage lands at the end of the
   * activation the Charge happened in (the Nemesis Claw WE HAVE COME FOR YOU precedent). Free
   * and always beneficial, so it is auto-used under D-022 against the enemy in control range
   * with the fewest wounds left.
   */
  reg.on('onActivationEnd', T.bindText(`${RULE.accursedGifts}.horned`, GIFT_TEXT.horned, 12), (ev) => {
    const op = ev.operative;
    if (!mine(op) || !T.ctx || !hasGift(ev.state, op, 'horned')) return;
    if (!did(op, 'Charge') && !did(op, WINGS_CHARGE)) return;
    const victim = T.enemies(ev.state)
      .filter((e) => inCR(T, ev.state, op, e))
      .sort((a, b) => a.wounds - b.wounds || byId(a, b))[0];
    if (!victim) return;
    let damage = 1;
    if (isTormentCard(op)) {
      damage = T.ctx.rng.d3();
      recordRoll(ev.state, 'horned', [damage], T.player, `Horned vs ${victim.letter}`);
    }
    log(ev.state, { kind: 'action', player: T.player, text: `Horned: ${op.letter} gores ${victim.letter}` });
    inflictDamage(T.ctx, ev.state, victim, damage, 'other');
  });

  /*
   * 5. Sinewed — "You can ignore any changes to the Hit stat of this operative's melee weapons
   *  from being injured. This operative's melee weapons have the Brutal weapon rule."
   *
   * `hitOf` adds +1 when injured and subtracts `mods.hit`, so `mods.hit += 1` cancels it exactly.
   * `onStatMod` carries no weapon, so "melee weapons" is read off the in-flight fight sequence —
   * a bare `hitOf` outside a sequence has no weapon to scope to. EXALTATION IN PAIN prints the
   * same cancellation for every CHAOS CULT weapon; the two must never both fire on the same
   * read, so the ploy checks this predicate first.
   */
  const sinewedIgnoresInjured = (state: GameState, op: OperativeState): boolean =>
    hasGift(state, op, 'sinewed') && injuredNow(op, T.ctx) && inMeleeFor(state, op);
  reg.on('onStatMod', T.bindText(`${RULE.accursedGifts}.sinewed`, GIFT_TEXT.sinewed, 10), (ev) => {
    if (!mine(ev.operative)) return;
    if (sinewedIgnoresInjured(ev.state, ev.operative)) ev.mods.hit += 1;
  });
  reg.on('onWeaponRules', T.bindText(`${RULE.accursedGifts}.sinewed`, GIFT_TEXT.sinewed, 10), (ev) => {
    if (ev.type !== 'melee' || !mine(ev.operative)) return;
    if (!hasGift(ev.state, ev.operative, 'sinewed')) return;
    if (!ev.rules.some((r) => r.id === 'Brutal')) ev.rules.push(ruleTag('Brutal', undefined, 'Brutal (Sinewed)'));
  });

  /*
   * 6. Barbed — "Whenever this operative is fighting or retaliating: Enemy operatives cannot
   *  assist. The first time you strike during that sequence, also inflict 1 damage on each other
   *  enemy operative within this operative's control range, or D3 damage instead if this
   *  operative is a TORMENT."
   *
   * `onFightAssist` fires inside `startFight` before `state.sequence` exists, so it cannot tell
   * WHICH fight the assists belong to; the assists are cancelled where they are SPENT instead
   * (`rollSide` passes `assists + mods.hit` to `hitOf`) — the Hearthkyn Brawler seam.
   */
  reg.on('onCollectAttackDice', T.bindText(`${RULE.accursedGifts}.barbed`, GIFT_TEXT.barbed, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side =
      seq.attackerId === ev.ctx.attacker.id ? 'attacker' : seq.defenderId === ev.ctx.attacker.id ? 'defender' : undefined;
    if (!side) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.player !== T.player || !hasGift(ev.state, foe, 'barbed')) return;
    const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    if (assists > 0) {
      ev.mods.hit -= assists;
      log(ev.state, { kind: 'dice', player: T.player, text: `Barbed: enemy operatives cannot assist (-${assists})` });
    }
  });
  reg.on('onStrikeResolved', T.bindText(`${RULE.accursedGifts}.barbed`, GIFT_TEXT.barbed, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (ev.ctx.type !== 'melee' || op.player !== T.player || !T.ctx) return;
    if (!hasGift(ev.state, op, 'barbed')) return;
    if (!useOncePerSequence(ev.state, `chaos-cult.barbed:${op.id}`)) return;
    const victims = T.enemies(ev.state).filter((e) => e.id !== ev.struck.id && inCR(T, ev.state, op, e));
    for (const victim of victims.sort(byId)) {
      let damage = 1;
      if (isTormentCard(op)) {
        damage = T.ctx.rng.d3();
        recordRoll(ev.state, 'barbed', [damage], T.player, `Barbed vs ${victim.letter}`);
      }
      log(ev.state, { kind: 'action', player: T.player, text: `Barbed: ${victim.letter} is torn by the barbs` });
      inflictDamage(T.ctx, ev.state, victim, damage, 'other');
    }
  });

  // =========================================================================
  // BLESSED BLADE › Cut Them Down
  // =========================================================================
  /*
   * "Whenever an enemy operative performs the Fall Back action while within control range of
   *  this operative, you can use this rule. If you do, inflict D3+1 damage on that enemy
   *  operative before it moves. If that enemy operative is within control range of two of these
   *  operatives, inflict 2D3+2 damage instead."
   *
   * PARTIAL: `canPerformAction`, `onActionCost` and `onMoveDistance` are all pure queries the AI
   * runs many times per activation, so nothing may roll dice there. The BLESSED BLADEs in
   * control range are snapshotted at the enemy's `onActivationStart` and the damage is inflicted
   * at its `onActivationEnd` if it performed the Fall Back — "before it moves" is lost (the
   * Nemesis Claw CHAIN SNARE precedent).
   */
  reg.on('onActivationStart', T.bindText(AB.cutThemDown, abilityText(CARD.blessedBlade, AB.cutThemDown), 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    dropEffects(ev.state, (e) => e.rule === CUT_THEM_DOWN_WATCH && e.operativeId === foe.id && e.player === T.player);
    const blades = T.friendlies(ev.state)
      .filter((o) => o.datacardId === CARD.blessedBlade && inCR(T, ev.state, o, foe))
      .map((o) => o.id);
    if (blades.length === 0) return;
    effect(ev.state, {
      rule: CUT_THEM_DOWN_WATCH,
      source: { kind: 'ability', id: AB.cutThemDown },
      sourceText: shortQuote(abilityText(CARD.blessedBlade, AB.cutThemDown)),
      operativeId: foe.id,
      player: T.player,
      data: { blades },
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
  });
  reg.on('onActivationEnd', T.bindText(AB.cutThemDown, abilityText(CARD.blessedBlade, AB.cutThemDown), 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || !T.ctx) return;
    const watch = ev.state.effects.find(
      (e) => e.rule === CUT_THEM_DOWN_WATCH && e.operativeId === foe.id && e.player === T.player,
    );
    if (!watch) return;
    dropEffects(ev.state, (e) => e === watch);
    if (!did(foe, 'Fall Back')) return;
    const alive = (watch.data?.['blades'] as string[] | undefined ?? []).filter((id) => {
      const blade = ev.state.operatives[id];
      return blade !== undefined && !blade.removed && !blade.incapacitated;
    });
    if (alive.length === 0) return;
    const dice = alive.length >= 2 ? 2 : 1;
    const rolls = Array.from({ length: dice }, () => T.ctx!.rng.d3());
    recordRoll(ev.state, 'cutThemDown', rolls, T.player, `Cut Them Down vs ${foe.letter}`);
    const damage = rolls.reduce((a, b) => a + b, 0) + dice;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Cut Them Down: ${foe.letter} takes ${damage} damage for falling back`,
    });
    inflictDamage(T.ctx, ev.state, foe, damage, 'other');
  });

  // =========================================================================
  // BLESSED BLADE › Attuned In Purpose  /  CHAOS DEVOTEE › Group Activation
  // =========================================================================
  /*
   * "Whenever this operative is activated, you can activate another ready friendly BLESSED BLADE
   *  operative within 6" of it at the same time." / "Whenever this operative is expended, you
   *  must then activate one other ready friendly CHAOS CULT DEVOTEE operative (if able) before
   *  your opponent activates."
   *
   * PARTIAL, both: `EndActivation` sets `activePlayer` to the opponent AFTER `onActivationEnd`
   * fires and nothing runs later, so the pairing is recorded as an effect the UI/AI reads (the
   * Breachers' Breach and Clear / Pathfinders' Group Activation partial).
   */
  reg.on('onActivationEnd', T.bindText(AB.groupActivation, abilityText(CARD.devotee, AB.groupActivation), 12), (ev) => {
    const op = ev.operative;
    if (!mine(op) || op.datacardId !== CARD.devotee) return;
    // "…in other words, you cannot activate more than two operatives in succession with this rule."
    if (effectOn(ev.state, op.id, GROUP_ACTIVATION_USED)) return;
    const other = T.friendlies(ev.state)
      .filter((o) => o.id !== op.id && o.ready && o.datacardId === CARD.devotee)
      .sort(byId)[0];
    if (!other) return;
    for (const [rule, id] of [
      [GROUP_ACTIVATION, other.id],
      [GROUP_ACTIVATION_USED, other.id],
    ] as const) {
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: AB.groupActivation },
        sourceText: shortQuote(abilityText(CARD.devotee, AB.groupActivation)),
        operativeId: id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Group Activation: ${other.letter} activates next`,
      data: { operativeId: other.id },
    });
  });
  reg.on(
    'onActivationStart',
    T.bindText(AB.attunedInPurpose, abilityText(CARD.blessedBlade, AB.attunedInPurpose), 12),
    (ev) => {
      const op = ev.operative;
      if (!mine(op) || op.datacardId !== CARD.blessedBlade) return;
      const other = T.friendlies(ev.state)
        .filter((o) => o.id !== op.id && o.ready && o.datacardId === CARD.blessedBlade && T.gap(o, op) <= 6 + EPS)
        .sort(byId)[0];
      if (!other) return;
      effect(ev.state, {
        rule: GROUP_ACTIVATION,
        source: { kind: 'ability', id: AB.attunedInPurpose },
        sourceText: shortQuote(abilityText(CARD.blessedBlade, AB.attunedInPurpose)),
        operativeId: other.id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Attuned In Purpose: ${other.letter} activates at the same time as ${op.letter}`,
        data: { operativeId: other.id },
      });
    },
  );

  // =========================================================================
  // ICONARCH › Icon Bearer
  // =========================================================================
  // "Whenever determining control of a marker, treat this operative's APL stat as 1 higher.
  //  Note this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', T.bindText(AB.iconBearer, abilityText(CARD.iconarch, AB.iconBearer), 12), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId !== CARD.iconarch) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      ev.aplByPlayer[T.player] += 1;
    }
  });

  // =========================================================================
  // CHAOS MUTANT › Accursed Mutant
  // =========================================================================
  // "This operative cannot perform unique actions. You must spend 1 additional AP for this
  //  operative to perform the Pick Up Marker and mission actions (excluding Operate Hatch)."
  reg.on('canPerformAction', T.bindText(AB.accursedMutant, abilityText(CARD.mutant, AB.accursedMutant), 12), (ev) => {
    if (!mine(ev.operative) || !isMutantCard(ev.operative)) return;
    if (TEAM_CARVE_OUTS.has(ev.action)) return;
    const def = allActions().find((a) => a.id === ev.action);
    // A rule that grants an action a universal one forbids registers its own ActionDef (D-021);
    // those are the universal action, not a printed unique action.
    if (!def || def.type !== 'unique' || def.treatedAs !== undefined) return;
    ev.allowed = false;
    ev.reason = 'Accursed Mutant: this operative cannot perform unique actions';
  });
  reg.on('onActionCost', T.bindText(AB.accursedMutant, abilityText(CARD.mutant, AB.accursedMutant), 12), (ev) => {
    if (!mine(ev.operative) || !isMutantCard(ev.operative)) return;
    if (ev.action === 'Operate Hatch' || TEAM_CARVE_OUTS.has(ev.action)) return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (key !== 'Pick Up Marker' && def?.type !== 'mission') return;
    ev.ap += 1;
  });

  // =========================================================================
  // CHAOS TORMENT › Accursed Torment
  // =========================================================================
  /*
   * "This operative cannot use any weapons that aren't on its datacard, or perform the Pick Up
   *  Marker, unique or mission actions (excluding Operate Hatch)."
   *
   * The weapon half reaches RANGED weapons only, through `onSelectWeapon` (the XV26 DRONE
   * precedent): `weaponsOf` appends `grantedWeapons` AFTER `availableWeapons` has filtered the
   * datacard, and `startFight` picks the melee weapon with no hook at all. It bites on nothing
   * today because this team grants no weapon — see `REMINDER_ONLY`.
   */
  reg.on('canPerformAction', T.bindText(AB.accursedTorment, abilityText(CARD.torment, AB.accursedTorment), 12), (ev) => {
    if (!mine(ev.operative) || !isTormentCard(ev.operative)) return;
    if (ev.action === 'Operate Hatch' || TEAM_CARVE_OUTS.has(ev.action)) return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    const banned = key === 'Pick Up Marker' || def?.type === 'mission' || (def?.type === 'unique' && !def.treatedAs);
    if (!banned) return;
    ev.allowed = false;
    ev.reason = 'Accursed Torment: this operative cannot perform the Pick Up Marker, unique or mission actions';
  });
  reg.on('onSelectWeapon', T.bindText(AB.accursedTorment, abilityText(CARD.torment, AB.accursedTorment), 12), (ev) => {
    const op = ev.ctx.attacker;
    if (!mine(op) || !isTormentCard(op)) return;
    const card = T.card(op);
    if (!card || card.weapons.some((w) => w.name === ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Accursed Torment: it cannot use any weapons that aren’t on its datacard';
  });

  // =========================================================================
  // CHAOS MUTANT / CHAOS TORMENT › Unnatural Regeneration
  // =========================================================================
  /*
   * "Whenever an attack dice inflicts damage of 3 or more on this operative, roll one D6: on a
   *  5+, subtract 1 from that inflicted damage."
   *
   * `onDamage` always carries `ctx: null`, so the striking profile is re-derived from
   * `state.sequence` (the Raveners Reinforced Carapace read). A fight strike IS one attack dice;
   * a shoot aggregates every unblocked dice into one call, so the roll is made per unblocked
   * dice whose Dmg is 3 or more.
   */
  for (const [cardId, abilityId] of [
    [CARD.mutant, AB.mutantRegeneration],
    [CARD.torment, AB.tormentRegeneration],
  ] as const) {
    reg.on('onDamage', T.bindText(abilityId, abilityText(cardId, abilityId), 14), (ev) => {
      if (ev.kind !== 'attack' || !T.ctx) return;
      const victim = ev.target;
      if (!mine(victim) || victim.datacardId !== cardId) return;
      const seq = ev.state.sequence;
      if (!seq) return;
      // VILE BLESSING: "you cannot roll for the Unnatural Regeneration rule for that attack
      // dice then decide to use this rule on the same dice — you must use one or the other."
      const bag = bucket(ev.state, VILE_BLESSING_USED) as Record<string, number>;
      const spared = bag[victim.id] ?? 0;
      delete bag[victim.id];
      let dice = 0;
      if (seq.kind === 'fight') {
        dice = ev.amount >= 3 ? 1 : 0;
      } else {
        if (seq.targetId !== victim.id) return;
        const attacker = ev.state.operatives[seq.attackerId];
        const weapon = attacker ? T.card(attacker)?.weapons.find((w) => w.name === seq.weaponName) : undefined;
        const profile = weapon?.profiles.find((p) => (p.name ?? '') === (seq.profileName ?? '')) ?? weapon?.profiles[0];
        if (!profile) return;
        const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
        const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
        dice = (profile.dmgC >= 3 ? crits : 0) + (profile.dmgN >= 3 ? normals : 0);
      }
      dice = Math.max(0, dice - spared);
      let saved = 0;
      for (let i = 0; i < dice; i++) {
        const roll = T.ctx.rng.d6();
        recordRoll(ev.state, 'regeneration', [roll], T.player, `Unnatural Regeneration on ${victim.letter}`);
        if (roll >= 5) saved += 1;
      }
      if (saved > 0) {
        ev.amount = Math.max(0, ev.amount - saved);
        log(ev.state, {
          kind: 'action',
          player: T.player,
          text: `Unnatural Regeneration: ${victim.letter} shrugs off ${saved} damage`,
        });
      }
    });
  }

  // =========================================================================
  // CHAOS TORMENT › Brute
  // =========================================================================
  /*
   * "Whenever your opponent is selecting a valid target, if this operative has a Conceal order,
   *  it cannot use Light terrain for cover. While this can allow this operative to be targeted
   *  (assuming it's visible), it doesn't remove its cover save (if any)."
   *
   * The Ratlings BULLGRYN read, verbatim: `ignoreCoverTerrain: 'light'` makes it targetable, and
   * because the same flag also feeds the cover SAVE, the save is put back at `onDefenceDice` —
   * which is exactly the printed second sentence.
   */
  reg.on('onValidTarget', T.bindText(AB.brute, abilityText(CARD.torment, AB.brute), 12), (ev) => {
    if (!mine(ev.target) || !isTormentCard(ev.target) || ev.target.order !== 'conceal') return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });
  reg.on('onDefenceDice', T.bindText(AB.brute, abilityText(CARD.torment, AB.brute), 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !mine(target) || !isTormentCard(target) || !T.ctx) return;
    if (target.order !== 'conceal' || ev.coverSave) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    const attacker = ev.ctx.attacker;
    const seek = ev.ctx.rules.some((r) => r.id === 'Seek');
    const seekLight = ev.ctx.rules.some((r) => r.id === 'SeekLight');
    const cover = coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, attacker), body(T.ctx, target), {
      ignoreCoverTerrain: seek ? 'all' : seekLight ? 'light' : 'none',
      vantageDeniesLightCover: ev.ctx.vantageAccurate > 0 && attacker.z - target.z >= 2 - EPS,
    });
    if (!cover.inCover) return;
    ev.coverSave = true; // "it doesn't remove its cover save (if any)"
  });

  // =========================================================================
  // The `grantFreeAction` APL upkeep
  // =========================================================================
  /*
   * `grantFreeAction` models a free action as one extra AP (D-015) by pushing +1 into
   * `aplMods`, which the engine never pops. COVERT GUISES hands three out during the Strategy
   * phase and INCITE SLAUGHTER / INCITE URGENCY one per DEMAGOGUE action, so without this upkeep
   * a CHAOS CULT operative would sit on APL 3 for the rest of the battle (the Corsair Aeldari
   * Raiders / Death Korps REGROUP / Ratlings Scarper precedent).
   */
  const upkeep = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      const at = op.aplMods.lastIndexOf(1);
      if (at >= 0) op.aplMods.splice(at, 1);
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onActivationEnd', T.bindText('chaos-cult.aplUpkeep', text(RULE.mutation), 90), (ev) => {
    if (mine(ev.operative)) upkeep(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('chaos-cult.aplUpkeep', text(RULE.mutation), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) upkeep(ev.state, o);
  });

  // =========================================================================
  // Unique-action effects that outlive their action
  // =========================================================================

  // HEINOUS DELUGE — "Until the end of that operative's next activation, subtract 1 from its
  // APL stat." Through `onStatMod` (which `aplOf` consults), so it expires with its effect
  // instead of leaking a permanent `aplMods` entry (the Death Korps precedent).
  reg.on('onStatMod', T.bindText(ACT.heinousDeluge, actionText(CARD.mindwitch, ACT.heinousDeluge), 12), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, HEINOUS_EFFECT);
    if (!eff || eff.player !== T.player) return;
    ev.mods.apl -= 1;
  });

  // INCITE URGENCY — "(for the former, it cannot move more than 3")".
  reg.on('onMoveDistance', T.bindText(ACT.inciteUrgency, actionText(CARD.demagogue, ACT.inciteUrgency), 12), (ev) => {
    if (!mine(ev.operative) || ev.action !== 'Charge') return;
    if (!effectOn(ev.state, ev.operative.id, URGENCY_CHARGE_CAP)) return;
    ev.inches = Math.min(ev.inches, 3);
  });

  // MALEFIC VORTEX — "In addition, in the Ready step of each Strategy phase, inflict 1 damage on
  // each enemy operative within 2" of that marker."
  reg.on('onReadyStep', T.bindText(ACT.maleficVortex, actionText(CARD.mindwitch, ACT.maleficVortex), 12), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const marker = ev.state.markers[VORTEX_MARKER(T.player)];
    if (!marker) return;
    for (const foe of T.enemies(ev.state).sort(byId)) {
      if (T.markerGap(foe, marker) > 2 + EPS) continue;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Malefic Vortex: ${foe.letter} is within 2" of the vortex`,
      });
      inflictDamage(T.ctx, ev.state, foe, 1, 'other');
    }
  });

  // RUINOUS ICON — the printed duration, kept honest even though the effect list is missing
  // from the JSON: "until the start of this operative's next activation, until it's
  // incapacitated or until it performs this action again (whichever comes first)".
  reg.on('onActivationStart', T.bindText(ACT.ruinousIcon, actionText(CARD.iconarch, ACT.ruinousIcon), 12), (ev) => {
    if (!mine(ev.operative)) return;
    dropEffects(ev.state, (e) => e.rule === RUINOUS_EFFECT && e.operativeId === ev.operative.id);
  });
  reg.on('onIncapacitated', T.bindText(ACT.ruinousIcon, actionText(CARD.iconarch, ACT.ruinousIcon), 12), (ev) => {
    if (ev.prevented) return;
    dropEffects(ev.state, (e) => e.rule === RUINOUS_EFFECT && e.operativeId === ev.operative.id);
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => op.player === T.player;
  const mineCult = (op: OperativeState): boolean => mine(op) && isCultOp(op, T.ctx);

  // =========================================================================
  // EXALTATION IN PAIN (strategy)
  // =========================================================================
  /*
   * "You can ignore any changes to the Hit stat of friendly CHAOS CULT operatives' weapons from
   *  being injured. Whenever an operative is shooting a friendly CHAOS CULT operative that's
   *  wounded, you can re-roll one of your defence dice."
   *
   * `hitOf` adds +1 when injured, so `mods.hit += 1` cancels it — but the Sinewed ACCURSED GIFT
   * prints the same cancellation for melee weapons, and the two must never both fire on one read.
   */
  reg.on('onStatMod', T.bind(SP.exaltationInPain, 20), (ev) => {
    if (!mineCult(ev.operative) || !gambitUsed(ev.state, T.player, SP.exaltationInPain)) return;
    if (!injuredNow(ev.operative, T.ctx)) return;
    if (hasGift(ev.state, ev.operative, 'sinewed') && inMeleeFor(ev.state, ev.operative)) return;
    ev.mods.hit += 1;
  });
  reg.on('onDefenceDice', T.bind(SP.exaltationInPain, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.exaltationInPain)) return;
    const target = ev.ctx.defender;
    if (!target || !mineCult(target)) return;
    const card = T.card(target);
    if (!card || target.wounds >= card.wounds) return; // "…that's wounded"
    if (ev.rerolls.some((r) => r.id === 'chaos-cult.exaltation')) return;
    const grant: RerollGrant = {
      id: 'chaos-cult.exaltation',
      label: 'Exaltation in Pain: re-roll one defence dice',
      mode: 'one',
      max: 1,
      sourceText: shortQuote(text(SP.exaltationInPain)),
      player: T.player,
    };
    ev.rerolls.push(grant);
  });

  // =========================================================================
  // FERVENT ONSLAUGHT (strategy)
  // =========================================================================
  // "Friendly CHAOS CULT operatives' melee weapons have the Accurate 1 weapon rule, or the
  //  Accurate 2 weapon rule if that friendly operative is a MUTANT or TORMENT operative."
  reg.on('onWeaponRules', T.bind(SP.ferventOnslaught, 20), (ev) => {
    if (ev.type !== 'melee' || !mineCult(ev.operative)) return;
    if (!gambitUsed(ev.state, T.player, SP.ferventOnslaught)) return;
    const x = isAccursed(ev.operative) ? 2 : 1;
    ev.rules.push(ruleTag('Accurate', x, `Accurate ${x} (Fervent Onslaught)`));
  });

  // =========================================================================
  // CREATURES OF NIGHTMARE (strategy)
  // =========================================================================
  /*
   * "Whenever determining control of a marker, treat the total APL stat of enemy operatives that
   *  contest it as 1 lower if at least one of those enemy operatives is within 2" of friendly
   *  CHAOS CULT MUTANT or CHAOS CULT TORMENT operatives. Note this isn't a change to the APL
   *  stat, so any changes are cumulative with this."
   */
  reg.on('onMarkerControl', T.bind(SP.creaturesOfNightmare, 20), (ev) => {
    if (!T.ctx || !gambitUsed(ev.state, T.player, SP.creaturesOfNightmare)) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foes = T.enemies(ev.state).filter((o) => markerContestedBy(T.ctx!, ev.state, marker, o));
    const accursed = T.friendlies(ev.state).filter(isAccursed);
    const scared = foes.some((f) => accursed.some((m) => T.gap(m, f) <= 2 + EPS));
    if (!scared) return;
    const foePlayer = otherPlayer(T.player);
    ev.aplByPlayer[foePlayer] -= 1;
  });

  // =========================================================================
  // SICKENING AURA (strategy)
  // =========================================================================
  // "Whenever an enemy operative is within 2" of friendly CHAOS CULT MUTANT or CHAOS CULT
  //  TORMENT operatives, worsen the Hit stat of that enemy operative's weapons by 1. This isn't
  //  cumulative with being injured."
  reg.on('onStatMod', T.bind(SP.sickeningAura, 20), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || !gambitUsed(ev.state, T.player, SP.sickeningAura)) return;
    if (injuredNow(foe, T.ctx)) return; // "This isn't cumulative with being injured."
    const near = T.friendlies(ev.state).some((m) => isAccursed(m) && T.gap(m, foe) <= 2 + EPS);
    if (!near) return;
    ev.mods.hit -= 1;
  });

  // =========================================================================
  // FAITHFUL FOLLOWER (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when a friendly CHAOS CULT DARK COMMUNE operative is selected as
   *  the valid target of a Shoot action or to fight against during the Fight action. Select one
   *  other friendly CHAOS CULT operative (excluding DARK COMMUNE) visible to and within 3" of
   *  that DARK COMMUNE operative to become the valid target … instead … If it's the Shoot
   *  action, that other operative is only in cover or obscured if the original target was. …
   *  This ploy has no effect if it's the Shoot action and the ranged weapon has the Blast or
   *  Torrent weapon rule."
   *
   * The Shoot half is the batch-1 `onSelectTarget` seam (Pathfinders' SAVIOUR PROTOCOLS shape):
   * `startShoot` carries the original cover/obscured verdict onto the substitute, which is the
   * printed sentence. The Fight half is reminder-only — see `REMINDER_ONLY`.
   */
  reg.on('onSelectTarget', T.bind(FP.faithfulFollower, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.faithfulFollower)) return;
    if (!mineCult(ev.target) || !isDarkCommune(ev.target, T.ctx)) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `${FP.faithfulFollower}:${T.player}`)) return;
    const shield = T.friendlies(ev.state)
      .filter(
        (o) =>
          o.id !== ev.target.id &&
          isCultOp(o, T.ctx) &&
          !isDarkCommune(o, T.ctx) &&
          T.gap(o, ev.target) <= 3 + EPS &&
          visibleBetween(T, ev.state, ev.target, o),
      )
      .sort(byId)[0];
    if (!shield) return;
    useOncePerTP(ev.state, `${FP.faithfulFollower}:${T.player}`);
    ev.redirectTo = shield.id;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Faithful Follower: ${shield.letter} takes the hit` });
  });

  // =========================================================================
  // ABHORRENT MUTATION (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when a friendly CHAOS CULT operative (excluding DARK COMMUNE) is
   *  activated. Select an ACCURSED GIFT for that operative to gain. This is in addition to any
   *  ACCURSED GIFTS it already has. Each friendly operative cannot be selected for this ploy
   *  more than once per battle, and if that operative turns into a different one (see Mutation
   *  faction rule), it still has that ACCURSED GIFT."
   *
   * The gift is keyed by the operative's own id, so the last clause holds by construction — a
   * Mutation keeps the id and only swaps the datacard.
   */
  reg.on('onPloyUsed', T.bind(FP.abhorrentMutation, 21), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.abhorrentMutation) return;
    const used = bucket(ev.state, ABHORRENT_BAG) as Record<string, boolean>;
    const candidates = abhorrentCandidates(T, ev.state).filter((o) => !used[o.id]);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    const gift = pickGift(ev.state, T.player, ev.data?.['gift']);
    if (!gift) {
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: 'Abhorrent Mutation: every ACCURSED GIFT has already been selected this battle',
      });
      return;
    }
    used[op.id] = true;
    const rec = giftsFor(ev.state, T.player);
    rec.extra = { ...(rec.extra ?? {}), [op.id]: gift };
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Abhorrent Mutation: ${op.letter} gains ${GIFT_LABEL[gift]}`,
      data: { operativeId: op.id, gift },
    });
  });

  // =========================================================================
  // FRENZIED DEMISE (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when a friendly CHAOS CULT MUTANT or CHAOS CULT TORMENT operative
   *  is incapacitated, before it's removed from the killzone. Inflict D3 damage (or D6 damage
   *  instead if that friendly operative is a TORMENT) on one enemy operative visible to and
   *  within 2" of that friendly operative."
   *
   * PARTIAL: the engine opens no ploy window inside a sequence (`advanceFight` runs a whole
   * fight inside the Fight action), so the ploy is declared in advance and fires on its printed
   * trigger — the Mandrakes SHADOW'S BITE / Celestian GLORIOUS MARTYRDOM shape.
   */
  reg.on('onPloyUsed', T.bind(FP.frenziedDemise, 21), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.frenziedDemise) return;
    effect(ev.state, {
      rule: FRENZIED_ARMED,
      source: { kind: 'ploy', id: FP.frenziedDemise },
      sourceText: shortQuote(text(FP.frenziedDemise)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: 'Frenzied Demise: the next MUTANT or TORMENT to fall lashes out',
    });
  });
  reg.on('onIncapacitated', T.bind(FP.frenziedDemise, 22), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const dying = ev.operative;
    if (!mine(dying) || !isAccursed(dying)) return;
    const armed = ev.state.effects.find((e) => e.rule === FRENZIED_ARMED && e.player === T.player);
    if (!armed) return;
    const victim = T.enemies(ev.state)
      .filter((e) => T.gap(e, dying) <= 2 + EPS && visibleBetween(T, ev.state, dying, e))
      .sort((a, b) => a.wounds - b.wounds || byId(a, b))[0];
    if (!victim) return;
    dropEffects(ev.state, (e) => e === armed);
    const damage = isTormentCard(dying) ? T.ctx.rng.d6() : T.ctx.rng.d3();
    recordRoll(ev.state, 'frenziedDemise', [damage], T.player, `Frenzied Demise vs ${victim.letter}`);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Frenzied Demise: ${dying.letter} inflicts ${damage} damage on ${victim.letter}`,
    });
    inflictDamage(T.ctx, ev.state, victim, damage, 'other');
  });

  // =========================================================================
  // UNLEASH THE DAEMON (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy during a friendly CHAOS CULT MUTANT or CHAOS CULT TORMENT
   *  operative's activation, before or after it performs an action. During that activation, that
   *  operative can perform two Fight actions, and one of them can be free."
   *
   * The second Fight is `Fight (Unleash the Daemon)` — its own `ActionDef` with its own
   * restriction key (D-021, the Plague Marines Astartes shape) — and "one of them can be free"
   * is D-015's one extra AP restricted to a Fight.
   */
  reg.on('onPloyUsed', T.bind(FP.unleashTheDaemon, 21), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.unleashTheDaemon) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !mine(active) || !isAccursed(active)) return;
    effect(ev.state, {
      rule: DAEMON_EFFECT,
      source: { kind: 'ploy', id: FP.unleashTheDaemon },
      sourceText: shortQuote(text(FP.unleashTheDaemon)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
    grantFreeAction(ev.state, active, {
      sourceId: FP.unleashTheDaemon,
      sourceText: shortQuote(text(FP.unleashTheDaemon)),
      threshold: currentApl(T, ev.state, active),
      only: ['Fight', FIGHT_DAEMON],
    });
  });
}

/** "…a friendly CHAOS CULT operative (excluding DARK COMMUNE)" that has just been activated. */
function abhorrentCandidates(T: TeamHooks, state: GameState): OperativeState[] {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const eligible = (op: OperativeState): boolean =>
    op.player === T.player && isCultOp(op, T.ctx) && !isDarkCommune(op, T.ctx);
  if (active && eligible(active)) return [active];
  return T.friendlies(state).filter(eligible).sort(byId);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => op.player === T.player;
  const mineCult = (op: OperativeState): boolean => mine(op) && isCultOp(op, T.ctx);

  // =========================================================================
  // BALEFUL SCRIPT
  // =========================================================================
  /*
   * "Once per battle STRATEGIC GAMBIT. Change one of your ACCURSED GIFTS. Note that if it's an
   *  ACCURSED GIFT an operative has from the Abhorrent Mutation firefight ploy, only that
   *  operative benefits from this."
   *
   * Which gift changes and to what come from the gambit's `data` (`slot`, `gift`) with a
   * deterministic logged default (D-016): the secondary if one is set, else the primary, swapped
   * for the first ACCURSED GIFT not yet selected this battle. The per-operative half is
   * reminder-only — see `REMINDER_ONLY`.
   */
  reg.on('gambitOptions', T.bind(EQ.balefulScript, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.balefulScript)) return;
    if (usedThisBattle(ev.state, `${EQ.balefulScript}:${T.player}`)) return;
    const rec = giftsFor(ev.state, T.player);
    if (!rec.primary && !rec.secondary) return;
    if (availableGifts(ev.state, T.player).length === 0) return;
    ev.options.push({
      id: EQ.balefulScript,
      label: 'Baleful Script: change one of your ACCURSED GIFTS',
      sourceText: shortQuote(text(EQ.balefulScript)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.balefulScript, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.balefulScript) return;
    if (!useOncePerBattle(ev.state, `${EQ.balefulScript}:${T.player}`)) return;
    const rec = giftsFor(ev.state, T.player);
    const asked = ev.data?.['slot'];
    const slot: 'primary' | 'secondary' =
      asked === 'primary' || asked === 'secondary' ? asked : rec.secondary ? 'secondary' : 'primary';
    const was = rec[slot];
    if (!was) return;
    const gift = pickGift(ev.state, T.player, ev.data?.['gift']);
    if (!gift) return;
    rec[slot] = gift;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Baleful Script: the ${slot} ACCURSED GIFT changes from ${GIFT_LABEL[was]} to ${GIFT_LABEL[gift]}`,
      data: { slot, gift },
    });
  });

  // =========================================================================
  // COVERT GUISES
  // =========================================================================
  // "After revealing this equipment option, roll one D3. As a STRATEGIC GAMBIT in the first
  //  turning point, a number of friendly CHAOS CULT DEVOTEE operatives equal to the result that
  //  are wholly within your drop zone can immediately perform a free Reposition action, but must
  //  end that move wholly within 3" of your drop zone."
  reg.on('onSelectEquipment', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!ev.equipment.includes(EQ.covertGuises)) return;
    if (!useOncePerBattle(ev.state, `${EQ.covertGuises}:${T.player}`)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'covertGuises', [d3], T.player, 'COVERT GUISES D3');
    effect(ev.state, {
      rule: COVERT_GUISES_D3,
      source: { kind: 'equipment', id: EQ.covertGuises },
      sourceText: shortQuote(text(EQ.covertGuises)),
      player: T.player,
      data: { count: d3 },
      expiry: { kind: 'endOfBattle' },
    });
  });
  reg.on('gambitOptions', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (!hasEquipment(ev.state, T.player, EQ.covertGuises)) return;
    ev.options.push({
      id: EQ.covertGuises,
      label: 'Covert Guises: a free Reposition for DEVOTEE operatives in your drop zone',
      sourceText: shortQuote(text(EQ.covertGuises)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.covertGuises, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.covertGuises) return;
    const rolled = ev.state.effects.find((e) => e.rule === COVERT_GUISES_D3 && e.player === T.player);
    const count = Number(rolled?.data?.['count'] ?? 1);
    const zones = dropZoneOf(ev.state, T.player);
    const eligible = T.friendlies(ev.state)
      .filter((o) => o.datacardId === CARD.devotee)
      .filter((o) => {
        const card = T.card(o);
        return card !== undefined && zones.length > 0 && baseWhollyWithin(o.pos, card.base, o.rot, zones);
      })
      .sort(byId)
      .slice(0, count);
    for (const op of eligible) {
      // REMINDER ONLY: "must end that move wholly within 3" of your drop zone" — no hook
      // constrains where a move ENDS.
      grantFreeAction(ev.state, op, {
        sourceId: EQ.covertGuises,
        sourceText: shortQuote(text(EQ.covertGuises)),
        threshold: currentApl(T, ev.state, op),
        kind: 'equipment',
        only: ['Reposition', WINGS_REPOSITION],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Covert Guises: ${eligible.length} of ${count} CHAOS DEVOTEE operatives may Reposition for free`,
    });
  });

  // =========================================================================
  // UNHOLY TALISMAN
  // =========================================================================
  /*
   * "Once per turning point, when an operative is shooting a friendly CHAOS CULT operative, in
   *  the Roll Defence Dice step, you can retain one of your normal successes as a critical
   *  success instead."
   *
   * `addRolled(seq.defence, results, save)` is called without `ClassifyOpts`, so there is no
   * critical threshold to move; the promotion is made in the post-roll `onDefenceDice` emit (the
   * Ratlings IMPROVISED ARMOUR seam) and is idempotent, because the step re-emits after each
   * re-roll.
   */
  reg.on('onDefenceDice', T.bind(EQ.unholyTalisman, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.unholyTalisman)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !mineCult(target)) return;
    const die = seq.defence.dice.find((d) => d.state === 'normal' && d.note !== 'Unholy Talisman');
    if (!die) return;
    if (!useOncePerTP(ev.state, `${EQ.unholyTalisman}:${T.player}`)) return;
    die.state = 'crit';
    die.note = 'Unholy Talisman';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: 'Unholy Talisman: one normal success is retained as a critical success',
    });
  });

  // =========================================================================
  // VILE BLESSING
  // =========================================================================
  /*
   * "Once per battle, when an attack dice inflicts Normal Dmg on a friendly CHAOS CULT operative
   *  (excluding DEVOTEE), you can ignore that inflicted damage. If that friendly operative is a
   *  MUTANT or TORMENT operative, you cannot roll for the Unnatural Regeneration rule for that
   *  attack dice then decide to use this rule on the same dice – you must use one or the other."
   *
   * Bound at priority 13, ABOVE Unnatural Regeneration's 14, and it records the dice it spared
   * in a per-damage-call bag that Unnatural Regeneration consumes — which is the printed "you
   * must use one or the other". Once per battle, so it is spent under D-022 on a stated policy:
   * only when the ignored Normal Dmg is 3 or more, or when the damage would incapacitate.
   */
  reg.on('onDamage', T.bind(EQ.vileBlessing, 13), (ev) => {
    if (ev.kind !== 'attack' || !hasEquipment(ev.state, T.player, EQ.vileBlessing)) return;
    const victim = ev.target;
    if (!mineCult(victim) || isDevoteeCard(victim)) return;
    if (usedThisBattle(ev.state, `${EQ.vileBlessing}:${T.player}`)) return;
    const slice = normalDamageSlice(T, ev.state, victim, ev.amount);
    if (slice <= 0) return;
    if (slice < 3 && ev.amount < victim.wounds) return;
    if (!useOncePerBattle(ev.state, `${EQ.vileBlessing}:${T.player}`)) return;
    ev.amount = Math.max(0, ev.amount - slice);
    const bag = bucket(ev.state, VILE_BLESSING_USED) as Record<string, number>;
    bag[victim.id] = (bag[victim.id] ?? 0) + 1;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Vile Blessing: ${victim.letter} ignores ${slice} damage`,
    });
  });
}

/** "…when an attack dice inflicts Normal Dmg" — the Hearthkyn Weavefield Crest read. */
function normalDamageSlice(T: TeamHooks, state: GameState, victim: OperativeState, amount: number): number {
  const seq = state.sequence;
  if (!seq || !T.ctx) return 0;
  if (seq.kind === 'fight') {
    const side = seq.defenderId === victim.id ? 'attacker' : seq.attackerId === victim.id ? 'defender' : undefined;
    if (!side) return 0;
    const striker = state.operatives[side === 'attacker' ? seq.attackerId : seq.defenderId];
    const name = side === 'attacker' ? seq.attackerWeapon : seq.defenderWeapon;
    if (!striker || !name) return 0;
    const w = weaponsOf(T.ctx, state, striker, 'melee').find((x) => x.name === name);
    const profile = w ? findProfile(w, side === 'attacker' ? seq.attackerProfile : seq.defenderProfile) : undefined;
    if (!profile || profile.dmgN <= 0) return 0;
    // A fight resolves one dice at a time, so `amount` IS that dice's damage.
    return amount === profile.dmgN ? profile.dmgN : 0;
  }
  if (seq.targetId !== victim.id) return 0;
  const attacker = state.operatives[seq.attackerId];
  const w = attacker ? weaponsOf(T.ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName) : undefined;
  const profile = w ? findProfile(w, seq.profileName) : undefined;
  if (!profile || profile.dmgN <= 0) return 0;
  if (!seq.attack.dice.some((d) => d.state === 'normal')) return 0;
  return Math.min(profile.dmgN, amount);
}

// ---------------------------------------------------------------------------
// Unique actions and the ActionDefs a rule grants (D-021)
// ---------------------------------------------------------------------------

const opCard = (ctx: GameContext, op: OperativeState): Datacard | undefined => ctx.datacards.get(op.datacardId);

function engagedNow(ctx: GameContext, state: GameState, op: OperativeState): boolean {
  return aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e));
}

function visibleFrom(ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean {
  return isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;
}

/** "One other friendly CHAOS CULT operative visible to and within 9" of this operative." */
function supportTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const range = supportDistance(ctx, state, op, 9);
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && hasKw(o, KW, ctx))
    .filter((o) => {
      const a = opCard(ctx, op);
      const b = opCard(ctx, o);
      if (!a || !b) return false;
      return (
        baseGapBetween(op, a, o, b) <= range + EPS && visibleFrom(ctx, state, op, o)
      );
    })
    .sort(byId);
}

function baseGapBetween(a: OperativeState, ca: Datacard, b: OperativeState, cb: Datacard): number {
  // The shared geometry helper, without needing a TeamHooks facade inside an ActionDef.
  return Math.max(0, dist(a.pos, b.pos) - baseRadius(ca.base) - baseRadius(cb.base));
}

const pickTarget = (list: OperativeState[], asked?: string): OperativeState | undefined =>
  list.find((o) => o.id === asked) ?? list[0];

/** Both SUPPORT actions share one legality check, so `perform` can never refuse (D-026). */
function supportCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string; target?: OperativeState } {
  if (engagedNow(ctx, state, op))
    return { ok: false, reason: 'this operative cannot perform this action while within control range of an enemy operative' };
  const list = supportTargets(ctx, state, op);
  const asked = params.targetOperativeId ?? params.targetId;
  if (asked !== undefined && !list.some((o) => o.id === asked))
    return { ok: false, reason: 'select one other friendly CHAOS CULT operative visible to and within 9"' };
  const target = pickTarget(list, asked);
  if (!target) return { ok: false, reason: 'no other friendly CHAOS CULT operative is visible to and within 9"' };
  return { ok: true, target };
}

function actions(): ActionDef[] {
  const out: ActionDef[] = [];

  // ---- CULT DEMAGOGUE › INCITE SLAUGHTER ---------------------------------
  // "SUPPORT. One other friendly CHAOS CULT operative visible to and within 9" of this operative
  //  can immediately perform a free Fight action."
  out.push(
    uniqueAction(DATA, CARD.demagogue, ACT.inciteSlaughter, {
      check: (ctx, state, op, params) => {
        const r = supportCheck(ctx, state, op, params);
        return r.ok ? { ok: true } : { ok: false, reason: r.reason! };
      },
      perform: (ctx, state, op, params) => {
        const r = supportCheck(ctx, state, op, params);
        if (!r.ok || !r.target) return { ok: false, reason: r.reason ?? 'no target' };
        grantFreeActionFor(ctx, state, r.target, ACT.inciteSlaughter, actionText(CARD.demagogue, ACT.inciteSlaughter), [
          'Fight',
          FIGHT_DAEMON,
        ]);
        return { ok: true };
      },
    }),
  );

  // ---- CULT DEMAGOGUE › INCITE URGENCY -----------------------------------
  // "SUPPORT. One other friendly CHAOS CULT operative visible to and within 9" of this operative
  //  can immediately perform a free Charge or Dash action (for the former, it cannot move more
  //  than 3")."
  out.push(
    uniqueAction(DATA, CARD.demagogue, ACT.inciteUrgency, {
      check: (ctx, state, op, params) => {
        const r = supportCheck(ctx, state, op, params);
        return r.ok ? { ok: true } : { ok: false, reason: r.reason! };
      },
      perform: (ctx, state, op, params) => {
        const r = supportCheck(ctx, state, op, params);
        if (!r.ok || !r.target) return { ok: false, reason: r.reason ?? 'no target' };
        const target = r.target;
        grantFreeActionFor(ctx, state, target, ACT.inciteUrgency, actionText(CARD.demagogue, ACT.inciteUrgency), [
          'Charge',
          'Dash',
          WINGS_CHARGE,
          WINGS_DASH,
        ]);
        effect(state, {
          rule: URGENCY_CHARGE_CAP,
          source: { kind: 'ability', id: ACT.inciteUrgency },
          sourceText: shortQuote(actionText(CARD.demagogue, ACT.inciteUrgency)),
          operativeId: target.id,
          player: target.player,
          expiry: { kind: 'endOfActivation', operativeId: target.id },
        });
        return { ok: true };
      },
    }),
  );

  // ---- ICONARCH › RUINOUS ICON -------------------------------------------
  /*
   * "PSYCHIC. Select one of the following effects to last until the start of this operative's
   *  next activation, until it's incapacitated or until it performs this action again (whichever
   *  comes first): … This operative cannot perform this action while within control range of an
   *  enemy operative."
   *
   * DATA-BLOCKED: the printed effect list is truncated out of the JSON, so the effect is placed
   * with the printed duration and carries no payload (see `REMINDER_ONLY`).
   */
  out.push(
    uniqueAction(DATA, CARD.iconarch, ACT.ruinousIcon, {
      check: (ctx, state, op) =>
        engagedNow(ctx, state, op)
          ? { ok: false, reason: 'this operative cannot perform this action while within control range of an enemy operative' }
          : { ok: true },
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === RUINOUS_EFFECT && e.operativeId === op.id);
        effect(state, {
          rule: RUINOUS_EFFECT,
          source: { kind: 'ability', id: ACT.ruinousIcon },
          sourceText: shortQuote(actionText(CARD.iconarch, ACT.ruinousIcon)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfBattle' },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter} raises the Ruinous Icon (the printed effect list is missing from the source data)`,
          data: { operativeId: op.id, dataBlocked: true },
        });
        return { ok: true };
      },
    }),
  );

  // ---- MINDWITCH › HEINOUS DELUGE ----------------------------------------
  // "PSYCHIC. Select one enemy operative that's a valid target for this operative. Until the end
  //  of that operative's next activation, subtract 1 from its APL stat."
  out.push(
    uniqueAction(DATA, CARD.mindwitch, ACT.heinousDeluge, {
      check: (ctx, state, op, params) => {
        if (engagedNow(ctx, state, op))
          return {
            ok: false,
            reason: 'this operative cannot perform this action while within control range of an enemy operative',
          };
        const list = delugeTargets(ctx, state, op);
        const asked = params.targetOperativeId ?? params.targetId;
        if (asked !== undefined && !list.some((o) => o.id === asked))
          return { ok: false, reason: 'select one enemy operative that’s a valid target for this operative' };
        return list.length > 0 ? { ok: true } : { ok: false, reason: 'no enemy operative is a valid target' };
      },
      perform: (ctx, state, op, params) => {
        const target = pickTarget(delugeTargets(ctx, state, op), params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'no enemy operative is a valid target' };
        dropEffects(state, (e) => e.rule === HEINOUS_EFFECT && e.operativeId === target.id && e.player === op.player);
        effect(state, {
          rule: HEINOUS_EFFECT,
          source: { kind: 'ability', id: ACT.heinousDeluge },
          sourceText: shortQuote(actionText(CARD.mindwitch, ACT.heinousDeluge)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter} floods ${target.letter} with a heinous deluge (-1 APL)`,
          data: { operativeId: target.id },
        });
        return { ok: true };
      },
    }),
  );

  // ---- MINDWITCH › MALEFIC VORTEX ----------------------------------------
  // "PSYCHIC. Remove your Malefic Vortex marker from the killzone (if any). Then place your
  //  Malefic Vortex marker visible to this operative, or on Vantage terrain of a terrain feature
  //  that's visible to this operative. Inflict 1 damage on each enemy operative within 2" of
  //  that marker."
  out.push(
    uniqueAction(DATA, CARD.mindwitch, ACT.maleficVortex, {
      check: (ctx, state, op) =>
        engagedNow(ctx, state, op)
          ? { ok: false, reason: 'this operative cannot perform this action while within control range of an enemy operative' }
          : { ok: true },
      perform: (ctx, state, op, params) => {
        removeMarker(state, VORTEX_MARKER(op.player));
        const pos = vortexPosition(ctx, state, op, params);
        const marker = placeTeamMarker(state, {
          id: VORTEX_MARKER(op.player),
          kind: 'generic',
          player: op.player,
          pos,
          z: 0,
          flags: { maleficVortex: true },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter} tears open a Malefic Vortex`,
          data: { operativeId: op.id, pos },
        });
        for (const foe of aliveOperatives(state, otherPlayer(op.player)).sort(byId)) {
          const card = opCard(ctx, foe);
          if (!card) continue;
          const gap = Math.max(0, dist(foe.pos, marker.pos) - baseRadius(card.base) - baseRadius(MARKER_BASE));
          if (gap > 2 + EPS) continue;
          inflictDamage(ctx, state, foe, 1, 'other');
        }
        return { ok: true };
      },
    }),
  );

  // ---- Fight (Unleash the Daemon) ----------------------------------------
  registerAction({
    id: FIGHT_DAEMON,
    name: FIGHT_DAEMON,
    ap: 1,
    type: 'unique',
    sourceText: text(FP.unleashTheDaemon),
    available: (ctx, state, op) =>
      hasKw(op, KW, ctx) && state.effects.some((e) => e.rule === DAEMON_EFFECT && e.operativeId === op.id),
    check(ctx, state, op, params) {
      if (!state.effects.some((e) => e.rule === DAEMON_EFFECT && e.operativeId === op.id))
        return { ok: false, reason: 'Unleash the Daemon has not been used on this operative' };
      if (!did(op, 'Fight')) return { ok: false, reason: 'this is the second Fight action of that activation' };
      return getAction('Fight')!.check(ctx, state, op, params);
    },
    perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
  });

  // ---- Deformed Wings: four sibling move actions (D-021) ------------------
  for (const spec of WINGS_SPECS) out.push(wingsAction(spec));

  return out;
}

/** "…an enemy operative that's a valid target for this operative", using its own ranged weapon. */
function delugeTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const weapon = weaponsOf(ctx, state, op, 'ranged')[0];
  const profile = weapon ? findProfile(weapon) : undefined;
  if (!weapon || !profile) return [];
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => {
      const rules = effectiveRules(ctx, state, profile, { operative: op, target: e, weaponName: weapon.name });
      return checkTarget(ctx, state, op, e, profile, rules).valid;
    })
    .sort(byId);
}

/**
 * "…place your Malefic Vortex marker visible to this operative". The printed rule sets no
 * distance limit, so the default (D-016) is the enemy position — visible to the MINDWITCH — that
 * catches the most enemy operatives inside the printed 2", falling back to the caster's own
 * spot so `perform` can never fail what `check` allowed (D-026).
 */
function vortexPosition(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): Vec2 {
  const asked = params.markerPos ?? params.targetPos ?? (params.data ? posFromData(params.data, op.pos) : undefined);
  const foes = aliveOperatives(state, otherPlayer(op.player));
  const index = terrain(ctx, state);
  const seesMarker = (pos: Vec2, z: number): boolean => isVisible(index, body(ctx, op), markerBodyAt(pos, z)).visible;
  if (asked && seesMarker(asked, 0)) return { x: asked.x, y: asked.y };
  const caught = (pos: Vec2): number =>
    foes.filter((f) => {
      const card = opCard(ctx, f);
      return (
        card !== undefined &&
        dist(f.pos, pos) - baseRadius(card.base) - baseRadius(MARKER_BASE) <= 2 + EPS
      );
    }).length;
  const ranked = foes
    .filter((f) => seesMarker(f.pos, f.z))
    .map((f) => ({ f, n: caught(f.pos) }))
    .sort((a, b) => b.n - a.n || byId(a.f, b.f));
  const best = ranked[0];
  if (best) {
    log(state, {
      kind: 'system',
      player: op.player,
      text: `Malefic Vortex: default placement on ${best.f.letter} (${best.n} enemy operatives within 2")`,
    });
    return { ...best.f.pos };
  }
  return { ...op.pos };
}

/** The D-015 free action a SUPPORT action hands to another operative. */
function grantFreeActionFor(
  ctx: GameContext,
  state: GameState,
  target: OperativeState,
  sourceId: string,
  sourceText: string,
  only: string[],
): void {
  // The threshold is the operative's LIVE APL — read through `aplOf`, which consults both
  // `aplMods` and `onStatMod`, so a HEINOUS DELUGE'd operative is not handed a free AP it can
  // then spend on anything it likes.
  const threshold = aplOf(ctx, state, target);
  grantFreeAction(state, target, {
    sourceId,
    sourceText: shortQuote(sourceText),
    threshold,
    kind: 'ability',
    only,
  });
}

// ---------------------------------------------------------------------------
// ACCURSED GIFT 1 — Deformed Wings
// ---------------------------------------------------------------------------

interface WingsSpec {
  id: string;
  base: 'Reposition' | 'Dash' | 'Charge' | 'Fall Back';
}

const WINGS_SPECS: WingsSpec[] = [
  { id: WINGS_REPOSITION, base: 'Reposition' },
  { id: WINGS_DASH, base: 'Dash' },
  { id: WINGS_CHARGE, base: 'Charge' },
  { id: WINGS_FALL_BACK, base: 'Fall Back' },
];

function wingsMoveOptions(base: WingsSpec['base']): MoveOptions {
  switch (base) {
    case 'Dash':
      return { action: 'Dash', noClimb: true, mustNotFinishEngaged: true };
    case 'Charge':
      return { action: 'Charge', bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true };
    case 'Fall Back':
      return { action: 'Fall Back', mayEnterEnemyControlRange: true, mustNotFinishEngaged: true };
    default:
      return { action: 'Reposition', mustNotFinishEngaged: true };
  }
}

function wingsPreconditions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  base: WingsSpec['base'],
): { ok: boolean; reason?: string } {
  const engaged = engagedNow(ctx, state, op);
  if (base === 'Fall Back') {
    if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
    if (did(op, 'Reposition') || did(op, 'Charge'))
      return { ok: false, reason: 'already performed Reposition or Charge this activation' };
    return { ok: true };
  }
  if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
  if (base === 'Charge') {
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
    if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    return { ok: true };
  }
  if (base === 'Dash') {
    if (did(op, 'Charge')) return { ok: false, reason: 'already performed Charge this activation' };
    return { ok: true };
  }
  if (did(op, 'Fall Back') || did(op, 'Charge'))
    return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
  return { ok: true };
}

/**
 * "Whenever this operative is climbing up, you can treat the vertical distance as 2"
 * (regardless of how far the operative actually moves vertically). Whenever this operative is
 * dropping, ignore the vertical distance."
 *
 * `onMoveRules` — which carries `ignoreClimbCost` and `ignoreDropInches` — is declared but NEVER
 * emitted, and `validateMove` keeps its `legs` to itself, so Deformed Wings is four sibling
 * `ActionDef`s (the Farstalker BOUND / Murderwing BOOST precedent, D-021). The path is validated
 * twice: once with a generous allowance to discover the climb and drop legs, then again with
 * exactly the vertical distance the gift refunds. "You can treat" is optional, so a ladder climb
 * already charged 1" is never made worse.
 *
 * D-021's stated consequence: `src/ai/legal.ts` only builds movement params for the four
 * universal move ids, so a human uses these and the AI never does.
 */
function wingsValidate(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  base: WingsSpec['base'],
): { ok: boolean; reason?: string; endPos?: Vec2; endZ?: number; total?: number; ignored?: number } {
  if (!hasGift(state, op, 'deformed-wings'))
    return { ok: false, reason: 'this operative does not have the Deformed Wings ACCURSED GIFT' };
  const pre = wingsPreconditions(ctx, state, op, base);
  if (!pre.ok) return pre;
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const opts = wingsMoveOptions(base);
  const bonus = opts.bonusInches ?? 0;
  const probe = validateMove(ctx, state, op, params.path, { ...opts, bonusInches: bonus + 24 });
  if (!probe.ok) return { ok: false, reason: probe.reason ?? 'illegal move' };
  let ignored = 0;
  for (const leg of probe.legs) {
    if (leg.kind === 'climb') ignored += Math.max(0, leg.charged - 2);
    else if (leg.kind === 'drop') ignored += leg.charged;
  }
  if (ignored <= 0) return { ok: false, reason: 'this move includes no climb up or drop to ignore' };
  const v = validateMove(ctx, state, op, params.path, { ...opts, bonusInches: bonus + ignored });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  return { ok: true, endPos: v.endPos, endZ: v.endZ, total: v.total, ignored };
}

function wingsAction(spec: WingsSpec): ActionDef {
  return {
    id: spec.id,
    name: spec.id,
    ap: spec.base === 'Fall Back' ? 2 : 1,
    type: 'unique',
    treatedAs: spec.base,
    sourceText: GIFT_TEXT['deformed-wings'],
    available: (ctx, state, op) => hasKw(op, KW, ctx) && hasGift(state, op, 'deformed-wings'),
    check: (ctx, state, op, params) => {
      const v = wingsValidate(ctx, state, op, params, spec.base);
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform: (ctx, state, op, params) => {
      const v = wingsValidate(ctx, state, op, params, spec.base);
      if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
      op.pos = { ...v.endPos! };
      op.z = v.endZ!;
      if (params.path?.endRot !== undefined) op.rot = params.path.endRot;
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      if (spec.base === 'Charge') {
        op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} performs ${spec.id} (${v.total!}", ignoring ${v.ignored!}" of vertical distance)`,
        data: { operativeId: op.id, action: spec.id, inches: v.total },
      });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export const chaosCult = defineTeam({
  id: 'chaos-cult',
  rules,
  ploys,
  equipment,
  actions,
  rareRules: ['PSYCHIC'],
  ployUsable: {
    [FP.faithfulFollower]: (state, player) =>
      aliveOperatives(state, player).some((o) => isCultOp(o) && isDarkCommune(o))
        ? { ok: true }
        : { ok: false, reason: 'no friendly CHAOS CULT DARK COMMUNE operative is in the killzone' },
    [FP.abhorrentMutation]: (state, player) => {
      const used = (state.opState[ABHORRENT_BAG] ?? {}) as Record<string, boolean>;
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player || !isCultOp(active) || isDarkCommune(active))
        return {
          ok: false,
          reason: 'use it when a friendly CHAOS CULT operative (excluding DARK COMMUNE) is activated',
        };
      if (used[active.id]) return { ok: false, reason: 'that operative has already been selected for this ploy' };
      return { ok: true };
    },
    [FP.frenziedDemise]: (state, player) =>
      aliveOperatives(state, player).some(isAccursed)
        ? { ok: true }
        : { ok: false, reason: 'no friendly CHAOS CULT MUTANT or CHAOS CULT TORMENT operative is in the killzone' },
    [FP.unleashTheDaemon]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && isAccursed(active)
        ? { ok: true }
        : {
            ok: false,
            reason: 'use it during a friendly CHAOS CULT MUTANT or CHAOS CULT TORMENT operative’s activation',
          };
    },
  },
  aiHints: {
    roles: {
      [CARD.demagogue]: 'leader',
      [CARD.blessedBlade]: 'melee',
      [CARD.iconarch]: 'objective',
      [CARD.mindwitch]: 'gunner',
      [CARD.devotee]: 'objective',
      [CARD.mutant]: 'melee',
      [CARD.torment]: 'melee',
    },
    ployValue: {
      // Mutation is the whole team: priced above every ploy so a bot never leaves the CHAOS
      // MUTANT and CHAOS TORMENT datacards — and six ACCURSED GIFTS — switched off for the
      // battle (the Canoptek OBELISK NODE placement precedent).
      [MUTATE_GAMBIT]: 3,
      [SP.exaltationInPain]: 0.5,
      [SP.ferventOnslaught]: 0.6,
      [SP.creaturesOfNightmare]: 0.35,
      [SP.sickeningAura]: 0.55,
      [FP.faithfulFollower]: 0.5,
      [FP.abhorrentMutation]: 0.45,
      [FP.frenziedDemise]: 0.4,
      [FP.unleashTheDaemon]: 0.6,
      [EQ.balefulScript]: 0.2,
      [EQ.covertGuises]: 0.5,
    },
    equipmentValue: {
      [EQ.balefulScript]: 0.2,
      [EQ.covertGuises]: 0.5,
      [EQ.unholyTalisman]: 0.55,
      [EQ.vileBlessing]: 0.6,
    },
  },
});

export default chaosCult;
