/**
 * BLADES OF KHAINE — Aeldari (Asuryani Aspect Warriors).
 * https://wahapedia.ru/kill-team3/kill-teams/blades-of-khaine/
 *
 * Rule text is read from `data/teams/blades-of-khaine.json`; every hook carries a short
 * verbatim quote of the printed rule in its RuleBinding.
 *
 * The whole team is ONE faction rule — **Aspect Techniques** — a menu of fifteen sub-rules in
 * three Aspect categories with no ids of their own. They are sliced out of the single printed
 * faction rule at module load (the Kasrkin SKILL AT ARMS / Legionary Marks of Chaos exception
 * to "never retype printed rule text") and share one budget, `aspectLedger`:
 *
 *   - "You cannot use more than one ASPECT TECHNIQUE per activation or counteraction."
 *   - "You cannot use each ASPECT TECHNIQUE more than once per turning point." — twice while
 *     every operative selected for deployment shares one Aspect keyword.
 *
 * **How a technique is DECLARED.** The engine has no "use a rule now" intent: `UsePloy` is for
 * ploys and a STRATEGIC GAMBIT only exists in the Strategy phase. Ten techniques modify an
 * action the operative is about to perform, so each is registered as its own `ActionDef` that
 * wraps that action (docs/DECISIONS.md D-021) — `Shoot (Vigilance of the Avenger)`,
 * `Reposition (Patient Stalk, Sudden Blow)`, `Charge (The Woe)` … — with `treatedAs` pointing
 * at the universal action wherever the printed rule keeps the action's identity, so action
 * restrictions and AP cost stay the printed ones. Two more ("during a friendly … operative's
 * activation", with no single action to hang off) are 0AP declaration actions. The consequence
 * D-021 already records applies: `src/ai/legal.ts` cannot build weapon or path params for a
 * non-universal action id, so the AI only ever uses the two 0AP declarations; a human can use
 * them all.
 *
 * Two techniques whose printed trigger lands inside a sequence the active player may not own
 * are reactive instead: RAIN OF TEARS and SCREAM-THAT-STEALS raise a real `PendingDecision`
 * through `GameContext.decisionHandlers` (both list "decline" first, so the deterministic
 * default never spends the technique). UNSTINTING, IMMOVABLE fires during an ENEMY activation
 * and is free and strictly beneficial, so it is auto-used under D-022.
 *
 * ACROBATIC is the one technique with NO handler at all: both of its permissions are
 * `onMoveRules`, which is declared but never emitted, and registering the third clause alone
 * ("Cannot move more than its Move stat if it's the Charge action") would leave the player a
 * technique that is purely a penalty. It is reminder-only, and reported as such.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { validateMove } from '../../core/movement.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { successes, type DicePool } from '../../core/dice.ts';
import {
  body,
  gapBetween,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import { coverAndObscured, isVisible, withinControlRange } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Vec2,
  Weapon,
} from '../../core/types.ts';
import { teamData } from '../data.ts';
import { loadoutOf } from '../selection.ts';
import {
  aliveOperatives,
  catalogueCard,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  enemiesInControlRange,
  gambitUsed,
  hasEquipment,
  ployUsed,
  ruleTag,
  shortQuote,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('blades-of-khaine');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

export const KW = 'BLADES OF KHAINE';
export const DIRE_AVENGER = 'DIRE AVENGER';
export const HOWLING_BANSHEE = 'HOWLING BANSHEE';
export const STRIKING_SCORPION = 'STRIKING SCORPION';
/** "If every friendly BLADES OF KHAINE operative selected for deployment has the same Aspect keyword". */
export const ASPECT_KEYWORDS = [DIRE_AVENGER, HOWLING_BANSHEE, STRIKING_SCORPION] as const;

export const RULE_ASPECT_TECHNIQUES = 'blades-of-khaine.rule.aspect-techniques';

export const SP = {
  forewarned: 'blades-of-khaine.sp.forewarned',
  ruthlessPoise: 'blades-of-khaine.sp.ruthless-poise',
  khainesVengeance: 'blades-of-khaine.sp.khaines-vengeance',
  danceOfDeath: 'blades-of-khaine.sp.dance-of-death',
} as const;

/**
 * The four firefight ploys carry "1CP" glued onto their printed NAME **and** their id
 * (`BLADEWIND1CP`, `blades-of-khaine.fp.bladewind1cp`) — the Inquisitorial Agent scraper bug,
 * confirmed here on a second team. Ids are load-bearing, so they are used verbatim.
 */
export const FP = {
  bladewind: 'blades-of-khaine.fp.bladewind1cp',
  starfall: 'blades-of-khaine.fp.starfall1cp',
  fadingLight: 'blades-of-khaine.fp.fading-light1cp',
  contempt: 'blades-of-khaine.fp.contempt1cp',
} as const;

export const EQ = {
  runeOfProphecy: 'blades-of-khaine.eq.rune-of-prophecy',
  runeOfShielding: 'blades-of-khaine.eq.rune-of-shielding',
  runeOfForesight: 'blades-of-khaine.eq.rune-of-foresight',
  wraithboneTalisman: 'blades-of-khaine.eq.wraithbone-talisman',
} as const;

export const C = {
  direAvengerExarch: 'blades-of-khaine.dire-avenger-exarch',
  direAvengerWarrior: 'blades-of-khaine.dire-avenger-warrior',
  howlingBansheeExarch: 'blades-of-khaine.howling-banshee-exarch',
  howlingBansheeWarrior: 'blades-of-khaine.howling-banshee-warrior',
  strikingScorpionExarch: 'blades-of-khaine.striking-scorpion-exarch',
  strikingScorpionWarrior: 'blades-of-khaine.striking-scorpion-warrior',
} as const;

const A = {
  defenceTacticsExarch: 'blades-of-khaine.dire-avenger-exarch.defence-tactics',
  defenceTacticsWarrior: 'blades-of-khaine.dire-avenger-warrior.defence-tactics',
  exarchDireAvenger: 'blades-of-khaine.dire-avenger-exarch.exarch',
  exarchBanshee: 'blades-of-khaine.howling-banshee-exarch.exarch',
  exarchScorpion: 'blades-of-khaine.striking-scorpion-exarch.exarch',
  shimmershield: 'blades-of-khaine.dire-avenger-exarch.shimmershield',
  bansheeMaskExarch: 'blades-of-khaine.howling-banshee-exarch.banshee-mask',
  bansheeMaskWarrior: 'blades-of-khaine.howling-banshee-warrior.banshee-mask',
  mandiblastersExarch: 'blades-of-khaine.striking-scorpion-exarch.mandiblasters',
  mandiblastersWarrior: 'blades-of-khaine.striking-scorpion-warrior.mandiblasters',
} as const;

// ---------------------------------------------------------------------------
// The ASPECT TECHNIQUE menu, sliced out of the one printed faction rule
// ---------------------------------------------------------------------------

export interface AspectTechnique {
  /** Derived slug — the printed menu gives its entries no ids. */
  id: string;
  name: string;
  /** The Aspect keyword an operative must have to use it. */
  aspect: string;
  /** The printed "Use this ASPECT TECHNIQUE when…" paragraph, verbatim. */
  text: string;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * "Dire Avenger Aspect Techniques / THE SLICING HURRICANE / <fluff> / Use this ASPECT
 * TECHNIQUE when…" — three category headings, each followed by five NAME + fluff + rule
 * blocks. Sliced rather than retyped (CLAUDE.md: rules as data); the sentinel is the printed
 * "Use this ASPECT TECHNIQUE" opening every one of them.
 */
export const ASPECT_TECHNIQUES: AspectTechnique[] = (() => {
  const src = text(RULE_ASPECT_TECHNIQUES);
  const out: AspectTechnique[] = [];
  const heading = /^(.+?) Aspect Techniques$/gm;
  const heads: { aspect: string; at: number; end: number }[] = [];
  for (let m = heading.exec(src); m !== null; m = heading.exec(src))
    heads.push({ aspect: m[1]!.trim().toUpperCase(), at: m.index, end: m.index + m[0].length });
  heads.forEach((head, i) => {
    const bodyText = src.slice(head.end, i + 1 < heads.length ? heads[i + 1]!.at : src.length);
    const use = /^Use this ASPECT TECHNIQUE\b/gm;
    const starts: number[] = [];
    for (let m = use.exec(bodyText); m !== null; m = use.exec(bodyText)) starts.push(m.index);
    starts.forEach((start, j) => {
      // The two non-blank lines before the rule are the NAME and its fluff paragraph.
      const before = bodyText.slice(0, start).split('\n').filter((l) => l.trim().length > 0);
      const name = (before[before.length - 2] ?? '').trim();
      let segment = bodyText.slice(start, j + 1 < starts.length ? starts[j + 1]! : bodyText.length);
      if (j + 1 < starts.length) {
        // Drop the next technique's NAME + fluff lines from the tail of this one.
        const lines = segment.split('\n');
        let k = lines.length;
        let dropped = 0;
        while (k > 0 && dropped < 2) {
          k--;
          if (lines[k]!.trim().length > 0) dropped++;
        }
        segment = lines.slice(0, k).join('\n');
      }
      if (name.length > 0) out.push({ id: slug(name), name, aspect: head.aspect, text: segment.trim() });
    });
  });
  return out;
})();

export function aspectTechnique(id: string): AspectTechnique {
  const t = ASPECT_TECHNIQUES.find((x) => x.id === id);
  if (!t)
    throw new Error(
      `No ASPECT TECHNIQUE '${id}' in data/teams/blades-of-khaine.json — the printed menu was re-scraped`,
    );
  return t;
}

/** Slugs of the fifteen printed techniques; every one is resolved (and so validated) at load. */
export const AT = {
  slicingHurricane: 'the-slicing-hurricane',
  thousandBlades: 'death-of-a-thousand-blades',
  vigilance: 'vigilance-of-the-avenger',
  unstinting: 'unstinting-immovable',
  ragingHeat: 'raging-heat-of-the-dying-flame',
  theWoe: 'the-woe',
  rainOfTears: 'rain-of-tears',
  acrobatic: 'acrobatic',
  screamThatSteals: 'scream-that-steals',
  shriekThatKills: 'shriek-that-kills',
  patientStalk: 'patient-stalk-sudden-blow',
  strikeAndFade: 'strike-and-fade',
  scorpionsEye: 'scorpions-eye',
  mercilessStrikes: 'merciless-strikes',
  oneWithTheGloom: 'one-with-the-gloom',
} as const;
for (const id of Object.values(AT)) aspectTechnique(id);

// ---------------------------------------------------------------------------
// The shared ASPECT TECHNIQUE budget
// ---------------------------------------------------------------------------

const LEDGER = 'blades-of-khaine.aspectLedger';

interface AspectLedger {
  tp: number;
  /** techniqueId -> uses this turning point. */
  counts: Record<string, number>;
  /** The activation/counteraction a technique has already been used in. */
  activation: string;
}

/**
 * A stable key for "this activation or counteraction". `activationsThisTP` does not advance
 * for a counteraction (the reducer says so explicitly), so the active operative is part of the
 * key; UNSTINTING, IMMOVABLE fires during an ENEMY activation, which the same key covers.
 */
function activationKey(state: GameState): string {
  const counteract = state.opState['counteract']?.['operativeId'];
  return `${state.turningPoint}|${state.activationsThisTP}|${state.activeOperativeId ?? '-'}|${counteract ?? '-'}`;
}

/** Read-only view — `check` and `available` are queries the AI runs many times per turn. */
function readLedger(state: GameState, player: PlayerId): AspectLedger {
  const store = state.opState[LEDGER] as Record<string, AspectLedger> | undefined;
  const cur = store?.[player];
  if (cur && cur.tp === state.turningPoint) return cur;
  return { tp: state.turningPoint, counts: {}, activation: '' };
}

function mutableLedger(state: GameState, player: PlayerId): AspectLedger {
  const store = (state.opState[LEDGER] ?? {}) as Record<string, AspectLedger>;
  state.opState[LEDGER] = store;
  const cur = store[player];
  if (cur && cur.tp === state.turningPoint) return cur;
  const fresh: AspectLedger = { tp: state.turningPoint, counts: {}, activation: '' };
  store[player] = fresh;
  return fresh;
}

const cardOf = (op: OperativeState): Datacard | undefined => catalogueCard(op.datacardId);
const hasKeyword = (op: OperativeState, keyword: string): boolean =>
  (cardOf(op)?.keywords ?? []).some((k) => k.toUpperCase() === keyword);

/** The Aspect keyword an operative belongs to, if any. */
export function aspectOf(op: OperativeState): string | undefined {
  return ASPECT_KEYWORDS.find((k) => hasKeyword(op, k));
}

/**
 * "If every friendly BLADES OF KHAINE operative selected for deployment has the same Aspect
 * keyword (e.g. STRIKING SCORPION), you cannot use each ASPECT TECHNIQUE more than twice per
 * turning point (instead of once)."  Read from the roster, so casualties do not change it.
 */
export function monoAspect(state: GameState, player: PlayerId): string | undefined {
  const ids = state.teams[player].operativeIds;
  if (ids.length === 0) return undefined;
  const aspects = new Set<string>();
  for (const id of ids) {
    const op = state.operatives[id];
    const aspect = op ? aspectOf(op) : undefined;
    if (!aspect) return undefined;
    aspects.add(aspect);
  }
  return aspects.size === 1 ? [...aspects][0] : undefined;
}

export const perTurningPointLimit = (state: GameState, player: PlayerId): number =>
  monoAspect(state, player) !== undefined ? 2 : 1;

/** Every printed limit on using an ASPECT TECHNIQUE right now, as one answer. */
export function techniqueUsable(
  state: GameState,
  op: OperativeState,
  techniqueId: string,
): { ok: boolean; reason?: string } {
  const tech = aspectTechnique(techniqueId);
  if (!hasKeyword(op, KW)) return { ok: false, reason: 'not a BLADES OF KHAINE operative' };
  if (!hasKeyword(op, tech.aspect))
    return { ok: false, reason: `${tech.name} can only be used with a friendly ${tech.aspect} operative` };
  const led = readLedger(state, op.player);
  const limit = perTurningPointLimit(state, op.player);
  if ((led.counts[techniqueId] ?? 0) >= limit)
    return {
      ok: false,
      reason: `${tech.name} has already been used ${limit === 1 ? 'this turning point' : 'twice this turning point'}`,
    };
  if (led.activation === activationKey(state) && led.activation !== '')
    return { ok: false, reason: 'you cannot use more than one ASPECT TECHNIQUE per activation or counteraction' };
  return { ok: true };
}

export function claimTechnique(state: GameState, op: OperativeState, techniqueId: string): void {
  const tech = aspectTechnique(techniqueId);
  const led = mutableLedger(state, op.player);
  led.counts[techniqueId] = (led.counts[techniqueId] ?? 0) + 1;
  led.activation = activationKey(state);
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `ASPECT TECHNIQUE: ${tech.name} (${op.letter})`,
    data: { operativeId: op.id, technique: techniqueId },
  });
}

export const techniqueUses = (state: GameState, player: PlayerId, techniqueId: string): number =>
  readLedger(state, player).counts[techniqueId] ?? 0;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Effect rule names — never module-level mutable state (architecture rule 7). */
const EFF = {
  patientStalk: 'blades-of-khaine.at.patientStalk',
  slicingHurricane: 'blades-of-khaine.at.slicingHurricane',
  thousandBlades: 'blades-of-khaine.at.thousandBlades',
  vigilance: 'blades-of-khaine.at.vigilance',
  ragingHeat: 'blades-of-khaine.at.ragingHeat',
  shriek: 'blades-of-khaine.at.shriek',
  scorpionsEye: 'blades-of-khaine.at.scorpionsEye',
  merciless: 'blades-of-khaine.at.mercilessStrikes',
  mercilessArmed: 'blades-of-khaine.at.mercilessArmed',
  gloom: 'blades-of-khaine.at.oneWithTheGloom',
  rainArmed: 'blades-of-khaine.at.rainOfTearsArmed',
  woeKill: 'blades-of-khaine.at.woeKill',
  fadeKill: 'blades-of-khaine.at.strikeAndFadeKill',
  bladewind: 'blades-of-khaine.fp.bladewind',
  starfall: 'blades-of-khaine.fp.starfall',
  fadingLight: 'blades-of-khaine.fp.fadingLight',
  contempt: 'blades-of-khaine.fp.contempt',
} as const;

export const RAIN_DECISION = 'blades-of-khaine.rainOfTears';
export const SCREAM_DECISION = 'blades-of-khaine.screamThatSteals';

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

function seqStamp(state: GameState): string {
  const s = state.sequence;
  if (!s) return 'none';
  return s.kind === 'shoot' ? `shoot:${s.attackerId}:${s.targetId}` : `fight:${s.attackerId}:${s.defenderId}`;
}

/**
 * "Until the end of that action."
 *
 * Nothing runs at the end of an action, and the reducer pushes the action's restriction key
 * onto `actionsThisActivation` as soon as `perform` RETURNS — which is long before a shoot or
 * fight sequence finishes, because `advanceShoot`/`advanceFight` stop at the first pending
 * decision. So a per-action grant is bounded to the ACTIVATION instead, and the only way a
 * BLADES OF KHAINE operative performs a second Shoot or Fight action in one activation is
 * through an ActionDef this module owns (Exarch, BLADEWIND, STARFALL) — each of which clears
 * the grants first, so the bound never actually leaks. THE SLICING HURRICANE's free Shoot is
 * itself the activation's one ASPECT TECHNIQUE, so no other grant can precede it.
 */
const declared = (state: GameState, op: OperativeState, rule: string): boolean =>
  effectOn(state, op.id, rule) !== undefined;

const PER_ACTION_GRANTS: string[] = [
  EFF.slicingHurricane,
  EFF.thousandBlades,
  EFF.vigilance,
  EFF.scorpionsEye,
  EFF.shriek,
  EFF.merciless,
];

function clearActionGrants(state: GameState, op: OperativeState): void {
  dropEffects(state, (e) => e.operativeId === op.id && PER_ACTION_GRANTS.includes(e.rule));
  dropShriek(op);
}

function declare(state: GameState, op: OperativeState, techniqueId: string, rule: string): void {
  claimTechnique(state, op, techniqueId);
  effect(state, {
    rule,
    source: { kind: 'ability', id: RULE_ASPECT_TECHNIQUES },
    sourceText: shortQuote(aspectTechnique(techniqueId).text),
    operativeId: op.id,
    player: op.player,
    data: { technique: techniqueId },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
}

/** A strategy ploy can reach the state either as a STRATEGIC GAMBIT or through `UsePloy`. */
const strategyPloyUsed = (state: GameState, player: PlayerId, id: string): boolean =>
  gambitUsed(state, player, id) || ployUsed(state, player, id);

const SHURIKEN_CATAPULTS = ['shuriken catapult', 'twin shuriken catapult'];
const SLICING_WEAPONS = ['shuriken catapult', 'shuriken pistol', 'twin shuriken catapult'];
const isWeapon = (name: string | undefined, names: string[]): boolean =>
  names.includes((name ?? '').trim().toLowerCase());

/**
 * "…if you roll two or more fails, you can discard one of them to retain another as a normal
 * success instead." Applied straight to the live pool: the worst fail is discarded and the best
 * is retained, which is the same deterministic default `applyRetention` uses.
 */
function discardFailForNormal(pool: DicePool, note: string): boolean {
  const f = pool.dice.filter((d) => d.state === 'fail').sort((a, b) => a.value - b.value || a.id - b.id);
  if (f.length < 2) return false;
  const discard = f[0]!;
  const retain = f[f.length - 1]!;
  discard.state = 'discarded';
  discard.note = note;
  retain.state = 'normal';
  retain.note = note;
  return true;
}

/**
 * The DIRE AVENGER EXARCH's shimmershield is **not a datacard weapon** — the selection option
 * is kept verbatim in `items[]` (a data problem reported with this team) — so the only trace of
 * it is the recorded loadout: the option group is "Shimmershield or shuriken pistol", and an
 * EXARCH whose loadout omits the shuriken pistol took the shield. With no recorded loadout
 * (an AI-driven game never calls `applyLoadouts`) nothing was selected, so the rule is off.
 */
export function hasShimmershield(state: GameState, op: OperativeState): boolean {
  if (op.datacardId !== C.direAvengerExarch) return false;
  const loadout = loadoutOf(state, op.id);
  if (!loadout) return false;
  return !loadout.some((w) => w.trim().toLowerCase() === 'shuriken pistol');
}

/** The Shriek-that-kills profile, with the weapon rules sliced out of the printed WR row. */
export const SHRIEK_WEAPON: Weapon = (() => {
  const printed = (DATA.factionRules.find((r) => r.id === RULE_ASPECT_TECHNIQUES) as unknown as {
    weapons?: { name: string; profiles: { atk: number; hit: number; dmgN: number; dmgC: number }[] }[];
  }).weapons?.[0];
  if (!printed) throw new Error('No Shriek-that-kills weapon in data/teams/blades-of-khaine.json');
  const stats = printed.profiles[0]!;
  // The scraper parsed the WR cell to `rules: []`, so it is read back out of the printed text
  // (the Elucidian Starstrider PRIVATEER SUPPORT ASSETS precedent).
  const wr = /\bWR\s*\n+\s*(.+)\s*$/m.exec(aspectTechnique(AT.shriekThatKills).text)?.[1] ?? '';
  return {
    name: printed.name,
    profiles: [
      {
        type: 'ranged',
        atk: stats.atk,
        hit: stats.hit,
        dmgN: stats.dmgN,
        dmgC: stats.dmgC,
        rules: parseWeaponRules(wr),
      },
    ],
  };
})();

const grantShriek = (op: OperativeState): void => {
  const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
  holder.grantedWeapons = holder.grantedWeapons ?? [];
  if (!holder.grantedWeapons.some((w) => w.name === SHRIEK_WEAPON.name)) holder.grantedWeapons.push(SHRIEK_WEAPON);
};
const dropShriek = (op: OperativeState): void => {
  const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
  if (holder.grantedWeapons) holder.grantedWeapons = holder.grantedWeapons.filter((w) => w.name !== SHRIEK_WEAPON.name);
};

/** How many inches this operative already spent on a Charge in this activation (from the log). */
function chargeInchesThisActivation(state: GameState, op: OperativeState): number {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.tp !== state.turningPoint) break;
    if (entry.data?.['operativeId'] === op.id && entry.data['action'] === 'Charge')
      return Number(entry.data['inches'] ?? 0);
  }
  return 0;
}

/**
 * "…one enemy operative it moved within control range of." The engine has no per-increment
 * movement hook, so the validated path is re-walked afterwards and each sample point tested
 * with the core's own `withinControlRange` ("visible to and within 1"", mutual).
 */
export function enemiesPassed(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  legs: { from: Vec2; to: Vec2; toZ: number }[],
): OperativeState[] {
  const index = terrain(ctx, state);
  const enemies = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1');
  const self = body(ctx, op);
  const hit = new Map<string, OperativeState>();
  const probe = (pos: Vec2, z: number): void => {
    const ghost = { ...self, pos, z };
    for (const e of enemies) {
      if (hit.has(e.id)) continue;
      if (withinControlRange(index, ghost, body(ctx, e))) hit.set(e.id, e);
    }
  };
  for (const leg of legs) {
    const dx = leg.to.x - leg.from.x;
    const dy = leg.to.y - leg.from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.4));
    for (let i = 0; i <= steps; i++)
      probe({ x: leg.from.x + (dx * i) / steps, y: leg.from.y + (dy * i) / steps }, leg.toZ);
  }
  return [...hit.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const bindAT = (techniqueId: string, priority = 10) =>
    T.bindText(`${RULE_ASPECT_TECHNIQUES}.${techniqueId}`, aspectTechnique(techniqueId).text, priority);

  // ---- DEATH OF A THOUSAND BLADES -----------------------------------------
  // "Until the end of that action, that weapon has the Torrent 2" weapon rule, but you cannot
  //  select more than one secondary target."
  reg.on('onWeaponRules', bindAT(AT.thousandBlades, 11), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, DIRE_AVENGER)) return;
    if (!isWeapon(ev.weaponName, SHURIKEN_CATAPULTS)) return;
    if (!declared(ev.state, ev.operative, EFF.thousandBlades)) return;
    ev.rules.push(ruleTag('Torrent', 2, 'Torrent 2" (DEATH OF A THOUSAND BLADES)'));
  });
  reg.on('onCollectAttackDice', bindAT(AT.thousandBlades, 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary || ev.ctx.type !== 'ranged') return;
    if (!declared(ev.state, ev.ctx.attacker, EFF.thousandBlades)) return;
    if (seq.queue.length > 1) {
      seq.queue = seq.queue.slice(0, 1);
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: 'DEATH OF A THOUSAND BLADES: only one secondary target',
      });
    }
  });

  // ---- VIGILANCE OF THE AVENGER -------------------------------------------
  reg.on('onWeaponRules', bindAT(AT.vigilance, 11), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, DIRE_AVENGER)) return;
    if (!isWeapon(ev.weaponName, SHURIKEN_CATAPULTS)) return;
    if (!declared(ev.state, ev.operative, EFF.vigilance)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (VIGILANCE OF THE AVENGER)'));
  });

  // ---- SCORPION'S EYE ------------------------------------------------------
  reg.on('onWeaponRules', bindAT(AT.scorpionsEye, 11), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, STRIKING_SCORPION)) return;
    if (!isWeapon(ev.weaponName, ['shuriken pistol'])) return;
    if (!declared(ev.state, ev.operative, EFF.scorpionsEye)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, "Seek Light (SCORPION'S EYE)"));
  });

  // ---- UNSTINTING, IMMOVABLE ----------------------------------------------
  // "Use this ASPECT TECHNIQUE when an operative is shooting a friendly DIRE AVENGER operative,
  //  and you've rolled two or more fails. You can discard one of them to retain the other as a
  //  normal success instead."  The trigger sits inside an enemy activation, where no action
  //  channel exists, and it is free and strictly beneficial — auto-used under D-022.
  reg.on('onDefenceDice', bindAT(AT.unstinting, 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, DIRE_AVENGER)) return;
    if (!techniqueUsable(ev.state, target, AT.unstinting).ok) return;
    if (seq.defence.dice.filter((d) => d.state === 'fail').length < 2) return;
    claimTechnique(ev.state, target, AT.unstinting);
    discardFailForNormal(seq.defence, 'UNSTINTING, IMMOVABLE');
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `UNSTINTING, IMMOVABLE: ${target.letter} retains a fail as a normal success`,
    });
  });

  // ---- RAGING HEAT OF THE DYING FLAME -------------------------------------
  // "…you can ignore any changes to its stats from being injured (including its weapons' stats)."
  // Injured is −2" Move and Hit worsened by 1, both applied by `moveOf`/`hitOf` AFTER the
  // `onStatMod` hook, so cancelling them is exactly +2 move and +1 hit while injured.
  reg.on('onStatMod', bindAT(AT.ragingHeat, 11), (ev) => {
    if (!T.mineKw(ev.operative, DIRE_AVENGER)) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.ragingHeat)) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });

  // ---- ONE WITH THE GLOOM --------------------------------------------------
  // "…while that operative has a Conceal order and is in cover, it cannot be selected as a
  //  valid target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except
  //  being within 2"."  Cover is recomputed with DEFAULT options, which is what "taking
  //  precedence over all other rules" means (the Ratlings SHIFTY precedent); `onValidTarget` is
  //  emitted before the sequence works cover out for itself.
  reg.on('onValidTarget', bindAT(AT.oneWithTheGloom, 11), (ev) => {
    if (!T.ctx) return;
    if (!T.mineKw(ev.target, STRIKING_SCORPION)) return;
    if (!effectOn(ev.state, ev.target.id, EFF.gloom)) return;
    if (ev.target.order !== 'conceal') return;
    if (gapBetween(T.ctx, ev.attacker, ev.target) <= 2 + 1e-6) return;
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, ev.target));
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'ONE WITH THE GLOOM: a Conceal-order STRIKING SCORPION in cover cannot be selected';
  });

  // Both "until the start of its next activation" techniques end exactly there.
  reg.on('onActivationStart', bindAT(AT.oneWithTheGloom, 9), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.operativeId === ev.operative.id && (e.rule === EFF.gloom || e.rule === EFF.ragingHeat));
  });

  // ---- MERCILESS STRIKES ---------------------------------------------------
  // "…the first time you strike with a critical success during that sequence. Until the end of
  //  that sequence, that operative's melee weapon has the Shock weapon rule."
  reg.on('onStrikeResolved', bindAT(AT.mercilessStrikes, 11), (ev) => {
    if (ev.ctx.type !== 'melee' || !ev.crit) return;
    const attacker = ev.ctx.attacker;
    if (!T.mineKw(attacker, STRIKING_SCORPION)) return;
    if (!declared(ev.state, attacker, EFF.merciless)) return;
    if (effectOn(ev.state, attacker.id, EFF.mercilessArmed)) return;
    effect(ev.state, {
      rule: EFF.mercilessArmed,
      source: { kind: 'ability', id: RULE_ASPECT_TECHNIQUES },
      sourceText: shortQuote(aspectTechnique(AT.mercilessStrikes).text),
      operativeId: attacker.id,
      player: T.player,
      data: { stamp: seqStamp(ev.state) },
      expiry: { kind: 'endOfActivation', operativeId: attacker.id },
    });
    log(ev.state, { kind: 'dice', player: T.player, text: `MERCILESS STRIKES: ${attacker.letter}'s weapon gains Shock` });
  });
  reg.on('onWeaponRules', bindAT(AT.mercilessStrikes, 12), (ev) => {
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, STRIKING_SCORPION)) return;
    const armed = effectOn(ev.state, ev.operative.id, EFF.mercilessArmed);
    if (!armed || armed.data?.['stamp'] !== seqStamp(ev.state)) return;
    ev.rules.push(ruleTag('Shock', undefined, 'Shock (MERCILESS STRIKES)'));
  });

  // ---- RAIN OF TEARS -------------------------------------------------------
  // "…after you strike with a critical success, if the enemy operative isn't incapacitated."
  // The trigger is inside `resolveFightDie`, so it is a real PendingDecision; "decline" is
  // listed first so the deterministic default is not to spend the technique.
  reg.on('onStrikeResolved', bindAT(AT.rainOfTears, 13), (ev) => {
    if (ev.ctx.type !== 'melee' || !ev.crit) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const me = ev.ctx.attacker;
    if (!T.mineKw(me, HOWLING_BANSHEE)) return;
    if (me.id !== seq.attackerId) return; // "is fighting", not retaliating
    if (ev.struck.incapacitated || ev.struck.removed) return;
    // The sequence has to still be running for "End that sequence" to be worth a technique.
    if (successes(seq.attackerPool).length + successes(seq.defenderPool).length === 0) return;
    if (!techniqueUsable(ev.state, me, AT.rainOfTears).ok) return;
    ev.state.pending.push({
      id: `bok-rain-${ev.state.seq++}`,
      who: T.player,
      kind: RAIN_DECISION,
      prompt: `RAIN OF TEARS: end the fight and Fall Back up to 3" with ${me.letter}?`,
      sourceText: shortQuote(aspectTechnique(AT.rainOfTears).text),
      optional: true,
      ctx: { operativeId: me.id },
      options: [
        { id: 'decline', label: 'Keep fighting' },
        { id: 'use', label: 'End the sequence and Fall Back up to 3"' },
      ],
    });
  });

  // ---- SCREAM-THAT-STEALS --------------------------------------------------
  // "…is fighting or retaliating, at the start of the Resolve Attack Dice step. You can resolve
  //  one of your successes before the normal order."  As the fight's attacker you already
  //  resolve first, so the window is only offered while RETALIATING — where no action channel
  //  exists.  "That success must be used to block" is unenforceable: the engine builds the
  //  strike/block options (the Bladed Stance / PREPARED DEFENCE precedent).
  reg.on('onCollectAttackDice', bindAT(AT.screamThatSteals, 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.turn !== 'attacker') return;
    const me = ev.ctx.attacker;
    if (me.id !== seq.defenderId) return; // retaliating
    if (!T.mineKw(me, HOWLING_BANSHEE)) return;
    if (!seq.defenderCanRetaliate) return;
    if (!techniqueUsable(ev.state, me, AT.screamThatSteals).ok) return;
    ev.state.pending.push({
      id: `bok-scream-${ev.state.seq++}`,
      who: T.player,
      kind: SCREAM_DECISION,
      prompt: `SCREAM-THAT-STEALS: resolve one of ${me.letter}'s successes before the normal order?`,
      sourceText: shortQuote(aspectTechnique(AT.screamThatSteals).text),
      optional: true,
      ctx: { operativeId: me.id },
      options: [
        { id: 'decline', label: 'Resolve in the normal order' },
        { id: 'use', label: 'Resolve one success first (it must be used to block)' },
      ],
    });
  });

  // ---- THE WOE / STRIKE AND FADE: remembering the kill ---------------------
  reg.on('onIncapacitated', bindAT(AT.theWoe, 14), (ev) => {
    if (ev.prevented) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const victim = ev.operative;
    if (victim.player === T.player) return;
    const killerId = victim.id === seq.defenderId ? seq.attackerId : seq.defenderId;
    const killer = ev.state.operatives[killerId];
    if (!killer || killer.player !== T.player) return;
    const mark = (rule: string): void => {
      if (effectOn(ev.state, killer.id, rule)) return;
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: RULE_ASPECT_TECHNIQUES },
        operativeId: killer.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: killer.id },
      });
    };
    // THE WOE: "after it's performed the Charge action and incapacitated an enemy operative
    // during the Fight action" — the killer must be the one fighting.
    if (T.kw(killer, HOWLING_BANSHEE) && killerId === seq.attackerId) mark(EFF.woeKill);
    // STRIKE AND FADE: the printed trigger is "while fighting or retaliating"; only the
    // fighting half has an action channel (reported).
    if (T.kw(killer, STRIKING_SCORPION) && killerId === seq.attackerId) mark(EFF.fadeKill);
  });

  // ---- Move-distance caps owned by ASPECT TECHNIQUES -----------------------
  reg.on('onMoveDistance', bindAT(AT.theWoe, 11), (ev) => {
    if (ev.action !== 'Charge' || !T.mineKw(ev.operative, HOWLING_BANSHEE)) return;
    // The only way a second Charge action happens in one activation is THE WOE.
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    ev.inches = Math.max(0, ev.inches - chargeInchesThisActivation(ev.state, ev.operative));
  });
  reg.on('onMoveDistance', bindAT(AT.rainOfTears, 11), (ev) => {
    if (ev.action !== 'Fall Back' || !T.mineKw(ev.operative, HOWLING_BANSHEE)) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.rainArmed)) return;
    ev.inches = Math.min(ev.inches, 3); // "a free Fall Back action up to 3""
  });

  // "During that action, that operative can move within control range of enemy operatives
  // (it cannot end the move there)." The action declares EFF.patientStalk before it validates
  // its path; the "cannot end the move there" half is the universal Reposition's own
  // `mustNotFinishEngaged`, which stays on.
  reg.on('onMovePermissions', bindAT(AT.patientStalk, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.patientStalk)) return;
    ev.mayEnterEnemyControlRange = true;
  });

  // ---- SHRIEK-THAT-KILLS: the granted weapon is gated to its own action ----
  reg.on('onSelectWeapon', bindAT(AT.shriekThatKills, 11), (ev) => {
    if (ev.ctx.weaponName !== SHRIEK_WEAPON.name) return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (declared(ev.state, ev.ctx.attacker, EFF.shriek)) return;
    ev.allowed = false;
    ev.reason = 'SHRIEK-THAT-KILLS has not been used for this action';
  });
  reg.on('onActivationEnd', bindAT(AT.shriekThatKills, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropShriek(ev.operative);
  });

  // ---- Defence Tactics (DIRE AVENGER EXARCH + WARRIOR) ---------------------
  // "Whenever this operative contests an objective marker or one of your mission markers, or
  //  whenever it's shooting an enemy operative that does, this operative's weapons have the
  //  Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(A.defenceTacticsWarrior, 15), (ev) => {
    if (!T.mineKw(ev.operative, DIRE_AVENGER)) return;
    if (!T.ctx) return;
    const contests = (o: OperativeState): boolean =>
      Object.values(ev.state.markers).some(
        (m) => (m.kind === 'objective' || m.owner === T.player) && markerContestedBy(T.ctx!, ev.state, m, o),
      );
    const shootingAContester = ev.type === 'ranged' && ev.target !== undefined && contests(ev.target);
    if (!contests(ev.operative) && !shootingAContester) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Defence Tactics)'));
  });

  // ---- Shimmershield (DIRE AVENGER EXARCH) --------------------------------
  // "Whenever an operative is shooting a friendly BLADES OF KHAINE operative that's visible to
  //  and within 2" of this operative, ignore the Piercing weapon rule."
  reg.on('onWeaponRules', T.bind(A.shimmershield, 16), (ev) => {
    if (ev.type !== 'ranged' || !ev.target || !T.ctx) return;
    if (!T.mineKw(ev.target, KW)) return;
    const index = terrain(T.ctx, ev.state);
    const shield = T.friendlies(ev.state).find(
      (o) =>
        hasShimmershield(ev.state, o) &&
        T.gap(o, ev.target!) <= 2 + 1e-6 &&
        isVisible(index, body(T.ctx!, o), body(T.ctx!, ev.target!)).visible,
    );
    if (!shield) return;
    if (!ev.rules.some((r) => r.id === 'Piercing' || r.id === 'PiercingCrits')) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing' && r.id !== 'PiercingCrits');
  });

  // ---- Banshee Mask (HOWLING BANSHEE EXARCH + WARRIOR) --------------------
  // "Whenever this operative is fighting, worsen the Hit stat of the enemy operative's melee
  //  weapons by 1. This isn't cumulative with being injured."
  reg.on('onStatMod', T.bind(A.bansheeMaskWarrior, 15), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (ev.operative.player === T.player) return;
    if (ev.operative.id !== seq.defenderId) return;
    const banshee = ev.state.operatives[seq.attackerId];
    if (!banshee || !T.mineKw(banshee, HOWLING_BANSHEE)) return;
    const card = T.card(ev.operative);
    if (card && ev.operative.wounds < card.wounds / 2) return; // not cumulative with injured
    ev.mods.hit -= 1;
  });

  // ---- Mandiblasters (STRIKING SCORPION EXARCH + WARRIOR) -----------------
  // "Whenever this operative performs the Fight action, at the start of the Roll Attack Dice
  //  step, you can use this rule. If you do, inflict 2 damage on the enemy operative in that
  //  sequence."  Free and strictly beneficial, so auto-used and logged (D-022).
  reg.on('onCollectAttackDice', T.bind(A.mandiblastersWarrior, 14), (ev) => {
    if (ev.ctx.type !== 'melee' || !T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const me = ev.ctx.attacker;
    if (me.id !== seq.attackerId || !T.mineKw(me, STRIKING_SCORPION)) return;
    const foe = ev.state.operatives[seq.defenderId];
    if (!foe || foe.removed || foe.incapacitated) return;
    const key = `blades-of-khaine.mandiblasters:${me.id}`;
    const stamp = seqStamp(ev.state);
    const store = (ev.state.opState['blades-of-khaine.once'] ?? {}) as Record<string, string>;
    ev.state.opState['blades-of-khaine.once'] = store;
    if (store[key] === stamp) return;
    store[key] = stamp;
    log(ev.state, { kind: 'action', player: T.player, text: `Mandiblasters: ${me.letter} inflicts 2 damage on ${foe.letter}` });
    inflictDamage(T.ctx, ev.state, foe, 2, 'other');
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- FOREWARNED (strategy) ----------------------------------------------
  // "Whenever an operative is shooting a ready friendly BLADES OF KHAINE operative, you can
  //  re-roll any of your defence dice results of one result (e.g. results of 2)."
  reg.on('onDefenceDice', T.bind(SP.forewarned, 20), (ev) => {
    if (!strategyPloyUsed(ev.state, T.player, SP.forewarned)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || !target.ready) return;
    ev.rerolls.push({
      id: 'blades-of-khaine.forewarned',
      label: 'FOREWARNED: re-roll any of your defence dice results of one result',
      mode: 'value',
      sourceText: shortQuote(text(SP.forewarned)),
      player: T.player,
    });
  });

  // ---- RUTHLESS POISE (strategy) ------------------------------------------
  // "Whenever a friendly BLADES OF KHAINE operative is fighting a ready enemy operative, that
  //  friendly operative's melee weapons have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(SP.ruthlessPoise, 20), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!strategyPloyUsed(ev.state, T.player, SP.ruthlessPoise)) return;
    if (!ev.target?.ready) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (RUTHLESS POISE)'));
  });

  // ---- KHAINE'S VENGEANCE (strategy) --------------------------------------
  reg.on('onWeaponRules', T.bind(SP.khainesVengeance, 20), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!strategyPloyUsed(ev.state, T.player, SP.khainesVengeance)) return;
    if (!ev.target?.expended) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, "Ceaseless (KHAINE'S VENGEANCE)"));
  });

  // ---- DANCE OF DEATH (strategy) ------------------------------------------
  // "Select two friendly BLADES OF KHAINE operatives visible to and within 6" of each other.
  //  Remove them both from the killzone and set them back up in each other's previous
  //  locations."  The pair comes from the gambit's `data`, with a deterministic logged default
  //  (docs/DECISIONS.md D-016).
  reg.on('onPloyUsed', T.bind(SP.danceOfDeath, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.danceOfDeath || !T.ctx) return;
    const pairs = dancePairs(T, ev.state);
    if (pairs.length === 0) {
      log(ev.state, { kind: 'ploy', player: T.player, text: 'DANCE OF DEATH: no eligible pair' });
      return;
    }
    const wantA = ev.data?.['operativeId'] ?? ev.data?.['operativeIdA'];
    const wantB = ev.data?.['operativeIdB'];
    const chosen =
      pairs.find((p) => p[0].id === wantA && p[1].id === wantB) ??
      pairs.find((p) => p[1].id === wantA && p[0].id === wantB) ??
      pairs[0]!;
    const [a, b] = chosen;
    const pos = { ...a.pos };
    const z = a.z;
    const rot = a.rot;
    a.pos = { ...b.pos };
    a.z = b.z;
    a.rot = b.rot;
    b.pos = pos;
    b.z = z;
    b.rot = rot;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `DANCE OF DEATH: ${a.letter} and ${b.letter} swap positions`,
      data: { operativeId: a.id, otherId: b.id },
    });
  });

  // ---- BLADEWIND / STARFALL / FADING LIGHT (firefight) ---------------------
  // "Use this firefight ploy during a friendly BLADES OF KHAINE operative's activation.
  //  During that activation, that operative can …" — "that operative" is the active one.
  const marksActive = (ployId: string, rule: string): void => {
    reg.on('onPloyUsed', T.bind(ployId, 20), (ev) => {
      if (ev.player !== T.player || ev.ployId !== ployId) return;
      const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
      if (!active || active.player !== T.player || !T.kw(active, KW)) return;
      if (effectOn(ev.state, active.id, rule)) return;
      effect(ev.state, {
        rule,
        source: { kind: 'ploy', id: ployId },
        sourceText: shortQuote(text(ployId)),
        operativeId: active.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: active.id },
      });
    });
  };
  marksActive(FP.bladewind, EFF.bladewind);
  marksActive(FP.starfall, EFF.starfall);
  marksActive(FP.fadingLight, EFF.fadingLight);

  // "During that activation, that operative can perform the Fall Back action for 1 less AP."
  reg.on('onActionCost', T.bind(FP.fadingLight, 20), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.fadingLight)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- CONTEMPT ------------------------------------------------------------
  // "Until the end of the sequence, your opponent cannot re-roll their attack dice."
  reg.on('onPloyUsed', T.bind(FP.contempt, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.contempt) return;
    effect(ev.state, {
      rule: EFF.contempt,
      source: { kind: 'ploy', id: FP.contempt },
      sourceText: shortQuote(text(FP.contempt)),
      player: T.player,
      data: { stamp: seqStamp(ev.state) },
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onRollAttack', T.bind(FP.contempt, 45), (ev) => {
    if (ev.ctx.attacker.player === T.player) return;
    const live = ev.state.effects.some(
      (e) => e.rule === EFF.contempt && e.player === T.player && e.data?.['stamp'] === seqStamp(ev.state),
    );
    if (!live) return;
    if (ev.rerolls.length === 0) return;
    ev.rerolls = [];
    log(ev.state, { kind: 'ploy', player: T.player, text: 'CONTEMPT: your opponent cannot re-roll their attack dice' });
  });
}

/** Every ordered pair of friendly operatives "visible to and within 6" of each other". */
function dancePairs(T: TeamHooks, state: GameState): [OperativeState, OperativeState][] {
  const out: [OperativeState, OperativeState][] = [];
  if (!T.ctx) return out;
  const index = terrain(T.ctx, state);
  const mine = T.friendlies(state, KW).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i]!;
      const b = mine[j]!;
      if (T.gap(a, b) > 6 + 1e-6) continue;
      if (!isVisible(index, body(T.ctx, a), body(T.ctx, b)).visible) continue;
      out.push([a, b]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- RUNE OF PROPHECY ----------------------------------------------------
  // "Once per battle, after rolling off to decide initiative, you can add D3 to, or subtract D3
  //  from, your result."  `initiativeRollModifiers` is emitted BEFORE the D6 is rolled, so the
  //  result is unknown: the deterministic policy (D-022) is to ADD D3 at the first Strategy
  //  phase roll-off from turning point 2 onwards, when initiative first has a price.
  reg.on('initiativeRollModifiers', T.bind(EQ.runeOfProphecy, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, EQ.runeOfProphecy)) return;
    if (ev.state.phase !== 'strategy' || ev.state.turningPoint < 2) return;
    if (!useOncePerBattle(ev.state, `blades-of-khaine.prophecy:${T.player}`)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'blades-of-khaine.prophecy', [d3], T.player, 'RUNE OF PROPHECY');
    ev.mod += d3;
    log(ev.state, { kind: 'dice', player: T.player, text: `RUNE OF PROPHECY: +${d3} to the initiative roll-off` });
  });

  // ---- RUNE OF SHIELDING ---------------------------------------------------
  // "Once per battle, when an attack dice inflicts Normal Dmg on a friendly BLADES OF KHAINE
  //  operative, you can ignore that inflicted damage."  Auto-used (D-022) when it saves the
  //  operative from being incapacitated, or on a Normal Dmg of 4 or more.
  reg.on('onDamage', T.bind(EQ.runeOfShielding, 30), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!T.mineKw(ev.target, KW)) return;
    if (!hasEquipment(ev.state, T.player, EQ.runeOfShielding)) return;
    if (usedThisBattle(ev.state, `blades-of-khaine.shielding:${T.player}`)) return;
    const normal = normalDmgInFlight(ev.state, ev.target);
    if (normal === undefined || normal <= 0 || normal > ev.amount) return;
    const killing = ev.target.wounds - ev.amount <= 0;
    if (!killing && normal < 4) return;
    if (!useOncePerBattle(ev.state, `blades-of-khaine.shielding:${T.player}`)) return;
    ev.amount -= normal;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `RUNE OF SHIELDING: ${ev.target.letter} ignores ${normal} damage from one attack dice`,
    });
  });

  // ---- RUNE OF FORESIGHT ---------------------------------------------------
  // "When this equipment is revealed, roll one D3. In the Strategy phase of the turning point
  //  equal to the result, you gain 1 additional CP."
  reg.on('onSelectEquipment', T.bind(EQ.runeOfForesight, 30), (ev) => {
    if (ev.player !== T.player || !ev.equipment.includes(EQ.runeOfForesight)) return;
    const store = (ev.state.opState['blades-of-khaine.foresight'] ?? {}) as Record<string, number>;
    ev.state.opState['blades-of-khaine.foresight'] = store;
    if (store[T.player] !== undefined) return;
    const roll = T.ctx ? T.ctx.rng.d3() : 1;
    store[T.player] = roll;
    recordRoll(ev.state, 'blades-of-khaine.foresight', [roll], T.player, 'RUNE OF FORESIGHT');
    log(ev.state, { kind: 'system', player: T.player, text: `RUNE OF FORESIGHT: +1CP in turning point ${roll}` });
  });
  reg.on('onReadyStep', T.bind(EQ.runeOfForesight, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.runeOfForesight)) return;
    const store = (ev.state.opState['blades-of-khaine.foresight'] ?? {}) as Record<string, number>;
    if (store[T.player] !== ev.state.turningPoint) return;
    ev.cp += 1;
    log(ev.state, { kind: 'system', player: T.player, text: 'RUNE OF FORESIGHT: +1CP' });
  });

  // ---- WRAITHBONE TALISMAN -------------------------------------------------
  // "Once per turning point, when a friendly BLADES OF KHAINE operative is shooting, fighting
  //  or retaliating, if you roll two or more fails, you can discard one of them to retain
  //  another as a normal success instead."
  //
  // `fight.ts` emits no post-roll hook (D-031), but BOTH sequences read `onWeaponRules` at
  // their Retention step — after the dice are rolled and after every re-roll — so that emit is
  // the one moment the printed rule's three modes share. Free and strictly beneficial, so it is
  // auto-used and logged (D-022).
  reg.on('onWeaponRules', T.bind(EQ.wraithboneTalisman, 31), (ev) => {
    const seq = ev.state.sequence;
    if (!seq || seq.step !== 'retention') return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!hasEquipment(ev.state, T.player, EQ.wraithboneTalisman)) return;
    if (usedThisTP(ev.state, `blades-of-khaine.talisman:${T.player}`)) return;
    let pool: DicePool;
    if (seq.kind === 'shoot') {
      if (ev.operative.id !== seq.attackerId) return;
      pool = seq.attack;
    } else {
      pool = ev.retaliating ? seq.defenderPool : seq.attackerPool;
    }
    if (pool.dice.filter((d) => d.state === 'fail').length < 2) return;
    if (!discardFailForNormal(pool, 'WRAITHBONE TALISMAN')) return;
    useOncePerTP(ev.state, `blades-of-khaine.talisman:${T.player}`);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `WRAITHBONE TALISMAN: ${ev.operative.letter} retains a fail as a normal success`,
    });
  });
}

/**
 * The Normal Dmg one attack dice is inflicting inside the sequence in flight. A fight resolves
 * one die at a time, so the amount IS the die's; a shoot aggregates every unblocked dice, so
 * one Normal Dmg is deducted from the total when at least one normal success is unblocked.
 */
function normalDmgInFlight(state: GameState, target: OperativeState): number | undefined {
  const shoot = shootSeq(state);
  if (shoot) {
    if (shoot.targetId !== target.id) return undefined;
    const normals = shoot.attack.dice.filter((d) => d.state === 'normal').length;
    if (normals === 0) return undefined;
    const card = catalogueCard(state.operatives[shoot.attackerId]?.datacardId ?? '');
    const weapon = card?.weapons.find((w) => w.name === shoot.weaponName);
    const profile = weapon?.profiles.find((p) => (p.name ?? '') === (shoot.profileName ?? '')) ?? weapon?.profiles[0];
    return profile?.dmgN;
  }
  const fight = fightSeq(state);
  if (!fight) return undefined;
  const side = fight.turn;
  const attackerId = side === 'attacker' ? fight.attackerId : fight.defenderId;
  if (attackerId === target.id) return undefined;
  const card = catalogueCard(state.operatives[attackerId]?.datacardId ?? '');
  const name = side === 'attacker' ? fight.attackerWeapon : (fight.defenderWeapon ?? '');
  const weapon = card?.weapons.find((w) => w.name === name);
  return weapon?.profiles.find((p) => p.type === 'melee')?.dmgN;
}

// ---------------------------------------------------------------------------
// Decision handler (RAIN OF TEARS, SCREAM-THAT-STEALS)
// ---------------------------------------------------------------------------

function decisionHandler(
  _ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
): boolean {
  if (decision.kind === RAIN_DECISION) {
    if (optionId !== 'use') return true;
    const op = state.operatives[String(decision.ctx?.['operativeId'] ?? '')];
    const seq = fightSeq(state);
    if (!op || !seq) return true;
    if (!techniqueUsable(state, op, AT.rainOfTears).ok) return true;
    claimTechnique(state, op, AT.rainOfTears);
    // "End that sequence (any remaining attack dice are discarded)."
    for (const pool of [seq.attackerPool, seq.defenderPool]) {
      for (const die of pool.dice) {
        if (die.state === 'crit' || die.state === 'normal') {
          die.state = 'discarded';
          die.note = 'RAIN OF TEARS';
        }
      }
    }
    seq.step = 'done';
    effect(state, {
      rule: EFF.rainArmed,
      source: { kind: 'ability', id: RULE_ASPECT_TECHNIQUES },
      sourceText: shortQuote(aspectTechnique(AT.rainOfTears).text),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(state, {
      kind: 'action',
      player: op.player,
      text: `RAIN OF TEARS: the fight ends and ${op.letter} can Fall Back up to 3"`,
    });
    return true;
  }
  if (decision.kind === SCREAM_DECISION) {
    if (optionId !== 'use') return true;
    const op = state.operatives[String(decision.ctx?.['operativeId'] ?? '')];
    const seq = fightSeq(state);
    if (!op || !seq) return true;
    if (!techniqueUsable(state, op, AT.screamThatSteals).ok) return true;
    claimTechnique(state, op, AT.screamThatSteals);
    seq.turn = 'defender';
    log(state, {
      kind: 'action',
      player: op.player,
      text: `SCREAM-THAT-STEALS: ${op.letter} resolves one success before the normal order`,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const isBoK = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);
const hasAspect = (ctx: GameContext, op: OperativeState, aspect: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(aspect);
const countAction = (op: OperativeState, id: string): number =>
  op.actionsThisActivation.filter((a) => a === id).length;

export const SHOOT_SLICING = 'Shoot (The Slicing Hurricane)';
export const SHOOT_THOUSAND = 'Shoot (Death of a Thousand Blades)';
export const SHOOT_VIGILANCE = 'Shoot (Vigilance of the Avenger)';
export const SHOOT_SHRIEK = 'Shoot (Shriek-that-kills)';
export const SHOOT_SCORPIONS_EYE = "Shoot (Scorpion's Eye)";
export const FIGHT_MERCILESS = 'Fight (Merciless Strikes)';
export const REPOSITION_PATIENT_STALK = 'Reposition (Patient Stalk, Sudden Blow)';
export const CHARGE_WOE = 'Charge (The Woe)';
export const FALL_BACK_RAIN = 'Fall Back (Rain of Tears)';
export const DASH_STRIKE_AND_FADE = 'Dash (Strike and Fade)';
export const DECLARE_RAGING_HEAT = 'Aspect Technique (Raging Heat of the Dying Flame)';
export const DECLARE_ONE_WITH_THE_GLOOM = 'Aspect Technique (One with the Gloom)';
export const SHOOT_EXARCH = 'Shoot (Exarch)';
export const FIGHT_EXARCH = 'Fight (Exarch)';
export const SHOOT_STARFALL = 'Shoot (Starfall)';
export const FIGHT_BLADEWIND = 'Fight (Bladewind)';

/** A Shoot action that also declares an ASPECT TECHNIQUE (docs/DECISIONS.md D-021). */
function techniqueShoot(spec: {
  id: string;
  technique: string;
  aspect: string;
  weapons: string[];
  effectRule: string;
  ap?: number;
  extraCheck?: (ctx: GameContext, state: GameState, op: OperativeState) => { ok: boolean; reason?: string };
}): ActionDef {
  const tech = aspectTechnique(spec.technique);
  return {
    id: spec.id,
    name: spec.id,
    ap: spec.ap ?? 1,
    type: 'unique',
    treatedAs: 'Shoot',
    sourceText: `${tech.name}: ${tech.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, _state, op) => isBoK(ctx, op) && hasAspect(ctx, op, spec.aspect),
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, spec.technique);
      if (!usable.ok) return usable;
      if (!isWeapon(params.weaponName, spec.weapons))
        return { ok: false, reason: `${tech.name} requires ${spec.weapons.join(' or ')}` };
      const extra = spec.extraCheck?.(ctx, state, op);
      if (extra && !extra.ok) return extra;
      return getAction('Shoot')!.check(ctx, state, op, params);
    },
    perform(ctx, state, op, params) {
      declare(state, op, spec.technique, spec.effectRule);
      return getAction('Shoot')!.perform(ctx, state, op, params);
    },
  };
}

function actions(): ActionDef[] {
  const defs: ActionDef[] = [];

  // THE SLICING HURRICANE — "That operative can perform the Shoot action during that action",
  // so the shot costs no additional AP. The interleave itself is not modelled: the Shoot lands
  // after the whole Reposition rather than in the middle of it (reported).
  defs.push(
    techniqueShoot({
      id: SHOOT_SLICING,
      technique: AT.slicingHurricane,
      aspect: DIRE_AVENGER,
      weapons: SLICING_WEAPONS,
      effectRule: EFF.slicingHurricane,
      ap: 0,
      extraCheck: (_ctx, _state, op) =>
        op.actionsThisActivation.includes('Reposition')
          ? { ok: true }
          : { ok: false, reason: 'THE SLICING HURRICANE is performed during the Reposition action' },
    }),
  );
  defs.push(
    techniqueShoot({
      id: SHOOT_THOUSAND,
      technique: AT.thousandBlades,
      aspect: DIRE_AVENGER,
      weapons: SHURIKEN_CATAPULTS,
      effectRule: EFF.thousandBlades,
    }),
  );
  defs.push(
    techniqueShoot({
      id: SHOOT_VIGILANCE,
      technique: AT.vigilance,
      aspect: DIRE_AVENGER,
      weapons: SHURIKEN_CATAPULTS,
      effectRule: EFF.vigilance,
    }),
  );
  defs.push(
    techniqueShoot({
      id: SHOOT_SCORPIONS_EYE,
      technique: AT.scorpionsEye,
      aspect: STRIKING_SCORPION,
      weapons: ['shuriken pistol'],
      effectRule: EFF.scorpionsEye,
    }),
  );

  // SHRIEK-THAT-KILLS grants a weapon that is not on any datacard, so the target check is run
  // against the granted profile here rather than through the universal Shoot's weapon gate
  // (which refuses it until the technique has been declared).
  const shriekTech = aspectTechnique(AT.shriekThatKills);
  defs.push({
    id: SHOOT_SHRIEK,
    name: SHOOT_SHRIEK,
    ap: 1,
    type: 'unique',
    treatedAs: 'Shoot',
    sourceText: `${shriekTech.name}: ${shriekTech.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, _state, op) => isBoK(ctx, op) && hasAspect(ctx, op, HOWLING_BANSHEE),
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, AT.shriekThatKills);
      if (!usable.ok) return usable;
      if (op.order === 'conceal') return { ok: false, reason: 'cannot Shoot with a Conceal order' };
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      const target = params.targetId ? state.operatives[params.targetId] : undefined;
      if (!target || target.removed) return { ok: false, reason: 'weapon and target required' };
      const profile = SHRIEK_WEAPON.profiles[0]!;
      const rules = effectiveRules(ctx, state, profile, {
        operative: op,
        target,
        weaponName: SHRIEK_WEAPON.name,
      });
      const chk = checkTarget(ctx, state, op, target, profile, rules);
      return chk.valid ? { ok: true } : { ok: false, reason: chk.reason ?? 'not a valid target' };
    },
    perform(ctx, state, op, params) {
      declare(state, op, AT.shriekThatKills, EFF.shriek);
      grantShriek(op);
      return getAction('Shoot')!.perform(ctx, state, op, { ...params, weaponName: SHRIEK_WEAPON.name });
    },
  });

  // MERCILESS STRIKES — a Fight action that declares the technique.
  const merciless = aspectTechnique(AT.mercilessStrikes);
  defs.push({
    id: FIGHT_MERCILESS,
    name: FIGHT_MERCILESS,
    ap: 1,
    type: 'unique',
    treatedAs: 'Fight',
    sourceText: `${merciless.name}: ${merciless.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, _state, op) => isBoK(ctx, op) && hasAspect(ctx, op, STRIKING_SCORPION),
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, AT.mercilessStrikes);
      if (!usable.ok) return usable;
      return getAction('Fight')!.check(ctx, state, op, params);
    },
    perform(ctx, state, op, params) {
      declare(state, op, AT.mercilessStrikes, EFF.merciless);
      return getAction('Fight')!.perform(ctx, state, op, params);
    },
  });

  // PATIENT STALK, SUDDEN BLOW — a Conceal-order Reposition that ends with D3+2 damage on one
  // enemy operative the move passed within control range of. "During that action, that
  // operative can move within control range of enemy operatives (it cannot end the move
  // there)": that permission used to need no code, because `validateMove` tested only the end
  // of a path. It is now granted through `onMovePermissions`, keyed on an effect the action
  // declares before it delegates.
  const stalk = aspectTechnique(AT.patientStalk);
  defs.push({
    id: REPOSITION_PATIENT_STALK,
    name: REPOSITION_PATIENT_STALK,
    ap: 1,
    type: 'unique',
    treatedAs: 'Reposition',
    sourceText: `${stalk.name}: ${stalk.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, _state, op) => isBoK(ctx, op) && hasAspect(ctx, op, STRIKING_SCORPION),
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, AT.patientStalk);
      if (!usable.ok) return usable;
      if (op.order !== 'conceal') return { ok: false, reason: 'this operative must have a Conceal order' };
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, {
        action: 'Reposition',
        mustNotFinishEngaged: true,
        mayEnterEnemyControlRange: true,
      });
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform(ctx, state, op, params) {
      // Declared BEFORE the move is validated: `onMovePermissions` reads this effect to grant
      // "that operative can move within control range of enemy operatives".
      declare(state, op, AT.patientStalk, EFF.patientStalk);
      const path = params.path;
      const validated = path
        ? validateMove(ctx, state, op, path, {
            action: 'Reposition',
            mustNotFinishEngaged: true,
            mayEnterEnemyControlRange: true,
          })
        : undefined;
      const legs = validated?.ok ? validated.legs : [];
      const moved = getAction('Reposition')!.perform(ctx, state, op, params);
      if (!moved.ok) return moved;
      const passed = enemiesPassed(ctx, state, op, legs);
      if (passed.length === 0) {
        log(state, {
          kind: 'action',
          player: op.player,
          text: 'PATIENT STALK, SUDDEN BLOW: the move passed no enemy control range',
        });
        return { ok: true };
      }
      const victim = chosenOperative(state, { operativeId: params.targetOperativeId ?? params.targetId }, passed)!;
      const d3 = ctx.rng.d3();
      recordRoll(state, 'blades-of-khaine.patientStalk', [d3], op.player, 'PATIENT STALK, SUDDEN BLOW D3+2');
      log(state, {
        kind: 'action',
        player: op.player,
        text: `PATIENT STALK, SUDDEN BLOW: ${op.letter} inflicts ${d3 + 2} damage on ${victim.letter}`,
      });
      inflictDamage(ctx, state, victim, d3 + 2, 'other');
      return { ok: true };
    },
  });

  // THE WOE — the second Charge action of an activation, using what is left of the first one's
  // move distance. Its own action id, because the printed rule says "That operative can perform
  // two Charge actions during its activation to do so".
  const woe = aspectTechnique(AT.theWoe);
  defs.push({
    id: CHARGE_WOE,
    name: CHARGE_WOE,
    ap: 0,
    type: 'unique',
    sourceText: `${woe.name}: ${woe.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, state, op) =>
      isBoK(ctx, op) && hasAspect(ctx, op, HOWLING_BANSHEE) && effectOn(state, op.id, EFF.woeKill) !== undefined,
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, AT.theWoe);
      if (!usable.ok) return usable;
      if (!effectOn(state, op.id, EFF.woeKill))
        return { ok: false, reason: 'it must have incapacitated an enemy operative during the Fight action' };
      const done = op.actionsThisActivation;
      if (done.length !== 2 || !done.includes('Charge') || !done.includes('Fight'))
        return { ok: false, reason: 'the operative cannot have performed any other actions during this activation' };
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'it must no longer be within control range of enemy operatives' };
      return getAction('Charge')!.check(ctx, state, op, params);
    },
    perform(ctx, state, op, params) {
      claimTechnique(state, op, AT.theWoe);
      return getAction('Charge')!.perform(ctx, state, op, params);
    },
  });

  // RAIN OF TEARS — the free Fall Back the mid-fight decision arms. "That operative can do so
  // even if it's performed an action that prevents it from performing the Fall Back action",
  // so the universal action's own restrictions are deliberately not delegated to.
  const rain = aspectTechnique(AT.rainOfTears);
  defs.push({
    id: FALL_BACK_RAIN,
    name: FALL_BACK_RAIN,
    ap: 0,
    type: 'unique',
    sourceText: `${rain.name}: ${rain.text.replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, state, op) => effectOn(state, op.id, EFF.rainArmed) !== undefined,
    check(ctx, state, op, params) {
      if (!effectOn(state, op.id, EFF.rainArmed)) return { ok: false, reason: 'RAIN OF TEARS has not been used' };
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, {
        action: 'Fall Back',
        mayEnterEnemyControlRange: true,
        mustNotFinishEngaged: true,
      });
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform(ctx, state, op, params) {
      const r = getAction('Fall Back')!.perform(ctx, state, op, params);
      if (!r.ok) return r;
      dropEffects(state, (e) => e.rule === EFF.rainArmed && e.operativeId === op.id);
      return r;
    },
  });

  // STRIKE AND FADE — "Change that friendly operative's order to Conceal and it can immediately
  // perform a free Dash action, even if it's performed an action that prevents it".
  const fade = aspectTechnique(AT.strikeAndFade);
  defs.push({
    id: DASH_STRIKE_AND_FADE,
    name: DASH_STRIKE_AND_FADE,
    ap: 0,
    type: 'unique',
    sourceText: `${fade.name}: ${fade.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, state, op) =>
      isBoK(ctx, op) && hasAspect(ctx, op, STRIKING_SCORPION) && effectOn(state, op.id, EFF.fadeKill) !== undefined,
    check(ctx, state, op, params) {
      const usable = techniqueUsable(state, op, AT.strikeAndFade);
      if (!usable.ok) return usable;
      if (!effectOn(state, op.id, EFF.fadeKill))
        return { ok: false, reason: 'it must have incapacitated an enemy operative while fighting' };
      const near = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1').some(
        (e) => gapBetween(ctx, op, e) <= 3 + 1e-6,
      );
      if (near) return { ok: false, reason: 'it must no longer be within 3" of enemy operatives' };
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, {
        action: 'Dash',
        noClimb: true,
        mustNotFinishEngaged: true,
      });
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform(ctx, state, op, params) {
      claimTechnique(state, op, AT.strikeAndFade);
      op.order = 'conceal';
      dropEffects(state, (e) => e.rule === EFF.fadeKill && e.operativeId === op.id);
      log(state, { kind: 'action', player: op.player, text: `STRIKE AND FADE: ${op.letter} changes its order to Conceal` });
      return getAction('Dash')!.perform(ctx, state, op, params);
    },
  });

  // The two techniques that modify no single action are 0AP declarations.
  const declaration = (id: string, techniqueId: string, aspect: string, rule: string): ActionDef => {
    const tech = aspectTechnique(techniqueId);
    return {
      id,
      name: id,
      ap: 0,
      type: 'unique',
      sourceText: `${tech.name}: ${tech.text.replace(/\s+/g, ' ').trim()}`,
      available: (ctx, state, op) =>
        isBoK(ctx, op) && hasAspect(ctx, op, aspect) && effectOn(state, op.id, rule) === undefined,
      check(_ctx, state, op) {
        const usable = techniqueUsable(state, op, techniqueId);
        if (!usable.ok) return usable;
        if (effectOn(state, op.id, rule)) return { ok: false, reason: `${tech.name} is already in effect` };
        return { ok: true };
      },
      perform(_ctx, state, op) {
        claimTechnique(state, op, techniqueId);
        effect(state, {
          rule,
          source: { kind: 'ability', id: RULE_ASPECT_TECHNIQUES },
          sourceText: shortQuote(tech.text),
          operativeId: op.id,
          player: op.player,
          // "Until the start of that operative's next activation" — cleared exactly there by
          // `onActivationStart`; this expiry is the backstop.
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        return { ok: true };
      },
    };
  };
  defs.push(declaration(DECLARE_RAGING_HEAT, AT.ragingHeat, DIRE_AVENGER, EFF.ragingHeat));
  defs.push(declaration(DECLARE_ONE_WITH_THE_GLOOM, AT.oneWithTheGloom, STRIKING_SCORPION, EFF.gloom));

  // ---- Exarch, BLADEWIND and STARFALL: the second Shoot / Fight ------------
  const secondShoot = (id: string, sourceText: string, gate: (state: GameState, op: OperativeState) => boolean): ActionDef => ({
    id,
    name: id,
    ap: 1,
    type: 'unique',
    treatedAs: 'Shoot',
    sourceText,
    available: (ctx, state, op) => isBoK(ctx, op) && gate(state, op),
    check(ctx, state, op, params) {
      if (!gate(state, op)) return { ok: false, reason: 'this operative cannot perform two Shoot actions' };
      if (countAction(op, 'Fight') > 0) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
      if (countAction(op, 'Shoot') !== 1) return { ok: false, reason: 'this is the second Shoot action of an activation' };
      // The granted Shriek-that-kills is withdrawn by `clearActionGrants` below, so accepting
      // it here would be a `check` the `perform` could not honour (docs/DECISIONS.md D-026).
      if (params.weaponName === SHRIEK_WEAPON.name)
        return { ok: false, reason: 'SHRIEK-THAT-KILLS lasts only until the end of its own action' };
      return getAction('Shoot')!.check(ctx, state, op, params);
    },
    perform(ctx, state, op, params) {
      // The first Shoot's ASPECT TECHNIQUE grant was "until the end of that action".
      clearActionGrants(state, op);
      return getAction('Shoot')!.perform(ctx, state, op, params);
    },
  });
  const secondFight = (id: string, sourceText: string, gate: (state: GameState, op: OperativeState) => boolean): ActionDef => ({
    id,
    name: id,
    ap: 1,
    type: 'unique',
    treatedAs: 'Fight',
    sourceText,
    available: (ctx, state, op) => isBoK(ctx, op) && gate(state, op),
    check(ctx, state, op, params) {
      if (!gate(state, op)) return { ok: false, reason: 'this operative cannot perform two Fight actions' };
      if (countAction(op, 'Shoot') > 0) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
      if (countAction(op, 'Fight') !== 1) return { ok: false, reason: 'this is the second Fight action of an activation' };
      return getAction('Fight')!.check(ctx, state, op, params);
    },
    perform(ctx, state, op, params) {
      clearActionGrants(state, op);
      return getAction('Fight')!.perform(ctx, state, op, params);
    },
  });

  const exarchText = abilityText(C.direAvengerExarch, A.exarchDireAvenger);
  const isExarch = (_state: GameState, op: OperativeState): boolean =>
    (catalogueCard(op.datacardId)?.keywords ?? []).includes('EXARCH');
  defs.push(secondShoot(SHOOT_EXARCH, exarchText, isExarch));
  defs.push(secondFight(FIGHT_EXARCH, exarchText, isExarch));
  defs.push(
    secondShoot(SHOOT_STARFALL, text(FP.starfall), (state, op) => effectOn(state, op.id, EFF.starfall) !== undefined),
  );
  defs.push(
    secondFight(FIGHT_BLADEWIND, text(FP.bladewind), (state, op) => effectOn(state, op.id, EFF.bladewind) !== undefined),
  );

  return defs;
}

// ---------------------------------------------------------------------------

export const bladesOfKhaine = defineTeam({
  id: 'blades-of-khaine',
  rules: (reg, T) => {
    rules(reg, T);
    // The team owns two decision kinds (RAIN OF TEARS, SCREAM-THAT-STEALS); the handler is
    // installed once per GameContext — `decisionHandler` is a stable reference.
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during a friendly BLADES OF KHAINE operative's activation."
    [FP.bladewind]: (state, player) => activationOf(state, player),
    [FP.starfall]: (state, player) => activationOf(state, player),
    [FP.fadingLight]: (state, player) => activationOf(state, player),
    // "Use this firefight ploy when a friendly BLADES OF KHAINE operative is retaliating or an
    //  enemy operative is shooting it, after your opponent rolls their attack dice."
    [FP.contempt]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind === 'shoot' && seq.defender === player) return { ok: true };
      if (seq?.kind === 'fight' && seq.defender === player) return { ok: true };
      return { ok: false, reason: 'no friendly operative is being shot at or retaliating' };
    },
  },
  aiHints: {
    roles: {
      [C.direAvengerExarch]: 'leader',
      [C.direAvengerWarrior]: 'gunner',
      [C.howlingBansheeExarch]: 'leader',
      [C.howlingBansheeWarrior]: 'melee',
      [C.strikingScorpionExarch]: 'leader',
      [C.strikingScorpionWarrior]: 'melee',
    },
    ployValue: {
      [SP.forewarned]: 0.5,
      [SP.ruthlessPoise]: 0.6,
      [SP.khainesVengeance]: 0.6,
      [SP.danceOfDeath]: 0.3,
      [FP.bladewind]: 0.6,
      [FP.starfall]: 0.6,
      [FP.fadingLight]: 0.3,
      [FP.contempt]: 0.5,
    },
    equipmentValue: {
      [EQ.runeOfProphecy]: 0.3,
      [EQ.runeOfShielding]: 0.5,
      [EQ.runeOfForesight]: 0.4,
      [EQ.wraithboneTalisman]: 0.6,
    },
  },
});

function activationOf(state: GameState, player: PlayerId): { ok: boolean; reason?: string } {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return active && active.player === player
    ? { ok: true }
    : { ok: false, reason: 'use this ploy during a friendly operative’s activation' };
}

export default bladesOfKhaine;
