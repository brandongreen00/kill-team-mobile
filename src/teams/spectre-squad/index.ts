/**
 * SPECTRE SQUAD — Astra Militarum. https://wahapedia.ru/kill-team3/kill-teams/spectre-squad/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/spectre-squad.json`, never retyped.
 *
 * Two clauses of Elite Fieldcraft shape the whole module:
 *
 *  - The interrupt fires "after an enemy operative … performs an action during its
 *    activation". **The engine emits no post-action hook** (`offerGuardInterrupt` in
 *    `src/core/reducer.ts` is the only thing that runs there and it emits nothing), so the
 *    interrupt is taken at the LAST moment of that activation the engine does expose,
 *    `onActivationEnd`, and the free action itself is AP granted outside the APL budget
 *    (docs/DECISIONS.md D-100) — it lands on the interrupting operative's own next
 *    activation (D-013), on top of whatever APL that operative has.
 *  - "you can spend 1 of your Fieldcraft points" is a player choice with no decision
 *    channel, so it is auto-spent on the stated D-022 policy below.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { EXPLOSIVE_ID, grenadeAllowance, grenadeWeapon } from '../../core/equipment/grenades.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { checkTarget, effectiveRules, startShoot, advanceShoot } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aplOf,
  body,
  enemiesInControlRange,
  gapBetween,
  inflictDamage,
  log,
  findProfile,
  markerContestedBy,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  Order,
  PlayerId,
  Vec2,
  Weapon,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('spectre-squad');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

export const KW = 'SPECTRE SQUAD';
const EPS = 1e-6;

/** Datacard ids the printed rules name. */
export const C = {
  sergeant: 'spectre-squad.veteran-sergeant',
  beacon: 'spectre-squad.vox-relay-beacon',
  medicae: 'spectre-squad.field-medicae',
  grenadier: 'spectre-squad.grenadier',
  guide: 'spectre-squad.guide',
  gunner: 'spectre-squad.gunner',
  heavyGunner: 'spectre-squad.heavy-gunner',
  loader: 'spectre-squad.loader',
  sharpshooter: 'spectre-squad.sharpshooter',
  stubGunner: 'spectre-squad.stub-gunner',
  trooper: 'spectre-squad.trooper',
  voxOperator: 'spectre-squad.vox-operator',
} as const;

export const RULE = {
  eliteFieldcraft: 'spectre-squad.rule.elite-fieldcraft',
  camoCloaks: 'spectre-squad.rule.camo-cloaks',
} as const;

export const SP = {
  disappear: 'spectre-squad.sp.disappear',
  hiddenEngagement: 'spectre-squad.sp.hidden-engagement',
  ambushingVolley: 'spectre-squad.sp.ambushing-volley',
  patience: 'spectre-squad.sp.patience',
} as const;

export const FP = {
  dodge: 'spectre-squad.fp.dodge',
  silentKillers: 'spectre-squad.fp.silent-killers',
  sharpReactions: 'spectre-squad.fp.sharp-reactions',
  preparedDefence: 'spectre-squad.fp.prepared-defence',
} as const;

export const EQ = {
  sniperOverwatch: 'spectre-squad.eq.sniper-overwatch',
  tvidFeed: 'spectre-squad.eq.tvid-feed-triangulation',
  starshellFlare: 'spectre-squad.eq.starshell-flare',
  advancedCamouflage: 'spectre-squad.eq.advanced-camouflage',
} as const;

const A = {
  preDeploy: `${C.beacon}.pre-deploy`,
  expendable: `${C.beacon}.expendable`,
  medic: `${C.medicae}.medic`,
  grenadier: `${C.grenadier}.grenadier`,
  meltaMine: `${C.grenadier}.melta-mine`,
  proximityMine: `${C.grenadier}.proximity-mine`,
  preparedKillzone: `${C.guide}.prepared-killzone`,
  scoutTerrain: `${C.guide}.scout-terrain`,
  weaponsTeam: `${C.heavyGunner}.weapons-team`,
  weaponAssist: `${C.loader}.weapon-assist`,
  concealedPosition: `${C.sharpshooter}.concealed-position`,
  suppressiveFire: `${C.stubGunner}.suppressive-fire`,
  coolHeaded: `${C.trooper}.cool-headed`,
} as const;

export const ACT = {
  issueMission: `${C.sergeant}.act.issue-mission`,
  beaconSignal: `${C.beacon}.act.signal`,
  medikit: `${C.medicae}.act.medikit`,
  loadWeapon: `${C.loader}.act.load-weapon`,
  voxSignal: `${C.voxOperator}.act.signal`,
} as const;

/** Effect rule names — namespaced scratch, never module-level state. */
const E = {
  interrupt: 'spectre.eliteFieldcraft.interrupt',
  issueMission: 'spectre.issueMission',
  sharpReactions: 'spectre.sharpReactions',
  dodge: 'spectre.dodge',
  silentKillers: 'spectre.silentKillers',
  ambush: 'spectre.ambushingVolley',
  advCamo: 'spectre.advancedCamouflage',
  preparedDefence: 'spectre.preparedDefence',
  medicApl: 'spectre.medicApl',
  medicGuard: 'spectre.medicGuard',
  activationOver: 'spectre.activationOver',
  disappear: 'spectre.disappear',
  signalApl: 'spectre.signalApl',
} as const;

/** The extra actions this team registers. */
export const FIELDCRAFT_SHOOT = 'Shoot (Elite Fieldcraft)';
export const SILENT_CHARGE = 'Charge (Silent Killers)';
export const STARSHELL_STUN = 'Stun Grenade (Starshell Flare)';
export const ADVANCED_CAMOUFLAGE_ACTION = 'ADVANCED CAMOUFLAGE';
export const MINE_PICK_UP = 'Pick Up Marker (Melta Mine)';
export const MINE_PLACE = 'Place Marker (Melta Mine)';

/** "…can perform a free Shoot (excluding Guard), Dash or Reposition action." */
const FIELDCRAFT_ACTIONS = ['Shoot', FIELDCRAFT_SHOOT, 'Dash', 'Reposition'];

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);
const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade', SILENT_CHARGE];
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

// ---------------------------------------------------------------------------
// Fieldcraft points
// ---------------------------------------------------------------------------

export function fieldcraftPoints(state: GameState, player: PlayerId): number {
  return Number(bucket(state, 'spectre.fieldcraft')[player] ?? 0);
}
function setFieldcraft(state: GameState, player: PlayerId, n: number): void {
  bucket(state, 'spectre.fieldcraft')[player] = Math.max(0, n);
}

// ---------------------------------------------------------------------------
// "before determining its order"
// ---------------------------------------------------------------------------

/**
 * AMBUSHING VOLLEY tests "isn't a valid target for enemy operatives BEFORE determining its
 * order", but `ActivateOperative` writes the new order before `onActivationStart` is emitted.
 * The order an operative carries into its activation is the one it ended its last activation
 * with — recorded here at deployment (always Conceal, "must be given a Conceal order") and at
 * the end of each activation, which is also every moment a rule of this team changes an order.
 */
function rememberOrder(state: GameState, op: OperativeState): void {
  (bucket(state, 'spectre.prevOrder') as Record<string, Order>)[op.id] = op.order;
}
export function previousOrder(state: GameState, op: OperativeState): Order {
  return (bucket(state, 'spectre.prevOrder') as Record<string, Order | undefined>)[op.id] ?? 'conceal';
}

// ---------------------------------------------------------------------------
// "isn't a valid target for enemy operatives"
// ---------------------------------------------------------------------------

/**
 * Runs the core's own Select Valid Target step from each enemy operative in turn, for every
 * ranged profile it carries — the only honest reading of "isn't a valid target for enemy
 * operatives". Guarded against re-entry because `checkTarget` emits `onValidTarget`.
 */
export function isValidTargetForEnemies(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const guard = bucket(state, 'spectre.targetProbe');
  if (guard['busy']) return false;
  guard['busy'] = true;
  try {
    for (const enemy of T.enemies(state)) {
      for (const weapon of weaponsOf(ctx, state, enemy, 'ranged')) {
        for (const profile of weapon.profiles) {
          if (profile.type !== 'ranged') continue;
          const rules = effectiveRules(ctx, state, profile, {
            operative: enemy,
            target: op,
            weaponName: weapon.name,
          });
          if (checkTarget(ctx, state, enemy, op, profile, rules).valid) return true;
        }
      }
    }
    return false;
  } finally {
    guard['busy'] = false;
  }
}

/** The same test taken with the order the operative held before this activation began. */
function wasValidTargetBeforeOrder(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const now = op.order;
  op.order = previousOrder(state, op);
  try {
    return isValidTargetForEnemies(T, state, op);
  } finally {
    op.order = now;
  }
}

// ---------------------------------------------------------------------------
// Elite Fieldcraft — the interrupt
// ---------------------------------------------------------------------------

/**
 * "You cannot interrupt each enemy operative's activation more than once per activation
 * (including Guard)." An operative has exactly one activation per turning point, plus at most
 * one counteraction, so the pair (operative, turning point, counteracting?) names the window.
 */
function interruptKey(state: GameState, enemy: OperativeState): string {
  const counteracting = state.opState['counteract'] ? 'c' : 'a';
  return `${enemy.id}:${state.turningPoint}:${counteracting}`;
}

/**
 * D-022 policy: the points are discarded at the end of every turning point, so an interrupt
 * that has a legal user is always taken — at the first enemy activation that offers one,
 * with the lowest-id eligible ready operative (an ISSUE MISSION'd expended operative only
 * when no ready one qualifies). Every interrupt is written to the log.
 */
function tryInterrupt(T: TeamHooks, state: GameState, enemy: OperativeState): void {
  if (!T.ctx) return;
  const done = bucket(state, 'spectre.interrupted');
  const key = interruptKey(state, enemy);
  if (done[key]) return;

  // "After an enemy operative that has an Engage order performs an action…", widened by
  // SHARP REACTIONS to a Conceal-order enemy within 8" of a friendly SPECTRE SQUAD operative.
  const sharp = Boolean(effectFor(state, T.player, E.sharpReactions));
  const sharpOk =
    sharp &&
    enemy.order === 'conceal' &&
    T.friendlies(state, KW).some((o) => T.gap(o, enemy) <= 8 + EPS);
  if (enemy.order !== 'engage' && !sharpOk) return;

  const points = fieldcraftPoints(state, T.player);
  const coolHeadedFree = (o: OperativeState): boolean =>
    o.datacardId === C.trooper && !usedThisTP(state, `spectre.coolHeaded:${T.player}`);
  const eligible = T.friendlies(state, KW).filter(
    (o) =>
      o.datacardId !== C.beacon && // Expendable: "cannot perform any actions other than Signal"
      !usedThisTP(state, `spectre.fieldcraftFree:${o.id}`) &&
      // "a ready friendly SPECTRE SQUAD operative that isn't within control range of any
      //  OTHER enemy operatives"
      T.enemies(state).every((e) => e.id === enemy.id || T.gap(o, e) > 1 + EPS) &&
      (points >= 1 || coolHeadedFree(o)),
  );
  const ready = eligible.filter((o) => o.ready).sort(byId);
  // ISSUE MISSION: "that friendly operative can do so even though it's expended".
  const issued = eligible.filter((o) => !o.ready && Boolean(effectOn(state, o.id, E.issueMission))).sort(byId);
  const chosen = ready[0] ?? issued[0];
  if (!chosen) return;

  done[key] = true;
  useOncePerTP(state, `spectre.fieldcraftFree:${chosen.id}`);
  if (coolHeadedFree(chosen)) {
    // TROOPER › Cool-Headed: "can interrupt … for 0 Fieldcraft points".
    useOncePerTP(state, `spectre.coolHeaded:${T.player}`);
  } else {
    setFieldcraft(state, T.player, points - 1);
  }
  effect(state, {
    rule: E.interrupt,
    source: { kind: 'ability', id: RULE.eliteFieldcraft },
    sourceText: shortQuote(text(RULE.eliteFieldcraft)),
    operativeId: chosen.id,
    player: T.player,
    data: { enemyId: enemy.id, threshold: currentApl(T, state, chosen) },
    expiry: { kind: 'endOfActivation', operativeId: chosen.id },
  });
  if (chosen.ready) {
    grantFreeAction(state, chosen, {
      sourceId: RULE.eliteFieldcraft,
      sourceText: shortQuote(text(RULE.eliteFieldcraft)),
      kind: 'ability',
      threshold: currentApl(T, state, chosen),
      only: FIELDCRAFT_ACTIONS,
    });
  } else {
    // "if it does, it cannot counteract during the turning point" (ISSUE MISSION).
    chosen.counteractedThisTP = true;
  }
  log(state, {
    kind: 'ploy',
    player: T.player,
    text: `Elite Fieldcraft: ${chosen.letter} interrupts ${enemy.letter}'s activation`,
    data: { operativeId: chosen.id, enemyId: enemy.id, points: fieldcraftPoints(state, T.player) },
  });
}

/** Is this operative currently spending its Elite Fieldcraft free action? */
function spendingInterrupt(state: GameState, op: OperativeState): { enemyId: string } | undefined {
  const eff = effectOn(state, op.id, E.interrupt);
  if (!eff) return undefined;
  if (op.apSpent < Number(eff.data?.['threshold'] ?? 0)) return undefined;
  return { enemyId: String(eff.data?.['enemyId'] ?? '') };
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Elite Fieldcraft › the points --------------------------------------
  // "In the Ready step of each Strategy phase, you gain 1 Fieldcraft point, or 2 if a
  //  friendly SPECTRE SQUAD VOX-OPERATOR operative is in the killzone and isn't within
  //  control range of enemy operatives."
  reg.on('onReadyStep', T.bind(RULE.eliteFieldcraft, 10), (ev) => {
    if (ev.player !== T.player) return;
    const vox = T.friendlies(ev.state).some(
      (o) => o.datacardId === C.voxOperator && T.enemies(ev.state).every((e) => T.gap(e, o) > 1 + EPS),
    );
    const gained = vox ? 2 : 1;
    setFieldcraft(ev.state, T.player, fieldcraftPoints(ev.state, T.player) + gained);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Elite Fieldcraft: +${gained} Fieldcraft point${gained > 1 ? 's' : ''} (${fieldcraftPoints(ev.state, T.player)})`,
    });
  });
  // "At the end of each turning point, discard your Fieldcraft points."
  reg.on('onEndOfTP', T.bind(RULE.eliteFieldcraft, 11), (ev) => {
    setFieldcraft(ev.state, T.player, 0);
  });

  // ---- Elite Fieldcraft › the interrupt -----------------------------------
  reg.on('onActivationEnd', T.bind(RULE.eliteFieldcraft, 12), (ev) => {
    rememberOrder(ev.state, ev.operative);
    if (ev.operative.player === T.player) return;
    tryInterrupt(T, ev.state, ev.operative);
  });
  reg.on('onDeploy', T.bind(RULE.eliteFieldcraft, 12), (ev) => {
    rememberOrder(ev.state, ev.operative);
  });

  // "You cannot select any other enemy operative as a valid target during that action."
  reg.on('onValidTarget', T.bind(RULE.eliteFieldcraft, 12), (ev) => {
    if (ev.attacker.player !== T.player) return;
    const lock = spendingInterrupt(ev.state, ev.attacker);
    if (!lock || ev.target.id === lock.enemyId) return;
    ev.valid = false;
    ev.reason = 'Elite Fieldcraft: only the interrupted enemy operative can be selected';
  });

  // "If it's the Reposition action, that friendly operative cannot perform that action again
  //  during the turning point." (DISAPPEAR prints the same clause for its free Reposition.)
  reg.on('onActivationEnd', T.bind(RULE.eliteFieldcraft, 13), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !did(op, 'Reposition')) return;
    if (!effectOn(ev.state, op.id, E.interrupt) && !effectOn(ev.state, op.id, E.disappear)) return;
    useOncePerTP(ev.state, `spectre.noReposition:${op.id}`);
  });
  reg.on('canPerformAction', T.bind(RULE.eliteFieldcraft, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== 'Reposition') return;
    if (!usedThisTP(ev.state, `spectre.noReposition:${ev.operative.id}`)) return;
    ev.allowed = false;
    ev.reason = 'it cannot perform the Reposition action again during this turning point';
  });

  // ---- Camo Cloaks --------------------------------------------------------
  // "Whenever an operative is shooting a friendly SPECTRE SQUAD operative (excluding
  //  VOX-RELAY BEACON), if you can retain any cover saves, you can retain one additional
  //  cover save, or you can retain one cover save as a critical success instead. This isn't
  //  cumulative with improved cover saves from Vantage terrain."
  reg.on('onDefenceDice', T.bind(RULE.camoCloaks, 10), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.datacardId === C.beacon) return;
    if (!ev.coverSave) return; // "if you can retain any cover saves"
    const seq = shootSeq(ev.state);
    if (seq?.vantageImprovedCover) return; // "isn't cumulative with … Vantage terrain"
    // The two halves are exclusive ("or"); the additional cover save is the deterministic
    // choice — a second retained normal is never worse than promoting one to a critical.
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // ---- VOX-RELAY BEACON › Pre-Deploy --------------------------------------
  // REMINDER ONLY. "In the Set Up Operatives step, this operative can be set up outside of
  // your drop zone." `DeployOperative` refuses a position outside the drop zone BEFORE
  // `onDeploy` is emitted, and the hook's own `extraZones` field is never read.

  // ---- VOX-RELAY BEACON › Expendable --------------------------------------
  // "This operative cannot perform any actions other than Signal."
  reg.on('canPerformAction', T.bind(A.expendable, 10), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.beacon) return;
    if (ev.action === ACT.beaconSignal) return;
    ev.allowed = false;
    ev.reason = 'this operative cannot perform any actions other than Signal';
  });
  // "It cannot counteract…"
  reg.on('onCounteract', T.bind(A.expendable, 10), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.beacon) return;
    ev.allowed = false;
    ev.reason = 'Expendable';
  });
  // "…retaliate…" — `startFight` reads a core `cannotRetaliate` effect.
  const markCannotRetaliate = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === C.beacon)) {
      if (state.effects.some((e) => e.rule === 'cannotRetaliate' && e.operativeId === o.id)) continue;
      effect(state, {
        rule: 'cannotRetaliate',
        source: { kind: 'ability', id: A.expendable },
        sourceText: shortQuote(abilityText(C.beacon, A.expendable)),
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfBattle' },
      });
    }
  };
  reg.on('onDeploy', T.bind(A.expendable, 11), (ev) => {
    if (ev.operative.player === T.player) markCannotRetaliate(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.expendable, 11), (ev) => markCannotRetaliate(ev.state));
  // "…or assist in a fight." `onFightAssist` carries only the fighter, so the BEACON is
  // subtracted when it is within control range of an enemy that is itself within the
  // fighter's control range — the only enemy an assist can be counted against.
  reg.on('onFightAssist', T.bind(A.expendable, 11), (ev) => {
    if (ev.operative.player !== T.player || ev.assists <= 0 || !T.ctx) return;
    const foes = T.enemies(ev.state).filter((e) => T.gap(e, ev.operative) <= 1 + EPS);
    for (const beacon of T.friendlies(ev.state).filter((o) => o.datacardId === C.beacon)) {
      const touching = T.enemies(ev.state).filter((e) => T.gap(e, beacon) <= 1 + EPS);
      if (touching.length === 1 && foes.some((f) => f.id === touching[0]!.id)) ev.assists -= 1;
    }
    ev.assists = Math.max(0, ev.assists);
  });
  // "This operative cannot contest markers or areas of the killzone."
  reg.on('onMarkerControl', T.bind(A.expendable, 11), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    for (const beacon of T.friendlies(ev.state).filter((o) => o.datacardId === C.beacon)) {
      if (!markerContestedBy(T.ctx, ev.state, marker, beacon)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - aplOf(T.ctx, ev.state, beacon));
    }
  });
  // "Whenever a friendly SPECTRE SQUAD operative is performing the Shoot action and you're
  //  selecting a valid target, you can ignore this operative's control range."
  reg.on('onValidTarget', T.bind(A.expendable, 11), (ev) => {
    if (ev.attacker.player !== T.player || !T.kw(ev.attacker, KW) || !T.ctx) return;
    const blockers = T.friendlies(ev.state).filter((f) => f.id !== ev.attacker.id && T.gap(f, ev.target) <= 1 + EPS);
    if (blockers.length === 0 || !blockers.every((f) => f.datacardId === C.beacon)) return;
    ev.ignoreFriendlyControlRange = true;
  });

  // ---- FIELD MEDICAE › Medic! ---------------------------------------------
  reg.on('onIncapacitated', T.bind(A.medic, 10), (ev) => {
    const victim = ev.operative;
    if (ev.prevented) return;
    if (!T.mineKw(victim, KW) || victim.datacardId === C.beacon) return;
    // "…cannot be incapacitated for the remainder of the action."
    if (effectOn(ev.state, victim.id, E.medicGuard)) {
      ev.prevented = true;
      victim.wounds = Math.max(1, victim.wounds);
      return;
    }
    if (!T.ctx) return;
    const medic = T.friendlies(ev.state)
      .filter(
        (o) =>
          o.datacardId === C.medicae &&
          o.id !== victim.id &&
          !o.incapacitated &&
          T.gap(o, victim) <= 3 + EPS &&
          isVisible(terrain(T.ctx!, ev.state), body(T.ctx!, o), body(T.ctx!, victim)).visible &&
          // "providing neither this nor that operative is within control range of an enemy"
          T.enemies(ev.state).every((e) => T.gap(e, o) > 1 + EPS && T.gap(e, victim) > 1 + EPS) &&
          !usedThisTP(ev.state, `spectre.medic:${o.id}`),
      )
      .sort(byId)[0];
    if (!medic) return;
    // "You cannot use this rule … if it's a Shoot action and this operative would be a
    //  primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    useOncePerTP(ev.state, `spectre.medic:${medic.id}`);
    ev.prevented = true;
    victim.wounds = 1;
    medicTargets(ev.state)[medic.id] = victim.id;
    effect(ev.state, {
      rule: E.medicGuard,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.medicae, A.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? victim.id },
    });
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: E.medicApl,
        source: { kind: 'ability', id: A.medic },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    // "After that action, that friendly operative can immediately perform a free Dash
    //  action" — its "must end that move within this operative's control range" half has no
    //  seam (nothing constrains where a move ends) and is reminder-only.
    grantFreeAction(ev.state, victim, {
      sourceId: A.medic,
      sourceText: shortQuote(abilityText(C.medicae, A.medic)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, victim),
      only: ['Dash'],
    });
    // "…and if this rule was used during that friendly operative's activation, that
    //  activation ends."
    if (ev.state.activeOperativeId === victim.id) {
      effect(ev.state, {
        rule: E.activationOver,
        source: { kind: 'ability', id: A.medic },
        operativeId: victim.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: victim.id },
      });
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Medic! ${medic.letter} keeps ${victim.letter} on 1 wound`,
    });
  });
  reg.on('canPerformAction', T.bind(A.medic, 11), (ev) => {
    if (ev.operative.player !== T.player || ev.action === 'Dash') return;
    if (!effectOn(ev.state, ev.operative.id, E.activationOver)) return;
    ev.allowed = false;
    ev.reason = 'that activation ended when the Medic! rule was used';
  });

  // ---- GRENADIER › Grenadier ---------------------------------------------
  // "This operative can use frag, krak, and smoke grenades (see universal equipment)."
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === C.grenadier)) {
      grantWeapon(o, structuredClone(grenadeWeapon('frag')));
      grantWeapon(o, structuredClone(grenadeWeapon('krak')));
    }
  };
  reg.on('onDeploy', T.bind(A.grenadier, 12), (ev) => {
    if (ev.operative.player === T.player) armGrenadier(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.grenadier, 12), (ev) => armGrenadier(ev.state));
  // The universal Explosive Grenades limiter refuses a grenade the kill team has spent; the
  // GRENADIER is exempt, so it is re-allowed here (a later priority than the equipment's 10).
  reg.on('onSelectWeapon', T.bind(A.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== C.grenadier) return;
    if (!isGrenade(ev.ctx.weaponName)) return;
    ev.allowed = true;
    ev.reason = undefined;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs
  // at priority 10 on the same hook, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(A.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== C.grenadier) return;
    if (!isGrenade(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = ev.ctx.weaponName === 'Krak grenade' ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever this operative is using a frag or krak grenade, improve the Hit stat of that
  //  weapon by 1." `StatMods.hit` from `onCollectAttackDice` is dead — `hitOf` reads only
  //  `onStatMod`, so the sequence supplies the weapon context.
  reg.on('onStatMod', T.bind(A.grenadier, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.grenadier) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !isGrenade(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // ---- GRENADIER › Melta Mine + Proximity Mine ----------------------------
  const mineUpkeep = (state: GameState): void => {
    ensureMine(T, state);
    syncMine(T, state);
  };
  reg.on('onDeploy', T.bind(A.meltaMine, 12), (ev) => {
    if (ev.operative.player === T.player) mineUpkeep(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.meltaMine, 12), (ev) => mineUpkeep(ev.state));
  reg.on('onReadyStep', T.bind(A.meltaMine, 12), (ev) => {
    if (ev.player === T.player) mineUpkeep(ev.state);
  });
  // "(if this operative is incapacitated while carrying that marker and that marker cannot be
  //  placed, it's removed with this operative)"
  reg.on('onIncapacitated', T.bind(A.meltaMine, 13), (ev) => {
    const op = ev.operative;
    if (ev.prevented || op.player !== T.player || op.datacardId !== C.grenadier) return;
    if (op.carryingMarkerId !== MELTA_MARKER(T.player)) return;
    if (!T.enemies(ev.state).some((e) => T.gap(e, op) <= 2 + EPS)) return;
    delete ev.state.markers[op.carryingMarkerId];
    op.carryingMarkerId = undefined;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${op.letter}'s Melta Mine marker cannot be placed and is removed with it`,
    });
  });
  // The universal Place Marker action cannot express "cannot be placed within an enemy
  // operative's control range", so the mine has its own Pick Up / Place actions (below).
  // (The universal Pick Up Marker already refuses it: the Melta Mine marker carries no
  //  `pickUpAllowed` flag, so only the GRENADIER's own action below can lift it.)
  reg.on('canPerformAction', T.bind(A.meltaMine, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== 'Place Marker') return;
    if (ev.operative.carryingMarkerId !== MELTA_MARKER(T.player)) return;
    ev.allowed = false;
    ev.reason = 'use this operative’s own Melta Mine action for that marker';
  });
  // Proximity Mine. PARTIAL: `checkMines` is core-only and `applyMove` emits no marker
  // trigger, so the mine springs at the activation boundary and "end its action" is lost.
  const springMine = (state: GameState): void => {
    if (!T.ctx) return;
    const marker = state.markers[MELTA_MARKER(T.player)];
    if (!marker || marker.carriedBy) return;
    const grenadier = T.friendlies(state).find((o) => o.datacardId === C.grenadier);
    const victim = [...T.friendlies(state), ...T.enemies(state)]
      .filter((o) => o.id !== grenadier?.id) // "this operative is ignored for these effects"
      .sort(byId)
      .find((o) => markerContestedBy(T.ctx!, state, marker, o));
    if (!victim) return;
    delete state.markers[marker.id];
    const damage = T.ctx.rng.d6() + T.ctx.rng.d6() + 3;
    recordRoll(state, 'meltaMine', [damage], T.player, 'Proximity Mine 2D6+3');
    log(state, {
      kind: 'action',
      player: T.player,
      text: `${victim.letter} sets off the Melta Mine (${damage} damage)`,
    });
    inflictDamage(T.ctx, state, victim, damage, 'mine');
  };
  reg.on('onActivationStart', T.bind(A.proximityMine, 14), (ev) => springMine(ev.state));
  reg.on('onActivationEnd', T.bind(A.proximityMine, 15), (ev) => springMine(ev.state));

  // ---- GUIDE › Prepared Killzone ------------------------------------------
  // REMINDER ONLY. "You can select one additional equipment option" — `SelectEquipment`
  // refuses a fifth option before any hook is emitted, and which option is a player choice
  // with no decision channel at that step.

  // ---- GUIDE › Scout Terrain ----------------------------------------------
  // "Perform the Operate Hatch action for 1 less AP if the access point is scouted." An
  // access point must be within the operative's control range to be operated, so the actor's
  // own position stands in for it; the climb half needs `onMoveRules`, which is never emitted.
  reg.on('onActionCost', T.bind(A.scoutTerrain, 12), (ev) => {
    if (ev.action !== 'Operate Hatch' || !T.mineKw(ev.operative, KW)) return;
    if (!isScouted(T, ev.state, ev.operative.pos)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- HEAVY GUNNER › Weapons Team ----------------------------------------
  // "Whenever this operative is activated, if a friendly LOADER operative is within its
  //  control range, all profiles of its missile launcher have the Heavy (Dash only) weapon
  //  rule instead of the Heavy weapon rule until the end of that activation."
  reg.on('onActivationStart', T.bind(A.weaponsTeam, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.heavyGunner) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === C.loader && T.gap(o, op) <= 1 + EPS)) return;
    effect(ev.state, {
      rule: 'spectre.weaponsTeam',
      source: { kind: 'ability', id: A.weaponsTeam },
      sourceText: shortQuote(abilityText(C.heavyGunner, A.weaponsTeam)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(A.weaponsTeam, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.heavyGunner) return;
    if (ev.weaponName.toLowerCase() !== 'missile launcher') return;
    if (!effectOn(ev.state, ev.operative.id, 'spectre.weaponsTeam')) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Heavy');
    ev.rules.push({ id: 'Heavy', only: 'Dash', raw: 'Heavy (Dash only)' });
  });

  // ---- LOADER › Weapon Assist ---------------------------------------------
  // "Whenever another friendly SPECTRE SQUAD operative within control range of this operative
  //  is shooting, you can re-roll one of your attack dice."
  reg.on('onRollAttack', T.bind(A.weaponAssist, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const loader = T.friendlies(ev.state).find(
      (o) => o.datacardId === C.loader && o.id !== ev.ctx.attacker.id && T.gap(o, ev.ctx.attacker) <= 1 + EPS,
    );
    if (!loader) return;
    ev.rerolls.push({
      id: 'spectre.weaponAssist',
      label: 'Weapon Assist: re-roll one of your attack dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(abilityText(C.loader, A.weaponAssist)),
    });
  });

  // ---- SHARPSHOOTER › Concealed Position (rare weapon rule) ---------------
  // "This operative can only use this weapon the first time it's performing the Shoot action
  //  during the battle." Concealed Position sits on ONE profile of the long-las, which
  //  `availableWeapons` (per weapon) cannot express — `onSelectWeapon` can.
  reg.on('onSelectWeapon', T.bind(A.concealedPosition, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShot(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bind(A.concealedPosition, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || ev.ctx.secondary) return;
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // ---- STUB-GUNNER › Suppressive Fire -------------------------------------
  // "Whenever an enemy operative is visible to and within 3" of this operative, if this
  //  operative has an Engage order and isn't within control range of any other enemy
  //  operatives, subtract 1 from the Atk stat of that enemy operative's weapons (to a minimum
  //  of 1). This rule has no effect if this operative performed the Charge action during this
  //  turning point."
  reg.on('onCollectAttackDice', T.bind(A.suppressiveFire, 12), (ev) => {
    const shooter = ev.ctx.attacker;
    if (shooter.player === T.player || !T.ctx) return;
    const suppressed = T.friendlies(ev.state).some((o) => {
      if (o.datacardId !== C.stubGunner || o.order !== 'engage') return false;
      if (usedThisTP(ev.state, `spectre.charged:${o.id}`)) return false;
      if (T.gap(o, shooter) > 3 + EPS) return false;
      if (T.enemies(ev.state).some((e) => e.id !== shooter.id && T.gap(e, o) <= 1 + EPS)) return false;
      return isVisible(terrain(T.ctx!, ev.state), body(T.ctx!, o), body(T.ctx!, shooter)).visible;
    });
    if (!suppressed) return;
    ev.count = Math.max(1, ev.count - 1);
  });
  reg.on('onActivationEnd', T.bind(A.suppressiveFire, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.stubGunner) return;
    if (did(ev.operative, 'Charge') || did(ev.operative, SILENT_CHARGE))
      useOncePerTP(ev.state, `spectre.charged:${ev.operative.id}`);
  });

  // ---- TROOPER › Cool-Headed ----------------------------------------------
  // Implemented inside `tryInterrupt`: a TROOPER interrupt costs 0 Fieldcraft points once
  // per turning point, which is what lets the rule fire when the pool is empty.
}

function medicTargets(state: GameState): Record<string, string> {
  return bucket(state, 'spectre.medicTarget') as Record<string, string>;
}
const isGrenade = (name: string): boolean => name === 'Frag grenade' || name === 'Krak grenade';
function hasShot(state: GameState, id: string): boolean {
  return Boolean((bucket(state, 'spectre.shot') as Record<string, boolean>)[id]);
}
function markShot(state: GameState, id: string): void {
  (bucket(state, 'spectre.shot') as Record<string, boolean>)[id] = true;
}

/** "Terrain features within your territory or within 3" of this operative are scouted." */
function isScouted(T: TeamHooks, state: GameState, at: Vec2): boolean {
  const guide = T.friendlies(state).find((o) => o.datacardId === C.guide);
  if (guide && Math.hypot(guide.pos.x - at.x, guide.pos.y - at.y) <= 3 + EPS) return true;
  const zone = state.setup.dropZone[T.player] ?? T.player;
  for (const poly of state.map.territories[zone] ?? []) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > at.y !== b.y > at.y && at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The Melta Mine marker
// ---------------------------------------------------------------------------

export const MELTA_MARKER = (player: PlayerId): string => `spectre.meltaMine.${player}`;

/** "This operative is carrying your Melta Mine marker." */
function ensureMine(T: TeamHooks, state: GameState): void {
  const made = bucket(state, 'spectre.mineMade');
  if (made[T.player]) return;
  const carrier = T.friendlies(state).find((o) => o.datacardId === C.grenadier);
  if (carrier && !carrier.carryingMarkerId && !state.markers[MELTA_MARKER(T.player)]) {
    state.markers[MELTA_MARKER(T.player)] = {
      id: MELTA_MARKER(T.player),
      kind: 'generic',
      diameterMm: 20,
      pos: { ...carrier.pos },
      z: carrier.z,
      owner: T.player,
      carriedBy: carrier.id,
      flags: {},
    };
    carrier.carryingMarkerId = MELTA_MARKER(T.player);
  }
  if (T.friendlies(state).length > 0) made[T.player] = true;
}

/** Deployment moves an operative without `applyMove`, so a carried marker is re-synced. */
function syncMine(T: TeamHooks, state: GameState): void {
  const marker = state.markers[MELTA_MARKER(T.player)];
  if (!marker?.carriedBy) return;
  const carrier = state.operatives[marker.carriedBy];
  if (!carrier) return;
  marker.pos = { ...carrier.pos };
  marker.z = carrier.z;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- DISAPPEAR (strategy, 1CP) -----------------------------------------
  // "One friendly SPECTRE SQUAD operative can immediately perform a free Reposition action."
  // Its "cannot end that move closer to enemy operatives or your opponent's drop zone" half
  // is reminder-only: nothing in the engine constrains where a move ends.
  reg.on('onPloyUsed', T.bind(SP.disappear, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.disappear) return;
    const op = chosenOperative(
      ev.state,
      ev.data,
      T.friendlies(ev.state, KW).filter((o) => o.datacardId !== C.beacon),
    );
    if (!op) return;
    effect(ev.state, {
      rule: E.disappear,
      source: { kind: 'ploy', id: SP.disappear },
      sourceText: shortQuote(text(SP.disappear)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    grantFreeAction(ev.state, op, {
      sourceId: SP.disappear,
      sourceText: shortQuote(text(SP.disappear)),
      threshold: currentApl(T, ev.state, op),
      only: ['Reposition'],
    });
  });

  // ---- HIDDEN ENGAGEMENT (strategy, 1CP) ---------------------------------
  // "Whenever a friendly SPECTRE SQUAD operative is shooting, if it's in cover from the
  //  target's perspective, that friendly operative's weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP.hiddenEngagement, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.hiddenEngagement)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target || !T.ctx) return;
    const index = terrain(T.ctx, ev.state);
    // "…in cover from the target's perspective": the target is the one drawing the lines.
    if (!coverAndObscured(index, body(T.ctx, ev.target), body(T.ctx, ev.operative)).inCover) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Hidden Engagement)'));
  });

  // ---- AMBUSHING VOLLEY (strategy, 1CP) ----------------------------------
  reg.on('onActivationStart', T.bind(SP.ambushingVolley, 20), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    if (!gambitUsed(ev.state, T.player, SP.ambushingVolley)) return;
    if (T.enemies(ev.state).some((e) => T.gap(op, e) <= 3 + EPS)) return; // "more than 3\" from"
    if (wasValidTargetBeforeOrder(T, ev.state, op)) return;
    effect(ev.state, {
      rule: E.ambush,
      source: { kind: 'ploy', id: SP.ambushingVolley },
      sourceText: shortQuote(text(SP.ambushingVolley)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(SP.ambushingVolley, 21), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!effectOn(ev.state, ev.operative.id, E.ambush)) return;
    // "(excluding the suppressive profile of an autostubber)"
    if (ev.weaponName.toLowerCase() === 'autostubber' && ev.profile.name === 'suppressive') return;
    const existing = ev.rules.find((r) => r.id === 'Devastating');
    if (existing) {
      // "If that weapon already had the Devastating x weapon rule, add 1 to the x instead."
      ev.rules = ev.rules.filter((r) => r !== existing);
      ev.rules.push(ruleTag('Devastating', (existing.x ?? 0) + 1, `Devastating ${(existing.x ?? 0) + 1} (Ambushing Volley)`));
    } else {
      ev.rules.push(ruleTag('Devastating', 1, 'Devastating 1 (Ambushing Volley)'));
    }
  });

  // ---- PATIENCE (strategy, 1CP) ------------------------------------------
  // "In the Firefight phase of this turning point, you can do one of the following: [skip an
  //  activation] … [Relentless for the last friendly operative to be activated]".
  // D-022 policy: the Relentless half is taken, because the skip half needs an intent the
  // engine does not have (there is no way to decline an activation from a strategy ploy).
  reg.on('onWeaponRules', T.bind(SP.patience, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.patience)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (ev.state.activeOperativeId !== ev.operative.id) return;
    // "if it's the last friendly operative to be activated during this turning point"
    if (T.friendlies(ev.state).some((o) => o.id !== ev.operative.id && o.ready)) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Patience)'));
  });

  // ---- DODGE (firefight, 1CP) --------------------------------------------
  // "During that activation, that operative can perform the Fall Back action for 1 less AP."
  reg.on('onPloyUsed', T.bind(FP.dodge, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.dodge) return;
    const op = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!op || op.player !== T.player) return;
    effect(ev.state, {
      rule: E.dodge,
      source: { kind: 'ploy', id: FP.dodge },
      sourceText: shortQuote(text(FP.dodge)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.dodge, 20), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, E.dodge)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- SILENT KILLERS (firefight, 1CP) -----------------------------------
  reg.on('onPloyUsed', T.bind(FP.silentKillers, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.silentKillers) return;
    const op = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!op || op.player !== T.player) return;
    effect(ev.state, {
      rule: E.silentKillers,
      source: { kind: 'ploy', id: FP.silentKillers },
      sourceText: shortQuote(text(FP.silentKillers)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  // "…the first time it strikes you can inflict 3 additional damage, but cannot resolve any
  //  other successes during that sequence."
  // D-022 policy: taken when the 3 extra damage would incapacitate the defender, or when
  // there is nothing else left to resolve (in which case it costs nothing).
  reg.on('onDamage', T.bind(FP.silentKillers, 20), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const strikerId = ev.target.id === seq.defenderId ? seq.attackerId : seq.defenderId;
    const striker = ev.state.operatives[strikerId];
    if (!striker || striker.player !== T.player) return;
    if (!effectOn(ev.state, striker.id, E.silentKillers)) return;
    const spent = bucket(ev.state, 'spectre.silentStrike') as Record<string, string>;
    const stamp = `${seq.attackerId}:${seq.defenderId}:${ev.state.turningPoint}`;
    if (spent[striker.id] === stamp) return; // "the first time it strikes"
    const pool = strikerId === seq.attackerId ? seq.attackerPool : seq.defenderPool;
    const left = pool.dice.filter((d) => d.state === 'crit' || d.state === 'normal').length;
    const kills = ev.target.wounds - (ev.amount + 3) <= 0;
    if (!kills && left > 0) return;
    spent[striker.id] = stamp;
    ev.amount += 3;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Silent Killers: ${striker.letter} inflicts 3 additional damage`,
    });
  });
  reg.on('onStrikeResolved', T.bind(FP.silentKillers, 21), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const striker = ev.ctx.attacker;
    if (striker.player !== T.player || !effectOn(ev.state, striker.id, E.silentKillers)) return;
    const spent = bucket(ev.state, 'spectre.silentStrike') as Record<string, string>;
    if (spent[striker.id] !== `${seq.attackerId}:${seq.defenderId}:${ev.state.turningPoint}`) return;
    const pool = striker.id === seq.attackerId ? seq.attackerPool : seq.defenderPool;
    for (const die of pool.dice) {
      if (die.state !== 'crit' && die.state !== 'normal') continue;
      die.state = 'discarded';
      die.note = 'Silent Killers';
    }
  });

  // ---- SHARP REACTIONS (firefight, 1CP) ----------------------------------
  // "You can use the Elite Fieldcraft faction rule to interrupt that activation with that
  //  friendly SPECTRE SQUAD operative regardless of that enemy operative's order."
  reg.on('onPloyUsed', T.bind(FP.sharpReactions, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.sharpReactions) return;
    const active = ev.state.activeOperativeId;
    effect(ev.state, {
      rule: E.sharpReactions,
      source: { kind: 'ploy', id: FP.sharpReactions },
      sourceText: shortQuote(text(FP.sharpReactions)),
      player: T.player,
      // "…to interrupt THAT activation": the widening lasts only for the activation it is
      // used in (the effect still survives the `onActivationEnd` emit, which is where the
      // interrupt is taken).
      expiry: active ? { kind: 'endOfActivation', operativeId: active } : { kind: 'endOfTurningPoint' },
    });
    const enemy = active ? ev.state.operatives[active] : undefined;
    if (enemy && enemy.player !== T.player) tryInterrupt(T, ev.state, enemy);
  });

  // ---- PREPARED DEFENCE (firefight, 1CP) ---------------------------------
  // "You can do one of the following: [resolve one success before the normal order, which
  //  must block] or [a block can be allocated to block two unresolved successes]."
  // The second is exact on `onBlockAllocation`; the first can reorder the fight but the
  // engine builds the strike/block options, so "must be used to block" is unenforceable.
  // The choice is taken from the ploy's `data.choice` (D-016), defaulting to the exact half.
  reg.on('onPloyUsed', T.bind(FP.preparedDefence, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.preparedDefence) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const mine = seq.defender === T.player ? seq.defenderId : seq.attackerId;
    const choice = ev.data?.['choice'] === 'resolveFirst' ? 'resolveFirst' : 'blockTwo';
    effect(ev.state, {
      rule: E.preparedDefence,
      source: { kind: 'ploy', id: FP.preparedDefence },
      sourceText: shortQuote(text(FP.preparedDefence)),
      operativeId: mine,
      player: T.player,
      data: { choice },
      expiry: { kind: 'endOfTurningPoint' },
    });
    if (choice === 'resolveFirst') seq.turn = seq.defender === T.player ? 'defender' : 'attacker';
  });
  reg.on('onBlockAllocation', T.bind(FP.preparedDefence, 20), (ev) => {
    const blocker = ev.ctx.attacker; // the side resolving the die
    if (blocker.player !== T.player) return;
    const eff = effectOn(ev.state, blocker.id, E.preparedDefence);
    if (!eff || eff.data?.['choice'] !== 'blockTwo') return;
    ev.blocks = Math.max(ev.blocks, 2);
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/**
 * SNIPER OVERWATCH's weapon. The scraper stored the profile but dropped its WR cell
 * (`weapons[0].profiles[0].rules` is `[]`), so the rules are recovered from the printed
 * text's own "WR" row rather than retyped — see the data problems in the report.
 */
export const SNIPER_OVERWATCH_WEAPON: Weapon = (() => {
  const printed = DATA.equipment.find((e) => e.id === EQ.sniperOverwatch)!;
  const scraped = (printed as unknown as { weapons?: Weapon[] }).weapons?.[0];
  const wr = printed.text.split(/\bWR\b/).slice(1).join(' ');
  const profile = scraped?.profiles[0];
  return {
    name: scraped?.name ?? 'Sniper Overwatch',
    profiles: [
      {
        type: 'ranged',
        atk: profile?.atk ?? 4,
        hit: profile?.hit ?? 3,
        dmgN: profile?.dmgN ?? 3,
        dmgC: profile?.dmgC ?? 3,
        rules: parseWeaponRules(wr.replace(/\s+/g, ' ').trim()),
      },
    ],
  };
})();

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- SNIPER OVERWATCH ---------------------------------------------------
  // "Once per turning point, a friendly SPECTRE SQUAD operative can use the following ranged
  //  weapon." The weapon is granted to the whole kill team; the allowance is the gate.
  const arm = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ.sniperOverwatch)) return;
    for (const o of T.friendlies(state, KW).filter((x) => x.datacardId !== C.beacon))
      grantWeapon(o, structuredClone(SNIPER_OVERWATCH_WEAPON));
  };
  reg.on('onDeploy', T.bind(EQ.sniperOverwatch, 30), (ev) => {
    if (ev.operative.player === T.player) arm(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.sniperOverwatch, 30), (ev) => arm(ev.state));
  reg.on('onSelectWeapon', T.bind(EQ.sniperOverwatch, 30), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.weaponName !== SNIPER_OVERWATCH_WEAPON.name) return;
    if (!usedThisTP(ev.state, `spectre.sniperOverwatch:${T.player}`)) return;
    ev.allowed = false;
    ev.reason = 'Sniper Overwatch can only be used once per turning point';
  });
  reg.on('onCollectAttackDice', T.bind(EQ.sniperOverwatch, 31), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.weaponName !== SNIPER_OVERWATCH_WEAPON.name) return;
    if (ev.ctx.secondary) return;
    useOncePerTP(ev.state, `spectre.sniperOverwatch:${T.player}`);
  });

  // ---- TVID-FEED TRIANGULATION -------------------------------------------
  // "Once per turning point, when a friendly SPECTRE SQUAD operative is performing the Shoot
  //  action and you're selecting a valid target, you can use this rule. If you do, that
  //  target cannot be obscured if either of the following are true: [also a valid target for
  //  another friendly SPECTRE SQUAD operative] [within 6" of a friendly VOX-RELAY BEACON]."
  // D-022 policy: used automatically the first time in a turning point that it would change
  // the sequence — the target is obscured and one of the two conditions holds.
  reg.on('onCollectAttackDice', T.bind(EQ.tvidFeed, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.tvidFeed)) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || !seq.obscured || !target || ev.ctx.secondary) return;
    if (usedThisTP(ev.state, `spectre.tvid:${T.player}`)) return;
    const nearBeacon = T.friendlies(ev.state).some(
      (o) => o.datacardId === C.beacon && T.gap(o, target) <= 6 + EPS,
    );
    const spotted =
      nearBeacon ||
      T.friendlies(ev.state, KW).some(
        (o) => o.id !== ev.ctx.attacker.id && o.datacardId !== C.beacon && canSee(T, ev.state, o, target),
      );
    if (!spotted) return;
    useOncePerTP(ev.state, `spectre.tvid:${T.player}`);
    seq.obscured = false;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Tvid-feed Triangulation: ${target.letter} cannot be obscured`,
    });
  });

  // ---- STARSHELL FLARE ----------------------------------------------------
  // "STRATEGIC GAMBIT. One friendly SPECTRE SQUAD operative can immediately perform a free
  //  Stun Grenade action."
  reg.on('gambitOptions', T.bind(EQ.starshellFlare, 30), (ev) => {
    if (ev.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.starshellFlare)) return;
    if (usedThisBattle(ev.state, `spectre.starshell:${T.player}`)) return;
    ev.options.push({
      id: EQ.starshellFlare,
      label: 'STARSHELL FLARE (free Stun Grenade)',
      sourceText: shortQuote(text(EQ.starshellFlare)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.starshellFlare, 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.starshellFlare) return;
    const op = chosenOperative(
      ev.state,
      ev.data,
      T.friendlies(ev.state, KW).filter((o) => o.datacardId !== C.beacon),
    );
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: EQ.starshellFlare,
      sourceText: shortQuote(text(EQ.starshellFlare)),
      kind: 'equipment',
      threshold: currentApl(T, ev.state, op),
      only: [STARSHELL_STUN],
    });
  });

  // ---- ADVANCED CAMOUFLAGE ------------------------------------------------
  // "Until the start of this operative's next activation, while it has a Conceal order and is
  //  in cover, it cannot be selected as a valid target, taking precedence over all other
  //  rules (e.g. Seek, Vantage terrain) except being within 2"."
  reg.on('onValidTarget', T.bind(EQ.advancedCamouflage, 30), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || !T.ctx) return;
    if (!effectOn(ev.state, target.id, E.advCamo)) return;
    if (target.order !== 'conceal') return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2\""
    const index = terrain(T.ctx, ev.state);
    if (!coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'ADVANCED CAMOUFLAGE: it cannot be selected as a valid target';
  });
}

function canSee(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return false;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- ISSUE MISSION 0AP — VETERAN SERGEANT ----------------------------
    uniqueAction(data, C.sergeant, ACT.issueMission, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one expended friendly SPECTRE SQUAD operative' };
        if (target.datacardId === C.beacon) return { ok: false, reason: 'excluding VOX-RELAY BEACON' };
        if (!target.expended) return { ok: false, reason: 'that operative is not expended' };
        if (usedThisTP(state, `spectre.fieldcraftFree:${target.id}`))
          return { ok: false, reason: 'that operative has already interrupted an activation this turning point' };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible to this operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        effect(state, {
          rule: E.issueMission,
          source: { kind: 'ability', id: ACT.issueMission },
          sourceText: shortQuote(actionText(C.sergeant, ACT.issueMission)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: ISSUE MISSION — ${target.letter} can interrupt while expended`,
        });
        return { ok: true };
      },
    }),

    // ---- SIGNAL 1AP — VOX-RELAY BEACON -----------------------------------
    uniqueAction(data, C.beacon, ACT.beaconSignal, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one other friendly SPECTRE SQUAD operative within 6"' };
        if (gapOf(ctx, op, target) > 6 + EPS) return { ok: false, reason: 'that operative is more than 6" away' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => signalPerform(state, op, params.targetOperativeId!, ACT.beaconSignal),
    }),

    // ---- MEDIKIT 0AP — FIELD MEDICAE -------------------------------------
    uniqueAction(data, C.medicae, ACT.medikit, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select a friendly SPECTRE SQUAD operative within control range' };
        if (target.datacardId === C.beacon) return { ok: false, reason: 'excluding VOX-RELAY BEACON' };
        if (gapOf(ctx, op, target) > 1 + EPS)
          return { ok: false, reason: 'that operative is not within this operative’s control range' };
        // "It cannot be an operative that the Medic! rule was used on during this turning point."
        if (medicTargets(state)[op.id] === target.id && usedThisTP(state, `spectre.medic:${op.id}`))
          return { ok: false, reason: 'the Medic! rule was used on that operative during this turning point' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: MEDIKIT restores ${heal} wounds to ${target.letter}`,
        });
        return { ok: true };
      },
    }),

    // ---- LOAD WEAPON 1AP — LOADER ----------------------------------------
    uniqueAction(data, C.loader, ACT.loadWeapon, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "…while counteracting, or during an activation in which it performed the Charge,
        //  Dash or Shoot action (or vice versa)."
        if (state.opState['counteract']?.['operativeId'] === op.id)
          return { ok: false, reason: 'this operative cannot perform this action while counteracting' };
        if (['Charge', SILENT_CHARGE, 'Dash', 'Shoot', FIELDCRAFT_SHOOT].some((a) => did(op, a)))
          return { ok: false, reason: 'it already performed the Charge, Dash or Shoot action this activation' };
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select a friendly SPECTRE SQUAD operative within control range' };
        if (target.datacardId === C.beacon) return { ok: false, reason: 'that operative cannot Shoot' };
        if (gapOf(ctx, op, target) > 1 + EPS)
          return { ok: false, reason: 'that operative is not within this operative’s control range' };
        if (enemiesInControlRange(ctx, state, target).length > 0)
          return { ok: false, reason: 'that operative is within control range of an enemy operative' };
        if (aliveOf(state, otherPlayer(op.player)).some((e) => gapOf(ctx, target, e) <= 3 + EPS))
          return { ok: false, reason: 'that operative is within 3" of an enemy operative' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        target.order = 'engage'; // "you can change its order to do so"
        rememberOrder(state, target);
        grantFreeAction(state, target, {
          sourceId: ACT.loadWeapon,
          sourceText: shortQuote(actionText(C.loader, ACT.loadWeapon)),
          kind: 'ability',
          threshold: aplOf(ctx, state, target),
          only: ['Shoot'], // "(excluding Guard)"
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: LOAD WEAPON — ${target.letter} gains a free Shoot action`,
        });
        return { ok: true };
      },
    }),

    // ---- SIGNAL 1AP — VOX-OPERATOR ---------------------------------------
    // "SUPPORT." carries no distance requirement here (the printed condition is visibility
    // only), so there is nothing for `supportDistance`/a Comms Device to widen.
    uniqueAction(data, C.voxOperator, ACT.voxSignal, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one other friendly SPECTRE SQUAD operative' };
        if (target.datacardId === C.beacon) return { ok: false, reason: 'excluding VOX-RELAY BEACON' };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible to this operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => signalPerform(state, op, params.targetOperativeId!, ACT.voxSignal),
    }),
  ];
}

/** "Until the end of that operative's next activation, add 1 to its APL stat." */
function signalPerform(
  state: GameState,
  op: OperativeState,
  targetId: string,
  sourceId: string,
): { ok: boolean; reason?: string } {
  const target = state.operatives[targetId]!;
  target.aplMods.push(1);
  effect(state, {
    rule: E.signalApl,
    source: { kind: 'ability', id: sourceId },
    operativeId: target.id,
    player: op.player,
    expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
  });
  log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
  return { ok: true };
}

const aliveOf = (state: GameState, player: PlayerId): OperativeState[] =>
  Object.values(state.operatives).filter((o) => !o.removed && o.player === player);

/** Base-to-base distance in inches, for the unique actions (which get a ctx, not a facade). */
const gapOf = (ctx: GameContext, a: OperativeState, b: OperativeState): number => gapBetween(ctx, a, b);

// ---------------------------------------------------------------------------
// Extra actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * Elite Fieldcraft's free Shoot. Its own action id (not `treatedAs: 'Shoot'`) because the
 * printed rule grants an EXTRA Shoot outside the activation's action restrictions — the
 * Kasrkin `Shoot (Rapid Fire)` precedent. It carries three clauses the universal Shoot
 * cannot: the order change, the point-blank shot while engaged with the interrupted enemy,
 * and (through `onValidTarget`) the ban on any other target.
 */
registerAction({
  id: FIELDCRAFT_SHOOT,
  name: FIELDCRAFT_SHOOT,
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === RULE.eliteFieldcraft)!.text,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    const eff = effectOn(state, op.id, E.interrupt);
    if (!eff) return { ok: false, reason: 'this operative has not interrupted an activation' };
    const enemyId = String(eff.data?.['enemyId'] ?? '');
    if (params.targetId && params.targetId !== enemyId)
      return { ok: false, reason: 'only the interrupted enemy operative can be selected' };
    const foes = enemiesInControlRange(ctx, state, op);
    // "Being within that enemy operative's control range (but no others) doesn't prevent that
    //  friendly operative from performing that action."
    if (foes.length > 0 && (foes.length > 1 || foes[0]!.id !== enemyId))
      return { ok: false, reason: 'within control range of another enemy operative' };
    if (foes.length === 1) {
      // The universal Shoot's own check would refuse this shot outright, so its remaining
      // clauses are applied here (D-026: whatever `check` accepts, `perform` must complete).
      if (!params.weaponName || !params.targetId) return { ok: false, reason: 'weapon and target required' };
      const weapon = weaponsOf(ctx, state, op, 'ranged').find((w) => w.name === params.weaponName);
      const profile = weapon ? findProfile(weapon, params.profileName) : undefined;
      if (!weapon || !profile) return { ok: false, reason: `no ranged weapon '${params.weaponName}'` };
      const heavy = profile.rules.find((r) => r.id === 'Heavy');
      if (heavy && op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a)))
        return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which the operative moved` };
      const target = state.operatives[params.targetId];
      if (!target || target.removed) return { ok: false, reason: 'no such target' };
      const rules = effectiveRules(ctx, state, profile, { operative: op, target, weaponName: weapon.name });
      const chk = checkTarget(ctx, state, op, target, profile, rules, { pointBlank: true });
      return chk.valid ? { ok: true } : { ok: false, reason: chk.reason ?? 'not a valid target' };
    }
    const order = op.order;
    op.order = 'engage'; // "you can change that friendly operative's order to perform this action"
    try {
      return getAction('Shoot')!.check(ctx, state, op, params);
    } finally {
      op.order = order;
    }
  },
  perform(ctx, state, op, params) {
    if (op.order === 'conceal') {
      op.order = 'engage';
      rememberOrder(state, op);
      log(state, { kind: 'action', player: op.player, text: `${op.letter} changes its order to Engage (Elite Fieldcraft)` });
    }
    const pointBlank = enemiesInControlRange(ctx, state, op).length > 0;
    if (!pointBlank) return getAction('Shoot')!.perform(ctx, state, op, params);
    // "…follow the rules for a point-blank shot from the Guard action."
    const r = startShoot(ctx, state, op, params.weaponName!, params.profileName, params.targetId!, {
      pointBlank: true,
    });
    if (!r.ok) return r;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

/** SILENT KILLERS: "it can perform the Charge action while it has a Conceal order". */
registerAction({
  id: SILENT_CHARGE,
  name: SILENT_CHARGE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: DATA.firefightPloys.find((p) => p.id === FP.silentKillers)!.text,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === E.silentKillers && e.operativeId === op.id))
      return { ok: false, reason: 'Silent Killers has not been used on this operative' };
    const order = op.order;
    op.order = 'engage';
    try {
      return getAction('Charge')!.check(ctx, state, op, params);
    } finally {
      op.order = order;
    }
  },
  perform(ctx, state, op, params) {
    return getAction('Charge')!.perform(ctx, state, op, params);
  },
});

/**
 * STARSHELL FLARE's free Stun Grenade. The universal action is gated on the Utility Grenades
 * equipment and its two-use budget; "performing this action using this rule doesn't count
 * towards its action limits", so the budget is restored afterwards (the Kommandos Taktical
 * Wot-notz precedent).
 */
registerAction({
  id: STARSHELL_STUN,
  name: STARSHELL_STUN,
  ap: 1,
  type: 'unique',
  sourceText: DATA.equipment.find((e) => e.id === EQ.starshellFlare)!.text,
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes(EQ.starshellFlare) &&
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative' };
    if (gapOf(ctx, op, target) > 6 + EPS) return { ok: false, reason: 'that operative is more than 6" away' };
    if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
      return { ok: false, reason: 'that operative is not visible' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const before = { ...state.teams[op.player].equipmentUses };
    const aplBefore = new Map(
      Object.values(state.operatives)
        .filter((o) => o.player !== op.player)
        .map((o) => [o.id, o.aplMods.length] as const),
    );
    const res = getAction('Stun Grenade')!.perform(ctx, state, op, params);
    state.teams[op.player].equipmentUses = before;
    if (!res.ok) return res;
    // "When an enemy operative's APL stat is changed as a result of this STRATEGIC GAMBIT,
    //  you cannot use this equipment for the rest of the battle."
    const changed = [...aplBefore].some(
      ([id, n]) => (state.operatives[id]?.aplMods.length ?? n) > n,
    );
    if (changed) useOncePerBattle(state, `spectre.starshell:${op.player}`);
    return res;
  },
});

/** ADVANCED CAMOUFLAGE — the equipment's own unique action (unstructured in the JSON). */
const ADV_CAMO_AP = Number(/ADVANCED CAMOUFLAGE\s*(\d)\s*AP/i.exec(text(EQ.advancedCamouflage))?.[1] ?? 1);

registerAction({
  id: ADVANCED_CAMOUFLAGE_ACTION,
  name: ADVANCED_CAMOUFLAGE_ACTION,
  ap: ADV_CAMO_AP,
  type: 'unique',
  sourceText: text(EQ.advancedCamouflage),
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes(EQ.advancedCamouflage) &&
    op.datacardId !== C.beacon && // "(excluding VOX-RELAY BEACON)"
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op) {
    // "This operative cannot perform this action while visible to and within 3" of an enemy."
    const index = terrain(ctx, state);
    const seen = aliveOf(state, otherPlayer(op.player)).some(
      (e) => gapOf(ctx, op, e) <= 3 + EPS && isVisible(index, body(ctx, e), body(ctx, op)).visible,
    );
    if (seen) return { ok: false, reason: 'visible to and within 3" of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    dropEffects(state, (e) => e.rule === E.advCamo && e.operativeId === op.id);
    effect(state, {
      rule: E.advCamo,
      source: { kind: 'equipment', id: EQ.advancedCamouflage },
      sourceText: shortQuote(text(EQ.advancedCamouflage)),
      operativeId: op.id,
      player: op.player,
      // "Until the start of this operative's next activation."
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
    log(state, { kind: 'action', player: op.player, text: `${op.letter}: ADVANCED CAMOUFLAGE` });
    return { ok: true };
  },
});

/** The Melta Mine's own Pick Up / Place actions. */
registerAction({
  id: MINE_PICK_UP,
  name: MINE_PICK_UP,
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: abilityText(C.grenadier, A.meltaMine),
  available: (_ctx, _state, op) => op.datacardId === C.grenadier,
  check(ctx, state, op) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = state.markers[MELTA_MARKER(op.player)];
    if (!marker) return { ok: false, reason: 'that marker is not in the killzone' };
    if (marker.carriedBy) return { ok: false, reason: 'that marker is already being carried' };
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'that marker is not within this operative’s control range' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    const marker = state.markers[MELTA_MARKER(op.player)]!;
    marker.carriedBy = op.id;
    marker.pos = { ...op.pos };
    marker.z = op.z;
    op.carryingMarkerId = marker.id;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up the Melta Mine marker` });
    return { ok: true };
  },
});

registerAction({
  id: MINE_PLACE,
  name: MINE_PLACE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Place Marker',
  sourceText: abilityText(C.grenadier, A.meltaMine),
  available: (_ctx, _state, op) => op.datacardId === C.grenadier,
  check(ctx, state, op, params) {
    if (op.carryingMarkerId !== MELTA_MARKER(op.player)) return { ok: false, reason: 'not carrying that marker' };
    if (did(op, 'Pick Up Marker') && !op.incapacitated)
      return { ok: false, reason: 'already performed Pick Up Marker this activation' };
    return minePlacement(ctx, state, op, params.markerPos);
  },
  perform(ctx, state, op, params) {
    const pos = minePlacement(ctx, state, op, params.markerPos);
    if (!pos.ok) return pos;
    const marker = state.markers[op.carryingMarkerId!]!;
    marker.carriedBy = undefined;
    marker.pos = { ...pos.pos! };
    marker.z = op.z;
    op.carryingMarkerId = undefined;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} places the Melta Mine marker` });
    // "whenever it performs the Place Marker action on that marker, it can immediately
    //  perform a free Dash action"
    grantFreeAction(state, op, {
      sourceId: MINE_PLACE,
      sourceText: shortQuote(abilityText(C.grenadier, A.meltaMine)),
      kind: 'ability',
      threshold: aplOf(ctx, state, op),
      only: ['Dash'],
    });
    return { ok: true };
  },
});

/** "That marker cannot be placed within an enemy operative's control range." */
function minePlacement(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  requested: Vec2 | undefined,
): { ok: boolean; reason?: string; pos?: Vec2 } {
  const pos = requested ?? { ...op.pos };
  const probe: MarkerState = { id: 'probe', kind: 'generic', diameterMm: 20, pos, z: op.z, flags: {} };
  if (!markerContestedBy(ctx, state, probe, op))
    return { ok: false, reason: 'the marker must be placed within control range' };
  const foe = otherPlayer(op.player);
  if (aliveOf(state, foe).some((e) => markerContestedBy(ctx, state, probe, e)))
    return { ok: false, reason: 'that marker cannot be placed within an enemy operative’s control range' };
  return { ok: true, pos };
}

// ---------------------------------------------------------------------------

export const spectreSquad = defineTeam({
  id: 'spectre-squad',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during a friendly SPECTRE SQUAD operative's activation."
    [FP.dodge]: (state, player) => activeIsMine(state, player),
    // "…if it has a Conceal order and isn't a valid target for enemy operatives."
    [FP.silentKillers]: (state, player) => {
      const base = activeIsMine(state, player);
      if (!base.ok) return base;
      const op = state.operatives[state.activeOperativeId!]!;
      if (op.order !== 'conceal') return { ok: false, reason: 'that operative does not have a Conceal order' };
      return { ok: true };
    },
    // "Use this firefight ploy after an enemy operative that has a Conceal order performs an
    //  action during its activation, if it's within 8" of a friendly SPECTRE SQUAD operative."
    [FP.sharpReactions]: (state, player) => {
      const enemy = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!enemy || enemy.player === player) return { ok: false, reason: 'no enemy operative is activating' };
      if (enemy.order !== 'conceal') return { ok: false, reason: 'that operative does not have a Conceal order' };
      // "…if it's within 8\" of a friendly SPECTRE SQUAD operative." `usable` gets no
      // GameContext, so this is a permissive centre-to-centre pre-filter; `tryInterrupt`
      // applies the exact base-to-base test.
      const near = Object.values(state.operatives).some(
        (o) => !o.removed && o.player === player && Math.hypot(o.pos.x - enemy.pos.x, o.pos.y - enemy.pos.y) <= 9.2,
      );
      if (!near) return { ok: false, reason: 'no friendly SPECTRE SQUAD operative within 8"' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly SPECTRE SQUAD operative that has a Conceal
    //  order or is ready is retaliating."
    [FP.preparedDefence]: (state, player) => {
      const seq = state.sequence?.kind === 'fight' ? state.sequence : undefined;
      if (!seq) return { ok: false, reason: 'no fight is in progress' };
      const mine = seq.defender === player ? state.operatives[seq.defenderId] : undefined;
      if (!mine) return { ok: false, reason: 'none of your operatives is retaliating' };
      if (mine.order !== 'conceal' && !mine.ready)
        return { ok: false, reason: 'that operative is neither on a Conceal order nor ready' };
      // "You cannot use this ploy during an activation in which you've interrupted with the
      //  Elite Fieldcraft faction rule."
      if (state.effects.some((e) => e.rule === E.interrupt && e.player === player))
        return { ok: false, reason: 'you have interrupted with Elite Fieldcraft during this activation' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.sergeant]: 'leader',
      [C.beacon]: 'support',
      [C.medicae]: 'support',
      [C.grenadier]: 'objective',
      [C.guide]: 'scout',
      [C.gunner]: 'gunner',
      [C.heavyGunner]: 'gunner',
      [C.loader]: 'support',
      [C.sharpshooter]: 'sniper',
      [C.stubGunner]: 'gunner',
      [C.trooper]: 'objective',
      [C.voxOperator]: 'support',
    },
    ployValue: {
      [SP.disappear]: 0.4,
      [SP.hiddenEngagement]: 0.6,
      [SP.ambushingVolley]: 0.6,
      [SP.patience]: 0.4,
      [FP.dodge]: 0.4,
      [FP.silentKillers]: 0.6,
      [FP.sharpReactions]: 0.5,
      [FP.preparedDefence]: 0.5,
    },
    equipmentValue: {
      [EQ.sniperOverwatch]: 0.7,
      [EQ.tvidFeed]: 0.5,
      [EQ.starshellFlare]: 0.4,
      [EQ.advancedCamouflage]: 0.6,
    },
  },
});

function activeIsMine(state: GameState, player: PlayerId): { ok: boolean; reason?: string } {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!op || op.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
  return { ok: true };
}

export default spectreSquad;
