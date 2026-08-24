/**
 * CORSAIR VOIDSCARRED — Aeldari outcasts.
 * https://wahapedia.ru/kill-team3/kill-teams/corsair-voidscarred/
 *
 * Eleven datacards, two faction rules, eleven abilities and five unique actions. Every hook
 * carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read out of
 * `data/teams/corsair-voidscarred.json` at module load and never retyped.
 *
 * Three shapes drive the module:
 *
 *  - **Aeldari Raiders** hands EVERY operative a free Dash on EVERY activation. That grant is AP
 *    outside the APL budget (docs/DECISIONS.md D-100) and expires with the activation it was
 *    given for. Four rules here hand one out, so the module keeps exactly ONE grant live per
 *    operative at a time: free actions from different rules are not cumulative.
 *  - **Two interrupts** (the FELARCH's One Step Ahead and the KURNITE HUNTER's Erudite Hunter)
 *    fire "after an enemy operative performs an action". The engine emits no post-action hook,
 *    so both are taken at the last moment it does expose — the enemy's `onActivationEnd` — and
 *    the free action lands on the interrupting operative's own next activation (D-013; the
 *    Spectre Squad Elite Fieldcraft precedent).
 *  - **The SHADE RUNNER's Blink Pack** is a remove-and-set-up-again move, which `validateMove`
 *    cannot express, so it is three sibling `ActionDef`s with `treatedAs` pointing at the
 *    universal move actions (D-021; the Sanctifiers CHERUB Fly precedent).
 */
import { actionCost, getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { hasRule, ruleOf } from '../../core/dice.ts';
import { baseGap, baseRadius, dist, distancePointToSegment } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { advanceShoot, checkTarget, effectiveRules, startShoot } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  findProfile,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  moveOf,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, surfaceAt, wallRouteDistance } from '../../core/terrain.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { isVisible, withinControlRange, type Body } from '../../core/visibility.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  aplOf,
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  effectsOn,
  gambitUsed,
  grantFreeAction,
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

const DATA = teamData('corsair-voidscarred');
export const KW = 'CORSAIR VOIDSCARRED';
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
  felarch: 'corsair-voidscarred.voidscarred-felarch',
  fateDealer: 'corsair-voidscarred.voidscarred-fate-dealer',
  gunner: 'corsair-voidscarred.voidscarred-gunner',
  heavyGunner: 'corsair-voidscarred.voidscarred-heavy-gunner',
  kurnathi: 'corsair-voidscarred.voidscarred-kurnathi',
  kurniteHunter: 'corsair-voidscarred.voidscarred-kurnite-hunter',
  shadeRunner: 'corsair-voidscarred.voidscarred-shade-runner',
  soulWeaver: 'corsair-voidscarred.voidscarred-soul-weaver',
  starstormDuellist: 'corsair-voidscarred.voidscarred-starstorm-duellist',
  warrior: 'corsair-voidscarred.voidscarred-warrior',
  waySeeker: 'corsair-voidscarred.voidscarred-way-seeker',
} as const;

export const RULE = {
  rifles: 'corsair-voidscarred.rule.rifles',
  aeldariRaiders: 'corsair-voidscarred.rule.aeldari-raiders',
} as const;

export const SP = {
  plunderers: 'corsair-voidscarred.sp.plunderers',
  piraticalProfiteers: 'corsair-voidscarred.sp.piratical-profiteers',
  mobileEngagement: 'corsair-voidscarred.sp.mobile-engagement',
  outcasts: 'corsair-voidscarred.sp.outcasts',
} as const;

export const FP = {
  opportunisticFighters: 'corsair-voidscarred.fp.opportunistic-fighters',
  lightFingers: 'corsair-voidscarred.fp.light-fingers',
  capriciousFlight: 'corsair-voidscarred.fp.capricious-flight',
  contemptuousAdventurer: 'corsair-voidscarred.fp.contemptuous-adventurer',
} as const;

export const EQ = {
  diuturnalMantles: 'corsair-voidscarred.eq.diuturnal-mantles',
  mistfield: 'corsair-voidscarred.eq.mistfield',
  runesOfGuidance: 'corsair-voidscarred.eq.runes-of-guidance',
  starCharts: 'corsair-voidscarred.eq.star-charts',
} as const;

export const A = {
  veteranRaider: `${C.felarch}.veteran-raider`,
  oneStepAhead: `${C.felarch}.one-step-ahead`,
  camoCloak: `${C.fateDealer}.camo-cloak`,
  blademaster: `${C.kurnathi}.blademaster`,
  bladedStance: `${C.kurnathi}.bladed-stance`,
  // The scraper's id for "Faolchú's Bond" — the accented letter is dropped from the slug.
  faolchusBond: `${C.kurniteHunter}.faolch-s-bond`,
  eruditeHunter: `${C.kurniteHunter}.erudite-hunter`,
  blinkPack: `${C.shadeRunner}.blink-pack`,
  slicingAttack: `${C.shadeRunner}.slicing-attack`,
  quickOnTheTrigger: `${C.starstormDuellist}.quick-on-the-trigger`,
  prowlingRaiders: `${C.warrior}.prowling-raiders`,
} as const;

export const ACT = {
  soulChannel: `${C.soulWeaver}.act.soul-channel`,
  soulHeal: `${C.soulWeaver}.act.soul-heal`,
  pistolBarrage: `${C.starstormDuellist}.act.pistol-barrage`,
  warpFold: `${C.waySeeker}.act.warp-fold`,
  wardingShield: `${C.waySeeker}.act.warding-shield`,
} as const;

/** Extra `ActionDef`s that carry what a universal action forbids (docs/DECISIONS.md D-021). */
export const PISTOL_BARRAGE_2 = `${ACT.pistolBarrage}.2`;
export const DASH_BLADEMASTER = 'Dash (Blademaster)';
export const BLINK_REPOSITION = 'Reposition (Blink Pack)';
export const BLINK_FALL_BACK = 'Fall Back (Blink Pack)';
export const BLINK_CHARGE = 'Charge (Blink Pack)';
export const SHOOT_QUICK_TRIGGER = 'Shoot (Quick on the Trigger)';
export const PICK_UP_LIGHT_FINGERS = 'Pick Up Marker (Light Fingers)';

/** Effect / scratch keys — all namespaced, never module-level state (architecture rule 7). */
const E_PLUNDERED = 'cv.plundered';
const E_CAPRICIOUS = 'cv.capriciousFlight';
const E_LIGHT_FINGERS = 'cv.lightFingers';
const E_CONTEMPTUOUS = 'cv.contemptuous';
const E_ONE_STEP = 'cv.oneStepAhead';
const E_ONE_STEP_APL = 'cv.oneStepAheadApl';
const E_ERUDITE_MARK = 'cv.eruditeMark';
const E_ERUDITE_FREE = 'cv.eruditeFree';
const E_SOUL_CHANNEL = 'cv.soulChannel';
const E_WARDING_SHIELD = 'cv.wardingShield';
const E_WARP_FOLD_LOCK = 'cv.warpFoldLock';
const E_QUICK_TRIGGER = 'cv.quickTrigger';

/** Every rule of this team that hands out a `grantFreeAction`, for the stale-grant sweep. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([
  RULE.aeldariRaiders,
  SP.plunderers,
  A.oneStepAhead,
  A.eruditeHunter,
]);

/** The move actions "an action in which it moved" covers; `treatedAs` folds the variants in. */
const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];
/** "the Charge, Fall Back or Reposition action" (Rifles, WARP FOLD, Blink Pack). */
const BIG_MOVES = ['Charge', 'Fall Back', 'Reposition'];

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

function d3(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d3() ?? 2;
  recordRoll(state, 'corsair-voidscarred', [roll], T.player, note);
  return roll;
}

function d6(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, 'corsair-voidscarred', [roll], T.player, note);
  return roll;
}

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
 * Which turning point this operative last activated in. `onActivationStart` writes it, which is
 * what lets "performed an action in which it moved during this turning point" read
 * `actionsThisActivation` without leaking across turning points (the array is only cleared when
 * the operative activates again).
 */
const activationTP = (state: GameState, op: OperativeState): number =>
  Number(bucket(state, 'cv.activatedTP')[op.id] ?? -1);

const did = (op: OperativeState, actions: string[]): boolean =>
  op.actionsThisActivation.some((a) => actions.includes(a));

/** "…performed an action in which it moved during this turning point" (MOBILE ENGAGEMENT). */
export function movedThisTP(state: GameState, op: OperativeState): boolean {
  return activationTP(state, op) === state.turningPoint && did(op, MOVE_ACTIONS);
}

/** "…performed the Charge, Fall Back or Reposition action during this turning point" (WARP FOLD). */
function bigMovedThisTP(state: GameState, op: OperativeState): boolean {
  return activationTP(state, op) === state.turningPoint && did(op, BIG_MOVES);
}

/** "…contests an objective marker or one of your mission markers" (PIRATICAL PROFITEERS). */
function contestsScoringMarker(T: TeamHooks, state: GameState, op: OperativeState, player: PlayerId): boolean {
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'objective' && marker.owner !== player) continue;
    const contested = T.ctx ? markerContestedBy(T.ctx, state, marker, op) : T.markerGap(op, marker) <= 1 + EPS;
    if (contested) return true;
  }
  return false;
}

/** "…is more than 5" from other friendly operatives" (OUTCASTS, CONTEMPTUOUS ADVENTURER). */
export function isolatedFrom(T: TeamHooks, state: GameState, op: OperativeState, inches = 5): boolean {
  return T.friendlies(state).every((o) => o.id === op.id || T.gap(op, o) > inches + EPS);
}

/**
 * RUNES OF GUIDANCE: "Once per turning point, when a friendly … WAY SEEKER or … SOUL WEAVER
 * operative is performing a PSYCHIC unique action (excluding Warp Fold), you can use this rule.
 * If you do, until the end of that action, add 3" to its distance requirement."
 *
 * A pure query — the once-per-turning-point allowance is only CLAIMED in `perform`, and only
 * when the selected operative is actually beyond the printed distance, so a `check` never
 * mutates and the rule is never spent on a target it was not needed for.
 */
export function psychicRange(state: GameState, player: PlayerId, base: number): number {
  const armed = hasEquipment(state, player, EQ.runesOfGuidance) && !usedThisTP(state, runesKey(player));
  return armed ? base + 3 : base;
}

const runesKey = (player: PlayerId): string => `cv.runes:${player}`;

/** Claim the RUNES OF GUIDANCE use, but only if the printed distance was not enough. */
function claimRunes(state: GameState, op: OperativeState, target: OperativeState, base: number, gap: number): void {
  if (gap <= base + EPS) return;
  if (!useOncePerTP(state, runesKey(op.player))) return;
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `RUNES OF GUIDANCE: +3" for ${op.letter} → ${target.letter} (${gap.toFixed(1)}")`,
  });
}

interface AttackDie {
  dmg: number;
  crit: boolean;
}

/**
 * The attack dice behind one `onDamage` event, so a per-dice rule ("the first time an attack
 * dice inflicts Normal Dmg") applies per dice rather than once to the lump a Shoot action
 * inflicts (the Elucidian Starstrider precedent).
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

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Bookkeeping every rule below reads
  // =========================================================================
  reg.on('onActivationStart', T.bindText('cv.activationLedger', text(RULE.aeldariRaiders), 1), (ev) => {
    bucket(ev.state, 'cv.activatedTP')[ev.operative.id] = ev.state.turningPoint;
    if (!T.mineKw(ev.operative, KW)) return;
    const b = bucket(ev.state, 'cv.cvActivations');
    const key = `${T.player}:${ev.state.turningPoint}`;
    b[key] = Number(b[key] ?? 0) + 1;
  });

  // =========================================================================
  // Rifles
  // =========================================================================
  // "Whenever a friendly CORSAIR VOIDSCARRED operative is shooting with a shuriken rifle or
  //  ranger long rifle during an activation in which it hasn't performed the Charge, Fall Back
  //  or Reposition action, that weapon has the Accurate 1 weapon rule."
  reg.on('onWeaponRules', T.bind(RULE.rifles, 10), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!RIFLES.has(ev.weaponName.trim().toLowerCase())) return;
    if (did(op, BIG_MOVES)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Rifles)'));
  });

  // =========================================================================
  // Aeldari Raiders
  // =========================================================================
  // "Each friendly CORSAIR VOIDSCARRED operative can perform a free Dash action during their
  //  activation." — one AP outside the operative's APL budget, restricted to Dash (D-100).
  reg.on('onActivationStart', T.bind(RULE.aeldariRaiders, 10), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    // One live grant per operative. PLUNDERERS (and the two interrupts) may already have handed
    // this one a free action: free AP sums, so a second grant would be a second AP — and only
    // the FIRST grant's `only` list is read when the engine polices what that AP may be spent
    // on, which would let the extra AP through unrestricted.
    if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) return;
    // FELARCH › Veteran Raider: "This operative can perform a 1AP action for free during their
    // activation as a result of the Aeldari Raiders rule (instead of the Dash action)."
    const veteran = op.datacardId === C.felarch;
    grantFreeAction(ev.state, op, {
      sourceId: RULE.aeldariRaiders,
      sourceText: shortQuote(text(RULE.aeldariRaiders)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, op),
      ...(veteran ? {} : { only: ['Dash', DASH_BLADEMASTER] }),
    });
  });

  // Veteran Raider's "1AP action" cap: the free AP may not be spent on a 2AP action.
  reg.on('canPerformAction', T.bind(A.veteranRaider, 11), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.felarch) return;
    const eff = effectOn(ev.state, op.id, FREE_ACTION_RULE);
    if (!eff || eff.source.id !== RULE.aeldariRaiders) return;
    const def = getAction(ev.action);
    if (!def) return;
    const cost = T.ctx ? actionCost(T.ctx, ev.state, op, def) : def.ap;
    if (op.apSpent + cost <= Number(eff.data?.['threshold'] ?? 0)) return; // still its own AP
    if (cost <= 1) return;
    ev.allowed = false;
    ev.reason = 'Veteran Raider: the free action must be a 1AP action';
  });

  /*
   * A grant expires at the end of the recipient's activation (D-100), which covers Aeldari
   * Raiders — given at the start of the very activation it is for. The other three do not
   * always land on the operative that is activating: PLUNDERERS hands out D3 of them as a
   * STRATEGIC GAMBIT, and both interrupts fire during the ENEMY's activation. If such a
   * recipient is already expended its own activation never ends again, so nothing takes the
   * grant back and it would still be waiting at the next Ready step. This sweep is that bound,
   * and it is what keeps the one-grant-at-a-time guard above from being poisoned by a stale
   * grant nobody spent.
   */
  const dropStaleGrants = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bindText('cv.freeActionSweep', text(RULE.aeldariRaiders), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropStaleGrants(ev.state, o);
  });

  // =========================================================================
  // FELARCH › One Step Ahead
  // =========================================================================
  // "Once per battle, after an enemy operative performs an action, if this operative is ready,
  //  you can use this rule." The engine emits nothing after an action, so the interrupt is
  //  taken at the enemy's `onActivationEnd` (the Spectre Squad Elite Fieldcraft precedent) and
  //  the free Shoot/Fight is one AP outside the FELARCH's APL budget, on its own next
  //  activation (D-013, D-100).
  //
  //  It costs the FELARCH 1 APL, so it is auto-used on a stated deterministic policy (D-022):
  //  at the first enemy activation that ends with a ready FELARCH able to shoot or fight THAT
  //  enemy — the only operative the rule then lets it select.
  reg.on('onActivationEnd', T.bind(A.oneStepAhead, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || foe.removed || foe.incapacitated) return;
    if (usedThisBattle(ev.state, `cv.oneStepAhead:${T.player}`)) return;
    const felarch = T.friendlies(ev.state)
      .filter((o) => o.datacardId === C.felarch && o.ready && !o.incapacitated)
      .sort(byId)[0];
    if (!felarch) return;
    if (!oneStepWorthwhile(T, ev.state, felarch, foe)) return;
    useOncePerBattle(ev.state, `cv.oneStepAhead:${T.player}`);
    const roll = d6(T, ev.state, 'One Step Ahead D6');
    const apl = foeApl(T, ev.state, foe);
    if (roll <= apl) {
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `One Step Ahead: ${roll} is not higher than ${foe.letter}'s APL ${apl}`,
      });
      return;
    }
    effect(ev.state, {
      rule: E_ONE_STEP,
      source: { kind: 'ability', id: A.oneStepAhead },
      sourceText: shortQuote(abilityText(C.felarch, A.oneStepAhead)),
      operativeId: felarch.id,
      player: T.player,
      data: { enemyId: foe.id },
      expiry: { kind: 'endOfActivation', operativeId: felarch.id },
    });
    grantFreeAction(ev.state, felarch, {
      sourceId: A.oneStepAhead,
      sourceText: shortQuote(abilityText(C.felarch, A.oneStepAhead)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, felarch),
      only: ['Shoot', 'Fight', SHOOT_QUICK_TRIGGER],
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `One Step Ahead: ${felarch.letter} interrupts ${foe.letter} (${roll} > APL ${apl})`,
      data: { operativeId: felarch.id, enemyId: foe.id },
    });
  });

  // "…you cannot select any other enemy operative as a valid target … during that action."
  // (Blast secondaries are queued without re-running `checkTarget`, so the printed carve-out
  //  for them holds by construction.) The "or to fight against" half has no seam — `Fight`
  //  takes its target straight from the intent and nothing is emitted before `startFight`.
  reg.on('onValidTarget', T.bind(A.oneStepAhead, 12), (ev) => {
    if (ev.attacker.player !== T.player) return;
    const lock = spendingOneStep(ev.state, ev.attacker);
    if (!lock || ev.target.id === lock) return;
    ev.valid = false;
    ev.reason = 'One Step Ahead: only the interrupted enemy operative can be selected';
  });

  // "After you perform that action, subtract 1 from this operative's APL stat until the end of
  //  its next activation." The free action lands on the FELARCH's own next activation (D-013),
  //  so the penalty is armed at the END of that activation and expires one activation later —
  //  applied any earlier it would eat into the very activation the rule just paid for.
  reg.on('onActivationEnd', T.bind(A.oneStepAhead, 13), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !effectOn(ev.state, op.id, E_ONE_STEP)) return;
    if (!did(op, SHOOT_OR_FIGHT)) return;
    effect(ev.state, {
      rule: E_ONE_STEP_APL,
      source: { kind: 'ability', id: A.oneStepAhead },
      sourceText: shortQuote(abilityText(C.felarch, A.oneStepAhead)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `One Step Ahead: ${op.letter} is at −1 APL` });
  });
  reg.on('onStatMod', T.bind(A.oneStepAhead, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, E_ONE_STEP_APL)) return;
    ev.mods.apl -= 1;
  });

  // =========================================================================
  // FATE DEALER › Camo Cloak
  // =========================================================================
  // "Whenever an operative is shooting this operative: Ignore the Saturate weapon rule. If you
  //  can retain any cover saves, you can retain one additional cover save, or you can retain
  //  one cover save as a critical success instead. This isn't cumulative with improved cover
  //  saves from Vantage terrain."
  reg.on('onDefenceDice', T.bind(A.camoCloak, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== C.fateDealer) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id) return;
    if (seq.inCover) ev.coverSave = true; // "Ignore the Saturate weapon rule."
    if (!ev.coverSave) return;
    if (seq.vantageImprovedCover) return; // "isn't cumulative with improved cover saves from Vantage"
    // The two halves are exclusive ("or"); the additional cover save is the deterministic
    // choice — a second retained normal is never worse than promoting one to a critical.
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // =========================================================================
  // KURNATHI › Blademaster
  // =========================================================================
  // The Dash itself is `Dash (Blademaster)` below (D-021 — the universal Dash refuses an
  // activation in which the operative Charged). This caps its distance: "…can only use any
  // remaining move distance it had from that Charge action (to a maximum of 3")."
  reg.on('onMoveDistance', T.bind(A.blademaster, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.kurnathi) return;
    if (ev.action !== 'Dash' || !op.actionsThisActivation.includes('Charge')) return;
    ev.inches = Math.max(0, Math.min(ev.inches, blademasterRemaining(T, ev.state, op)));
  });

  // =========================================================================
  // KURNATHI › Bladed Stance
  // =========================================================================
  // "Whenever this operative is fighting or retaliating, you can resolve one of your successes
  //  before the normal order." A retaliating operative resolves second by default; the attacker
  //  already resolves first, so only the retaliating half changes anything. The second sentence
  //  ("that success must be used to block") is unenforceable — the engine builds the
  //  strike/block options itself.
  reg.on('onCollectAttackDice', T.bind(A.bladedStance, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.kurnathi) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return;
    seq.turn = 'defender';
  });

  // =========================================================================
  // KURNITE HUNTER › Faolchú's Bond
  // =========================================================================
  // "The first time during each turning point that this operative is retaliating, if it's
  //  ready, in the Resolve Attack Dice step of that sequence, you resolve the first attack dice
  //  (i.e. defender instead of attacker)." The defender's dice are collected in the same step,
  //  so the turn is flipped as its pool is built (the Exaction Squad Repress precedent).
  reg.on('onCollectAttackDice', T.bind(A.faolchusBond, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.kurniteHunter || !op.ready) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return;
    if (!useOncePerTP(ev.state, `cv.faolchu:${op.id}`)) return;
    seq.turn = 'defender';
    log(ev.state, { kind: 'dice', player: T.player, text: `Faolchú's Bond: ${op.letter} resolves the first attack dice` });
  });

  // =========================================================================
  // KURNITE HUNTER › Erudite Hunter (STRATEGIC GAMBIT)
  // =========================================================================
  reg.on('gambitOptions', T.bind(A.eruditeHunter, 20), (ev) => {
    if (ev.player !== T.player) return;
    if (effectFor(ev.state, T.player, E_ERUDITE_MARK)) return;
    if (eruditeCandidates(T, ev.state).length === 0) return;
    ev.options.push({
      id: A.eruditeHunter,
      label: 'ERUDITE HUNTER',
      sourceText: shortQuote(abilityText(C.kurniteHunter, A.eruditeHunter)),
    });
  });
  reg.on('onPloyUsed', T.bind(A.eruditeHunter, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== A.eruditeHunter) return;
    const pairs = eruditeCandidates(T, ev.state);
    const wantedFoe = ev.data?.['targetOperativeId'];
    const pair = pairs.find((p) => p.foe.id === wantedFoe) ?? pairs[0];
    if (!pair) return;
    effect(ev.state, {
      rule: E_ERUDITE_MARK,
      source: { kind: 'ability', id: A.eruditeHunter },
      sourceText: shortQuote(abilityText(C.kurniteHunter, A.eruditeHunter)),
      player: T.player,
      data: { hunterId: pair.hunter.id, enemyId: pair.foe.id },
      expiry: { kind: 'endOfTurningPoint' }, // "Once during this turning point"
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `ERUDITE HUNTER: ${pair.hunter.letter} marks ${pair.foe.letter}`,
      data: { operativeId: pair.hunter.id, enemyId: pair.foe.id },
    });
  });
  // "…after that enemy operative performs an action in which it moves, you can interrupt to use
  //  this rule." Nothing runs after an action, so the interrupt is taken at the end of that
  //  enemy's activation and the free move is one AP outside the HUNTER's APL budget (D-100),
  //  spent in its own next activation (D-013).
  reg.on('onActivationEnd', T.bind(A.eruditeHunter, 13), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    const mark = effectFor(ev.state, T.player, E_ERUDITE_MARK);
    if (!mark || mark.data?.['enemyId'] !== foe.id) return;
    if (!did(foe, MOVE_ACTIONS)) return;
    const hunter = ev.state.operatives[String(mark.data?.['hunterId'] ?? '')];
    if (!hunter || hunter.removed || hunter.incapacitated) return;
    dropEffects(ev.state, (e) => e === mark); // "Once during this turning point"
    effect(ev.state, {
      rule: E_ERUDITE_FREE,
      source: { kind: 'ability', id: A.eruditeHunter },
      sourceText: shortQuote(abilityText(C.kurniteHunter, A.eruditeHunter)),
      operativeId: hunter.id,
      player: T.player,
      data: { enemyId: foe.id },
      expiry: { kind: 'endOfActivation', operativeId: hunter.id },
    });
    grantFreeAction(ev.state, hunter, {
      sourceId: A.eruditeHunter,
      sourceText: shortQuote(abilityText(C.kurniteHunter, A.eruditeHunter)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, hunter),
      only: ['Reposition', 'Charge'],
    });
  });

  // =========================================================================
  // STARSTORM DUELLIST › Quick on the Trigger
  // =========================================================================
  // The action is `Shoot (Quick on the Trigger)` below (D-021). It goes down the engine's
  // point-blank path — the only way to shoot while engaged — so the point-blank Hit penalty,
  // which this rule does not print, is cancelled here (the Exaction Squad VIGILANT precedent).
  reg.on('onStatMod', T.bind(A.quickOnTheTrigger, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, E_QUICK_TRIGGER)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // WARRIOR › Prowling Raiders
  // =========================================================================
  // "You can use the Capricious Flight and Light Fingers firefight ploys for 0CP each if a
  //  friendly WARRIOR operative is the specified CORSAIR VOIDSCARRED operative." The reducer
  //  charges the CP before any hook sees the ploy, so the discount is a refund.
  reg.on('onPloyUsed', T.bind(A.prowlingRaiders, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId !== FP.capriciousFlight && ev.ployId !== FP.lightFingers) return;
    const active = activeFriendly(ev.state, T.player);
    if (!active || active.datacardId !== C.warrior) return;
    const ply = [...DATA.firefightPloys].find((p) => p.id === ev.ployId);
    ev.state.teams[T.player].cp += ply?.cp ?? 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Prowling Raiders: ${ply?.name ?? ev.ployId} costs ${active.letter} 0CP`,
    });
  });

  // =========================================================================
  // WAY SEEKER › WARDING SHIELD (the effect; the action is below)
  // =========================================================================
  // "…the first time an attack dice inflicts Normal Dmg on that friendly operative, ignore that
  //  inflicted damage."
  reg.on('onDamage', T.bind(ACT.wardingShield, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const target = ev.target;
    if (target.player !== T.player) return;
    const shield = effectOn(ev.state, target.id, E_WARDING_SHIELD);
    if (!shield) return;
    const normal = incomingAttackDice(T, ev.state, target, ev.amount).find((d) => !d.crit);
    if (!normal || normal.dmg <= 0) return;
    dropEffects(ev.state, (e) => e === shield); // "the first time"
    ev.amount = Math.max(0, ev.amount - normal.dmg);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `WARDING SHIELD: ${target.letter} ignores ${normal.dmg} damage`,
    });
  });
  // "Until the start of this operative's next activation, until it's incapacitated or until it
  //  performs this action again (whichever comes first)" — all three refer to the WAY SEEKER.
  reg.on('onActivationStart', T.bind(ACT.wardingShield, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E_WARDING_SHIELD && e.data?.['casterId'] === ev.operative.id);
  });
  reg.on('onIncapacitated', T.bind(ACT.wardingShield, 13), (ev) => {
    if (ev.prevented || ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E_WARDING_SHIELD && e.data?.['casterId'] === ev.operative.id);
  });

  // =========================================================================
  // SOUL WEAVER › SOUL CHANNEL (the effect; the action is below)
  // =========================================================================
  // "Until the end of that operative's next activation, add 1 to its APL stat." Carried through
  // `onStatMod`, which `aplOf` consults, so it expires with its effect instead of leaking a
  // permanent `aplMods` entry.
  reg.on('onStatMod', T.bind(ACT.soulChannel, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, E_SOUL_CHANNEL)) return;
    ev.mods.apl += 1;
  });

  // =========================================================================
  // WAY SEEKER › WARP FOLD (the lock; the action is below)
  // =========================================================================
  // "…the other cannot perform any of those actions in its activation during this turning point."
  reg.on('canPerformAction', T.bind(ACT.warpFold, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (!effectOn(ev.state, op.id, E_WARP_FOLD_LOCK)) return;
    const def = getAction(ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (!BIG_MOVES.includes(key)) return;
    ev.allowed = false;
    ev.reason = 'WARP FOLD: it cannot perform the Charge, Fall Back or Reposition action this turning point';
  });
}

const RIFLES: ReadonlySet<string> = new Set(['shuriken rifle', 'ranger long rifle']);

/** The enemy's APL stat right now, for One Step Ahead's D6 comparison. */
function foeApl(T: TeamHooks, state: GameState, op: OperativeState): number {
  if (T.ctx) return aplOf(T.ctx, state, op);
  const base = T.card(op)?.apl ?? 2;
  const raw = op.aplMods.reduce((a, b) => a + b, 0);
  return Math.max(0, base + Math.max(-1, Math.min(1, raw)));
}

/** Is this operative currently spending its One Step Ahead free action? */
function spendingOneStep(state: GameState, op: OperativeState): string | undefined {
  const lock = effectOn(state, op.id, E_ONE_STEP);
  if (!lock) return undefined;
  const grant = effectOn(state, op.id, FREE_ACTION_RULE);
  if (!grant || grant.source.id !== A.oneStepAhead) return undefined;
  if (op.apSpent < Number(grant.data?.['threshold'] ?? 0)) return undefined;
  return String(lock.data?.['enemyId'] ?? '');
}

/**
 * The stated D-022 policy for One Step Ahead: it costs 1 APL and is once per battle, so it is
 * only taken when the interrupted enemy is something the FELARCH could actually act against.
 */
function oneStepWorthwhile(T: TeamHooks, state: GameState, felarch: OperativeState, foe: OperativeState): boolean {
  if (!T.ctx) return T.gap(felarch, foe) <= 8 + EPS;
  if (inControlRange(T.ctx, state, felarch, foe)) return true; // a free Fight
  for (const w of weaponsOf(T.ctx, state, felarch, 'ranged')) {
    for (const p of w.profiles) {
      if (p.type !== 'ranged') continue;
      const rules = effectiveRules(T.ctx, state, p, { operative: felarch, target: foe, weaponName: w.name });
      if (checkTarget(T.ctx, state, felarch, foe, p, rules).valid) return true;
    }
  }
  return false;
}

/** "Select one enemy operative within 9" of this operative." */
function eruditeCandidates(
  T: TeamHooks,
  state: GameState,
): { hunter: OperativeState; foe: OperativeState }[] {
  const out: { hunter: OperativeState; foe: OperativeState }[] = [];
  for (const hunter of T.friendlies(state).filter((o) => o.datacardId === C.kurniteHunter).sort(byId)) {
    if (hunter.incapacitated) continue;
    for (const foe of T.enemies(state).sort(byId)) {
      if (T.gap(hunter, foe) <= 9 + EPS) out.push({ hunter, foe });
    }
  }
  return out;
}

/**
 * "…any remaining move distance it had from that Charge action (to a maximum of 3")."
 *
 * `applyMove` records the validated distance of every move on the log, so the inches actually
 * spent on the Charge are exact. The Charge's own budget is recomputed as Move + 2"; no rule of
 * this kill team changes a Charge's distance, so the two always agree.
 */
export function blademasterRemaining(T: TeamHooks, state: GameState, op: OperativeState): number {
  const budget = (T.ctx ? moveOf(T.ctx, state, op) : (T.card(op)?.move ?? 6)) + 2;
  let spent = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.kind !== 'action' || entry.data?.['operativeId'] !== op.id) continue;
    if (entry.data?.['action'] !== 'Charge') continue;
    const inches = entry.data['inches'];
    if (typeof inches === 'number') spent = inches;
    break;
  }
  return Math.max(0, Math.min(3, budget - spent));
}

/**
 * Erudite Hunter's free Reposition: "it cannot end that move further away from that enemy
 * operative". No hook constrains where a move ENDS (`onMoveDistance` only caps the allowance),
 * so the predicate is exported for the UI and reported as reminder-only. "In a killzone that
 * uses the close quarters rules … ignore Wall terrain when determining further away" needs no
 * special case: the distance here is the straight base-to-base gap either way.
 */
export function eruditeEndPositionLegal(
  ctx: GameContext,
  state: GameState,
  hunter: OperativeState,
  endPos: Vec2,
): boolean {
  const eff = effectOn(state, hunter.id, E_ERUDITE_FREE);
  if (!eff) return true;
  const foe = state.operatives[String(eff.data?.['enemyId'] ?? '')];
  if (!foe || foe.removed) return true;
  const c = ctx.datacards.get(hunter.datacardId);
  const fc = ctx.datacards.get(foe.datacardId);
  if (!c || !fc) return true;
  const before = baseGap(hunter.pos, c.base, hunter.rot, foe.pos, fc.base, foe.rot);
  const after = baseGap(endPos, c.base, hunter.rot, foe.pos, fc.base, foe.rot);
  return after <= before + EPS;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- PLUNDERERS (strategy) ---------------------------------------------
  // "Up to D3 friendly CORSAIR VOIDSCARRED operatives can immediately perform a free Dash
  //  action in an order of your choice." The free Dash is one AP outside the APL budget, so it
  //  lands on each operative's next activation (D-013); the operatives themselves come from the
  //  gambit's `data` with
  //  a deterministic, logged default (D-016).
  reg.on('onPloyUsed', T.bind(SP.plunderers, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.plunderers) return;
    const n = d3(T, ev.state, 'PLUNDERERS D3 operatives');
    const supplied = ev.data?.['operativeIds'];
    const all = T.friendlies(ev.state, KW).sort(byId);
    const chosen = (
      Array.isArray(supplied) ? all.filter((o) => (supplied as unknown[]).includes(o.id)) : all
    ).slice(0, n);
    for (const op of chosen) {
      effect(ev.state, {
        rule: E_PLUNDERED,
        source: { kind: 'ploy', id: SP.plunderers },
        sourceText: shortQuote(text(SP.plunderers)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' }, // "This turning point…"
      });
      if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) continue;
      grantFreeAction(ev.state, op, {
        sourceId: SP.plunderers,
        sourceText: shortQuote(text(SP.plunderers)),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash', DASH_BLADEMASTER],
      });
    }
    log(ev.state, { kind: 'ploy', player: T.player, text: `PLUNDERERS: ${chosen.length} free Dash actions` });
  });
  // "This turning point, each that does so cannot perform the Dash action during their
  //  activation." The free Dash IS spent during that activation (D-013), so the ban is scoped
  //  to the operative's own AP: it may still take the Dash the ploy paid for.
  reg.on('canPerformAction', T.bind(SP.plunderers, 21), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (ev.action !== 'Dash' && ev.action !== DASH_BLADEMASTER) return;
    if (!effectOn(ev.state, op.id, E_PLUNDERED)) return;
    const grant = effectOn(ev.state, op.id, FREE_ACTION_RULE);
    if (grant && grant.source.id === SP.plunderers && op.apSpent >= Number(grant.data?.['threshold'] ?? 0)) return;
    ev.allowed = false;
    ev.reason = 'PLUNDERERS: it cannot perform the Dash action during its activation';
  });

  // ---- PIRATICAL PROFITEERS (strategy) -----------------------------------
  // "…if it or the enemy operative in that sequence contests an objective marker or one of your
  //  mission markers, that friendly operative's weapons have the Balanced weapon rule."
  // `onWeaponRules` is emitted by both sequences, so shooting, fighting AND retaliating are live.
  reg.on('onWeaponRules', T.bind(SP.piraticalProfiteers, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.piraticalProfiteers)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player) return;
    if (
      !contestsScoringMarker(T, ev.state, op, T.player) &&
      !contestsScoringMarker(T, ev.state, foe, T.player)
    )
      return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (PIRATICAL PROFITEERS)'));
  });

  // ---- MOBILE ENGAGEMENT (strategy) --------------------------------------
  reg.on('onDefenceDice', T.bind(SP.mobileEngagement, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.mobileEngagement)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!movedThisTP(ev.state, target)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    ev.rerolls.push({
      id: 'cv.mobileEngagement',
      label: 'MOBILE ENGAGEMENT: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: target.player,
      sourceText: shortQuote(text(SP.mobileEngagement)),
    });
  });

  // ---- OUTCASTS (strategy) -----------------------------------------------
  reg.on('onWeaponRules', T.bind(SP.outcasts, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.outcasts)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!isolatedFrom(T, ev.state, op)) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (OUTCASTS)'));
  });

  // ---- OPPORTUNISTIC FIGHTERS (firefight) --------------------------------
  // "Use this firefight ploy when an enemy operative performs the Fall Back action. Before it
  //  moves, inflict 2D3 damage on that operative for each friendly CORSAIR VOIDSCARRED
  //  operative within its control range."
  reg.on('onPloyUsed', T.bind(FP.opportunisticFighters, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.opportunisticFighters) return;
    const foe = opportunisticTarget(T, ev.state, ev.data);
    if (!foe) return;
    const engaged = T.friendlies(ev.state, KW).filter((o) => engagedWith(T, ev.state, o, foe));
    for (const mate of engaged) {
      const dmg = d3(T, ev.state, 'OPPORTUNISTIC FIGHTERS 2D3') + d3(T, ev.state, 'OPPORTUNISTIC FIGHTERS 2D3');
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `OPPORTUNISTIC FIGHTERS: ${mate.letter} savages ${foe.letter} for ${dmg}`,
      });
      if (T.ctx) inflictDamage(T.ctx, ev.state, foe, dmg, 'other');
      if (foe.removed || foe.incapacitated) break;
    }
  });

  // ---- LIGHT FINGERS (firefight) -----------------------------------------
  reg.on('onPloyUsed', T.bind(FP.lightFingers, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.lightFingers) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op || !T.kw(op, KW)) return;
    effect(ev.state, {
      rule: E_LIGHT_FINGERS,
      source: { kind: 'ploy', id: FP.lightFingers },
      sourceText: shortQuote(text(FP.lightFingers)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });

  // ---- CAPRICIOUS FLIGHT (firefight) -------------------------------------
  reg.on('onPloyUsed', T.bind(FP.capriciousFlight, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.capriciousFlight) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op || !T.kw(op, KW)) return;
    effect(ev.state, {
      rule: E_CAPRICIOUS,
      source: { kind: 'ploy', id: FP.capriciousFlight },
      sourceText: shortQuote(text(FP.capriciousFlight)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.capriciousFlight, 20), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const def = getAction(ev.action);
    if ((def?.treatedAs ?? ev.action) !== 'Fall Back') return;
    if (!effectOn(ev.state, op.id, E_CAPRICIOUS)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- CONTEMPTUOUS ADVENTURER (firefight) -------------------------------
  reg.on('onPloyUsed', T.bind(FP.contemptuousAdventurer, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.contemptuousAdventurer) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op || !T.kw(op, KW)) return;
    effect(ev.state, {
      rule: E_CONTEMPTUOUS,
      source: { kind: 'ploy', id: FP.contemptuousAdventurer },
      sourceText: shortQuote(text(FP.contemptuousAdventurer)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  // "The first time that operative performs either the Shoot or Fight action during that
  //  activation, its weapons have the Relentless weapon rule." `actionsThisActivation` is
  //  pushed AFTER the action resolves, so "the first time" is exactly "it has not performed a
  //  Shoot or Fight action yet" — which is also what makes the printed once-per-activation note
  //  ("you cannot use it during both the Shoot and Fight action") hold.
  reg.on('onWeaponRules', T.bind(FP.contemptuousAdventurer, 20), (ev) => {
    if (ev.retaliating) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!effectOn(ev.state, op.id, E_CONTEMPTUOUS)) return;
    if (did(op, SHOOT_OR_FIGHT)) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (CONTEMPTUOUS ADVENTURER)'));
  });
}

/** Every action id that counts as "performs either the Shoot or Fight action". */
const SHOOT_OR_FIGHT = ['Shoot', 'Fight', ACT.pistolBarrage, PISTOL_BARRAGE_2];

function engagedWith(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

/** The enemy OPPORTUNISTIC FIGHTERS hits: the one the ploy names, or the active enemy. */
function opportunisticTarget(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): OperativeState | undefined {
  const candidates = T.enemies(state).filter((foe) =>
    T.friendlies(state, KW).some((o) => engagedWith(T, state, o, foe)),
  );
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const preferred = active && active.player !== T.player && candidates.some((o) => o.id === active.id) ? [active] : candidates;
  return chosenOperative(state, data, preferred);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- DIUTURNAL MANTLES -------------------------------------------------
  // "Whenever an operative is shooting a friendly CORSAIR VOIDSCARRED operative, if the ranged
  //  weapon in that sequence has the Blast or Torrent weapon rule, you can re-roll one of your
  //  defence dice."
  reg.on('onDefenceDice', T.bind(EQ.diuturnalMantles, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.diuturnalMantles)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!hasRule(ev.ctx.rules, 'Blast') && !hasRule(ev.ctx.rules, 'Torrent')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    ev.rerolls.push({
      id: 'cv.diuturnalMantles',
      label: 'DIUTURNAL MANTLES: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: target.player,
      sourceText: shortQuote(text(EQ.diuturnalMantles)),
    });
  });
  // "In addition, friendly CORSAIR VOIDSCARRED operatives aren't affected by the x" Devastating
  //  x weapon rule (i.e. Devastating with a distance) unless they are the target during that
  //  sequence." The splash lands as `kind: 'devastating'` damage on every operative within the
  //  printed radius, so the exemption is applied where that damage is inflicted.
  reg.on('onDamage', T.bind(EQ.diuturnalMantles, 31), (ev) => {
    if (ev.kind !== 'devastating') return;
    if (!hasEquipment(ev.state, T.player, EQ.diuturnalMantles)) return;
    if (!T.mineKw(ev.target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId === ev.target.id) return; // "…unless they are the target"
    const attacker = ev.state.operatives[seq.attackerId];
    const profile = attacker ? profileOf(T, attacker, seq.weaponName, seq.profileName) : undefined;
    if (!profile || ruleOf(profile.rules, 'Devastating')?.dist === undefined) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `DIUTURNAL MANTLES: ${ev.target.letter} is not affected by ${profile.rules.find((r) => r.id === 'Devastating')?.raw}`,
    });
    ev.amount = 0;
  });

  // ---- MISTFIELD ---------------------------------------------------------
  // "Once per turning point, when an operative is shooting a friendly CORSAIR VOIDSCARRED
  //  operative more than 3" from it, at the start of the Roll Defence Dice step, you can use
  //  this rule. If you do, worsen the x of the Piercing weapon rule by 1 (if any) until the end
  //  of that sequence." Free and it can only help, so it is auto-used on its printed trigger
  //  (docs/DECISIONS.md D-022). The defence pool is `3 − Piercing`, so worsening x by 1 is one
  //  more defence dice — and Piercing 1 is therefore ignored, exactly as the note says.
  reg.on('onDefenceDice', T.bind(EQ.mistfield, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.mistfield)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    if (!hasRule(ev.ctx.rules, 'Piercing')) return; // "(if any)"
    if (T.gap(ev.ctx.attacker, target) <= 3 + EPS) return; // "more than 3\" from it"
    if (!useOncePerTP(ev.state, `cv.mistfield:${T.player}`)) return;
    ev.count += 1;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `MISTFIELD: ${target.letter} worsens Piercing by 1 (${ev.count} defence dice)`,
    });
  });

  // ---- RUNES OF GUIDANCE -------------------------------------------------
  // The +3" is applied inside this team's own PSYCHIC unique actions (`psychicRange`), which is
  // the only place a distance requirement of theirs is read. Its printed note — "this has no
  // effect on PSYCHIC weapons (e.g. the Devastating distance requirement of lightning strike)"
  // — holds by construction: nothing here touches a weapon rule.

  // ---- STAR CHARTS -------------------------------------------------------
  // "STRATEGIC GAMBIT. Roll one D3: if the result is higher than the number of the current
  //  turning point, you gain 1CP and cannot use this STRATEGIC GAMBIT for the rest of the
  //  battle."
  reg.on('gambitOptions', T.bind(EQ.starCharts, 30), (ev) => {
    if (ev.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.starCharts)) return;
    if (usedThisBattle(ev.state, starChartsKey(T.player))) return;
    ev.options.push({
      id: EQ.starCharts,
      label: 'STAR CHARTS',
      sourceText: shortQuote(text(EQ.starCharts)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.starCharts, 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.starCharts) return;
    const roll = d3(T, ev.state, 'STAR CHARTS D3');
    if (roll <= ev.state.turningPoint) {
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `STAR CHARTS: ${roll} is not higher than turning point ${ev.state.turningPoint}`,
      });
      return;
    }
    ev.state.teams[T.player].cp += 1;
    useOncePerBattle(ev.state, starChartsKey(T.player));
    log(ev.state, { kind: 'ploy', player: T.player, text: `STAR CHARTS: ${roll} > turning point — +1CP` });
  });
}

const starChartsKey = (player: PlayerId): string => `cv.starCharts:${player}`;

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs — the four strategy ploys, with PLUNDERERS' turning-point gate
// ---------------------------------------------------------------------------

function gambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      // "You cannot use this ploy during the first turning point."
      if (ploy.id === SP.plunderers && ev.state.turningPoint <= 1) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** "Select one … friendly CORSAIR VOIDSCARRED operative visible to and within N" of this one." */
function psychicTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  base: number,
  targetId: string | undefined,
  opts: { excludeSelf?: boolean; woundedOnly?: boolean } = {},
): OperativeState | undefined {
  const reach = psychicRange(state, op.player, base);
  const index = terrain(ctx, state);
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => (opts.excludeSelf ? o.id !== op.id : true))
    .filter((o) => (catalogueCard(o.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === KW))
    .filter((o) => {
      const c = ctx.datacards.get(o.datacardId);
      const oc = ctx.datacards.get(op.datacardId);
      if (!c || !oc) return false;
      return baseGap(op.pos, oc.base, op.rot, o.pos, c.base, o.rot) <= reach + EPS;
    })
    .filter((o) => o.id === op.id || isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .filter((o) => {
      if (!opts.woundedOnly) return true;
      const c = ctx.datacards.get(o.datacardId);
      return c !== undefined && o.wounds < c.wounds;
    })
    .sort(byId);
  if (targetId) return candidates.find((o) => o.id === targetId);
  return candidates[0];
}

const gapOf = (ctx: GameContext, a: OperativeState, b: OperativeState): number => {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return 0;
  return baseGap(a.pos, ca.base, a.rot, b.pos, cb.base, b.rot);
};

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- SOUL WEAVER › SOUL CHANNEL 1AP ----------------------------------
    uniqueAction(data, C.soulWeaver, ACT.soulChannel, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return psychicTarget(ctx, state, op, 6, params.targetOperativeId, { excludeSelf: true })
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly CORSAIR VOIDSCARRED operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = psychicTarget(ctx, state, op, 6, params.targetOperativeId, { excludeSelf: true })!;
        claimRunes(state, op, target, 6, gapOf(ctx, op, target));
        dropEffects(state, (e) => e.rule === E_SOUL_CHANNEL && e.operativeId === target.id);
        effect(state, {
          rule: E_SOUL_CHANNEL,
          source: { kind: 'ability', id: ACT.soulChannel },
          sourceText: shortQuote(actionText(C.soulWeaver, ACT.soulChannel)),
          operativeId: target.id,
          player: op.player,
          // "Until the end of that operative's next activation" — the operative is never mid
          // activation when this lands (the SOUL WEAVER is the active one), so the expiry is
          // armed straight away and fires at the end of the target's next activation.
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: true },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SOUL CHANNEL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),

    // ---- SOUL WEAVER › SOUL HEAL 1AP -------------------------------------
    uniqueAction(data, C.soulWeaver, ACT.soulHeal, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return psychicTarget(ctx, state, op, 6, params.targetOperativeId, { woundedOnly: true })
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CORSAIR VOIDSCARRED operative with lost wounds within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = psychicTarget(ctx, state, op, 6, params.targetOperativeId, { woundedOnly: true })!;
        claimRunes(state, op, target, 6, gapOf(ctx, op, target));
        const a = ctx.rng.d3();
        const b = ctx.rng.d3();
        recordRoll(state, 'corsair-voidscarred', [a, b], op.player, 'SOUL HEAL 2D3');
        const card = ctx.datacards.get(target.datacardId);
        const before = target.wounds;
        target.wounds = Math.min(card?.wounds ?? target.wounds + a + b, target.wounds + a + b);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: SOUL HEAL — ${target.letter} regains ${target.wounds - before} wounds`,
        });
        return { ok: true };
      },
    }),

    // ---- WAY SEEKER › WARP FOLD 1AP --------------------------------------
    // "Select two friendly CORSAIR VOIDSCARRED operatives visible to and within 5" of this
    //  operative. Remove them both from the killzone and set them back up in each other's
    //  previous locations." RUNES OF GUIDANCE explicitly excludes this action, so the printed
    //  5" is never widened.
    uniqueAction(data, C.waySeeker, ACT.warpFold, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return warpFoldPair(ctx, state, op, params.targetOperativeId, params.data)
          ? { ok: true }
          : { ok: false, reason: 'select two friendly CORSAIR VOIDSCARRED operatives visible to and within 5"' };
      },
      perform: (ctx, state, op, params) => {
        const pair = warpFoldPair(ctx, state, op, params.targetOperativeId, params.data)!;
        const [a, b] = pair;
        const aPos = { ...a.pos };
        const aZ = a.z;
        a.pos = { ...b.pos };
        a.z = b.z;
        b.pos = aPos;
        b.z = aZ;
        for (const o of [a, b]) {
          o.onGuard = false;
          o.stickyEngagedWith = [];
          if (o.carryingMarkerId) {
            const m = state.markers[o.carryingMarkerId];
            if (m) {
              m.pos = { ...o.pos };
              m.z = o.z;
            }
          }
        }
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: WARP FOLD swaps ${a.letter} and ${b.letter}` });
        // "If one of them performed the Charge, Fall Back or Reposition action during this
        //  turning point and the other is ready, the other cannot perform any of those actions
        //  in its activation during this turning point."
        for (const [mover, other] of [
          [a, b],
          [b, a],
        ] as const) {
          if (!bigMovedThisTP(state, mover) || !other.ready) continue;
          if (effectOn(state, other.id, E_WARP_FOLD_LOCK)) continue;
          effect(state, {
            rule: E_WARP_FOLD_LOCK,
            source: { kind: 'ability', id: ACT.warpFold },
            sourceText: shortQuote(actionText(C.waySeeker, ACT.warpFold)),
            operativeId: other.id,
            player: op.player,
            expiry: { kind: 'endOfTurningPoint' },
          });
          log(state, {
            kind: 'action',
            player: op.player,
            text: `WARP FOLD: ${other.letter} cannot Charge, Fall Back or Reposition this turning point`,
          });
        }
        return { ok: true };
      },
    }),

    // ---- WAY SEEKER › WARDING SHIELD 1AP ---------------------------------
    uniqueAction(data, C.waySeeker, ACT.wardingShield, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return psychicTarget(ctx, state, op, 6, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CORSAIR VOIDSCARRED operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = psychicTarget(ctx, state, op, 6, params.targetOperativeId)!;
        claimRunes(state, op, target, 6, gapOf(ctx, op, target));
        // "…or until it performs this action again (whichever comes first)."
        dropEffects(state, (e) => e.rule === E_WARDING_SHIELD && e.data?.['casterId'] === op.id);
        effect(state, {
          rule: E_WARDING_SHIELD,
          source: { kind: 'ability', id: ACT.wardingShield },
          sourceText: shortQuote(actionText(C.waySeeker, ACT.wardingShield)),
          operativeId: target.id,
          player: op.player,
          data: { casterId: op.id },
          expiry: { kind: 'endOfBattle' }, // the three printed ends are handled by their own hooks
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: WARDING SHIELD on ${target.letter}` });
        return { ok: true };
      },
    }),
  ];
}

/** WARP FOLD's two operatives: from the intent, else a deterministic pair (D-016). */
function warpFoldPair(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  firstId: string | undefined,
  data: Record<string, unknown> | undefined,
): [OperativeState, OperativeState] | undefined {
  const index = terrain(ctx, state);
  const oc = ctx.datacards.get(op.datacardId);
  if (!oc) return undefined;
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => (catalogueCard(o.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === KW))
    .filter((o) => {
      const c = ctx.datacards.get(o.datacardId);
      if (!c) return false;
      return baseGap(op.pos, oc.base, op.rot, o.pos, c.base, o.rot) <= 5 + EPS;
    })
    .filter((o) => o.id === op.id || isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort(byId);
  if (candidates.length < 2) return undefined;
  const secondId = typeof data?.['secondOperativeId'] === 'string' ? (data['secondOperativeId'] as string) : undefined;
  const first = candidates.find((o) => o.id === firstId) ?? candidates[0]!;
  const second = candidates.find((o) => o.id === secondId && o.id !== first.id) ?? candidates.find((o) => o.id !== first.id);
  if (!second) return undefined;
  return [first, second];
}

// ---------------------------------------------------------------------------
// KURNATHI › Blademaster — `Dash (Blademaster)` (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

registerAction({
  id: DASH_BLADEMASTER,
  name: 'Dash (Blademaster)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Dash',
  sourceText: abilityText(C.kurnathi, A.blademaster),
  available: (_ctx, _state, op) => op.datacardId === C.kurnathi,
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Charge'))
      return { ok: false, reason: 'only during an activation in which it performed the Charge action' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Dash',
      noClimb: true,
      mustNotFinishEngaged: true,
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  // The universal Dash's `perform` re-validates through `moveBudget`, which emits
  // `onMoveDistance` — where the Blademaster cap lives — so the remaining-distance rule is
  // applied by the same code path the check saw.
  perform: (ctx, state, op, params) => getAction('Dash')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// SHADE RUNNER › Blink Pack + Slicing Attack (D-021; the Sanctifiers Fly precedent)
// ---------------------------------------------------------------------------

/**
 * "…remove it from the killzone and set it back up wholly within 7" horizontally of its
 * original location (in a killzone that uses the close quarters rules … this distance can be
 * measured through Wall terrain). It must be set up in a location it can be placed, and unless
 * it's the Charge action, it cannot be set up within control range of an enemy operative."
 */
function blinkDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2 | undefined,
  mode: 'Reposition' | 'Fall Back' | 'Charge',
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  if (!pos) return { ok: false, reason: 'select a location to warp jump to' };
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const r = baseRadius(c.base);
  if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location' };
  // "wholly within 7\" horizontally of its original location" — the whole base inside a 7"
  // circle around where it stood. Close quarters explicitly allows measuring through Wall
  // terrain, so the straight-line distance is used there too and `wallRouteDistance` is only
  // consulted outside those killzones.
  const travelled = state.map.closeQuarters ? dist(op.pos, pos) : wallRouteDistance(index, op.pos, pos);
  if (travelled + r > 7 + EPS) return { ok: false, reason: 'it can only warp jump wholly within 7"' };
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot)) return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, body(ctx, op).height))
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (baseGap(pos, c.base, op.rot, other.pos, oc.base, other.rot) < -1e-4)
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  const landed: Body = { id: op.id, pos, z, rot: op.rot, base: c.base, height: body(ctx, op).height };
  const engagedThere = aliveOperatives(state, otherPlayer(op.player)).some((e) =>
    withinControlRange(index, landed, body(ctx, e)),
  );
  if (mode === 'Charge' && !engagedThere)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  if (mode !== 'Charge' && engagedThere)
    return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
  return { ok: true, pos, z };
}

function blinkAction(id: string, name: string, mode: 'Reposition' | 'Fall Back' | 'Charge', ap: number): ActionDef {
  return {
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: mode,
    sourceText: abilityText(C.shadeRunner, A.blinkPack),
    available: (_ctx, _state, op) => op.datacardId === C.shadeRunner,
    check(ctx, state, op, params) {
      const engaged = enemiesInControlRange(ctx, state, op).length > 0;
      const done = (a: string): boolean => op.actionsThisActivation.includes(a);
      if (mode === 'Reposition') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (done('Fall Back') || done('Charge'))
          return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (mode === 'Fall Back') {
        if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
        if (done('Reposition') || done('Charge'))
          return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
        if (done('Reposition') || done('Dash') || done('Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const d = blinkDestination(ctx, state, op, params.targetPos, mode);
      return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? 'it cannot warp jump there' };
    },
    perform(ctx, state, op, params) {
      const d = blinkDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot warp jump there' };
      const from = { ...op.pos };
      // Slicing Attack needs the enemies that were visible at the START of the action.
      const visibleBefore = new Set(
        aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
          .map((e) => e.id),
      );
      op.pos = { ...d.pos };
      op.z = d.z ?? 0;
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      if (mode === 'Charge') {
        op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} warp jumps (${name}, ${dist(from, op.pos).toFixed(1)}")`,
        data: { operativeId: op.id, action: mode, inches: dist(from, op.pos) },
      });
      if (mode === 'Reposition') slicingAttack(ctx, state, op, from, visibleBefore, params.targetOperativeId);
      return { ok: true };
    },
  };
}

/**
 * SHADE RUNNER › Slicing Attack: "Whenever this operative performs the Reposition action with a
 * warp jump …, after it moves, draw an imaginary line 1mm in diameter and up to 7" long between
 * it and its previous location. Note this doesn't have to be a straight line. Inflict D3+2
 * damage on one enemy operative that line crosses. You cannot inflict damage on an enemy
 * operative that was not visible to this operative at the start of that action."
 *
 * The line is free, so it is drawn on the printed trigger (D-022). "It doesn't have to be a
 * straight line" is a continuous player choice with no decision channel, so the deterministic
 * default is the straight segment between the two locations (D-016) — reported as a partial.
 */
function slicingAttack(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  from: Vec2,
  visibleBefore: Set<string>,
  wanted: string | undefined,
): void {
  if (dist(from, op.pos) > 7 + EPS) return; // "up to 7\" long"
  const crossed = aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => visibleBefore.has(e.id))
    .filter((e) => {
      const c = ctx.datacards.get(e.datacardId);
      return c !== undefined && distancePointToSegment(e.pos, from, op.pos) <= baseRadius(c.base) + EPS;
    })
    .sort(byId);
  const victim = crossed.find((e) => e.id === wanted) ?? crossed[0];
  if (!victim) return;
  const roll = ctx.rng.d3();
  recordRoll(state, 'corsair-voidscarred', [roll], op.player, 'Slicing Attack D3+2');
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter}: Slicing Attack cuts ${victim.letter} for ${roll + 2}`,
  });
  inflictDamage(ctx, state, victim, roll + 2, 'other');
}

for (const [id, name, mode, ap] of [
  [BLINK_REPOSITION, 'Reposition (Blink Pack)', 'Reposition', 1],
  [BLINK_FALL_BACK, 'Fall Back (Blink Pack)', 'Fall Back', 2],
  [BLINK_CHARGE, 'Charge (Blink Pack)', 'Charge', 1],
] as const) {
  registerAction(blinkAction(id, name, mode, ap));
}

// ---------------------------------------------------------------------------
// STARSTORM DUELLIST › Quick on the Trigger — `Shoot (Quick on the Trigger)` (D-021)
// ---------------------------------------------------------------------------

/**
 * "This operative can perform the Shoot action while within control range of an enemy operative.
 * If it does, when selecting a valid target, you can only select an enemy operative within this
 * operative's control range, and can do so even if other friendly operatives are within that
 * enemy operative's control range."
 *
 * The engine's only path for shooting while engaged is the point-blank one, so the shot goes
 * down it (its Hit penalty, which this rule does not print, is cancelled by the `onStatMod`
 * handler bound to the ability). The point-blank path also waives the visibility and
 * Conceal-in-cover checks, which this rule does not lift, so they are re-applied here.
 */
function quickTriggerShot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: { weaponName?: string; profileName?: string; targetId?: string; targetOperativeId?: string },
): { ok: boolean; reason?: string; weaponName?: string; profileName?: string; targetId?: string } {
  const engaged = enemiesInControlRange(ctx, state, op);
  if (engaged.length === 0)
    return { ok: false, reason: 'no enemy operative within control range — use the Shoot action' };
  const ranged = weaponsOf(ctx, state, op, 'ranged');
  const weapon = params.weaponName ? ranged.find((w) => w.name === params.weaponName) : ranged[0];
  if (!weapon) return { ok: false, reason: 'operative has no ranged weapon' };
  const profile = findProfile(weapon, params.profileName);
  if (!profile) return { ok: false, reason: `weapon '${weapon.name}' has no such profile` };
  if (op.order === 'conceal' && !weapon.profiles.some((p) => p.rules.some((r) => r.id === 'Silent')))
    return { ok: false, reason: 'cannot Shoot with a Conceal order' };
  if (profile.rules.some((r) => r.id === 'Heavy') && op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a)))
    return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which the operative moved` };
  const wantedId = params.targetId ?? params.targetOperativeId;
  // "you can only select an enemy operative within this operative's control range"
  const candidates = [...engaged].sort(byId);
  const target = wantedId ? candidates.find((o) => o.id === wantedId) : candidates[0];
  if (!target) return { ok: false, reason: 'only an enemy operative within this operative’s control range can be selected' };
  const rules = effectiveRules(ctx, state, profile, { operative: op, target, weaponName: weapon.name });
  const check = checkTarget(ctx, state, op, target, profile, rules, { pointBlank: true });
  if (!check.valid) return { ok: false, reason: check.reason ?? 'not a valid target' };
  if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
    return { ok: false, reason: 'not visible' };
  if (target.order === 'conceal' && check.inCover)
    return { ok: false, reason: 'target has a Conceal order and is in cover' };
  return {
    ok: true,
    weaponName: weapon.name,
    targetId: target.id,
    ...(params.profileName ? { profileName: params.profileName } : {}),
  };
}

registerAction({
  id: SHOOT_QUICK_TRIGGER,
  name: 'Shoot (Quick on the Trigger)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(C.starstormDuellist, A.quickOnTheTrigger),
  available: (_ctx, _state, op) => op.datacardId === C.starstormDuellist,
  check(ctx, state, op, params) {
    const r = quickTriggerShot(ctx, state, op, params);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'not possible' };
  },
  perform(ctx, state, op, params) {
    const r = quickTriggerShot(ctx, state, op, params);
    if (!r.ok) return { ok: false, reason: r.reason ?? 'not possible' };
    effect(state, {
      rule: E_QUICK_TRIGGER,
      source: { kind: 'ability', id: A.quickOnTheTrigger },
      sourceText: shortQuote(abilityText(C.starstormDuellist, A.quickOnTheTrigger)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    const started = startShoot(ctx, state, op, r.weaponName!, r.profileName, r.targetId!, { pointBlank: true });
    if (!started.ok) return started;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// STARSTORM DUELLIST › PISTOL BARRAGE — two sibling actions
// ---------------------------------------------------------------------------

/**
 * "Perform two free Shoot actions with this operative (this takes precedence over action
 * restrictions). You must select its fusion pistol for one action and its shuriken pistol for
 * the other (in any order). This operative cannot perform this action while it has a Conceal
 * order, or during an activation in which it performed the Shoot action (or vice versa)."
 *
 * `state.sequence` is single-slot, so two shoot sequences cannot be started from one `perform`.
 * The barrage is therefore two sibling actions — the printed 1AP one fires the fusion pistol and
 * the 0AP follow-up the shuriken pistol, fixing the printed "in any order" deterministically.
 * Neither is `treatedAs: 'Shoot'`, which is what gives the rule its precedence over action
 * restrictions (the Inquisitorial Agent PISTOL BARRAGE precedent).
 */
const PISTOL_BARRAGE_AP = cardOf(C.starstormDuellist).uniqueActions.find((a) => a.id === ACT.pistolBarrage)!.ap;

const BARRAGE_WEAPON: Record<string, string> = {
  [ACT.pistolBarrage]: 'Fusion pistol',
  [PISTOL_BARRAGE_2]: 'Shuriken pistol',
};

function barrageParams(actionId: string, params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, weaponName: BARRAGE_WEAPON[actionId], profileName: undefined };
}

function barrageCheck(
  actionId: string,
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  if (op.order === 'conceal')
    return { ok: false, reason: 'this operative cannot perform this action while it has a Conceal order' };
  if (op.actionsThisActivation.includes('Shoot'))
    return { ok: false, reason: 'not during an activation in which it performed the Shoot action' };
  if (actionId === PISTOL_BARRAGE_2 && !op.actionsThisActivation.includes(ACT.pistolBarrage))
    return { ok: false, reason: 'the second barrage shot follows the first' };
  if (actionId === ACT.pistolBarrage && op.actionsThisActivation.includes(PISTOL_BARRAGE_2))
    return { ok: false, reason: 'the barrage is already finished' };
  const target = state.operatives[String(params['targetId'] ?? params['targetOperativeId'] ?? '')];
  if (!target || target.removed || target.player === op.player)
    return { ok: false, reason: 'select an enemy operative' };
  return getAction('Shoot')!.check(ctx, state, op, { ...barrageParams(actionId, params), targetId: target.id });
}

for (const actionId of [ACT.pistolBarrage, PISTOL_BARRAGE_2]) {
  registerAction({
    id: actionId,
    name: actionId === ACT.pistolBarrage ? 'PISTOL BARRAGE' : 'PISTOL BARRAGE (2)',
    ap: actionId === ACT.pistolBarrage ? PISTOL_BARRAGE_AP : 0,
    type: 'unique',
    sourceText: `PISTOL BARRAGE: ${actionText(C.starstormDuellist, ACT.pistolBarrage).replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, _state, op) => op.datacardId === C.starstormDuellist,
    check: (ctx, state, op, params) => barrageCheck(actionId, ctx, state, op, params as Record<string, unknown>),
    perform: (ctx, state, op, params) => {
      const p = params as Record<string, unknown>;
      const targetId = String(p['targetId'] ?? p['targetOperativeId'] ?? '');
      return getAction('Shoot')!.perform(ctx, state, op, { ...barrageParams(actionId, p), targetId });
    },
  });
}

// ---------------------------------------------------------------------------
// LIGHT FINGERS — `Pick Up Marker (Light Fingers)` (D-021)
// ---------------------------------------------------------------------------

registerAction({
  id: PICK_UP_LIGHT_FINGERS,
  name: 'Pick Up Marker (Light Fingers)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: text(FP.lightFingers),
  available: (_ctx, state, op) => Boolean(effectOn(state, op.id, E_LIGHT_FINGERS)),
  check(ctx, state, op, params) {
    if (!effectOn(state, op.id, E_LIGHT_FINGERS))
      return { ok: false, reason: 'the LIGHT FINGERS firefight ploy has not been used on this operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker: MarkerState | undefined = params.markerId ? state.markers[params.markerId] : undefined;
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

export const corsairVoidscarred = defineTeam({
  id: 'corsair-voidscarred',
  rules,
  ploys,
  equipment,
  actions,
  gambits,
  ployUsable: {
    // "Use this firefight ploy when an enemy operative performs the Fall Back action."
    // Nothing is emitted when an action is declared (`canPerformAction` is a pure query the AI
    // runs many times per activation), so the window is the board state that Fall Back needs:
    // an enemy operative engaged with a friendly CORSAIR VOIDSCARRED operative.
    [FP.opportunisticFighters]: (state, player) => {
      const mine = aliveOperatives(state, player).filter((o) => catKw(o, KW));
      const near = aliveOperatives(state, otherPlayer(player)).some((foe) =>
        mine.some((o) => dist(o.pos, foe.pos) <= 1 + 1.2),
      );
      return near
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative is within control range of a friendly CORSAIR VOIDSCARRED operative' };
    },
    // "Use this firefight ploy during a friendly CORSAIR VOIDSCARRED operative's activation."
    [FP.lightFingers]: (state, player) => {
      const op = activeFriendly(state, player);
      return op && catKw(op, KW)
        ? { ok: true }
        : { ok: false, reason: 'no friendly CORSAIR VOIDSCARRED operative is activated' };
    },
    [FP.capriciousFlight]: (state, player) => {
      const op = activeFriendly(state, player);
      return op && catKw(op, KW)
        ? { ok: true }
        : { ok: false, reason: 'no friendly CORSAIR VOIDSCARRED operative is activated' };
    },
    // "…when the FIRST friendly CORSAIR VOIDSCARRED operative is activated during the turning
    //  point, if it's more than 5" from other friendly operatives."
    [FP.contemptuousAdventurer]: (state, player) => {
      const op = activeFriendly(state, player);
      if (!op || !catKw(op, KW)) return { ok: false, reason: 'no friendly CORSAIR VOIDSCARRED operative is activated' };
      const n = Number(bucket(state, 'cv.cvActivations')[`${player}:${state.turningPoint}`] ?? 0);
      if (n > 1) return { ok: false, reason: 'it is not the first friendly operative activated this turning point' };
      const alone = aliveOperatives(state, player).every((o) => o.id === op.id || dist(o.pos, op.pos) > 5 + 1.2);
      return alone ? { ok: true } : { ok: false, reason: 'it is not more than 5" from other friendly operatives' };
    },
  },
  aiHints: {
    roles: {
      [C.felarch]: 'leader',
      [C.fateDealer]: 'sniper',
      [C.gunner]: 'gunner',
      [C.heavyGunner]: 'gunner',
      [C.kurnathi]: 'melee',
      [C.kurniteHunter]: 'melee',
      [C.shadeRunner]: 'scout',
      [C.soulWeaver]: 'support',
      [C.starstormDuellist]: 'gunner',
      [C.warrior]: 'objective',
      [C.waySeeker]: 'support',
    },
    ployValue: {
      [SP.plunderers]: 0.5,
      [SP.piraticalProfiteers]: 0.6,
      [SP.mobileEngagement]: 0.5,
      [SP.outcasts]: 0.4,
      [FP.opportunisticFighters]: 0.6,
      [FP.lightFingers]: 0.4,
      [FP.capriciousFlight]: 0.4,
      [FP.contemptuousAdventurer]: 0.5,
    },
    equipmentValue: {
      [EQ.diuturnalMantles]: 0.5,
      [EQ.mistfield]: 0.5,
      [EQ.runesOfGuidance]: 0.4,
      [EQ.starCharts]: 0.4,
    },
  },
});

export default corsairVoidscarred;
