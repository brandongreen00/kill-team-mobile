/**
 * HAND OF THE ARCHON — Drukhari kabalite raiders.
 * https://wahapedia.ru/kill-team3/kill-teams/hand-of-the-archon/
 *
 * Nine datacards, twelve abilities, three unique actions, three faction rules.
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read from `data/teams/hand-of-the-archon.json` at module load and never retyped. Two printed
 * structures are MENUS with no ids of their own, so they are sliced out of the text they are
 * printed inside (the Legionary "Marks of Chaos" / Warpcoven BOONS treatment):
 *
 *   1. the four INVIGORATIONS (`INVIGORATION_TEXT`), printed as one faction rule, and
 *   2. the three COMBAT DRUG rules (`DRUG_TEXT`), printed inside the ELIXICANT's ability.
 *
 * The whole team hangs off ONE economy — **Pain tokens** — which `painOf`/`gainPain`/`spendPain`
 * own. Power From Pain hands them out, seven other rules read or write them, and the four
 * invigorations spend them.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { lethalThreshold, rerollDie, type DicePool } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  findProfile,
  hitOf,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
  saveOf,
  weaponsOf,
} from '../../core/state.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import { whoActivates } from '../../core/phases.ts';
import { interveningParts, isVisible } from '../../core/visibility.ts';
import { hasType } from '../../core/terrain.ts';
import { baseGapToPoly } from '../../core/geometry.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  aplOf,
  bucket,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  notEngaged,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('hand-of-the-archon');
const KW = 'HAND OF THE ARCHON';
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Printed ids
// ---------------------------------------------------------------------------

export const C = {
  archsybarite: 'hand-of-the-archon.kabalite-archsybarite',
  agent: 'hand-of-the-archon.kabalite-agent',
  duellist: 'hand-of-the-archon.kabalite-crimson-duellist',
  disciple: 'hand-of-the-archon.kabalite-disciple-of-yaelindra',
  elixicant: 'hand-of-the-archon.kabalite-elixicant',
  flayer: 'hand-of-the-archon.kabalite-flayer',
  gunner: 'hand-of-the-archon.kabalite-gunner',
  heavyGunner: 'hand-of-the-archon.kabalite-heavy-gunner',
  assassin: 'hand-of-the-archon.kabalite-skysplinter-assassin',
} as const;

export const RULE = {
  powerFromPain: 'hand-of-the-archon.rule.power-from-pain',
  invigorations: 'hand-of-the-archon.rule.invigorations',
  rifles: 'hand-of-the-archon.rule.rifles',
} as const;

export const SP = {
  bladeArtists: 'hand-of-the-archon.sp.blade-artists',
  fromDarknessDeath: 'hand-of-the-archon.sp.from-darkness-death',
  mercilessSadists: 'hand-of-the-archon.sp.merciless-sadists',
  denizensOfNight: 'hand-of-the-archon.sp.denizens-of-night',
} as const;

export const FP = {
  cruelDeception: 'hand-of-the-archon.fp.cruel-deception',
  heinousArrogance: 'hand-of-the-archon.fp.heinous-arrogance',
  deviousScheme: 'hand-of-the-archon.fp.devious-scheme',
  preyOnTheWounded: 'hand-of-the-archon.fp.prey-on-the-wounded',
} as const;

export const EQ = {
  chainSnare: 'hand-of-the-archon.eq.chain-snare',
  toxinCoating: 'hand-of-the-archon.eq.toxin-coating',
  wickedBlades: 'hand-of-the-archon.eq.wicked-blades',
  refinedPoison: 'hand-of-the-archon.eq.refined-poison',
} as const;

export const A = {
  cunning: 'hand-of-the-archon.kabalite-archsybarite.cunning',
  torturousVision: 'hand-of-the-archon.kabalite-archsybarite.torturous-vision',
  sadisticCompetition: 'hand-of-the-archon.kabalite-agent.sadistic-competition',
  brutalDisplay: 'hand-of-the-archon.kabalite-crimson-duellist.brutal-display',
  crimsonDuellist: 'hand-of-the-archon.kabalite-crimson-duellist.crimson-duellist',
  tangle: 'hand-of-the-archon.kabalite-crimson-duellist.tangle',
  stinger: 'hand-of-the-archon.kabalite-disciple-of-yaelindra.stinger',
  combatDrugs: 'hand-of-the-archon.kabalite-elixicant.combat-drugs',
  insensibleToPain: 'hand-of-the-archon.kabalite-flayer.insensible-to-pain',
  flay: 'hand-of-the-archon.kabalite-flayer.flay',
  mercilessHunter: 'hand-of-the-archon.kabalite-skysplinter-assassin.merciless-hunter',
  omen: 'hand-of-the-archon.kabalite-skysplinter-assassin.omen',
} as const;

export const ACT = {
  tormentGrenade: 'hand-of-the-archon.kabalite-disciple-of-yaelindra.act.torment-grenade',
  administerDrug: 'hand-of-the-archon.kabalite-elixicant.act.administer-drug',
  mark: 'hand-of-the-archon.kabalite-skysplinter-assassin.act.mark',
} as const;

/** The two carve-out actions (docs/DECISIONS.md D-021). */
export const DUELLIST_FIGHT = 'Fight (Crimson Duellist)';
export const HUNTER_SHOOT = 'Shoot (Merciless Hunter)';
export const SURGE_DASH = 'Dash (Vitalised Surge)';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const shootSeq = (state: GameState): ShootSequence | null =>
  state.sequence?.kind === 'shoot' ? state.sequence : null;
const fightSeq = (state: GameState): FightSequence | null =>
  state.sequence?.kind === 'fight' ? state.sequence : null;

/**
 * A fingerprint for "this sequence", which the engine gives no id of its own. The pair alone is
 * not enough — the CRIMSON DUELLIST fights the same enemy twice in one activation — so the
 * attacker's action counters are folded in.
 */
function fightKey(state: GameState, seq: FightSequence): string {
  const attacker = state.operatives[seq.attackerId];
  return `${seq.attackerId}:${seq.defenderId}:${attacker?.actionsThisActivation.length ?? 0}:${attacker?.apSpent ?? 0}`;
}

// ---------------------------------------------------------------------------
// Pain tokens — the team's one economy
// ---------------------------------------------------------------------------

/** "…it gains one of your Pain tokens." A token is an effect on the operative that holds it. */
export const PAIN = 'handOfTheArchon.pain';
/** TORMENT GRENADE's own token, which is a different thing entirely. */
export const POISON = 'handOfTheArchon.poison';

export function painOf(state: GameState, op: OperativeState): number {
  return state.effects.filter((e) => e.rule === PAIN && e.operativeId === op.id && e.player === op.player).length;
}

/**
 * "…it gains one of your Pain tokens", plus the AGENT's Sadistic Competition, which is printed
 * as a rider on every gain: "Once per turning point, when a friendly HAND OF THE ARCHON
 * operative gains one of your Pain tokens, one friendly HAND OF THE ARCHON AGENT operative that
 * doesn't have one of your Pain tokens can also gain one." It is free, so it is auto-used on the
 * printed trigger (D-022); the once-per-turning-point claim is taken before the second gain, so
 * the AGENT's own token cannot re-enter this.
 */
function gainPain(T: TeamHooks, state: GameState, op: OperativeState, n: number, sourceId: string): void {
  if (n <= 0 || op.removed) return;
  for (let i = 0; i < n; i++) {
    effect(state, {
      rule: PAIN,
      source: { kind: 'ability', id: sourceId },
      sourceText: shortQuote(text(RULE.powerFromPain)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfBattle' },
    });
  }
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} gains ${n === 2 ? 'two Pain tokens' : 'a Pain token'} (${painOf(state, op)} held)`,
    data: { operativeId: op.id, source: sourceId },
  });
  sadisticCompetition(T, state, op);
}

function sadisticCompetition(T: TeamHooks, state: GameState, gainer: OperativeState): void {
  if (gainer.player !== T.player) return;
  const agent = T.friendlies(state).find(
    (o) => o.datacardId === C.agent && !o.removed && o.id !== gainer.id && painOf(state, o) === 0,
  );
  if (!agent) return;
  if (!useOncePerTP(state, `hota.sadisticCompetition.${T.player}`)) return;
  gainPain(T, state, agent, 1, A.sadisticCompetition);
}

function spendPain(state: GameState, op: OperativeState, n = 1): boolean {
  const held = state.effects.filter((e) => e.rule === PAIN && e.operativeId === op.id && e.player === op.player);
  if (held.length < n) return false;
  const drop = new Set(held.slice(0, n).map((e) => e.id));
  dropEffects(state, (e) => drop.has(e.id));
  return true;
}

// ---------------------------------------------------------------------------
// Invigorations (faction rule 2) — a MENU with no printed ids
// ---------------------------------------------------------------------------

export const INVIGORATIONS = [
  'dark-animus',
  'accelerated-rejuvenation',
  'vitalised-surge',
  'stimulated-senses',
] as const;
export type Invigoration = (typeof INVIGORATIONS)[number];

export const INVIGORATION_NAME: Record<Invigoration, string> = {
  'dark-animus': 'Dark Animus',
  'accelerated-rejuvenation': 'Accelerated Rejuvenation',
  'vitalised-surge': 'Vitalised Surge',
  'stimulated-senses': 'Stimulated Senses',
};

/**
 * The four invigorations are printed inside the one Invigorations faction rule as
 * `<name>\nWhen: …\nEffect: …`, with no ids of their own, so each one's printed text is sliced
 * out of that string here rather than being retyped (CLAUDE.md: rule text is data).
 */
export const INVIGORATION_TEXT: Record<Invigoration, string> = sliceInvigorations();

function sliceInvigorations(): Record<Invigoration, string> {
  const whole = text(RULE.invigorations);
  const marks = INVIGORATIONS.map((id) => {
    const name = INVIGORATION_NAME[id];
    const at = whole.startsWith(`${name}\n`) ? 0 : whole.indexOf(`\n${name}\n`);
    return { id, name, at: at < 0 ? -1 : at, from: (at === 0 ? 0 : at + 1) + name.length };
  });
  const out = {} as Record<Invigoration, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0)
      throw new Error(`Invigoration '${mark.name}' is not in data/teams/hand-of-the-archon.json`);
    const to = marks[i + 1]?.at ?? whole.length;
    out[mark.id] = whole.slice(mark.from, to < 0 ? whole.length : to).trim();
  });
  return out;
}

/** One invigoration per activation/counteraction; Stimulated Senses has its own allowance. */
const EFF = {
  invigoration: 'handOfTheArchon.invigorationUsed',
  stimulated: 'handOfTheArchon.stimulatedUsed',
  darkAnimus: 'handOfTheArchon.darkAnimus',
  torturousVision: 'handOfTheArchon.torturousVision',
  brutalDisplay: 'handOfTheArchon.brutalDisplay',
  fromDarkness: 'handOfTheArchon.fromDarkness',
  cruelDeception: 'handOfTheArchon.cruelDeception',
  deviousScheme: 'handOfTheArchon.deviousScheme',
  mark: 'handOfTheArchon.mark',
  refinedPoison: 'handOfTheArchon.refinedPoison',
  toxinCoating: 'handOfTheArchon.toxinCoating',
  chainSnare: 'handOfTheArchon.chainSnare',
  rangedThisActivation: 'handOfTheArchon.rangedThisActivation',
} as const;

/**
 * "You cannot use more than one invigoration per activation or counteraction, except Stimulated
 * Senses, which can be used once per activation or counteraction in addition to another
 * invigorations." Both allowances are effects on the operative that expire with its activation
 * (a counteraction ends through the same `EndActivation` intent).
 */
function claimInvigoration(state: GameState, op: OperativeState, which: Invigoration): boolean {
  const rule = which === 'stimulated-senses' ? EFF.stimulated : EFF.invigoration;
  if (effectOn(state, op.id, rule)) return false;
  if (!spendPain(state, op)) return false;
  effect(state, {
    rule,
    source: { kind: 'ability', id: RULE.invigorations },
    sourceText: shortQuote(INVIGORATION_TEXT[which]),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `${op.letter} spends a Pain token on ${INVIGORATION_NAME[which]}`,
    data: { operativeId: op.id, invigoration: which },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Combat drugs (ELIXICANT) — a second MENU with no printed ids
// ---------------------------------------------------------------------------

export const DRUGS = ['painbringer', 'adrenalight', 'hypex'] as const;
export type Drug = (typeof DRUGS)[number];
export const DRUG_NAME: Record<Drug, string> = {
  painbringer: 'Painbringer',
  adrenalight: 'Adrenalight',
  hypex: 'Hypex',
};

/** "select one of the following COMBAT DRUG rules" — sliced out of the ELIXICANT's ability. */
export const DRUG_TEXT: Record<Drug, string> = sliceDrugs();

function sliceDrugs(): Record<Drug, string> {
  const whole = abilityText(C.elixicant, A.combatDrugs);
  const marks = DRUGS.map((id) => ({ id, at: whole.indexOf(`${DRUG_NAME[id]}:`) }));
  const out = {} as Record<Drug, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0) throw new Error(`COMBAT DRUG '${DRUG_NAME[mark.id]}' is not in data/teams/hand-of-the-archon.json`);
    const to = marks[i + 1]?.at ?? whole.length;
    out[mark.id] = whole.slice(mark.at, to < 0 ? whole.length : to).trim();
  });
  return out;
}

interface DrugStore {
  team?: Record<string, Drug>;
  op?: Record<string, Drug>;
}

const drugStore = (state: GameState): DrugStore => bucket(state, 'handOfTheArchon.drugs') as DrugStore;

/**
 * "At the end of the Select Operatives step, if this operative is selected for deployment,
 * select one of the following COMBAT DRUG rules for friendly HAND OF THE ARCHON operatives to
 * have for the battle."
 *
 * Select Operatives has no decision channel (docs/TEAM-STATUS.md › Known engine gaps), so the
 * choice is made through this pure setter (D-017). Nothing applies until it is called.
 */
export function setCombatDrug(state: GameState, player: PlayerId, drug: Drug): { ok: boolean; reason?: string } {
  if (!DRUGS.includes(drug)) return { ok: false, reason: `no COMBAT DRUG '${drug}'` };
  const store = drugStore(state);
  store.team = { ...(store.team ?? {}), [player]: drug };
  log(state, { kind: 'system', player, text: `COMBAT DRUG: ${DRUG_NAME[drug]}` });
  return { ok: true };
}

/** ADMINISTER DRUG: "Select a different COMBAT DRUG rule for it to have for the battle." */
export function setOperativeDrug(state: GameState, op: OperativeState, drug: Drug): void {
  const store = drugStore(state);
  store.op = { ...(store.op ?? {}), [op.id]: drug };
}

export function drugOf(state: GameState, op: OperativeState): Drug | undefined {
  const store = drugStore(state);
  return store.op?.[op.id] ?? store.team?.[op.player];
}

// ---------------------------------------------------------------------------
// Omen (SKYSPLINTER ASSASSIN)
// ---------------------------------------------------------------------------

/**
 * "In the Select Operatives step, when you're selecting equipment, you can select one enemy
 * operative or one other friendly HAND OF THE ARCHON operative (reveal your selection when you
 * reveal equipment)." `onSelectEquipment` carries no channel for naming an operative, so the
 * selection is a pure setter (D-017) — nothing applies until it is called.
 */
export function setOmen(state: GameState, player: PlayerId, operativeId: string): { ok: boolean; reason?: string } {
  const op = state.operatives[operativeId];
  if (!op) return { ok: false, reason: 'no such operative' };
  const store = bucket(state, 'handOfTheArchon.omen') as Record<string, string>;
  store[player] = operativeId;
  log(state, { kind: 'system', player, text: `Omen: ${op.letter}` });
  return { ok: true };
}

export function omenTarget(state: GameState, player: PlayerId): OperativeState | undefined {
  const id = (bucket(state, 'handOfTheArchon.omen') as Record<string, string>)[player];
  return id ? state.operatives[id] : undefined;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * The friendly HAND OF THE ARCHON operative whose action this is. Power From Pain pays the
 * operative that PERFORMED the action, so a kill made while retaliating pays nobody.
 */
function actingFriendly(T: TeamHooks, state: GameState): OperativeState | undefined {
  const seq = state.sequence;
  if (seq) {
    const attacker = state.operatives[seq.attackerId];
    if (attacker && !attacker.removed && T.mineKw(attacker, KW)) return attacker;
    return undefined;
  }
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return active && !active.removed && T.mineKw(active, KW) ? active : undefined;
}

/**
 * "after a friendly operative performs an action" — nothing runs at the end of an action
 * (docs/TEAM-STATUS.md › Known engine gaps), so the token is handed out at the moment the enemy
 * is injured or incapacitated and this fingerprint keeps one action to one payout.
 */
function claimAction(state: GameState, op: OperativeState, key: string): boolean {
  const b = bucket(state, 'handOfTheArchon.perAction') as Record<string, string>;
  const stamp = `${state.turningPoint}|${state.activationsThisTP}|${op.id}|${op.actionsThisActivation.length}|${op.apSpent}`;
  if (b[key] === stamp) return false;
  b[key] = stamp;
  return true;
}

const isWoundedOp = (T: TeamHooks, op: OperativeState): boolean => op.wounds < (T.card(op)?.wounds ?? 0);

const injuredOp = (T: TeamHooks, op: OperativeState): boolean => {
  const card = T.card(op);
  return card !== undefined && op.wounds < card.wounds / 2;
};

/** Unblocked dice of a resolved shoot pool, which is what `resolveAttackDice` turned into damage. */
function unblocked(seq: ShootSequence): { crits: number; normals: number } {
  return {
    crits: seq.attack.dice.filter((d) => d.state === 'crit').length,
    normals: seq.attack.dice.filter((d) => d.state === 'normal').length,
  };
}

function shotProfile(T: TeamHooks, state: GameState, seq: ShootSequence): WeaponProfile | undefined {
  const ctx = T.ctx;
  const attacker = state.operatives[seq.attackerId];
  if (!ctx || !attacker) return undefined;
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
  return w ? findProfile(w, seq.profileName) : undefined;
}

/**
 * "you can re-roll any of your dice results of one result" / "your opponent must re-roll their
 * dice results of 6". A `RerollGrant` cannot name a value and cannot be made mandatory (a known
 * engine gap), so both rules re-roll the dice themselves — the Warpcoven RAVAGE DESTINY shape.
 */
function rerollAllOf(
  T: TeamHooks,
  state: GameState,
  pool: DicePool,
  value: number,
  hit: number,
  lethal: number | undefined,
  note: string,
  player: PlayerId,
): number {
  const ctx = T.ctx;
  if (!ctx) return 0;
  const rolled: number[] = [];
  for (const die of pool.dice) {
    if (!die.rolled || die.value !== value) continue;
    if (die.state !== 'crit' && die.state !== 'normal' && die.state !== 'fail') continue;
    const v = ctx.rng.d6();
    rerollDie(die, v, hit, lethal !== undefined ? { lethal } : {});
    die.note = note;
    rolled.push(v);
  }
  if (rolled.length > 0) {
    recordRoll(state, 'reroll', rolled, player, note);
    log(state, { kind: 'dice', player, text: `${note}: re-rolled ${rolled.length} dice → ${rolled.join(', ')}` });
  }
  return rolled.length;
}

/** The failing result the most dice show (ties → the lowest), or undefined when none repeat. */
function repeatedFail(pool: DicePool, min = 2): number | undefined {
  const counts = new Map<number, number>();
  for (const die of pool.dice) {
    if (!die.rolled || die.state !== 'fail') continue;
    counts.set(die.value, (counts.get(die.value) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestN = min - 1;
  for (const [value, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestN) {
      best = value;
      bestN = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  powerFromPain(reg, T);
  invigorations(reg, T);

  // ---- Rifles (faction rule 3) -------------------------------------------
  // "Whenever a friendly HAND OF THE ARCHON operative is shooting with a splinter rifle during
  //  an activation in which it hasn't performed the Charge, Fall Back or Reposition action,
  //  that weapon has the Accurate 1 weapon rule."
  reg.on('onWeaponRules', T.bind(RULE.rifles, 11), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (ev.weaponName.trim().toLowerCase() !== 'splinter rifle') return;
    const moved = ev.operative.actionsThisActivation.some((a) => ['Charge', 'Fall Back', 'Reposition'].includes(a));
    if (moved) return; // Dash is deliberately not in that list.
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Rifles)'));
  });

  archsybarite(reg, T);
  crimsonDuellist(reg, T);
  discipleOfYaelindra(reg, T);
  elixicant(reg, T);
  flayer(reg, T);
  skysplinterAssassin(reg, T);

  /*
   * `grantFreeAction` models a free action as one extra AP (D-015) by pushing a +1 into
   * `aplMods`, which the engine never pops (the Death Korps / Ratlings upkeep). Vitalised Surge
   * hands one out on every kill, so without this a killer would keep APL 3 for the battle.
   */
  const upkeep = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.source.id !== RULE.invigorations) continue;
      const at = op.aplMods.lastIndexOf(1);
      if (at >= 0) op.aplMods.splice(at, 1);
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onActivationEnd', T.bindText('handOfTheArchon.aplUpkeep', INVIGORATION_TEXT['vitalised-surge'], 90), (ev) => {
    if (ev.operative.player === T.player) upkeep(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('handOfTheArchon.aplUpkeep', INVIGORATION_TEXT['vitalised-surge'], 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const op of T.friendlies(ev.state)) upkeep(ev.state, op);
  });
}

// ---------------------------------------------------------------------------

function powerFromPain(reg: HookRegistry, T: TeamHooks): void {
  /*
   * "After a friendly HAND OF THE ARCHON operative performs an action, it gains one of your Pain
   *  tokens if: An enemy operative was injured during that action, but was not incapacitated."
   *
   * "Injured" is a state an operative enters at half wounds, so the trigger is the CROSSING:
   * an enemy that was already injured before the action does not pay again. Bound late (90) so
   * every rule that changes the damage — Insensible to Pain, Painbringer, REFINED POISON — has
   * already had its say and `ev.amount` is the damage that will actually be inflicted.
   */
  reg.on('onDamage', T.bind(RULE.powerFromPain, 90), (ev) => {
    if (ev.target.player === T.player) return; // "an ENEMY operative"
    const actor = actingFriendly(T, ev.state);
    if (!actor) return;
    const card = T.card(ev.target);
    if (!card) return;
    const after = ev.target.wounds - Math.max(0, Math.round(ev.amount));
    if (after <= 0) return; // "but was not incapacitated" — the second bullet pays for that
    const half = card.wounds / 2;
    if (ev.target.wounds < half || after >= half) return;
    if (!claimAction(ev.state, actor, 'powerFromPain')) return;
    gainPain(T, ev.state, actor, 1, RULE.powerFromPain);
  });

  /*
   * "An enemy operative was incapacitated during that action. If that enemy operative had a
   *  Wounds stat of 12 or more, that friendly operative gains two of your Pain tokens instead."
   */
  reg.on('onIncapacitated', T.bind(RULE.powerFromPain, 80), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const actor = actingFriendly(T, ev.state);
    if (!actor) return;
    if (!claimAction(ev.state, actor, 'powerFromPain')) return;
    gainPain(T, ev.state, actor, (T.card(ev.operative)?.wounds ?? 0) >= 12 ? 2 : 1, RULE.powerFromPain);
  });
}

/**
 * The four invigorations. "You can spend friendly operatives' Pain tokens on invigorations when
 * the 'when' condition is met" is an option, and the engine cannot ask a question inside a dice
 * sequence, so each is auto-used on a stated deterministic policy (D-022):
 *
 *  - Accelerated Rejuvenation while the operative is injured (the −2" Move / worsened Hit is
 *    the biggest swing a token can buy);
 *  - Dark Animus while it is NOT injured and holds two tokens (so one stays in reserve);
 *  - Vitalised Surge on a kill while it holds two tokens (same reserve);
 *  - Stimulated Senses whenever at least two of its rolled dice share a failing result, so the
 *    token always buys at least two re-rolls.
 */
function invigorations(reg: HookRegistry, T: TeamHooks): void {
  const bindInvig = (id: Invigoration, priority = 12) =>
    T.bindText(`handOfTheArchon.invigoration.${id}`, `${INVIGORATION_NAME[id]}: ${INVIGORATION_TEXT[id]}`, priority);

  // Dark Animus / Accelerated Rejuvenation: "During the operative's activation … before or
  // after it performs an action" — taken before its first action.
  reg.on('onActivationStart', bindInvig('accelerated-rejuvenation'), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || painOf(ev.state, op) < 1) return;
    const card = T.card(op);
    if (!card || !injuredOp(T, op)) return;
    if (!T.ctx) return;
    if (!claimInvigoration(ev.state, op, 'accelerated-rejuvenation')) return;
    const roll = T.ctx.rng.d3();
    recordRoll(ev.state, 'acceleratedRejuvenation', [roll], T.player, 'Accelerated Rejuvenation D3+1');
    const healed = Math.min(roll + 1, card.wounds - op.wounds);
    op.wounds += healed;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Accelerated Rejuvenation: ${op.letter} regains ${healed} lost wounds`,
    });
  });

  reg.on('onActivationStart', bindInvig('dark-animus', 13), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || injuredOp(T, op)) return;
    if (painOf(ev.state, op) < 2) return; // policy: keep one token in reserve
    if (!claimInvigoration(ev.state, op, 'dark-animus')) return;
    effect(ev.state, {
      rule: EFF.darkAnimus,
      source: { kind: 'ability', id: RULE.invigorations },
      sourceText: shortQuote(INVIGORATION_TEXT['dark-animus']),
      operativeId: op.id,
      player: T.player,
      // "Until the start of the operative's next activation" — the backstop expiry is one
      // activation long; the start of its next activation drops it below.
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Dark Animus: ${op.letter} +1 APL` });
  });
  // "Until the START of the operative's next activation."
  reg.on('onActivationStart', bindInvig('dark-animus', 9), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === EFF.darkAnimus && e.operativeId === ev.operative.id);
  });
  // APL through `onStatMod`, which `aplOf` consults — `StatMods.apl` from other hooks is dead,
  // and an `aplMods` push would outlive the effect (the Death Korps precedent).
  reg.on('onStatMod', bindInvig('dark-animus', 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.darkAnimus)) return;
    ev.mods.apl += 1;
  });

  // Vitalised Surge: "After the operative incapacitates an enemy operative and that enemy
  // operative is removed from the killzone." Removal happens at the end of the action, so the
  // grant is made as the enemy is incapacitated (a bounded timing shift).
  reg.on('onIncapacitated', bindInvig('vitalised-surge', 82), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const actor = actingFriendly(T, ev.state);
    if (!actor || painOf(ev.state, actor) < 2) return; // policy: keep one token in reserve
    if (!claimInvigoration(ev.state, actor, 'vitalised-surge')) return;
    grantFreeAction(ev.state, actor, {
      sourceId: RULE.invigorations,
      sourceText: shortQuote(INVIGORATION_TEXT['vitalised-surge']),
      threshold: currentApl(T, ev.state, actor),
      kind: 'ability',
      only: ['Dash', SURGE_DASH],
    });
  });

  // Stimulated Senses: "After rolling your attack or defence dice for the operative."
  // `onRollAttack` is emitted by `shoot.ts` only (D-031), so the melee half is out of reach.
  reg.on('onRollAttack', bindInvig('stimulated-senses', 14), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.usedRerolls.includes('hota.stimulated')) return;
    if (painOf(ev.state, op) < 1) return;
    const value = repeatedFail(seq.attack);
    if (value === undefined || !T.ctx) return;
    if (!claimInvigoration(ev.state, op, 'stimulated-senses')) return;
    seq.usedRerolls.push('hota.stimulated');
    const hit = hitOf(T.ctx, ev.state, op, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    rerollAllOf(T, ev.state, seq.attack, value, hit, lethalThreshold(ev.ctx.rules), 'Stimulated Senses', T.player);
  });
  reg.on('onDefenceDice', bindInvig('stimulated-senses', 14), (ev) => {
    const op = ev.ctx.defender;
    const seq = shootSeq(ev.state);
    if (!op || op.player !== T.player || !T.kw(op, KW)) return;
    if (!seq || seq.step !== 'defenceRerolls' || seq.usedRerolls.includes('hota.stimulatedDef')) return;
    if (painOf(ev.state, op) < 1 || !T.ctx) return;
    const value = repeatedFail(seq.defence);
    if (value === undefined) return;
    if (!claimInvigoration(ev.state, op, 'stimulated-senses')) return;
    seq.usedRerolls.push('hota.stimulatedDef');
    rerollAllOf(T, ev.state, seq.defence, value, saveOf(T.ctx, ev.state, op), undefined, 'Stimulated Senses', T.player);
  });
}

// ---------------------------------------------------------------------------

function archsybarite(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Cunning: "In the Gambit step of each Strategy phase, if this operative is in the killzone
   *  and you pass at the first opportunity, you gain 1CP. Ignore each STRATEGIC GAMBIT from the
   *  mission pack (if any) when determining this."
   *
   * `PassGambit` emits no hook, so the condition — "you used no STRATEGIC GAMBIT of your own
   * this turning point" — is settled at the first activation of the Firefight phase, which is
   * the first moment after the Gambit step has closed. The CP still arrives in time to be spent
   * during the turning point it was earned in.
   */
  reg.on('onActivationStart', T.bind(A.cunning, 12), (ev) => {
    if (!useOncePerTP(ev.state, `hota.cunning.${T.player}`)) return;
    const arch = T.friendlies(ev.state).find((o) => o.datacardId === C.archsybarite && !o.removed);
    if (!arch) return;
    // "Ignore each STRATEGIC GAMBIT from the mission pack" — only this team's own gambits count.
    if (ev.state.teams[T.player].gambitsUsedTP.some((g) => g.startsWith('hand-of-the-archon.'))) return;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Cunning: passed at the first opportunity, +1CP' });
  });

  /*
   * Torturous Vision: "Once during each of this operative's activations, if it doesn't have any
   *  of your Pain tokens when it performs either the Fight or Shoot action, it can gain one of
   *  your Pain tokens when you select a valid target or an enemy operative to fight against."
   *  Free, so it is auto-used (D-022).
   */
  const vision = (state: GameState, op: OperativeState): void => {
    if (!T.mineKw(op, KW) || op.datacardId !== C.archsybarite) return;
    if (painOf(state, op) > 0) return;
    if (effectOn(state, op.id, EFF.torturousVision)) return;
    effect(state, {
      rule: EFF.torturousVision,
      source: { kind: 'ability', id: A.torturousVision },
      sourceText: shortQuote(abilityText(C.archsybarite, A.torturousVision)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    gainPain(T, state, op, 1, A.torturousVision);
  };
  // Shooting: the Select Valid Target step.
  reg.on('onSelectTarget', T.bind(A.torturousVision, 12), (ev) => {
    vision(ev.state, ev.attacker);
  });
  // Fighting: `startFight` emits nothing, so the melee half is taken as the attack dice are
  // collected — still inside the Fight action, and still before any dice are rolled.
  reg.on('onCollectAttackDice', T.bind(A.torturousVision, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return; // not while retaliating
    vision(ev.state, ev.ctx.attacker);
  });
}

// ---------------------------------------------------------------------------

function crimsonDuellist(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Brutal Display: "Once per turning point, when this operative incapacitates an enemy
   *  operative within its control range, you can select one other enemy operative visible to and
   *  within 6" of either this operative or the incapacitated enemy operative. Until the start of
   *  the next turning point, that other enemy operative cannot control markers or perform the
   *  Pick Up Marker or mission actions."
   */
  reg.on('onIncapacitated', T.bind(A.brutalDisplay, 81), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const ctx = T.ctx;
    if (!ctx) return;
    const duellist = actingFriendly(T, ev.state);
    if (!duellist || duellist.datacardId !== C.duellist) return;
    if (!inControlRange(ctx, ev.state, duellist, ev.operative)) return;
    const index = terrain(ctx, ev.state);
    const eligible = T.enemies(ev.state)
      .filter((e) => e.id !== ev.operative.id && !e.incapacitated)
      .filter((e) =>
        [duellist, ev.operative].some(
          (from) => T.gap(from, e) <= 6 + EPS && isVisible(index, body(ctx, from), body(ctx, e)).visible,
        ),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const victim = eligible[0];
    if (!victim) return;
    if (!useOncePerTP(ev.state, `hota.brutalDisplay.${T.player}`)) return;
    effect(ev.state, {
      rule: EFF.brutalDisplay,
      source: { kind: 'ability', id: A.brutalDisplay },
      sourceText: shortQuote(abilityText(C.duellist, A.brutalDisplay)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'startOfNextTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Brutal Display: ${victim.letter} cannot control markers or perform the Pick Up Marker or mission actions`,
    });
  });
  reg.on('canPerformAction', T.bind(A.brutalDisplay, 21), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, EFF.brutalDisplay)) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    ev.allowed = false;
    ev.reason = 'Brutal Display: it cannot perform the Pick Up Marker or mission actions';
  });
  reg.on('onMarkerControl', T.bind(A.brutalDisplay, 21), (ev) => {
    const ctx = T.ctx;
    const marker = ev.state.markers[ev.markerId];
    if (!ctx || !marker) return;
    for (const enemy of T.enemies(ev.state)) {
      if (!effectOn(ev.state, enemy.id, EFF.brutalDisplay)) continue;
      if (!markerContestedBy(ctx, ev.state, marker, enemy)) continue;
      ev.aplByPlayer[enemy.player] = Math.max(0, ev.aplByPlayer[enemy.player] - aplOf(ctx, ev.state, enemy));
    }
  });

  /*
   * Tangle (rare weapon rule, printed as the CRIMSON DUELLIST's own ability): "Whenever this
   *  operative is fighting or retaliating with this weapon, each of your blocks can be allocated
   *  to block two unresolved successes (instead of one)." The `Shield` shape.
   */
  reg.on('onBlockAllocation', T.bind(A.tangle, 12), (ev) => {
    const blocker = ev.ctx.attacker; // the side resolving the die is `attacker` in this payload
    if (blocker.player !== T.player || blocker.datacardId !== C.duellist) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Tangle')) return;
    ev.blocks = 2;
  });
}

// ---------------------------------------------------------------------------

function discipleOfYaelindra(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Stinger (rare weapon rule, printed as the DISCIPLE's own ability): "Whenever an enemy
   *  operative is incapacitated by this weapon, before it's removed from the killzone, inflict
   *  D3 damage on each other operative visible to and within 2" of it. Each operative
   *  subsequently incapacitated as a result of this weapon rule will cause this to happen again."
   *  The chain is the recursion `inflictDamage` → `onIncapacitated` gives us for free: an
   *  operative already incapacitated cannot fire it twice.
   */
  reg.on('onIncapacitated', T.bind(A.stinger, 40), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const ctx = T.ctx;
    const seq = shootSeq(ev.state);
    if (!ctx || !seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || !T.mineKw(attacker, KW)) return;
    const profile = shotProfile(T, ev.state, seq);
    if (!profile?.rules.some((r) => r.id === 'Stinger')) return;
    const index = terrain(ctx, ev.state);
    const victims = aliveOperatives(ev.state).filter(
      (o) =>
        o.id !== ev.operative.id &&
        !o.incapacitated &&
        T.gap(ev.operative, o) <= 2 + EPS &&
        isVisible(index, body(ctx, ev.operative), body(ctx, o)).visible,
    );
    for (const victim of victims) {
      const d3 = ctx.rng.d3();
      recordRoll(ev.state, 'stinger', [d3], T.player, `Stinger vs ${victim.letter}`);
      inflictDamage(ctx, ev.state, victim, d3, 'other');
    }
  });

  // "Whenever an operative that has one of your Poison tokens is activated, inflict D3 damage."
  reg.on('onActivationStart', T.bindText(ACT.tormentGrenade, actionText(C.disciple, ACT.tormentGrenade), 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    if (!ev.state.effects.some((e) => e.rule === POISON && e.operativeId === ev.operative.id && e.player === T.player))
      return;
    const d3 = ctx.rng.d3();
    recordRoll(ev.state, 'tormentGrenade', [d3], T.player, 'Poison token D3');
    inflictDamage(ctx, ev.state, ev.operative, d3, 'other');
  });
}

// ---------------------------------------------------------------------------

function elixicant(reg: HookRegistry, T: TeamHooks): void {
  const drugBind = (drug: Drug, priority = 12) =>
    T.bindText(`handOfTheArchon.drug.${drug}`, DRUG_TEXT[drug], priority);

  // Painbringer: "Whenever an attack dice inflicts damage of 3 or more on this operative, roll
  //  one D6: on a 6, subtract 1 from that inflicted damage."
  reg.on('onDamage', drugBind('painbringer'), (ev) => {
    if (ev.kind !== 'attack' || ev.amount < 3) return;
    if (!T.mineKw(ev.target, KW) || drugOf(ev.state, ev.target) !== 'painbringer') return;
    const ctx = T.ctx;
    if (!ctx) return;
    const roll = ctx.rng.d6();
    recordRoll(ev.state, 'painbringer', [roll], T.player, 'Painbringer 6+');
    if (roll === 6) ev.amount -= 1;
  });

  // Adrenalight: "In the Ready step of each Strategy phase, you can select one friendly
  //  operative that has this COMBAT DRUG to gain one of your Pain tokens." Free, so it is
  //  auto-used (D-022); the deterministic pick is the lowest-id operative holding the fewest.
  reg.on('onReadyStep', drugBind('adrenalight'), (ev) => {
    if (ev.player !== T.player) return;
    const candidates = T.friendlies(ev.state, KW)
      .filter((o) => drugOf(ev.state, o) === 'adrenalight')
      .sort((a, b) => painOf(ev.state, a) - painOf(ev.state, b) || (a.id < b.id ? -1 : 1));
    const pick = candidates[0];
    if (pick) gainPain(T, ev.state, pick, 1, A.combatDrugs);
  });

  // Hypex: "You can ignore any changes to this operative's Move stat from being injured."
  // D-022: an "ignore" rule only ignores a WORSENING change, so it cancels the injured −2".
  reg.on('onStatMod', drugBind('hypex'), (ev) => {
    if (!T.mineKw(ev.operative, KW) || drugOf(ev.state, ev.operative) !== 'hypex') return;
    if (!injuredOp(T, ev.operative)) return;
    ev.mods.move += 2;
  });
}

// ---------------------------------------------------------------------------

function flayer(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Insensible to Pain: "Normal and Critical Dmg of 3 or more inflicts 1 less damage on this
   *  operative." A shot aggregates every unblocked dice into one `inflictDamage` call, so the
   *  reduction is computed per DICE from the resolved pool; a fight inflicts one dice at a time,
   *  where the amount IS the Dmg stat.
   */
  reg.on('onDamage', T.bind(A.insensibleToPain, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!T.mineKw(ev.target, KW) || ev.target.datacardId !== C.flayer) return;
    const seq = shootSeq(ev.state);
    if (!seq) {
      // Melee: `resolveFightDie` inflicts exactly dmgN or dmgC.
      if (ev.amount >= 3) ev.amount -= 1;
      return;
    }
    const profile = shotProfile(T, ev.state, seq);
    if (!profile) return;
    const { crits, normals } = unblocked(seq);
    const reduce = (profile.dmgC >= 3 ? crits : 0) + (profile.dmgN >= 3 ? normals : 0);
    ev.amount = Math.max(0, ev.amount - reduce);
  });

  /*
   * Flay (rare weapon rule, printed as the FLAYER's own ability): "Whenever this operative is
   *  using this weapon, the first time you strike with a critical success during that sequence,
   *  you can select one friendly HAND OF THE ARCHON operative within 6" of it to gain one of
   *  your Pain tokens." Free, so it is auto-used (D-022) on the friendly operative within 6"
   *  holding the fewest tokens (ties by id).
   */
  reg.on('onStrikeResolved', T.bind(A.flay, 12), (ev) => {
    if (!ev.crit) return;
    const striker = ev.ctx.attacker;
    if (!T.mineKw(striker, KW) || striker.datacardId !== C.flayer) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Flay')) return;
    const seq = fightSeq(ev.state);
    const key = seq ? fightKey(ev.state, seq) : 'none';
    const b = bucket(ev.state, 'handOfTheArchon.flay') as Record<string, string>;
    if (b[striker.id] === key) return; // "the first time … during that sequence"
    b[striker.id] = key;
    const pick = T.friendlies(ev.state, KW)
      .filter((o) => !o.removed && T.gap(striker, o) <= 6 + EPS)
      .sort((a, b2) => painOf(ev.state, a) - painOf(ev.state, b2) || (a.id < b2.id ? -1 : 1))[0];
    if (pick) gainPain(T, ev.state, pick, 1, A.flay);
  });
}

// ---------------------------------------------------------------------------

function skysplinterAssassin(reg: HookRegistry, T: TeamHooks): void {
  // Merciless Hunter needs to know which ranged weapon each Shoot action used.
  reg.on('onCollectAttackDice', T.bind(A.mercilessHunter, 11), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.assassin) return;
    const existing = effectOn(ev.state, op.id, EFF.rangedThisActivation);
    const used = ((existing?.data?.['weapons'] as string[] | undefined) ?? []).slice();
    if (!used.includes(ev.ctx.weaponName)) used.push(ev.ctx.weaponName);
    if (existing) existing.data = { weapons: used };
    else
      effect(ev.state, {
        rule: EFF.rangedThisActivation,
        source: { kind: 'ability', id: A.mercilessHunter },
        sourceText: shortQuote(abilityText(C.assassin, A.mercilessHunter)),
        operativeId: op.id,
        player: T.player,
        data: { weapons: used },
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
  });

  // "If this operative doesn't perform the Mark unique action during its activation" — the
  // clause bites both ways, so MARK is refused once the second Shoot action has been taken.
  reg.on('canPerformAction', T.bind(A.mercilessHunter, 12), (ev) => {
    if (ev.action !== ACT.mark) return;
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.assassin) return;
    if (!ev.operative.actionsThisActivation.includes(HUNTER_SHOOT)) return;
    ev.allowed = false;
    ev.reason = 'it has already performed two Shoot actions this activation (Merciless Hunter)';
  });

  /*
   * Omen: "Whenever attack or defence dice are rolled for that operative: If it's an enemy
   *  operative, your opponent must re-roll their dice results of 6. If it's a friendly operative,
   *  you can re-roll any of your dice results of 1."
   *
   * A `RerollGrant` cannot name a value and cannot be made mandatory, so both halves re-roll the
   * dice in place. A result of 1 is always a fail, so re-rolling it is free and auto-used (D-022).
   * `onRollAttack` is shoot-only (D-031), so the attack-dice half is unreachable in a fight.
   */
  reg.on('onRollAttack', T.bind(A.omen, 14), (ev) => {
    const marked = omenTarget(ev.state, T.player);
    const seq = shootSeq(ev.state);
    if (!marked || !seq || !T.ctx) return;
    if (ev.ctx.attacker.id !== marked.id) return;
    const enemy = marked.player !== T.player;
    const key = `hota.omen.${enemy ? 6 : 1}`;
    if (seq.usedRerolls.includes(key)) return;
    seq.usedRerolls.push(key);
    const hit = hitOf(T.ctx, ev.state, marked, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    rerollAllOf(
      T,
      ev.state,
      seq.attack,
      enemy ? 6 : 1,
      hit,
      lethalThreshold(ev.ctx.rules),
      `Omen (${enemy ? 'must re-roll 6s' : 're-roll 1s'})`,
      marked.player,
    );
  });
  reg.on('onDefenceDice', T.bind(A.omen, 14), (ev) => {
    const marked = omenTarget(ev.state, T.player);
    const seq = shootSeq(ev.state);
    if (!marked || !seq || !T.ctx) return;
    if (seq.step !== 'defenceRerolls' || ev.ctx.defender?.id !== marked.id) return;
    const enemy = marked.player !== T.player;
    const key = `hota.omenDef.${enemy ? 6 : 1}`;
    if (seq.usedRerolls.includes(key)) return;
    seq.usedRerolls.push(key);
    rerollAllOf(
      T,
      ev.state,
      seq.defence,
      enemy ? 6 : 1,
      saveOf(T.ctx, ev.state, marked),
      undefined,
      `Omen (${enemy ? 'must re-roll 6s' : 're-roll 1s'})`,
      marked.player,
    );
  });

  /*
   * MARK: "Until the end of the turning point, whenever this operative is shooting that enemy
   *  operative you can use this effect. If you do: This operative's ranged weapons have the Seek
   *  Light weapon rule. That enemy operative cannot be obscured." Free, so it is auto-used.
   */
  reg.on('onWeaponRules', T.bindText(ACT.mark, actionText(C.assassin, ACT.mark), 12), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!ev.target || !markedBy(ev.state, ev.operative, ev.target)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (MARK)'));
  });
  // "That enemy operative cannot be obscured" — the sequence's own flag, cleared as the attack
  // dice are collected, which still precedes the retention and obscured-discard steps.
  reg.on('onCollectAttackDice', T.bindText(ACT.mark, actionText(C.assassin, ACT.mark), 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !markedBy(ev.state, ev.ctx.attacker, target)) return;
    seq.obscured = false;
  });
}

function markedBy(state: GameState, shooter: OperativeState, target: OperativeState): boolean {
  const eff = effectOn(state, shooter.id, EFF.mark);
  return eff?.data?.['targetId'] === target.id;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- BLADE ARTISTS (strategy) ------------------------------------------
  // "Friendly HAND OF THE ARCHON operatives' melee weapons have the Rending weapon rule."
  reg.on('onWeaponRules', T.bind(SP.bladeArtists, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.bladeArtists)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Rending', undefined, 'Rending (BLADE ARTISTS)'));
  });

  // ---- FROM DARKNESS, DEATH (strategy) -----------------------------------
  /*
   * "Whenever a friendly HAND OF THE ARCHON operative is activated, before you determine its
   *  order, you can select one enemy operative that friendly operative isn't a valid target for.
   *  Until the end of that activation, the first time that friendly operative is shooting
   *  against or fighting against that enemy operative, you can retain one of your normal
   *  successes as a critical success instead."
   *
   * The order is already set when `onActivationStart` fires, which costs nothing here: the
   * choice is of an enemy, not of an order. The pick is deterministic — the lowest-id enemy the
   * operative is not a valid target for with any of its ranged weapons (D-016).
   */
  reg.on('onActivationStart', T.bind(SP.fromDarknessDeath, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.fromDarknessDeath)) return;
    const op = ev.operative;
    const ctx = T.ctx;
    if (!ctx || !T.mineKw(op, KW)) return;
    const notValid = T.enemies(ev.state)
      .filter((e) => !isValidTargetFor(T, ev.state, op, e))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!notValid) return;
    effect(ev.state, {
      rule: EFF.fromDarkness,
      source: { kind: 'ploy', id: SP.fromDarknessDeath },
      sourceText: shortQuote(text(SP.fromDarknessDeath)),
      operativeId: op.id,
      player: T.player,
      data: { targetId: notValid.id },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `FROM DARKNESS, DEATH: ${op.letter} marks ${notValid.letter}`,
    });
  });
  reg.on('onRollAttack', T.bind(SP.fromDarknessDeath, 21), (ev) => {
    const op = ev.ctx.attacker;
    const seq = shootSeq(ev.state);
    if (!seq || op.player !== T.player) return;
    const eff = effectOn(ev.state, op.id, EFF.fromDarkness);
    if (!eff || eff.data?.['targetId'] !== ev.ctx.defender?.id) return;
    if (seq.usedRerolls.includes('hota.fromDarkness')) return;
    if (seq.obscured) return; // crits cannot be retained while obscured
    const die = seq.attack.dice.find((d) => d.state === 'normal');
    if (!die) return;
    seq.usedRerolls.push('hota.fromDarkness');
    die.state = 'crit';
    die.note = 'FROM DARKNESS, DEATH';
    dropEffects(ev.state, (e) => e === eff); // "the FIRST time"
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `FROM DARKNESS, DEATH: ${op.letter} retains a normal success as a critical success`,
    });
  });

  // ---- MERCILESS SADISTS (strategy) --------------------------------------
  // "Whenever a friendly HAND OF THE ARCHON operative is shooting against or fighting against a
  //  wounded enemy operative, that friendly operative's weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP.mercilessSadists, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.mercilessSadists)) return;
    if (!T.mineKw(ev.operative, KW) || ev.retaliating) return; // "shooting against or fighting against"
    if (!ev.target || ev.target.player === T.player || !isWoundedOp(T, ev.target)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (MERCILESS SADISTS)'));
  });

  // ---- DENIZENS OF NIGHT (strategy) --------------------------------------
  // "Whenever an enemy operative is shooting a friendly HAND OF THE ARCHON operative that's more
  //  than 2" from enemy operatives, if Heavy or Light terrain is intervening, or any part of that
  //  friendly operative's base is underneath Vantage terrain, you can re-roll one of your
  //  defence dice."
  reg.on('onDefenceDice', T.bind(SP.denizensOfNight, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.denizensOfNight)) return;
    const target = ev.ctx.defender;
    const ctx = T.ctx;
    if (!ctx || !target || !T.mineKw(target, KW) || ev.ctx.type !== 'ranged') return;
    if (T.enemies(ev.state).some((e) => T.gap(e, target) <= 2 + EPS)) return; // "more than 2" from"
    const index = terrain(ctx, ev.state);
    const intervening = interveningParts(index, body(ctx, ev.ctx.attacker), body(ctx, target)).any.some(
      (p) => hasType(p, 'Heavy') || hasType(p, 'Light'),
    );
    if (!intervening && !underneathVantage(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'hand-of-the-archon.denizensOfNight',
      label: 'DENIZENS OF NIGHT: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: target.player,
      sourceText: shortQuote(text(SP.denizensOfNight)),
    });
  });

  // ---- CRUEL DECEPTION (firefight) ---------------------------------------
  // "Use this firefight ploy during a friendly HAND OF THE ARCHON operative's activation, before
  //  or after it performs an action. During that activation, that operative can perform the Fall
  //  Back action for 1 less AP."
  reg.on('onPloyUsed', T.bind(FP.cruelDeception, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.cruelDeception) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !T.mineKw(active, KW)) return;
    effect(ev.state, {
      rule: EFF.cruelDeception,
      source: { kind: 'ploy', id: FP.cruelDeception },
      sourceText: shortQuote(text(FP.cruelDeception)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.cruelDeception, 21), (ev) => {
    if (ev.action !== 'Fall Back') return;
    // Both players register this module in a mirror match, so the effect's owner is checked:
    // without it the discount would be taken twice.
    const eff = effectOn(ev.state, ev.operative.id, EFF.cruelDeception);
    if (!eff || eff.player !== T.player) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- HEINOUS ARROGANCE (firefight) -------------------------------------
  // "Use this firefight ploy when it's your turn to activate a friendly operative. You can skip
  //  that activation." The engine has no skip intent, so the turn is handed to the opponent and
  //  every ready operative keeps its ready status (the Phobos PATIENT AMBUSH precedent).
  reg.on('onPloyUsed', T.bind(FP.heinousArrogance, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.heinousArrogance) return;
    ev.state.activePlayer = T.player === 'p1' ? 'p2' : 'p1';
    log(ev.state, { kind: 'ploy', player: T.player, text: 'HEINOUS ARROGANCE: that activation is skipped' });
  });

  // ---- DEVIOUS SCHEME (firefight) ----------------------------------------
  /*
   * "Use this firefight ploy after an opponent uses a firefight ploy (excluding one that costs
   *  0CP). The next time they would use that ploy, they must spend 1 additional CP to do so (at
   *  which point this effect ends). You cannot use this ploy again during the battle until its
   *  effect has ended."
   *
   * The reducer charges a ploy's CP BEFORE `onPloyUsed` fires (docs/TEAM-STATUS.md › Known
   * engine gaps), so the surcharge is an extra deduction as the opponent uses the ploy rather
   * than a legality gate on using it.
   */
  reg.on('onPloyUsed', T.bind(FP.deviousScheme, 19), (ev) => {
    if (ev.kind !== 'firefight' || ev.player === T.player) return;
    const surcharge = ev.state.effects.find(
      (e) => e.rule === EFF.deviousScheme && e.player === T.player && e.data?.['ployId'] === ev.ployId,
    );
    if (surcharge) {
      const team = ev.state.teams[ev.player];
      team.cp = Math.max(0, team.cp - 1);
      dropEffects(ev.state, (e) => e === surcharge);
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: 'DEVIOUS SCHEME: that ploy costs 1 additional CP (the effect ends)',
      });
      return;
    }
    const cp = T.ctx?.teams.get(ev.state.teams[ev.player].teamId)?.ploys.find((p) => p.id === ev.ployId)?.cp ?? 1;
    if (cp <= 0) return; // "excluding one that costs 0CP"
    const b = bucket(ev.state, 'handOfTheArchon.lastFirefightPloy') as Record<string, string>;
    b[ev.player] = ev.ployId;
  });
  reg.on('onPloyUsed', T.bind(FP.deviousScheme, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.deviousScheme) return;
    const opponent = T.player === 'p1' ? 'p2' : 'p1';
    const ployId = (bucket(ev.state, 'handOfTheArchon.lastFirefightPloy') as Record<string, string>)[opponent];
    if (!ployId) return;
    effect(ev.state, {
      rule: EFF.deviousScheme,
      source: { kind: 'ploy', id: FP.deviousScheme },
      sourceText: shortQuote(text(FP.deviousScheme)),
      player: T.player,
      data: { ployId },
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `DEVIOUS SCHEME: ${ployId} costs 1 additional CP next time` });
  });

  // ---- PREY ON THE WOUNDED (firefight) -----------------------------------
  // "Use this firefight ploy after rolling your attack dice for a friendly HAND OF THE ARCHON
  //  operative, if it's shooting against or fighting against a wounded enemy operative. You can
  //  re-roll any of your attack dice." `ploysUsedTP` lasts the whole turning point, so the ploy
  //  arms a one-shot flag that the next qualifying roll consumes.
  reg.on('onPloyUsed', T.bind(FP.preyOnTheWounded, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.preyOnTheWounded) return;
    (bucket(ev.state, 'handOfTheArchon.preyArmed') as Record<string, boolean>)[T.player] = true;
  });
  reg.on('onRollAttack', T.bind(FP.preyOnTheWounded, 21), (ev) => {
    const armed = bucket(ev.state, 'handOfTheArchon.preyArmed') as Record<string, boolean>;
    if (!armed[T.player]) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    if (!foe || foe.player === T.player || !isWoundedOp(T, foe)) return;
    delete armed[T.player];
    ev.rerolls.push({
      id: 'hand-of-the-archon.preyOnTheWounded',
      label: 'PREY ON THE WOUNDED: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text(FP.preyOnTheWounded)),
    });
  });
}

/** "one enemy operative that friendly operative isn't a valid target for" — for any weapon. */
function isValidTargetFor(T: TeamHooks, state: GameState, op: OperativeState, enemy: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  for (const weapon of weaponsOf(ctx, state, op, 'ranged')) {
    for (const profile of weapon.profiles) {
      if (profile.type !== 'ranged') continue;
      const rules = effectiveRules(ctx, state, profile, { operative: op, target: enemy, weaponName: weapon.name });
      if (checkTarget(ctx, state, op, enemy, profile, rules).valid) return true;
    }
  }
  return false;
}

/** "any part of that friendly operative's base is underneath Vantage terrain" */
function underneathVantage(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const base = T.card(op)?.base ?? { shape: 'round' as const, mm: 25 };
  return terrain(ctx, state).parts.some(
    (p) => hasType(p, 'Vantage') && p.z0 > op.z + EPS && baseGapToPoly(op.pos, base, op.rot, p.poly) <= EPS,
  );
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

const REFINED_WEAPONS = ['shardcarbine', 'splinter cannon', 'splinter pistol', 'splinter rifle', 'stinger pistol'];

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- CHAIN SNARE -------------------------------------------------------
  /*
   * "Whenever an enemy operative would perform the Fall Back action while within control range
   *  of a friendly HAND OF THE ARCHON operative, if no other enemy operatives are within that
   *  friendly operative's control range, you can use this rule. If you do, roll two D6, or one
   *  D6 if that enemy operative has a higher Wounds stat than that friendly operative. If any
   *  result is a 4+, that enemy operative cannot perform that action during that
   *  activation/counteraction (no AP are spent on it), and you cannot use this rule again during
   *  this turning point."
   *
   * `canPerformAction` is a pure query the AI runs many times per activation, so the roll is
   * taken at the start of the enemy's activation instead of when it declares the Fall Back —
   * the Nemesis Claw CHAIN SNARE / Inquisitorial Agent No Escape precedent. Its counteraction
   * half is therefore not covered.
   */
  reg.on('onActivationStart', T.bind(EQ.chainSnare, 30), (ev) => {
    const ctx = T.ctx;
    if (!ctx || !hasEquipment(ev.state, T.player, EQ.chainSnare)) return;
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (bucket(ev.state, 'handOfTheArchon.chainSnare')[T.player] === `${ev.state.turningPoint}`) return;
    const holder = T.friendlies(ev.state, KW).find(
      (o) => inControlRange(ctx, ev.state, o, foe) && enemiesInControlRange(ctx, ev.state, o).length === 1,
    );
    if (!holder) return;
    const foeWounds = T.card(foe)?.wounds ?? 0;
    const holderWounds = T.card(holder)?.wounds ?? 0;
    const dice = foeWounds > holderWounds ? 1 : 2;
    const results = ctx.rng.roll(dice);
    recordRoll(ev.state, 'chainSnare', results, T.player, `CHAIN SNARE ${dice}D6`);
    if (!results.some((r) => r >= 4)) return;
    bucket(ev.state, 'handOfTheArchon.chainSnare')[T.player] = `${ev.state.turningPoint}`;
    effect(ev.state, {
      rule: EFF.chainSnare,
      source: { kind: 'equipment', id: EQ.chainSnare },
      sourceText: shortQuote(text(EQ.chainSnare)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `CHAIN SNARE: ${foe.letter} cannot Fall Back` });
  });
  reg.on('canPerformAction', T.bind(EQ.chainSnare, 31), (ev) => {
    if (ev.action !== 'Fall Back') return;
    if (!effectOn(ev.state, ev.operative.id, EFF.chainSnare)) return;
    ev.allowed = false;
    ev.reason = 'CHAIN SNARE: it cannot perform that action during this activation';
  });

  // ---- TOXIN COATING -----------------------------------------------------
  /*
   * "Up to twice per turning point, whenever a friendly HAND OF THE ARCHON operative is fighting
   *  or retaliating and you're selecting a melee weapon, you can use this rule. If you do, until
   *  the end of that sequence, that operative's melee weapon has the Lethal 5+ weapon rule."
   *
   * `onWeaponRules` is re-emitted on every read, so the use is claimed once per sequence and
   * recorded as an effect the later reads see. Stated policy (D-022): used only when the weapon
   * has no Lethal x of 5+ or better, so a use is never wasted.
   */
  reg.on('onWeaponRules', T.bind(EQ.toxinCoating, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.toxinCoating)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    const seq = fightSeq(ev.state);
    if (!seq || (seq.attackerId !== ev.operative.id && seq.defenderId !== ev.operative.id)) return;
    const key = `${fightKey(ev.state, seq)}:${ev.operative.id}`;
    const armed = effectsOn(ev.state, ev.operative.id, EFF.toxinCoating).some((e) => e.data?.['key'] === key);
    if (!armed) {
      const existing = (ev.rules.find((r) => r.id === 'Lethal')?.x ?? 7) <= 5;
      if (existing) return;
      const b = bucket(ev.state, 'handOfTheArchon.toxinCoating') as Record<string, { tp: number; used: number }>;
      const cur = b[T.player] && b[T.player]!.tp === ev.state.turningPoint ? b[T.player]! : { tp: ev.state.turningPoint, used: 0 };
      if (cur.used >= 2) return;
      cur.used += 1;
      b[T.player] = cur;
      effect(ev.state, {
        rule: EFF.toxinCoating,
        source: { kind: 'equipment', id: EQ.toxinCoating },
        sourceText: shortQuote(text(EQ.toxinCoating)),
        operativeId: ev.operative.id,
        player: T.player,
        data: { key },
        expiry: { kind: 'endOfTurningPoint' },
      });
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `TOXIN COATING: ${ev.operative.letter}'s melee weapon has Lethal 5+ (${cur.used}/2 this turning point)`,
      });
    }
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (TOXIN COATING)'));
  });

  // ---- WICKED BLADES -----------------------------------------------------
  // "Add 1 to the Atk stat of friendly HAND OF THE ARCHON operatives' array of blades."
  reg.on('onCollectAttackDice', T.bind(EQ.wickedBlades, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.wickedBlades)) return;
    if (ev.ctx.type !== 'melee' || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (ev.ctx.weaponName.trim().toLowerCase() !== 'array of blades') return;
    ev.mods.atk += 1;
  });

  // ---- REFINED POISON ----------------------------------------------------
  /*
   * "Up to twice per turning point, whenever a friendly HAND OF THE ARCHON operative is
   *  performing the Shoot action and you select a shardcarbine, splinter cannon, splinter pistol,
   *  splinter rifle or stinger pistol, you can use this rule. If you do, until the end of that
   *  action, add 1 to the Normal Dmg stat of that weapon."
   *
   * Claimed at Select Weapon — which is what `onSelectWeapon` is — and paid out at `onDamage`,
   * because a `WeaponProfile` is shared datacard data and must never be rewritten (D-019). A shot
   * aggregates its unblocked dice into one damage total, so the bonus is +1 per unblocked normal
   * success. Stated policy: the first two qualifying Shoot actions of each turning point.
   */
  reg.on('onSelectWeapon', T.bind(EQ.refinedPoison, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (D-032)
    if (!hasEquipment(ev.state, T.player, EQ.refinedPoison)) return;
    const op = ev.ctx.attacker;
    if (!T.mineKw(op, KW)) return;
    if (!REFINED_WEAPONS.includes(ev.ctx.weaponName.trim().toLowerCase())) return;
    const b = bucket(ev.state, 'handOfTheArchon.refinedPoison') as Record<string, { tp: number; used: number }>;
    const cur = b[T.player] && b[T.player]!.tp === ev.state.turningPoint ? b[T.player]! : { tp: ev.state.turningPoint, used: 0 };
    if (cur.used >= 2) return;
    cur.used += 1;
    b[T.player] = cur;
    effect(ev.state, {
      rule: EFF.refinedPoison,
      source: { kind: 'equipment', id: EQ.refinedPoison },
      sourceText: shortQuote(text(EQ.refinedPoison)),
      operativeId: op.id,
      player: T.player,
      data: { weapon: ev.ctx.weaponName },
      expiry: { kind: 'endOfAction' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `REFINED POISON: +1 Normal Dmg on ${op.letter}'s ${ev.ctx.weaponName} (${cur.used}/2 this turning point)`,
    });
  });
  reg.on('onDamage', T.bind(EQ.refinedPoison, 31), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player) return;
    const eff = effectOn(ev.state, attacker.id, EFF.refinedPoison);
    if (!eff || eff.data?.['weapon'] !== seq.weaponName) return;
    ev.amount += unblocked(seq).normals;
  });
  // `endOfAction` effects are only swept at the end of the turning point, so the grant is
  // dropped as the next Shoot action selects its weapon.
  reg.on('onSelectWeapon', T.bind(EQ.refinedPoison, 5), (ev) => {
    if (ev.dryRun) return;
    if (ev.ctx.attacker.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === EFF.refinedPoison && e.operativeId === ev.ctx.attacker.id);
  });
}

// ---------------------------------------------------------------------------
// Unique actions and the two carve-out actions (D-021)
// ---------------------------------------------------------------------------

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- TORMENT GRENADE 1AP — DISCIPLE OF YAELINDRA ---------------------
    uniqueAction(data, C.disciple, ACT.tormentGrenade, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative visible to and within 6"' };
        if (!visibleWithin(ctx, state, op, target, 6))
          return { ok: false, reason: 'that operative is not visible to and within 6"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        // "That operative and each other operative within 1" of it takes a poison test."
        const victims = [
          target,
          ...aliveOperatives(state).filter((o) => o.id !== target.id && gap(ctx, target, o) <= 1 + EPS),
        ];
        for (const victim of victims) poisonTest(ctx, state, op.player, victim);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: TORMENT GRENADE on ${target.letter}` });
        return { ok: true };
      },
    }),

    // ---- ADMINISTER DRUG 1AP — ELIXICANT --------------------------------
    uniqueAction(data, C.elixicant, ACT.administerDrug, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select one friendly HAND OF THE ARCHON operative visible to and within 3"' };
        if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
          return { ok: false, reason: 'select one friendly HAND OF THE ARCHON operative' };
        if (target.id !== op.id && !visibleWithin(ctx, state, op, target, 3))
          return { ok: false, reason: 'that operative is not visible to and within 3"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const card = ctx.datacards.get(target.datacardId);
        const lost = (card?.wounds ?? target.wounds) - target.wounds;
        // "then select one of the following for that friendly operative" — from the intent's
        // `choice`, with a deterministic, logged default (D-016): heal a wounded operative,
        // otherwise change its COMBAT DRUG.
        const choice = params.choice === 'drug' || params.choice === 'wounds' ? params.choice : lost > 0 ? 'wounds' : 'drug';
        if (choice === 'wounds') {
          const a = ctx.rng.d3();
          const b = ctx.rng.d3();
          recordRoll(state, 'administerDrug', [a, b], op.player, 'ADMINISTER DRUG 2D3');
          const healed = Math.min(a + b, lost);
          target.wounds += healed;
          log(state, {
            kind: 'action',
            player: op.player,
            text: `${op.letter}: ADMINISTER DRUG — ${target.letter} regains ${healed} lost wounds`,
          });
          return { ok: true };
        }
        const current = drugOf(state, target);
        const wanted = params.data?.['drug'] as Drug | undefined;
        const next =
          wanted && DRUGS.includes(wanted) && wanted !== current
            ? wanted
            : DRUGS.find((d) => d !== current) ?? DRUGS[0];
        setOperativeDrug(state, target, next);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: ADMINISTER DRUG — ${target.letter} now has ${DRUG_NAME[next]}`,
        });
        return { ok: true };
      },
    }),

    // ---- MARK 1AP — SKYSPLINTER ASSASSIN --------------------------------
    uniqueAction(data, C.assassin, ACT.mark, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative visible to this operative' };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        dropEffects(state, (e) => e.rule === EFF.mark && e.operativeId === op.id);
        effect(state, {
          rule: EFF.mark,
          source: { kind: 'ability', id: ACT.mark },
          sourceText: shortQuote(actionText(C.assassin, ACT.mark)),
          operativeId: op.id,
          player: op.player,
          data: { targetId: target.id },
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: MARK on ${target.letter}` });
        return { ok: true };
      },
    }),

    // ---- Crimson Duellist: "This operative can perform two Fight actions" ----
    // D-021: the universal Fight refuses a second one (action restrictions), so the second is
    // its own ActionDef with its own restriction key, delegating to the universal action.
    {
      id: DUELLIST_FIGHT,
      name: 'Fight (Crimson Duellist)',
      ap: 1,
      type: 'unique',
      sourceText: `Crimson Duellist: ${abilityText(C.duellist, A.crimsonDuellist)}`,
      available: (_ctx, _state, op) => op.datacardId === C.duellist,
      check: (ctx, state, op, params) => {
        if (!op.actionsThisActivation.includes('Fight'))
          return { ok: false, reason: 'Crimson Duellist is the second Fight action of an activation' };
        return getAction('Fight')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
    },

    // ---- Merciless Hunter: the second Shoot action ------------------------
    {
      id: HUNTER_SHOOT,
      name: 'Shoot (Merciless Hunter)',
      ap: 1,
      type: 'unique',
      sourceText: `Merciless Hunter: ${abilityText(C.assassin, A.mercilessHunter)}`,
      available: (_ctx, _state, op) => op.datacardId === C.assassin,
      check: (ctx, state, op, params) => {
        if (!op.actionsThisActivation.includes('Shoot'))
          return { ok: false, reason: 'Merciless Hunter is the second Shoot action of an activation' };
        if (op.actionsThisActivation.includes(ACT.mark))
          return { ok: false, reason: 'it performed the Mark unique action during this activation' };
        // "but a razorwing must be selected for one (and only one) of those actions"
        const first = (effectOn(state, op.id, EFF.rangedThisActivation)?.data?.['weapons'] as string[] | undefined) ?? [];
        const firstRazorwing = first.some((w) => w.trim().toLowerCase() === 'razorwing');
        const nowRazorwing = (params.weaponName ?? '').trim().toLowerCase() === 'razorwing';
        if (firstRazorwing && nowRazorwing)
          return { ok: false, reason: 'a razorwing must be selected for one (and only one) of those actions' };
        if (!firstRazorwing && !nowRazorwing)
          return { ok: false, reason: 'a razorwing must be selected for one of those actions' };
        return getAction('Shoot')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
    },

    // ---- Vitalised Surge's free Dash -------------------------------------
    // "…even if it's performed an action that prevents it from performing the Dash action."
    // The universal Dash refuses after a Charge and refuses a second Dash, so the invigoration
    // gets its own ActionDef (D-021) that keeps the move validation and drops those two bars.
    {
      id: SURGE_DASH,
      name: 'Dash (Vitalised Surge)',
      ap: 1,
      type: 'unique',
      sourceText: `${INVIGORATION_NAME['vitalised-surge']}: ${INVIGORATION_TEXT['vitalised-surge']}`,
      available: (_ctx, state, op) => effectOn(state, op.id, FREE_ACTION_RULE)?.source.id === RULE.invigorations,
      check: (ctx, state, op, params) => {
        if (effectOn(state, op.id, FREE_ACTION_RULE)?.source.id !== RULE.invigorations)
          return { ok: false, reason: 'that operative has no Vitalised Surge Dash to perform' };
        const proxy: OperativeState = {
          ...op,
          actionsThisActivation: op.actionsThisActivation.filter((a) => a !== 'Charge' && a !== 'Dash'),
        };
        return getAction('Dash')!.check(ctx, state, proxy, params);
      },
      perform: (ctx, state, op, params) => getAction('Dash')!.perform(ctx, state, op, params),
    },
  ];
}

function gap(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) - radiusOf(ca.base) - radiusOf(cb.base),
  );
}

function radiusOf(base: { shape: 'round'; mm: number } | { shape: 'oval'; mm: [number, number] }): number {
  return base.shape === 'round' ? base.mm / 2 / 25.4 : Math.max(base.mm[0], base.mm[1]) / 2 / 25.4;
}

function visibleWithin(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  target: OperativeState,
  inches: number,
): boolean {
  if (gap(ctx, op, target) > inches + EPS) return false;
  return isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible;
}

/**
 * "For an operative to take a poison test, roll one D6, adding 1 to the result if that operative
 * has a Save stat of 4+ or worse: on a 3+, inflict D3 damage on that operative and it gains one
 * of your Poison tokens (if it doesn't already have one)."
 */
export function poisonTest(ctx: GameContext, state: GameState, player: PlayerId, victim: OperativeState): number {
  const roll = ctx.rng.d6();
  const modified = roll + (saveOf(ctx, state, victim) >= 4 ? 1 : 0);
  recordRoll(state, 'poisonTest', [roll], player, `poison test vs ${victim.letter} (${modified})`);
  if (modified < 3) return 0;
  const d3 = ctx.rng.d3();
  recordRoll(state, 'poisonTest', [d3], player, `poison test damage vs ${victim.letter}`);
  inflictDamage(ctx, state, victim, d3, 'other');
  const has = state.effects.some((e) => e.rule === POISON && e.operativeId === victim.id && e.player === player);
  if (!has) {
    effect(state, {
      rule: POISON,
      source: { kind: 'ability', id: ACT.tormentGrenade },
      sourceText: shortQuote(actionText(C.disciple, ACT.tormentGrenade)),
      operativeId: victim.id,
      player,
      expiry: { kind: 'endOfBattle' },
    });
    log(state, { kind: 'action', player, text: `${victim.letter} gains a Poison token` });
  }
  return d3;
}

// ---------------------------------------------------------------------------

export const handOfTheArchon = defineTeam({
  id: 'hand-of-the-archon',
  rareRules: ['Flay', 'Stinger', 'Tangle'],
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy when it's your turn to activate a friendly operative."
    [FP.heinousArrogance]: (state, player) => {
      const turn = whoActivates(state);
      if (state.activeOperativeId) return { ok: false, reason: 'an operative is already activated' };
      return turn?.player === player && turn.mode === 'activate'
        ? { ok: true }
        : { ok: false, reason: 'it is not your turn to activate a friendly operative' };
    },
    // "Use this firefight ploy after an opponent uses a firefight ploy (excluding one that costs
    //  0CP)… You cannot use this ploy again during the battle until its effect has ended."
    [FP.deviousScheme]: (state, player) => {
      if (state.effects.some((e) => e.rule === EFF.deviousScheme && e.player === player))
        return { ok: false, reason: 'its previous effect has not ended' };
      const opponent = player === 'p1' ? 'p2' : 'p1';
      const last = (state.opState['handOfTheArchon.lastFirefightPloy'] as Record<string, string> | undefined)?.[opponent];
      return last ? { ok: true } : { ok: false, reason: 'your opponent has not used a firefight ploy' };
    },
    // "Use this firefight ploy after rolling your attack dice for a friendly HAND OF THE ARCHON
    //  operative, if it's shooting against or fighting against a wounded enemy operative."
    [FP.preyOnTheWounded]: (state, player) => {
      const seq = state.sequence;
      if (!seq || seq.kind !== 'shoot' || seq.attacker !== player)
        return { ok: false, reason: 'after rolling your attack dice for a friendly operative' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly HAND OF THE ARCHON operative's activation."
    [FP.cruelDeception]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'during a friendly operative’s activation' };
    },
  },
  aiHints: {
    roles: {
      [C.archsybarite]: 'leader',
      [C.agent]: 'objective',
      [C.duellist]: 'melee',
      [C.disciple]: 'support',
      [C.elixicant]: 'support',
      [C.flayer]: 'melee',
      [C.gunner]: 'gunner',
      [C.heavyGunner]: 'gunner',
      [C.assassin]: 'sniper',
    },
    ployValue: {
      [SP.bladeArtists]: 0.6,
      [SP.fromDarknessDeath]: 0.5,
      [SP.mercilessSadists]: 0.6,
      [SP.denizensOfNight]: 0.5,
      [FP.cruelDeception]: 0.4,
      [FP.heinousArrogance]: 0.2,
      [FP.deviousScheme]: 0.3,
      [FP.preyOnTheWounded]: 0.7,
    },
    equipmentValue: {
      [EQ.chainSnare]: 0.5,
      [EQ.toxinCoating]: 0.6,
      [EQ.wickedBlades]: 0.5,
      [EQ.refinedPoison]: 0.7,
    },
  },
});

export default handOfTheArchon;
