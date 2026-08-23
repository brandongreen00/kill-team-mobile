/**
 * GELLERPOX INFECTED. https://wahapedia.ru/kill-team3/kill-teams/gellerpox-infected/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read out of `data/teams/gellerpox-infected.json` and never retyped (CLAUDE.md: rules as data).
 *
 * Four faction rules, and three of them are shapes this tree already has a precedent for:
 *
 *  - **Techno-Curse** is a MENU of three curses with no ids of their own, so each curse's
 *    heading, infection range and symptom are sliced out of that one printed string at module
 *    load (`CURSE`) — the Warpcoven BOONS / Legionary Marks of Chaos treatment. The choice is
 *    printed as MANDATORY ("select one TECHNO-CURSE … for the battle") and the Select Operatives
 *    step has no decision channel, so the pure setter `setTechnoCurse` (D-017) owns it for the UI
 *    and a deterministic, LOGGED default (Barrelwarp) is taken at the first friendly deploy —
 *    D-016's shape, because "no curse at all" is not a legal state and leaving it unset would
 *    switch the team's whole faction rule off in every AI-driven game.
 *
 *  - **Mutoid Vermin** is the Spectre Squad's Expendable shape: the action ban, the Fall Back
 *    discount and the marker-contest ban are live; the op-scoring clauses belong to
 *    `src/core/ops/**`. Its "having only MUTOID VERMIN operatives within their control range
 *    doesn't prevent enemy operatives from performing the Charge, Dash and Reposition action"
 *    is three `treatedAs` ActionDefs the ENEMY may use (D-021) — without them a 2-wound grub
 *    would lock a whole kill team down, which is the exact opposite of the printed rule.
 *
 *  - **Nightmare Hulks** is the Ratlings Brute cover give-back plus the Ratlings Slow-witted
 *    AP surcharge, verbatim in both cases.
 *
 *  - **Revoltingly Resilient** is the Raveners Reinforced Carapace read: a fight strike IS one
 *    attack dice, a shoot's aggregated total is reduced once per unblocked attack dice.
 *
 * Rare weapon rules: `Engineered`, `Feast` and `Swipe` — all three resolve through
 * `rareRuleTextFor` (D-033) to this team's own datacard abilities, which is where the shared
 * registry sourced them from, so the registry and the team agree.
 *
 * Data problems, reported loudly in docs/TEAM-STATUS.md: the MUTOID VERMIN selection group is
 * scraped with `count: 1` where the equipment prints "add **four**", the printed `custom`
 * gate ("If you selected the MUTOID VERMIN faction equipment:") is the one constraint kind the
 * shared validator cannot express, and `markerGuide` is empty although Spread the Glorious
 * Gifts places a printed "Techno-curse token".
 */
import { allActions, getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits } from '../../core/dice.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  inControlRange,
  inflictDamage,
  isWounded,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import type { Datacard, GameState, OperativeState, PlayerId, WeaponProfile } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  hasEquipment,
  ruleTag,
  shortQuote,
  usedThisBattle,
  useOncePerBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('gellerpox-infected');
export const KW = 'GELLERPOX INFECTED';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
export const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

export const RULE = {
  technoCurse: 'gellerpox-infected.rule.techno-curse',
  mutoidVermin: 'gellerpox-infected.rule.mutoid-vermin',
  nightmareHulks: 'gellerpox-infected.rule.nightmare-hulks',
  revoltinglyResilient: 'gellerpox-infected.rule.revoltingly-resilient',
} as const;

export const CARD = {
  vulgrar: 'gellerpox-infected.vulgrar-thrice-cursed',
  bloatspawn: 'gellerpox-infected.bloatspawn',
  fleshscreamer: 'gellerpox-infected.fleshscreamer',
  lumberghast: 'gellerpox-infected.lumberghast',
  mutant: 'gellerpox-infected.mutant',
  glitchling: 'gellerpox-infected.glitchling',
  cursemite: 'gellerpox-infected.cursemite',
  eyestinger: 'gellerpox-infected.eyestinger-swarm',
  sludgeGrub: 'gellerpox-infected.sludge-grub',
} as const;

export const AB = {
  spreadTheGifts: 'gellerpox-infected.vulgrar-thrice-cursed.spread-the-glorious-gifts',
  engineered: 'gellerpox-infected.vulgrar-thrice-cursed.engineered',
  tentacledGrasp: 'gellerpox-infected.bloatspawn.tentacled-grasp',
  swipe: 'gellerpox-infected.bloatspawn.swipe',
  horrifyingShrieking: 'gellerpox-infected.fleshscreamer.horrifying-shrieking',
  spikedCharger: 'gellerpox-infected.lumberghast.spiked-charger',
  mutantGroupActivation: 'gellerpox-infected.mutant.group-activation',
  gellercaustMasks: 'gellerpox-infected.mutant.gellercaust-masks',
  daemonic: 'gellerpox-infected.glitchling.daemonic',
  small: 'gellerpox-infected.glitchling.small',
  glitchlingGroupActivation: 'gellerpox-infected.glitchling.group-activation',
  cursemiteGroupActivation: 'gellerpox-infected.cursemite.group-activation',
  feast: 'gellerpox-infected.cursemite.feast',
  eyestingerGroupActivation: 'gellerpox-infected.eyestinger-swarm.group-activation',
  sludgeGrubGroupActivation: 'gellerpox-infected.sludge-grub.group-activation',
  causticDemise: 'gellerpox-infected.sludge-grub.caustic-demise',
} as const;

export const SP = {
  plagueriddenDetermination: 'gellerpox-infected.sp.plagueridden-determination',
  drawnToTheHum: 'gellerpox-infected.sp.drawn-to-the-hum',
  blessingsOfInfection: 'gellerpox-infected.sp.blessings-of-infection',
  rustEmanations: 'gellerpox-infected.sp.rust-emanations',
} as const;

export const FP = {
  revoltingTechnology: 'gellerpox-infected.fp.revolting-technology',
  putrescentDemise: 'gellerpox-infected.fp.putrescent-demise',
  barge: 'gellerpox-infected.fp.barge',
  frighteningOnslaught: 'gellerpox-infected.fp.frightening-onslaught',
} as const;

export const EQ = {
  mutoidVermin: 'gellerpox-infected.eq.mutoid-vermin',
  mutatedSymptoms: 'gellerpox-infected.eq.mutated-symptoms',
  pollutedStockpile: 'gellerpox-infected.eq.polluted-stockpile',
  plagueBellows: 'gellerpox-infected.eq.plague-bellows',
} as const;

/** The one extra STRATEGIC GAMBIT this team offers beyond its four strategy ploys. */
export const SPREAD_GAMBIT = 'gellerpox-infected.gambit.spread-the-glorious-gifts';

/** Extra `ActionDef`s a rule grants that a universal action forbids (D-021). */
export const FIGHT_SWIPE = ['Fight (Swipe)', 'Fight (Swipe 2)', 'Fight (Swipe 3)', 'Fight (Swipe 4)'] as const;
export const FIGHT_ONSLAUGHT = 'Fight (Frightening Onslaught)';
export const REPOSITION_BARGE = 'Reposition (Barge)';
export const CHARGE_BARGE = 'Charge (Barge)';
export const VERMIN_REPOSITION = 'Reposition (ignoring Mutoid Vermin)';
export const VERMIN_DASH = 'Dash (ignoring Mutoid Vermin)';
export const VERMIN_CHARGE = 'Charge (ignoring Mutoid Vermin)';

/**
 * The `ActionDef`s this module registers on top of the universal ones (D-021). They ARE the
 * universal action wearing a different id, so the NIGHTMARE HULK and Small "cannot perform
 * unique actions" bans must not reach them (the chaos-cult TEAM_CARVE_OUTS shape).
 */
const TEAM_CARVE_OUTS = new Set<string>([
  ...FIGHT_SWIPE,
  FIGHT_ONSLAUGHT,
  REPOSITION_BARGE,
  CHARGE_BARGE,
  VERMIN_REPOSITION,
  VERMIN_DASH,
  VERMIN_CHARGE,
]);

/** Effect / token / scratch keys, all namespaced (never module-level state — architecture rule 7). */
export const CURSE_BAG = 'gellerpox-infected.curse';
export const ENGINEERED_BAG = 'gellerpox-infected.engineered';
export const STOCKPILE_BAG = 'gellerpox-infected.pollutedStockpile';
export const VERMIN_BAG = 'gellerpox-infected.mutoidVerminAdded';
export const GIFT_TOKEN = 'gellerpox-infected.technoCurseToken';
export const ADDITIONAL_CURSE = 'gellerpox-infected.additionalCurse';
export const GROUP_ACTIVATION = 'gellerpox-infected.groupActivation';
export const GROUP_ACTIVATION_USED = 'gellerpox-infected.groupActivation.used';
export const REVOLTING_ARMED = 'gellerpox-infected.revoltingTechnology';
export const PUTRESCENT_ARMED = 'gellerpox-infected.putrescentDemise';
export const BARGE_EFFECT = 'gellerpox-infected.barge';
export const ONSLAUGHT_ARMED = 'gellerpox-infected.frighteningOnslaught';
export const SWIPE_LEDGER = 'gellerpox-infected.swipe';
export const GRASP_BAN = 'gellerpox-infected.tentacledGrasp';
export const HUM_MARKER = 'gellerpox-infected.drawnToTheHum';

/**
 * Printed clauses this module does NOT implement, each with the engine reason. Exported so the
 * tests can pin every one of them — `docs/TEAM-STATUS.md` is only worth anything if it is
 * honest, and a declared-but-unemitted hook would be the silent no-op architecture rule 5
 * forbids.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE.mutoidVermin}.ops`]:
    '"ignored for your opponent\'s kill/elimination op … and for victory conditions and scoring VPs if either require operatives to escape, survive or be incapacitated" is op scoring, owned by src/core/ops/** (the Spectre Squad Expendable / Kommandos Expendable gap); the "determining your starting number of operatives" half IS honoured, because team.startingSize is fixed at SelectRoster and the four MUTOID VERMIN the equipment adds are never counted into it',
  [`${RULE.mutoidVermin}.areas`]:
    '"cannot contest … areas of the killzone" — an area is only ever read by src/core/ops/**, which has no per-operative contest hook (markerContestedBy is the only seam and it is per MARKER); the marker half IS enforced through onMarkerControl',
  [`${RULE.mutoidVermin}.moveThrough`]:
    '"Operatives can move through MUTOID VERMIN operatives" needs onMoveRules.mayMoveThroughEnemies, which is declared but NEVER emitted — but validateMove only tests the END of a path for base overlap and control range, so the permission is already true for every operative in the game and registering a handler would be a silent no-op (the Void Dancer Harlequin\'s Panoply reading)',
  [`${RULE.mutoidVermin}.leaveControlRange`]:
    '"enemy operatives can leave MUTOID VERMIN operatives\' control range when performing the Charge action" — op.stickyEngagedWith is written by the universal Charge and READ NOWHERE in the engine, so the restriction it would lift does not exist yet',
  [`${AB.small}.melee`]:
    'weaponsOf appends grantedWeapons AFTER availableWeapons filters the datacard and startFight picks the melee weapon with no hook, so "cannot use any weapons that aren\'t on its datacard" reaches ranged weapons only (through onSelectWeapon) — the Sanctifiers CHERUB gap; it bites on nothing today because this team grants no weapon',
  [`${AB.mutantGroupActivation}.pairing`]:
    'EndActivation sets activePlayer to the opponent AFTER onActivationEnd fires and nothing runs later, so "you must then activate one other ready friendly GELLERPOX INFECTED MUTANT operative before your opponent activates" is recorded as an effect for the UI/AI only (the Breachers Breach and Clear / Pathfinders Group Activation partial)',
  [`${AB.glitchlingGroupActivation}.pairing`]:
    'the same activation-order gap: the GLITCHLING pairing is recorded as an effect for the UI/AI and cannot be enforced',
  [`${AB.cursemiteGroupActivation}.pairing`]:
    'the same activation-order gap: the MUTOID VERMIN pairing (CURSEMITE, EYESTINGER SWARM and SLUDGE-GRUB print the identical rule) is recorded as an effect for the UI/AI and cannot be enforced',
  [`${SP.drawnToTheHum}.endPosition`]:
    'no hook constrains where a move ENDS — onMoveRules is never emitted and onMoveDistance only scales the allowance — so "it must end that move within 2\\" of that objective marker" is not enforced; the predicate is exported as `drawnToTheHumEndLegal` for the UI (the Ratlings scarperEndPositionLegal precedent) and the +1\\" is only granted when the marker is actually reachable',
  [`${FP.revoltingTechnology}.hotRoll`]:
    'the Hot D6 is rolled inside finishShoot (src/core/sequences/shoot.ts) with no hook of any kind, so "if the weapon already has that weapon rule … you can add or subtract 1 from the result" — and the printed "you can see the result … before deciding to use this ploy" — have no seam; the Hot GRANT half is live',
  [`${EQ.pollutedStockpile}.timing`]:
    '"You cannot select this equipment option after the Select Operatives step" cannot be refused: the reducer commits SelectEquipment before onSelectEquipment fires and the event carries no `allowed` field (the Wyrmblade EXPLOSIVE TRAPS finding), so the CONSEQUENCE is enforced instead — the 2D6 is simply not rolled once setup is done',
  [`${AB.tentacledGrasp}.apNotRefunded`]:
    '"(the AP spent on it isn\'t refunded)" cannot be modelled: canPerformAction refuses the Fall Back before any AP is spent, so the enemy keeps AP the printed rule would have burned — strictly kinder to the opponent',
};

/** Clauses that are implemented, but at a moment or in a form the engine shifts. */
export const PARTIAL: Record<string, string> = {
  [`${RULE.technoCurse}.choice`]:
    'the Select Operatives step has no decision channel, so the mandatory choice is the pure setter setTechnoCurse (D-017) plus a deterministic, logged Barrelwarp default taken at the first friendly deploy (D-016) — a bot never leaves the faction rule switched off',
  [`${RULE.mutoidVermin}.enemyMoves`]:
    'the three enemy-facing ActionDefs lift the "cannot perform this action while within control range" refusal exactly, but they delegate to the universal action\'s perform, which still applies mustNotFinishEngaged against EVERY enemy — so an enemy may start a move engaged only by vermin and may not END within a vermin\'s control range; src/ai/legal.ts builds movement params for the four universal ids only, so a human uses them and the AI does not (D-021)',
  [`${AB.spikedCharger}.timing`]:
    'nothing runs at the end of an action, so "whenever this operative finishes moving during the Charge action" lands at the end of the activation the Charge happened in (the Ratlings Bayonet Charge / Nemesis Claw WE HAVE COME FOR YOU precedent)',
  [`${AB.tentacledGrasp}.timing`]:
    'canPerformAction is a pure query the AI runs many times per activation, so the D6 is rolled once at the enemy\'s onActivationStart while it is within the BLOATSPAWN\'s control range and the ban then holds for that activation (the Nemesis Claw CHAIN SNARE precedent); the counteraction half is invisible because Counteract emits no onActivationStart',
  [`${AB.swipe}.counteraction`]:
    'the reducer refuses a counteraction action whose ap is not 1 and hard-codes one action per counteraction, so the free 0AP FIGHT chain is reachable during an activation only — the Deathwatch Veteran Astartes gap; the chain is four sibling ActionDefs (the Phase Sweep precedent), so at most four enemies in control range can be swiped',
  [`${SP.rustEmanations}.timing`]:
    'the demotion is applied to the opponent\'s already-rolled pool at every post-roll onWeaponRules emit, so it lands before their re-roll offer is built and again at the retention step — the end state is exact, but the opponent learns a 3 is a fail one emit later than the printed "cannot retain"',
  [`${FP.revoltingTechnology}.window`]:
    'the engine opens no ploy window inside a shoot sequence (advanceShoot runs to completion inside PerformAction), so the ploy is declared in advance and arms itself against the next qualifying enemy shot (the Mandrakes SHADOW\'S BITE / Celestian GLORIOUS MARTYRDOM shape)',
  [`${FP.putrescentDemise}.window`]:
    'the same in-sequence ploy window: the ploy is declared in advance and fires on its printed trigger at onIncapacitated, before the operative is removed',
  [`${EQ.mutoidVermin}.four`]:
    'the printed equipment adds FOUR operatives while the scraped selection group is `count: 1`, so the equipment TOPS THE KILL TEAM UP to four MUTOID VERMIN operatives (a modelling decision, pinned by a test): the vermin already selected from that equipment-gated group are the ones this equipment added, and the printed 11 + 4 total is reached exactly',
  [`${EQ.pollutedStockpile}.choice`]:
    '"remove one of your opponent\'s selected equipment options" / "that player removes one of their own" have no decision channel, so the removal is a deterministic, logged default (D-016): on a 7+ the first option in their list, otherwise their last',
  [`${EQ.mutatedSymptoms}.choice`]:
    'nothing is emitted when a player would "select one additional TECHNO-CURSE", so it is auto-used under D-022 on a stated policy — the first activation of a friendly GELLERPOX INFECTED operative (excluding MUTOID VERMIN) that has an enemy within 4", taking the next curse in printed order after the selected one',
  [`${AB.engineered}.choice`]:
    'the Select Operatives step has no decision channel, so setEngineered (D-017) owns the pick and a deterministic, logged default of Balanced + Lethal 5+ is taken at the first friendly deploy — "up to two" with six strictly beneficial options is a free choice under D-022',
  [`${RULE.revoltinglyResilient}.shoot`]:
    'inflictDamage is called once per shoot with an aggregated total, so "whenever an attack dice inflicts damage of 3 or more" is counted per unblocked attack dice off the resolved pool (the Raveners Reinforced Carapace read); a fight strike IS one dice and is exact',
  [`${AB.gellercaustMasks}.shoot`]:
    'the same aggregation: a shoot\'s total is reduced by (Critical Dmg − Normal Dmg) once per unblocked critical success; a fight strike is identified by its amount matching the striking profile\'s Critical Dmg (the Death Korps Bruiser read, unambiguous here because every Dmg pair in this matchup differs)',
};

// ---------------------------------------------------------------------------
// TECHNO-CURSE — the three curses, sliced out of the one printed faction rule
// ---------------------------------------------------------------------------

export const CURSES = ['barrelwarp', 'rustspikes', 'vox-static'] as const;
export type Curse = (typeof CURSES)[number];

/** The printed heading of each TECHNO-CURSE, in printed order. Names, not rule text. */
export const CURSE_NAME: Record<Curse, string> = {
  barrelwarp: 'Barrelwarp',
  rustspikes: 'Screaming Rustspikes',
  'vox-static': 'Viral Vox-static',
};

export interface CurseText {
  /** Everything printed under the curse's heading, flavour paragraph dropped. */
  text: string;
  infectionRange: string;
  symptom: string;
}

/**
 * The three curses are printed inside the one Techno-Curse faction rule and the scrape has no
 * per-curse ids, so each curse's block is sliced out of that string here (CLAUDE.md: rule text
 * is data, never retyped). Each block is
 * `<Name>\n\n<flavour>\n\nInfection Range: …\n\nSymptom: …`.
 */
export const CURSE: Record<Curse, CurseText> = sliceCurses();

function sliceCurses(): Record<Curse, CurseText> {
  const whole = text(RULE.technoCurse);
  const marks = CURSES.map((c) => ({ curse: c, at: whole.indexOf(`\n${CURSE_NAME[c]}\n`) }));
  const out = {} as Record<Curse, CurseText>;
  marks.forEach((mark, i) => {
    if (mark.at < 0)
      throw new Error(`TECHNO-CURSE '${CURSE_NAME[mark.curse]}' is not in data/teams/gellerpox-infected.json`);
    const from = mark.at + 1 + CURSE_NAME[mark.curse].length;
    const to = marks[i + 1]?.at ?? whole.length;
    const paragraphs = whole
      .slice(from, to)
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body = paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs;
    const range = body.find((p) => p.startsWith('Infection Range:'));
    const symptom = body.find((p) => p.startsWith('Symptom:'));
    if (!range || !symptom)
      throw new Error(`TECHNO-CURSE '${CURSE_NAME[mark.curse]}' has no printed Infection Range / Symptom`);
    out[mark.curse] = { text: body.join('\n\n'), infectionRange: range, symptom };
  });
  return out;
}

/**
 * Spread the Glorious Gifts prints one extra clause per curse under the same headings. Sliced
 * out of the VULGRAR datacard ability the same way.
 */
export const GIFT_CLAUSE: Record<Curse, string> = sliceGiftClauses();

function sliceGiftClauses(): Record<Curse, string> {
  const whole = abilityText(CARD.vulgrar, AB.spreadTheGifts);
  const out = {} as Record<Curse, string>;
  for (const curse of CURSES) {
    const marker = `${CURSE_NAME[curse]}:`;
    const at = whole.indexOf(marker);
    if (at < 0) throw new Error(`Spread the Glorious Gifts has no '${marker}' clause`);
    const rest = whole.slice(at + marker.length);
    const end = rest.indexOf('\n\n');
    out[curse] = rest.slice(0, end < 0 ? rest.length : end).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engineered — the six improvements, sliced out of the printed datacard ability
// ---------------------------------------------------------------------------

export type EngineeredOption = 'dmgN' | 'dmgC' | 'Balanced' | 'Brutal' | 'Lethal' | 'Rending';

/** `{ id, label }` for each printed improvement, in printed order. */
export const ENGINEERED_OPTIONS: { id: EngineeredOption; label: string }[] = sliceEngineered();

function sliceEngineered(): { id: EngineeredOption; label: string }[] {
  const whole = abilityText(CARD.vulgrar, AB.engineered);
  const at = whole.lastIndexOf('for the battle:');
  if (at < 0) throw new Error('Engineered prints no improvement list');
  const labels = whole
    .slice(at + 'for the battle:'.length)
    .replace(/\.\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const idFor = (label: string): EngineeredOption => {
    const l = label.toLowerCase();
    if (l.includes('normal dmg')) return 'dmgN';
    if (l.includes('critical dmg')) return 'dmgC';
    if (l.startsWith('balanced')) return 'Balanced';
    if (l.startsWith('brutal')) return 'Brutal';
    if (l.startsWith('lethal')) return 'Lethal';
    if (l.startsWith('rending')) return 'Rending';
    throw new Error(`Engineered improvement '${label}' is not one this module knows`);
  };
  const out = labels.map((label) => ({ id: idFor(label), label }));
  if (out.length !== 6) throw new Error(`Engineered printed ${out.length} improvements, expected 6`);
  return out;
}

/**
 * D-022: "select up to two" of six options that are each a pure improvement is a free choice,
 * so a deterministic default is taken and logged rather than leaving Vulgrar's Fleshmelded
 * weapons unbuffed in every AI-driven game. Balanced (a re-roll on a 5-dice Atk) and Lethal 5+
 * (a second critical band on a weapon whose Critical Dmg is 5) are the two that pay best.
 */
export const ENGINEERED_DEFAULT: EngineeredOption[] = ['Balanced', 'Lethal'];

/** The mandatory TECHNO-CURSE choice needs a legal value; Barrelwarp always applies. */
export const CURSE_DEFAULT: Curse = 'barrelwarp';

// ---------------------------------------------------------------------------
// Pure setters and reads (docs/DECISIONS.md D-017)
// ---------------------------------------------------------------------------

/** "At the end of the Select Operatives step, select one TECHNO-CURSE…" */
export function setTechnoCurse(state: GameState, player: PlayerId, curse: Curse): void {
  bucket(state, CURSE_BAG)[player] = curse;
  log(state, {
    kind: 'system',
    player,
    text: `TECHNO-CURSE: ${CURSE_NAME[curse]}`,
    data: { curse },
  });
}

export function technoCurseOf(state: GameState, player: PlayerId): Curse | undefined {
  const v = bucket(state, CURSE_BAG)[player];
  return typeof v === 'string' && (CURSES as readonly string[]).includes(v) ? (v as Curse) : undefined;
}

/** "select up to two of the following improvements or weapon rules for this weapon to have…" */
export function setEngineered(state: GameState, player: PlayerId, picks: EngineeredOption[]): void {
  const known = picks.filter((p) => ENGINEERED_OPTIONS.some((o) => o.id === p)).slice(0, 2);
  bucket(state, ENGINEERED_BAG)[player] = known;
  log(state, {
    kind: 'system',
    player,
    text: `Engineered: ${known.map((id) => ENGINEERED_OPTIONS.find((o) => o.id === id)!.label).join(', ') || 'nothing'}`,
    data: { picks: known },
  });
}

export function engineeredOf(state: GameState, player: PlayerId): EngineeredOption[] {
  const v = bucket(state, ENGINEERED_BAG)[player];
  return Array.isArray(v) ? (v as EngineeredOption[]) : [];
}

/** The mandatory pre-battle choices, taken deterministically and logged if nobody made them. */
function ensureChoices(state: GameState, player: PlayerId): void {
  if (technoCurseOf(state, player) === undefined) setTechnoCurse(state, player, CURSE_DEFAULT);
  if (bucket(state, ENGINEERED_BAG)[player] === undefined) setEngineered(state, player, ENGINEERED_DEFAULT);
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

export const isVermin = (T: TeamHooks, op: OperativeState): boolean => T.kw(op, 'MUTOID VERMIN');
export const isHulk = (T: TeamHooks, op: OperativeState): boolean => T.kw(op, 'NIGHTMARE HULK');

/** "friendly GELLERPOX INFECTED operative (excluding MUTOID VERMIN)" — the aura carriers. */
const carriers = (T: TeamHooks, state: GameState): OperativeState[] =>
  T.friendlies(state, KW).filter((o) => !isVermin(T, o));

/**
 * Is this enemy operative inside the infection range of `curse`, projected from `from`?
 * "Within 2" of a friendly GELLERPOX INFECTED operative (excluding MUTOID VERMIN), or within 3"
 * of a friendly GELLERPOX INFECTED GLITCHLING operative."
 */
function inInfectionRange(
  T: TeamHooks,
  state: GameState,
  enemy: OperativeState,
  curse: Curse,
  from: OperativeState,
): boolean {
  if (curse === 'rustspikes') return T.ctx ? inControlRange(T.ctx, state, from, enemy) : T.gap(from, enemy) <= 1 + EPS;
  const base = curse === 'barrelwarp' ? 2 : 3;
  const reach = T.kw(from, 'GLITCHLING') ? base + 1 : base;
  return T.gap(from, enemy) <= reach + EPS;
}

export interface CurseVerdict {
  curses: Set<Curse>;
  /** True when the enemy is affected because it is within control range of a token'd marker. */
  viaToken: boolean;
}

/**
 * Every TECHNO-CURSE affecting this enemy operative right now: the selected one (from the
 * infection range, or from an objective marker carrying one of your Techno-curse tokens), plus
 * an additional one an operative gained from MUTATED SYMPTOMS.
 */
export function curseVerdict(T: TeamHooks, state: GameState, enemy: OperativeState): CurseVerdict {
  const out: CurseVerdict = { curses: new Set<Curse>(), viaToken: false };
  if (enemy.player === T.player || enemy.removed || enemy.incapacitated) return out;
  const selected = technoCurseOf(state, T.player);
  if (selected) {
    if (carriers(T, state).some((o) => inInfectionRange(T, state, enemy, selected, o))) out.curses.add(selected);
    // "Whenever that objective marker is within control range of an enemy operative, that
    //  operative is affected by your selected TECHNO-CURSE rule and an additional rule…"
    const token = effectFor(state, T.player, GIFT_TOKEN);
    const markerId = token?.data?.['markerId'];
    const marker = typeof markerId === 'string' ? state.markers[markerId] : undefined;
    if (marker && T.ctx && markerContestedBy(T.ctx, state, marker, enemy)) {
      out.curses.add(selected);
      out.viaToken = true;
    }
  }
  // MUTATED SYMPTOMS: "select one additional TECHNO-CURSE for that operative to gain".
  for (const holder of T.friendlies(state, KW)) {
    const eff = effectOn(state, holder.id, ADDITIONAL_CURSE);
    const extra = eff?.data?.['curse'];
    if (typeof extra !== 'string' || !(CURSES as readonly string[]).includes(extra)) continue;
    if (inInfectionRange(T, state, enemy, extra as Curse, holder)) out.curses.add(extra as Curse);
  }
  return out;
}

export const affectedBy = (T: TeamHooks, state: GameState, enemy: OperativeState, curse: Curse): boolean =>
  curseVerdict(T, state, enemy).curses.has(curse);

/** The melee/ranged profile the current fight is resolving for one side. */
function fightProfile(T: TeamHooks, state: GameState, seq: FightSequence, side: 'attacker' | 'defender'): WeaponProfile | undefined {
  const op = state.operatives[side === 'attacker' ? seq.attackerId : seq.defenderId];
  if (!op) return undefined;
  const name = side === 'attacker' ? seq.attackerWeapon : seq.defenderWeapon;
  const profileName = side === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  const w = T.card(op)?.weapons.find((x) => x.name === name);
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w.profiles[0];
}

/** The profile a shoot sequence is resolving. */
function shootProfile(T: TeamHooks, state: GameState, seq: ShootSequence): WeaponProfile | undefined {
  const attacker = state.operatives[seq.attackerId];
  const w = attacker ? T.card(attacker)?.weapons.find((x) => x.name === seq.weaponName) : undefined;
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (seq.profileName ?? '')) ?? w.profiles[0];
}

/** Gellercaust Masks is a "you can choose" that is only ever taken when it strictly helps (D-022). */
const masksApply = (T: TeamHooks, target: OperativeState, profile: WeaponProfile): boolean =>
  target.player === T.player && target.datacardId === CARD.mutant && profile.dmgC > profile.dmgN;

/** What each unblocked attack dice of the current shoot inflicts, after Gellercaust Masks. */
function shootDiceDamages(T: TeamHooks, state: GameState, seq: ShootSequence, target: OperativeState): number[] {
  const profile = shootProfile(T, state, seq);
  if (!profile) return [];
  const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
  const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
  const critDmg = masksApply(T, target, profile) ? profile.dmgN : profile.dmgC;
  const out: number[] = [];
  for (let i = 0; i < crits; i++) out.push(critDmg);
  for (let i = 0; i < normals; i++) out.push(profile.dmgN);
  return out;
}

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // Techno-Curse (faction rule)
  // =========================================================================
  /*
   * "At the end of the Select Operatives step, select one TECHNO-CURSE for friendly GELLERPOX
   *  INFECTED operatives to gain for the battle."
   *
   * The step has no decision channel, so `setTechnoCurse` (D-017) owns the pick for the UI and a
   * deterministic, LOGGED default is taken at the first friendly deploy — the choice is printed
   * as mandatory, so "no curse" is not a legal state (D-016's shape). The `onActivationStart`
   * copy is an idempotent safety net for a battle assembled without the deploy step (the
   * Raveners tunnel-marker-0 precedent).
   */
  reg.on('onDeploy', T.bind(RULE.technoCurse, 5), (ev) => {
    if (ev.operative.player !== T.player) return;
    ensureChoices(ev.state, T.player);
  });
  reg.on('onActivationStart', T.bind(RULE.technoCurse, 5), (ev) => {
    if (ev.operative.player !== T.player) return;
    ensureChoices(ev.state, T.player);
  });

  // Barrelwarp — "Symptom: Subtract 1 from the Atk stat of that enemy operative's ranged weapons."
  reg.on('onCollectAttackDice', T.bindText(`${RULE.technoCurse}.barrelwarp`, CURSE.barrelwarp.text, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const shooter = ev.ctx.attacker;
    if (shooter.player === T.player) return;
    if (!affectedBy(T, ev.state, shooter, 'barrelwarp')) return;
    ev.mods.atk -= 1;
  });

  /*
   * Screaming Rustspikes — "Symptom: Whenever that enemy operative is fighting or retaliating
   *  against a friendly GELLERPOX INFECTED operative, if your opponent discards any attack dice
   *  as a fail, inflict 1 damage on that enemy operative."
   *
   * `fight.ts` emits no post-roll hook (D-031), but `effectiveRules` is re-emitted at the top of
   * every `advanceFight` pass, so an `onWeaponRules` handler gated on `step === 'retention'` is a
   * real post-roll seam in a fight (the Void Dancer WRAITHBONE TALISMAN / Hearthkyn Grudge seam).
   * By then every re-roll has been offered, so the fails are exactly the dice being discarded.
   * VULGRAR's Spread the Glorious Gifts raises the 1 to 2 for an enemy standing on the marker
   * that carries a Techno-curse token.
   */
  reg.on('onWeaponRules', T.bindText(`${RULE.technoCurse}.rustspikes`, CURSE.rustspikes.text, 14), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || seq.step !== 'retention' || ev.type !== 'melee') return;
    const foe = ev.operative;
    if (foe.player === T.player) return;
    const friendly = ev.target;
    if (!friendly || !mine(friendly)) return; // "against a friendly GELLERPOX INFECTED operative"
    const verdict = curseVerdict(T, ev.state, foe);
    if (!verdict.curses.has('rustspikes')) return;
    const pool = seq.attackerId === foe.id ? seq.attackerPool : seq.defenderId === foe.id ? seq.defenderPool : undefined;
    if (!pool || !pool.dice.some((d) => d.state === 'fail')) return;
    const ledger = bucket(ev.state, `${CURSE_BAG}.rustspikes`);
    const stamp = `${seq.attackerId}:${seq.defenderId}:${foe.id}`;
    if (ledger[stamp]) return;
    ledger[stamp] = true;
    const damage = verdict.viaToken ? 2 : 1; // GIFT_CLAUSE['rustspikes']
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Screaming Rustspikes: ${foe.letter} discards a fail and takes ${damage} damage`,
    });
    if (T.ctx) inflictDamage(T.ctx, ev.state, foe, damage, 'other');
  });

  /*
   * Viral Vox-static — "Symptom: That enemy operative's APL stat cannot be added to (remove all
   *  positive APL stat changes it has)."
   *
   * `aplOf` sums `op.aplMods` and the `onStatMod` total, so the positive entries of `aplMods` are
   * cancelled here and a net-positive hook contribution is zeroed. Bound at priority 90 so it
   * runs after the ordinary APL rules; a handler bound above it would not be seen (a stated
   * limitation, and no other team binds `onStatMod` that high).
   */
  reg.on('onStatMod', T.bindText(`${RULE.technoCurse}.vox-static`, CURSE['vox-static'].text, 90), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    // `onStatMod` is emitted by every hitOf/moveOf/aplOf/saveOf read, so the geometry is only
    // walked when Viral Vox-static is actually in play (the Mandrakes `withinShadow` note).
    if (technoCurseOf(ev.state, T.player) !== 'vox-static' && !ev.state.effects.some((e) => e.rule === ADDITIONAL_CURSE && e.player === T.player && e.data?.['curse'] === 'vox-static'))
      return;
    if (!affectedBy(T, ev.state, foe, 'vox-static')) return;
    const positiveOnCard = foe.aplMods.reduce((a, b) => a + Math.max(0, b), 0);
    ev.mods.apl = Math.min(0, ev.mods.apl) - positiveOnCard;
  });

  /*
   * Spread the Glorious Gifts (VULGRAR) — "Viral Vox-static: Whenever that enemy operative is
   *  activated, subtract 1 from its APL stat until the end of its activation."
   */
  reg.on('onActivationStart', T.bindText(`${AB.spreadTheGifts}.vox-static`, abilityText(CARD.vulgrar, AB.spreadTheGifts), 14), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (technoCurseOf(ev.state, T.player) !== 'vox-static') return;
    const verdict = curseVerdict(T, ev.state, foe);
    if (!verdict.viaToken) return;
    foe.aplMods.push(-1);
    effect(ev.state, {
      rule: `${AB.spreadTheGifts}.apl`,
      source: { kind: 'ability', id: AB.spreadTheGifts },
      sourceText: GIFT_CLAUSE['vox-static'],
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Spread the Glorious Gifts: ${foe.letter} is activated on the cursed marker (-1 APL)`,
    });
  });
  // `endOfActivation` expiry clears the effect; the `aplMods` entry it pushed is popped here.
  reg.on('onActivationEnd', T.bindText(`${AB.spreadTheGifts}.aplPop`, abilityText(CARD.vulgrar, AB.spreadTheGifts), 90), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (!effectOn(ev.state, foe.id, `${AB.spreadTheGifts}.apl`)) return;
    const at = foe.aplMods.lastIndexOf(-1);
    if (at >= 0) foe.aplMods.splice(at, 1);
    dropEffects(ev.state, (e) => e.rule === `${AB.spreadTheGifts}.apl` && e.operativeId === foe.id);
  });

  // =========================================================================
  // Mutoid Vermin (faction rule)
  // =========================================================================
  /*
   * "MUTOID VERMIN operatives cannot perform any actions other than Charge, Dash, Fall Back,
   *  Fight, Reposition and Shoot, or use any weapons that aren't on their datacard. They can
   *  perform the Fall Back action for 1 less AP."
   */
  const VERMIN_ACTIONS = new Set(['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot']);
  reg.on('canPerformAction', T.bind(RULE.mutoidVermin, 12), (ev) => {
    if (!mine(ev.operative) || !isVermin(T, ev.operative)) return;
    if (ev.action === 'Guard') {
      // Guard carries `treatedAs: 'Shoot'` but is not on the printed list.
      ev.allowed = false;
      ev.reason = 'Mutoid Vermin: it can only Charge, Dash, Fall Back, Fight, Reposition and Shoot';
      return;
    }
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (VERMIN_ACTIONS.has(key)) return;
    ev.allowed = false;
    ev.reason = 'Mutoid Vermin: it can only Charge, Dash, Fall Back, Fight, Reposition and Shoot';
  });
  reg.on('onActionCost', T.bind(RULE.mutoidVermin, 12), (ev) => {
    if (!mine(ev.operative) || !isVermin(T, ev.operative)) return;
    const def = allActions().find((a) => a.id === ev.action);
    if ((def?.treatedAs ?? ev.action) !== 'Fall Back') return;
    ev.ap -= 1; // "They can perform the Fall Back action for 1 less AP."
  });
  // "…or use any weapons that aren't on their datacard." The ranged half only: `weaponsOf`
  // appends `grantedWeapons` AFTER `availableWeapons`, so a granted melee weapon has no seam.
  reg.on('onSelectWeapon', T.bind(RULE.mutoidVermin, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (!mine(op) || !isVermin(T, op)) return;
    if ((T.card(op)?.weapons ?? []).some((w) => w.name === ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Mutoid Vermin: it cannot use weapons that are not on its datacard';
  });
  // "MUTOID VERMIN operatives cannot contest markers…"
  reg.on('onMarkerControl', T.bind(RULE.mutoidVermin, 12), (ev) => {
    const ctx = T.ctx;
    const marker = ev.state.markers[ev.markerId];
    if (!ctx || !marker) return;
    for (const grub of T.friendlies(ev.state, KW)) {
      if (!isVermin(T, grub)) continue;
      if (!markerContestedBy(ctx, ev.state, marker, grub)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - aplOfSafe(T, grub));
    }
  });

  // =========================================================================
  // Nightmare Hulks (faction rule)
  // =========================================================================
  /*
   * "Whenever your opponent is selecting a valid target, friendly GELLERPOX INFECTED NIGHTMARE
   *  HULK operatives cannot use Light terrain for cover. While this can allow such operatives to
   *  be targeted (assuming they're visible), it doesn't remove their cover save (if any)."
   *
   * `ignoreCoverTerrain: 'light'` makes it targetable, but the same flag also feeds the cover
   * SAVE, so the save is put back at `onDefenceDice` — which is exactly the second sentence
   * (the Ratlings Brute give-back, verbatim).
   */
  reg.on('onValidTarget', T.bind(RULE.nightmareHulks, 12), (ev) => {
    if (!mine(ev.target) || !isHulk(T, ev.target)) return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });
  reg.on('onDefenceDice', T.bind(RULE.nightmareHulks, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !mine(target) || !isHulk(T, target) || ev.coverSave) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || !T.ctx) return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    const attacker = ev.ctx.attacker;
    const seek = ev.ctx.rules.some((r) => r.id === 'Seek');
    const seekLight = ev.ctx.rules.some((r) => r.id === 'SeekLight');
    const cover = coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, attacker), body(T.ctx, target), {
      ignoreCoverTerrain: seek ? 'all' : seekLight ? 'light' : 'none',
      vantageDeniesLightCover: ev.ctx.vantageAccurate > 0 && attacker.z - target.z >= 2 - EPS,
    });
    if (!cover.inCover) return;
    ev.coverSave = true; // "it doesn't remove their cover save (if any)"
  });
  // "Friendly GELLERPOX INFECTED NIGHTMARE HULK operatives cannot perform unique actions."
  reg.on('canPerformAction', T.bind(RULE.nightmareHulks, 13), (ev) => {
    if (!mine(ev.operative) || !isHulk(T, ev.operative)) return;
    if (TEAM_CARVE_OUTS.has(ev.action)) return; // this module's own D-021 carve-outs are not unique actions
    const def = allActions().find((a) => a.id === ev.action);
    if (def?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'Nightmare Hulks: it cannot perform unique actions';
  });
  /*
   * "You must spend 1 additional AP for friendly GELLERPOX INFECTED NIGHTMARE HULK operatives
   *  (excluding VULGRAR THRICE-CURSED) to perform the Pick Up Marker and mission actions
   *  (excluding Operate Hatch)."
   */
  reg.on('onActionCost', T.bind(RULE.nightmareHulks, 13), (ev) => {
    const op = ev.operative;
    if (!mine(op) || !isHulk(T, op) || op.datacardId === CARD.vulgrar) return;
    if (ev.action === 'Operate Hatch') return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (key !== 'Pick Up Marker' && def?.type !== 'mission') return;
    ev.ap += 1;
  });

  // =========================================================================
  // Revoltingly Resilient (faction rule)
  // =========================================================================
  /*
   * "Whenever an attack dice inflicts damage of 3 or more on a friendly GELLERPOX INFECTED
   *  NIGHTMARE HULK or GELLERPOX INFECTED MUTANT operative, roll one D6: on a 4+, subtract 1
   *  from that inflicted damage."
   *
   * A fight strike IS one attack dice, so `ev.amount` is exact. A shoot inflicts one aggregated
   * sum, so the reduction is counted per unblocked attack dice off the resolved pool (the
   * Raveners Reinforced Carapace read). Devastating x is inflicted by a retained critical
   * success — an attack dice — so it is covered too, per crit.
   */
  reg.on('onDamage', T.bind(RULE.revoltinglyResilient, 14), (ev) => {
    if (ev.kind !== 'attack' && ev.kind !== 'devastating') return;
    const target = ev.target;
    if (!mine(target) || !(isHulk(T, target) || T.kw(target, 'MUTANT'))) return;
    if (!T.ctx || ev.amount <= 0) return;
    const perDice = attackDiceAmounts(T, ev.state, target, ev.amount, ev.kind);
    let saved = 0;
    for (const amount of perDice) {
      if (amount < 3) continue;
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'revoltinglyResilient', [roll], T.player, `${target.letter} Revoltingly Resilient`);
      if (roll >= 4) saved += 1;
    }
    if (saved === 0) return;
    ev.amount = Math.max(0, ev.amount - saved);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Revoltingly Resilient: ${target.letter} shrugs off ${saved} damage`,
    });
  });

  datacards(reg, T);
}

/**
 * The operative's APL from its datacard and its own `aplMods`, without a `GameContext`. Used
 * inside `onMarkerControl`, where re-entering `aplOf` would re-emit `onStatMod` for every
 * operative on the board on every marker read.
 */
function aplOfSafe(T: TeamHooks, op: OperativeState): number {
  const base = T.card(op)?.apl ?? 2;
  const raw = op.aplMods.reduce((a, b) => a + b, 0);
  return Math.max(0, base + Math.max(-1, Math.min(1, raw)));
}

/**
 * Split an inflicted amount into the attack dice that produced it, so a per-attack-dice rule can
 * read a shoot's aggregated total. A fight strike and a melee Devastating hit are one dice each.
 */
function attackDiceAmounts(
  T: TeamHooks,
  state: GameState,
  target: OperativeState,
  amount: number,
  kind: 'attack' | 'devastating',
): number[] {
  const fight = fightSeq(state);
  if (fight) return [amount];
  const seq = shootSeq(state);
  if (!seq) return [amount];
  if (kind === 'devastating') {
    const retainedCrits = seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'blocked').length;
    if (retainedCrits <= 0) return [amount];
    const per = amount / retainedCrits;
    return Array.from({ length: retainedCrits }, () => per);
  }
  if (seq.targetId !== target.id) return [amount];
  const dice = shootDiceDamages(T, state, seq, target);
  return dice.length > 0 ? dice : [amount];
}

// ---------------------------------------------------------------------------
// Datacard abilities
// ---------------------------------------------------------------------------

/**
 * "Whenever this operative is expended, you must then activate one other ready friendly … before
 *  your opponent activates."
 *
 * PARTIAL for all four printed copies: `EndActivation` sets `activePlayer` to the opponent AFTER
 * `onActivationEnd` fires and nothing runs later, so the pairing is recorded as an effect the
 * UI/AI reads (the Breachers' Breach and Clear / Pathfinders' Group Activation partial).
 */
function groupActivation(reg: HookRegistry, T: TeamHooks, cardId: string, abilityId: string, partner: (T: TeamHooks, op: OperativeState) => boolean): void {
  reg.on('onActivationEnd', T.bind(abilityId, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== cardId) return;
    // "…in other words, you cannot activate more than two operatives in succession with this rule."
    if (effectOn(ev.state, op.id, GROUP_ACTIVATION_USED)) return;
    const other = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== op.id && o.ready && partner(T, o))
      .sort(byId)[0];
    if (!other) return;
    for (const [rule, id] of [
      [GROUP_ACTIVATION, other.id],
      [GROUP_ACTIVATION_USED, other.id],
    ] as const) {
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: abilityId },
        sourceText: shortQuote(abilityText(cardId, abilityId)),
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
}

function datacards(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // VULGRAR THRICE-CURSED › Engineered (rare weapon rule, printed as an ability)
  // =========================================================================
  /*
   * "At the end of the Select Operatives step, if this operative is selected for deployment,
   *  select up to two of the following improvements or weapon rules for this weapon to have for
   *  the battle: Add 1 to the Normal Dmg stat, add 1 to the Critical Dmg stat, Balanced, Brutal,
   *  Lethal 5+, Rending."
   *
   * The weapon-rule half rides `onWeaponRules`, which BOTH sequences read, so it is live when
   * fighting and when retaliating. The two Dmg bumps land where the damage is inflicted (D-019:
   * a `WeaponProfile` is shared catalogue data and is never rewritten).
   */
  const ENGINEERED_WEAPON = 'Fleshmelded weapons';
  reg.on('onWeaponRules', T.bind(AB.engineered, 12), (ev) => {
    if (!mine(ev.operative) || ev.operative.datacardId !== CARD.vulgrar) return;
    if (ev.weaponName !== ENGINEERED_WEAPON) return;
    const picks = engineeredOf(ev.state, T.player);
    for (const pick of picks) {
      if (pick === 'Balanced' && !ev.rules.some((r) => r.id === 'Balanced'))
        ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Engineered)'));
      if (pick === 'Brutal' && !ev.rules.some((r) => r.id === 'Brutal'))
        ev.rules.push(ruleTag('Brutal', undefined, 'Brutal (Engineered)'));
      if (pick === 'Rending' && !ev.rules.some((r) => r.id === 'Rending'))
        ev.rules.push(ruleTag('Rending', undefined, 'Rending (Engineered)'));
      if (pick === 'Lethal' && !ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5))
        ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Engineered)'));
    }
  });
  reg.on('onDamage', T.bind(AB.engineered, 11), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    const defender = ev.state.operatives[seq.defenderId];
    const vulgrar =
      attacker?.datacardId === CARD.vulgrar ? attacker : defender?.datacardId === CARD.vulgrar ? defender : undefined;
    if (!vulgrar || !mine(vulgrar) || ev.target.id === vulgrar.id) return;
    const side = seq.attackerId === vulgrar.id ? 'attacker' : 'defender';
    if ((side === 'attacker' ? seq.attackerWeapon : seq.defenderWeapon) !== ENGINEERED_WEAPON) return;
    const profile = fightProfile(T, ev.state, seq, side);
    if (!profile) return;
    const picks = engineeredOf(ev.state, T.player);
    if (picks.includes('dmgC') && ev.amount === profile.dmgC) ev.amount += 1;
    else if (picks.includes('dmgN') && ev.amount === profile.dmgN) ev.amount += 1;
  });

  // =========================================================================
  // BLOATSPAWN › Tentacled Grasp
  // =========================================================================
  /*
   * "Whenever an enemy operative would perform the Fall Back action while within control range of
   *  this operative, you can use this rule. If you do, roll one D6, adding 1 to the result if
   *  that enemy operative has a Wounds stat of 8 or less: on a 4+, that enemy operative cannot
   *  perform that action during that activation/counteraction (the AP spent on it isn't
   *  refunded)."
   *
   * `canPerformAction` is a pure query the AI runs many times per activation, so the D6 is rolled
   * once at the enemy's `onActivationStart` while it is within the BLOATSPAWN's control range and
   * the ban then holds for that activation (the Nemesis Claw CHAIN SNARE precedent). Free and
   * always beneficial, so it is auto-used (D-022).
   */
  reg.on('onActivationStart', T.bind(AB.tentacledGrasp, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || !T.ctx) return;
    const grabber = T.friendlies(ev.state, KW).find(
      (o) => o.datacardId === CARD.bloatspawn && inControlRange(T.ctx!, ev.state, o, foe),
    );
    if (!grabber) return;
    const wounds = T.card(foe)?.wounds ?? 99;
    const roll = T.ctx.rng.d6() + (wounds <= 8 ? 1 : 0);
    recordRoll(ev.state, 'tentacledGrasp', [roll], T.player, `${foe.letter} Tentacled Grasp`);
    if (roll < 4) {
      log(ev.state, { kind: 'action', player: T.player, text: `Tentacled Grasp: ${roll} — ${foe.letter} can still Fall Back` });
      return;
    }
    effect(ev.state, {
      rule: GRASP_BAN,
      source: { kind: 'ability', id: AB.tentacledGrasp },
      sourceText: shortQuote(abilityText(CARD.bloatspawn, AB.tentacledGrasp)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Tentacled Grasp: ${roll} — ${foe.letter} cannot Fall Back` });
  });
  reg.on('canPerformAction', T.bind(AB.tentacledGrasp, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const def = allActions().find((a) => a.id === ev.action);
    if ((def?.treatedAs ?? ev.action) !== 'Fall Back') return;
    if (!effectOn(ev.state, ev.operative.id, GRASP_BAN)) return;
    ev.allowed = false;
    ev.reason = 'Tentacled Grasp: it cannot perform the Fall Back action during this activation';
  });

  // =========================================================================
  // BLOATSPAWN › Swipe (rare weapon rule, printed as an ability)
  // =========================================================================
  /*
   * "Whenever this operative performs the Fight action and you select this weapon profile … it
   *  can immediately perform a free FIGHT action afterwards, but you must select this weapon
   *  profile and it can only fight against each enemy operative within its control range once per
   *  activation or counteraction using this weapon profile."
   *
   * The chain is four sibling 0AP `ActionDef`s (the Deathwatch Phase Sweep precedent). The ledger
   * of enemies already swiped is written as the swiping profile's dice are collected, which is
   * the one moment that carries both the profile and the operative being fought.
   */
  reg.on('onCollectAttackDice', T.bind(AB.swipe, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (!mine(op) || op.datacardId !== CARD.bloatspawn) return;
    if ((ev.ctx.profile.name ?? '') !== SWIPE_PROFILE) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== op.id) return; // "whenever this operative PERFORMS the Fight action"
    const foe = ev.ctx.defender;
    if (!foe) return;
    const ledger = swipeLedger(ev.state, op);
    if (!ledger.includes(foe.id)) ledger.push(foe.id);
    ev.state.opState[SWIPE_LEDGER] = { ...(ev.state.opState[SWIPE_LEDGER] ?? {}), [op.id]: ledger };
  });
  // The ledger is per activation or counteraction.
  reg.on('onActivationEnd', T.bind(AB.swipe, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const bag = (ev.state.opState[SWIPE_LEDGER] ?? {}) as Record<string, string[]>;
    delete bag[ev.operative.id];
    ev.state.opState[SWIPE_LEDGER] = bag;
  });

  // =========================================================================
  // FLESHSCREAMER › Horrifying Shrieking
  // =========================================================================
  // "Whenever an enemy operative is within 3" of this operative, your opponent must spend 1
  //  additional AP for that enemy operative to perform the Pick Up Marker and mission actions."
  reg.on('onActionCost', T.bind(AB.horrifyingShrieking, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (key !== 'Pick Up Marker' && def?.type !== 'mission') return;
    const near = T.friendlies(ev.state, KW).some(
      (o) => o.datacardId === CARD.fleshscreamer && T.gap(o, foe) <= 3 + EPS,
    );
    if (near) ev.ap += 1;
  });
  /*
   * "Whenever determining control of a marker, treat the total APL stat of enemy operatives that
   *  contest it as 1 lower if at least one of those enemy operatives is within 3" of this
   *  operative. Note this isn't a change to the APL stat, so any changes are cumulative with this."
   */
  reg.on('onMarkerControl', T.bind(AB.horrifyingShrieking, 12), (ev) => {
    const ctx = T.ctx;
    const marker = ev.state.markers[ev.markerId];
    if (!ctx || !marker) return;
    const foes = T.enemies(ev.state).filter((o) => markerContestedBy(ctx, ev.state, marker, o));
    if (foes.length === 0) return;
    const screamers = T.friendlies(ev.state, KW).filter((o) => o.datacardId === CARD.fleshscreamer);
    for (const screamer of screamers) {
      if (!foes.some((f) => T.gap(screamer, f) <= 3 + EPS)) continue;
      const foe = T.player === 'p1' ? 'p2' : 'p1';
      ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
    }
  });

  // =========================================================================
  // LUMBERGHAST › Spiked Charger
  // =========================================================================
  /*
   * "Whenever this operative finishes moving during the Charge action, you can inflict D3 damage
   *  on each enemy operative within its control range (roll separately for each)."
   *
   * PARTIAL: nothing runs at the end of an action, so the D3s land at the end of the activation
   * the Charge happened in (the Ratlings Bayonet Charge precedent). Free and always beneficial,
   * so it is auto-used (D-022).
   */
  reg.on('onActivationEnd', T.bind(AB.spikedCharger, 12), (ev) => {
    const op = ev.operative;
    if (!mine(op) || op.datacardId !== CARD.lumberghast || !T.ctx) return;
    if (!op.actionsThisActivation.includes('Charge') && !op.actionsThisActivation.includes(CHARGE_BARGE)) return;
    if (op.incapacitated || op.removed) return;
    for (const foe of T.enemies(ev.state).filter((e) => inControlRange(T.ctx!, ev.state, op, e)).sort(byId)) {
      const damage = T.ctx.rng.d3();
      recordRoll(ev.state, 'spikedCharger', [damage], T.player, 'Spiked Charger D3');
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Spiked Charger: ${op.letter} inflicts ${damage} on ${foe.letter}`,
      });
      inflictDamage(T.ctx, ev.state, foe, damage, 'other');
    }
  });

  // =========================================================================
  // MUTANT › Gellercaust Masks
  // =========================================================================
  /*
   * "Whenever an attack dice would inflict Critical Dmg on this operative, you can choose for
   *  that attack dice to inflict Normal Dmg instead."
   *
   * D-022: taken whenever Critical Dmg is worse than Normal Dmg, never when it is not (KT24 does
   * print weapons whose Critical Dmg is at or below Normal Dmg — docs/TEAM-STATUS.md). A fight
   * strike IS one dice; a shoot's aggregated total is reduced once per unblocked critical success.
   */
  reg.on('onDamage', T.bind(AB.gellercaustMasks, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const target = ev.target;
    if (!mine(target) || target.datacardId !== CARD.mutant) return;
    const fight = fightSeq(ev.state);
    if (fight) {
      const side = fight.defenderId === target.id ? 'attacker' : 'defender';
      const profile = fightProfile(T, ev.state, fight, side);
      if (!profile || !masksApply(T, target, profile)) return;
      if (ev.amount !== profile.dmgC) return;
      ev.amount = profile.dmgN;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Gellercaust Masks: ${target.letter} takes Normal Dmg (${profile.dmgN}) instead of Critical Dmg`,
      });
      return;
    }
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id) return;
    const profile = shootProfile(T, ev.state, seq);
    if (!profile || !masksApply(T, target, profile)) return;
    const crits = countCrits(seq.attack);
    if (crits === 0) return;
    const saved = crits * (profile.dmgC - profile.dmgN);
    ev.amount = Math.max(0, ev.amount - saved);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Gellercaust Masks: ${crits} critical success(es) inflict Normal Dmg on ${target.letter} (-${saved})`,
    });
  });

  // =========================================================================
  // GLITCHLING › Daemonic / Small
  // =========================================================================
  // "Whenever an operative is shooting this operative, ignore the Piercing weapon rule."
  // Bound high so it also strips a Piercing another rule granted.
  reg.on('onWeaponRules', T.bind(AB.daemonic, 45), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player === T.player) return;
    if (!ev.target || !mine(ev.target) || ev.target.datacardId !== CARD.glitchling) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
  });
  // "This operative cannot use any weapons that aren't on its datacard, or perform unique actions."
  reg.on('canPerformAction', T.bind(AB.small, 12), (ev) => {
    if (!mine(ev.operative) || ev.operative.datacardId !== CARD.glitchling) return;
    if (TEAM_CARVE_OUTS.has(ev.action)) return;
    const def = allActions().find((a) => a.id === ev.action);
    if (def?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'Small: a GLITCHLING cannot perform unique actions';
  });
  reg.on('onSelectWeapon', T.bind(AB.small, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (!mine(op) || op.datacardId !== CARD.glitchling) return;
    if ((T.card(op)?.weapons ?? []).some((w) => w.name === ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Small: it cannot use weapons that are not on its datacard';
  });
  /*
   * "Whenever this operative has a Conceal order and is in cover, it cannot be selected as a valid
   *  target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being
   *  within 2"."
   *
   * `onValidTarget` is emitted before the core computes cover, so cover is recomputed here with
   * the DEFAULT options — which is what "taking precedence over Seek and Vantage" means (the
   * Ratlings SHIFTY / Vespid Evasive Drone precedent).
   */
  reg.on('onValidTarget', T.bind(AB.small, 25), (ev) => {
    const target = ev.target;
    if (!mine(target) || target.datacardId !== CARD.glitchling || target.order !== 'conceal') return;
    if (!T.ctx || T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    if (!coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'Small: a concealed GLITCHLING in cover cannot be selected';
  });

  // =========================================================================
  // CURSEMITE › Feast (rare weapon rule, printed as an ability)
  // =========================================================================
  /*
   * "Whenever this operative is using this weapon against a wounded operative, add 1 to the Atk
   *  stat of this weapon and it has the Lethal 5+ weapon rule."
   *
   * `onWeaponRules` and `onCollectAttackDice` are both emitted by `fight.ts` for the attacker AND
   * the retaliating defender, so "using this weapon" is live in both directions.
   */
  const FEAST_WEAPON = 'Bloodsucking proboscis';
  const feastOn = (state: GameState, user: OperativeState | undefined, foe: OperativeState | undefined, weapon: string): boolean => {
    if (!user || !foe || weapon !== FEAST_WEAPON) return false;
    if (!mine(user) || user.datacardId !== CARD.cursemite) return false;
    return T.ctx ? isWounded(T.ctx, foe) : foe.wounds < (T.card(foe)?.wounds ?? foe.wounds);
  };
  reg.on('onWeaponRules', T.bind(AB.feast, 12), (ev) => {
    if (!feastOn(ev.state, ev.operative, ev.target, ev.weaponName)) return;
    if (!ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5))
      ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Feast)'));
  });
  reg.on('onCollectAttackDice', T.bind(AB.feast, 12), (ev) => {
    if (!feastOn(ev.state, ev.ctx.attacker, ev.ctx.defender, ev.ctx.weaponName)) return;
    ev.mods.atk += 1;
  });

  // =========================================================================
  // SLUDGE-GRUB › Caustic Demise
  // =========================================================================
  /*
   * "When this operative is incapacitated, before it's removed from the killzone, roll one D6
   *  separately for each enemy operative visible to and within 2" of it: on a 4+, inflict 1
   *  damage on that operative."
   */
  reg.on('onIncapacitated', T.bind(AB.causticDemise, 40), (ev) => {
    const op = ev.operative;
    if (ev.prevented || !mine(op) || op.datacardId !== CARD.sludgeGrub || !T.ctx) return;
    const index = terrain(T.ctx, ev.state);
    for (const foe of T.enemies(ev.state).sort(byId)) {
      if (T.gap(op, foe) > 2 + EPS) continue;
      if (!isVisible(index, body(T.ctx, op), body(T.ctx, foe)).visible) continue;
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'causticDemise', [roll], T.player, `Caustic Demise vs ${foe.letter}`);
      if (roll < 4) continue;
      log(ev.state, { kind: 'action', player: T.player, text: `Caustic Demise: ${roll} — 1 damage to ${foe.letter}` });
      inflictDamage(T.ctx, ev.state, foe, 1, 'other');
    }
  });

  // =========================================================================
  // Group Activation — four printed copies, three different partner rules
  // =========================================================================
  groupActivation(reg, T, CARD.mutant, AB.mutantGroupActivation, (h, o) => h.kw(o, 'MUTANT'));
  groupActivation(reg, T, CARD.glitchling, AB.glitchlingGroupActivation, (h, o) => h.kw(o, 'GLITCHLING'));
  groupActivation(reg, T, CARD.cursemite, AB.cursemiteGroupActivation, (h, o) => isVermin(h, o));
  groupActivation(reg, T, CARD.eyestinger, AB.eyestingerGroupActivation, (h, o) => isVermin(h, o));
  groupActivation(reg, T, CARD.sludgeGrub, AB.sludgeGrubGroupActivation, (h, o) => isVermin(h, o));
}

/** The BLOATSPAWN's `swiping` weapon profile — the one Swipe is printed on. */
export const SWIPE_WEAPON = 'Mutant claw & tentacles';
export const SWIPE_PROFILE = 'swiping';

export function swipeLedger(state: GameState, op: OperativeState): string[] {
  const bag = (state.opState[SWIPE_LEDGER] ?? {}) as Record<string, string[]>;
  return [...(bag[op.id] ?? [])];
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

/** The objective marker DRAWN TO THE HUM named this turning point, if any. */
export function humMarkerId(state: GameState, player: PlayerId): string | undefined {
  const eff = effectFor(state, player, HUM_MARKER);
  const id = eff?.data?.['markerId'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * "…but it must end that move within 2" of that objective marker." No hook constrains where a
 * move ENDS, so the predicate is exported for the UI (the Ratlings `scarperEndPositionLegal` /
 * Corsair `eruditeEndPositionLegal` precedent) and the extra inch is only granted when the
 * marker is within reach in the first place.
 */
export function drawnToTheHumEndLegal(T: TeamHooks, state: GameState, op: OperativeState, end: { x: number; y: number }): boolean {
  const id = humMarkerId(state, T.player);
  const marker = id ? state.markers[id] : undefined;
  if (!marker) return true;
  return T.markerGap({ ...op, pos: { x: end.x, y: end.y } }, marker) <= 2 + EPS;
}

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);
  const gambitTP = (state: GameState, id: string): boolean => state.teams[T.player].gambitsUsedTP.includes(id);

  // =========================================================================
  // PLAGUERIDDEN DETERMINATION (strategy, 1CP)
  // =========================================================================
  // "Whenever an operative is shooting a friendly GELLERPOX INFECTED operative (excluding MUTOID
  //  VERMIN) that has an Engage order, you can re-roll one of your defence dice."
  reg.on('onDefenceDice', T.bind(SP.plagueriddenDetermination, 20), (ev) => {
    if (!gambitTP(ev.state, SP.plagueriddenDetermination)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !mine(target) || isVermin(T, target) || target.order !== 'engage') return;
    const grant: RerollGrant = {
      id: 'gellerpox.plagueridden',
      label: 'PLAGUERIDDEN DETERMINATION: re-roll one defence die',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(SP.plagueriddenDetermination)),
    };
    if (!ev.rerolls.some((r) => r.id === grant.id)) ev.rerolls.push(grant);
  });

  // =========================================================================
  // DRAWN TO THE HUM (strategy, 1CP)
  // =========================================================================
  /*
   * "Select one objective marker. Whenever a friendly GELLERPOX INFECTED operative performs the
   *  Reposition or Charge action during its activation, you can use this rule. If you do, add 1"
   *  to its Move stat until the end of that activation, but it must end that move within 2" of
   *  that objective marker."
   *
   * The marker comes from the gambit's `data.markerId`, else a deterministic, logged default
   * (D-016): the objective marker closest to the centroid of the kill team. The end-position
   * clause has no seam, so the inch is only added when the marker is actually reachable with it
   * — a stated policy, and `drawnToTheHumEndLegal` is exported for the UI.
   */
  reg.on('onPloyUsed', T.bind(SP.drawnToTheHum, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.drawnToTheHum) return;
    const objectives = Object.values(ev.state.markers).filter((m) => m.kind === 'objective');
    if (objectives.length === 0) return;
    const asked = ev.data?.['markerId'];
    const friends = T.friendlies(ev.state, KW);
    const cx = friends.reduce((a, o) => a + o.pos.x, 0) / Math.max(1, friends.length);
    const cy = friends.reduce((a, o) => a + o.pos.y, 0) / Math.max(1, friends.length);
    const chosen =
      (typeof asked === 'string' ? objectives.find((m) => m.id === asked) : undefined) ??
      [...objectives].sort(
        (a, b) => Math.hypot(a.pos.x - cx, a.pos.y - cy) - Math.hypot(b.pos.x - cx, b.pos.y - cy) || (a.id < b.id ? -1 : 1),
      )[0]!;
    effect(ev.state, {
      rule: HUM_MARKER,
      source: { kind: 'ploy', id: SP.drawnToTheHum },
      sourceText: shortQuote(text(SP.drawnToTheHum)),
      player: T.player,
      data: { markerId: chosen.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `DRAWN TO THE HUM: ${chosen.id}`,
      data: { markerId: chosen.id },
    });
  });
  reg.on('onMoveDistance', T.bind(SP.drawnToTheHum, 20), (ev) => {
    const op = ev.operative;
    if (!mine(op) || ev.state.activeOperativeId !== op.id) return;
    if (ev.action !== 'Reposition' && ev.action !== 'Charge') return;
    const id = humMarkerId(ev.state, T.player);
    const marker = id ? ev.state.markers[id] : undefined;
    if (!marker) return;
    // "you can use this rule" — only when the extra inch can actually buy the printed end
    // position, so the clause the engine cannot enforce is never a free bonus (D-022).
    if (T.markerGap(op, marker) > ev.inches + 1 + 2 + EPS) return;
    ev.inches += 1;
  });

  // =========================================================================
  // BLESSINGS OF INFECTION (strategy, 1CP)
  // =========================================================================
  /*
   * "Whenever a friendly GELLERPOX INFECTED operative is fighting or retaliating, you can do one
   *  of the following:
   *    If you roll three or more fails, you can discard one of them to retain another as a normal
   *    success instead.
   *    If you roll three or more successes, you can discard one of your fails to retain one of
   *    your normal successes as a critical success instead."
   *
   * `fight.ts` emits no post-roll hook (D-031), but `effectiveRules` is re-emitted at the top of
   * every `advanceFight` pass, so `onWeaponRules` gated on `step === 'retention'` is a real
   * post-roll seam for BOTH fighting and retaliating (the Void Dancer WRAITHBONE TALISMAN seam).
   * Free and strictly beneficial, so it is auto-used (D-022) with a stated policy: take the
   * critical-success branch when it applies, otherwise the fail branch; the dice picked are the
   * deterministic defaults the engine itself uses (lowest fail discarded, highest kept).
   */
  reg.on('onWeaponRules', T.bind(SP.blessingsOfInfection, 20), (ev) => {
    if (!gambitTP(ev.state, SP.blessingsOfInfection)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.step !== 'retention' || ev.type !== 'melee') return;
    const op = ev.operative;
    if (!mine(op)) return;
    const pool = seq.attackerId === op.id ? seq.attackerPool : seq.defenderId === op.id ? seq.defenderPool : undefined;
    if (!pool) return;
    const ledger = bucket(ev.state, `${SP.blessingsOfInfection}.used`);
    const stamp = `${seq.attackerId}:${seq.defenderId}:${op.id}`;
    if (ledger[stamp]) return;
    const fails = pool.dice.filter((d) => d.state === 'fail' && d.rolled).sort((a, b) => a.value - b.value);
    const normals = pool.dice.filter((d) => d.state === 'normal').sort((a, b) => b.value - a.value);
    const successes = pool.dice.filter((d) => d.state === 'crit' || d.state === 'normal').length;
    if (successes >= 3 && fails.length >= 1 && normals.length >= 1) {
      ledger[stamp] = true;
      const discarded = fails[0]!;
      const promoted = normals[0]!;
      discarded.state = 'discarded';
      discarded.note = 'BLESSINGS OF INFECTION';
      promoted.state = 'crit';
      promoted.note = 'BLESSINGS OF INFECTION';
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `BLESSINGS OF INFECTION: ${op.letter} discards a ${discarded.value} to retain a normal success as a critical success`,
      });
      return;
    }
    if (fails.length >= 3) {
      ledger[stamp] = true;
      const discarded = fails[0]!;
      const retained = fails[fails.length - 1]!;
      discarded.state = 'discarded';
      discarded.note = 'BLESSINGS OF INFECTION';
      retained.state = 'normal';
      retained.note = 'BLESSINGS OF INFECTION';
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `BLESSINGS OF INFECTION: ${op.letter} discards a ${discarded.value} to retain the ${retained.value} as a normal success`,
      });
    }
  });

  // =========================================================================
  // RUST EMANATIONS (strategy, 1CP)
  // =========================================================================
  /*
   * "Whenever a friendly GELLERPOX INFECTED NIGHTMARE HULK operative is fighting, your opponent
   *  cannot retain results of 3 as successes."
   *
   * `addRolled` classifies against the Hit stat with no seam for "cannot retain x", so the
   * opponent's already-rolled pool is re-read at every post-roll `onWeaponRules` emit — which
   * lands before their re-roll offer is built and again at the retention step. Idempotent.
   */
  reg.on('onWeaponRules', T.bind(SP.rustEmanations, 20), (ev) => {
    if (!gambitTP(ev.state, SP.rustEmanations)) return;
    const seq = fightSeq(ev.state);
    if (!seq || ev.type !== 'melee') return;
    if (seq.step !== 'attackerRerolls' && seq.step !== 'defenderRerolls' && seq.step !== 'retention') return;
    const hulk = ev.state.operatives[seq.attackerId];
    if (!hulk || !mine(hulk) || !isHulk(T, hulk)) return; // "is FIGHTING" — the Fight action's actor
    const foe = ev.state.operatives[seq.defenderId];
    if (!foe || foe.player === T.player) return;
    if (ev.operative.id !== foe.id) return;
    let demoted = 0;
    for (const die of seq.defenderPool.dice) {
      if (!die.rolled || die.value !== 3) continue;
      if (die.state !== 'normal' && die.state !== 'crit') continue;
      die.state = 'fail';
      die.note = 'RUST EMANATIONS';
      demoted++;
    }
    if (demoted > 0)
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `RUST EMANATIONS: ${foe.letter} cannot retain ${demoted} result(s) of 3 as successes`,
      });
  });

  // =========================================================================
  // REVOLTING TECHNOLOGY (firefight, 1CP)
  // =========================================================================
  /*
   * "Use this firefight ploy when an enemy operative is shooting a friendly GELLERPOX INFECTED
   *  operative. That operative's ranged weapons have the Hot weapon rule until the end of that
   *  sequence…"
   *
   * The engine opens no ploy window inside a shoot sequence, so the ploy is declared in advance
   * and claims the NEXT qualifying enemy shot (the Mandrakes SHADOW'S BITE shape). The claim is
   * taken at `onSelectWeapon`, which `startShoot` emits exactly once per shot (D-032: the Shoot
   * action's dry run must never spend it).
   */
  reg.on('onPloyUsed', T.bind(FP.revoltingTechnology, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.revoltingTechnology) return;
    effect(ev.state, {
      rule: REVOLTING_ARMED,
      source: { kind: 'ploy', id: FP.revoltingTechnology },
      sourceText: shortQuote(text(FP.revoltingTechnology)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onSelectWeapon', T.bind(FP.revoltingTechnology, 20), (ev) => {
    if (ev.dryRun) return; // D-032 — a `check` is a query the AI runs many times per turn
    const eff = effectFor(ev.state, T.player, REVOLTING_ARMED);
    if (!eff) return;
    // "until the end of that sequence": `startShoot` emits this exactly once per shot, so the
    // next shot to begin — anyone's — is the end of the claimed one.
    if (eff.data?.['claim']) {
      dropEffects(ev.state, (e) => e.rule === REVOLTING_ARMED && e.player === T.player);
      return;
    }
    const shooter = ev.ctx.attacker;
    const target = ev.ctx.defender;
    if (shooter.player === T.player || !target || !mine(target)) return;
    eff.data = { ...(eff.data ?? {}), claim: `${shooter.id}:${target.id}` };
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `REVOLTING TECHNOLOGY: ${shooter.letter}'s ranged weapons have Hot for this sequence`,
    });
  });
  reg.on('onWeaponRules', T.bind(FP.revoltingTechnology, 20), (ev) => {
    if (ev.type !== 'ranged') return;
    const eff = effectFor(ev.state, T.player, REVOLTING_ARMED);
    const claim = eff?.data?.['claim'];
    if (typeof claim !== 'string') return;
    const seq = shootSeq(ev.state);
    if (!seq || !claim.startsWith(`${seq.attackerId}:`)) return;
    if (ev.operative.id !== seq.attackerId) return;
    if (!ev.rules.some((r) => r.id === 'Hot')) ev.rules.push(ruleTag('Hot', undefined, 'Hot (REVOLTING TECHNOLOGY)'));
  });

  // =========================================================================
  // PUTRESCENT DEMISE (firefight, 1CP)
  // =========================================================================
  /*
   * "Use this firefight ploy when a friendly GELLERPOX INFECTED operative (excluding MUTOID
   *  VERMIN) is incapacitated, before it's removed from the killzone. Inflict 1 damage (or D3
   *  damage instead if that friendly operative is a NIGHTMARE HULK) on each enemy operative
   *  visible to and within 2" of that friendly operative."
   *
   * Declared in advance and fired on its printed trigger (the same in-sequence ploy window).
   */
  reg.on('onPloyUsed', T.bind(FP.putrescentDemise, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.putrescentDemise) return;
    effect(ev.state, {
      rule: PUTRESCENT_ARMED,
      source: { kind: 'ploy', id: FP.putrescentDemise },
      sourceText: shortQuote(text(FP.putrescentDemise)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onIncapacitated', T.bind(FP.putrescentDemise, 41), (ev) => {
    const op = ev.operative;
    if (ev.prevented || !mine(op) || isVermin(T, op) || !T.ctx) return;
    const eff = effectFor(ev.state, T.player, PUTRESCENT_ARMED);
    if (!eff) return;
    dropEffects(ev.state, (e) => e.rule === PUTRESCENT_ARMED && e.player === T.player);
    const index = terrain(T.ctx, ev.state);
    for (const foe of T.enemies(ev.state).sort(byId)) {
      if (T.gap(op, foe) > 2 + EPS) continue;
      if (!isVisible(index, body(T.ctx, op), body(T.ctx, foe)).visible) continue;
      const damage = isHulk(T, op) ? T.ctx.rng.d3() : 1;
      if (isHulk(T, op)) recordRoll(ev.state, 'putrescentDemise', [damage], T.player, 'PUTRESCENT DEMISE D3');
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `PUTRESCENT DEMISE: ${op.letter} bursts for ${damage} on ${foe.letter}`,
      });
      inflictDamage(T.ctx, ev.state, foe, damage, 'other');
    }
  });

  // =========================================================================
  // BARGE (firefight, 1CP)
  // =========================================================================
  /*
   * "Use this firefight ploy during a friendly GELLERPOX INFECTED NIGHTMARE HULK operative's
   *  activation or counteraction, before or after it performs an action. During that
   *  activation/counteraction:
   *    It can move through enemy operatives and within control range of them.
   *    It can perform the Charge and Reposition actions while within control range of an enemy
   *    operative, and can leave that operative's control range to do so (but then normal
   *    requirements for that move apply)."
   *
   * The first bullet used to be a no-op by construction, because `validateMove` tested only the
   * END of a path for base overlap and control range — so every operative in the game could
   * already move through and within enemy control range. Since the rules review a path is
   * checked along its length, so the permission is granted through `onMovePermissions`. The
   * second bullet is two `treatedAs` ActionDefs (D-021), because `canPerformAction` can only
   * forbid.
   */
  reg.on('onPloyUsed', T.bind(FP.barge, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.barge) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !mine(active) || !isHulk(T, active)) return;
    effect(ev.state, {
      rule: BARGE_EFFECT,
      source: { kind: 'ploy', id: FP.barge },
      sourceText: shortQuote(text(FP.barge)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `BARGE: ${active.letter} can shoulder its way clear` });
  });

  // "It can move through enemy operatives and within control range of them." Until the rules
  // review `validateMove` checked neither along a path, so this permission cost nothing to
  // grant; now it is the difference between BARGE working and not.
  reg.on('onMovePermissions', T.bind(FP.barge, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, BARGE_EFFECT)) return;
    ev.mayEnterEnemyControlRange = true;
    ev.mayMoveThroughEnemies = true;
  });

  // =========================================================================
  // FRIGHTENING ONSLAUGHT (firefight, 1CP)
  // =========================================================================
  /*
   * "Use this firefight ploy after a friendly GELLERPOX INFECTED NIGHTMARE HULK operative
   *  performs the Fight action, if it isn't incapacitated. It can immediately perform a free
   *  Fight action (you don't have to select the same enemy operative to fight against). This
   *  takes precedence over action restrictions."
   *
   * Its own 0AP `ActionDef` with no `treatedAs`, which is what makes "takes precedence over
   * action restrictions" work while every other Fight condition still applies (D-021).
   */
  reg.on('onPloyUsed', T.bind(FP.frighteningOnslaught, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.frighteningOnslaught) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !mine(active) || !isHulk(T, active)) return;
    effect(ev.state, {
      rule: ONSLAUGHT_ARMED,
      source: { kind: 'ploy', id: FP.frighteningOnslaught },
      sourceText: shortQuote(text(FP.frighteningOnslaught)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `FRIGHTENING ONSLAUGHT: ${active.letter} strikes again` });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/**
 * The MUTOID VERMIN the faction equipment adds, read out of the printed selection group it gates
 * ("Specified number of GELLERPOX INFECTED operatives selected from the following list: CURSEMITE
 * / EYESTINGER SWARM / SLUDGE-GRUB"), never retyped.
 */
export const VERMIN_ROWS: string[] = DATA.selection.list
  .filter((e) => e.group === 2)
  .map((e) => e.datacardId);

/** "add four GELLERPOX INFECTED MUTOID VERMIN operatives to your kill team for the battle." */
export const MUTOID_VERMIN_COUNT = 4;

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // MUTOID VERMIN
  // =========================================================================
  /*
   * "After revealing this equipment option, add four GELLERPOX INFECTED MUTOID VERMIN operatives
   *  to your kill team for the battle."
   *
   * The printed selection list gates its MUTOID VERMIN group on this equipment ("If you selected
   * the MUTOID VERMIN faction equipment:") — a `kind: 'custom'` constraint the shared validator
   * cannot express — and the scraper gave that group `count: 1` rather than the four printed
   * here. So this TOPS THE KILL TEAM UP to four: the vermin already picked from that gated group
   * ARE the ones this equipment added, and the printed 11 + 4 total is reached exactly. Which
   * datacards fill the remainder is a deterministic, logged default (D-016) — the printed list
   * order, preferring rows the kill team does not already field.
   *
   * `team.startingSize` is deliberately left alone: "…and when determining your starting number
   * of operatives" is exactly the printed carve-out.
   */
  reg.on('onSelectEquipment', T.bind(EQ.mutoidVermin, 30), (ev) => {
    if (ev.player !== T.player || !ev.equipment.includes(EQ.mutoidVermin) || !T.ctx) return;
    const done = bucket(ev.state, VERMIN_BAG);
    if (done[T.player]) return;
    done[T.player] = true;
    const team = ev.state.teams[T.player];
    const already = team.operativeIds
      .map((id) => ev.state.operatives[id])
      .filter((o): o is OperativeState => Boolean(o) && isVermin(T, o!));
    const toAdd = MUTOID_VERMIN_COUNT - already.length;
    if (toAdd <= 0) return;
    const have = new Set(already.map((o) => o.datacardId));
    const order = [...VERMIN_ROWS.filter((id) => !have.has(id)), ...VERMIN_ROWS];
    for (let n = 0; n < toAdd; n++) {
      const datacardId = order[n % order.length]!;
      const dc = T.ctx.datacards.get(datacardId);
      if (!dc) continue;
      const i = team.operativeIds.length;
      const id = `${T.player}-vermin-${n}`;
      ev.state.operatives[id] = {
        id,
        player: T.player,
        datacardId,
        letter: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : ''),
        pos: { x: -100, y: -100 }, // undeployed: the setup step places it like any other operative
        z: 0,
        rot: 0,
        order: 'conceal',
        ready: false,
        expended: false,
        counteractedThisTP: false,
        wounds: dc.wounds,
        apSpent: 0,
        actionsThisActivation: [],
        onGuard: false,
        guardSpentTP: null,
        aplMods: [],
        weaponUses: {},
        stickyEngagedWith: [],
      };
      team.operativeIds.push(id);
      log(ev.state, {
        kind: 'system',
        player: T.player,
        text: `MUTOID VERMIN: ${dc.name} joins the kill team`,
        data: { operativeId: id, datacardId },
      });
    }
  });

  // =========================================================================
  // MUTATED SYMPTOMS
  // =========================================================================
  /*
   * "Once per battle, when you activate a friendly GELLERPOX INFECTED operative, you can select
   *  one additional TECHNO-CURSE for that operative to gain until the end of the turning point
   *  (it must be different from your existing TECHNO-CURSE)."
   *
   * Nothing is emitted when a player would make that selection, so it is auto-used under D-022 on
   * a stated policy: the first activation of a friendly GELLERPOX INFECTED operative (excluding
   * MUTOID VERMIN, so the aura carrier is a legal one) that has an enemy within 4" — the widest
   * printed infection range — taking the next curse in printed order after the selected one.
   */
  reg.on('onActivationStart', T.bind(EQ.mutatedSymptoms, 30), (ev) => {
    const op = ev.operative;
    if (!mine(op) || isVermin(T, op)) return;
    if (!hasEquipment(ev.state, T.player, EQ.mutatedSymptoms)) return;
    if (usedThisBattle(ev.state, `gellerpox.mutatedSymptoms:${T.player}`)) return;
    const selected = technoCurseOf(ev.state, T.player);
    if (!selected) return;
    if (!T.enemies(ev.state).some((e) => T.gap(op, e) <= 4 + EPS)) return;
    const extra = CURSES.filter((c) => c !== selected)[0]!;
    if (!useOncePerBattle(ev.state, `gellerpox.mutatedSymptoms:${T.player}`)) return;
    effect(ev.state, {
      rule: ADDITIONAL_CURSE,
      source: { kind: 'equipment', id: EQ.mutatedSymptoms },
      sourceText: shortQuote(text(EQ.mutatedSymptoms)),
      operativeId: op.id,
      player: T.player,
      data: { curse: extra },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `MUTATED SYMPTOMS: ${op.letter} also carries ${CURSE_NAME[extra]}`,
      data: { curse: extra },
    });
  });

  // =========================================================================
  // POLLUTED STOCKPILE
  // =========================================================================
  /*
   * "After revealing this equipment option, roll 2D6: on a 7+, remove one of your opponent's
   *  selected equipment options; otherwise, that player removes one of their own selected
   *  equipment options. They cannot select that equipment again during the game sequence… You
   *  cannot select this equipment option after the Select Operatives step."
   *
   * The last sentence cannot be refused (the reducer commits SelectEquipment before the hook and
   * the event carries no `allowed`), so the CONSEQUENCE is enforced: nothing happens once setup
   * is done. Which option goes is a deterministic, logged default (D-016) — on a 7+ the first in
   * their list (your choice), otherwise their last (theirs). The roll happens once, and it is
   * applied to the opponent's list whenever that list next exists.
   */
  const applyStockpile = (state: GameState): void => {
    const bag = bucket(state, STOCKPILE_BAG);
    const roll = bag[`${T.player}.roll`];
    if (typeof roll !== 'number' || bag[`${T.player}.done`]) return;
    const foe = otherPlayer(T.player);
    const list = state.teams[foe].equipment;
    if (list.length === 0) return;
    const removed = roll >= 7 ? list[0]! : list[list.length - 1]!;
    state.teams[foe].equipment = list.filter((id) => id !== removed);
    bag[`${T.player}.done`] = true;
    const banned = (bag[`${T.player}.banned`] as string[] | undefined) ?? [];
    bag[`${T.player}.banned`] = [...banned, removed];
    log(state, {
      kind: 'system',
      player: T.player,
      text: `POLLUTED STOCKPILE (${roll}): ${removed} is removed from your opponent's equipment`,
      data: { removed, roll },
    });
  };
  reg.on('onSelectEquipment', T.bind(EQ.pollutedStockpile, 30), (ev) => {
    const bag = bucket(ev.state, STOCKPILE_BAG);
    if (ev.player === T.player) {
      if (!ev.equipment.includes(EQ.pollutedStockpile) || !T.ctx) return;
      if (bag[`${T.player}.roll`] !== undefined) return;
      if (ev.state.setup.step === 'done') return; // "…cannot select this equipment after Select Operatives"
      const roll = T.ctx.rng.d6() + T.ctx.rng.d6();
      recordRoll(ev.state, 'pollutedStockpile', [roll], T.player, 'POLLUTED STOCKPILE 2D6');
      bag[`${T.player}.roll`] = roll;
      applyStockpile(ev.state);
      return;
    }
    // "They cannot select that equipment again during the game sequence."
    const banned = (bag[`${T.player}.banned`] as string[] | undefined) ?? [];
    if (banned.length > 0) {
      const kept = ev.state.teams[ev.player].equipment.filter((id) => !banned.includes(id));
      if (kept.length !== ev.state.teams[ev.player].equipment.length) {
        ev.state.teams[ev.player].equipment = kept;
        log(ev.state, {
          kind: 'system',
          player: T.player,
          text: 'POLLUTED STOCKPILE: that equipment cannot be selected again',
        });
      }
    }
    applyStockpile(ev.state);
  });

  // =========================================================================
  // PLAGUE BELLOWS
  // =========================================================================
  /*
   * "Whenever an operative is shooting a friendly GELLERPOX INFECTED NIGHTMARE HULK operative
   *  that's more than 6" from it, you can retain one of your defence dice results of 3 as a
   *  normal success instead of discarding it."
   *
   * `addRolled(seq.defence, results, save)` takes no `ClassifyOpts`, so the pool is re-read at the
   * post-roll `onDefenceDice` emit (the Ratlings IMPROVISED ARMOUR seam). Idempotent, and free, so
   * it is auto-used (D-022) — one die, the printed maximum.
   */
  reg.on('onDefenceDice', T.bind(EQ.plagueBellows, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.plagueBellows)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !mine(target) || !isHulk(T, target)) return;
    if (ev.ctx.distance <= 6 + EPS) return; // "that's more than 6" from it"
    if (seq.defence.dice.some((d) => d.note === 'PLAGUE BELLOWS')) return;
    const die = seq.defence.dice.find((d) => d.rolled && d.value === 3 && d.state === 'fail');
    if (!die) return;
    die.state = 'normal';
    die.note = 'PLAGUE BELLOWS';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `PLAGUE BELLOWS: ${target.letter} retains a 3 as a normal success`,
    });
  });
}

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs
// ---------------------------------------------------------------------------

function gambits(reg: HookRegistry, T: TeamHooks): void {
  defaultGambits(reg, T);

  /*
   * VULGRAR THRICE-CURSED › Spread the Glorious Gifts — "Once per battle STRATEGIC GAMBIT. Select
   *  one objective marker this operative controls to gain one of your Techno-curse tokens. It
   *  cannot be an objective marker within control range of an enemy operative. … You cannot use
   *  this STRATEGIC GAMBIT while this operative is within control range of an enemy operative."
   */
  reg.on('gambitOptions', T.bind(AB.spreadTheGifts, 15), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (usedThisBattle(ev.state, `gellerpox.spread:${T.player}`)) return;
    if (spreadTargets(T, ev.state).length === 0) return;
    ev.options.push({
      id: SPREAD_GAMBIT,
      label: 'Spread the Glorious Gifts: give an objective marker a Techno-curse token',
      sourceText: shortQuote(abilityText(CARD.vulgrar, AB.spreadTheGifts)),
    });
  });
  reg.on('onPloyUsed', T.bind(AB.spreadTheGifts, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SPREAD_GAMBIT || !T.ctx) return;
    const candidates = spreadTargets(T, ev.state);
    const asked = ev.data?.['markerId'];
    const marker =
      (typeof asked === 'string' ? candidates.find((m) => m === asked) : undefined) ?? candidates.sort()[0];
    if (!marker) return;
    if (!useOncePerBattle(ev.state, `gellerpox.spread:${T.player}`)) return;
    effect(ev.state, {
      rule: GIFT_TOKEN,
      source: { kind: 'ability', id: AB.spreadTheGifts },
      sourceText: shortQuote(abilityText(CARD.vulgrar, AB.spreadTheGifts)),
      player: T.player,
      data: { markerId: marker },
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Spread the Glorious Gifts: ${marker} gains a Techno-curse token`,
      data: { markerId: marker },
    });
  });
}

/** Objective markers VULGRAR controls that no enemy operative is within control range of. */
export function spreadTargets(T: TeamHooks, state: GameState): string[] {
  const ctx = T.ctx;
  if (!ctx) return [];
  const vulgrar = T.friendlies(state, KW).find((o) => o.datacardId === CARD.vulgrar);
  // "You cannot use this STRATEGIC GAMBIT while this operative is within control range of an
  //  enemy operative."
  if (!vulgrar || T.enemies(state).some((e) => inControlRange(ctx, state, vulgrar, e))) return [];
  return Object.values(state.markers)
    .filter((m) => m.kind === 'objective')
    .filter((m) => markerControllerIs(T, state, m.id))
    .filter((m) => !T.enemies(state).some((e) => markerContestedBy(ctx, state, m, e)))
    .map((m) => m.id)
    .sort();
}

function markerControllerIs(T: TeamHooks, state: GameState, markerId: string): boolean {
  const ctx = T.ctx;
  const marker = state.markers[markerId];
  if (!ctx || !marker) return false;
  const apl: Record<PlayerId, number> = { p1: 0, p2: 0 };
  for (const op of aliveOperatives(state)) {
    if (markerContestedBy(ctx, state, marker, op)) apl[op.player] += aplOfSafe(T, op);
  }
  return apl[T.player] > apl[otherPlayer(T.player)];
}

// ---------------------------------------------------------------------------
// Actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

const hasKw = (ctx: GameContext, op: OperativeState, keyword: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

const foesInControlRange = (ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player)).filter((e) => inControlRange(ctx, state, op, e));

/**
 * "Having only MUTOID VERMIN operatives within their control range doesn't prevent enemy
 *  operatives from performing the Charge, Dash and Reposition action."
 *
 * `canPerformAction` can only forbid, so the permission is three `treatedAs` siblings of the
 * universal actions (D-021), available to the operative facing the grubs — WITHOUT them a
 * 2-wound vermin would lock a whole kill team down, the exact opposite of the printed rule.
 * `src/ai/legal.ts` builds movement params for the four universal ids only, so a human uses
 * these and the AI does not.
 */
const onlyVerminEngage = (ctx: GameContext, state: GameState, op: OperativeState): boolean => {
  const foes = foesInControlRange(ctx, state, op);
  return foes.length > 0 && foes.every((f) => hasKw(ctx, f, 'MUTOID VERMIN'));
};

interface MoveCarveOut {
  id: string;
  delegate: 'Reposition' | 'Dash' | 'Charge';
  sourceText: string;
  available(ctx: GameContext, state: GameState, op: OperativeState): boolean;
}

function moveCarveOut(spec: MoveCarveOut): ActionDef {
  const opts = {
    Reposition: { action: 'Reposition' as const, mustNotFinishEngaged: true },
    Dash: { action: 'Dash' as const, noClimb: true, mustNotFinishEngaged: true },
    Charge: { action: 'Charge' as const, bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true },
  }[spec.delegate];
  return {
    id: spec.id,
    name: spec.id,
    ap: getAction(spec.delegate)?.ap ?? 1,
    type: 'unique',
    treatedAs: spec.delegate,
    sourceText: spec.sourceText,
    available: spec.available,
    check(ctx, state, op, params) {
      if (!spec.available(ctx, state, op)) return { ok: false, reason: 'this rule does not apply right now' };
      // Every universal restriction EXCEPT "while within control range of an enemy operative".
      if (spec.delegate === 'Reposition' && (did(op, 'Fall Back') || did(op, 'Charge')))
        return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      if (spec.delegate === 'Dash' && did(op, 'Charge'))
        return { ok: false, reason: 'already performed Charge this activation' };
      if (spec.delegate === 'Charge') {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, opts);
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform: (ctx, state, op, params) => getAction(spec.delegate)!.perform(ctx, state, op, params),
  };
}

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

function actions(): ActionDef[] {
  const swipeText = abilityText(CARD.bloatspawn, AB.swipe);
  const bargeText = text(FP.barge);
  const onslaughtText = text(FP.frighteningOnslaught);
  const verminText = text(RULE.mutoidVermin);

  const eligibleSwipeFoes = (ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] => {
    const fought = swipeLedger(state, op);
    return foesInControlRange(ctx, state, op)
      .filter((e) => !fought.includes(e.id))
      .sort(byId);
  };

  const swipeLinks: ActionDef[] = FIGHT_SWIPE.map((id) => ({
    id,
    name: id,
    ap: 0, // "it can immediately perform a free FIGHT action afterwards"
    type: 'unique' as const,
    sourceText: swipeText,
    // Gated here as well as in `check`, so the action sheet and `src/ai/legal.ts` only ever see
    // the links while the chain is actually running.
    available: (_ctx: GameContext, state: GameState, op: OperativeState) =>
      op.datacardId === CARD.bloatspawn && swipeLedger(state, op).length > 0,
    check(ctx: GameContext, state: GameState, op: OperativeState, params: Record<string, unknown>) {
      // "Whenever this operative performs the Fight action and you select this weapon profile…"
      if (swipeLedger(state, op).length === 0)
        return { ok: false, reason: 'Swipe follows a Fight action made with the swiping profile' };
      const eligible = eligibleSwipeFoes(ctx, state, op);
      if (eligible.length === 0)
        return { ok: false, reason: 'it has already fought every enemy operative within its control range' };
      const asked = params['targetId'] ?? params['targetOperativeId'];
      if (typeof asked === 'string' && !eligible.some((e) => e.id === asked))
        return { ok: false, reason: 'select an enemy operative within control range it has not swiped' };
      if (!(ctx.datacards.get(op.datacardId)?.weapons ?? []).some((w) => w.name === SWIPE_WEAPON))
        return { ok: false, reason: 'the swiping weapon profile is not on this datacard' };
      return { ok: true };
    },
    perform(ctx: GameContext, state: GameState, op: OperativeState, params: Record<string, unknown>) {
      const eligible = eligibleSwipeFoes(ctx, state, op);
      const asked = params['targetId'] ?? params['targetOperativeId'];
      const target = (typeof asked === 'string' ? eligible.find((e) => e.id === asked) : undefined) ?? eligible[0];
      if (!target) return { ok: false, reason: 'no enemy operative left to swipe' };
      return getAction('Fight')!.perform(ctx, state, op, {
        targetId: target.id,
        meleeWeaponName: SWIPE_WEAPON,
        meleeProfileName: SWIPE_PROFILE,
      });
    },
  }));

  const onslaught: ActionDef = {
    id: FIGHT_ONSLAUGHT,
    name: FIGHT_ONSLAUGHT,
    ap: 0,
    type: 'unique',
    sourceText: onslaughtText,
    available: (_ctx, state, op) => Boolean(effectOn(state, op.id, ONSLAUGHT_ARMED)),
    check(ctx, state, op, params) {
      if (!effectOn(state, op.id, ONSLAUGHT_ARMED))
        return { ok: false, reason: 'FRIGHTENING ONSLAUGHT has not been used for this operative' };
      if (!op.actionsThisActivation.some((a) => a === 'Fight' || (FIGHT_SWIPE as readonly string[]).includes(a)))
        return { ok: false, reason: 'it has not performed the Fight action this activation' };
      // `src/ai/legal.ts` offers friendly ids to any non-universal action and the universal
      // Fight's own `perform` takes `params.targetId` on trust, so the whole target check lives
      // here (D-026: whatever `check` accepts, `perform` must be able to complete).
      const asked = params.targetId ?? params.targetOperativeId;
      if (typeof asked === 'string') {
        const foe = state.operatives[asked];
        if (!foe || foe.removed || foe.incapacitated || foe.player === op.player)
          return { ok: false, reason: 'select an enemy operative within control range' };
        if (!foesInControlRange(ctx, state, op).some((e) => e.id === foe.id))
          return { ok: false, reason: 'that enemy operative is not within control range' };
      }
      return getAction('Fight')!.check(ctx, state, op, params);
    },
    perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
  };

  const bargeMoves: ActionDef[] = [
    moveCarveOut({
      id: REPOSITION_BARGE,
      delegate: 'Reposition',
      sourceText: bargeText,
      available: (_ctx, state, op) => Boolean(effectOn(state, op.id, BARGE_EFFECT)),
    }),
    moveCarveOut({
      id: CHARGE_BARGE,
      delegate: 'Charge',
      sourceText: bargeText,
      available: (_ctx, state, op) => Boolean(effectOn(state, op.id, BARGE_EFFECT)),
    }),
  ];

  const verminMoves: ActionDef[] = [
    moveCarveOut({ id: VERMIN_REPOSITION, delegate: 'Reposition', sourceText: verminText, available: onlyVerminEngage }),
    moveCarveOut({ id: VERMIN_DASH, delegate: 'Dash', sourceText: verminText, available: onlyVerminEngage }),
    moveCarveOut({ id: VERMIN_CHARGE, delegate: 'Charge', sourceText: verminText, available: onlyVerminEngage }),
  ];

  return [...swipeLinks, onslaught, ...bargeMoves, ...verminMoves];
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------


export const gellerpoxInfected = defineTeam({
  id: 'gellerpox-infected',
  rules,
  ploys,
  equipment,
  gambits,
  actions,
  rareRules: ['Engineered', 'Feast', 'Swipe'],
  ployUsable: {
    [FP.revoltingTechnology]: (state, player) =>
      aliveOperatives(state, player).length > 0
        ? { ok: true }
        : { ok: false, reason: 'no friendly GELLERPOX INFECTED operative is in the killzone' },
    [FP.putrescentDemise]: (state, player) =>
      aliveOperatives(state, player).some((o) => !catalogueHasKw(o, 'MUTOID VERMIN'))
        ? { ok: true }
        : { ok: false, reason: 'no friendly GELLERPOX INFECTED operative (excluding MUTOID VERMIN) is in the killzone' },
    [FP.barge]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && catalogueHasKw(active, 'NIGHTMARE HULK')
        ? { ok: true }
        : { ok: false, reason: 'use it during a friendly GELLERPOX INFECTED NIGHTMARE HULK operative’s activation' };
    },
    [FP.frighteningOnslaught]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player || !catalogueHasKw(active, 'NIGHTMARE HULK'))
        return { ok: false, reason: 'use it after a friendly GELLERPOX INFECTED NIGHTMARE HULK operative fights' };
      if (active.incapacitated || active.removed) return { ok: false, reason: 'that operative is incapacitated' };
      return active.actionsThisActivation.some((a) => a === 'Fight' || (FIGHT_SWIPE as readonly string[]).includes(a))
        ? { ok: true }
        : { ok: false, reason: 'it has not performed the Fight action this activation' };
    },
  },
  aiHints: {
    roles: {
      [CARD.vulgrar]: 'leader',
      [CARD.bloatspawn]: 'melee',
      [CARD.fleshscreamer]: 'melee',
      [CARD.lumberghast]: 'melee',
      [CARD.mutant]: 'objective',
      [CARD.glitchling]: 'objective',
      [CARD.cursemite]: 'melee',
      [CARD.eyestinger]: 'support',
      [CARD.sludgeGrub]: 'gunner',
    },
    ployValue: {
      // Spread the Glorious Gifts is free, permanent and switches a second TECHNO-CURSE effect
      // on for the rest of the battle, so it is priced above every paid ploy (the Canoptek
      // OBELISK NODE placement precedent).
      [SPREAD_GAMBIT]: 2,
      [SP.plagueriddenDetermination]: 0.5,
      [SP.drawnToTheHum]: 0.35,
      [SP.blessingsOfInfection]: 0.7,
      [SP.rustEmanations]: 0.55,
      [FP.revoltingTechnology]: 0.45,
      [FP.putrescentDemise]: 0.5,
      // BARGE and FRIGHTENING ONSLAUGHT resolve through ActionDefs `src/ai/legal.ts` can only
      // reach for the Fight variant, so the movement one is priced low rather than at zero.
      [FP.barge]: 0.2,
      [FP.frighteningOnslaught]: 0.75,
    },
    equipmentValue: {
      [EQ.mutoidVermin]: 0.9,
      [EQ.mutatedSymptoms]: 0.5,
      [EQ.pollutedStockpile]: 0.4,
      [EQ.plagueBellows]: 0.55,
    },
  },
});

/** Keyword test against the static catalogue, for the `usable` predicates (no context there). */
function catalogueHasKw(op: OperativeState, keyword: string): boolean {
  const card = DATA.datacards.find((c) => c.id === op.datacardId);
  return (card?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());
}

export default gellerpoxInfected;
