/**
 * CELESTIAN INSIDIANTS — Adepta Sororitas.
 * https://wahapedia.ru/kill-team3/kill-teams/celestian-insidiants/
 *
 * Rule text is read from `data/teams/celestian-insidiants.json`; every hook carries a short
 * verbatim quote of the printed rule in its RuleBinding.
 *
 * The team is built around two states an operative can be in — INSPIRING (Inspiration) and
 * holding a BENEDICTION (Martyrdom) — so both are modelled as effects on the operative and
 * read through `isInspiring` / `hasBenediction` rather than being recomputed per rule.
 */
import { HookRegistry } from '../../core/hooks.ts';
import { terrain } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { UTILITY_ID } from '../../core/equipment/grenades.ts';
import { body, inflictDamage, isInjured, log, recordRoll } from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import { successes } from '../../core/dice.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type { GameContext } from '../../core/context.ts';
import type { GameState, OperativeState, PendingDecision, PlayerId, WeaponProfile } from '../../core/types.ts';
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
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('celestian-insidiants');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const KW = 'CELESTIAN INSIDIANT';

// ---------------------------------------------------------------------------
// INSPIRING (Inspiration faction rule)
// ---------------------------------------------------------------------------

export const INSPIRING = 'celestian.inspiring';
/** One of your Suspicion tokens (SUSPECT & ELIMINATE). */
export const SUSPICION = 'celestian.suspicion';
/** The Mortisanctus' ultimatum, once it has been accepted or declined. */
const ULTIMATUM = 'celestian.ultimatum';
/** Wrath BENEDICTION: "weapons on that operative's datacard have the Ceaseless weapon rule". */
const WRATH = 'celestian.wrath';

/**
 * Inspiration: "Performs the Charge action, before it moves, it becomes INSPIRING." The
 * operative is INSPIRING for the whole of the Charge, so an operative that has charged this
 * activation counts even before `onActivationEnd` writes the lasting effect; `action` lets a
 * rule that fires BEFORE the Charge (UNSHAKEABLE PURSUIT) see it too.
 */
export function isInspiring(
  state: GameState,
  op: OperativeState,
  opts: { action?: string } = {},
): boolean {
  if (state.effects.some((e) => e.rule === INSPIRING && e.operativeId === op.id)) return true;
  if (op.actionsThisActivation.includes('Charge')) return true;
  return opts.action === 'Charge';
}

export function makeInspiring(state: GameState, op: OperativeState, sourceId: string, why: string): void {
  if (state.effects.some((e) => e.rule === INSPIRING && e.operativeId === op.id)) return;
  effect(state, {
    rule: INSPIRING,
    source: { kind: 'ability', id: sourceId },
    sourceText: shortQuote(text('celestian-insidiants.rule.inspiration')),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfBattle' },
  });
  log(state, { kind: 'action', player: op.player, text: `${op.letter} becomes INSPIRING (${why})` });
}

// ---------------------------------------------------------------------------
// BENEDICTIONS (Martyrdom faction rule)
// ---------------------------------------------------------------------------

export const BENEDICTIONS = ['ardour', 'wrath', 'restoration', 'exigence'] as const;
export type Benediction = (typeof BENEDICTIONS)[number];

/** Quoted verbatim from the BENEDICTIONS faction rule. */
export const BENEDICTION_TEXT: Record<Benediction, string> = {
  ardour:
    'Ardour: Until the end of the battle, add 1 to that operative’s APL stat. You cannot select this BENEDICTION for a SUPERIOR operative.',
  wrath: 'Wrath: Until the end of the battle, weapons on that operative’s datacard have the Ceaseless weapon rule',
  restoration: 'Restoration: That operative regains up to D3+2 lost wounds.',
  exigence:
    'Exigence: That operative can immediately perform a free Charge or Dash action (for the former, it cannot move more than 3"), but must end that move closer to that incapacitated INSPIRING operative.',
};

export const MARTYRDOM_DECISION = 'celestian.martyrdom';

export function hasBenediction(state: GameState, op: OperativeState, b: Benediction): boolean {
  if (b === 'wrath') return state.effects.some((e) => e.rule === WRATH && e.operativeId === op.id);
  return state.effects.some((e) => e.rule === `celestian.benediction.${b}` && e.operativeId === op.id);
}

function applyBenediction(
  ctx: GameContext | undefined,
  state: GameState,
  op: OperativeState,
  benediction: Benediction,
  martyr: OperativeState | undefined,
): void {
  const record = (rule: string): void => {
    effect(state, {
      rule,
      source: { kind: 'ability', id: 'celestian-insidiants.rule.benedictions' },
      sourceText: BENEDICTION_TEXT[benediction],
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfBattle' },
    });
  };
  switch (benediction) {
    case 'ardour':
      op.aplMods.push(1); // "Until the end of the battle, add 1 to that operative's APL stat."
      record('celestian.benediction.ardour');
      break;
    case 'wrath':
      record(WRATH);
      break;
    case 'restoration': {
      const heal = (ctx?.rng.d3() ?? 1) + 2; // "regains up to D3+2 lost wounds"
      recordRoll(state, 'restoration', [heal], op.player, 'Restoration D3+2');
      const max = ctx?.datacards.get(op.datacardId)?.wounds ?? op.wounds + heal;
      op.wounds = Math.min(max, op.wounds + heal);
      break;
    }
    case 'exigence':
      grantFreeAction(state, op, {
        sourceId: 'celestian-insidiants.rule.benedictions',
        sourceText: BENEDICTION_TEXT.exigence,
        threshold: ctx ? Math.max(0, op.apSpent) : 0,
        kind: 'ability',
        only: ['Charge', 'Dash'],
      });
      break;
  }
  log(state, {
    kind: 'action',
    player: op.player,
    text: `Martyrdom${martyr ? ` (${martyr.letter})` : ''}: ${op.letter} gains the ${benediction} BENEDICTION`,
  });
}

// ---------------------------------------------------------------------------
// PSYCHIC (Weapons of the Witch Hunters)
// ---------------------------------------------------------------------------

/** A PSYCHIC unique action is printed with "PSYCHIC." as its first word. */
export const isPsychicAction = (t: string): boolean => /^PSYCHIC\b/i.test(t.trim());

const hasPsychicProfile = (profile: WeaponProfile): boolean => profile.rules.some((r) => r.id === 'PSYCHIC');

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

/** The weapon profile currently inflicting damage, for the rules that cap or bump it. */
function currentProfile(T: TeamHooks, state: GameState): { op: OperativeState; profile: WeaponProfile } | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holderId = seq.kind === 'shoot' ? seq.attackerId : lastStriker(state) ?? seq.attackerId;
  const holder = state.operatives[holderId];
  if (!holder) return undefined;
  const name = seq.kind === 'shoot' ? seq.weaponName : holderId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profileName = seq.kind === 'shoot' ? seq.profileName : holderId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  return profile ? { op: holder, profile } : undefined;
}

/** In a fight, whoever is resolving a die is the one inflicting damage. */
function lastStriker(state: GameState): string | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  return seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
}

function visible(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Inspiration -------------------------------------------------------
  // "Incapacitates an enemy operative that has a Wounds stat of 6 or more, that friendly
  //  operative becomes INSPIRING."
  reg.on('onIncapacitated', T.bind('celestian-insidiants.rule.inspiration', 11), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player) return;
    if ((T.card(victim)?.wounds ?? 0) < 6) return;
    const killer = incapacitator(ev.state, victim);
    if (!killer || !T.mineKw(killer, KW)) return;
    makeInspiring(ev.state, killer, 'celestian-insidiants.rule.inspiration', `incapacitated ${victim.letter}`);
  });
  // "Performs the Charge action, before it moves, it becomes INSPIRING." — `isInspiring`
  // already reads the in-flight Charge; this writes the lasting effect.
  reg.on('onActivationEnd', T.bind('celestian-insidiants.rule.inspiration', 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    makeInspiring(ev.state, ev.operative, 'celestian-insidiants.rule.inspiration', 'Charge');
  });
  // "Whenever a friendly CELESTIAN INSIDIANT operative is INSPIRING, weapons on its datacard
  //  have the Severe weapon rule."
  reg.on('onWeaponRules', T.bind('celestian-insidiants.rule.inspiration', 13), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !onDatacard(T, ev.operative, ev.weaponName)) return;
    if (!isInspiring(ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Inspiration)'));
  });

  // ---- Martyrdom ---------------------------------------------------------
  reg.on('onIncapacitated', T.bind('celestian-insidiants.rule.martyrdom', 14), (ev) => {
    const victim = ev.operative;
    if (!T.mineKw(victim, KW) || !isInspiring(ev.state, victim)) return;
    if (ev.prevented) return;
    offerMartyrdom(T, ev.state, victim);
  });

  // ---- Weapons of the Witch Hunters --------------------------------------
  // "PSYCHIC ranged weapons cannot inflict damage on friendly CELESTIAN INSIDIANT operatives."
  reg.on('onDamage', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 11), (ev) => {
    if (!T.mineKw(ev.target, KW)) return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'ranged' || !hasPsychicProfile(cur.profile)) return;
    ev.amount = 0;
  });
  // "Whenever an operative is within 3" of a friendly CELESTIAN INSIDIANT operative: that
  //  operative cannot perform PSYCHIC actions or use PSYCHIC additional rules."
  reg.on('canPerformAction', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 12), (ev) => {
    if (!nullifiedByCreed(T, ev.state, ev.operative)) return;
    const printed = T.card(ev.operative)?.uniqueActions.find((a) => a.id === ev.action);
    if (!printed || !isPsychicAction(printed.text)) return;
    ev.allowed = false;
    ev.reason = 'within 3" of a CELESTIAN INSIDIANT operative: it cannot perform PSYCHIC actions';
  });
  // "That operative cannot use PSYCHIC ranged weapons."
  reg.on('availableWeapons', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 13), (ev) => {
    if (!nullifiedByCreed(T, ev.state, ev.operative)) return;
    const psychic = (T.card(ev.operative)?.weapons ?? []).filter((w) =>
      w.profiles.some((p) => p.type === 'ranged' && hasPsychicProfile(p)),
    );
    if (psychic.length === 0) return;
    ev.weapons = ev.weapons.filter((n) => !psychic.some((w) => w.name === n));
  });
  // "PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4."
  reg.on('onWeaponRules', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 14), (ev) => {
    if (ev.type !== 'melee' || !hasPsychicProfile(ev.profile)) return;
    if (!nullifiedByCreed(T, ev.state, ev.operative)) return;
    ev.rules = [];
  });
  reg.on('onDamage', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 15), (ev) => {
    if (ev.kind !== 'attack') return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'melee' || !hasPsychicProfile(cur.profile)) return;
    if (!nullifiedByCreed(T, ev.state, cur.op)) return;
    const cap = ev.amount >= cur.profile.dmgC ? 4 : 3; // "cannot have Dmg stats higher than 3/4"
    ev.amount = Math.min(ev.amount, cap);
  });
  // Anti-PSYKER (rare weapon rule): "Whenever this weapon is being used against an operative
  // that has the PSYKER keyword, it has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind('celestian-insidiants.rule.weapons-of-the-witch-hunters', 16), (ev) => {
    if (!ev.rules.some((r) => r.id === 'AntiPSYKER')) return;
    if (!ev.target || !T.kw(ev.target, 'PSYKER')) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Anti-PSYKER)'));
  });

  // ---- SUPERIOR › Holy Example -------------------------------------------
  // "Once per turning point, if this operative is INSPIRING, you can use a firefight ploy for
  //  0CP if this is the specified CELESTIAN INSIDIANT operative."
  reg.on('onPloyUsed', T.bind('celestian-insidiants.insidiant-superior.holy-example', 12), (ev) => {
    if (ev.player !== T.player || ev.kind !== 'firefight') return;
    const superior = T.friendlies(ev.state).find((o) => o.datacardId === 'celestian-insidiants.insidiant-superior');
    if (!superior || !isInspiring(ev.state, superior)) return;
    const named = (ev.data?.['operativeId'] as string | undefined) ?? ev.state.activeOperativeId;
    if (named !== superior.id) return;
    if (!useOncePerTP(ev.state, `celestian.holyExample:${T.player}`)) return;
    const ploy = DATA.firefightPloys.find((p) => p.id === ev.ployId);
    ev.state.teams[T.player].cp += ploy?.cp ?? 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Holy Example: ${ploy?.name ?? ev.ployId} costs 0CP` });
  });

  // ---- ABJUROR › Shield (rare weapon rule) -------------------------------
  reg.on('onBlockAllocation', T.bind('celestian-insidiants.insidiant-abjuror.shield', 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Shield')) return;
    ev.blocks = 2; // "each of your blocks can be allocated to block two unresolved successes"
  });

  // ---- ABJUROR › Holy Defender -------------------------------------------
  // "Once per turning point, when a friendly … operative visible to and within 2" of this
  //  operative is selected as the valid target of a Shoot action … this operative becomes the
  //  valid target … instead. This rule has no effect if … the ranged weapon has the Blast or
  //  Torrent weapon rule."
  reg.on('onSelectTarget', T.bind('celestian-insidiants.insidiant-abjuror.holy-defender', 12), (ev) => {
    if (ev.target.player !== T.player || !T.kw(ev.target, KW)) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `celestian.holyDefender:${T.player}`)) return;
    const abjuror = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === 'celestian-insidiants.insidiant-abjuror' &&
        o.id !== ev.target.id &&
        T.gap(o, ev.target) <= 2 + 1e-6 &&
        visible(T, ev.state, o, ev.target),
    );
    if (!abjuror) return;
    // "You can use this rule": taken when the ABJUROR is the sturdier body right now.
    if (abjuror.wounds <= ev.target.wounds) return;
    useOncePerTP(ev.state, `celestian.holyDefender:${T.player}`);
    ev.redirectTo = abjuror.id;
    log(ev.state, { kind: 'action', player: T.player, text: `Holy Defender: ${abjuror.letter} shields ${ev.target.letter}` });
  });

  // ---- CENSOR › Virge of Admonition Icon Bearer --------------------------
  reg.on('onMarkerControl', T.bind('celestian-insidiants.insidiant-censor.virge-of-admonition-icon-bearer', 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const censor = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-censor' && T.markerGap(o, marker) <= 1 + 1e-6,
    );
    if (censor) ev.aplByPlayer[T.player] += 1; // "treat this operative's APL stat as 1 higher"
  });

  // ---- CENSOR › Null Field -----------------------------------------------
  reg.on('onStatMod', T.bind('celestian-insidiants.insidiant-censor.null-field', 12), (ev) => {
    if (ev.operative.player === T.player) return; // "whenever an ENEMY operative is within null range"
    const censor = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-censor' && T.gap(o, ev.operative) <= nullRange(ev.state, o) + 1e-6,
    );
    if (!censor) return;
    // "(this isn't cumulative with being injured)"
    if (T.ctx && isInjured(T.ctx, ev.operative)) return;
    ev.mods.move -= 2;
    ev.mods.hit -= 1;
  });

  // ---- CREMATOR › Inspirational Pyre -------------------------------------
  reg.on('onStrikeResolved', T.bind('celestian-insidiants.insidiant-cremator.inspirational-pyre', 12), (ev) => {
    const cremator = ev.ctx.attacker;
    if (cremator.datacardId !== 'celestian-insidiants.insidiant-cremator' || cremator.player !== T.player) return;
    if (!/hand flamer/i.test(ev.ctx.weaponName)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.damage <= 0) return; // "inflicts damage … but doesn't incapacitate it"
    if (ev.struck.incapacitated || ev.struck.removed) return;
    if (!useOncePerTP(ev.state, `celestian.pyre:${cremator.id}`)) return;
    const friend = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== cremator.id && T.gap(cremator, o) <= 6 + 1e-6 && !isInspiring(ev.state, o))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (friend) makeInspiring(ev.state, friend, 'celestian-insidiants.insidiant-cremator.inspirational-pyre', 'Inspirational Pyre');
  });

  // ---- DENUNCIA › Accusing Exorcist --------------------------------------
  reg.on('onPloyUsed', T.bind('celestian-insidiants.insidiant-denuncia.accusing-exorcist', 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'celestian-insidiants.sp.suspect-eliminate') return;
    const denuncia = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-denuncia' && isInspiring(ev.state, o),
    );
    if (!denuncia) return;
    const chosen = ev.data?.['operativeId'] as string | undefined;
    const enemy = chosen ? ev.state.operatives[chosen] : suspicionTarget(T, ev.state);
    if (!enemy) return;
    if (T.gap(denuncia, enemy) > 6 + 1e-6 && !visible(T, ev.state, denuncia, enemy)) return;
    ev.state.teams[T.player].cp += 1; // "the Suspect & Eliminate strategy ploy costs you 0CP"
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Accusing Exorcist: Suspect & Eliminate costs 0CP' });
  });

  // ---- MORTISANCTUS › Zealous Ultimatum ----------------------------------
  reg.on('gambitOptions', T.bind('celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum', 15), (ev) => {
    if (ev.player !== T.player) return;
    if (usedThisBattleKey(ev.state, `celestian.ultimatum:${T.player}`)) return;
    const mortisanctus = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-mortisanctus',
    );
    if (!mortisanctus) return;
    if (!T.enemies(ev.state).some((e) => T.gap(mortisanctus, e) <= 8 + 1e-6)) return;
    ev.options.push({
      id: ULTIMATUM_GAMBIT,
      label: 'Zealous Ultimatum',
      sourceText: shortQuote(abilityText('celestian-insidiants.insidiant-mortisanctus', 'celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum')),
    });
  });
  reg.on('onPloyUsed', T.bind('celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum', 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== ULTIMATUM_GAMBIT) return;
    const mortisanctus = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-mortisanctus',
    );
    if (!mortisanctus) return;
    const candidates = T.enemies(ev.state).filter((e) => T.gap(mortisanctus, e) <= 8 + 1e-6);
    const chosen = (ev.data?.['operativeId'] as string | undefined) ?? undefined;
    const enemy = candidates.find((e) => e.id === chosen) ?? [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!enemy) return;
    useOncePerBattle(ev.state, `celestian.ultimatum:${T.player}`);
    // "Your opponent must accept or decline that ultimatum" — their choice, so it is a decision.
    ev.state.pending.push({
      id: `ultimatum-${ev.state.seq++}`,
      who: enemy.player,
      kind: ULTIMATUM_DECISION,
      prompt: `${mortisanctus.letter} issues an ultimatum to ${enemy.letter} — accept or decline?`,
      sourceText: shortQuote(abilityText('celestian-insidiants.insidiant-mortisanctus', 'celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum')),
      options: [
        { id: 'accept', label: 'Accept the ultimatum', data: { targetId: enemy.id, player: T.player } },
        { id: 'decline', label: 'Decline the ultimatum', data: { targetId: enemy.id, player: T.player } },
      ],
    });
  });
  reg.on('onCollectAttackDice', T.bind('celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum', 17), (ev) => {
    const ult = ev.state.effects.find((e) => e.rule === ULTIMATUM && e.player === T.player);
    if (!ult) return;
    const accepted = Boolean(ult.data?.['accepted']);
    const targetId = String(ult.data?.['targetId'] ?? '');
    if (accepted) {
      // "add 1 to the Atk stat of this operative's blessed broadsword … to a maximum of 5"
      if (ev.ctx.attacker.datacardId !== 'celestian-insidiants.insidiant-mortisanctus') return;
      if (ev.ctx.attacker.player !== T.player || ev.ctx.defender?.id !== targetId) return;
      if (!/blessed broadsword/i.test(ev.ctx.weaponName)) return;
      const bonus = 1 + (ult.data?.['slain'] ? 1 : 0);
      ev.count = Math.min(5, ev.count + bonus);
    } else {
      // "subtract 1 from the Atk stat of that enemy operative's weapons"
      if (ev.ctx.attacker.id !== targetId) return;
      if (!ev.ctx.defender || !T.mineKw(ev.ctx.defender, KW)) return;
      if (ev.ctx.type !== 'melee') return;
      ev.count = Math.max(0, ev.count - 1);
    }
  });
  reg.on('onIncapacitated', T.bind('celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum', 18), (ev) => {
    const ult = ev.state.effects.find((e) => e.rule === ULTIMATUM && e.player === T.player);
    if (!ult || !ult.data?.['accepted'] || ult.data['targetId'] !== ev.operative.id) return;
    const killer = incapacitator(ev.state, ev.operative);
    if (!killer || killer.datacardId !== 'celestian-insidiants.insidiant-mortisanctus') return;
    if (!fightSeq(ev.state)) return; // "while fighting or retaliating"
    ult.data = { ...ult.data, slain: true };
  });

  // ---- MORTISANCTUS › Bladed Stance --------------------------------------
  // "Whenever this operative is fighting or retaliating, you can resolve one of your successes
  //  before the normal order."
  reg.on('onCollectAttackDice', T.bind('celestian-insidiants.insidiant-mortisanctus.bladed-stance', 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    if (ev.ctx.attacker.datacardId !== 'celestian-insidiants.insidiant-mortisanctus') return;
    if (ev.ctx.attacker.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== ev.ctx.attacker.id) return;
    seq.turn = 'defender'; // the retaliating MORTISANCTUS resolves first
  });

  // ---- RELIQUARIUS › Simulacrum Nullificatus Icon Bearer -----------------
  reg.on('onMarkerControl', T.bind('celestian-insidiants.insidiant-reliquarius.simulacrum-nullificatus-icon-bearer', 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const reliquarius = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'celestian-insidiants.insidiant-reliquarius',
    );
    if (!reliquarius) return;
    const foe = T.player === 'p1' ? 'p2' : 'p1';
    const contesting = T.enemies(ev.state).filter((e) => T.markerGap(e, marker) <= 1 + 1e-6);
    if (!contesting.some((e) => T.gap(reliquarius, e) <= 3 + 1e-6)) return;
    ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // ---- RELIQUARIUS › Devotion --------------------------------------------
  reg.on('onActivationEnd', T.bind('celestian-insidiants.insidiant-reliquarius.devotion', 13), (ev) => {
    const op = ev.operative;
    if (op.datacardId !== 'celestian-insidiants.insidiant-reliquarius' || op.player !== T.player) return;
    if (!isInspiring(ev.state, op)) return;
    const controls = Object.values(ev.state.markers).some(
      (m) => (m.kind === 'objective' || m.owner === T.player) && T.markerGap(op, m) <= 1 + 1e-6,
    );
    if (!controls) return;
    const friend = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== op.id && T.gap(op, o) <= 6 + 1e-6 && !isInspiring(ev.state, o) && visible(T, ev.state, op, o))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (friend) makeInspiring(ev.state, friend, 'celestian-insidiants.insidiant-reliquarius.devotion', 'Devotion');
  });

  // ---- WARRIOR › Inspired Strikes ----------------------------------------
  // "Whenever this operative is INSPIRING, add 1 to the Critical Dmg stat of weapons on its
  //  datacard." Dmg stats are shared datacard data, so the bump lands where damage is
  //  inflicted (docs/DECISIONS.md D-019).
  reg.on('onDamage', T.bind('celestian-insidiants.insidiant-warrior.inspired-strikes', 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.op.datacardId !== 'celestian-insidiants.insidiant-warrior' || cur.op.player !== T.player) return;
    if (!isInspiring(ev.state, cur.op)) return;
    if (ev.amount < cur.profile.dmgC) return; // only the Critical Dmg stat
    ev.amount += 1;
  });

  // ---- Wrath BENEDICTION --------------------------------------------------
  reg.on('onWeaponRules', T.bindText('celestian-insidiants.benediction.wrath', BENEDICTION_TEXT.wrath), (ev) => {
    if (!T.mine(ev.operative) || !onDatacard(T, ev.operative, ev.weaponName)) return;
    if (!hasBenediction(ev.state, ev.operative, 'wrath')) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Wrath)'));
  });
}

const ULTIMATUM_GAMBIT = 'celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum';
const ULTIMATUM_DECISION = 'celestian.ultimatum';

function usedThisBattleKey(state: GameState, key: string): boolean {
  return Boolean((state.opState['teamOnceBattle'] as Record<string, unknown> | undefined)?.[key]);
}

/** Is this weapon printed on the operative's own datacard (as opposed to granted)? */
function onDatacard(T: TeamHooks, op: OperativeState, weaponName: string): boolean {
  return (T.card(op)?.weapons ?? []).some((w) => w.name === weaponName);
}

/** "Whenever an operative is within 3" of a friendly CELESTIAN INSIDIANT operative". */
function nullifiedByCreed(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (T.mineKw(op, KW)) return false;
  return T.friendlies(state, KW).some((o) => T.gap(o, op) <= 3 + 1e-6);
}

/** The CENSOR's null range: 1" at the start of the battle, +1" per NULLIFYING RITUAL, max 5". */
export function nullRange(state: GameState, censor: OperativeState): number {
  const eff = effectOn(state, censor.id, 'celestian.nullRange');
  return Math.min(5, 1 + Number(eff?.data?.['steps'] ?? 0));
}

/** Whoever inflicted the wound that incapacitated `victim`, as far as the sequence knows. */
function incapacitator(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (seq?.kind === 'shoot') return state.operatives[seq.attackerId];
  if (seq?.kind === 'fight') {
    const other = seq.attackerId === victim.id ? seq.defenderId : seq.attackerId;
    return state.operatives[other];
  }
  return state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
}

// ---------------------------------------------------------------------------
// Martyrdom: the BENEDICTION decision
// ---------------------------------------------------------------------------

function offerMartyrdom(T: TeamHooks, state: GameState, martyr: OperativeState): void {
  // "select one other friendly CELESTIAN INSIDIANT operative that operative is visible to or
  //  within 6" of … (incapacitated operatives cannot be selected for a BENEDICTION)."
  const near = T.friendlies(state, KW).filter(
    (o) => o.id !== martyr.id && !o.incapacitated && (T.gap(martyr, o) <= 6 + 1e-6 || visible(T, state, martyr, o)),
  );
  // VOCIFERA MORTIS: "the other friendly … operative you select can be one that isn't visible
  // to or within 6" of that operative."
  const vocifera =
    hasEquipment(state, T.player, 'celestian-insidiants.eq.vocifera-mortis') &&
    !usedThisBattleKey(state, `celestian.vocifera:${T.player}`);
  const candidates = vocifera ? T.friendlies(state, KW).filter((o) => o.id !== martyr.id && !o.incapacitated) : near;
  if (candidates.length === 0) return;

  const options: PendingDecision['options'] = [];
  for (const op of [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const b of BENEDICTIONS) {
      // "You cannot select this BENEDICTION for a SUPERIOR operative."
      if (b === 'ardour' && T.kw(op, 'SUPERIOR')) continue;
      options.push({
        id: `${op.id}|${b}`,
        label: `${op.letter}: ${b}${near.some((n) => n.id === op.id) ? '' : ' (Vocifera Mortis)'}`,
        data: { operativeId: op.id, benediction: b, martyrId: martyr.id, far: !near.some((n) => n.id === op.id) },
      });
    }
  }
  if (options.length === 0) return;
  state.pending.push({
    id: `martyrdom-${state.seq++}`,
    who: T.player,
    kind: MARTYRDOM_DECISION,
    prompt: `${martyr.letter} is martyred — select an operative and a BENEDICTION`,
    sourceText: shortQuote(text('celestian-insidiants.rule.martyrdom')),
    options,
  });
}

/** The team's own decision kinds, claimed through `GameContext.decisionHandlers`. */
function decisionHandler(ctx: GameContext, state: GameState, decision: PendingDecision, optionId: string, data?: Record<string, unknown>): boolean {
  if (decision.kind === MARTYRDOM_DECISION) {
    const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
    const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
    const op = state.operatives[String(payload['operativeId'] ?? '')];
    const benediction = String(payload['benediction'] ?? 'restoration') as Benediction;
    if (op && !op.removed) {
      if (payload['far']) useOncePerBattle(state, `celestian.vocifera:${op.player}`);
      applyBenediction(ctx, state, op, benediction, state.operatives[String(payload['martyrId'] ?? '')]);
    }
    return true;
  }
  if (decision.kind === ULTIMATUM_DECISION) {
    const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
    const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
    const accepted = (option?.id ?? optionId) === 'accept';
    const player = String(payload['player'] ?? 'p1') as PlayerId;
    effect(state, {
      rule: ULTIMATUM,
      source: { kind: 'ability', id: ULTIMATUM_GAMBIT },
      sourceText: shortQuote(abilityText('celestian-insidiants.insidiant-mortisanctus', ULTIMATUM_GAMBIT)),
      player,
      data: { targetId: String(payload['targetId'] ?? ''), accepted },
      expiry: { kind: 'endOfBattle' },
    });
    log(state, {
      kind: 'decision',
      player: decision.who,
      text: `Zealous Ultimatum ${accepted ? 'accepted' : 'declined'}`,
    });
    return true;
  }
  if (decision.kind === FLAGELLATOR_DECISION) {
    if (optionId !== 'use') return true;
    const opId = String(decision.ctx?.['operativeId'] ?? '');
    const op = state.operatives[opId];
    if (!op || op.removed) return true;
    const roll = ctx.rng.d6();
    recordRoll(state, 'autoFlagellator', [roll], op.player, 'AUTO-FLAGELLATOR D6');
    inflictDamage(ctx, state, op, Math.ceil(roll / 2), 'other');
    if (roll >= 4 && !op.incapacitated) {
      useOncePerTP(state, `celestian.flagellator:${op.player}`);
      makeInspiring(state, op, 'celestian-insidiants.eq.auto-flagellator', 'Auto-flagellator');
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function suspicionTarget(T: TeamHooks, state: GameState): OperativeState | undefined {
  const mine = T.friendlies(state, KW);
  return [...T.enemies(state)]
    .map((e) => ({ e, d: Math.min(...mine.map((f) => T.gap(f, e)), Infinity) }))
    .sort((a, b) => a.d - b.d || (a.e.id < b.e.id ? -1 : 1))[0]?.e;
}

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // SUSPECT & ELIMINATE (strategy)
  reg.on('onPloyUsed', T.bind('celestian-insidiants.sp.suspect-eliminate', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'celestian-insidiants.sp.suspect-eliminate') return;
    const markerId = ev.data?.['markerId'] as string | undefined;
    const marked: OperativeState[] = [];
    if (markerId && ev.state.markers[markerId]) {
      const marker = ev.state.markers[markerId]!;
      marked.push(...T.enemies(ev.state).filter((e) => T.markerGap(e, marker) <= 1 + 1e-6));
    } else {
      const chosen = ev.data?.['operativeId'] as string | undefined;
      const first = (chosen ? ev.state.operatives[chosen] : undefined) ?? suspicionTarget(T, ev.state);
      if (!first) return;
      marked.push(first);
      // "each other enemy operative visible to and within 2" of it"
      marked.push(
        ...T.enemies(ev.state).filter(
          (e) => e.id !== first.id && T.gap(first, e) <= 2 + 1e-6 && visible(T, ev.state, first, e),
        ),
      );
    }
    for (const enemy of marked) {
      if (ev.state.effects.some((e) => e.rule === SUSPICION && e.operativeId === enemy.id && e.player === T.player)) continue;
      effect(ev.state, {
        rule: SUSPICION,
        source: { kind: 'ploy', id: 'celestian-insidiants.sp.suspect-eliminate' },
        sourceText: shortQuote(text('celestian-insidiants.sp.suspect-eliminate')),
        operativeId: enemy.id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
      log(ev.state, { kind: 'ploy', player: T.player, text: `${enemy.letter} gains a Suspicion token` });
    }
  });
  reg.on('onWeaponRules', T.bind('celestian-insidiants.sp.suspect-eliminate', 21), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!ev.state.effects.some((e) => e.rule === SUSPICION && e.operativeId === ev.target!.id && e.player === T.player))
      return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Suspect & Eliminate)'));
  });

  // SUFFERING & SACRIFICE (strategy)
  reg.on('onWeaponRules', T.bind('celestian-insidiants.sp.suffering-sacrifice', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'celestian-insidiants.sp.suffering-sacrifice')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds) return; // "a wounded friendly … operative"
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Suffering & Sacrifice)'));
  });

  // WRATHFUL DETERMINATION (strategy)
  reg.on('onDefenceDice', T.bind('celestian-insidiants.sp.wrathful-determination', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'celestian-insidiants.sp.wrathful-determination')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.order !== 'engage') return;
    ev.rerolls.push({
      id: 'celestian.wrathfulDetermination',
      label: 'Wrathful Determination: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('celestian-insidiants.sp.wrathful-determination')),
    });
  });

  // HOLY RESILIENCE (strategy)
  reg.on('onDamage', T.bind('celestian-insidiants.sp.holy-resilience', 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, 'celestian-insidiants.sp.holy-resilience')) return;
    if (!T.mineKw(ev.target, KW) || !isInspiring(ev.state, ev.target)) return;
    if (!fightSeq(ev.state)) return; // "is fighting or retaliating"
    if (ev.amount < 4) return; // "Normal and Critical Dmg of 4 or more inflicts 1 less damage"
    ev.amount -= 1;
  });

  // GLORY TO THE MARTYRS (firefight)
  reg.on('onIncapacitated', T.bind('celestian-insidiants.fp.glory-to-the-martyrs', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'celestian-insidiants.fp.glory-to-the-martyrs')) return;
    if (!T.mineKw(ev.operative, KW) || ev.prevented) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (!useOncePerSequence(ev.state, `celestian.glory:${ev.operative.id}`)) return;
    const mine = seq.attackerId === ev.operative.id ? seq.attackerPool : seq.defenderPool;
    const enemy = ev.state.operatives[seq.attackerId === ev.operative.id ? seq.defenderId : seq.attackerId];
    const die = successes(mine)[0];
    if (!enemy || !die || !T.ctx) return;
    const profile = currentProfileOf(T, ev.state, ev.operative);
    const dmg = die.state === 'crit' ? (profile?.dmgC ?? 3) : (profile?.dmgN ?? 2);
    die.state = 'struck';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Glory to the Martyrs: ${ev.operative.letter} strikes for ${dmg}` });
    const res = inflictDamage(T.ctx, ev.state, enemy, dmg, 'attack');
    if (res.incapacitated) {
      makeInspiring(ev.state, ev.operative, 'celestian-insidiants.fp.glory-to-the-martyrs', 'Glory to the Martyrs');
      offerMartyrdom(T, ev.state, ev.operative);
    }
  });

  // UNSHAKEABLE PURSUIT (firefight)
  reg.on('onStatMod', T.bind('celestian-insidiants.fp.unshakeable-pursuit', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'celestian-insidiants.fp.unshakeable-pursuit')) return;
    if (!T.mineKw(ev.operative, KW) || ev.state.activeOperativeId !== ev.operative.id) return;
    ev.mods.move = 0; // "you can ignore any changes to its Move stat"
    if (T.ctx && isInjured(T.ctx, ev.operative)) ev.mods.move += 2;
  });
  reg.on('onMoveDistance', T.bind('celestian-insidiants.fp.unshakeable-pursuit', 21), (ev) => {
    if (!ployUsed(ev.state, T.player, 'celestian-insidiants.fp.unshakeable-pursuit')) return;
    if (!T.mineKw(ev.operative, KW) || ev.state.activeOperativeId !== ev.operative.id) return;
    // "If that operative is INSPIRING, add 1" to its Move stat" — including when it becomes
    // INSPIRING by performing this very Charge.
    if (isInspiring(ev.state, ev.operative, { action: ev.action })) ev.inches += 1;
  });

  // FAITH & FURY (firefight)
  reg.on('onStrikeResolved', T.bind('celestian-insidiants.fp.faith-fury', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'celestian-insidiants.fp.faith-fury')) return;
    if (!ev.crit || ev.ctx.type !== 'melee') return;
    const fighter = ev.ctx.attacker;
    if (!T.mineKw(fighter, KW) || !T.ctx) return;
    if (!useOncePerSequence(ev.state, `celestian.faithFury:${fighter.id}`)) return;
    for (const enemy of T.enemies(ev.state)) {
      if (enemy.id === ev.struck.id) continue; // "each OTHER enemy operative"
      if (T.gap(fighter, enemy) > 2 + 1e-6 || !visible(T, ev.state, fighter, enemy)) continue;
      const d3 = T.ctx.rng.d3();
      recordRoll(ev.state, 'faithAndFury', [d3], T.player, `Faith & Fury vs ${enemy.letter}`);
      inflictDamage(T.ctx, ev.state, enemy, d3, 'other');
      if ((T.card(enemy)?.wounds ?? 0) >= 6 && enemy.incapacitated)
        makeInspiring(ev.state, fighter, 'celestian-insidiants.fp.faith-fury', 'Faith & Fury');
    }
  });

  // FERVENT HATE (firefight)
  reg.on('onWeaponRules', T.bind('celestian-insidiants.fp.fervent-hate', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'celestian-insidiants.fp.fervent-hate')) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (T.kw(ev.target, 'IMPERIUM')) return; // "an enemy operative that doesn't have the IMPERIUM keyword"
    if (T.kw(ev.target, 'CHAOS') || T.kw(ev.target, 'PSYKER'))
      ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Fervent Hate)'));
    else ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Fervent Hate)'));
  });
}

function currentProfileOf(T: TeamHooks, state: GameState, op: OperativeState): WeaponProfile | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  const name = seq.attackerId === op.id ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const weapon = T.card(op)?.weapons.find((w) => w.name === name);
  const profileName = seq.attackerId === op.id ? seq.attackerProfile : seq.defenderProfile;
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

const FLAGELLATOR_DECISION = 'celestian.autoFlagellator';

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // PSYK-OUT GRENADES — "select two utility grenades … and they must all be stun grenades."
  reg.on('onSelectEquipment', T.bind('celestian-insidiants.eq.psyk-out-grenades', 30), (ev) => {
    if (ev.player !== T.player) return;
    if (!ev.equipment.includes('celestian-insidiants.eq.psyk-out-grenades')) return;
    const team = ev.state.teams[T.player];
    const alsoUtility = team.equipment.includes(UTILITY_ID);
    // The Stun Grenade action lives in universal equipment, so the allowance is recorded there.
    team.equipmentUses[`${UTILITY_ID}:stun`] = 2;
    // "If you also select that equipment as normal, you cannot select any stun grenades."
    team.equipmentUses[`${UTILITY_ID}:smoke`] = alsoUtility ? 2 : 0;
    if (!alsoUtility) team.equipment = [...team.equipment, UTILITY_ID];
  });
  reg.on('onStunTest', T.bind('celestian-insidiants.eq.psyk-out-grenades', 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'celestian-insidiants.eq.psyk-out-grenades')) return;
    if (!T.mineKw(ev.thrower, KW)) return;
    if (ev.roll < 3) return; // "if the result is a 3+"
    // "…inflict damage on it equal to the dice result halved (rounding up). If that first
    //  operative has the PSYKER keyword, inflict damage on it equal to the dice result instead."
    ev.damage += T.kw(ev.target, 'PSYKER') ? ev.roll : Math.ceil(ev.roll / 2);
  });

  // SAINTLY RELICS
  reg.on('onDamage', T.bind('celestian-insidiants.eq.saintly-relics', 30), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (!hasEquipment(ev.state, T.player, 'celestian-insidiants.eq.saintly-relics')) return;
    if (!T.mineKw(ev.target, KW) || !T.ctx) return;
    const used = relicUses(ev.state, T.player);
    if (used >= 2) return; // "You cannot ignore … two attack dice per battle this way."
    // "You can use this rule": taken when the dice would really hurt.
    if (ev.amount < 3 && ev.amount < ev.target.wounds) return;
    if (!useOncePerSequence(ev.state, `celestian.relics:${T.player}`)) return; // "…one attack dice per action"
    const rolls = [T.ctx.rng.d6(), ...(isInspiring(ev.state, ev.target) ? [T.ctx.rng.d6()] : [])];
    recordRoll(ev.state, 'saintlyRelics', rolls, T.player, 'Saintly Relics 6+');
    setRelicUses(ev.state, T.player, used + 1);
    if (rolls.some((r) => r === 6)) {
      ev.amount = 0;
      log(ev.state, { kind: 'action', player: T.player, text: `Saintly Relics: ${ev.target.letter} ignores the damage` });
    }
  });

  // VOCIFERA MORTIS — read by `offerMartyrdom`, which widens the candidate list once per battle.
  reg.on('onIncapacitated', T.bind('celestian-insidiants.eq.vocifera-mortis', 31), () => {
    /* the widened selection happens in offerMartyrdom; this binding documents the rule */
  });

  // AUTO-FLAGELLATOR
  reg.on('onActivationStart', T.bind('celestian-insidiants.eq.auto-flagellator', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'celestian-insidiants.eq.auto-flagellator')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (isInspiring(ev.state, ev.operative)) return;
    // "You cannot make more than one friendly operative INSPIRING using this rule per turning
    //  point" — with the allowance spent, using it could only cost wounds, so it is not offered.
    if (usedThisTP(ev.state, `celestian.flagellator:${T.player}`)) return;
    if (ev.operative.wounds <= 3) return;
    ev.state.pending.push({
      id: `flagellate-${ev.state.seq++}`,
      who: T.player,
      kind: FLAGELLATOR_DECISION,
      prompt: `${ev.operative.letter}: use the AUTO-FLAGELLATOR?`,
      sourceText: shortQuote(text('celestian-insidiants.eq.auto-flagellator')),
      optional: true,
      ctx: { operativeId: ev.operative.id },
      options: [
        { id: 'use', label: 'Roll one D6: take half the result in damage, and on a 4+ become INSPIRING' },
        { id: 'decline', label: 'Do not use it' },
      ],
    });
  });
}

function relicUses(state: GameState, player: PlayerId): number {
  return Number((state.opState['celestian.relics'] as Record<string, number> | undefined)?.[player] ?? 0);
}
function setRelicUses(state: GameState, player: PlayerId, n: number): void {
  const b = (state.opState['celestian.relics'] ?? {}) as Record<string, number>;
  b[player] = n;
  state.opState['celestian.relics'] = b;
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/**
 * "…visible to and within 6" of this operative" for a SUPPORT action. The distance goes
 * through `supportDistance` so a Comms Device widens it (universal equipment).
 */
function supportReach(ctx: GameContext, state: GameState, op: OperativeState, other: OperativeState): boolean {
  const range = supportDistance(ctx, state, op, 6);
  const gap = Math.max(0, Math.hypot(other.pos.x - op.pos.x, other.pos.y - op.pos.y) - 1.3);
  return gap <= range + 1e-6 && isVisible(terrain(ctx, state), body(ctx, op), body(ctx, other)).visible;
}

/** SPIRITUAL MENTOR's target: the named friendly, or the lowest-id one in reach. */
function mentorTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): OperativeState | undefined {
  const eligible = Object.values(state.operatives)
    .filter(
      (o) =>
        o.player === op.player &&
        !o.removed &&
        (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW) &&
        supportReach(ctx, state, op, o),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return eligible.find((o) => o.id === chosenId) ?? eligible[0];
}

/** SPEAK OF HER DEEDS needs an INSPIRING source AND a different target, both in reach. */
function speakPair(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): { source: OperativeState; target: OperativeState } | undefined {
  const inReach = Object.values(state.operatives)
    .filter(
      (o) =>
        o.player === op.player &&
        !o.removed &&
        (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW) &&
        supportReach(ctx, state, op, o),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const source = inReach.find((o) => isInspiring(state, o));
  if (!source) return undefined;
  const target = inReach.find((o) => o.id === chosenId && o.id !== source.id) ?? inReach.find((o) => o.id !== source.id);
  return target ? { source, target } : undefined;
}

function actions(data: typeof DATA) {
  return [
    // SPIRITUAL MENTOR 1AP (SUPPORT) — SUPERIOR
    uniqueAction(data, 'celestian-insidiants.insidiant-superior', 'celestian-insidiants.insidiant-superior.act.spiritual-mentor', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `celestian.mentor:${op.id}`))
          return { ok: false, reason: 'this action cannot be performed more than once per turning point' };
        return mentorTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CELESTIAN INSIDIANT operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = mentorTarget(ctx, state, op, params.targetOperativeId);
        if (!target) return { ok: false, reason: 'select one friendly CELESTIAN INSIDIANT operative visible to and within 6"' };
        useOncePerTP(state, `celestian.mentor:${op.id}`);
        makeInspiring(state, target, 'celestian-insidiants.insidiant-superior.act.spiritual-mentor', 'Spiritual Mentor');
        return { ok: true };
      },
    }),

    // NULLIFYING RITUAL 1AP — CENSOR
    uniqueAction(data, 'celestian-insidiants.insidiant-censor', 'celestian-insidiants.insidiant-censor.act.nullifying-ritual', {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `celestian.ritual:${op.id}`))
          return { ok: false, reason: 'this action cannot be performed more than once per turning point' };
        if (nullRange(state, op) >= 5) return { ok: false, reason: 'the null range is already 5"' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        useOncePerTP(state, `celestian.ritual:${op.id}`);
        const eff = effectOn(state, op.id, 'celestian.nullRange');
        if (eff) eff.data = { steps: Number(eff.data?.['steps'] ?? 0) + 1 };
        else
          effect(state, {
            rule: 'celestian.nullRange',
            source: { kind: 'ability', id: 'celestian-insidiants.insidiant-censor.act.nullifying-ritual' },
            operativeId: op.id,
            player: op.player,
            data: { steps: 1 },
            expiry: { kind: 'endOfBattle' },
          });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: NULLIFYING RITUAL (null range ${nullRange(state, op)}")` });
        return { ok: true };
      },
    }),

    // SPEAK OF HER DEEDS 1AP (SUPPORT) — DENUNCIA
    uniqueAction(data, 'celestian-insidiants.insidiant-denuncia', 'celestian-insidiants.insidiant-denuncia.act.speak-of-her-deeds', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const pair = speakPair(ctx, state, op, params.targetOperativeId);
        return pair ? { ok: true } : { ok: false, reason: 'no INSPIRING friendly operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const pair = speakPair(ctx, state, op, params.targetOperativeId);
        if (!pair) return { ok: false, reason: 'no INSPIRING friendly operative visible to and within 6"' };
        const { source, target } = pair;
        // "That operative is no longer INSPIRING."
        dropEffects(state, (e) => e.rule === INSPIRING && e.operativeId === source.id);
        // "Resolve one BENEDICTION … on that operative (excluding Exigence)."
        const choice = (params.choice ?? 'restoration') as Benediction;
        const benediction: Benediction =
          choice === 'exigence' || !BENEDICTIONS.includes(choice)
            ? 'restoration'
            : choice === 'ardour' && (ctx.datacards.get(target.datacardId)?.keywords ?? []).includes('SUPERIOR')
              ? 'restoration'
              : choice;
        applyBenediction(ctx, state, target, benediction, source);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SPEAK OF HER DEEDS (${source.letter} → ${target.letter})` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------

export const celestianInsidiants = defineTeam({
  id: 'celestian-insidiants',
  rareRules: ['AntiPSYKER', 'Shield'],
  rules: (reg, T) => {
    rules(reg, T);
    // The team owns three decision kinds (BENEDICTION, ultimatum, auto-flagellator); the
    // handler is installed once per GameContext — `decisionHandler` is a stable reference.
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
      'celestian-insidiants.insidiant-superior': 'leader',
      'celestian-insidiants.insidiant-abjuror': 'support',
      'celestian-insidiants.insidiant-censor': 'melee',
      'celestian-insidiants.insidiant-cremator': 'gunner',
      'celestian-insidiants.insidiant-denuncia': 'support',
      'celestian-insidiants.insidiant-mortisanctus': 'melee',
      'celestian-insidiants.insidiant-reliquarius': 'objective',
      'celestian-insidiants.insidiant-warrior': 'objective',
    },
    ployValue: {
      'celestian-insidiants.sp.suspect-eliminate': 0.6,
      'celestian-insidiants.sp.suffering-sacrifice': 0.5,
      'celestian-insidiants.sp.wrathful-determination': 0.5,
      'celestian-insidiants.sp.holy-resilience': 0.5,
      'celestian-insidiants.fp.glory-to-the-martyrs': 0.4,
      'celestian-insidiants.fp.unshakeable-pursuit': 0.4,
      'celestian-insidiants.fp.faith-fury': 0.6,
      'celestian-insidiants.fp.fervent-hate': 0.6,
    },
    equipmentValue: {
      'celestian-insidiants.eq.psyk-out-grenades': 0.4,
      'celestian-insidiants.eq.saintly-relics': 0.6,
      'celestian-insidiants.eq.vocifera-mortis': 0.3,
      'celestian-insidiants.eq.auto-flagellator': 0.5,
    },
  },
});

export default celestianInsidiants;
