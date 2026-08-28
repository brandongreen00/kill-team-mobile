/**
 * VOID-DANCER TROUPE — Harlequins.
 * https://wahapedia.ru/kill-team3/kill-teams/void-dancer-troupe/
 *
 * Four datacards, two dense faction rules, three abilities and two PSYCHIC unique actions.
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read out of `data/teams/void-dancer-troupe.json` at module load and never retyped.
 *
 * Four shapes drive the module:
 *
 *  - **Saedath** is a STRATEGIC GAMBIT menu. Its two ALLEGORIES (Epic / Melodrama) have no ids
 *    of their own in the JSON, so they are sliced out of the one printed faction rule at load
 *    (the Legionary Marks of Chaos / Death Korps Guardsmen Orders treatment) and offered as one
 *    gambit id each, so the pick lands in `gambitsUsedTP` (the Kasrkin SKILL AT ARMS precedent).
 *    Everything else — the PIVOTAL ROLE, the ACCOLADE grants, the performance trigger, Lead the
 *    Performance and UNDERSTUDY'S MASK — reads the two effects it plants.
 *  - **Harlequin's Panoply** is three clauses of which only the Piercing one has a seam. The
 *    defence pool is `3 − Piercing`, so "worsen the x of the Piercing weapon rule by 1" is one
 *    more defence dice (the Corsair MISTFIELD precedent). The climbing clause and the
 *    move-within-control-range clause are reminder-only; see the comments where they belong.
 *  - **Two fight-ending / fight-extending firefight ploys** (MURDEROUS ENTRANCE, THE CURTAIN
 *    FALLS) reach into the live `FightSequence`, clear the stale `strikeOrBlock` decision and
 *    let `advanceFight` re-raise it (the Murderwing LONG FORGOTTEN HONOUR precedent).
 *  - **WRAITHBONE TALISMAN uses `onWeaponRules` as a post-roll seam.** `effectiveRules` is
 *    re-emitted at the top of every `advanceShoot`/`advanceFight` pass, so a handler gated on
 *    `state.sequence.step === 'retention'` sees a rolled pool in a shoot AND in a fight — which
 *    is how the printed "shooting, fighting or retaliating" is honoured in full despite
 *    `fight.ts` emitting no `onRollAttack` (docs/DECISIONS.md D-031).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits, hasRule, lethalThreshold, successes, type Die } from '../../core/dice.ts';
import { baseGap, baseRadius, basesOverlap } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { advanceFight, resolveFightDie, sideWeapon } from '../../core/sequences/fight.ts';
import { advanceShoot, checkTarget } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  card,
  hitOf,
  inControlRange,
  inflictDamage,
  log,
  modelHeight,
  recordRoll,
  removeIncapacitated,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, surfaceAt } from '../../core/terrain.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PlayerId,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  catalogueCard,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  gambitUsed,
  giveToken,
  hasEquipment,
  hasToken,
  isInjuredCard,
  notEngaged,
  removeToken,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('void-dancer-troupe');
export const KW = 'VOID-DANCER TROUPE';
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
  leadPlayer: 'void-dancer-troupe.lead-player',
  deathJester: 'void-dancer-troupe.death-jester',
  player: 'void-dancer-troupe.player',
  shadowseer: 'void-dancer-troupe.shadowseer',
} as const;

export const RULE = {
  saedath: 'void-dancer-troupe.rule.saedath',
  panoply: 'void-dancer-troupe.rule.harlequins-panoply',
} as const;

export const SP = {
  dartingSalvo: 'void-dancer-troupe.sp.darting-salvo',
  risingCrescendo: 'void-dancer-troupe.sp.rising-crescendo',
  prismaticBlur: 'void-dancer-troupe.sp.prismatic-blur',
  cegorachsJest: 'void-dancer-troupe.sp.cegorachs-jest',
} as const;

export const FP = {
  murderousEntrance: 'void-dancer-troupe.fp.murderous-entrance',
  theCurtainFalls: 'void-dancer-troupe.fp.the-curtain-falls',
  elusiveTarget: 'void-dancer-troupe.fp.elusive-target',
  dominoField: 'void-dancer-troupe.fp.domino-field',
} as const;

export const EQ = {
  wraithboneTalisman: 'void-dancer-troupe.eq.wraithbone-talisman',
  shriekerToxinRounds: 'void-dancer-troupe.eq.shrieker-toxin-rounds',
  deathMask: 'void-dancer-troupe.eq.death-mask',
  understudysMask: 'void-dancer-troupe.eq.understudys-mask',
} as const;

export const A = {
  leadThePerformance: `${C.leadPlayer}.lead-the-performance`,
  humblingCruelty: `${C.deathJester}.humbling-cruelty`,
  luckOfTheLaughingGod: `${C.player}.luck-of-the-laughing-god`,
} as const;

export const ACT = {
  fogOfDreams: `${C.shadowseer}.act.fog-of-dreams`,
  mirrorOfMinds: `${C.shadowseer}.act.mirror-of-minds`,
} as const;

/** Extra `ActionDef`s that carry what a universal action forbids (docs/DECISIONS.md D-021). */
export const REPOSITION_SALVO = 'Reposition (DARTING SALVO)';
export const DASH_CRESCENDO = 'Dash (RISING CRESCENDO)';

/** Effect / scratch keys — all namespaced, never module-level state (architecture rule 7). */
const E_ALLEGORY = 'vdt.allegory';
const E_PIVOTAL = 'vdt.pivotalRole';
const E_ACCOLADE = 'vdt.accolade';
const E_ELUSIVE = 'vdt.elusiveTarget';
const E_TOXIN = 'vdt.shriekerToxin';
const E_FOG = 'vdt.fogOfDreams';
const ACTIVATION_MARK = 'vdt.activation';

/** "the target gains one of your Humbling Cruelty tokens" — a per-player token on the enemy. */
export const HUMBLING_TOKEN = 'Humbling Cruelty';

// ---------------------------------------------------------------------------
// Saedath — the ALLEGORY menu, sliced out of the one printed faction rule
// ---------------------------------------------------------------------------

export interface Allegory {
  id: 'epic' | 'melodrama';
  name: string;
  performance: string;
  accolade: string;
}

/**
 * Saedath prints its two ALLEGORIES as a MENU inside one faction rule, with a Performance and
 * an Accolade line each and no ids of their own, so they are sliced out of the printed text at
 * module load rather than retyped (CLAUDE.md: rules as data; the Legionary Marks of Chaos and
 * Death Korps Guardsmen Orders precedent).
 */
function sliceAllegories(raw: string): Allegory[] {
  const names = ['Epic', 'Melodrama'] as const;
  const out: Allegory[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const start = raw.indexOf(`\n${name}\n`);
    if (start < 0) throw new Error(`Saedath: no '${name}' ALLEGORY in data/teams/${DATA.id}.json`);
    const after = names[i + 1];
    const end = after ? raw.indexOf(`\n${after}\n`, start + 1) : -1;
    const section = end < 0 ? raw.slice(start) : raw.slice(start, end);
    const performance = /Performance:\s*([^\n]+)/.exec(section)?.[1]?.trim();
    const accolade = /Accolade:\s*([^\n]+)/.exec(section)?.[1]?.trim();
    if (!performance || !accolade)
      throw new Error(`Saedath: '${name}' has no Performance/Accolade line in data/teams/${DATA.id}.json`);
    out.push({ id: name.toLowerCase() as Allegory['id'], name, performance, accolade });
  }
  return out;
}

export const ALLEGORIES: Allegory[] = sliceAllegories(text(RULE.saedath));

/** One gambit id per ALLEGORY, so the player's choice lands in `gambitsUsedTP`. */
export const saedathGambit = (id: Allegory['id']): string => `${RULE.saedath}:${id}`;
/** "As a STRATEGIC GAMBIT in each subsequent turning point, you can select one friendly…" */
export const SAEDATH_ACCOLADE = `${RULE.saedath}:accolade`;

export function allegoryOf(state: GameState, player: PlayerId): Allegory | undefined {
  const eff = effectFor(state, player, E_ALLEGORY);
  return eff ? ALLEGORIES.find((a) => a.id === eff.data?.['allegory']) : undefined;
}

/** The PIVOTAL ROLE holder, even once it has been incapacitated (UNDERSTUDY'S MASK reads that). */
export function pivotalRole(state: GameState, player: PlayerId): OperativeState | undefined {
  const eff = state.effects.find((e) => e.rule === E_PIVOTAL && e.player === player);
  return eff?.operativeId ? state.operatives[eff.operativeId] : undefined;
}

/**
 * "Whenever a friendly operative has the PIVOTAL ROLE, it has the ACCOLADE rule of your
 * ALLEGORY for the battle" — so the PIVOTAL ROLE operative always counts as having one.
 */
export function hasAccolade(state: GameState, op: OperativeState): boolean {
  if (state.effects.some((e) => e.rule === E_ACCOLADE && e.operativeId === op.id)) return true;
  return state.effects.some((e) => e.rule === E_PIVOTAL && e.operativeId === op.id);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const catKw = (op: OperativeState, keyword: string): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

const activeFriendly = (state: GameState, player: PlayerId): OperativeState | undefined => {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return op && op.player === player && !op.removed ? op : undefined;
};

function profileOf(
  T: TeamHooks,
  op: OperativeState,
  weaponName: string,
  profileName?: string,
): WeaponProfile | undefined {
  const w = (T.card(op)?.weapons ?? []).find((x) => x.name === weaponName);
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w.profiles[0];
}

/**
 * Crit-ness of a retained dice, recomputed from its value. `classify` only ever looks at the
 * value, Lethal x+ and 6s — never at the Hit stat — so a dice whose `state` has already moved
 * on to 'struck' can still be told apart, which is what "strikes with a normal success"
 * (CEGORACH'S JEST) and "strike with a critical success" (THE CURTAIN FALLS) both need.
 */
const dieWasCrit = (die: Die, lethal?: number): boolean =>
  die.rolled && (die.value === 6 || (lethal !== undefined && die.value >= lethal));

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade', DASH_CRESCENDO, REPOSITION_SALVO];

/** Which turning point this operative last activated in (PRISMATIC BLUR reads it). */
const activationTP = (state: GameState, op: OperativeState): number =>
  Number(bucket(state, 'vdt.activatedTP')[op.id] ?? -1);

/** "…that performed an action in which it moved during this turning point" (PRISMATIC BLUR). */
export function movedThisTP(state: GameState, op: OperativeState): boolean {
  return (
    activationTP(state, op) === state.turningPoint && op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a))
  );
}

/** Distance this operative has moved so far in this activation, from the log `applyMove` writes. */
function movedThisActivation(state: GameState, op: OperativeState): number {
  const start = effectOn(state, op.id, ACTIVATION_MARK)?.data?.['seq'];
  if (typeof start !== 'number') return 0;
  let total = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.seq < start) break;
    if (entry.kind !== 'action' || entry.data?.['operativeId'] !== op.id) continue;
    const inches = entry.data?.['inches'];
    if (typeof inches === 'number') total += inches;
  }
  return total;
}

function d6(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, DATA.id, [roll], T.player, note);
  return roll;
}

function setAllegory(T: TeamHooks, state: GameState, allegory: Allegory): void {
  dropEffects(state, (e) => e.rule === E_ALLEGORY && e.player === T.player);
  effect(state, {
    rule: E_ALLEGORY,
    source: { kind: 'ability', id: RULE.saedath },
    sourceText: shortQuote(`${allegory.name}. Accolade: ${allegory.accolade}`),
    player: T.player,
    data: { allegory: allegory.id },
    expiry: { kind: 'endOfBattle' }, // "for the battle"
  });
}

function setPivotal(T: TeamHooks, state: GameState, op: OperativeState): void {
  dropEffects(state, (e) => e.rule === E_PIVOTAL && e.player === T.player);
  effect(state, {
    rule: E_PIVOTAL,
    source: { kind: 'ability', id: RULE.saedath },
    sourceText: shortQuote(text(RULE.saedath)),
    operativeId: op.id,
    player: T.player,
    expiry: { kind: 'endOfBattle' }, // "for the battle"
  });
}

/** "…select one friendly VOID-DANCER TROUPE operative to gain the ACCOLADE rule." */
function accoladeCandidates(T: TeamHooks, state: GameState): OperativeState[] {
  return T.friendlies(state, KW)
    .filter((o) => !hasAccolade(state, o))
    .sort(byId);
}

function grantAccolade(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
  source: string,
): OperativeState | undefined {
  const chosen = chosenOperative(state, data, accoladeCandidates(T, state));
  if (!chosen) return undefined;
  effect(state, {
    rule: E_ACCOLADE,
    source: { kind: 'ability', id: RULE.saedath },
    sourceText: shortQuote(text(RULE.saedath)),
    operativeId: chosen.id,
    player: T.player,
    expiry: { kind: 'endOfBattle' }, // "for the battle"
  });
  log(state, {
    kind: 'ploy',
    player: T.player,
    text: `Saedath (${source}): ${chosen.letter} gains the ACCOLADE`,
    data: { operativeId: chosen.id },
  });
  return chosen;
}

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Bookkeeping every rule below reads
  // =========================================================================
  reg.on('onActivationStart', T.bindText('vdt.activationLedger', text(RULE.saedath), 1), (ev) => {
    bucket(ev.state, 'vdt.activatedTP')[ev.operative.id] = ev.state.turningPoint;
    if (ev.operative.player !== T.player) return;
    // The log cursor DARTING SALVO's "any remaining move distance" is measured from.
    dropEffects(ev.state, (e) => e.rule === ACTIVATION_MARK && e.operativeId === ev.operative.id);
    effect(ev.state, {
      rule: ACTIVATION_MARK,
      source: { kind: 'core', id: RULE.saedath },
      operativeId: ev.operative.id,
      player: T.player,
      data: { seq: ev.state.seq },
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });

  // =========================================================================
  // Saedath
  // =========================================================================
  // "As a STRATEGIC GAMBIT in the first turning point, you MUST select an ALLEGORY (Epic or
  //  Melodrama below) for your kill team for the battle, and one friendly VOID-DANCER TROUPE
  //  operative to have the PIVOTAL ROLE for the battle."
  //
  //  One gambit id per ALLEGORY (the Kasrkin SKILL AT ARMS precedent), and the PIVOTAL ROLE
  //  comes from the gambit's `data` with a deterministic, logged default (D-016). The engine
  //  cannot force a mandatory gambit, so the pair stays on offer until it has been taken rather
  //  than vanishing after the first turning point — a player who passed in TP1 would otherwise
  //  spend the whole battle with six of this team's rules switched off.
  for (const allegory of ALLEGORIES) {
    reg.on('gambitOptions', T.bind(RULE.saedath, 15), (ev) => {
      if (ev.player !== T.player) return;
      if (allegoryOf(ev.state, T.player)) return;
      if (T.friendlies(ev.state, KW).length === 0) return;
      ev.options.push({
        id: saedathGambit(allegory.id),
        label: `SAEDATH: ${allegory.name}`,
        sourceText: shortQuote(`${allegory.name}. Performance: ${allegory.performance} Accolade: ${allegory.accolade}`),
      });
    });
  }

  // "As a STRATEGIC GAMBIT in each subsequent turning point, you can select one friendly
  //  VOID-DANCER TROUPE operative to gain the ACCOLADE rule of your ALLEGORY for the battle."
  reg.on('gambitOptions', T.bind(RULE.saedath, 16), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.state.turningPoint < 2) return; // "in each SUBSEQUENT turning point"
    if (!allegoryOf(ev.state, T.player)) return;
    if (accoladeCandidates(T, ev.state).length === 0) return;
    ev.options.push({
      id: SAEDATH_ACCOLADE,
      label: 'SAEDATH: an operative gains the ACCOLADE',
      sourceText: shortQuote(text(RULE.saedath)),
    });
  });

  reg.on('onPloyUsed', T.bind(RULE.saedath, 16), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId === SAEDATH_ACCOLADE) {
      grantAccolade(T, ev.state, ev.data, 'STRATEGIC GAMBIT');
      return;
    }
    const allegory = ALLEGORIES.find((a) => saedathGambit(a.id) === ev.ployId);
    if (!allegory) return;
    setAllegory(T, ev.state, allegory);
    const star = chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW).sort(byId));
    if (star) setPivotal(T, ev.state, star);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Saedath: ${allegory.name}${star ? ` — ${star.letter} has the PIVOTAL ROLE` : ''}`,
      ...(star ? { data: { operativeId: star.id } } : {}),
    });
  });

  // "Once per turning point, when a friendly operative that has the PIVOTAL ROLE completes the
  //  performance of your ALLEGORY, you can select one friendly VOID-DANCER TROUPE operative to
  //  gain the ACCOLADE rule of your ALLEGORY for the battle."
  //   Epic      Performance: the operative incapacitates an enemy operative while FIGHTING.
  //   Melodrama Performance: the operative incapacitates an enemy operative while SHOOTING.
  //  Free and it can only help, so it is taken on its printed trigger (D-022) and the operative
  //  that gains the ACCOLADE is the deterministic default (D-016) — there is no decision channel
  //  inside `onIncapacitated`.
  reg.on('onIncapacitated', T.bind(RULE.saedath, 14), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (victim.player === T.player) return; // "incapacitates an ENEMY operative"
    const allegory = allegoryOf(ev.state, T.player);
    const star = pivotalRole(ev.state, T.player);
    if (!allegory || !star) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const performed =
      allegory.id === 'epic'
        ? seq.kind === 'fight' && seq.attackerId === star.id && seq.defenderId === victim.id
        : seq.kind === 'shoot' && seq.attackerId === star.id;
    if (!performed) return;
    if (!useOncePerTP(ev.state, `vdt.performance:${T.player}`)) return;
    grantAccolade(T, ev.state, undefined, `${allegory.name} performance`);
  });

  // Epic     — "Whenever this operative is fighting, its melee weapons have the Balanced
  //             weapon rule." ("fighting", not "fighting or retaliating".)
  // Melodrama — "The operative's ranged weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(RULE.saedath, 12), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!hasAccolade(ev.state, op)) return;
    const allegory = allegoryOf(ev.state, T.player);
    if (!allegory) return;
    if (allegory.id === 'epic') {
      if (ev.type !== 'melee' || ev.retaliating) return;
      ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Epic ACCOLADE)'));
    } else {
      if (ev.type !== 'ranged') return;
      ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Melodrama ACCOLADE)'));
    }
  });

  // =========================================================================
  // LEAD PLAYER › Lead the Performance
  // =========================================================================
  // "Once per battle STRATEGIC GAMBIT. If this operative is in the killzone, change the
  //  ALLEGORY you selected for your kill team. Note that the ACCOLADE rule friendly operatives
  //  have will also change." — the ACCOLADE is derived from the current ALLEGORY on every read,
  //  so the second sentence holds by construction.
  reg.on('gambitOptions', T.bind(A.leadThePerformance, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (usedThisBattle(ev.state, `vdt.leadPerformance:${T.player}`)) return;
    if (!allegoryOf(ev.state, T.player)) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === C.leadPlayer)) return;
    ev.options.push({
      id: A.leadThePerformance,
      label: 'Lead the Performance (STRATEGIC GAMBIT)',
      sourceText: shortQuote(abilityText(C.leadPlayer, A.leadThePerformance)),
    });
  });
  reg.on('onPloyUsed', T.bind(A.leadThePerformance, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== A.leadThePerformance) return;
    const current = allegoryOf(ev.state, T.player);
    if (!current) return;
    const next = ALLEGORIES.find((a) => a.id !== current.id);
    if (!next) return;
    useOncePerBattle(ev.state, `vdt.leadPerformance:${T.player}`);
    setAllegory(T, ev.state, next);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Lead the Performance: the ALLEGORY becomes ${next.name}`,
    });
  });

  // =========================================================================
  // Harlequin's Panoply
  // =========================================================================
  // "Whenever an operative is shooting a friendly VOID-DANCER TROUPE operative, and no attack
  //  dice are retained as critical successes, worsen the x of the Piercing weapon rule by 1 (if
  //  any). Note that Piercing 1 would therefore be ignored."
  //
  //  The defence pool is `3 − Piercing` (`src/core/sequences/shoot.ts`), so worsening x by 1 is
  //  exactly one more defence dice — and Piercing 1 is therefore ignored, as the note says (the
  //  Corsair Voidscarred MISTFIELD precedent). Retained crits are known at the Roll Defence Dice
  //  step, which is where the engine reads Piercing.
  reg.on('onDefenceDice', T.bind(RULE.panoply, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (!hasRule(ev.ctx.rules, 'Piercing')) return; // "(if any)"
    if (countCrits(seq.attack) > 0) return; // "no attack dice are retained as critical successes"
    ev.count += 1;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Harlequin’s Panoply: Piercing worsened by 1 against ${target.letter} (${ev.count} defence dice)`,
    });
  });

  // REMINDER-ONLY (1/2). "Whenever a friendly VOID-DANCER TROUPE operative is climbing up, you
  // can treat the vertical distance as 2" (regardless of how far the operative actually moves
  // vertically)." `validateMove` charges each climb leg internally (`Math.max(2, dz)`) and
  // `onMoveRules` is declared but never emitted, so there is no per-leg seam — the same gap as
  // the Ratlings' Grappling Hook and the Scout Squad's / Phobos' Grapnel Launcher
  // (docs/TEAM-STATUS.md § Known engine gaps). No handler is registered.

  // REMINDER-ONLY (2/2), and a no-op by construction. "Friendly VOID-DANCER TROUPE operatives
  // can move within control range of enemy operatives (they must still start and end the move
  // following all requirements for that move)." `validateMove` only ever tests the END of a move
  // against enemy control range (`mustNotFinishEngaged`); `MoveOptions.mayEnterEnemyControlRange`
  // is declared but never read, so nothing in the engine restricts the middle of a move. The
  // permission this clause grants is therefore already true for every operative in the game, and
  // registering a handler would be the silent no-op architecture rule 5 forbids.

  // =========================================================================
  // DEATH JESTER › Humbling Cruelty (the rare weapon rule on the shrieker cannon)
  // =========================================================================
  // "If the target of this weapon isn't incapacitated but any of your attack dice inflict
  //  damage, the target gains one of your Humbling Cruelty tokens (if it doesn't already have
  //  one)." Devastating damage comes from retained critical successes, so it counts as attack
  //  dice inflicting damage; the "isn't incapacitated" half is enforced twice — the token is not
  //  handed out by a killing blow, and it is stripped again if a later dice of the same shot
  //  finishes the target off.
  reg.on('onDamage', T.bind(A.humblingCruelty, 12), (ev) => {
    if (ev.amount <= 0) return;
    if (ev.kind !== 'attack' && ev.kind !== 'devastating') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== ev.target.id) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player) return;
    const profile = profileOf(T, attacker, seq.weaponName, seq.profileName);
    if (!profile?.rules.some((r) => r.id === 'HumblingCruelty')) return;
    if (ev.target.wounds - ev.amount <= 0) return; // "isn't incapacitated"
    giveToken(ev.state, ev.target, HUMBLING_TOKEN, {
      sourceId: A.humblingCruelty,
      sourceText: shortQuote(abilityText(C.deathJester, A.humblingCruelty)),
      player: T.player,
      // "At the end of that enemy operative's next activation, remove its token." `armed: true`
      // fires at the end of the FIRST activation-end seen, which is the right one whenever the
      // token lands outside that operative's own activation; when it lands during it (an On
      // Guard interrupt or a counteraction), the expiry is left unarmed so it survives to the
      // next one.
      expiry: { kind: 'endOfNextActivation', operativeId: ev.target.id, armed: ev.state.activeOperativeId !== ev.target.id },
    });
  });
  reg.on('onIncapacitated', T.bind(A.humblingCruelty, 13), (ev) => {
    if (ev.prevented) return;
    if (hasToken(ev.state, ev.operative.id, HUMBLING_TOKEN, T.player)) removeToken(ev.state, ev.operative.id, HUMBLING_TOKEN);
  });
  // "Whenever an enemy operative has one of your Humbling Cruelty tokens, subtract 2" from its
  //  Move stat and worsen the Hit stat of its weapons by 1. This isn't cumulative with being
  //  injured." `moveOf` and `hitOf` both consult `onStatMod`, and both apply the injured
  //  penalties themselves, so the token stands down while the operative is already injured.
  reg.on('onStatMod', T.bind(A.humblingCruelty, 12), (ev) => {
    const op = ev.operative;
    if (op.player === T.player) return;
    if (!hasToken(ev.state, op.id, HUMBLING_TOKEN, T.player)) return;
    if (isInjuredCard(T.card(op), op)) return; // "isn't cumulative with being injured"
    ev.mods.move -= 2;
    ev.mods.hit -= 1;
  });

  // =========================================================================
  // PLAYER › Luck of the Laughing God
  // =========================================================================
  // "Once per turning point, you can use this rule. If you do, you can use a firefight ploy for
  //  0CP if this is the specified VOID-DANCER TROUPE operative … You cannot select the same
  //  firefight ploy for this rule more than once per battle."
  //
  //  The reducer charges the CP before any hook sees the ploy, so the discount is a refund (the
  //  Corsair Prowling Raiders / Angels of Death Heroic Leader precedent). "The specified
  //  operative" is ploy-specific, so it is read as: the friendly operative in the sequence the
  //  ploy interrupts, else the activated operative.
  //  PARTIAL — the printed "(including Command Re-roll…)" half is unreachable: Command Re-roll is
  //  charged inside `applyReroll` (`src/core/decisions.ts`) and emits no `onPloyUsed`.
  reg.on('onPloyUsed', T.bind(A.luckOfTheLaughingGod, 15), (ev) => {
    if (ev.player !== T.player || ev.kind !== 'firefight') return;
    const ply = DATA.firefightPloys.find((p) => p.id === ev.ployId);
    if (!ply || ply.cp <= 0) return;
    const specified = specifiedOperative(T, ev.state);
    if (!specified || specified.datacardId !== C.player) return;
    if (usedThisTP(ev.state, `vdt.luck:${T.player}`)) return;
    const b = bucket(ev.state, 'vdt.luckPloys');
    const seen = (b[T.player] as string[] | undefined) ?? [];
    if (seen.includes(ev.ployId)) return; // "not the same firefight ploy more than once per battle"
    useOncePerTP(ev.state, `vdt.luck:${T.player}`);
    b[T.player] = [...seen, ev.ployId];
    ev.state.teams[T.player].cp += ply.cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Luck of the Laughing God: ${ply.name} costs ${specified.letter} 0CP`,
    });
  });

  // =========================================================================
  // SHADOWSEER › FOG OF DREAMS (the lock; the action is below)
  // =========================================================================
  // "…until your opponent has activated a number of enemy operatives after this action equal to
  //  the result of the D6 (whichever comes first)."
  reg.on('onActivationStart', T.bind(ACT.fogOfDreams, 13), (ev) => {
    if (ev.operative.player === T.player) return;
    for (const eff of ev.state.effects) {
      if (eff.rule !== E_FOG || eff.player !== T.player || !eff.data) continue;
      eff.data['count'] = Number(eff.data['count'] ?? 0) + 1;
    }
  });
  // PARTIAL — "that enemy operative cannot be activated or perform actions until…". The engine
  // has no seam that refuses an activation (the Hierotek VISION OF MADNESS gap), so the
  // activation itself still happens; every action inside it is refused, which is the printed
  // second half in full.
  reg.on('canPerformAction', T.bind(ACT.fogOfDreams, 13), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!fogLocked(ev.state, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'FOG OF DREAMS: this operative cannot perform actions';
  });
}

/** "…if this is the specified VOID-DANCER TROUPE operative" (Luck of the Laughing God). */
function specifiedOperative(T: TeamHooks, state: GameState): OperativeState | undefined {
  const seq = state.sequence;
  if (seq?.kind === 'shoot') {
    const target = state.operatives[seq.targetId];
    if (target && target.player === T.player) return target;
    const attacker = state.operatives[seq.attackerId];
    if (attacker && attacker.player === T.player) return attacker;
  } else if (seq?.kind === 'fight') {
    for (const id of [seq.attackerId, seq.defenderId]) {
      const o = state.operatives[id];
      if (o && o.player === T.player) return o;
    }
  }
  return activeFriendly(state, T.player);
}

/** Is this enemy operative still held by FOG OF DREAMS? */
export function fogLocked(state: GameState, op: OperativeState): boolean {
  const eff = state.effects.find((e) => e.rule === E_FOG && e.operativeId === op.id);
  if (!eff) return false;
  if (Number(eff.data?.['count'] ?? 0) >= Number(eff.data?.['limit'] ?? 0)) return false;
  // "…until it's the last enemy operative to be activated"
  return aliveOperatives(state, op.player).some((o) => o.id !== op.id && o.ready);
}

// ---------------------------------------------------------------------------
// Strategy and firefight ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- DARTING SALVO (strategy) ------------------------------------------
  // "Whenever a friendly VOID-DANCER TROUPE operative performs the Reposition action during its
  //  activation, it can perform the Shoot action during that action (it must do so in a location
  //  it can be placed, and any remaining move distance it had from that Reposition action can be
  //  used after it does so)."
  //
  //  PARTIAL. The engine cannot interleave one action inside another, so the Reposition is split
  //  around the shot instead: Reposition, Shoot, then `Reposition (DARTING SALVO)` (0AP, D-021)
  //  for whatever move distance was left. AP and total distance are exactly the printed ones;
  //  what is lost is that the shot happens at the end of the first leg rather than at any point
  //  the player likes along it.
  reg.on('onMoveDistance', T.bind(SP.dartingSalvo, 20), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || ev.action !== 'Reposition') return;
    if (!gambitUsed(ev.state, T.player, SP.dartingSalvo)) return;
    if (!op.actionsThisActivation.includes('Reposition')) return; // only the follow-up leg
    ev.inches = Math.max(0, ev.inches - movedThisActivation(ev.state, op));
  });

  // ---- RISING CRESCENDO (strategy) ---------------------------------------
  // "Friendly VOID-DANCER TROUPE operatives can perform the Dash action during the same
  //  activation in which they performed the Charge action, but not vice versa (i.e. not DASH
  //  then CHARGE)." The Dash half is `Dash (RISING CRESCENDO)` below (D-021 — the universal Dash
  //  refuses an activation in which the operative Charged); the "not vice versa" half needs no
  //  code, because the universal Charge already refuses after a Dash.

  // ---- PRISMATIC BLUR (strategy) -----------------------------------------
  // "Whenever an operative is shooting a friendly VOID-DANCER TROUPE operative that performed an
  //  action in which it moved during this turning point, you can re-roll one of your defence
  //  dice."
  reg.on('onDefenceDice', T.bind(SP.prismaticBlur, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.prismaticBlur)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!movedThisTP(ev.state, target)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    ev.rerolls.push({
      id: 'vdt.prismaticBlur',
      label: 'PRISMATIC BLUR: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: target.player,
      sourceText: shortQuote(text(SP.prismaticBlur)),
    });
  });

  // ---- CEGORACH'S JEST (strategy) ----------------------------------------
  // "Whenever a friendly VOID-DANCER TROUPE operative is fighting or retaliating and your
  //  opponent strikes with a normal success, you can roll one D6: if the result is less than the
  //  Hit stat of your opponent's selected weapon, that strike is allocated to block one of your
  //  dice instead (ignore the Brutal weapon rule, if relevant) and you cannot use this rule for
  //  the rest of the sequence."
  //
  //  `resolveFightDie` marks the dice 'struck' and inflicts the damage in the same breath, so the
  //  window is `onDamage`: the strike is identified from the striker's pool (a per-sequence
  //  ledger of dice already resolved), its crit-ness recomputed from its value, the damage zeroed
  //  and the dice turned into a block. Free and it can only help, so the D6 is rolled on its
  //  printed trigger (D-022); the printed lockout is in the consequent, so a failed roll may be
  //  tried again on the next strike, exactly as printed.
  reg.on('onDamage', T.bind(SP.cegorachsJest, 11), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.cegorachsJest)) return;
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    const victim = ev.target;
    if (!T.mineKw(victim, KW)) return;
    const seq = fightSeq(ev.state);
    const ctx = T.ctx;
    if (!seq || !ctx) return;
    const mySide = seq.attackerId === victim.id ? 'attacker' : seq.defenderId === victim.id ? 'defender' : undefined;
    if (!mySide) return;
    const foeSide = mySide === 'attacker' ? 'defender' : 'attacker';
    const striker = ev.state.operatives[foeSide === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!striker || striker.player === T.player) return;
    const ledger = jestLedger(ev.state, seq);
    if (ledger['used'] === true) return; // "you cannot use this rule for the rest of the sequence"
    const foePool = foeSide === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const seen = (ledger['seen'] as number[] | undefined) ?? [];
    const die = foePool.dice.find((d) => d.state === 'struck' && !seen.includes(d.id));
    if (!die) return;
    ledger['seen'] = [...seen, die.id];
    const { profile, rules } = sideWeapon(ctx, ev.state, seq, foeSide);
    if (dieWasCrit(die, lethalThreshold(rules))) return; // "strikes with a NORMAL success"
    const assists = foeSide === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    const hit = hitOf(ctx, ev.state, striker, profile, assists);
    const roll = d6(T, ev.state, "CEGORACH’S JEST D6");
    if (roll >= hit) {
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `CEGORACH’S JEST: ${roll} is not less than ${striker.letter}'s Hit ${hit}+`,
      });
      return;
    }
    ledger['used'] = true;
    // "that strike is allocated to block one of your dice instead (ignore the Brutal weapon
    //  rule, if relevant)" — the striking dice is spent as a block, and the engine's own default
    //  block target is used: the dearest of the defender's unresolved successes.
    die.state = 'discarded';
    die.note = 'CEGORACH’S JEST';
    const myPool = mySide === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const mine = successes(myPool);
    const blocked = mine.find((d) => d.state === 'crit') ?? mine[0];
    if (blocked) {
      blocked.state = 'blocked';
      blocked.note = 'CEGORACH’S JEST';
    }
    ev.amount = 0;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `CEGORACH’S JEST: ${roll} < Hit ${hit}+ — ${striker.letter}'s strike blocks ${victim.letter} instead`,
    });
  });

  // ---- MURDEROUS ENTRANCE (firefight) ------------------------------------
  // "Use this firefight ploy when a friendly VOID-DANCER TROUPE operative is fighting during an
  //  activation in which it performed the Charge action, after you strike. You can immediately
  //  resolve another of your normal successes as a strike (before your opponent), or one of your
  //  critical successes if there are none."
  reg.on('onPloyUsed', T.bind(FP.murderousEntrance, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.murderousEntrance) return;
    const ctx = T.ctx;
    const seq = fightSeq(ev.state);
    if (!ctx || !seq || seq.attacker !== T.player) return;
    const me = ev.state.operatives[seq.attackerId];
    if (!me || !T.kw(me, KW) || !me.actionsThisActivation.includes('Charge')) return;
    const pool = seq.attackerPool;
    const die = pool.dice.find((d) => d.state === 'normal') ?? pool.dice.find((d) => d.state === 'crit');
    if (!die) return;
    // The opponent's pending strike/block decision was built before this extra strike; it is
    // dropped and `advanceFight` raises a fresh one (the Murderwing precedent).
    ev.state.pending = ev.state.pending.filter((p) => p.kind !== 'strikeOrBlock');
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `MURDEROUS ENTRANCE: ${me.letter} resolves another ${die.state === 'crit' ? 'critical' : 'normal'} success`,
    });
    resolveFightDie(ctx, ev.state, seq, 'attacker', die.id, 'strike');
    advanceFight(ctx, ev.state);
    finishFight(ctx, ev.state);
  });

  // ---- THE CURTAIN FALLS (firefight) -------------------------------------
  // "Use this firefight ploy when a friendly VOID-DANCER TROUPE operative is fighting, after you
  //  strike with a critical success, if the enemy operative isn't incapacitated. End that
  //  sequence (any remaining attack dice are discarded) and immediately perform a free Fall Back
  //  action up to 3" with that operative (then the Fight action ends). That operative can do so
  //  even if it's performed an action that prevents it from performing the Fall Back action."
  //
  //  Word for word the Murderwing's LONG FORGOTTEN HONOUR, and implemented the same way: the
  //  sequence ends and the operative is moved directly, because the free Fall Back has to happen
  //  while a fight sequence is still on the table and no intent can be issued there.
  reg.on('onPloyUsed', T.bind(FP.theCurtainFalls, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.theCurtainFalls) return;
    const ctx = T.ctx;
    const seq = fightSeq(ev.state);
    if (!ctx || !seq || seq.attacker !== T.player) return;
    const me = ev.state.operatives[seq.attackerId];
    const foe = ev.state.operatives[seq.defenderId];
    if (!me || !T.kw(me, KW)) return;
    for (const pool of [seq.attackerPool, seq.defenderPool])
      for (const d of pool.dice)
        if (d.state === 'crit' || d.state === 'normal') {
          d.state = 'discarded';
          d.note = 'THE CURTAIN FALLS';
        }
    seq.step = 'done';
    ev.state.pending = ev.state.pending.filter((p) => p.kind !== 'strikeOrBlock');
    removeIncapacitated(ctx, ev.state);
    ev.state.sequence = null;
    const spot = foe ? retreatSpot(ctx, ev.state, me, foe, 3) : undefined;
    if (spot) {
      me.pos = { ...spot.pos };
      me.z = spot.z;
      me.stickyEngagedWith = [];
    }
    me.onGuard = false;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `THE CURTAIN FALLS: ${me.letter} ends the fight and falls back${spot ? ' up to 3"' : ' (nowhere to go)'}`,
    });
  });

  // ---- ELUSIVE TARGET (firefight) ----------------------------------------
  // "Use this firefight ploy during a friendly VOID-DANCER TROUPE operative's activation."
  reg.on('onPloyUsed', T.bind(FP.elusiveTarget, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.elusiveTarget) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op || !T.kw(op, KW)) return;
    effect(ev.state, {
      rule: E_ELUSIVE,
      source: { kind: 'ploy', id: FP.elusiveTarget },
      sourceText: shortQuote(text(FP.elusiveTarget)),
      operativeId: op.id,
      player: T.player,
      // "Until the start of its next activation" — dropped by the handler below.
      expiry: { kind: 'endOfBattle' },
    });
  });
  reg.on('onActivationStart', T.bindText('vdt.elusiveClear', text(FP.elusiveTarget), 2), (ev) => {
    dropEffects(ev.state, (e) => e.rule === E_ELUSIVE && e.operativeId === ev.operative.id);
  });
  // "…while that operative has a Conceal order and is in cover, it cannot be selected as a valid
  //  target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being
  //  within 2"." `onValidTarget` is emitted before the engine works out cover, so cover is
  //  computed here with DEFAULT options — which is exactly what "taking precedence over Seek and
  //  Vantage terrain" means.
  reg.on('onValidTarget', T.bind(FP.elusiveTarget, 21), (ev) => {
    const target = ev.target;
    if (target.player !== T.player) return;
    if (target.order !== 'conceal') return;
    if (!effectOn(ev.state, target.id, E_ELUSIVE)) return;
    const ctx = T.ctx;
    if (!ctx) return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2\""
    const cover = coverAndObscured(terrain(ctx, ev.state), body(ctx, ev.attacker), body(ctx, target));
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'ELUSIVE TARGET: it cannot be selected as a valid target';
  });

  // ---- DOMINO FIELD (firefight) ------------------------------------------
  // "Use this firefight ploy when an operative is shooting a friendly VOID-DANCER TROUPE
  //  operative, during the Resolve Defence Dice step. You can allocate one of your rolled
  //  successful dice to block all of your opponent's attack dice with matching results."
  reg.on('onPloyUsed', T.bind(FP.dominoField, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.dominoField) return;
    const ctx = T.ctx;
    const seq = shootSeq(ev.state);
    if (!ctx || !seq || seq.defender !== T.player) return;
    const match = dominoMatch(seq);
    if (!match) return;
    match.die.state = 'discarded';
    match.die.note = 'DOMINO FIELD';
    for (const d of match.blocked) {
      d.state = 'blocked';
      d.note = 'DOMINO FIELD';
    }
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `DOMINO FIELD: a ${match.die.value} blocks ${match.blocked.length} attack dice showing ${match.die.value}`,
    });
    // The allocation decision was built from the old counts; drop it and let `advanceShoot`
    // raise a fresh one from what is left.
    ev.state.pending = ev.state.pending.filter((p) => p.kind !== 'allocateDefence');
    advanceShoot(ctx, ev.state);
  });
}

/** The best "block all matching results" pairing available to the defender right now. */
function dominoMatch(seq: ShootSequence): { die: Die; blocked: Die[] } | undefined {
  let best: { die: Die; blocked: Die[] } | undefined;
  for (const die of seq.defence.dice) {
    if (!die.rolled || (die.state !== 'crit' && die.state !== 'normal')) continue;
    const blocked = seq.attack.dice.filter(
      (d) => d.rolled && d.value === die.value && (d.state === 'crit' || d.state === 'normal'),
    );
    if (blocked.length === 0) continue;
    const weight = blocked.filter((d) => d.state === 'crit').length * 2 + blocked.length;
    const bestWeight = best ? best.blocked.filter((d) => d.state === 'crit').length * 2 + best.blocked.length : -1;
    if (weight > bestWeight) best = { die, blocked };
  }
  return best;
}

/** Per-sequence scratch for CEGORACH'S JEST (never module-level state). */
function jestLedger(state: GameState, seq: FightSequence): Record<string, unknown> {
  const b = bucket(state, 'vdt.jest');
  const stamp = `${seq.attackerId}:${seq.defenderId}:${state.turningPoint}:${state.activationsThisTP}`;
  if (b['stamp'] !== stamp) {
    b['stamp'] = stamp;
    b['used'] = false;
    b['seen'] = [] as number[];
  }
  return b;
}

/** A fight this module ended by hand leaves nothing for the reducer to clean up. */
function finishFight(ctx: GameContext, state: GameState): void {
  if (state.sequence && state.sequence.step === 'done' && state.pending.length === 0) {
    removeIncapacitated(ctx, state);
    state.sequence = null;
  }
}

/** "…perform a free Fall Back action up to 3" with that operative" (THE CURTAIN FALLS). */
function retreatSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  foe: OperativeState,
  inches: number,
): { pos: Vec2; z: number } | undefined {
  const away = { x: op.pos.x - foe.pos.x, y: op.pos.y - foe.pos.y };
  const len = Math.hypot(away.x, away.y) || 1;
  for (const step of [inches, inches - 0.5, inches - 1, inches - 1.5, inches - 2]) {
    if (step <= 0) break;
    const pos = { x: op.pos.x + (away.x / len) * step, y: op.pos.y + (away.y / len) * step };
    const z = surfaceAt(terrain(ctx, state), pos);
    if (!canPlaceAt(ctx, state, op, pos, z)) continue;
    // "the same as the Reposition action, except… it cannot finish the move within control range"
    const ghost: OperativeState = { ...op, pos, z };
    if (aliveOperatives(state).some((e) => e.player !== op.player && inControlRange(ctx, state, ghost, e))) continue;
    return { pos, z };
  }
  return undefined;
}

function canPlaceAt(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2, z: number): boolean {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c))) return false;
  if (baseTouchesHazardous(index, pos, c.base, op.rot)) return false;
  const r = baseRadius(c.base);
  const { w, h } = state.map.board;
  if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS) return false;
  if (z > EPS && Math.abs(surfaceAt(index, pos, z + 0.05) - z) > 0.05) return false;
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    if (Math.abs(other.z - z) > 1) continue;
    if (basesOverlap(pos, c.base, op.rot, other.pos, card(ctx, other).base, other.rot)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- WRAITHBONE TALISMAN -----------------------------------------------
  // "Once per turning point, when a friendly VOID-DANCER TROUPE operative is shooting, fighting
  //  or retaliating, if you roll two or more fails, you can discard one of them to retain
  //  another as a normal success instead."
  //
  //  `effectiveRules` is re-emitted at the top of every `advanceShoot` and `advanceFight` pass,
  //  so gating on `step === 'retention'` gives a post-roll seam in BOTH sequences — which is why
  //  this rule is live for shooting, fighting AND retaliating even though `fight.ts` emits no
  //  `onRollAttack` (D-031), and why it is the exact printed transform rather than D-018's
  //  re-roll approximation. Free and strictly beneficial, so it is auto-used (D-022); the dice
  //  are the deterministic default the engine itself uses — discard the lowest fail, retain the
  //  highest.
  reg.on('onWeaponRules', T.bind(EQ.wraithboneTalisman, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.wraithboneTalisman)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    const seq = ev.state.sequence;
    if (!seq || seq.step !== 'retention') return;
    const pool =
      seq.kind === 'shoot'
        ? seq.attackerId === op.id
          ? seq.attack
          : undefined
        : seq.attackerId === op.id
          ? seq.attackerPool
          : seq.defenderId === op.id
            ? seq.defenderPool
            : undefined;
    if (!pool) return;
    const fails = pool.dice.filter((d) => d.state === 'fail' && d.rolled).sort((a, b) => a.value - b.value);
    if (fails.length < 2) return; // "if you roll two or more fails"
    if (!useOncePerTP(ev.state, `vdt.talisman:${T.player}`)) return;
    const discarded = fails[0]!;
    const retained = fails[fails.length - 1]!;
    discarded.state = 'discarded';
    discarded.note = 'WRAITHBONE TALISMAN';
    retained.state = 'normal';
    retained.note = 'WRAITHBONE TALISMAN';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `WRAITHBONE TALISMAN: ${op.letter} discards a ${discarded.value} to retain the ${retained.value} as a normal success`,
    });
  });

  // ---- SHRIEKER TOXIN ROUNDS ---------------------------------------------
  // "Once per turning point, when a friendly VOID-DANCER TROUPE operative is performing the
  //  Shoot action and you select a shuriken pistol or shrieker cannon (focused), you can use
  //  this rule. If you do, until the end of that action, that weapon has the Devastating 1
  //  weapon rule." Claimed at Select Weapon, which is emitted exactly once per shot from
  //  `startShoot`; the dry run the Shoot action's `check` makes must never spend it (D-032).
  reg.on('onSelectWeapon', T.bind(EQ.shriekerToxinRounds, 30), (ev) => {
    if (ev.dryRun) return; // D-032 — a `check` is a query the AI runs many times per turn
    if (!hasEquipment(ev.state, T.player, EQ.shriekerToxinRounds)) return;
    const op = ev.ctx.attacker;
    if (!T.mineKw(op, KW)) return;
    if (!isToxinWeapon(ev.ctx.weaponName, ev.ctx.profile)) return;
    if (!useOncePerTP(ev.state, `vdt.toxin:${T.player}`)) return;
    effect(ev.state, {
      rule: E_TOXIN,
      source: { kind: 'equipment', id: EQ.shriekerToxinRounds },
      sourceText: shortQuote(text(EQ.shriekerToxinRounds)),
      operativeId: op.id,
      player: T.player,
      data: { weaponName: ev.ctx.weaponName, profileName: ev.ctx.profile.name ?? '' },
      // "until the end of that action" — bounded to the activation, which is the nearest expiry
      // the engine sweeps ('endOfAction' is only swept at end of turning point).
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SHRIEKER TOXIN ROUNDS: ${op.letter}'s ${ev.ctx.weaponName} has Devastating 1`,
    });
  });
  reg.on('onWeaponRules', T.bind(EQ.shriekerToxinRounds, 31), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, E_TOXIN);
    if (!eff) return;
    if (eff.data?.['weaponName'] !== ev.weaponName) return;
    if ((eff.data?.['profileName'] ?? '') !== (ev.profile.name ?? '')) return;
    ev.rules.push(ruleTag('Devastating', 1, 'Devastating 1 (SHRIEKER TOXIN ROUNDS)'));
  });

  // ---- DEATH MASK ---------------------------------------------------------
  // "Keep a Tragedy tally. Whenever a friendly VOID-DANCER TROUPE operative that has an ACCOLADE
  //  rule is incapacitated, add 1 to your Tragedy tally. When your Tragedy tally reaches 3, you
  //  gain 1CP and stop that tally."
  reg.on('onIncapacitated', T.bind(EQ.deathMask, 30), (ev) => {
    if (ev.prevented) return;
    if (!hasEquipment(ev.state, T.player, EQ.deathMask)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !hasAccolade(ev.state, op)) return;
    const b = bucket(ev.state, 'vdt.tragedy');
    if (b[`${T.player}:stopped`] === true) return; // "…and stop that tally"
    const tally = Number(b[T.player] ?? 0) + 1;
    b[T.player] = tally;
    log(ev.state, { kind: 'action', player: T.player, text: `DEATH MASK: Tragedy tally ${tally}` });
    if (tally < 3) return;
    b[`${T.player}:stopped`] = true;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'DEATH MASK: the Tragedy tally reaches 3 — +1CP' });
  });

  // ---- UNDERSTUDY'S MASK --------------------------------------------------
  // "Once per battle, when you activate a friendly VOID-DANCER TROUPE operative, if the friendly
  //  operative that has the PIVOTAL ROLE has been incapacitated, you can use this rule. If you
  //  do, that activated operative has the PIVOTAL ROLE for the battle." Free and it can only
  //  help, so it is taken on its printed trigger (D-022).
  reg.on('onActivationStart', T.bind(EQ.understudysMask, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.understudysMask)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!allegoryOf(ev.state, T.player)) return;
    const star = pivotalRole(ev.state, T.player);
    if (star && !star.incapacitated && !star.removed) return;
    if (!useOncePerBattle(ev.state, `vdt.understudy:${T.player}`)) return;
    setPivotal(T, ev.state, op);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `UNDERSTUDY’S MASK: ${op.letter} takes the PIVOTAL ROLE`,
      data: { operativeId: op.id },
    });
  });
}

/** "…you select a shuriken pistol or shrieker cannon (focused)". */
export function isToxinWeapon(weaponName: string, profile: WeaponProfile): boolean {
  const name = weaponName.trim().toLowerCase();
  if (name === 'shuriken pistol') return true;
  return name === 'shrieker cannon' && (profile.name ?? '') === 'focused';
}

// ---------------------------------------------------------------------------
// SHADOWSEER unique actions
// ---------------------------------------------------------------------------

/** "a valid target for … this operative" — no weapon is named, so a bare profile is used. */
const BARE_PROFILE: WeaponProfile = { type: 'ranged', atk: 0, hit: 6, dmgN: 0, dmgC: 0, rules: [] };

/** "Select one ready enemy operative visible to this operative" (FOG OF DREAMS). */
function fogTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  targetId: string | undefined,
): OperativeState | undefined {
  const index = terrain(ctx, state);
  const candidates = aliveOperatives(state, otherPlayer(op.player))
    .filter((foe) => foe.ready)
    .filter((foe) => isVisible(index, body(ctx, op), body(ctx, foe)).visible)
    .sort(byId);
  if (targetId) return candidates.find((o) => o.id === targetId);
  return candidates[0];
}

/** "Select one enemy operative that's a valid target for and within 8" of this operative." */
function mirrorTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  targetId: string | undefined,
): OperativeState | undefined {
  const candidates = aliveOperatives(state, otherPlayer(op.player))
    .filter((foe) => {
      const oc = ctx.datacards.get(op.datacardId);
      const fc = ctx.datacards.get(foe.datacardId);
      if (!oc || !fc) return false;
      return baseGap(op.pos, oc.base, op.rot, foe.pos, fc.base, foe.rot) <= 8 + EPS;
    })
    .filter((foe) => checkTarget(ctx, state, op, foe, BARE_PROFILE, []).valid)
    .sort(byId);
  if (targetId) return candidates.find((o) => o.id === targetId);
  return candidates[0];
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- SHADOWSEER › FOG OF DREAMS 1AP ----------------------------------
    uniqueAction(data, C.shadowseer, ACT.fogOfDreams, {
      check: (ctx, state, op, params) => {
        // "This operative cannot perform this action while within control range of an enemy."
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return fogTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one ready enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = fogTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        const roll = ctx.rng.d6();
        recordRoll(state, data.id, [roll], op.player, 'FOG OF DREAMS D6');
        dropEffects(state, (e) => e.rule === E_FOG && e.operativeId === target.id);
        effect(state, {
          rule: E_FOG,
          source: { kind: 'ability', id: ACT.fogOfDreams },
          sourceText: shortQuote(actionText(C.shadowseer, ACT.fogOfDreams)),
          operativeId: target.id,
          player: op.player,
          data: { limit: roll, count: 0 },
          expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point"
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: FOG OF DREAMS — ${target.letter} is held for ${roll} enemy activations`,
          data: { operativeId: op.id, targetId: target.id },
        });
        return { ok: true };
      },
    }),

    // ---- SHADOWSEER › MIRROR OF MINDS 1AP --------------------------------
    // "Both players roll five D6. Pair your dice with your opponent's dice based on matching
    //  results. For each matching pair, inflict D3 damage on that enemy operative (to a maximum
    //  of 8)."
    uniqueAction(data, C.shadowseer, ACT.mirrorOfMinds, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return mirrorTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative that’s a valid target for and within 8"' };
      },
      perform: (ctx, state, op, params) => {
        const target = mirrorTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        const mine = ctx.rng.roll(5);
        const theirs = ctx.rng.roll(5);
        recordRoll(state, data.id, mine, op.player, 'MIRROR OF MINDS (yours)');
        recordRoll(state, data.id, theirs, otherPlayer(op.player), 'MIRROR OF MINDS (opponent)');
        const unpaired = [...theirs];
        let pairs = 0;
        for (const v of mine) {
          const at = unpaired.indexOf(v);
          if (at < 0) continue;
          unpaired.splice(at, 1);
          pairs++;
        }
        let damage = 0;
        for (let i = 0; i < pairs; i++) damage += ctx.rng.d3();
        damage = Math.min(8, damage);
        log(state, {
          kind: 'dice',
          player: op.player,
          text: `MIRROR OF MINDS: ${mine.join(', ')} vs ${theirs.join(', ')} — ${pairs} pairs → ${damage} damage`,
        });
        if (damage > 0) inflictDamage(ctx, state, target, damage, 'mortal');
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// DARTING SALVO — `Reposition (DARTING SALVO)` (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/** The follow-up leg is only offered after Reposition → Shoot, in that order. */
function salvoArmed(state: GameState, op: OperativeState): boolean {
  if (!catKw(op, KW)) return false;
  if (!gambitUsed(state, op.player, SP.dartingSalvo)) return false;
  const repositioned = op.actionsThisActivation.indexOf('Reposition');
  const shot = op.actionsThisActivation.indexOf('Shoot');
  return repositioned >= 0 && shot > repositioned;
}

registerAction({
  id: REPOSITION_SALVO,
  name: REPOSITION_SALVO,
  ap: 0, // it is the rest of the Reposition the operative already paid for
  type: 'unique',
  sourceText: text(SP.dartingSalvo),
  available: (_ctx, state, op) => salvoArmed(state, op),
  check(ctx, state, op, params) {
    if (!salvoArmed(state, op))
      return { ok: false, reason: 'only after a Reposition action interrupted by the Shoot action' };
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, { action: 'Reposition', mustNotFinishEngaged: true });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  // The universal Reposition re-validates through `moveBudget`, which emits `onMoveDistance` —
  // where the "any remaining move distance" cap lives — so the same code path the check saw
  // applies the cap.
  perform: (ctx, state, op, params) => getAction('Reposition')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// RISING CRESCENDO — `Dash (RISING CRESCENDO)` (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

registerAction({
  id: DASH_CRESCENDO,
  name: DASH_CRESCENDO,
  ap: 1,
  type: 'unique',
  treatedAs: 'Dash',
  sourceText: text(SP.risingCrescendo),
  available: (_ctx, state, op) => catKw(op, KW) && gambitUsed(state, op.player, SP.risingCrescendo),
  check(ctx, state, op, params) {
    if (!gambitUsed(state, op.player, SP.risingCrescendo))
      return { ok: false, reason: 'the RISING CRESCENDO strategy ploy has not been used' };
    if (!op.actionsThisActivation.includes('Charge'))
      return { ok: false, reason: 'only during an activation in which it performed the Charge action' };
    // The printed Dash restrictions still apply ("the same as the Reposition action, except…").
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Dash',
      noClimb: true,
      mustNotFinishEngaged: true,
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform: (ctx, state, op, params) => getAction('Dash')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------

/** Public for the tests: the Tragedy tally DEATH MASK keeps. */
export const tragedyTally = (state: GameState, player: PlayerId): number =>
  Number(bucket(state, 'vdt.tragedy')[player] ?? 0);

/** Public for the tests/UI: does this operative carry a Humbling Cruelty token from `player`? */
export const hasHumblingToken = (state: GameState, operativeId: string, player: PlayerId): boolean =>
  hasToken(state, operativeId, HUMBLING_TOKEN, player);

export const voidDancerTroupe = defineTeam({
  id: 'void-dancer-troupe',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "…when a friendly VOID-DANCER TROUPE operative is fighting during an activation in which
    //  it performed the Charge action, after you strike."
    [FP.murderousEntrance]: (state, player) => {
      const seq = state.sequence?.kind === 'fight' ? state.sequence : undefined;
      if (!seq || seq.attacker !== player) return { ok: false, reason: 'no friendly operative is fighting' };
      const me = state.operatives[seq.attackerId];
      if (!me || !catKw(me, KW)) return { ok: false, reason: 'no friendly operative is fighting' };
      if (!me.actionsThisActivation.includes('Charge'))
        return { ok: false, reason: 'it did not perform the Charge action during this activation' };
      if (!seq.attackerPool.dice.some((d) => d.state === 'struck'))
        return { ok: false, reason: 'it has not struck yet' };
      if (!seq.attackerPool.dice.some((d) => d.state === 'normal' || d.state === 'crit'))
        return { ok: false, reason: 'it has no unresolved successes left' };
      return { ok: true };
    },
    // "…when a friendly VOID-DANCER TROUPE operative is fighting, after you strike with a
    //  critical success, if the enemy operative isn't incapacitated."
    [FP.theCurtainFalls]: (state, player) => {
      const seq = state.sequence?.kind === 'fight' ? state.sequence : undefined;
      if (!seq || seq.attacker !== player) return { ok: false, reason: 'no friendly operative is fighting' };
      const me = state.operatives[seq.attackerId];
      const foe = state.operatives[seq.defenderId];
      if (!me || !catKw(me, KW)) return { ok: false, reason: 'no friendly operative is fighting' };
      if (!foe || foe.incapacitated || foe.removed)
        return { ok: false, reason: 'the enemy operative is incapacitated' };
      // Crit-ness is recomputed from the dice value: `classify` only ever looks at the value,
      // 6s and Lethal x+, so a dice already marked 'struck' can still be read back. The printed
      // weapon profile is used here because `usable` is given no GameContext.
      const profile = catalogueCard(me.datacardId)?.weapons.find((w) => w.name === seq.attackerWeapon)?.profiles[0];
      const lethal = profile?.rules.find((r) => r.id === 'Lethal')?.x;
      if (!seq.attackerPool.dice.some((d) => d.state === 'struck' && dieWasCrit(d, lethal)))
        return { ok: false, reason: 'it has not struck with a critical success' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly VOID-DANCER TROUPE operative's activation."
    [FP.elusiveTarget]: (state, player) => {
      const op = activeFriendly(state, player);
      return op && catKw(op, KW)
        ? { ok: true }
        : { ok: false, reason: 'no friendly VOID-DANCER TROUPE operative is activated' };
    },
    // "…when an operative is shooting a friendly VOID-DANCER TROUPE operative, during the
    //  Resolve Defence Dice step."
    [FP.dominoField]: (state, player) => {
      const seq = state.sequence?.kind === 'shoot' ? state.sequence : undefined;
      if (!seq || seq.defender !== player || seq.step !== 'allocate')
        return { ok: false, reason: 'no friendly operative is in the Resolve Defence Dice step' };
      return dominoMatch(seq)
        ? { ok: true }
        : { ok: false, reason: 'no rolled defence dice matches an unresolved attack dice' };
    },
  },
  aiHints: {
    roles: {
      [C.leadPlayer]: 'leader',
      [C.deathJester]: 'sniper',
      [C.player]: 'melee',
      [C.shadowseer]: 'support',
    },
    ployValue: {
      [SP.dartingSalvo]: 0.4,
      [SP.risingCrescendo]: 0.5,
      [SP.prismaticBlur]: 0.5,
      [SP.cegorachsJest]: 0.6,
      [FP.murderousEntrance]: 0.7,
      [FP.theCurtainFalls]: 0.5,
      [FP.elusiveTarget]: 0.5,
      [FP.dominoField]: 0.6,
    },
    equipmentValue: {
      [EQ.wraithboneTalisman]: 0.6,
      [EQ.shriekerToxinRounds]: 0.4,
      [EQ.deathMask]: 0.3,
      [EQ.understudysMask]: 0.4,
    },
  },
});

export default voidDancerTroupe;
