/**
 * HERNKYN YAEGIR — Leagues of Votann. https://wahapedia.ru/kill-team3/kill-teams/hernkyn-yaegir/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is read
 * from `data/teams/hernkyn-yaegir.json`, never retyped.
 *
 * Three things shape the module:
 *
 *  - **Resourceful points** are one pure per-player count that eight rules read or write. The
 *    printed rule is "you can spend 1 … to do one of the following", a player choice with no
 *    decision channel, so it is auto-spent at each friendly operative's activation start on the
 *    deterministic D-022 policy written next to it.
 *  - **Minefield** markers are real markers created when the IRONBRAEK reaches the killzone.
 *    The engine has no marker-trigger hook (`checkMines` is core-only and hard-wired to D3+3
 *    damage), so a HY-Pex mine springs at an activation boundary — which is why the printed
 *    "end its action" is reminder-only, exactly as every other team's mine reports it.
 *  - **`fight.ts` emits no post-roll hook** (docs/DECISIONS.md D-031), so NO KIN LEFT BEHIND's
 *    "shooting, fighting or retaliating" retention is live only when shooting.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain } from '../../core/context.ts';
import { successes } from '../../core/dice.ts';
import { baseRadius, baseWhollyWithin, dist, distancePointToPoly, pointInPoly } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aplOf,
  body,
  gapBetween,
  inflictDamage,
  inControlRange,
  log,
  markerContestedBy,
  recordRoll,
  saveOf,
} from '../../core/state.ts';
import { hasType } from '../../core/terrain.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  enemiesInControlRange,
  gambitUsed,
  grantWeapon,
  grantedWeapons,
  grantFreeAction,
  hasEquipment,
  removeMarker,
  ruleTag,
  shortQuote,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('hernkyn-yaegir');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
export const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

export const KW = 'HERNKYN YAEGIR';
const EPS = 1e-6;

/** Datacard ids the printed rules name. */
export const C = {
  theyn: 'hernkyn-yaegir.yaegir-theyn',
  bladekyn: 'hernkyn-yaegir.yaegir-bladekyn',
  bombast: 'hernkyn-yaegir.yaegir-bombast',
  gunner: 'hernkyn-yaegir.yaegir-gunner',
  ironbraek: 'hernkyn-yaegir.yaegir-ironbraek',
  riflekyn: 'hernkyn-yaegir.yaegir-riflekyn',
  tracker: 'hernkyn-yaegir.yaegir-tracker',
  warrior: 'hernkyn-yaegir.yaegir-warrior',
} as const;

export const RULE = {
  resourceful: 'hernkyn-yaegir.rule.resourceful',
  dauntlessExplorers: 'hernkyn-yaegir.rule.dauntless-explorers',
} as const;

export const SP = {
  hiddenEngagement: 'hernkyn-yaegir.sp.hidden-engagement',
  masterfulBladework: 'hernkyn-yaegir.sp.masterful-bladework',
  toughSurvivalists: 'hernkyn-yaegir.sp.tough-survivalists',
  inPosition: 'hernkyn-yaegir.sp.in-position',
} as const;

export const FP = {
  sturdy: 'hernkyn-yaegir.fp.sturdy',
  bondsThatBind: 'hernkyn-yaegir.fp.bonds-that-bind',
  noKinLeftBehind: 'hernkyn-yaegir.fp.no-kin-left-behind',
  stalwartDefence: 'hernkyn-yaegir.fp.stalwart-defence',
} as const;

export const EQ = {
  plasmaKnives: 'hernkyn-yaegir.eq.plasma-knives',
  stabilisedBoltShells: 'hernkyn-yaegir.eq.stabilised-bolt-shells',
  firestormBoltShells: 'hernkyn-yaegir.eq.firestorm-bolt-shells',
  kvCeramideUndersuit: 'hernkyn-yaegir.eq.kv-ceramide-undersuit',
} as const;

/** The 14 printed datacard abilities. */
export const A = {
  veteranAdventurer: `${C.theyn}.veteran-adventurer`,
  outrightConviction: `${C.theyn}.outright-conviction`,
  stalker: `${C.bladekyn}.stalker`,
  irrepressibleHardiness: `${C.bladekyn}.irrepressible-hardiness`,
  wroughtlockNegotiation: `${C.bombast}.wroughtlock-negotiation`,
  brazenKiller: `${C.bombast}.brazen-killer`,
  bipod: `${C.gunner}.bipod`,
  minefield: `${C.ironbraek}.minefield`,
  hyPexMines: `${C.ironbraek}.hy-pex-mines`,
  concealedPosition: `${C.riflekyn}.concealed-position`,
  weavewerkeCloak: `${C.riflekyn}.weavew-rke-cloak`,
  panSpectralVisor: `${C.tracker}.pan-spectral-visor`,
  tracker: `${C.tracker}.tracker`,
  intrepid: `${C.warrior}.intrepid`,
} as const;

/** Effect rule names — namespaced scratch, never module-level state (architecture rule 7). */
const E = {
  resourcefulApl: 'hy.resourceful.apl',
  convictionShield: 'hy.outrightConviction.shield',
  brazenApl: 'hy.brazenKiller.apl',
  bondsThatBind: 'hy.bondsThatBind',
  stalwart: 'hy.stalwartDefence',
} as const;

/** The one extra action this team registers (docs/DECISIONS.md D-021). */
export const STALKER_CHARGE = 'Charge (Stalker)';

export const MINEFIELD_MARKER = (player: PlayerId, i: number): string => `hernkyn-yaegir.minefield.${player}.${i}`;
export const FALLEN_KIN_MARKER = (player: PlayerId): string => `hernkyn-yaegir.fallenKin.${player}`;

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];
const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : 1);
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A stable name for the sequence in flight, so an effect can be scoped to it. */
function seqKey(state: GameState): string {
  const seq = state.sequence;
  if (!seq) return 'none';
  return seq.kind === 'shoot'
    ? `shoot:${seq.attackerId}:${seq.targetId}`
    : `fight:${seq.attackerId}:${seq.defenderId}`;
}

/** "isn't within control range of enemy operatives" — exact with a context, base-gap without. */
function engaged(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (T.ctx) return enemiesInControlRange(T.ctx, state, op).length > 0;
  return T.enemies(state).some((e) => T.gap(op, e) <= 1 + EPS);
}

function canSee(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

// ---------------------------------------------------------------------------
// Resourceful points
// ---------------------------------------------------------------------------

export function resourcefulPoints(state: GameState, player: PlayerId): number {
  return Number(bucket(state, 'hy.resourceful')[player] ?? 0);
}
function setResourceful(state: GameState, player: PlayerId, n: number): void {
  bucket(state, 'hy.resourceful')[player] = Math.max(0, n);
}

// ---------------------------------------------------------------------------
// Concealed Position bookkeeping
// ---------------------------------------------------------------------------

const hasShot = (state: GameState, opId: string): boolean => Boolean(bucket(state, 'hy.hasShot')[opId]);
const markShot = (state: GameState, opId: string): void => {
  bucket(state, 'hy.hasShot')[opId] = true;
};

// ---------------------------------------------------------------------------
// Minefield markers
// ---------------------------------------------------------------------------

/** 20mm markers (core rules › Markers: everything but an objective marker). */
const MARKER_R = baseRadius({ shape: 'round', mm: 20 });

export function minefieldMarkers(state: GameState, player: PlayerId): MarkerState[] {
  return Object.values(state.markers)
    .filter((m) => m.owner === player && m.flags['minefield'] === true)
    .sort(byId);
}

/**
 * "Set up all your Minefield markers as if they were one item of equipment. Each must be set up
 *  reverse-side down …, more than 2" from other markers, access points and Accessible terrain,
 *  and more than 6" from your opponent's drop zone and your other Minefield markers."
 *
 * Equipment is placed during setup, which has no decision channel and no team seam, so the five
 * markers are created the first time the module sees the IRONBRAEK on the board (the Phobos
 * `ensureTeamMarkers` precedent). The position is a deterministic, logged default (D-016): the
 * first lattice point, ordered by distance from the IRONBRAEK, that satisfies every printed
 * constraint this engine can measure.
 */
function ensureMinefield(T: TeamHooks, state: GameState): void {
  const made = bucket(state, 'hy.minefieldMade');
  if (made[T.player]) return;
  const roster = T.friendlies(state);
  if (roster.length === 0) return; // the kill team has not been selected yet
  if (!roster.some((o) => o.datacardId === C.ironbraek)) {
    made[T.player] = true; // no IRONBRAEK in this kill team, so no Minefield markers
    return;
  }
  // Undeployed operatives sit off the board at (-100,-100); wait until the IRONBRAEK is placed.
  const owner = roster.find((o) => o.datacardId === C.ironbraek && o.pos.x > -50);
  if (!owner) return;
  made[T.player] = true;

  // "three of them are HY-Pex mines … and two are blank" — which is which is hidden from the
  // opponent, so it is drawn from the injected, seeded RNG rather than fixed by index.
  const order = [0, 1, 2, 3, 4];
  if (T.ctx) {
    const rolls = T.ctx.rng.roll(5);
    recordRoll(state, 'minefield', rolls, T.player, 'HY-Pex mine placement');
    order.sort((a, b) => rolls[a]! - rolls[b]! || a - b);
  }
  const isMine = new Set(order.slice(0, 3));

  // One lattice, sorted outwards from the IRONBRAEK, so each marker takes the nearest legal spot.
  const map = state.map;
  const lattice: Vec2[] = [];
  for (let x = 1; x <= map.board.w - 1; x += 1)
    for (let y = 1; y <= map.board.h - 1; y += 1) lattice.push({ x, y });
  lattice.sort((a, b) => dist(a, owner.pos) - dist(b, owner.pos) || a.x - b.x || a.y - b.y);
  const zone = minefieldZone(T, state);

  const placed: Vec2[] = [];
  for (let i = 0; i < 5; i++) {
    const pos = lattice.find((p) => minefieldPosLegal(zone, p, placed));
    if (!pos) break;
    placed.push(pos);
    const marker: MarkerState = {
      id: MINEFIELD_MARKER(T.player, i),
      kind: 'generic',
      diameterMm: 20,
      pos: { ...pos },
      z: 0,
      owner: T.player,
      flags: { minefield: true, mine: isMine.has(i), flipped: false },
    };
    state.markers[marker.id] = marker;
  }
  log(state, {
    kind: 'action',
    player: T.player,
    text: `Minefield: ${placed.length} Minefield markers set up`,
    data: { count: placed.length, source: A.minefield },
  });
}

/** Everything the printed placement constraints measure against, gathered once. */
interface MinefieldZone {
  board: { w: number; h: number };
  enemyZones: Vec2[][];
  others: { pos: Vec2; r: number }[];
  avoid: Vec2[][];
  solid: Vec2[][];
}

function minefieldZone(T: TeamHooks, state: GameState): MinefieldZone {
  const avoid: Vec2[][] = [];
  const solid: Vec2[][] = [];
  if (T.ctx) {
    for (const part of terrain(T.ctx, state).parts) {
      if (hasType(part, 'Accessible') || part.role === 'accessPoint') avoid.push(part.poly);
      else if (part.solid !== false && part.z0 <= EPS) solid.push(part.poly);
    }
  }
  return {
    board: { w: state.map.board.w, h: state.map.board.h },
    enemyZones: state.map.dropZones[T.player === 'p1' ? 'p2' : 'p1'] ?? [],
    others: Object.values(state.markers)
      .filter((m) => m.flags['minefield'] !== true)
      .map((m) => ({ pos: m.pos, r: baseRadius({ shape: 'round', mm: m.diameterMm }) })),
    avoid,
    solid,
  };
}

function minefieldPosLegal(zone: MinefieldZone, p: Vec2, placed: Vec2[]): boolean {
  if (p.x < MARKER_R || p.y < MARKER_R || p.x > zone.board.w - MARKER_R || p.y > zone.board.h - MARKER_R) return false;
  // "more than 6\" from … your other Minefield markers"
  for (const q of placed) if (dist(p, q) - 2 * MARKER_R <= 6 + EPS) return false;
  // "more than 2\" from other markers"
  for (const m of zone.others) if (dist(p, m.pos) - MARKER_R - m.r <= 2 + EPS) return false;
  // "more than 6\" from your opponent's drop zone"
  for (const poly of zone.enemyZones) if (distancePointToPoly(p, poly) - MARKER_R <= 6 + EPS) return false;
  // "more than 2\" from … access points and Accessible terrain"
  for (const poly of zone.avoid) if (distancePointToPoly(p, poly) - MARKER_R <= 2 + EPS) return false;
  for (const poly of zone.solid) if (pointInPoly(p, poly)) return false;
  return true;
}

/**
 * HY-Pex Mines. There is no marker-trigger hook — `checkMines` lives inside `applyMove`
 * (`src/core/actions.ts`), is hard-wired to `kind: 'mine'` and D3+3 damage, and emits nothing —
 * so the trap is sprung at the activation boundaries, the same partial every other team's mine
 * reports. The printed "end its action (if any)" is therefore reminder-only.
 */
function checkMinefield(T: TeamHooks, state: GameState): void {
  if (!T.ctx) return;
  for (const marker of minefieldMarkers(state, T.player)) {
    if (marker.flags['flipped'] === true) continue;
    const victim = T.enemies(state).find((e) => markerContestedBy(T.ctx!, state, marker, e));
    if (!victim) continue;
    // "…and not within a friendly HERNKYN YAEGIR operative's control range"
    if (T.friendlies(state, KW).some((o) => markerContestedBy(T.ctx!, state, marker, o))) continue;
    marker.flags['flipped'] = true; // "that marker isn't removed"
    if (marker.flags['mine'] !== true) {
      log(state, { kind: 'action', player: T.player, text: `${victim.letter} flips a blank Minefield marker` });
      continue;
    }
    log(state, { kind: 'action', player: T.player, text: `${victim.letter} sets off a HY-Pex mine` });
    inflictDamage(T.ctx, state, victim, 3, 'mine');
    const roll = T.ctx.rng.d6();
    recordRoll(state, 'hy-pex', [roll], T.player, `${victim.letter} HY-Pex mine`);
    const save = saveOf(T.ctx, state, victim);
    if (roll < save) {
      log(state, { kind: 'dice', player: T.player, text: `HY-Pex: ${roll} < Save ${save}+ → ${roll} more damage` });
      inflictDamage(T.ctx, state, victim, roll, 'mine');
    }
  }
}

// ---------------------------------------------------------------------------
// Equipment weapons and shell rules
// ---------------------------------------------------------------------------

/**
 * PLASMA KNIVES' granted weapon. The scraper kept the profile row but dropped the "WR" cell
 * (`weapons[0].profiles[0].rules` is `[]`), so Lethal 5+ is recovered from the printed text's own
 * WR row rather than retyped — see the data problems in the report.
 */
export const PLASMA_KNIFE_WEAPON: Weapon = (() => {
  const printed = DATA.equipment.find((e) => e.id === EQ.plasmaKnives)!;
  const scraped = (printed as unknown as { weapons?: Weapon[] }).weapons?.[0];
  const profile = scraped?.profiles[0];
  const wr = printed.text.split(/\bWR\b/).slice(1).join(' ');
  return {
    name: scraped?.name ?? 'Plasma Knife',
    profiles: [
      {
        type: 'melee',
        atk: profile?.atk ?? 3,
        hit: profile?.hit ?? 4,
        dmgN: profile?.dmgN ?? 3,
        dmgC: profile?.dmgC ?? 5,
        rules: parseWeaponRules(wr.replace(/\s+/g, ' ').trim()),
      },
    ],
  };
})();

/** "some operatives already have this weapon but with better stats" — from the recorded loadout. */
function carriesOwnPlasmaKnife(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const names = (T.card(op)?.weapons ?? []).map((w) => w.name);
  if (!names.some((n) => same(n, PLASMA_KNIFE_WEAPON.name))) return false;
  const loadout = (state.opState['loadout'] as Record<string, string[]> | undefined)?.[op.id];
  if (!loadout || loadout.length === 0) return true; // no recorded loadout: the whole card is carried
  return loadout.some((n) => same(n, PLASMA_KNIFE_WEAPON.name));
}

interface ShellArm {
  opId: string;
  weapon: string;
  profile: string;
}

const shellArm = (state: GameState, key: string): ShellArm | undefined =>
  bucket(state, 'hy.shells')[key] as ShellArm | undefined;

function setShellArm(state: GameState, key: string, arm: ShellArm | undefined): void {
  const b = bucket(state, 'hy.shells');
  if (arm) b[key] = arm;
  else delete b[key];
}

/** Is the shot in flight the one this rule was armed for? */
function shellApplies(state: GameState, key: string, op: OperativeState, weaponName: string, profileName: string): boolean {
  const arm = shellArm(state, key);
  return (
    arm !== undefined && arm.opId === op.id && same(arm.weapon, weaponName) && same(arm.profile, profileName || '')
  );
}

/** Unblocked attack dice in the shoot in flight, for D-019's "+1 to both Dmg stats". */
function unblockedDice(seq: ShootSequence): number {
  return seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'normal').length;
}

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Resourceful
  // =========================================================================
  // "In the Ready step of each Strategy phase after the first, you gain Resourceful points
  //  determined by the number of friendly HERNKYN YAEGIR operatives in the killzone that aren't
  //  within control range of enemy operatives … 5+ → 2, 1-4 → 1."
  reg.on('onReadyStep', T.bind(RULE.resourceful, 10), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint <= 1) return;
    const n = T.friendlies(ev.state, KW).filter((o) => !engaged(T, ev.state, o)).length;
    if (n === 0) return;
    const gain = n >= 5 ? 2 : 1;
    setResourceful(ev.state, T.player, resourcefulPoints(ev.state, T.player) + gain);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Resourceful: ${n} free operatives → +${gain} Resourceful point${gain > 1 ? 's' : ''}`,
    });
  });

  // THEYN › Veteran Adventurer — "…you gain 1 Resourceful point."
  reg.on('onReadyStep', T.bindText(A.veteranAdventurer, abilityText(C.theyn, A.veteranAdventurer), 11), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint <= 1) return;
    const theyn = T.friendlies(ev.state).find((o) => o.datacardId === C.theyn);
    if (!theyn || engaged(T, ev.state, theyn)) return;
    setResourceful(ev.state, T.player, resourcefulPoints(ev.state, T.player) + 1);
    log(ev.state, { kind: 'system', player: T.player, text: 'Veteran Adventurer: +1 Resourceful point' });
  });

  // "At the end of each turning point, discard your Resourceful points."
  reg.on('onEndOfTP', T.bind(RULE.resourceful, 10), (ev) => setResourceful(ev.state, T.player, 0));

  // WARRIOR › Intrepid — "If you add 1 to its APL stat, it lasts until the start of its next
  //  activation instead." There is no such expiry in the engine, so the effect is dropped at
  //  the start of that operative's next activation (before a new point can be spent).
  reg.on('onActivationStart', T.bindText(A.intrepid, abilityText(C.warrior, A.intrepid), 5), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E.resourcefulApl && e.operativeId === ev.operative.id);
  });

  /*
   * "You can spend 1 of your Resourceful points during each activation of each friendly HERNKYN
   *  YAEGIR operative to do one of the following: [+1 APL until the end of its activation]
   *  [regain up to D3+1 lost wounds when it's activated]."
   *
   * A player choice with no decision channel, so it is auto-spent on this stated D-022 policy:
   * at the start of each friendly HERNKYN YAEGIR operative's activation, while a point is held
   * and the operative isn't within control range of enemy operatives — regain wounds if it has
   * lost at least 3 (the median of D3+1, and exactly what a WARRIOR's Intrepid regains), and
   * otherwise take the extra AP. One point per activation, as printed; a counteraction is not an
   * activation, and `onActivationStart` is not emitted for one.
   */
  reg.on('onActivationStart', T.bind(RULE.resourceful, 12), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (resourcefulPoints(ev.state, T.player) < 1) return;
    if (engaged(T, ev.state, op)) return;
    const card = T.card(op);
    const lost = card ? card.wounds - op.wounds : 0;
    const intrepid = op.datacardId === C.warrior;
    setResourceful(ev.state, T.player, resourcefulPoints(ev.state, T.player) - 1);
    if (lost >= 3) {
      // "it regains up to D3+1 lost wounds" — Intrepid: "it regains up to 4 instead".
      let heal = 4;
      if (!intrepid) {
        const d3 = T.ctx ? T.ctx.rng.d3() : 2;
        if (T.ctx) recordRoll(ev.state, 'resourceful', [d3], T.player, `${op.letter} regains D3+1`);
        heal = d3 + 1;
      }
      const gained = Math.min(heal, lost);
      op.wounds += gained;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Resourceful: ${op.letter} regains ${gained} lost wounds${intrepid ? ' (Intrepid)' : ''}`,
      });
      return;
    }
    effect(ev.state, {
      rule: E.resourcefulApl,
      source: { kind: 'ability', id: RULE.resourceful },
      sourceText: shortQuote(text(RULE.resourceful)),
      operativeId: op.id,
      player: T.player,
      // Intrepid: "it lasts until the start of its next activation instead".
      expiry: intrepid ? { kind: 'endOfBattle' } : { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Resourceful: ${op.letter} gains +1 APL${intrepid ? ' until the start of its next activation (Intrepid)' : ''}`,
    });
  });
  reg.on('onStatMod', T.bind(RULE.resourceful, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E.resourcefulApl)) ev.mods.apl += 1;
  });

  // =========================================================================
  // Dauntless Explorers — "STRATEGIC GAMBIT in the first turning point."
  // =========================================================================
  reg.on('gambitOptions', T.bind(RULE.dauntlessExplorers, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (dauntlessCandidates(T, ev.state).length === 0) return;
    ev.options.push({
      id: RULE.dauntlessExplorers,
      label: 'Dauntless Explorers (0CP)',
      sourceText: shortQuote(text(RULE.dauntlessExplorers)),
    });
  });
  reg.on('onPloyUsed', T.bind(RULE.dauntlessExplorers, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== RULE.dauntlessExplorers) return;
    // "Each that does so must end that move wholly within 4\" of your drop zone" is
    // REMINDER-ONLY: no hook constrains where a move ends.
    for (const op of dauntlessCandidates(T, ev.state)) {
      grantFreeAction(ev.state, op, {
        sourceId: RULE.dauntlessExplorers,
        sourceText: shortQuote(text(RULE.dauntlessExplorers)),
        threshold: currentApl(T, ev.state, op),
        kind: 'ability',
        only: ['Reposition'],
      });
    }
  });

  // =========================================================================
  // THEYN › Outright Conviction
  // =========================================================================
  // "…cannot be incapacitated for the remainder of the action." Nothing expires an
  //  `endOfAction` effect, so the shield is pinned to the activation in flight.
  reg.on('onIncapacitated', T.bindText(A.outrightConviction, abilityText(C.theyn, A.outrightConviction), 8), (ev) => {
    if (ev.operative.player !== T.player || ev.prevented) return;
    if (!effectOn(ev.state, ev.operative.id, E.convictionShield)) return;
    ev.prevented = true;
  });
  reg.on('onIncapacitated', T.bindText(A.outrightConviction, abilityText(C.theyn, A.outrightConviction), 9), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.theyn || ev.prevented) return;
    if (!useOncePerBattle(ev.state, `hy.outrightConviction:${op.id}`)) return;
    ev.prevented = true;
    op.wounds = 1; // "it's not incapacitated, has 1 wound remaining"
    effect(ev.state, {
      rule: E.convictionShield,
      source: { kind: 'ability', id: A.outrightConviction },
      sourceText: shortQuote(abilityText(C.theyn, A.outrightConviction)),
      operativeId: op.id,
      player: T.player,
      data: { seq: seqKey(ev.state) },
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? op.id },
    });
    discardRemainingAttackDice(ev.state, op);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Outright Conviction: ${op.letter} is not incapacitated (1 wound left)`,
    });
  });
  // "All remaining attack dice are discarded" — a shoot aggregates its unblocked dice into one
  //  damage total computed before this hook can run, so the discarded dice are also cancelled
  //  where they land: no further attack damage from THAT sequence reaches the operative.
  reg.on('onDamage', T.bindText(A.outrightConviction, abilityText(C.theyn, A.outrightConviction), 9), (ev) => {
    if (ev.kind !== 'attack' || !ev.state.sequence) return;
    const shield = effectOn(ev.state, ev.target.id, E.convictionShield);
    if (!shield || shield.data?.['seq'] !== seqKey(ev.state)) return;
    ev.amount = 0;
  });

  // =========================================================================
  // BLADEKYN › Irrepressible Hardiness
  // =========================================================================
  // "If this operative is incapacitated during the Fight action, you can strike the enemy
  //  operative in that sequence with one of your unresolved successes before this operative is
  //  removed from the killzone."  Free, so auto-used (D-022); the best remaining success.
  reg.on(
    'onIncapacitated',
    T.bindText(A.irrepressibleHardiness, abilityText(C.bladekyn, A.irrepressibleHardiness), 12),
    (ev) => {
      const op = ev.operative;
      if (op.player !== T.player || op.datacardId !== C.bladekyn || ev.prevented || !T.ctx) return;
      const seq = fightSeq(ev.state);
      if (!seq) return;
      const side = seq.attackerId === op.id ? 'attacker' : seq.defenderId === op.id ? 'defender' : undefined;
      if (!side) return;
      const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
      if (!foe || foe.removed || foe.incapacitated) return;
      if (!useOncePerSequence(ev.state, `hy.hardiness:${op.id}`)) return;
      const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
      const die = successes(pool).find((d) => d.state === 'crit') ?? successes(pool)[0];
      if (!die) return;
      const crit = die.state === 'crit';
      const { profile } = sideWeapon(T.ctx, ev.state, seq, side);
      die.state = 'struck';
      die.note = 'Irrepressible Hardiness';
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `Irrepressible Hardiness: ${op.letter} strikes ${foe.letter} for ${crit ? profile.dmgC : profile.dmgN}`,
      });
      inflictDamage(T.ctx, ev.state, foe, crit ? profile.dmgC : profile.dmgN, 'attack');
    },
  );

  // =========================================================================
  // BOMBAST › Wroughtlock Negotiation — "STRATEGIC GAMBIT."
  // =========================================================================
  reg.on('gambitOptions', T.bindText(A.wroughtlockNegotiation, abilityText(C.bombast, A.wroughtlockNegotiation), 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === C.bombast)) return;
    ev.options.push({
      id: A.wroughtlockNegotiation,
      label: 'Wroughtlock Negotiation (0CP)',
      sourceText: shortQuote(abilityText(C.bombast, A.wroughtlockNegotiation)),
    });
  });
  reg.on('onPloyUsed', T.bindText(A.wroughtlockNegotiation, abilityText(C.bombast, A.wroughtlockNegotiation), 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== A.wroughtlockNegotiation) return;
    const op = T.friendlies(ev.state).find((o) => o.datacardId === C.bombast);
    if (!op) return;
    op.order = 'engage'; // "you can change its order to Engage to do so"
    grantFreeAction(ev.state, op, {
      sourceId: A.wroughtlockNegotiation,
      sourceText: shortQuote(abilityText(C.bombast, A.wroughtlockNegotiation)),
      threshold: currentApl(T, ev.state, op),
      kind: 'ability',
      only: ['Shoot'],
    });
  });

  // =========================================================================
  // BOMBAST › Brazen Killer
  // =========================================================================
  // "Whenever this operative incapacitates an enemy operative with its wroughtlock revolvers,
  //  roll one D6 separately for each other enemy operative visible to and within 2\" of that
  //  enemy operative: if the result is higher than that other enemy operative's APL stat,
  //  subtract 1 from its APL stat until the end of its next activation."
  reg.on('onIncapacitated', T.bindText(A.brazenKiller, abilityText(C.bombast, A.brazenKiller), 12), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player || ev.prevented || !T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const shooter = ev.state.operatives[seq.attackerId];
    if (!shooter || shooter.player !== T.player || shooter.datacardId !== C.bombast) return;
    if (!same(seq.weaponName, 'Wroughtlock revolvers')) return;
    for (const other of T.enemies(ev.state)) {
      if (other.id === victim.id || other.incapacitated) continue;
      if (T.gap(other, victim) > 2 + EPS) continue;
      if (!canSee(T, ev.state, victim, other)) continue;
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'brazen-killer', [roll], T.player, `${other.letter} APL test`);
      const apl = aplOf(T.ctx, ev.state, other);
      if (roll <= apl) continue;
      other.aplMods.push(-1);
      effect(ev.state, {
        rule: E.brazenApl,
        source: { kind: 'ability', id: A.brazenKiller },
        sourceText: shortQuote(abilityText(C.bombast, A.brazenKiller)),
        operativeId: other.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: other.id, armed: false },
      });
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `Brazen Killer: ${roll} beats ${other.letter}'s APL ${apl} → -1 APL`,
      });
    }
  });

  // =========================================================================
  // GUNNER › Bipod (rare weapon rule)
  // =========================================================================
  // "Whenever this operative is shooting with this weapon, if it hasn't moved during the
  //  activation, or if it's a counteraction, this weapon has the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bindText(A.bipod, abilityText(C.gunner, A.bipod), 12), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player || ev.retaliating) return;
    if (!ev.profile.rules.some((r) => r.id === 'Bipod')) return;
    const counteracting = (ev.state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === ev.operative.id;
    const moved = ev.operative.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a));
    if (moved && !counteracting) return;
    if (ev.rules.some((r) => r.id === 'Ceaseless')) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Bipod)'));
  });

  // =========================================================================
  // IRONBRAEK › Minefield / HY-Pex Mines
  // =========================================================================
  reg.on('onDeploy', T.bindText(A.minefield, abilityText(C.ironbraek, A.minefield), 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    ensureMinefield(T, ev.state);
  });
  reg.on('onActivationStart', T.bindText(A.minefield, abilityText(C.ironbraek, A.minefield), 12), (ev) => {
    void ev.operative;
    ensureMinefield(T, ev.state);
  });
  // The trap is sprung at the END of an activation, not at its start: `EndActivation` calls
  // `removeIncapacitated` immediately after this hook, so an operative a mine kills leaves the
  // killzone cleanly instead of activating while incapacitated.
  reg.on('onActivationEnd', T.bindText(A.hyPexMines, abilityText(C.ironbraek, A.hyPexMines), 12), (ev) => {
    void ev.operative;
    ensureMinefield(T, ev.state);
    checkMinefield(T, ev.state);
  });
  // "Whenever this operative is readied, if it's not within control range of enemy operatives,
  //  you can reset one of your flipped Minefield markers that's within its control range."
  reg.on('onReadyStep', T.bindText(A.minefield, abilityText(C.ironbraek, A.minefield), 12), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const owner = T.friendlies(ev.state).find((o) => o.datacardId === C.ironbraek);
    if (!owner || engaged(T, ev.state, owner)) return;
    const flipped = minefieldMarkers(ev.state, T.player).find(
      (m) => m.flags['flipped'] === true && markerContestedBy(T.ctx!, ev.state, m, owner),
    );
    if (!flipped) return;
    flipped.flags['flipped'] = false;
    log(ev.state, { kind: 'action', player: T.player, text: `Minefield: ${owner.letter} resets a Minefield marker` });
  });

  // =========================================================================
  // RIFLEKYN › Concealed Position (rare weapon rule)
  // =========================================================================
  // "This operative can only use this weapon the first time it's performing the Shoot action
  //  during the battle." The restriction sits on the magna-coil rifle's `concealed` profile
  //  alone, which `availableWeapons` (per weapon) cannot express — `onSelectWeapon` can, and
  //  since D-032 it is also emitted from the Shoot action's `check`, so the refusal reaches the
  //  AI before it commits an intent.
  reg.on('onSelectWeapon', T.bindText(A.concealedPosition, abilityText(C.riflekyn, A.concealedPosition), 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShot(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bindText(A.concealedPosition, abilityText(C.riflekyn, A.concealedPosition), 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || ev.ctx.secondary) return;
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // =========================================================================
  // RIFLEKYN › Weavewërke Cloak
  // =========================================================================
  // "Whenever an operative is shooting this operative: Ignore the Saturate weapon rule. If you
  //  can retain any cover saves, you can retain one additional cover save, or you can retain one
  //  cover save as a critical success instead. This isn't cumulative with improved cover saves
  //  from Vantage terrain."  The additional-cover-save branch is taken deterministically (the
  //  Scout Squad Camo Cloak precedent).
  reg.on('onDefenceDice', T.bindText(A.weavewerkeCloak, abilityText(C.riflekyn, A.weavewerkeCloak), 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== C.riflekyn) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (seq.inCover) ev.coverSave = true; // "Ignore the Saturate weapon rule."
    if (!ev.coverSave || seq.vantageImprovedCover) return;
    ev.extraCoverSaves += 1;
  });

  // =========================================================================
  // TRACKER › Pan Spectral Visor
  // =========================================================================
  // "Whenever this operative is shooting an operative within 6\" of it: This operative's weapons
  //  have the Seek Light weapon rule. That operative cannot be obscured."
  reg.on('onWeaponRules', T.bindText(A.panSpectralVisor, abilityText(C.tracker, A.panSpectralVisor), 12), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    if (!T.mine(ev.operative) || ev.operative.datacardId !== C.tracker) return;
    if (!ev.target || T.gap(ev.operative, ev.target) > 6 + EPS) return;
    if (ev.rules.some((r) => r.id === 'SeekLight' || r.id === 'Seek')) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Pan Spectral Visor)'));
  });
  reg.on('onCollectAttackDice', T.bindText(A.panSpectralVisor, abilityText(C.tracker, A.panSpectralVisor), 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const shooter = ev.ctx.attacker;
    if (!T.mine(shooter) || shooter.datacardId !== C.tracker) return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || !target || T.gap(shooter, target) > 6 + EPS) return;
    seq.obscured = false;
  });

  // =========================================================================
  // TRACKER › Tracker
  // =========================================================================
  // "Whenever this operative is shooting against or fighting against an expended operative
  //  within 6\" of it, this operative's weapons have the Punishing weapon rule."
  reg.on('onWeaponRules', T.bindText(A.tracker, abilityText(C.tracker, A.tracker), 12), (ev) => {
    if (ev.retaliating) return;
    if (!T.mine(ev.operative) || ev.operative.datacardId !== C.tracker) return;
    if (!ev.target || !ev.target.expended) return;
    if (T.gap(ev.operative, ev.target) > 6 + EPS) return;
    if (ev.rules.some((r) => r.id === 'Punishing')) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Tracker)'));
  });
}

/** "Each friendly HERNKYN YAEGIR operative wholly within your drop zone." */
function dauntlessCandidates(T: TeamHooks, state: GameState): OperativeState[] {
  return T.friendlies(state, KW)
    .filter((o) => whollyInDropZone(T, state, o))
    .sort(byId);
}

function whollyInDropZone(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const zones = state.map.dropZones[state.setup.dropZone[op.player] ?? op.player] ?? [];
  const base = T.card(op)?.base ?? { shape: 'round' as const, mm: 28 };
  return baseWhollyWithin(op.pos, base, op.rot, zones);
}

/** "All remaining attack dice are discarded (including yours if this operative is fighting…)." */
function discardRemainingAttackDice(state: GameState, op: OperativeState): void {
  const seq = state.sequence;
  if (!seq) return;
  const kill = (pool: { dice: { state: string; note?: string }[] }): void => {
    for (const d of pool.dice)
      if (d.state === 'crit' || d.state === 'normal') {
        d.state = 'discarded';
        d.note = 'Outright Conviction';
      }
  };
  if (seq.kind === 'shoot') {
    if (seq.targetId === op.id) kill(seq.attack);
    return;
  }
  if (seq.attackerId !== op.id && seq.defenderId !== op.id) return;
  kill(seq.attackerPool);
  kill(seq.defenderPool);
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- HIDDEN ENGAGEMENT (strategy, 1CP) ---------------------------------
  // "Whenever a friendly HERNKYN YAEGIR operative is shooting, if it's in cover from the
  //  target's perspective, that friendly operative's weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP.hiddenEngagement, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.hiddenEngagement)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target || !T.ctx) return;
    const index = terrain(T.ctx, ev.state);
    // "…in cover from the target's perspective": the target is the one drawing the lines.
    if (!coverAndObscured(index, body(T.ctx, ev.target), body(T.ctx, ev.operative)).inCover) return;
    if (ev.rules.some((r) => r.id === 'Balanced')) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Hidden Engagement)'));
  });

  // ---- MASTERFUL BLADEWORK (strategy, 1CP) -------------------------------
  // "Whenever a friendly HERNKYN YAEGIR operative is fighting, or has a Conceal order and is
  //  retaliating, add 1 to the Atk stat of its melee weapons (to a maximum of 4) and they have
  //  the Balanced weapon rule; if the weapon already has that weapon rule, it has the Ceaseless
  //  weapon rule instead of Balanced."
  //  Bound at priority 40 so the "already has Balanced" upgrade sees the PLASMA KNIVES grant.
  reg.on('onWeaponRules', T.bind(SP.masterfulBladework, 40), (ev) => {
    if (ev.type !== 'melee') return;
    if (!bladeworkApplies(T, ev.state, ev.operative, ev.retaliating)) return;
    if (ev.rules.some((r) => r.id === 'Balanced'))
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Masterful Bladework)'));
    else ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Masterful Bladework)'));
  });
  reg.on('onCollectAttackDice', T.bind(SP.masterfulBladework, 20), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const op = ev.ctx.attacker;
    const retaliating = seq.defenderId === op.id;
    if (!bladeworkApplies(T, ev.state, op, retaliating)) return;
    ev.count = Math.min(4, ev.count + 1);
  });

  // ---- TOUGH SURVIVALISTS (strategy, 1CP) --------------------------------
  // "The first time an attack dice inflicts damage on each friendly HERNKYN YAEGIR operative
  //  during the turning point in the Resolve Attack Dice step, you can halve that inflicted
  //  damage (rounding up, to a minimum of 2)."
  //  D-022 policy: taken only when it strictly reduces the damage, so the once-per-turning-point
  //  use is never spent on a hit it could not shrink.
  //  PARTIAL: a shoot aggregates every unblocked dice into ONE `inflictDamage` call, so what is
  //  halved there is the sequence total rather than one attack dice (the Zealot/Weathered
  //  precedent). In a fight each strike is its own dice and the rule is exact.
  reg.on('onDamage', T.bind(SP.toughSurvivalists, 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, SP.toughSurvivalists)) return;
    if (!T.mineKw(ev.target, KW)) return;
    const halved = Math.max(2, Math.ceil(ev.amount / 2));
    if (halved >= ev.amount) return;
    if (!useOncePerTP(ev.state, `hy.tough:${ev.target.id}`)) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Tough Survivalists: ${ev.target.letter} halves ${ev.amount} damage to ${halved}`,
    });
    ev.amount = halved;
  });

  // ---- IN POSITION (strategy, 1CP) ---------------------------------------
  /*
   * "Whenever a friendly HERNKYN YAEGIR operative has a Conceal order and is in cover, it cannot
   *  be selected as a valid target, taking precedence over all other rules (e.g. Seek, Vantage
   *  terrain) except being within 2"."
   *
   * `onValidTarget` is emitted before the core computes cover, so cover is recomputed here with
   * the DEFAULT options — which is what "taking precedence over Seek and Vantage" means.
   */
  reg.on('onValidTarget', T.bind(SP.inPosition, 25), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.inPosition)) return;
    const target = ev.target;
    if (!T.mineKw(target, KW) || target.order !== 'conceal' || !T.ctx) return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2\""
    if (!coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'IN POSITION: a Conceal-order HERNKYN YAEGIR operative in cover cannot be selected';
  });

  // ---- STURDY (firefight, 1CP) -------------------------------------------
  // "Use this firefight ploy when an operative is shooting a friendly HERNKYN YAEGIR operative,
  //  when you collect your defence dice. Change the attacker's retained critical successes to
  //  normal successes (any weapon rules they've already resolved aren't affected, e.g. Piercing
  //  Crits)."  Piercing is applied when the defence pool is sized, which is why the ploy is only
  //  offered before that; Devastating is resolved later and is therefore correctly reduced.
  reg.on('onPloyUsed', T.bind(FP.sturdy, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.sturdy) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.defender !== T.player) return;
    let n = 0;
    for (const d of seq.attack.dice)
      if (d.state === 'crit') {
        d.state = 'normal';
        d.note = 'Sturdy';
        n++;
      }
    log(ev.state, { kind: 'dice', player: T.player, text: `Sturdy: ${n} critical success(es) become normal` });
  });

  // ---- BONDS THAT BIND (firefight, 1CP) ----------------------------------
  // PARTIAL: the engine alternates activations strictly and `EndActivation` hands the turn to
  // the opponent after `onActivationEnd` fires, so the back-to-back activation is recorded as an
  // effect the UI/AI reads — the same partial as the Breachers' Breach and Clear, the
  // Pathfinders' Group Activation and the Warpcoven's MUTANT HERD.
  reg.on('onPloyUsed', T.bind(FP.bondsThatBind, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.bondsThatBind) return;
    const first = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!first || first.player !== T.player) return;
    const partner = chosenOperative(ev.state, ev.data, bondsCandidates(T, ev.state, first));
    if (!partner) return;
    effect(ev.state, {
      rule: E.bondsThatBind,
      source: { kind: 'ploy', id: FP.bondsThatBind },
      sourceText: shortQuote(text(FP.bondsThatBind)),
      operativeId: partner.id,
      player: T.player,
      data: { firstId: first.id, otherId: partner.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Bonds That Bind: ${partner.letter} activates after ${first.letter}`,
      data: { firstId: first.id, otherId: partner.id },
    });
  });

  // ---- NO KIN LEFT BEHIND (firefight, 1CP) -------------------------------
  // "…remove your Fallen Kin marker from the killzone (if any), then place it within that
  //  operative's control range."
  reg.on('onPloyUsed', T.bind(FP.noKinLeftBehind, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.noKinLeftBehind) return;
    const fallen = chosenOperative(
      ev.state,
      ev.data,
      T.friendlies(ev.state, KW).filter((o) => o.incapacitated),
    );
    if (!fallen) return;
    removeMarker(ev.state, FALLEN_KIN_MARKER(T.player));
    ev.state.markers[FALLEN_KIN_MARKER(T.player)] = {
      id: FALLEN_KIN_MARKER(T.player),
      kind: 'generic',
      diameterMm: 20,
      pos: { ...fallen.pos },
      z: fallen.z,
      owner: T.player,
      flags: { fallenKin: true },
    };
    log(ev.state, { kind: 'ploy', player: T.player, text: `No Kin Left Behind: Fallen Kin marker placed at ${fallen.letter}` });
  });
  /*
   * "Whenever a friendly HERNKYN YAEGIR operative within 3" of your Fallen Kin marker is
   *  shooting, fighting or retaliating, in the Roll Attack Dice step, you can retain one of your
   *  fails as a normal success instead of discarding it, or retain one of your normal successes
   *  as a critical success instead."
   *
   * `onAttackDiceRetained` is declared but never emitted, so the transform is applied directly to
   * the pool from `onRollAttack` — the Roll Attack Dice step, after the dice are classified and
   * before the retention step. **Shooting only**: `fight.ts` emits no post-roll hook (D-031), so
   * the fighting/retaliating half is unreachable.
   *
   * D-022 policy: free, so always taken, on whichever of the two printed options is worth more
   * damage (a fail promoted to a normal is worth Normal Dmg; a normal promoted to a critical is
   * worth the difference between the two Dmg stats). Obscured forbids the second option outright.
   */
  reg.on('onRollAttack', T.bind(FP.noKinLeftBehind, 20), (ev) => {
    const op = ev.ctx.attacker;
    if (!T.mineKw(op, KW)) return;
    const marker = ev.state.markers[FALLEN_KIN_MARKER(T.player)];
    if (!marker || T.markerGap(op, marker) > 3 + EPS) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    if (!useOncePerSequence(ev.state, `hy.noKin:${op.id}:${seq.targetId}`)) return;
    const fail = seq.attack.dice.filter((d) => d.state === 'fail').sort((a, b) => b.value - a.value)[0];
    const normal = seq.attack.dice.filter((d) => d.state === 'normal').sort((a, b) => a.value - b.value)[0];
    const gainFail = fail ? ev.ctx.profile.dmgN : -1;
    const gainCrit = normal && !seq.obscured ? ev.ctx.profile.dmgC - ev.ctx.profile.dmgN : -1;
    if (gainFail < 0 && gainCrit < 0) return;
    if (gainFail >= gainCrit && fail) {
      fail.state = 'normal';
      fail.note = 'No Kin Left Behind';
      log(ev.state, { kind: 'dice', player: T.player, text: 'No Kin Left Behind: a fail is retained as a normal success' });
    } else if (normal) {
      normal.state = 'crit';
      normal.note = 'No Kin Left Behind';
      log(ev.state, { kind: 'dice', player: T.player, text: 'No Kin Left Behind: a normal success is retained as a critical' });
    }
  });

  // ---- STALWART DEFENCE (firefight, 1CP) ---------------------------------
  // "Select one other friendly HERNKYN YAEGIR operative visible to and within 6\" of that
  //  friendly operative, but that isn't itself within control range of enemy operatives. The
  //  selected operative can perform a free Shoot action."
  //  D-100: the free action is one extra AP restricted to Shoot, granted on top of the APL
  //  budget, so it is the LAST AP the operative spends — exactly the window every clause below
  //  is gated on.
  reg.on('onPloyUsed', T.bind(FP.stalwartDefence, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.stalwartDefence) return;
    const enemy = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!enemy || enemy.player === T.player) return;
    const anchor = T.friendlies(ev.state, KW).find((o) => !T.ctx || inControlRange(T.ctx, ev.state, o, enemy));
    if (!anchor) return;
    const shooter = chosenOperative(ev.state, ev.data, stalwartCandidates(T, ev.state, anchor));
    if (!shooter) return;
    const threshold = currentApl(T, ev.state, shooter);
    grantFreeAction(ev.state, shooter, {
      sourceId: FP.stalwartDefence,
      sourceText: shortQuote(text(FP.stalwartDefence)),
      threshold,
      only: ['Shoot'],
    });
    effect(ev.state, {
      rule: E.stalwart,
      source: { kind: 'ploy', id: FP.stalwartDefence },
      sourceText: shortQuote(text(FP.stalwartDefence)),
      operativeId: shooter.id,
      player: T.player,
      data: { enemyId: enemy.id, threshold },
      expiry: { kind: 'endOfActivation', operativeId: shooter.id },
    });
  });
  reg.on('onValidTarget', T.bind(FP.stalwartDefence, 20), (ev) => {
    const lock = stalwartLock(ev.state, ev.attacker);
    if (!lock) return;
    if (ev.target.id !== lock) {
      // "You cannot select any other enemy operative as a valid target."
      ev.valid = false;
      ev.reason = 'STALWART DEFENCE: only that enemy operative can be selected';
      return;
    }
    // "It can target that enemy operative even though it's within control range of a friendly."
    ev.ignoreFriendlyControlRange = true;
  });
  reg.on('onSelectWeapon', T.bind(FP.stalwartDefence, 20), (ev) => {
    if (!stalwartLock(ev.state, ev.ctx.attacker)) return;
    // "You cannot select a frag or krak grenade, or a weapon with the Blast or x\" Devastating x
    //  weapon rule (i.e. Devastating with a distance)."
    const name = ev.ctx.weaponName.toLowerCase();
    const banned =
      /frag grenade|krak grenade/.test(name) ||
      ev.ctx.profile.rules.some((r) => r.id === 'Blast' || (r.id === 'Devastating' && r.dist !== undefined));
    if (!banned) return;
    ev.allowed = false;
    ev.reason = 'STALWART DEFENCE: no grenades, Blast or x" Devastating x weapons';
  });

  // Free AP looks after itself: `grantFreeAction` records it on an effect that expires at the
  // end of the grantee's activation, and `expireActivationEffects` honours that (D-100). What
  // no expiry can reach is a grant nobody took, and all three of this team's grants are handed
  // to an operative that is NOT activating — Dauntless Explorers arms the whole kill team during
  // the STRATEGIC GAMBIT step, Wroughtlock Negotiation and STALWART DEFENCE arm one operative
  // while an enemy is activating. "Can immediately perform a free Reposition/Shoot action" is an
  // offer made in one turning point, so the Ready step clears anything still unspent rather than
  // letting an operative that was expended without taking it carry the AP into the next.
  const FREE_SOURCES = new Set<string>([RULE.dauntlessExplorers, A.wroughtlockNegotiation, FP.stalwartDefence]);
  reg.on('onReadyStep', T.bindText('hy.freeActionUpkeep', text(RULE.resourceful), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const op of T.friendlies(ev.state)) {
      for (const eff of effectsOn(ev.state, op.id, FREE_ACTION_RULE)) {
        if (!FREE_SOURCES.has(eff.source.id)) continue;
        dropEffects(ev.state, (e) => e === eff);
      }
    }
  });

  // Brazen Killer's "subtract 1 from its APL stat until the end of its next activation" IS an
  // APL stat change, so it lives in `op.aplMods` — and those the engine really does never pop.
  // This takes it out at the same boundary where `expireActivationEffects` drops the effect that
  // recorded it. It runs for every operative rather than friendlies only, because the operative
  // carrying the debuff is an ENEMY of the player who owns this rule.
  reg.on('onActivationEnd', T.bindText('hy.brazenKillerUpkeep', abilityText(C.bombast, A.brazenKiller), 90), (ev) => {
    for (const eff of effectsOn(ev.state, ev.operative.id, E.brazenApl)) {
      if (eff.expiry.kind !== 'endOfNextActivation' || !eff.expiry.armed) continue;
      const at = ev.operative.aplMods.lastIndexOf(-1);
      if (at >= 0) ev.operative.aplMods.splice(at, 1);
    }
  });
}

function bladeworkApplies(T: TeamHooks, state: GameState, op: OperativeState, retaliating: boolean): boolean {
  if (!gambitUsed(state, T.player, SP.masterfulBladework)) return false;
  if (!T.mineKw(op, KW)) return false;
  return retaliating ? op.order === 'conceal' : true;
}

/** "one other ready friendly HERNKYN YAEGIR operative visible to and within 3" of that operative" */
function bondsCandidates(T: TeamHooks, state: GameState, first: OperativeState): OperativeState[] {
  const bombastBlocked = gambitUsed(state, T.player, A.wroughtlockNegotiation);
  return T.friendlies(state, KW)
    .filter((o) => o.id !== first.id && o.ready)
    .filter((o) => !(bombastBlocked && o.datacardId === C.bombast))
    .filter((o) => T.gap(o, first) <= 3 + EPS && canSee(T, state, first, o))
    .sort(byId);
}

function stalwartCandidates(T: TeamHooks, state: GameState, anchor: OperativeState): OperativeState[] {
  return T.friendlies(state, KW)
    .filter((o) => o.id !== anchor.id)
    .filter((o) => T.gap(o, anchor) <= 6 + EPS && canSee(T, state, anchor, o))
    .filter((o) => !engaged(T, state, o))
    .sort(byId);
}

/** The locked enemy id, but only while the operative is actually spending its free Shoot AP. */
function stalwartLock(state: GameState, op: OperativeState): string | undefined {
  const eff = effectOn(state, op.id, E.stalwart);
  if (!eff) return undefined;
  if (op.apSpent < Number(eff.data?.['threshold'] ?? 0)) return undefined;
  const id = eff.data?.['enemyId'];
  return typeof id === 'string' ? id : undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- PLASMA KNIVES -----------------------------------------------------
  // "Friendly HERNKYN YAEGIR operatives have the following melee weapon. Note that some
  //  operatives already have this weapon but with better stats; in that instance, use the better
  //  version, and that weapon has the Balanced weapon rule for the battle."
  reg.on('availableWeapons', T.bind(EQ.plasmaKnives, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.plasmaKnives)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (grantedWeapons(ev.operative).some((w) => same(w.name, PLASMA_KNIFE_WEAPON.name))) return;
    if (carriesOwnPlasmaKnife(T, ev.state, ev.operative)) return;
    grantWeapon(ev.operative, structuredClone(PLASMA_KNIFE_WEAPON));
  });
  reg.on('onWeaponRules', T.bind(EQ.plasmaKnives, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.plasmaKnives)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    if (!same(ev.weaponName, PLASMA_KNIFE_WEAPON.name)) return;
    if (!carriesOwnPlasmaKnife(T, ev.state, ev.operative)) return;
    if (ev.rules.some((r) => r.id === 'Balanced')) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Plasma Knives)'));
  });

  // ---- STABILISED / FIRESTORM BOLT SHELLS --------------------------------
  /*
   * Both are "when a friendly HERNKYN YAEGIR operative is performing the Shoot action and you
   * select a bolt shotgun (<profile>), you can use this rule", which is exactly `onSelectWeapon`.
   * The handler CHANGES STATE, so it returns early on a dry run (D-032: the Shoot action's
   * `check` emits the same hook as a legality query and must never mutate).
   *
   * D-022 policy: both are strict improvements with no cost, so each is used the moment its
   * profile is selected while its printed allowance holds. The single arming slot per rule is
   * rewritten (or cleared) on every real weapon selection, so it can never leak into a later shot.
   */
  reg.on('onSelectWeapon', T.bind(EQ.stabilisedBoltShells, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    const op = ev.ctx.attacker;
    if (op.player !== T.player) return;
    setShellArm(ev.state, EQ.stabilisedBoltShells, undefined);
    if (!hasEquipment(ev.state, T.player, EQ.stabilisedBoltShells) || !T.kw(op, KW)) return;
    if (!same(ev.ctx.weaponName, 'Bolt shotgun') || (ev.ctx.profile.name ?? '') !== 'long range') return;
    const key = `${T.player}:${ev.state.turningPoint}`;
    const b = bucket(ev.state, 'hy.stabilisedUses');
    const used = Number(b[key] ?? 0);
    if (used >= 2) return; // "Up to twice per turning point"
    b[key] = used + 1;
    setShellArm(ev.state, EQ.stabilisedBoltShells, { opId: op.id, weapon: ev.ctx.weaponName, profile: 'long range' });
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Stabilised Bolt Shells` });
  });
  // "improve the Hit stat of that weapon by 1" — `StatMods.hit` from `onCollectAttackDice` is
  //  dead, so it goes through `onStatMod`, which `hitOf` consults, reading `state.sequence` for
  //  the weapon context.
  reg.on('onStatMod', T.bind(EQ.stabilisedBoltShells, 30), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!shellApplies(ev.state, EQ.stabilisedBoltShells, ev.operative, seq.weaponName, seq.profileName ?? '')) return;
    ev.mods.hit += 1;
  });
  // "and add 1 to both of its Dmg stats" — applied where the damage is inflicted, per unblocked
  //  attack dice (D-019: the shared catalogue profile is never rewritten).
  reg.on('onDamage', T.bind(EQ.stabilisedBoltShells, 30), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== ev.target.id) return;
    const shooter = ev.state.operatives[seq.attackerId];
    if (!shooter) return;
    if (!shellApplies(ev.state, EQ.stabilisedBoltShells, shooter, seq.weaponName, seq.profileName ?? '')) return;
    ev.amount += unblockedDice(seq);
  });

  reg.on('onSelectWeapon', T.bind(EQ.firestormBoltShells, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    const op = ev.ctx.attacker;
    if (op.player !== T.player) return;
    setShellArm(ev.state, EQ.firestormBoltShells, undefined);
    if (!hasEquipment(ev.state, T.player, EQ.firestormBoltShells) || !T.kw(op, KW)) return;
    if (!same(ev.ctx.weaponName, 'Bolt shotgun') || (ev.ctx.profile.name ?? '') !== 'short range') return;
    if (usedThisTP(ev.state, `hy.firestorm:${T.player}`)) return; // "Once per turning point"
    useOncePerTP(ev.state, `hy.firestorm:${T.player}`);
    setShellArm(ev.state, EQ.firestormBoltShells, { opId: op.id, weapon: ev.ctx.weaponName, profile: 'short range' });
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Firestorm Bolt Shells (Blast 1")` });
  });
  reg.on('onWeaponRules', T.bind(EQ.firestormBoltShells, 30), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!shellApplies(ev.state, EQ.firestormBoltShells, ev.operative, ev.weaponName, ev.profile.name ?? '')) return;
    if (ev.rules.some((r) => r.id === 'Blast')) return;
    ev.rules.push(ruleTag('Blast', 1, 'Blast 1" (Firestorm Bolt Shells)'));
  });
  /*
   * `startShoot` computes the Blast/Torrent secondary queue from the weapon rules it read BEFORE
   * `onSelectWeapon` fires, so the granted Blast 1" would otherwise arrive one step too late to
   * put anything in the queue. The secondaries are therefore queued here, at the first sequence
   * step, exactly as the core computes them (the Sanctifiers' Twin Torrent precedent).
   */
  reg.on('onCollectAttackDice', T.bind(EQ.firestormBoltShells, 31), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary || seq.queue.length > 0 || seq.resolvedTargets.length > 0) return;
    const attacker = ev.ctx.attacker;
    if (!shellApplies(ev.state, EQ.firestormBoltShells, attacker, seq.weaponName, seq.profileName ?? '')) return;
    const primary = ev.state.operatives[seq.targetId];
    if (!primary) return;
    const index = terrain(T.ctx, ev.state);
    // "Secondary targets are other operatives visible to and within x" of the primary target."
    for (const other of Object.values(ev.state.operatives)) {
      if (other.removed || other.id === primary.id || other.id === attacker.id) continue;
      if (gapBetween(T.ctx, primary, other) > 1 + EPS) continue;
      if (!isVisible(index, body(T.ctx, primary), body(T.ctx, other)).visible) continue;
      seq.queue.push(other.id);
    }
    if (seq.queue.length > 0)
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Firestorm Bolt Shells: Blast 1" catches ${seq.queue.length} more operative(s)`,
      });
  });

  // ---- KV-CERAMIDE UNDERSUIT ---------------------------------------------
  // "Whenever an operative is shooting a friendly HERNKYN YAEGIR operative, if the ranged weapon
  //  in that sequence has the Blast or Torrent weapon rule, you can re-roll one of your defence
  //  dice."
  reg.on('onDefenceDice', T.bind(EQ.kvCeramideUndersuit, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.kvCeramideUndersuit)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || ev.ctx.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    if (!ev.ctx.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    const grant: RerollGrant = {
      id: 'hy.undersuit',
      label: 'KV-Ceramide Undersuit: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(EQ.kvCeramideUndersuit)),
    };
    ev.rerolls.push(grant);
  });
  // "In addition, friendly HERNKYN YAEGIR operatives aren't affected by the x\" Devastating x
  //  weapon rule (i.e. Devastating with a distance) unless they are the target during that
  //  sequence."  Only a distance-Devastating reaches an operative that is not the target.
  reg.on('onDamage', T.bind(EQ.kvCeramideUndersuit, 30), (ev) => {
    if (ev.kind !== 'devastating') return;
    if (!hasEquipment(ev.state, T.player, EQ.kvCeramideUndersuit)) return;
    if (!T.mineKw(ev.target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId === ev.target.id) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `KV-Ceramide Undersuit: ${ev.target.letter} ignores x" Devastating x`,
    });
    ev.amount = 0;
  });
}

// ---------------------------------------------------------------------------
// Extra actions (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * BLADEKYN › Stalker: "This operative can perform the Charge action while it has a Conceal
 * order." The universal Charge rejects a Conceal order outright and `canPerformAction` can only
 * forbid, never permit, so the carve-out is its own action that runs the same move validation and
 * resolves through the universal Charge (`treatedAs: 'Charge'`, so action restrictions and the
 * Reposition/Dash/Fall Back exclusions are shared with it).
 */
function actions(): ActionDef[] {
  const printed = abilityText(C.bladekyn, A.stalker);
  return [
    {
      id: STALKER_CHARGE,
      name: 'Charge (Stalker)',
      ap: 1,
      type: 'unique',
      treatedAs: 'Charge',
      sourceText: printed,
      available: (_ctx, _state, op) => op.datacardId === C.bladekyn,
      check(ctx, state, op, params) {
        if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'already within control range of an enemy operative' };
        if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
        if (!params.path) return { ok: false, reason: 'no path supplied' };
        const v = validateMove(ctx, state, op, params.path, {
          action: 'Charge',
          bonusInches: 2,
          mayEnterEnemyControlRange: true,
          mustFinishEngaged: true,
        });
        return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
      },
      perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
    },
  ];
}

for (const def of actions()) registerAction(def);

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const activeIsMine = (state: GameState, player: PlayerId): { ok: boolean; reason?: string } => {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!op || op.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
  return { ok: true };
};

export const hernkynYaegir = defineTeam({
  id: 'hernkyn-yaegir',
  rules,
  ploys,
  equipment,
  ployUsable: {
    // "Use this firefight ploy when an operative is shooting a friendly HERNKYN YAEGIR operative,
    //  when you collect your defence dice."
    [FP.sturdy]: (state, player) => {
      const seq = state.sequence?.kind === 'shoot' ? state.sequence : undefined;
      if (!seq) return { ok: false, reason: 'no shooting sequence is in progress' };
      if (seq.defender !== player) return { ok: false, reason: 'none of your operatives is being shot' };
      if (seq.defence.dice.length > 0) return { ok: false, reason: 'your defence dice have already been collected' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly HERNKYN YAEGIR operative is activated. Select one
    //  other ready friendly … operative visible to and within 3\" of that operative. Neither
    //  operative can be a BOMBAST operative if its Wroughtlock Negotiation STRATEGIC GAMBIT has
    //  been used this turning point."
    [FP.bondsThatBind]: (state, player) => {
      const base = activeIsMine(state, player);
      if (!base.ok) return base;
      const first = state.operatives[state.activeOperativeId!]!;
      const bombastBlocked = state.teams[player].gambitsUsedTP.includes(A.wroughtlockNegotiation);
      if (bombastBlocked && first.datacardId === C.bombast)
        return { ok: false, reason: 'that BOMBAST has already used Wroughtlock Negotiation this turning point' };
      // `usable` gets no GameContext, so this is a permissive centre-to-centre pre-filter;
      // `onPloyUsed` applies the exact base-to-base and visibility tests.
      const partner = Object.values(state.operatives).some(
        (o) =>
          o.player === player &&
          !o.removed &&
          o.ready &&
          o.id !== first.id &&
          !(bombastBlocked && o.datacardId === C.bombast) &&
          dist(o.pos, first.pos) <= 4.5,
      );
      if (!partner) return { ok: false, reason: 'no other ready friendly operative within 3"' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly HERNKYN YAEGIR operative is incapacitated."
    [FP.noKinLeftBehind]: (state, player) =>
      Object.values(state.operatives).some((o) => o.player === player && o.incapacitated && !o.removed)
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative has just been incapacitated' },
    // "Use this firefight ploy when an enemy operative ends a move within control range of a
    //  friendly HERNKYN YAEGIR operative."
    [FP.stalwartDefence]: (state, player) => {
      const enemy = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!enemy || enemy.player === player) return { ok: false, reason: 'no enemy operative is activating' };
      const near = Object.values(state.operatives).some(
        (o) => o.player === player && !o.removed && dist(o.pos, enemy.pos) <= 2.2,
      );
      if (!near) return { ok: false, reason: 'that enemy operative is not within control range of your operatives' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.theyn]: 'leader',
      [C.bladekyn]: 'melee',
      [C.bombast]: 'gunner',
      [C.gunner]: 'gunner',
      [C.ironbraek]: 'support',
      [C.riflekyn]: 'sniper',
      [C.tracker]: 'scout',
      [C.warrior]: 'objective',
    },
    ployValue: {
      [SP.hiddenEngagement]: 0.6,
      [SP.masterfulBladework]: 0.6,
      [SP.toughSurvivalists]: 0.6,
      [SP.inPosition]: 0.5,
      [FP.sturdy]: 0.6,
      [FP.bondsThatBind]: 0.4,
      [FP.noKinLeftBehind]: 0.5,
      [FP.stalwartDefence]: 0.6,
    },
    equipmentValue: {
      [EQ.plasmaKnives]: 0.6,
      [EQ.stabilisedBoltShells]: 0.6,
      [EQ.firestormBoltShells]: 0.4,
      [EQ.kvCeramideUndersuit]: 0.5,
    },
  },
});

/** The printed weapon profile of a datacard weapon, for tests and the UI. */
export function profileOf(datacardId: string, weapon: string, profile?: string): WeaponProfile {
  const w = cardOf(datacardId).weapons.find((x) => same(x.name, weapon))!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
}

export default hernkynYaegir;
