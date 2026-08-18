/**
 * RATLINGS — Astra Militarum. https://wahapedia.ru/kill-team3/kill-teams/ratlings/
 * Rule text is read from `data/teams/ratlings.json`; nothing printed is retyped here.
 *
 * The team is one faction rule (Scarper) plus a pile of sniper-flavoured riders on the
 * "rifle" keyword. The selection block's own designer note defines what a rifle is:
 *   "Some RATLING rules refer to a 'rifle'. This is a ranged weapon that includes 'rifle'
 *    in its name, e.g. tankstopper rifle, all profiles of a sniper rifle, etc."
 * so `isRifle` is a name test, exactly as printed.
 */
import { allActions, getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGap, baseWhollyWithin, baseWithin, baseRadius, dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  aliveOperatives,
  body,
  hitOf,
  inflictDamage,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
  settleZ,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseDistanceToPart, baseTouchesHazardous, hasType, surfaceAt } from '../../core/terrain.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
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
  placeTeamMarker,
  ployUsed,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('ratlings');
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

const KW = 'RATLING';

export const CARD = {
  fixer: 'ratlings.fixer',
  battlemutt: 'ratlings.battlemutt',
  bullgryn: 'ratlings.bullgryn',
  ogryn: 'ratlings.ogryn',
  bigShot: 'ratlings.big-shot',
  bomber: 'ratlings.bomber',
  hardbit: 'ratlings.hardbit',
  raider: 'ratlings.raider',
  sneak: 'ratlings.sneak',
  sniper: 'ratlings.sniper',
  spotter: 'ratlings.spotter',
  stashmaster: 'ratlings.stashmaster',
  voxThief: 'ratlings.vox-thief',
} as const;

export const RULE = { scarper: 'ratlings.rule.scarper' } as const;

export const SP = {
  sniperPositions: 'ratlings.sp.sniper-positions',
  shifty: 'ratlings.sp.shifty',
  crackShots: 'ratlings.sp.crack-shots',
  frontlineAssault: 'ratlings.sp.frontline-assault',
} as const;

export const FP = {
  survivalInstincts: 'ratlings.fp.survival-instincts',
  larcenous: 'ratlings.fp.larcenous',
  sharpshot: 'ratlings.fp.sharpshot',
  shootAndHide: 'ratlings.fp.shoot-and-hide',
} as const;

export const EQ = {
  purloinedRations: 'ratlings.eq.purloined-rations',
  stolenGoods: 'ratlings.eq.stolen-goods',
  luckyRound: 'ratlings.eq.lucky-round',
  improvisedArmour: 'ratlings.eq.improvised-armour',
} as const;

export const A = {
  munitorumContacts: 'ratlings.fixer.munitorum-contacts',
  targetDesignation: 'ratlings.fixer.target-designation',
  earlyWarning: 'ratlings.battlemutt.early-warning',
  beast: 'ratlings.battlemutt.beast',
  bullgrynShield: 'ratlings.bullgryn.shield',
  bullgrynBrute: 'ratlings.bullgryn.brute',
  bullgrynSlowWitted: 'ratlings.bullgryn.slow-witted',
  bayonetCharge: 'ratlings.ogryn.bayonet-charge',
  ogrynBrute: 'ratlings.ogryn.brute',
  ogrynSlowWitted: 'ratlings.ogryn.slow-witted',
  tripwire: 'ratlings.bomber.tripwire',
  mine: 'ratlings.bomber.mine',
  hunter: 'ratlings.hardbit.hunter',
  lieInWait: 'ratlings.hardbit.lie-in-wait',
  grapplingHook: 'ratlings.raider.grappling-hook',
  evade: 'ratlings.sneak.evade',
  lightFingered: 'ratlings.stashmaster.light-fingered',
  wellStocked: 'ratlings.stashmaster.well-stocked',
} as const;

export const ACT = {
  slingshot: 'ratlings.raider.act.slingshot',
  optics: 'ratlings.sneak.act.optics',
  spot: 'ratlings.spotter.act.spot',
  intercept: 'ratlings.vox-thief.act.intercept-communications',
} as const;

/** Effect ids (namespaced scratch — never module-level state, architecture rule 7). */
export const EFF = {
  /** The weapon the operative last shot with, so "…with a rifle" can be tested after the shot. */
  shotWeapon: 'ratlings.shotWeapon',
  targetDesignation: 'ratlings.targetDesignation',
  spot: 'ratlings.spot',
  optics: 'ratlings.optics',
  hunterCharge: 'ratlings.hunterCharge',
  larcenous: 'ratlings.larcenous',
  slingshot: 'ratlings.slingshot',
  rations: 'ratlings.rations',
  luckyRound: 'ratlings.luckyRound',
  tripwireApl: 'ratlings.tripwireApl',
  interceptApl: 'ratlings.interceptApl',
} as const;

export const TRIPWIRE_MARKER = (player: PlayerId, n: number): string => `ratlings.tripwire.${player}.${n}`;
export const WELL_STOCKED_MARKER = (player: PlayerId): string => `ratlings.ammoCache.${player}`;

export const SNIPER_POSITIONS_SHOOT = 'Shoot (Sniper Positions)';
export const HUNTER_CHARGE = 'Charge (Hunter)';
export const LARCENOUS_PICK_UP = 'Pick Up Marker (Larcenous)';

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

/** The selection block's own designer note defines "rifle" by name. */
export const isRifle = (weaponName: string): boolean => /rifle/i.test(weaponName);

/** "(excluding OGRYN or BULLGRYN)" — the two big operatives every Ratling rule carves out. */
const isBig = (T: TeamHooks, op: OperativeState): boolean => T.kw(op, 'OGRYN') || T.kw(op, 'BULLGRYN');

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? { shape: 'round', mm: 25 };

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

const objectiveMarkers = (state: GameState): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'objective');

const MARKER_BASE: BaseShape = { shape: 'round', mm: 20 };

function seenBy(ctx: GameContext, state: GameState, watcher: OperativeState, op: OperativeState): boolean {
  return isVisible(terrain(ctx, state), body(ctx, watcher), body(ctx, op)).visible;
}

/**
 * "…not visible to every enemy operative".
 *
 * Read as "no enemy operative can see it" — the hiding clause it is attached to (Scarper,
 * Early Warning, SHOOT AND HIDE) is worthless under the literal "at least one enemy cannot
 * see it" reading, which is true on almost every board position.
 */
function hiddenFromAllEnemies(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  return T.enemies(state).every((e) => !seenBy(T.ctx!, state, e, op));
}

/** "…is more than x" from enemy operatives" — base to base, every enemy. */
function fartherThanFromEnemies(T: TeamHooks, state: GameState, op: OperativeState, inches: number): boolean {
  return T.enemies(state).every((e) => T.gap(op, e) > inches + EPS);
}

function terrainWithin(T: TeamHooks, state: GameState, op: OperativeState, inches: number, types: ('Heavy' | 'Light')[]): boolean {
  if (!T.ctx) return false;
  const index = terrain(T.ctx, state);
  const base = baseOf(T, op);
  return index.parts.some(
    (p) => types.some((t) => hasType(p, t)) && baseDistanceToPart(op.pos, base, op.rot, p) <= inches + EPS,
  );
}

/** Does this operative carry a weapon whose name says "rifle"? */
function carriesRifle(ctx: GameContext, state: GameState, op: OperativeState): boolean {
  return weaponsOf(ctx, state, op, 'ranged').some((w) => isRifle(w.name));
}

/**
 * `onBlockAllocation` does not carry the die being resolved, so "if it's a critical success"
 * is read off the strike-or-block choice the reducer logs immediately before it calls
 * `resolveFightDie` ("strikeOrBlock: Block with the critical success"). A `dieWasCrit` field
 * on the event would make this exact — reported as a seam.
 */
function blockedWithCrit(state: GameState): boolean {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.kind !== 'decision') continue;
    return /^strikeOrBlock: Block with the critical/.test(entry.text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Faction rule — Scarper
// ---------------------------------------------------------------------------

const scarperKey = (op: OperativeState): string => `ratlings.scarper:${op.id}`;

/** Everything of ours that hands out `grantFreeAction`, for the AP book-keeping below. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([RULE.scarper, A.evade, A.earlyWarning]);

/** Operatives eligible for Scarper right now, lowest id first (the deterministic default). */
export function scarperCandidates(T: TeamHooks, state: GameState): OperativeState[] {
  return T.friendlies(state, KW)
    .filter((o) => !isBig(T, o) && !T.kw(o, 'SNEAK') && !usedThisTP(state, scarperKey(o)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function factionRule(reg: HookRegistry, T: TeamHooks): void {
  /*
   * "After each enemy operative's activation, before the next operative is activated, you can
   *  perform a free Dash action with one friendly RATLING operative (excluding BULLGRYN, OGRYN
   *  and SNEAK)… Each friendly operative can only do this once per turning point, and cannot do
   *  so after the final activation of the turning point."
   *
   * The engine has no intent for acting outside an activation, so the free Dash is one extra AP
   * restricted to Dash (docs/DECISIONS.md D-015) and lands on that operative's next activation.
   * Which operative takes it is the deterministic lowest-id default (D-016).
   *
   * REMINDER-ONLY: "but it cannot end that move within 3" of an enemy operative unless it's not
   * visible to every enemy operative when it ends that move" — no hook constrains where a move
   * ends. `scarperEndPositionLegal` below is exported so the UI can enforce it.
   */
  reg.on('onActivationEnd', T.bind(RULE.scarper, 11), (ev) => {
    if (ev.operative.player === T.player) return; // "After each ENEMY operative's activation"
    // "…and cannot do so after the final activation of the turning point."
    if (!aliveOperatives(ev.state).some((o) => o.ready)) return;
    const op = scarperCandidates(T, ev.state)[0];
    if (!op) return;
    useOncePerTP(ev.state, scarperKey(op));
    grantFreeAction(ev.state, op, {
      sourceId: RULE.scarper,
      sourceText: shortQuote(text(RULE.scarper)),
      threshold: currentApl(T, ev.state, op),
      kind: 'ability',
      only: ['Dash'],
    });
  });
}

/**
 * "…it cannot end that move within 3" of an enemy operative unless it's not visible to every
 * enemy operative when it ends that move." Exported for the UI/AI: the engine has no
 * end-of-move seam, so nothing in the reducer can refuse the move.
 */
export function scarperEndPositionLegal(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  end: Vec2,
  inches = 3,
): boolean {
  const ghost: OperativeState = { ...op, pos: end };
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return true;
  const enemies = aliveOperatives(state, otherPlayer(op.player));
  const near = enemies.some((e) => {
    const ec = ctx.datacards.get(e.datacardId);
    return ec !== undefined && baseGap(end, card.base, op.rot, e.pos, ec.base, e.rot) <= inches + EPS;
  });
  if (!near) return true;
  return enemies.every((e) => !isVisible(terrain(ctx, state), body(ctx, e), body(ctx, ghost)).visible);
}

// ---------------------------------------------------------------------------
// Datacard abilities
// ---------------------------------------------------------------------------

const BEAST_ACTIONS = ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition'];

function abilities(reg: HookRegistry, T: TeamHooks): void {
  // ---- FIXER › Munitorum Contacts ---------------------------------------
  // REMINDER-ONLY. "You can select one additional equipment option." The reducer caps
  // `SelectEquipment` at four before any hook runs (`src/core/reducer.ts`), exactly as the
  // Deathwatch's Adaptable Armoury does, so there is nothing for a team rule to widen.

  // ---- FIXER › Target Designation (STRATEGIC GAMBIT) --------------------
  reg.on('gambitOptions', T.bind(A.targetDesignation, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.fixer)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: A.targetDesignation,
      label: 'Target Designation (STRATEGIC GAMBIT)',
      sourceText: shortQuote(abilityText(CARD.fixer, A.targetDesignation)),
    });
  });
  reg.on('onPloyUsed', T.bind(A.targetDesignation, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== A.targetDesignation) return;
    // "Select one enemy operative." D-016: from the intent's `data`, else the lowest-id enemy.
    const enemies = T.enemies(ev.state).sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosenId = ev.data?.['operativeId'];
    const target = enemies.find((e) => e.id === chosenId) ?? enemies[0];
    if (!target) return;
    effect(ev.state, {
      rule: EFF.targetDesignation,
      source: { kind: 'ability', id: A.targetDesignation },
      sourceText: shortQuote(abilityText(CARD.fixer, A.targetDesignation)),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Target Designation: ${target.name}` });
  });
  // "…whenever a friendly RATLING operative is shooting that enemy operative with a rifle,
  //  that weapon has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(A.targetDesignation, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !isRifle(ev.weaponName)) return;
    if (!ev.target) return;
    const token = effectOn(ev.state, ev.target.id, EFF.targetDesignation);
    if (!token || token.player !== T.player) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Target Designation)'));
  });

  // ---- BATTLEMUTT › Early Warning ---------------------------------------
  /*
   * "Once per turning point, after an enemy operative performs an action in which it moves or
   *  is set up, you can interrupt to use this rule. If you do, each friendly RATLING operative
   *  (excluding OGRYN and BULLGRYN) within 6" of this operative and within 2" of that enemy
   *  operative can immediately perform a free Dash or Fall Back action…, but it cannot move
   *  more than 3" during that action."
   *
   * PARTIAL: nothing runs at the end of an action, so the interrupt is taken at the end of the
   * enemy's activation instead (the same bound as Legionary's MALIGNANT AURA). The 3" cap IS
   * enforced, through `onMoveDistance`. The end-of-move restriction is reminder-only.
   */
  reg.on('onActivationEnd', T.bind(A.earlyWarning, 11), (ev) => {
    if (ev.operative.player === T.player) return;
    const moved = ev.operative.actionsThisActivation.some((a) =>
      ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'].includes(a),
    );
    if (!moved) return;
    const mutts = T.friendlies(ev.state).filter((o) => o.datacardId === CARD.battlemutt);
    if (mutts.length === 0) return;
    if (usedThisTP(ev.state, `ratlings.earlyWarning:${T.player}`)) return;
    const eligible = T.friendlies(ev.state, KW).filter(
      (o) =>
        !isBig(T, o) &&
        T.gap(o, ev.operative) <= 2 + EPS &&
        mutts.some((m) => m.id !== o.id && T.gap(m, o) <= 6 + EPS),
    );
    if (eligible.length === 0) return;
    useOncePerTP(ev.state, `ratlings.earlyWarning:${T.player}`);
    for (const o of eligible) {
      grantFreeAction(ev.state, o, {
        sourceId: A.earlyWarning,
        sourceText: shortQuote(abilityText(CARD.battlemutt, A.earlyWarning)),
        threshold: currentApl(T, ev.state, o),
        kind: 'ability',
        only: ['Dash', 'Fall Back'],
      });
    }
  });
  // "…but it cannot move more than 3" during that action."
  reg.on('onMoveDistance', T.bind(A.earlyWarning, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const eff = effectsOn(ev.state, ev.operative.id, FREE_ACTION_RULE).find(
      (e) => e.source.id === A.earlyWarning,
    );
    if (!eff) return;
    if (ev.operative.apSpent < Number(eff.data?.['threshold'] ?? 0)) return;
    if (ev.action !== 'Dash' && ev.action !== 'Fall Back') return;
    ev.inches = Math.min(ev.inches, 3);
  });

  // ---- BATTLEMUTT › Beast -----------------------------------------------
  reg.on('canPerformAction', T.bind(A.beast, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.battlemutt) return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (!BEAST_ACTIONS.includes(key)) {
      ev.allowed = false;
      ev.reason = 'a BATTLEMUTT can only Charge, Dash, Fall Back, Fight and Reposition';
    }
  });
  // "It cannot use any weapons that aren't on its datacard."
  reg.on('availableWeapons', T.bind(A.beast, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.battlemutt) return;
    const own = new Set(cardOf(CARD.battlemutt).weapons.map((w) => w.name));
    ev.weapons = ev.weapons.filter((n) => own.has(n));
  });

  // ---- BULLGRYN › Shield -------------------------------------------------
  // "If this operative has a slabshield, it has a 3+ Save stat…"
  reg.on('onStatMod', T.bind(A.bullgrynShield, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.bullgryn) return;
    if (!T.ctx) return;
    if (!weaponsOf(T.ctx, ev.state, ev.operative).some((w) => /slabshield/i.test(w.name))) return;
    const printed = T.card(ev.operative)?.save ?? 4;
    ev.mods.save += printed - 3; // improving a Save lowers the number
  });
  // "…if it has a brute shield, whenever it's fighting or retaliating, each of your blocks can
  //  be allocated to block two unresolved successes (instead of one)."
  reg.on('onBlockAllocation', T.bind(A.bullgrynShield, 12), (ev) => {
    const blocker = ev.ctx.attacker; // `attacker` is whoever is resolving the die
    if (blocker.player !== T.player || blocker.datacardId !== CARD.bullgryn) return;
    if (!T.ctx) return;
    if (!weaponsOf(T.ctx, ev.state, blocker).some((w) => /brute shield/i.test(w.name))) return;
    ev.blocks = Math.max(ev.blocks, 2);
  });

  // ---- BULLGRYN / OGRYN › Brute -----------------------------------------
  /*
   * "Whenever your opponent is selecting a valid target, if this operative has a Conceal order,
   *  it cannot use Light terrain for cover. While this can allow this operative to be targeted
   *  (assuming it's visible), it doesn't remove its cover save (if any)."
   *
   * `ignoreCoverTerrain: 'light'` makes it targetable, but the same flag also feeds the cover
   * SAVE, so the save is put back at `onDefenceDice` — which is exactly the second sentence.
   */
  for (const [cardId, abilityId] of [
    [CARD.bullgryn, A.bullgrynBrute],
    [CARD.ogryn, A.ogrynBrute],
  ] as const) {
    reg.on('onValidTarget', T.bind(abilityId, 12), (ev) => {
      if (ev.target.player !== T.player || ev.target.datacardId !== cardId) return;
      if (ev.target.order !== 'conceal') return;
      if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
    });
    reg.on('onDefenceDice', T.bind(abilityId, 12), (ev) => {
      const target = ev.ctx.defender;
      if (!target || target.player !== T.player || target.datacardId !== cardId) return;
      if (target.order !== 'conceal' || ev.coverSave) return;
      const seq = shootSeq(ev.state);
      if (!seq || seq.step !== 'rollDefence') return;
      if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
      if (!T.ctx) return;
      // Cover as the core would have found it WITHOUT this rule's Light carve-out: Seek,
      // Seek Light and the Vantage denial all still take the cover save away.
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
  }

  // ---- BULLGRYN / OGRYN › Slow-witted ------------------------------------
  // "You must spend 1 additional AP for this operative to perform the Pick Up Marker and
  //  mission actions (excluding Operate Hatch)."
  for (const [cardId, abilityId] of [
    [CARD.bullgryn, A.bullgrynSlowWitted],
    [CARD.ogryn, A.ogrynSlowWitted],
  ] as const) {
    reg.on('onActionCost', T.bind(abilityId, 12), (ev) => {
      if (ev.operative.player !== T.player || ev.operative.datacardId !== cardId) return;
      if (ev.action === 'Operate Hatch') return;
      const def = allActions().find((a) => a.id === ev.action);
      const key = def?.treatedAs ?? ev.action;
      if (key !== 'Pick Up Marker' && def?.type !== 'mission') return;
      ev.ap += 1;
    });
  }

  // ---- OGRYN › Bayonet Charge -------------------------------------------
  /*
   * "Whenever this operative finishes moving during the Charge action, you can inflict D3+1
   *  damage on one enemy operative within its control range."
   *
   * PARTIAL: nothing runs at the end of an action (docs/TEAM-STATUS.md § Known engine gaps),
   * so the D3+1 lands at the end of the activation the Charge happened in — the same shift as
   * Nemesis Claw's WE HAVE COME FOR YOU. It is free and always beneficial, so it is auto-used
   * on a stated policy (D-022): the enemy in control range with the fewest wounds left.
   */
  reg.on('onActivationEnd', T.bind(A.bayonetCharge, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.ogryn) return;
    if (!op.actionsThisActivation.includes('Charge')) return;
    if (!T.ctx || op.incapacitated || op.removed) return;
    const victims = T.enemies(ev.state)
      .filter((e) => T.gap(op, e) <= 1 + EPS)
      .sort((a, b) => a.wounds - b.wounds || (a.id < b.id ? -1 : 1));
    const victim = victims[0];
    if (!victim) return;
    const damage = T.ctx.rng.d3() + 1;
    recordRoll(ev.state, 'bayonetCharge', [damage], T.player, 'Bayonet Charge D3+1');
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Bayonet Charge: ${op.name} inflicts ${damage} on ${victim.name}`,
    });
    inflictDamage(T.ctx, ev.state, victim, damage, 'other');
  });

  // ---- BOMBER › Tripwire -------------------------------------------------
  /*
   * "When setting up equipment before the battle, you can set up to two of your Tripwire
   *  markers up wholly within your territory and more than 2" from other markers, access points
   *  and Accessible terrain… If it cannot be placed, move it the minimum amount to do so."
   *
   * Faction markers are not part of the universal equipment kit (`src/core/equipment/kit.ts`),
   * so they are placed at the first friendly deployment on the deterministic default position
   * D-016 asks for: the legal square closest to the centre of the killzone.
   *
   * PARTIAL: `checkMines` is core-only and `applyMove` emits no marker-trigger hook, so the
   * trap springs at the activation boundary (the Scout Squad's Booby Trap partial) and
   * "end its action (if any)" cannot be honoured.
   */
  const placeTripwires = (state: GameState): void => {
    if (!T.ctx) return;
    if (!T.friendlies(state).some((o) => o.datacardId === CARD.bomber)) return;
    if (!useOncePerBattle(state, `ratlings.tripwire:${T.player}`)) return;
    for (let n = 0; n < 2; n++) {
      const pos = tripwirePosition(T.ctx, state, T.player);
      if (!pos) return;
      placeTeamMarker(state, {
        id: TRIPWIRE_MARKER(T.player, n),
        kind: 'generic',
        player: T.player,
        pos,
        flags: { tripwire: true },
      });
    }
    log(state, { kind: 'system', player: T.player, text: 'Tripwire markers set up' });
  };
  reg.on('onDeploy', T.bind(A.tripwire, 11), (ev) => {
    if (ev.operative.player === T.player) placeTripwires(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.tripwire, 11), (ev) => {
    if (ev.operative.player === T.player) placeTripwires(ev.state);
  });
  // "The first time that marker is within an enemy operative's control range, remove that
  //  marker, subtract 1 from that operative's APL stat until the end of its next activation…"
  reg.on('onActivationEnd', T.bind(A.tripwire, 13), (ev) => {
    if (!T.ctx) return;
    for (const marker of Object.values(ev.state.markers)) {
      if (marker.flags['tripwire'] !== true || marker.owner !== T.player) continue;
      const victim = T.enemies(ev.state).find((e) => markerContestedBy(T.ctx!, ev.state, marker, e));
      if (!victim) continue;
      removeMarker(ev.state, marker.id);
      victim.aplMods.push(-1);
      effect(ev.state, {
        rule: EFF.tripwireApl,
        source: { kind: 'ability', id: A.tripwire },
        sourceText: shortQuote(abilityText(CARD.bomber, A.tripwire)),
        operativeId: victim.id,
        player: T.player,
        // `armed` false only when the victim's own activation is the one ending right now, so
        // the penalty covers its NEXT activation either way.
        expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: victim.id !== ev.operative.id },
      });
      log(ev.state, { kind: 'action', player: T.player, text: `${victim.name} trips a Tripwire (-1 APL)` });
    }
  });

  // ---- BOMBER › Mine -----------------------------------------------------
  /*
   * "Mines you select from universal equipment inflict 2D3+3 damage instead, and friendly
   *  RATLING operatives (excluding OGRYN and BULLGRYN) are ignored for your mines' effects
   *  (i.e. they cannot trigger or take damage from them)."
   *
   * PARTIAL: `checkMines` lives inside `applyMove`, is hard-wired to D3+3 and emits nothing, so
   * "cannot trigger" is unreachable and the extra D3 is added at `onDamage`. `onDamage` carries
   * no marker, so "your mines" is inferred from the last recorded roll being the core Mines
   * roll plus this kill team having selected Mines — reported as a seam.
   */
  const ourMines = (state: GameState): boolean =>
    hasEquipment(state, T.player, 'eq.mines') &&
    T.friendlies(state).some((o) => o.datacardId === CARD.bomber) &&
    state.rolls[state.rolls.length - 1]?.kind === 'mine';
  reg.on('onDamage', T.bind(A.mine, 12), (ev) => {
    if (ev.kind !== 'mine' || !T.ctx) return;
    if (T.mine(ev.target) && T.kw(ev.target, KW) && !isBig(T, ev.target)) {
      if (!ourMines(ev.state)) return;
      ev.amount = 0; // "…they cannot … take damage from them"
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.target.name} ignores your Mines` });
      return;
    }
    if (ev.target.player === T.player || !ourMines(ev.state)) return;
    const extra = T.ctx.rng.d3();
    recordRoll(ev.state, 'mine', [extra], T.player, 'Mine (BOMBER) extra D3');
    ev.amount += extra; // D3+3 -> 2D3+3
  });

  // ---- HARDBIT › Hunter --------------------------------------------------
  // The Conceal-order Charge is its own action (D-021) below; this is the rider.
  reg.on('onCollectAttackDice', T.bind(A.hunter, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== CARD.hardbit) return;
    if (!/combat knife/i.test(ev.ctx.weaponName)) return;
    if (!effectOn(ev.state, op.id, EFF.hunterCharge)) return;
    ev.mods.atk += 1; // "add 1 to the Atk stat of its combat knife"
  });
  reg.on('onWeaponRules', T.bind(A.hunter, 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.datacardId !== CARD.hardbit) return;
    if (ev.operative.player !== T.player || !/combat knife/i.test(ev.weaponName)) return;
    if (!effectOn(ev.state, ev.operative.id, EFF.hunterCharge)) return;
    ev.rules.push(ruleTag('Brutal', undefined, 'Brutal (Hunter)'));
  });

  // ---- HARDBIT › Lie in Wait --------------------------------------------
  // "Whenever this operative is retaliating while Light or Heavy terrain is within its control
  //  range, you resolve the first attack dice (i.e. defender instead of attacker)."
  reg.on('onCollectAttackDice', T.bind(A.lieInWait, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== CARD.hardbit) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return; // "while retaliating"
    if (!terrainWithin(T, ev.state, op, 1, ['Light', 'Heavy'])) return;
    seq.turn = 'defender';
  });

  // ---- RAIDER › Grappling Hook ------------------------------------------
  // REMINDER-ONLY. "Whenever this operative is climbing up, you can treat the vertical distance
  // as 2"." `validateMove` charges each climb leg internally and `onMoveRules` is declared but
  // never emitted, so there is no per-leg seam (docs/TEAM-STATUS.md § Known engine gaps — the
  // same gap as the Scout Squad's and Phobos' Grapnel Launcher).

  // ---- SNEAK › Evade -----------------------------------------------------
  // "Once per turning point, after an enemy operative performs an action, you can interrupt and
  //  perform a free Dash action with this operative." D-015 again; the SNEAK is printed out of
  //  Scarper because it has this instead.
  reg.on('onActivationEnd', T.bind(A.evade, 11), (ev) => {
    if (ev.operative.player === T.player) return;
    for (const sneak of T.friendlies(ev.state).filter((o) => o.datacardId === CARD.sneak)) {
      if (!useOncePerTP(ev.state, `ratlings.evade:${sneak.id}`)) continue;
      grantFreeAction(ev.state, sneak, {
        sourceId: A.evade,
        sourceText: shortQuote(abilityText(CARD.sneak, A.evade)),
        threshold: currentApl(T, ev.state, sneak),
        kind: 'ability',
        only: ['Dash'],
      });
    }
  });

  // ---- STASHMASTER › Light-fingered -------------------------------------
  // "Once during each of this operative's activations, it can perform the Pick Up Marker, Place
  //  Marker or a mission action for 1 less AP." `onActionCost` is a pure query, so the use is
  //  spent by the FIRST such action of the activation rather than by a flag.
  reg.on('onActionCost', T.bind(A.lightFingered, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.stashmaster) return;
    const def = allActions().find((a) => a.id === ev.action);
    const key = def?.treatedAs ?? ev.action;
    const qualifies = (id: string, type?: string): boolean =>
      id === 'Pick Up Marker' || id === 'Place Marker' || type === 'mission';
    if (!qualifies(key, def?.type)) return;
    const alreadyDiscounted = ev.operative.actionsThisActivation.some((a) => {
      const d = allActions().find((x) => (x.treatedAs ?? x.id) === a || x.id === a);
      return qualifies(a, d?.type);
    });
    if (alreadyDiscounted) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- STASHMASTER › Well Stocked ---------------------------------------
  // "If you select an Ammo Cache from universal equipment, you can set up an additional Ammo
  //  Cache marker." The universal kit places one item per option and a team cannot add to it,
  //  so the extra marker is set up at deployment on the deterministic default position (D-016).
  reg.on('onDeploy', T.bind(A.wellStocked, 11), (ev) => {
    if (ev.operative.player !== T.player || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, 'eq.ammoCache')) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.stashmaster)) return;
    if (ev.state.markers[WELL_STOCKED_MARKER(T.player)]) return;
    const pos = markerPositionInTerritory(T.ctx, ev.state, T.player);
    if (!pos) return;
    placeTeamMarker(ev.state, {
      id: WELL_STOCKED_MARKER(T.player),
      kind: 'ammoCache',
      player: T.player,
      pos,
    });
    log(ev.state, { kind: 'system', player: T.player, text: 'Well Stocked: an additional Ammo Cache marker' });
  });
}

// ---------------------------------------------------------------------------
// Book-keeping shared by several rules
// ---------------------------------------------------------------------------

function bookkeeping(reg: HookRegistry, T: TeamHooks): void {
  // Remember the weapon each of our operatives last shot with, so "…performs the Shoot action
  // with a rifle" can be tested AFTER the shot (SHOOT AND HIDE).
  reg.on('onCollectAttackDice', T.bindText('ratlings.shotWeapon', text(FP.shootAndHide), 5), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, EFF.shotWeapon);
    if (existing) existing.data = { weaponName: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: EFF.shotWeapon,
        source: { kind: 'core', id: FP.shootAndHide },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weaponName: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  /*
   * "…until the end of that sequence" (PURLOINED RATIONS, LUCKY ROUND). The engine's
   * `endOfAction` expiry is only swept at the end of the turning point (`expireEffects` in
   * `src/core/phases.ts`), so the two effects are cleared here instead: `onSelectWeapon` is
   * emitted once at the top of every `startShoot`, which is exactly the start of the next
   * sequence. Reported as a seam.
   */
  reg.on('onSelectWeapon', T.bindText('ratlings.sequenceUpkeep', text(EQ.purloinedRations), 5), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    if (ev.ctx.attacker.player !== T.player) return;
    dropEffects(
      ev.state,
      (e) => (e.rule === EFF.rations || e.rule === EFF.luckyRound) && e.operativeId === ev.ctx.attacker.id,
    );
  });

  /*
   * `grantFreeAction` models a free action as one extra AP (D-015) by pushing a +1 into
   * `aplMods`, which the engine never pops. Scarper hands one out after EVERY enemy activation,
   * so without this the whole kill team would sit on APL 3 for the rest of the battle. The same
   * clean-up removes the ±1 of our own "until the end of its next activation" APL effects once
   * their window has closed. Reported as a seam.
   */
  const APL_EFFECTS: { rule: string; delta: number }[] = [
    { rule: EFF.tripwireApl, delta: -1 },
    { rule: EFF.interceptApl, delta: 1 },
  ];
  const upkeep = (state: GameState, op: OperativeState): void => {
    dropEffects(state, (e) => (e.rule === EFF.rations || e.rule === EFF.luckyRound) && e.operativeId === op.id);
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      const at = op.aplMods.lastIndexOf(1);
      if (at >= 0) op.aplMods.splice(at, 1);
      dropEffects(state, (e) => e === eff);
    }
    for (const { rule, delta } of APL_EFFECTS) {
      for (const eff of effectsOn(state, op.id, rule)) {
        if (eff.expiry.kind !== 'endOfNextActivation' || !eff.expiry.armed) continue;
        const at = op.aplMods.lastIndexOf(delta);
        if (at >= 0) op.aplMods.splice(at, 1);
      }
    }
  };
  reg.on('onActivationEnd', T.bindText('ratlings.aplUpkeep', text(RULE.scarper), 90), (ev) => {
    upkeep(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('ratlings.aplUpkeep', text(RULE.scarper), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) upkeep(ev.state, o);
  });

  // OPTICS ends "until the start of this operative's next activation" — exactly, rather than
  // through the engine's `endOfNextActivation` expiry, which runs one activation long.
  reg.on('onActivationStart', T.bindText(ACT.optics, actionText(CARD.sneak, ACT.optics), 5), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === EFF.optics && e.operativeId === ev.operative.id);
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

/** SNIPER POSITIONS' condition, shared by the weapon-rule grant and the Conceal-order Shoot. */
export function sniperPositionsActive(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!gambitUsed(state, op.player, SP.sniperPositions)) return false;
  if (!T.kw(op, KW)) return false;
  return fartherThanFromEnemies(T, state, op, 6) && terrainWithin(T, state, op, 1, ['Heavy']);
}

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- SNIPER POSITIONS (strategy) --------------------------------------
  // "…the stationary profile of its rifle (if any) has the Silent weapon rule."
  reg.on('onWeaponRules', T.bind(SP.sniperPositions, 20), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!isRifle(ev.weaponName) || (ev.profile.name ?? '') !== 'stationary') return;
    if (!sniperPositionsActive(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Silent', undefined, 'Silent (Sniper Positions)'));
  });

  // ---- SHIFTY (strategy) -------------------------------------------------
  /*
   * "Whenever a friendly RATLING operative (excluding OGRYN or BULLGRYN) has a Conceal order
   *  and is in cover, it cannot be selected as a valid target, taking precedence over all other
   *  rules (e.g. Seek, Vantage terrain) except being within 2"."
   *
   * `onValidTarget` is emitted before the core computes cover, so cover is recomputed here with
   * the DEFAULT options — which is what "taking precedence over Seek and Vantage" means.
   */
  reg.on('onValidTarget', T.bind(SP.shifty, 25), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.shifty)) return;
    const target = ev.target;
    if (target.player !== T.player || !T.kw(target, KW) || isBig(T, target)) return;
    if (target.order !== 'conceal' || !T.ctx) return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    const cover = coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, ev.attacker), body(T.ctx, target));
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'SHIFTY: a concealed RATLING operative in cover cannot be selected';
  });

  // ---- CRACK SHOTS (strategy) -------------------------------------------
  reg.on('onWeaponRules', T.bind(SP.crackShots, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.crackShots)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !isRifle(ev.weaponName)) return;
    if (!ev.target || T.gap(ev.operative, ev.target) <= 6 + EPS) return; // "more than 6" from it"
    const moved = ['Charge', 'Fall Back', 'Reposition'].some((a) =>
      ev.operative.actionsThisActivation.includes(a),
    );
    if (moved && !counteracting(ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Crack Shots)'));
  });

  // ---- FRONTLINE ASSAULT (strategy) -------------------------------------
  // "…is shooting, fighting or retaliating, its weapons have the Balanced weapon rule."
  // `onWeaponRules` is read by both sequences, so all three cases are live.
  reg.on('onWeaponRules', T.bind(SP.frontlineAssault, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.frontlineAssault)) return;
    if (!T.mineKw(ev.operative, KW) || !isBig(T, ev.operative)) return;
    const inEnemyTerritory = baseWithin(
      ev.operative.pos,
      baseOf(T, ev.operative),
      ev.operative.rot,
      ev.state.map.territories[otherPlayer(T.player)],
    );
    const nearObjective = objectiveMarkers(ev.state).some((m) => T.markerGap(ev.operative, m) <= 3 + EPS);
    if (!inEnemyTerritory && !nearObjective) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Frontline Assault)'));
  });

  // ---- SURVIVAL INSTINCTS (firefight) -----------------------------------
  /*
   * "…and you're allocating a dice to block. If it's a normal success, it can block one
   *  unresolved critical success; if it's a critical success, it can block two unresolved
   *  successes (normal or critical)."
   *
   * PARTIAL: the fighting half is live through `onBlockAllocation`. The SHOOTING half has no
   * seam at all — defence dice are allocated by `allocateSavesOptimally` in `src/core/dice.ts`,
   * which is a pure function the sequence calls without emitting anything. Reported as a seam.
   */
  reg.on('onBlockAllocation', T.bind(FP.survivalInstincts, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.survivalInstincts)) return;
    const blocker = ev.ctx.attacker;
    if (blocker.player !== T.player || !T.kw(blocker, KW) || isBig(T, blocker)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId === blocker.id) return; // "an ENEMY operative is … fighting against"
    ev.normalsCanBlockCrits = true;
    if (blockedWithCrit(ev.state)) ev.blocks = Math.max(ev.blocks, 2);
  });

  // ---- LARCENOUS (firefight) --------------------------------------------
  /*
   * "Until the end of that activation, that operative doesn't have to control a marker to
   *  perform the Pick Up Marker or mission actions that usually require this…, and having an
   *  enemy operative within its control range doesn't prevent it from doing so."
   *
   * PARTIAL: the Pick Up Marker half is the `Pick Up Marker (Larcenous)` action below (D-021 —
   * `canPerformAction` can only forbid). The "or mission actions" half is REMINDER-ONLY: those
   * ActionDefs are registered by `src/core/ops/**` and a team cannot wrap an action it does not
   * own (the Warpcoven's Mutant Appendage has the identical partial).
   */
  reg.on('onPloyUsed', T.bind(FP.larcenous, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.larcenous) return;
    const op = larcenousCandidate(T, ev.state);
    if (!op) return;
    effect(ev.state, {
      rule: EFF.larcenous,
      source: { kind: 'ploy', id: FP.larcenous },
      sourceText: shortQuote(text(FP.larcenous)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Larcenous: ${op.name} only needs to contest a marker` });
  });

  // ---- SHARPSHOT (firefight) --------------------------------------------
  /*
   * "Having other friendly RATLING operatives within an enemy operative's control range doesn't
   *  prevent that enemy operative from being selected."
   *
   * The effect is exact. The trigger's "with a rifle" is widened to "carries a rifle", because
   * `onValidTarget` carries no weapon: it is emitted from `checkTarget`, which both `startShoot`
   * and `validTargets` call, and `state.sequence` is not yet set. Reported as a seam.
   */
  reg.on('onValidTarget', T.bind(FP.sharpshot, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.sharpshot)) return;
    if (ev.attacker.player !== T.player || !T.kw(ev.attacker, KW) || !T.ctx) return;
    if (!carriesRifle(T.ctx, ev.state, ev.attacker)) return;
    ev.ignoreFriendlyControlRange = true;
  });

  // ---- SHOOT AND HIDE (firefight) ---------------------------------------
  reg.on('onPloyUsed', T.bind(FP.shootAndHide, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.shootAndHide) return;
    const op = shootAndHideCandidate(T, ev.state);
    if (!op) return;
    op.order = 'conceal';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Shoot and Hide: ${op.name} takes a Conceal order` });
  });
}

/** "…during a friendly RATLING operative's activation (excluding OGRYN or BULLGRYN)." */
export function larcenousCandidate(T: TeamHooks, state: GameState): OperativeState | undefined {
  const id = state.activeOperativeId;
  const op = id ? state.operatives[id] : undefined;
  if (!op || op.player !== T.player || !T.kw(op, KW) || isBig(T, op)) return undefined;
  return op;
}

/**
 * "…after a friendly RATLING operative that has an Engage order performs the Shoot action with
 * a rifle. If it's more than 3" from enemy operatives, or not visible to every enemy operative…"
 */
export function shootAndHideCandidate(T: TeamHooks, state: GameState): OperativeState | undefined {
  const id = state.activeOperativeId;
  const op = id ? state.operatives[id] : undefined;
  if (!op || op.player !== T.player || !T.kw(op, KW) || op.order !== 'engage') return undefined;
  if (!op.actionsThisActivation.includes('Shoot')) return undefined;
  const shot = effectOn(state, op.id, EFF.shotWeapon)?.data?.['weaponName'];
  if (typeof shot !== 'string' || !isRifle(shot)) return undefined;
  if (fartherThanFromEnemies(T, state, op, 3) || hiddenFromAllEnemies(T, state, op)) return op;
  return undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- PURLOINED RATIONS -------------------------------------------------
  /*
   * "Once per turning point, when a friendly RATLING operative is shooting with a rifle and
   *  you've rolled your attack dice, you can use this rule. If you do, improve the Hit stat of
   *  its rifle by 1 until the end of that sequence."
   *
   * The improvement applies to dice that are ALREADY rolled, so the pool is reclassified in
   * place and an effect carries the Hit change through the rest of the sequence (re-rolls read
   * `hitOf`, which consults `onStatMod`). D-022: it is auto-used only when at least one rolled
   * fail would become a success, and the use is logged.
   */
  reg.on('onRollAttack', T.bind(EQ.purloinedRations, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.purloinedRations)) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW) || !isRifle(ev.ctx.weaponName)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    if (usedThisTP(ev.state, `ratlings.rations:${T.player}`)) return;
    if (!T.ctx) return;
    // The Hit stat the pool was rolled against, reproduced exactly (`hitStat` in shoot.ts).
    const rolledAt = hitOf(T.ctx, ev.state, ev.ctx.attacker, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    const improved = Math.max(2, rolledAt - 1);
    if (improved === rolledAt) return;
    const lethal = ev.ctx.rules.filter((r) => r.id === 'Lethal').reduce((m, r) => Math.min(m, r.x ?? 6), 6);
    const promotable = seq.attack.dice.filter((d) => d.rolled && d.state === 'fail' && d.value >= improved);
    if (promotable.length === 0) return;
    useOncePerTP(ev.state, `ratlings.rations:${T.player}`);
    effect(ev.state, {
      rule: EFF.rations,
      source: { kind: 'equipment', id: EQ.purloinedRations },
      sourceText: shortQuote(text(EQ.purloinedRations)),
      operativeId: ev.ctx.attacker.id,
      player: T.player,
      data: { weaponName: ev.ctx.weaponName },
      expiry: { kind: 'endOfAction' },
    });
    for (const die of promotable) {
      die.state = die.value >= lethal || die.value === 6 ? 'crit' : 'normal';
      die.note = 'Purloined Rations';
    }
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Purloined Rations: ${ev.ctx.weaponName} hits on ${improved}+ (${promotable.length} more success)`,
    });
  });
  reg.on('onStatMod', T.bind(EQ.purloinedRations, 31), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    const eff = effectOn(ev.state, ev.operative.id, EFF.rations);
    if (!eff || eff.player !== T.player) return;
    if (eff.data?.['weaponName'] !== seq.weaponName) return;
    ev.mods.hit += 1;
  });

  // ---- STOLEN GOODS ------------------------------------------------------
  // "At the end of the Select Operatives step, roll one D3."
  reg.on('onSelectEquipment', T.bind(EQ.stolenGoods, 30), (ev) => {
    if (ev.player !== T.player || !ev.equipment.includes(EQ.stolenGoods)) return;
    if (!T.ctx) return;
    if (!useOncePerBattle(ev.state, `ratlings.stolenGoods:${T.player}`)) return;
    const roll = T.ctx.rng.d3();
    recordRoll(ev.state, 'stolenGoods', [roll], T.player, 'Stolen Goods D3');
    const foe = otherPlayer(T.player);
    if (roll === 1) ev.state.teams[T.player].cp = Math.max(0, ev.state.teams[T.player].cp - 1);
    else if (roll === 2) ev.state.teams[T.player].cp += 1;
    else ev.state.teams[foe].cp = Math.max(0, ev.state.teams[foe].cp - 1);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Stolen Goods (${roll}): ${roll === 1 ? 'you lose 1CP' : roll === 2 ? 'you gain 1CP' : 'your opponent loses 1CP'}`,
    });
  });

  // ---- LUCKY ROUND -------------------------------------------------------
  // "…that weapon has the Severe weapon rule until the end of that sequence." Severe is applied
  // at the retention step, which runs after the attack dice are rolled, so the grant is made at
  // `onRollAttack` and read back through `onWeaponRules`. D-022 policy: only when Severe would
  // actually do something ("if you don't retain any critical successes").
  reg.on('onRollAttack', T.bind(EQ.luckyRound, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.luckyRound)) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW) || !isRifle(ev.ctx.weaponName)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id || seq.obscured) return;
    if (ev.ctx.rules.some((r) => r.id === 'Severe')) return;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
    if (crits > 0 || normals === 0) return;
    if (!useOncePerTP(ev.state, `ratlings.luckyRound:${T.player}`)) return;
    effect(ev.state, {
      rule: EFF.luckyRound,
      source: { kind: 'equipment', id: EQ.luckyRound },
      sourceText: shortQuote(text(EQ.luckyRound)),
      operativeId: ev.ctx.attacker.id,
      player: T.player,
      data: { weaponName: ev.ctx.weaponName },
      expiry: { kind: 'endOfAction' },
    });
    log(ev.state, { kind: 'dice', player: T.player, text: `Lucky Round: ${ev.ctx.weaponName} has Severe` });
  });
  reg.on('onWeaponRules', T.bind(EQ.luckyRound, 31), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, EFF.luckyRound);
    if (!eff || eff.player !== T.player || eff.data?.['weaponName'] !== ev.weaponName) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Lucky Round)'));
  });

  // ---- IMPROVISED ARMOUR -------------------------------------------------
  /*
   * "Whenever an operative is shooting a friendly RATLING BULLGRYN or friendly RATLING OGRYN
   *  operative, defence dice results of 5+ are critical successes."
   *
   * `addRolled(seq.defence, results, save)` is called without `ClassifyOpts`, so the defence
   * pool has no critical threshold to move. The `onDefenceDice` emit in the `defenceRerolls`
   * step happens AFTER the roll, so the pool is promoted there; it is idempotent, which matters
   * because the step re-emits after each re-roll. Reported as a seam (a `critOn` on the event).
   */
  reg.on('onDefenceDice', T.bind(EQ.improvisedArmour, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.improvisedArmour)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || !T.kw(target, KW) || !isBig(T, target)) return;
    let promoted = 0;
    for (const die of seq.defence.dice) {
      if (!die.rolled || die.value < 5) continue;
      if (die.state !== 'normal' && die.state !== 'fail') continue;
      die.state = 'crit';
      die.note = 'Improvised Armour';
      promoted++;
    }
    if (promoted > 0)
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `Improvised Armour: ${promoted} defence dice of 5+ are critical successes`,
      });
  });
}

// ---------------------------------------------------------------------------
// Actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * SNIPER POSITIONS grants Silent, and Silent's only mechanical effect in the engine is the
 * Conceal-order carve-out inside the universal Shoot action's `check` — which reads the RAW
 * profile rules, not `effectiveRules`. So the granted form is its own action (D-021).
 */
registerAction({
  id: SNIPER_POSITIONS_SHOOT,
  name: SNIPER_POSITIONS_SHOOT,
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: text(SP.sniperPositions),
  available: (ctx, state, op) => {
    const kws = ctx.datacards.get(op.datacardId)?.keywords ?? [];
    return kws.includes(KW) && state.teams[op.player].gambitsUsedTP.includes(SP.sniperPositions);
  },
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Shoot action with an Engage order' };
    if (!state.teams[op.player].gambitsUsedTP.includes(SP.sniperPositions))
      return { ok: false, reason: 'Sniper Positions has not been used this turning point' };
    if (!params.weaponName || !isRifle(params.weaponName)) return { ok: false, reason: 'select a rifle' };
    if ((params.profileName ?? '') !== 'stationary')
      return { ok: false, reason: 'only the stationary profile has the Silent weapon rule' };
    if (!snipeConditions(ctx, state, op))
      return { ok: false, reason: 'must be more than 6" from enemy operatives and within 1" of Heavy terrain' };
    // Everything else is the universal Shoot action, minus the order test.
    return getAction('Shoot')!.check(ctx, state, { ...op, order: 'engage' }, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

/** The context-free half of `sniperPositionsActive`, for the ActionDef above. */
function snipeConditions(ctx: GameContext, state: GameState, op: OperativeState): boolean {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return false;
  const enemies = aliveOperatives(state, otherPlayer(op.player));
  const far = enemies.every((e) => {
    const ec = ctx.datacards.get(e.datacardId);
    return ec === undefined || baseGap(op.pos, card.base, op.rot, e.pos, ec.base, e.rot) > 6 + EPS;
  });
  if (!far) return false;
  const index = terrain(ctx, state);
  return index.parts.some((p) => hasType(p, 'Heavy') && baseDistanceToPart(op.pos, card.base, op.rot, p) <= 1 + EPS);
}

/**
 * HARDBIT › Hunter: "This operative can perform the Charge action while it has a Conceal order."
 * The universal Charge refuses a Conceal order outright and `canPerformAction` can only forbid,
 * so the carve-out is its own action treated as Charge (D-021, the Kommandos' Throat Slittas).
 */
registerAction({
  id: HUNTER_CHARGE,
  name: HUNTER_CHARGE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(CARD.hardbit, A.hunter),
  available: (_ctx, _state, op) => op.datacardId === CARD.hardbit,
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
    return getAction('Charge')!.check(ctx, state, { ...op, order: 'engage' }, params);
  },
  perform(ctx, state, op, params) {
    const r = getAction('Charge')!.perform(ctx, state, op, params);
    if (!r.ok) return r;
    // "If it does so during its activation, until the end of that activation, add 1 to the Atk
    //  stat of its combat knife and that melee weapon has the Brutal weapon rule."
    if (state.opState['counteract']?.['operativeId'] !== op.id) {
      effect(state, {
        rule: EFF.hunterCharge,
        source: { kind: 'ability', id: A.hunter },
        sourceText: shortQuote(abilityText(CARD.hardbit, A.hunter)),
        operativeId: op.id,
        player: op.player,
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
    }
    return r;
  },
});

/**
 * LARCENOUS: "that operative doesn't have to control a marker… (it only needs to contest the
 * marker), and having an enemy operative within its control range doesn't prevent it from doing
 * so." Both conditions live inside the universal Pick Up Marker's own `check`, so the permitted
 * form is its own action (D-021).
 */
registerAction({
  id: LARCENOUS_PICK_UP,
  name: LARCENOUS_PICK_UP,
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: text(FP.larcenous),
  available: (_ctx, state, op) =>
    state.effects.some((e) => e.rule === EFF.larcenous && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === EFF.larcenous && e.operativeId === op.id))
      return { ok: false, reason: 'the Larcenous ploy has not been used on this operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker) return { ok: false, reason: 'no such marker' };
    if (!marker.flags['pickUpAllowed']) return { ok: false, reason: 'this marker cannot be picked up' };
    if (!markerContestedBy(ctx, state, marker, op)) return { ok: false, reason: 'it does not contest that marker' };
    return { ok: true };
  },
  perform: (ctx, state, op, params) => getAction('Pick Up Marker')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

interface SlingshotPlan {
  ok: boolean;
  reason?: string;
  point?: Vec2;
  dest?: Vec2;
}

/**
 * SLINGSHOT 1AP: "Select a point on a terrain feature; that point must be visible to and within
 * 6" of this operative. Remove this operative from the killzone and set it back up in a location
 * it can be placed wholly within 6" horizontally of that point, not within control range of enemy
 * operatives, and with that point visible to it."
 *
 * Pure and shared by `check` and `perform`, so whatever `check` accepts `perform` completes
 * (D-026). The point comes from the intent's `targetPos` where one is supplied, otherwise from a
 * deterministic scan (D-016); the destination is always derived, never taken from the caller.
 */
function planSlingshot(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): SlingshotPlan {
  const eng = notEngaged(ctx, state, op);
  if (!eng.ok) return { ok: false, reason: eng.reason ?? 'within control range of an enemy operative' };
  if (['Charge', 'Fall Back', 'Shoot'].some((a) => op.actionsThisActivation.includes(a)))
    return { ok: false, reason: 'already performed Charge, Fall Back or Shoot this activation' };
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  const points = slingshotPoints(ctx, state, op, params.targetPos);
  for (const point of points) {
    const dest = slingshotDestination(ctx, state, op, point);
    if (dest) return { ok: true, point, dest };
  }
  return { ok: false, reason: 'no point on a terrain feature this operative could be slung to' };
}

/** Candidate "point on a terrain feature": visible to and within 6" of the operative. */
function slingshotPoints(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  preferred: Vec2 | undefined,
): Vec2[] {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return [];
  const index = terrain(ctx, state);
  const me = body(ctx, op);
  const seen = new Set<string>();
  const out: { p: Vec2; z: number; d: number }[] = [];
  for (const part of index.parts) {
    if (part.role === 'accessPoint') continue;
    for (const vertex of part.poly) {
      const key = `${vertex.x.toFixed(2)},${vertex.y.toFixed(2)},${part.z1.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = baseGap(op.pos, card.base, op.rot, vertex, MARKER_BASE, 0);
      if (d > 6 + EPS) continue;
      const pointBody = { id: 'slingshot', pos: vertex, z: part.z1, rot: 0, base: MARKER_BASE, height: 0.2 };
      if (!isVisible(index, me, pointBody).visible) continue;
      out.push({ p: vertex, z: part.z1, d });
    }
  }
  // Deterministic order: a caller-supplied point first, then farthest-from-here, then by x/y.
  out.sort((a, b) => b.d - a.d || a.p.x - b.p.x || a.p.y - b.p.y);
  const ordered = out.map((o) => o.p);
  if (preferred) {
    const match = ordered.find((p) => dist(p, preferred) < 0.5);
    if (match) return [match, ...ordered.filter((p) => p !== match)].slice(0, 12);
  }
  return ordered.slice(0, 12);
}

/** The best legal landing spot for one point, or undefined. */
function slingshotDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  point: Vec2,
): Vec2 | undefined {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return undefined;
  const index = terrain(ctx, state);
  let best: { pos: Vec2; gain: number } | undefined;
  for (let ring = 6; ring >= 1; ring--) {
    for (let step = 0; step < 12; step++) {
      const angle = (step * Math.PI) / 6;
      const pos = { x: point.x + Math.cos(angle) * ring, y: point.y + Math.sin(angle) * ring };
      if (dist(pos, op.pos) < 1) continue; // a slingshot that does not move it is not worth 1AP
      if (!canPlaceAt(ctx, state, op, pos)) continue;
      const z = surfaceAt(index, pos);
      const ghost: OperativeState = { ...op, pos, z };
      if (aliveOperatives(state, otherPlayer(op.player)).some((e) => baseGapTo(ctx, ghost, e) <= 1 + EPS)) continue;
      const pointBody = { id: 'slingshot', pos: point, z, rot: 0, base: MARKER_BASE, height: 0.2 };
      if (!isVisible(index, body(ctx, ghost), pointBody).visible) continue;
      const gain = dist(pos, op.pos);
      if (!best || gain > best.gain + EPS) best = { pos, gain };
    }
    if (best) return best.pos;
  }
  return best?.pos;
}

function baseGapTo(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return Infinity;
  return baseGap(a.pos, ca.base, a.rot, b.pos, cb.base, b.rot);
}

/** "…in a location it can be placed" — the same bar `DeployOperative` applies. */
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

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- RAIDER › SLINGSHOT ----------------------------------------------
    uniqueAction(data, CARD.raider, ACT.slingshot, {
      treatedAs: 'Reposition',
      check: (ctx, state, op, params) => {
        const plan = planSlingshot(ctx, state, op, params);
        return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'not possible' };
      },
      perform: (ctx, state, op, params) => {
        const plan = planSlingshot(ctx, state, op, params);
        if (!plan.ok || !plan.dest) return { ok: false, reason: plan.reason ?? 'not possible' };
        op.pos = { ...plan.dest };
        settleZ(ctx, state, op);
        op.onGuard = false;
        if (op.carryingMarkerId) {
          const m = state.markers[op.carryingMarkerId];
          if (m) {
            m.pos = { ...op.pos };
            m.z = op.z;
          }
        }
        // "(or vice versa)" — a Shoot after a SLINGSHOT is refused through `canPerformAction`.
        effect(state, {
          rule: EFF.slingshot,
          source: { kind: 'ability', id: ACT.slingshot },
          sourceText: shortQuote(actionText(CARD.raider, ACT.slingshot)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: SLINGSHOT to (${op.pos.x.toFixed(1)}, ${op.pos.y.toFixed(1)})`,
        });
        return { ok: true };
      },
    }),

    // ---- SNEAK › OPTICS ---------------------------------------------------
    uniqueAction(data, CARD.sneak, ACT.optics, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        effect(state, {
          rule: EFF.optics,
          source: { kind: 'ability', id: ACT.optics },
          sourceText: shortQuote(actionText(CARD.sneak, ACT.optics)),
          operativeId: op.id,
          player: op.player,
          // Removed at the start of this operative's next activation (see `bookkeeping`).
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: OPTICS` });
        return { ok: true };
      },
    }),

    // ---- SPOTTER › SPOT ---------------------------------------------------
    // DATA PROBLEM: the printed effect list ("If you do:" …) is missing from the JSON, so the
    // token is placed and nothing is applied. See the report.
    uniqueAction(data, CARD.spotter, ACT.spot, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return spotTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = spotTarget(ctx, state, op, params.targetOperativeId);
        if (!target) return { ok: false, reason: 'select one enemy operative visible to this operative' };
        effect(state, {
          rule: EFF.spot,
          source: { kind: 'ability', id: ACT.spot },
          sourceText: shortQuote(actionText(CARD.spotter, ACT.spot)),
          operativeId: target.id,
          player: op.player,
          data: { spotterId: op.id },
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: SPOT on ${target.name}` });
        return { ok: true };
      },
    }),

    // ---- VOX-THIEF › INTERCEPT COMMUNICATIONS -----------------------------
    uniqueAction(data, CARD.voxThief, ACT.intercept, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return interceptTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly RATLING operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = interceptTarget(ctx, state, op, params.targetOperativeId);
        if (!target) return { ok: false, reason: 'select one other friendly RATLING operative visible to and within 6"' };
        target.aplMods.push(1);
        effect(state, {
          rule: EFF.interceptApl,
          source: { kind: 'ability', id: ACT.intercept },
          sourceText: shortQuote(actionText(CARD.voxThief, ACT.intercept)),
          operativeId: target.id,
          player: op.player,
          // The target is not the active operative, so its NEXT activation end is the window's
          // close: `armed` starts true.
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: true },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: INTERCEPT COMMUNICATIONS — ${target.name} +1 APL`,
        });
        return { ok: true };
      },
    }),
  ];
}

function spotTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen: string | undefined,
): OperativeState | undefined {
  const enemies = aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return enemies.find((e) => e.id === chosen) ?? enemies[0];
}

function interceptTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen: string | undefined,
): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 6);
  const mates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter(
      (o) =>
        baseGapTo(ctx, op, o) <= range + EPS &&
        isVisible(terrain(ctx, state), body(ctx, op), body(ctx, o)).visible,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

// ---------------------------------------------------------------------------
// Deterministic marker placement (D-016)
// ---------------------------------------------------------------------------

function markerCandidates(state: GameState, player: PlayerId): Vec2[] {
  const { w, h } = state.map.board;
  const centre = { x: w / 2, y: h / 2 };
  const out: Vec2[] = [];
  for (let x = 1; x <= w - 1; x += 1) {
    for (let y = 1; y <= h - 1; y += 1) {
      const p = { x, y };
      if (!baseWhollyWithin(p, MARKER_BASE, 0, state.map.territories[player])) continue;
      out.push(p);
    }
  }
  out.sort((a, b) => dist(a, centre) - dist(b, centre) || a.x - b.x || a.y - b.y);
  return out;
}

/**
 * "wholly within your territory and more than 2" from other markers, access points and
 * Accessible terrain… If it cannot be placed, move it the minimum amount to do so."
 */
function tripwirePosition(ctx: GameContext, state: GameState, player: PlayerId): Vec2 | undefined {
  const index = terrain(ctx, state);
  const clear = (p: Vec2): boolean => {
    for (const m of Object.values(state.markers)) {
      if (baseGap(p, MARKER_BASE, 0, m.pos, { shape: 'round', mm: m.diameterMm }, 0) <= 2 + EPS) return false;
    }
    for (const part of index.parts) {
      if (part.role !== 'accessPoint' && !hasType(part, 'Accessible')) continue;
      if (baseDistanceToPart(p, MARKER_BASE, 0, part) <= 2 + EPS) return false;
    }
    return true;
  };
  const candidates = markerCandidates(state, player);
  return candidates.find(clear) ?? candidates[0];
}

function markerPositionInTerritory(ctx: GameContext, state: GameState, player: PlayerId): Vec2 | undefined {
  void ctx;
  const candidates = markerCandidates(state, player);
  const clear = (p: Vec2): boolean =>
    Object.values(state.markers).every(
      (m) => baseGap(p, MARKER_BASE, 0, m.pos, { shape: 'round', mm: m.diameterMm }, 0) > 2 + EPS,
    );
  return candidates.find(clear) ?? candidates[0];
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const ratlings = defineTeam({
  id: 'ratlings',
  rules: (reg, T) => {
    factionRule(reg, T);
    abilities(reg, T);
    bookkeeping(reg, T);

    // SLINGSHOT: "…or during an activation in which it performed the Charge, Fall Back or Shoot
    // action (or vice versa)." The Reposition key it is treated as already blocks Charge and
    // Fall Back; Shoot has to be refused explicitly.
    reg.on('canPerformAction', T.bindText(ACT.slingshot, actionText(CARD.raider, ACT.slingshot), 12), (ev) => {
      if (ev.operative.player !== T.player || ev.action !== 'Shoot') return;
      if (!effectOn(ev.state, ev.operative.id, EFF.slingshot)) return;
      ev.allowed = false;
      ev.reason = 'it performed SLINGSHOT this activation';
    });

    // OPTICS: "…whenever it's shooting, enemy operatives cannot be obscured and the stationary
    // profile of this operative's suppressed sniper rifle has the Lethal 5+ weapon rule."
    reg.on('onCollectAttackDice', T.bindText(ACT.optics, actionText(CARD.sneak, ACT.optics), 12), (ev) => {
      if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
      if (!effectOn(ev.state, ev.ctx.attacker.id, EFF.optics)) return;
      const seq = shootSeq(ev.state);
      if (seq) seq.obscured = false;
    });
    reg.on('onWeaponRules', T.bindText(ACT.optics, actionText(CARD.sneak, ACT.optics), 12), (ev) => {
      if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
      if (!/suppressed sniper rifle/i.test(ev.weaponName) || (ev.profile.name ?? '') !== 'stationary') return;
      if (!effectOn(ev.state, ev.operative.id, EFF.optics)) return;
      ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (OPTICS)'));
    });
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    [FP.larcenous]: (state, player) => {
      const id = state.activeOperativeId;
      const op = id ? state.operatives[id] : undefined;
      const card = op ? DATA.datacards.find((c) => c.id === op.datacardId) : undefined;
      const ok =
        op !== undefined &&
        op.player === player &&
        card !== undefined &&
        card.keywords.includes(KW) &&
        !card.keywords.includes('OGRYN') &&
        !card.keywords.includes('BULLGRYN');
      return ok ? { ok: true } : { ok: false, reason: 'use it during a friendly RATLING operative’s activation' };
    },
    [FP.shootAndHide]: (state, player) => {
      const id = state.activeOperativeId;
      const op = id ? state.operatives[id] : undefined;
      if (!op || op.player !== player || op.order !== 'engage' || !op.actionsThisActivation.includes('Shoot'))
        return { ok: false, reason: 'use it after a friendly RATLING operative performs the Shoot action' };
      const shot = state.effects.find((e) => e.rule === EFF.shotWeapon && e.operativeId === op.id)?.data?.[
        'weaponName'
      ];
      return typeof shot === 'string' && isRifle(shot)
        ? { ok: true }
        : { ok: false, reason: 'that Shoot action did not use a rifle' };
    },
  },
  aiHints: {
    roles: {
      [CARD.fixer]: 'leader',
      [CARD.battlemutt]: 'scout',
      [CARD.bullgryn]: 'melee',
      [CARD.ogryn]: 'melee',
      [CARD.bigShot]: 'sniper',
      [CARD.bomber]: 'gunner',
      [CARD.hardbit]: 'melee',
      [CARD.raider]: 'sniper',
      [CARD.sneak]: 'scout',
      [CARD.sniper]: 'sniper',
      [CARD.spotter]: 'support',
      [CARD.stashmaster]: 'objective',
      [CARD.voxThief]: 'support',
    },
    ployValue: {
      [SP.sniperPositions]: 0.5,
      [SP.shifty]: 0.6,
      [SP.crackShots]: 0.7,
      [SP.frontlineAssault]: 0.4,
      [FP.survivalInstincts]: 0.5,
      [FP.larcenous]: 0.4,
      [FP.sharpshot]: 0.5,
      [FP.shootAndHide]: 0.4,
    },
    equipmentValue: {
      [EQ.purloinedRations]: 0.6,
      [EQ.stolenGoods]: 0.3,
      [EQ.luckyRound]: 0.5,
      [EQ.improvisedArmour]: 0.4,
    },
  },
});

export default ratlings;

/** Re-exported for the tests, which pin the printed text they quote. */
export {
  DATA as RATLINGS_DATA,
  text as ratlingsRuleText,
  abilityText as ratlingsAbilityText,
  actionText as ratlingsActionText,
};
