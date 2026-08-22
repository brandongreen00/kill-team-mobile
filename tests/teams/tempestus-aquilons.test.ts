/**
 * TEMPESTUS AQUILONS. Every test quotes the printed rule it pins, read out of
 * `data/teams/tempestus-aquilons.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/tempestus-aquilons/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { HookRegistry, zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { checkTarget, effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import { aliveOperatives, aplOf, moveOf, markerController, statMods } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import { baseWhollyWithin } from '../../src/core/geometry.ts';
import { markerWhollyWithin } from '../../src/core/ops/common.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/tempestus-aquilons.json';
import rareRulesJson from '../../data/teams/_rare-weapon-rules.json';
import { teamData, trimTrailingSection } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ABOVE,
  ACT,
  CARD,
  DASH_DYNAMIC,
  DETECTED_TOKEN,
  DROP_MARKER_GAMBIT,
  EQ,
  FP,
  KW,
  LAND,
  LANDED_OBSCURED,
  MAX_DROP_MARKERS,
  RAPID_INSERTION_GAMBIT,
  REMINDER_ONLY,
  REPOSITION_RAPID,
  RULE,
  SHOOT_GUNFIGHT,
  SHOOT_TURRET,
  SMOKE_GRENADIER,
  SP,
  STUN_GRENADIER,
  TEMPESTUS_DAGGER,
  aboveOperatives,
  abilityText,
  commandTargets,
  dropMarkerId,
  dropMarkers,
  dynamicDashCap,
  hotDropReady,
  isAbove,
  landingRadius,
  landingSpot,
  printed,
  setAbove,
  tempestusAquilons,
  thirdsOf,
} from '../../src/teams/tempestus-aquilons/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, settle, teamContext } from './harness.ts';
import { testMap, vantagePlatform } from '../fixtures.ts';

const DATA = teamData('tempestus-aquilons');
const RAW = rawJson as {
  strategyPloys: { id: string; name: string; text: string; weapons?: unknown[] }[];
  firefightPloys: { id: string; name: string; text: string; weapons?: unknown[] }[];
  equipment: { id: string; name: string; text: string; weapons?: unknown[] }[];
  notes: string[];
  markerGuide: string;
};

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};
const cardOf = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const actionOf = (cardId: string, actionId: string) =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!;

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: ReturnType<typeof testMap>;
}

/** Both sides are Tempestus Aquilons, so every rule can be tested from either seat. */
function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([tempestusAquilons], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const picks = defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: tempestusAquilons, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: tempestusAquilons, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number, z = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = z;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    op.z = 0;
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
  type: 'ranged' | 'melee' = 'ranged',
  over: Partial<AttackContext> = {},
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules: profile.rules,
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
    ...over,
  };
}

function shootSequence(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'resolve',
    queue: [],
    resolvedTargets: [],
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: newPool(),
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    free: false,
    ...over,
  };
}

function fightSequence(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attackerWeapon' | 'attacker' | 'defender'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    defenderCanRetaliate: true,
    free: false,
    hatchway: false,
    ...over,
  };
}

/** A hand-placed Drop marker, so the landing tests do not depend on `setAbove`. */
function dropMarkerAt(state: GameState, player: PlayerId, n: number, pos: Vec2): void {
  state.markers[dropMarkerId(player, n)] = {
    id: dropMarkerId(player, n),
    kind: 'generic',
    diameterMm: 20,
    pos,
    z: 0,
    owner: player,
    flags: { drop: n },
  };
}

// ---------------------------------------------------------------------------
describe('TEMPESTUS AQUILONS data (pinned against data/teams/tempestus-aquilons.json)', () => {
  it('is the Astra Militarum / Imperium Seek & Destroy + Recon kill team from the June 2026 book', () => {
    expect(DATA.id).toBe('tempestus-aquilons');
    expect(DATA.name).toBe('Tempestus Aquilons');
    expect(DATA.faction).toBe('Astra Militarum');
    expect(DATA.archetypes).toEqual(['Seek & Destroy', 'Recon']);
    expect(DATA.sourceUrl).toBe('https://wahapedia.ru/kill-team3/kill-teams/tempestus-aquilons/');
    expect(RAW.notes).toEqual([]);
  });

  it('has 8 datacards — all TEMPESTUS AQUILON IMPERIUM, the TEMPESTOR the only LEADER', () => {
    expect(DATA.datacards).toHaveLength(8);
    for (const card of DATA.datacards) expect(card.keywords.slice(0, 2)).toEqual([KW, 'IMPERIUM']);
    expect(DATA.datacards.filter((c) => c.keywords.includes('LEADER')).map((c) => c.id)).toEqual([CARD.tempestor]);
    expect(Object.values(CARD).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
  });

  it('pins every datacard stat line', () => {
    expect(cardOf(CARD.tempestor)).toMatchObject({ apl: 3, move: 6, save: 4, wounds: 9, base: { shape: 'round', mm: 28 } });
    expect(cardOf(CARD.servoSentry)).toMatchObject({ apl: 2, move: 4, save: 3, wounds: 10, base: { shape: 'round', mm: 40 } });
    // Every other operative is the same 2 / 6" / 4+ / 8 wounds on a 28mm base.
    for (const id of [CARD.grenadier, CARD.gunfighter, CARD.gunner, CARD.marksman, CARD.precursor, CARD.trooper]) {
      expect([id, cardOf(id).apl, cardOf(id).move, cardOf(id).save, cardOf(id).wounds]).toEqual([id, 2, 6, 4, 8]);
      expect(cardOf(id).base).toEqual({ shape: 'round', mm: 28 });
    }
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment options, 12 abilities and 1 unique action', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Drop Insertion', 'Grav‑Chute']);
    expect(tempestusAquilons.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(tempestusAquilons.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(new Set(tempestusAquilons.ploys.map((p) => p.cp))).toEqual(new Set([1]));
    expect(tempestusAquilons.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(12);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.id)).toEqual([ACT.command]);
    expect(actionOf(CARD.tempestor, ACT.command).ap).toBe(1);
    expect(DATA.rareWeaponRules).toEqual(['ConcealedPosition', 'Salvo']);
  });

  it('pins the weapon profiles the rules read', () => {
    // GUNFIGHTER: three profiles on one weapon, the salvo one carrying the rare Salvo rule.
    expect(profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'focused')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'focused').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Ceaseless',
      'Rending',
    ]);
    expect(profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'salvo').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Salvo*',
    ]);
    expect(profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'point‑blank')).toMatchObject({ type: 'melee', atk: 4, hit: 3 });
    // MARKSMAN: Concealed Position sits on the `concealed` profile ALONE.
    expect(cardOf(CARD.marksman).weapons.find((w) => w.name === 'Hot‑shot long‑las')!.profiles.map((p) => p.name)).toEqual([
      'concealed',
      'mobile',
      'stationary',
    ]);
    expect(profileOf(CARD.marksman, 'Hot‑shot long‑las', 'concealed').rules.map((r) => r.raw)).toEqual([
      'Devastating 3',
      'Heavy',
      'Silent',
      'Concealed Position*',
    ]);
    expect(profileOf(CARD.marksman, 'Hot‑shot long‑las', 'mobile').rules).toEqual([]);
    // GUNNER: the two printed loadouts.
    expect(profileOf(CARD.gunner, 'Melta carbine')).toMatchObject({ atk: 4, hit: 3, dmgN: 6, dmgC: 3 });
    expect(profileOf(CARD.gunner, 'Plasma carbine', 'supercharge').rules.map((r) => r.id)).toEqual(['Hot', 'Lethal', 'Piercing']);
    // GRENADIER: a Limited 1 melta bomb.
    expect(profileOf(CARD.grenadier, 'Melta bomb').rules.map((r) => r.raw)).toEqual([
      'Range 3"',
      'Devastating 3',
      'Heavy (Reposition only)',
      'Limited 1',
      'Piercing 2',
    ]);
    // SERVO-SENTRY: three loadout weapons, none of them melee.
    expect(cardOf(CARD.servoSentry).weapons.map((w) => w.name)).toEqual(['Flamer', 'Grenade launcher', 'Hot‑shot volley gun']);
    expect(cardOf(CARD.servoSentry).weapons.flatMap((w) => w.profiles).every((p) => p.type === 'ranged')).toBe(true);
    // PRECURSOR: its own Tempestus dagger is BETTER than the equipment one (see the data notes).
    expect(profileOf(CARD.precursor, 'Tempestus dagger')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.precursor, 'Tempestus dagger').rules.map((r) => r.id)).toEqual(['Ceaseless', 'Lethal']);
    // TEMPESTOR: three printed loadout options.
    expect(DATA.selection.leaderList?.[0]?.loadouts?.map((l) => l.label)).toEqual([
      'Hot-shot laspistol; power weapon',
      'Relic bolt pistol; chainsword',
      'Hot-shot lascarbine; fists',
    ]);
    expect(profileOf(CARD.tempestor, 'Power weapon').rules.map((r) => r.raw)).toEqual(['Lethal 5+']);
    expect(profileOf(CARD.tempestor, 'Relic bolt pistol').rules.map((r) => r.raw)).toEqual(['Range 8"', 'Lethal 5+']);
  });

  it('resolves both rare weapon rules against its OWN printed text (D-033)', () => {
    const salvo = rareWeaponRuleText('Salvo', 'tempestus-aquilons');
    expect(salvo).toBe(abilityText(CARD.gunfighter, AB.salvo));
    // Unlike Detonate and Anti-PSYKER, this team's Salvo matches the shared registry byte for byte.
    const registry = (rareRulesJson as { rules: { id: string; definition: string }[] }).rules;
    expect(salvo).toBe(registry.find((r) => r.id === 'Salvo')!.definition);
    const concealed = rareWeaponRuleText('ConcealedPosition', 'tempestus-aquilons');
    expect(concealed).toBe(abilityText(CARD.marksman, AB.concealedPosition));
    expect(concealed).toBe(registry.find((r) => r.id === 'ConcealedPosition')!.definition);
  });

  it('names its four tokens in the marker guide', () => {
    expect(RAW.markerGuide.split('\n').filter(Boolean)).toEqual([
      'Detected token',
      'Drop marker',
      'Drop and Secure token',
      'Melta Bomb token',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('Selection', () => {
  it('prints one constraint — "Other than TROOPER operatives, your kill team can only include each operative on this list once"', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['TROOPER'] }]);
    expect(DATA.selection.rawText).toContain(
      'Other than TROOPER operatives, your kill team can only include each operative on this list once.',
    );
    // Nothing is silently unenforced: no `custom`, `maxItem` or `exclusiveItems` is printed.
    expect(DATA.selection.constraints.filter((c) => ['custom', 'maxItem', 'exclusiveItems'].includes(c.kind))).toEqual([]);
  });

  it('`defaultRoster` is legal, is eleven operatives and fields ALL EIGHT datacards', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(11);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect([...fielded].sort()).toEqual(Object.values(CARD).slice().sort());
    // 1 TEMPESTOR + 1 SERVO-SENTRY + one of each list row + TROOPERs filling the rest.
    expect(picks.filter((p) => p.datacardId === CARD.trooper)).toHaveLength(3);
    expect(picks.filter((p) => p.datacardId === CARD.gunner)).toHaveLength(2); // two printed GUNNER rows
  });

  it('enforces the uniqueExcept exemption in both directions', () => {
    const picks = defaultRoster(DATA);
    // A fourth TROOPER is legal (the printed exemption)…
    const moreTroopers = picks.map((p) =>
      p.datacardId === CARD.marksman ? { ...p, datacardId: CARD.trooper, entryId: 'tempestus-aquilons.sel8.trooper' } : p,
    );
    expect(validateRosterFor(DATA, moreTroopers).ok).toBe(true);
    // …a second MARKSMAN is not.
    const twoMarksmen = picks.map((p) =>
      p.datacardId === CARD.precursor ? { ...p, datacardId: CARD.marksman, entryId: 'tempestus-aquilons.sel6.marksman' } : p,
    );
    expect(validateRosterFor(DATA, twoMarksmen).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DATA PROBLEMS in the committed JSON', () => {
  it('DROP AND SECURE swallows the whole rest of the page; `trimTrailingSection` cuts it', () => {
    const raw = RAW.strategyPloys.find((p) => p.id === SP.dropAndSecure)!;
    // The raw bytes carry all four firefight ploys AND all four equipment entries.
    expect(raw.text).toContain('\nFirefight Ploys\n');
    for (const name of ['HOT DROP', 'ADJUST COORDINATES', 'TEMPESTUS EXEMPLARS', 'PROGENA']) {
      expect(raw.text).toContain(name);
    }
    for (const name of ['TEMPESTUS DAGGERS', 'COMBAT STIMMS', 'DROP AUGURY', 'REMOTE OVERSEER']) {
      expect(raw.text).toContain(name);
    }
    // …and a spurious `weapons` array lifted from the equipment section's dagger table.
    expect(raw.weapons).toHaveLength(1);
    // The shared normaliser trims it, so the module quotes the ploy and nothing else.
    expect(printed(SP.dropAndSecure)).toBe(trimTrailingSection(raw.text));
    expect(printed(SP.dropAndSecure)).not.toContain('HOT DROP');
    expect(printed(SP.dropAndSecure).endsWith('add 1 to the Atk stat of its melee weapons (to a maximum of 4).')).toBe(true);
  });

  it('PROGENA swallows the four equipment entries; `trimTrailingSection` cuts it', () => {
    const raw = RAW.firefightPloys.find((p) => p.id === FP.progena)!;
    expect(raw.text).toContain('\nFaction Equipment\n');
    expect(raw.weapons).toHaveLength(1);
    expect(printed(FP.progena)).toBe(trimTrailingSection(raw.text));
    expect(printed(FP.progena)).not.toContain('TEMPESTUS DAGGERS');
    expect(printed(FP.progena).endsWith('during that activation you can ignore any changes to its APL stat.')).toBe(true);
  });

  it('TEMPESTUS EXEMPLARS has lost its trailing full stop', () => {
    // The "text missing a leading or trailing character" class, after `"ou gain 1CP."` and
    // `FOCUSED MARKERLIGH`. Its neighbours all end in a full stop.
    expect(printed(FP.tempestusExemplars).endsWith('for 1 less AP')).toBe(true);
    for (const id of [FP.hotDrop, FP.adjustCoordinates, FP.progena]) expect(printed(id).endsWith('.')).toBe(true);
  });

  it('the TEMPESTUS DAGGERS weapon table parses out of the printed text, and is NOT the PRECURSOR’s dagger', () => {
    expect(TEMPESTUS_DAGGER).toEqual({
      name: 'Tempestus dagger',
      profiles: [{ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4, rules: [] }],
    });
    // The printed equipment table has NAME/ATK/HIT/DMG columns and no WR column at all, so
    // `rules: []` is the printed truth here rather than the "weapon table loses its WR row" bug.
    expect(printed(EQ.tempestusDaggers)).toContain('NAME');
    expect(printed(EQ.tempestusDaggers)).not.toContain('WR');
    // The PRECURSOR's own dagger is a different, better profile.
    expect(profileOf(CARD.precursor, 'Tempestus dagger').atk).toBe(4);
    expect(profileOf(CARD.precursor, 'Tempestus dagger').rules).not.toEqual([]);
  });

  it('`uniqueActions[].keywords` is ABSENT, not empty — the corsair-voidscarred variant again', () => {
    const raw = rawJson as { datacards: { uniqueActions: Record<string, unknown>[] }[] };
    const printedAction = raw.datacards.flatMap((c) => c.uniqueActions)[0]!;
    expect(Object.keys(printedAction)).toEqual(['id', 'name', 'ap', 'text']);
    expect('keywords' in printedAction).toBe(false);
    // COMMAND is a SUPPORT action, which the printed text carries as its opening word instead.
    expect(String(printedAction['text']).startsWith('SUPPORT.')).toBe(true);
  });

  it('no printed effect list is truncated to its lead-in, and no ploy has "1CP" glued to its name', () => {
    // The two defects six/two other teams hit; checked here rather than assumed.
    const every = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
      ...DATA.datacards.flatMap((c) => c.abilities),
      ...DATA.datacards.flatMap((c) => c.uniqueActions),
    ];
    for (const r of every) expect([r.id, /following[^\n]*:\s*$/.test(r.text.trim())]).toEqual([r.id, false]);
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect([p.id, /\dCP/i.test(p.name), p.cp]).toEqual([p.id, false, 1]);
    }
  });

  it('the markerGuide names a Melta Bomb token no rule places', () => {
    expect(RAW.markerGuide).toContain('Melta Bomb token');
    const everyText = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
      ...DATA.datacards.flatMap((c) => c.abilities),
      ...DATA.datacards.flatMap((c) => c.uniqueActions),
    ]
      .map((r) => r.text)
      .join('\n');
    expect(everyText).not.toContain('Melta Bomb token');
    // The melta bomb itself is a Limited 1 weapon, which the engine tracks without a marker.
    expect(profileOf(CARD.grenadier, 'Melta bomb').rules.some((r) => r.id === 'Limited')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Drop Insertion — set up above', () => {
  it('"the first third of your kill team must be set up as normal. Each third thereafter can be set up above"', () => {
    const { state } = setup();
    expect(printed(RULE.dropInsertion)).toContain(
      'the first third of your kill team must be set up as normal. Each third thereafter can be set up above',
    );
    const blocks = thirdsOf(state, 'p1');
    expect(blocks.map((b) => b.length)).toEqual([4, 4, 3]); // 11 operatives
    const ids = setAbove(state, 'p1', 1);
    // "you must set up the WHOLE third in this way (not some of them)"
    expect(ids).toEqual(blocks[2]!.map((o) => o.id));
    expect(blocks[0]!.every((o) => !isAbove(state, o))).toBe(true);
    expect(blocks[1]!.every((o) => !isAbove(state, o))).toBe(true);
  });

  it('"place them to one side instead of in the killzone" — parked, but still deployed and ready', () => {
    const { state } = setup();
    const ids = setAbove(state, 'p1', 1);
    for (const id of ids) {
      const op = state.operatives[id]!;
      expect(op.removed).toBeFalsy();
      expect(op.ready).toBe(true);
      expect(op.pos.x).toBeLessThan(0);
      // `FinishSetup` treats pos.x < -50 as "not deployed", so the parking spot stays above it.
      expect(op.pos.x).toBeGreaterThan(-50);
    }
    expect(aboveOperatives(state, 'p1').map((o) => o.id)).toEqual(ids);
  });

  it('"then place one of your Drop markers wholly within your drop zone" — one per third above', () => {
    const { state } = setup();
    expect(dropMarkers(state, 'p1')).toHaveLength(0);
    setAbove(state, 'p1', 1);
    expect(dropMarkers(state, 'p1')).toHaveLength(1);
    const { state: s2 } = setup();
    setAbove(s2, 'p1', 2);
    expect(dropMarkers(s2, 'p1')).toHaveLength(MAX_DROP_MARKERS);
    // Wholly within the p1 drop zone (x in [0,6] on the test map).
    for (const m of dropMarkers(s2, 'p1')) {
      expect(m.pos.x).toBeGreaterThanOrEqual(20 / 25.4 / 2);
      expect(m.pos.x).toBeLessThanOrEqual(6 - 20 / 25.4 / 2 + 1e-6);
    }
    // 2/3 of the kill team is above at setup: 7 of 11.
    expect(aboveOperatives(s2, 'p1')).toHaveLength(7);
  });

  it('quotes all four printed landing requirements', () => {
    const rule = printed(RULE.dropInsertion);
    for (const clause of [
      'Within 3" horizontally of one of your Drop markers, or wholly within your drop zone.',
      'Not within control range of enemy operatives (unless you’re setting up a PRECURSOR operative, which can be set up within control range of an enemy operative).',
      'With no part of its base underneath Vantage terrain.',
      'With an order of your choice.',
      'The operative is treated as performing the Reposition action (spend the AP accordingly), then continue its activation as normal. It’s obscured until the end of the next activation or the end of the turning point (whichever comes first).',
    ]) {
      expect(rule).toContain(clause);
    }
  });

  it('"you can either expend or land that operative" — nothing else is legal up there', () => {
    const { ctx, state } = setup();
    const [id] = setAbove(state, 'p1', 1);
    const op = state.operatives[id!]!;
    const legal = availableActions(ctx, state, op).filter((a) => a.ok).map((a) => a.def.id);
    expect(legal).toEqual([LAND]);
    // …and it is not a valid target while it is up there.
    const shooter = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    expect(checkTarget(ctx, state, shooter, op, profile, profile.rules).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Drop Insertion — landing', () => {
  function withAbove(opts: SetupOpts = {}): { ctx: GameContext; state: GameState; id: string } {
    const { ctx, state } = setup(opts);
    const id = opWith(state, 'p1', CARD.trooper);
    isolate(state, [id]);
    // One operative above, by hand, so the test does not depend on the thirds arithmetic.
    setAbove(state, 'p1', 0);
    const op = state.operatives[id]!;
    op.pos = { x: -22, y: -18 };
    state.effects.push({
      id: `above-${state.seq++}`,
      rule: ABOVE,
      source: { kind: 'ability', id: RULE.dropInsertion },
      operativeId: id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    return { ctx, state, id };
  }

  it('LAND is 1AP and "treated as performing the Reposition action"', () => {
    const { ctx, state, id } = withAbove();
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    const def = getAction(LAND)!;
    expect(def.ap).toBe(1);
    expect(def.treatedAs).toBe('Reposition');
    let s = activate(ctx, state, id);
    const before = s.operatives[id]!.apSpent;
    s = act(ctx, s, id, LAND).state;
    expect(s.operatives[id]!.apSpent).toBe(before + 1);
    expect(s.operatives[id]!.actionsThisActivation).toContain('Reposition');
    expect(isAbove(s, s.operatives[id]!)).toBe(false);
    expect(s.operatives[id]!.pos.x).toBeGreaterThan(0);
  });

  it('"Within 3" horizontally of one of your Drop markers" — and a TROOPER gets 4" (Swift Landing)', () => {
    const { ctx, state, id } = withAbove();
    dropMarkerAt(state, 'p1', 0, { x: 10, y: 11 });
    const trooper = state.operatives[id]!;
    expect(trooper.datacardId).toBe(CARD.trooper);
    expect(landingRadius(state, trooper)).toBe(4); // Swift Landing
    // 28mm base radius 0.55", 20mm marker radius 0.39": base-to-marker gap at 14.9" is 3.95".
    expect(landingSpot(ctx, state, trooper, { x: 14.9, y: 11 }).ok).toBe(true);
    expect(landingSpot(ctx, state, trooper, { x: 16, y: 11 }).ok).toBe(false);
    expect(landingSpot(ctx, state, trooper, { x: 16, y: 11 }).reason).toContain('4"');
  });

  it('"or wholly within your drop zone" — the only branch before any Drop marker exists', () => {
    const { ctx, state, id } = withAbove();
    expect(dropMarkers(state, 'p1')).toHaveLength(0);
    const op = state.operatives[id]!;
    const spot = landingSpot(ctx, state, op);
    expect(spot.ok).toBe(true);
    // The test map's p1 drop zone is x in [0,6]; "wholly within" keeps the whole base inside.
    expect(spot.pos!.x).toBeLessThanOrEqual(6);
    expect(landingSpot(ctx, state, op, { x: 15, y: 11 }).ok).toBe(false);
  });

  it('"Not within control range of enemy operatives (unless… a PRECURSOR operative)"', () => {
    const { ctx, state } = setup();
    dropMarkerAt(state, 'p1', 0, { x: 12, y: 11 });
    const trooperId = opWith(state, 'p1', CARD.trooper);
    const precursorId = opWith(state, 'p1', CARD.precursor);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 13.4, 11);
    isolate(state, [trooperId, precursorId, foe.id]);
    for (const id of [trooperId, precursorId]) {
      const op = state.operatives[id]!;
      op.pos = { x: -22, y: -18 };
      state.effects.push({
        id: `above-${state.seq++}`,
        rule: ABOVE,
        source: { kind: 'ability', id: RULE.dropInsertion },
        operativeId: id,
        player: 'p1',
        expiry: { kind: 'endOfBattle' },
      });
    }
    // 28mm bases: at 1.4" between centres the gap is 0.3", inside the 1" control range.
    const at = { x: 12, y: 11 };
    expect(landingSpot(ctx, state, state.operatives[trooperId]!, at).ok).toBe(false);
    expect(landingSpot(ctx, state, state.operatives[trooperId]!, at).reason).toContain('control range');
    expect(landingSpot(ctx, state, state.operatives[precursorId]!, at).ok).toBe(true);
  });

  it('"With no part of its base underneath Vantage terrain"', () => {
    const map = testMap({ features: [vantagePlatform('deck', 10, 9, 6, 6, 3)] });
    const { ctx, state, id } = withAbove({ map });
    dropMarkerAt(state, 'p1', 0, { x: 7, y: 11 });
    const op = state.operatives[id]!;
    // The platform's footprint starts at x = 10; a 28mm base is 0.55" across the radius, so a
    // landing centred at 9.8" has part of its base under the deck even though it stands on the
    // killzone floor.
    const under = landingSpot(ctx, state, op, { x: 9.8, y: 11 });
    expect(under.ok).toBe(false);
    expect(under.reason).toContain('Vantage');
    expect(landingSpot(ctx, state, op, { x: 8.5, y: 11 }).ok).toBe(true);
    // Landing ON TOP of the deck is fine — the printed ban is only on being underneath it.
    const onTop = landingSpot(ctx, state, op, { x: 11, y: 11 });
    expect(onTop.ok).toBe(true);
    expect(onTop.z).toBe(3);
  });

  it('"With an order of your choice", and "it\'s obscured until the end of the next activation"', () => {
    const { ctx, state, id } = withAbove();
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    let s = activate(ctx, state, id, 'engage');
    s = act(ctx, s, id, LAND, { choice: 'conceal' }).state;
    expect(s.operatives[id]!.order).toBe('conceal');
    const obscured = s.effects.find((e) => e.rule === LANDED_OBSCURED && e.operativeId === id);
    expect(obscured).toBeDefined();
    expect(obscured!.expiry).toEqual({ kind: 'nActivations', remaining: 2 });
    // The hook makes the in-flight shoot sequence obscured.
    const shooter = s.operatives[opWith(s, 'p2', CARD.trooper)]!;
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    const seq = shootSequence({
      attackerId: shooter.id,
      targetId: id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Hot‑shot lascarbine',
    });
    s.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shooter, s.operatives[id]!, profile, 'Hot‑shot lascarbine'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(true);
  });

  it('LAND is offered only to an operative that is actually set up above', () => {
    const { ctx, state, id } = withAbove();
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    const def = getAction(LAND)!;
    expect(def.available!(ctx, state, state.operatives[id]!)).toBe(true);
    const grounded = state.operatives[opWith(state, 'p1', CARD.marksman)]!;
    expect(def.available!(ctx, state, grounded)).toBe(false);
    expect(def.check(ctx, state, grounded, {}).ok).toBe(false);
  });

  it('every legality lives in `check` (D-026): LAND refuses when there is nowhere to be placed', () => {
    const { ctx, state, id } = withAbove();
    // No Drop markers and a drop zone stuffed with bodies leaves nowhere legal.
    for (const other of aliveOperatives(state)) {
      if (other.id === id) continue;
      other.pos = { x: 3, y: 11 };
    }
    state.map = { ...state.map, dropZones: { p1: [], p2: [] } };
    const op = state.operatives[id]!;
    expect(getAction(LAND)!.check(ctx, state, op, {}).ok).toBe(false);
    expect(getAction(LAND)!.check(ctx, state, op, { targetPos: { x: 15, y: 11 } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Drop Insertion — the gambit, the Ready step and the second turning point', () => {
  it('"As a STRATEGIC GAMBIT in the first and second turning point, you can move your Drop markers up to 4""', () => {
    const { ctx, state } = setup();
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(DROP_MARKER_GAMBIT);
    const before = { ...state.markers[dropMarkerId('p1', 0)]!.pos };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: DROP_MARKER_GAMBIT }, ctx).state;
    const after = s.markers[dropMarkerId('p1', 0)]!.pos;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(4 + 1e-6);
    expect(after.x).toBeGreaterThan(before.x); // it heads for the opponent's drop zone
    // Not offered in the third turning point.
    s.turningPoint = 3;
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(DROP_MARKER_GAMBIT);
  });

  it('"When readying your operatives during the second and third turning points, remove one of your Drop markers"', () => {
    const { ctx, state } = setup();
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    dropMarkerAt(state, 'p1', 1, { x: 3, y: 15 });
    for (const tp of [2, 3]) {
      state.turningPoint = tp;
      ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    }
    expect(dropMarkers(state, 'p1')).toHaveLength(0);
    // Turning point 1 and 4 leave the markers alone.
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    for (const tp of [1, 4]) {
      state.turningPoint = tp;
      ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    }
    expect(dropMarkers(state, 'p1')).toHaveLength(1);
  });

  it('"operatives still set up above are incapacitated at the end of the second turning point"', () => {
    const { ctx, state } = setup();
    const ids = setAbove(state, 'p1', 1);
    state.turningPoint = 1;
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(ids.every((id) => !state.operatives[id]!.incapacitated)).toBe(true);
    state.turningPoint = 2;
    ctx.hooks.emit('onEndOfTP', state, { state });
    for (const id of ids) expect(state.operatives[id]!.removed || state.operatives[id]!.incapacitated).toBe(true);
  });

  it('REMINDER-ONLY: "Less than half of your operatives can be set up above by the end of the first turning point"', () => {
    expect(REMINDER_ONLY[`${RULE.dropInsertion}.halfByTP1`]).toContain('no hook can refuse the end of an activation');
    const { ctx, state } = setup();
    setAbove(state, 'p1', 2); // 7 of 11 — a violation
    state.turningPoint = 1;
    ctx.hooks.emit('onEndOfTP', state, { state });
    const entry = state.log.find((l) => l.data?.['reminderOnly'] === true);
    expect(entry?.text).toContain('less than half');
  });
});

// ---------------------------------------------------------------------------
describe('Grav-Chute', () => {
  it('REMINDER-ONLY: the whole rule is `onMoveRules`, which is declared but never emitted', () => {
    expect(printed(RULE.gravChute)).toBe(
      'Whenever a friendly TEMPESTUS AQUILON operative is dropping, ignore the vertical distance.',
    );
    expect(REMINDER_ONLY[RULE.gravChute]).toContain('onMoveRules');
    const ctx = teamContext([tempestusAquilons]);
    const reg = new HookRegistry();
    tempestusAquilons.register(reg, 'p1', ctx);
    expect(reg.has('onMoveRules')).toBe(false);
    // …and the module DOES use the movement seam that is emitted, so the absence is deliberate.
    expect(reg.has('canPerformAction')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Datacard abilities', () => {
  it('TEMPESTOR › Tempestus Veteran: "you can either use a firefight ploy for 0CP if this is the specified… operative"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tempestor);
    state.teams.p1.cp = 4;
    let s = activate(ctx, state, id);
    // TEMPESTUS EXEMPLARS is used during that operative's activation, so the TEMPESTOR is its
    // specified operative… but the TEMPESTOR is APL 3, which the ploy excludes.
    expect(tempestusAquilons.ploys.find((p) => p.id === FP.tempestusExemplars)!.usable!(s, 'p1').ok).toBe(false);
    // PROGENA names the activating operative and excludes only the SERVO-SENTRY.
    s.operatives[id]!.wounds = 3;
    const cp = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.progena }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp); // 1CP charged, 1CP refunded — "for 0CP"
    // Once per battle: a second firefight ploy costs full price.
    s.teams.p1.ploysUsedTP = [];
    const cp2 = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.progena }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp2 - 1);
  });

  it('TEMPESTOR › Tempestus Veteran: "…or the Command Re-roll firefight ploy for 0CP" when it is shooting', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tempestor);
    const foe = state.operatives[opWith(state, 'p2', CARD.trooper)]!;
    state.teams.p1.cp = 3;
    const profile = profileOf(CARD.tempestor, 'Hot‑shot laspistol');
    state.sequence = shootSequence({
      attackerId: id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Hot‑shot laspistol',
    });
    const grants = [{ id: 'commandReroll:attack', label: 'Command Re-roll', mode: 'one' as const, cp: 1, player: 'p1' as PlayerId }];
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(state.operatives[id]!, foe, profile, 'Hot‑shot laspistol'),
      dice: [],
      rerolls: grants,
    });
    expect(grants[0]!.cp).toBe(0);
    expect(REMINDER_ONLY[`${AB.veteran}.commandRerollFight`]).toContain('fight.ts emits no post-roll hook');
  });

  it('GRENADIER › "This operative can use frag, krak, smoke and stun grenades"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.grenadier);
    const s = activate(ctx, state, id); // the arming hook runs at activation start
    const op = s.operatives[id]!;
    const names = (op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons?.map((w) => w.name);
    expect(names).toEqual(['Frag grenade', 'Krak grenade']);
    // …and the two universal grenade ACTIONS, without the kill team taking the equipment.
    expect(s.teams.p1.equipment).not.toContain('eq.utilityGrenades');
    for (const action of [SMOKE_GRENADIER, STUN_GRENADIER]) {
      expect(getAction(action)!.available!(ctx, s, op)).toBe(true);
      expect(getAction(action)!.available!(ctx, s, s.operatives[opWith(s, 'p1', CARD.trooper)]!)).toBe(false);
    }
    expect(getAction(SMOKE_GRENADIER)!.check(ctx, s, op, { targetPos: { x: op.pos.x + 2, y: op.pos.y } }).ok).toBe(true);
  });

  it('GRENADIER › "improve the Hit stat of that weapon by 1", and no limited use is spent', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.grenadier);
    const foe = state.operatives[opWith(state, 'p2', CARD.trooper)]!;
    state.sequence = shootSequence({
      attackerId: id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Frag grenade',
    });
    // `hitOf` reads only `onStatMod`; `StatMods.hit` from `onCollectAttackDice` is dead.
    expect(statMods(ctx, state, state.operatives[id]!).hit).toBe(1);
    state.sequence = shootSequence({
      attackerId: id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Hot‑shot laspistol',
    });
    expect(statMods(ctx, state, state.operatives[id]!).hit).toBe(0);
    // "Doing so doesn't count towards any limited uses you have."
    state.teams.p1.equipment.push('eq.explosiveGrenades');
    state.teams.p1.equipmentUses['eq.explosiveGrenades:frag'] = 1;
    state.teams.p1.equipmentUses['used:eq.explosiveGrenades:frag'] = 0;
    const grenade = { type: 'ranged' as const, atk: 4, hit: 4, dmgN: 2, dmgC: 4, rules: [] };
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(state.operatives[id]!, foe, grenade, 'Frag grenade'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(state.teams.p1.equipmentUses['used:eq.explosiveGrenades:frag']).toBe(0);
  });

  it('GUNFIGHTER › Salvo: "Select up to two different valid targets that aren\'t within control range of friendly operatives"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gunfighter);
    const me = place(state, id, 12, 11);
    const a = place(state, opWith(state, 'p2', CARD.trooper), 15, 11);
    const b = place(state, opWith(state, 'p2', CARD.marksman), 15, 13);
    isolate(state, [id, a.id, b.id]);
    const profile = profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'salvo');
    const seq = shootSequence({
      attackerId: id,
      targetId: a.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Hot‑shot laspistols',
      profileName: 'salvo',
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(me, a, profile, 'Hot‑shot laspistols'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.queue).toEqual([b.id]);
  });

  it('GUNFIGHTER › Salvo excludes a target within control range of a friendly operative', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gunfighter);
    const me = place(state, id, 12, 11);
    const a = place(state, opWith(state, 'p2', CARD.trooper), 15, 11);
    const b = place(state, opWith(state, 'p2', CARD.marksman), 15, 14);
    const mate = place(state, opWith(state, 'p1', CARD.precursor), 15.6, 14); // engages b
    isolate(state, [id, a.id, b.id, mate.id]);
    const profile = profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'salvo');
    const seq = shootSequence({
      attackerId: id,
      targetId: a.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Hot‑shot laspistols',
      profileName: 'salvo',
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(me, a, profile, 'Hot‑shot laspistols'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.queue).toEqual([]);
  });

  it('GUNFIGHTER › Salvo: "roll each sequence separately" — the second target’s cover is re-determined', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gunfighter);
    const me = place(state, id, 12, 11);
    const b = place(state, opWith(state, 'p2', CARD.marksman), 15, 13);
    isolate(state, [id, b.id]);
    const profile = profileOf(CARD.gunfighter, 'Hot‑shot laspistols', 'salvo');
    // The primary was obscured; the queued Salvo target is a primary in its own right.
    const seq = shootSequence({
      attackerId: id,
      targetId: b.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Hot‑shot laspistols',
      profileName: 'salvo',
      secondary: true,
      obscured: true,
      inCover: true,
      resolvedTargets: ['someone-else'],
    });
    state.sequence = seq;
    state.opState['tempestus-aquilons.salvoSecond'] = { p1: b.id };
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(me, b, profile, 'Hot‑shot laspistols', 'ranged', { secondary: true }),
      count: 4,
      mods: zeroStatMods(),
    });
    // Open ground on the test map: nothing intervenes, so both are re-determined to false.
    expect([seq.obscured, seq.inCover]).toEqual([false, false]);
  });

  it('GUNFIGHTER › Gunfight ignores a shooter more than 8" away', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gunfighter);
    const me = place(state, id, 5, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.trooper), 25, 11);
    isolate(state, [id, shooter.id]);
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    state.sequence = shootSequence({
      attackerId: shooter.id,
      targetId: id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Hot‑shot lascarbine',
      attack: pool([1, 1, 1, 6], 3),
    });
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, me, profile, 'Hot‑shot lascarbine'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(state.effects.some((e) => e.rule === 'tempestus-aquilons.gunfightDebt')).toBe(false);
  });

  it('GUNFIGHTER › Gunfight: the fails are counted, and the free Shoot is capped at "discarded plus one, to a maximum of four"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.gunfighter);
    const me = place(state, id, 12, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.trooper), 16, 11);
    isolate(state, [id, shooter.id]);
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    const seq = shootSequence({
      attackerId: shooter.id,
      targetId: id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Hot‑shot lascarbine',
      attack: pool([1, 2, 2, 6], 3), // three fails, one crit
    });
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, me, profile, 'Hot‑shot lascarbine'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    state.sequence = null;
    state.activeOperativeId = shooter.id;
    ctx.hooks.emit('onActivationEnd', state, { state, operative: shooter });
    // D-015: the free Shoot is one extra AP restricted to `Shoot (Gunfight)`.
    expect(me.aplMods).toContain(1);
    const def = getAction(SHOOT_GUNFIGHT)!;
    expect(def.available!(ctx, state, me)).toBe(true);
    expect(def.treatedAs).toBe('Shoot');
    // "it can only target that enemy operative"
    const other = state.operatives[opWith(state, 'p2', CARD.marksman)]!;
    expect(def.check(ctx, state, me, { targetId: other.id }).ok).toBe(false);
    me.order = 'conceal'; // "(you can change its order to Engage to do so)"
    expect(def.check(ctx, state, me, { targetId: shooter.id }).ok).toBe(true);
    const s = act(ctx, activate(ctx, state, id, 'conceal'), id, SHOOT_GUNFIGHT, { targetId: shooter.id }).state;
    const rolled = s.rolls.filter((r) => r.kind === 'attack').at(-1)!;
    expect(rolled.results).toHaveLength(4); // 3 fails + 1, capped at 4
    expect(REMINDER_ONLY[`${AB.gunfight}.timing`]).toContain('nothing runs at the end of an action');
  });

  it('MARKSMAN › Sniper\'s Vantage: "all profiles of its hot-shot long-las have the Severe weapon rule"', () => {
    const map = testMap({ features: [vantagePlatform('deck', 10, 9, 6, 6, 3)] });
    const { ctx, state } = setup({ map });
    const id = opWith(state, 'p1', CARD.marksman);
    const me = place(state, id, 12, 11, 3);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 20, 11, 0);
    isolate(state, [id, foe.id]);
    foe.order = 'engage';
    const severe = (profileName: string): boolean =>
      effectiveRules(ctx, state, profileOf(CARD.marksman, 'Hot‑shot long‑las', profileName), {
        operative: me,
        target: foe,
        weaponName: 'Hot‑shot long‑las',
      }).some((r) => r.id === 'Severe');
    for (const p of ['concealed', 'mobile', 'stationary']) expect([p, severe(p)]).toEqual([p, true]);
    // "…an operative that has an Engage order and is at least 2" lower than it."
    foe.order = 'conceal';
    expect(severe('mobile')).toBe(false);
    foe.order = 'engage';
    foe.z = 3;
    expect(severe('mobile')).toBe(false);
  });

  it('MARKSMAN › Concealed Position: "only the first time it\'s performing the Shoot action during the battle"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.marksman);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 18, 11);
    isolate(state, [id, foe.id]);
    const ask = (profileName: string, dryRun: boolean) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(me, foe, profileOf(CARD.marksman, 'Hot‑shot long‑las', profileName), 'Hot‑shot long‑las'),
        allowed: true,
        dryRun,
      });
    // D-032: the hook is emitted twice per shot and a dry run must never change state, so any
    // number of `check`-side emits leaves the first real shot available.
    for (let i = 0; i < 3; i++) expect(ask('concealed', true).allowed).toBe(true);
    expect(ask('concealed', false).allowed).toBe(true);
    expect(ask('concealed', true).allowed).toBe(true);
    // A shot is recorded at the dice-collection step (D-032: the dry run must not mutate).
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(me, foe, profileOf(CARD.marksman, 'Hot‑shot long‑las', 'mobile'), 'Hot‑shot long‑las'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(ask('concealed', true).allowed).toBe(false);
    expect(ask('concealed', false).reason).toContain('Concealed Position');
    // The restriction is per PROFILE: the mobile and stationary profiles stay legal.
    expect(ask('mobile', false).allowed).toBe(true);
    expect(ask('stationary', false).allowed).toBe(true);
  });

  it('PRECURSOR › Vicious Knife Fighter: "after resolving your first attack dice… you can immediately resolve another"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.precursor);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 12.9, 11);
    isolate(state, [id, foe.id]);
    const profile = profileOf(CARD.precursor, 'Tempestus dagger');
    const seq = fightSequence({
      attackerId: id,
      defenderId: foe.id,
      attackerWeapon: 'Tempestus dagger',
      attacker: 'p1',
      defender: 'p2',
      attackerPool: pool([6, 5, 5], 3),
    });
    state.sequence = seq;
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(me, foe, profile, 'Tempestus dagger', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBe(before - profile.dmgC); // one more dice resolved as a strike
    expect(seq.attackerPool.dice.filter((d) => d.state === 'struck')).toHaveLength(1);
    // "…during that sequence" — only once.
    const after = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(me, foe, profile, 'Tempestus dagger', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBe(after);
    expect(REMINDER_ONLY[`${AB.viciousKnifeFighter}.block`]).toContain('strike/block options');
  });

  it('PRECURSOR › Vicious Knife Fighter does not fire while RETALIATING ("whenever this operative is fighting")', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.precursor);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 12.9, 11);
    isolate(state, [id, foe.id]);
    const profile = profileOf(CARD.precursor, 'Tempestus dagger');
    state.sequence = fightSequence({
      attackerId: foe.id, // the enemy is fighting; the PRECURSOR only retaliates
      defenderId: id,
      attackerWeapon: 'Fists',
      attacker: 'p2',
      defender: 'p1',
      defenderPool: pool([6, 5], 3),
    });
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(me, foe, profile, 'Tempestus dagger', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBe(before);
  });

  it('PRECURSOR › Dynamic: a free Dash after the Shoot action, capped by the Charge it has left', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.precursor);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 17, 11);
    isolate(state, [id, foe.id]);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, 'Shoot', { weaponName: 'Hot‑shot laspistol', targetId: foe.id }).state;
    const op = s.operatives[id]!;
    expect(op.aplMods).toContain(1); // D-015: one extra AP restricted to Dash
    expect(aplOf(ctx, s, op)).toBe(3);
    // "…but can only use any remaining move distance it had from that Charge action (max 3")."
    expect(dynamicDashCap(ctx, s, op)).toBe(3); // no Charge performed
    op.actionsThisActivation.push('Charge');
    s.log.push({
      seq: s.seq++,
      tp: s.turningPoint,
      kind: 'action',
      player: 'p1',
      text: 'charge',
      data: { operativeId: id, action: 'Charge', inches: 6 },
    });
    expect(dynamicDashCap(ctx, s, op)).toBe(2); // Move 6" + 2" = 8" budget, 6" used
    const def = getAction(DASH_DYNAMIC)!;
    expect(def.treatedAs).toBe('Dash');
    expect(def.check(ctx, s, op, { path: { points: [{ x: op.pos.x + 1.5, y: op.pos.y }] } }).ok).toBe(true);
    expect(def.check(ctx, s, op, { path: { points: [{ x: op.pos.x + 3, y: op.pos.y }] } }).ok).toBe(false);
  });

  it('SERVO-SENTRY › Machine: the action ban, no retaliating, no assisting, and no off-datacard weapons', () => {
    const { ctx, state } = setup({ equipment: [EQ.tempestusDaggers] });
    const id = opWith(state, 'p1', CARD.servoSentry);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 12.9, 11);
    const mate = place(state, opWith(state, 'p1', CARD.trooper), 13.4, 11.4);
    isolate(state, [id, foe.id, mate.id]);
    const s = activate(ctx, state, id);
    const legal = availableActions(ctx, s, s.operatives[id]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(legal.sort()).toEqual(['Dash', 'Fall Back', 'Reposition', 'Shoot', SHOOT_TURRET].sort());
    expect(s.effects.some((e) => e.rule === 'cannotRetaliate' && e.operativeId === id)).toBe(true);
    // "…or use any weapons that aren't on its datacard": TEMPESTUS DAGGERS excludes it anyway…
    const granted = (s.operatives[id] as OperativeState & { grantedWeapons?: unknown[] }).grantedWeapons ?? [];
    expect(granted).toEqual([]);
    // …and a weapon granted by anything else is refused at the profile gate.
    const dagger = TEMPESTUS_DAGGER.profiles[0]!;
    const refuse = ctx.hooks.emit('onSelectWeapon', s, {
      state: s,
      ctx: attackCtx(s.operatives[id]!, s.operatives[foe.id]!, dagger, 'Tempestus dagger', 'melee'),
      allowed: true,
      dryRun: true,
    });
    expect(refuse.allowed).toBe(false);
    // "It cannot… assist in a fight": the SERVO-SENTRY is discounted from the assist count.
    const assists = ctx.hooks.emit('onFightAssist', s, { state: s, operative: s.operatives[mate.id]!, assists: 1 });
    expect(assists.assists).toBe(0);
    // `availableWeapons` keeps only the weapons printed on its own datacard.
    const own = cardOf(CARD.servoSentry).weapons.map((w) => w.name);
    expect(
      ctx.hooks.emit('availableWeapons', s, { state: s, operative: s.operatives[id]!, weapons: [...own, 'Frag grenade'] })
        .weapons,
    ).toEqual(own);
  });

  it('SERVO-SENTRY › Turret: "This operative can perform two Shoot actions during its activation"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.servoSentry);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 16, 11);
    isolate(state, [id, foe.id]);
    state.teams.p1.cp = 0; // no Command Re-roll decision to settle mid-sequence
    state.teams.p2.cp = 0;
    // Two Shoot actions need 2AP; the SERVO-SENTRY is APL 2 — exactly enough.
    const def = getAction(SHOOT_TURRET)!;
    let s = activate(ctx, state, id);
    // The second Shoot is only legal after the first.
    expect(def.check(ctx, s, s.operatives[id]!, { targetId: foe.id }).ok).toBe(false);
    s = settle(ctx, act(ctx, s, id, 'Shoot', { weaponName: 'Flamer', targetId: foe.id }).state);
    const out = act(ctx, s, id, SHOOT_TURRET, { targetId: foe.id });
    expect([out.ok, out.reason]).toEqual([true, undefined]);
    expect(out.state.operatives[id]!.apSpent).toBe(2);
  });

  it('TROOPER › Rapid Insertion: a STRATEGIC GAMBIT in the first turning point only', () => {
    const { ctx, state } = setup();
    for (const id of state.teams.p1.operativeIds) place(state, id, 3, 2 + state.teams.p1.operativeIds.indexOf(id) * 1.6);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.turningPoint = 1;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(RAPID_INSERTION_GAMBIT);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: RAPID_INSERTION_GAMBIT }, ctx).state;
    for (const op of aliveOperatives(s, 'p1')) {
      const expected = op.datacardId === CARD.trooper ? 1 : 0;
      expect([op.id, op.aplMods.filter((m) => m === 1).length]).toEqual([op.id, expected]);
    }
    s.turningPoint = 2;
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(RAPID_INSERTION_GAMBIT);
  });

  it('TROOPER › Rapid Insertion: "must end that move wholly within 3" of your drop zone"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.trooper);
    const me = place(state, id, 4, 11);
    isolate(state, [id]);
    const def = getAction(REPOSITION_RAPID)!;
    expect(def.treatedAs).toBe('Reposition');
    // The p1 drop zone is x in [0,6]; a 28mm base is 0.55" — 8.4" is just inside 3" of it.
    expect(def.check(ctx, state, me, { path: { points: [{ x: 8.4, y: 11 }] } }).ok).toBe(true);
    const far = def.check(ctx, state, me, { path: { points: [{ x: 9.5, y: 11 }] } });
    expect(far.ok).toBe(false);
    expect(far.reason).toContain('wholly within 3"');
  });

  it('TROOPER › Swift Landing: "you can set it up within 4" horizontally of one of your Drop markers"', () => {
    const { state } = setup();
    expect(abilityText(CARD.trooper, AB.swiftLanding)).toContain('within 4" horizontally of one of your Drop markers');
    expect(landingRadius(state, state.operatives[opWith(state, 'p1', CARD.trooper)]!)).toBe(4);
    expect(landingRadius(state, state.operatives[opWith(state, 'p1', CARD.marksman)]!)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('Unique action — COMMAND', () => {
  it('"Select one other friendly TEMPESTUS AQUILON operative (excluding SERVO-SENTRY) visible to and within 6""', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tempestor);
    const me = place(state, id, 12, 11);
    const mate = place(state, opWith(state, 'p1', CARD.trooper), 16, 11);
    const sentry = place(state, opWith(state, 'p1', CARD.servoSentry), 14, 11);
    const far = place(state, opWith(state, 'p1', CARD.marksman), 25, 11);
    isolate(state, [id, mate.id, sentry.id, far.id]);
    const options = commandTargets(ctx, state, me).map((o) => o.id);
    expect(options).toContain(mate.id);
    expect(options).not.toContain(sentry.id); // "excluding SERVO-SENTRY"
    expect(options).not.toContain(far.id); // outside 6"
    expect(options).not.toContain(id); // "one OTHER friendly operative"
  });

  it('"Until the end of that operative\'s next activation, add 1 to its APL stat"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tempestor);
    const me = place(state, id, 12, 11);
    const mate = place(state, opWith(state, 'p1', CARD.trooper), 15, 11);
    isolate(state, [id, mate.id]);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.command, { targetOperativeId: mate.id }).state;
    expect(aplOf(ctx, s, s.operatives[mate.id]!)).toBe(3);
    const eff = s.effects.find((e) => e.rule === 'tempestus-aquilons.command' && e.operativeId === mate.id);
    expect(eff!.expiry).toMatchObject({ kind: 'endOfNextActivation', operativeId: mate.id });
  });

  it('the printed 6" is a SUPPORT distance, so a Comms Device widens it through `onSupportDistance`', () => {
    const { ctx, state } = setup();
    expect(actionOf(CARD.tempestor, ACT.command).text.startsWith('SUPPORT.')).toBe(true);
    const id = opWith(state, 'p1', CARD.tempestor);
    const me = place(state, id, 12, 11);
    const mate = place(state, opWith(state, 'p1', CARD.trooper), 20, 11); // 8" apart, outside 6"
    isolate(state, [id, mate.id]);
    expect(commandTargets(ctx, state, me).map((o) => o.id)).not.toContain(mate.id);
    ctx.hooks.on('onSupportDistance', { id: 'test.comms', sourceText: 'Comms Device: +3"' }, (ev) => {
      ev.inches += 3;
    });
    expect(commandTargets(ctx, state, me).map((o) => o.id)).toContain(mate.id);
  });

  it('"This operative cannot perform this action while within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tempestor);
    const me = place(state, id, 12, 11);
    place(state, opWith(state, 'p1', CARD.trooper), 15, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 12.9, 11);
    isolate(state, [id, foe.id, opWith(state, 'p1', CARD.trooper)]);
    const check = getAction(ACT.command)!.check(ctx, state, me, {});
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('control range');
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('SUDDEN OFFENSIVE: x is half the operatives that aren\'t incapacitated, rounding up', () => {
    const { ctx, state } = setup();
    expect(printed(SP.suddenOffensive)).toContain('halve the result (rounding up) to give you x');
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.suddenOffensive }, ctx).state;
    expect(s.effects.find((e) => e.rule === 'tempestus-aquilons.suddenOffensive')!.data!['x']).toBe(6); // 11 → 6
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    const balanced = (opId: string): boolean => {
      const op = s.operatives[opId]!;
      const foe = s.operatives[s.teams.p2.operativeIds[0]!]!;
      return effectiveRules(ctx, s, profileOf(op.datacardId, cardOf(op.datacardId).weapons[0]!.name), {
        operative: op,
        target: foe,
        weaponName: cardOf(op.datacardId).weapons[0]!.name,
      }).some((r) => r.id === 'Balanced');
    };
    const order = s.teams.p1.operativeIds;
    for (let i = 0; i < 7; i++) {
      s = activate(ctx, s, order[i]!);
      expect([i, balanced(order[i]!)]).toEqual([i, i < 6]);
      s = reduce(s, { t: 'EndActivation', operativeId: order[i]! }, ctx).state;
      s.activePlayer = 'p1';
    }
  });

  it('MAINTAIN MOMENTUM: "shooting against or fighting against a ready enemy operative" — never retaliating', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.trooper);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 15, 11);
    isolate(state, [id, foe.id]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.maintainMomentum }, ctx).state;
    const rules = (retaliating: boolean) =>
      ctx.hooks.emit('onWeaponRules', s, {
        state: s,
        operative: s.operatives[id]!,
        target: s.operatives[foe.id]!,
        weaponName: 'Hot‑shot lascarbine',
        profile: profileOf(CARD.trooper, 'Hot‑shot lascarbine'),
        type: 'ranged',
        retaliating,
        rules: [],
      }).rules;
    expect(rules(false).some((r) => r.id === 'Severe')).toBe(true);
    expect(rules(true).some((r) => r.id === 'Severe')).toBe(false);
    s.operatives[foe.id]!.ready = false;
    expect(rules(false).some((r) => r.id === 'Severe')).toBe(false);
  });

  it('EYE ABOVE: the Detected tokens, the defence re-roll and the double block', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.trooper), 12, 11);
    const a = place(state, opWith(state, 'p2', CARD.trooper), 18, 11);
    const b = place(state, opWith(state, 'p2', CARD.marksman), 20, 11); // within 3" of a
    const c = place(state, opWith(state, 'p2', CARD.precursor), 26, 11); // outside 3"
    isolate(state, [me.id, a.id, b.id, c.id]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: SP.eyeAbove, data: { operativeId: a.id } },
      ctx,
    ).state;
    const tokens = s.effects.filter((e) => e.rule === DETECTED_TOKEN && e.player === 'p1');
    expect(tokens.map((e) => e.operativeId).sort()).toEqual([a.id, b.id].sort());
    // "…gains one of your Detected tokens until the end of the turning point."
    for (const t of tokens) expect(t.expiry).toEqual({ kind: 'endOfTurningPoint' });
    // "Is shooting a friendly TEMPESTUS AQUILON operative, you can re-roll one of your defence dice."
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    const dice = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[a.id]!, s.operatives[me.id]!, profile, 'Hot‑shot lascarbine'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(dice.rerolls.map((g) => g.id)).toContain('tempestus-aquilons.eyeAbove.defence');
    // "…one of your blocks can be allocated to block two unresolved successes (instead of one)."
    s.sequence = fightSequence({
      attackerId: a.id,
      defenderId: me.id,
      attackerWeapon: 'Hot‑shot lascarbine',
      attacker: 'p2',
      defender: 'p1',
    });
    const melee = profileOf(CARD.trooper, 'Fists');
    const alloc = () =>
      ctx.hooks.emit('onBlockAllocation', s, {
        state: s,
        ctx: attackCtx(s.operatives[me.id]!, s.operatives[a.id]!, melee, 'Fists', 'melee'),
        brutal: false,
        blocks: 1,
        normalsCanBlockCrits: false,
      }).blocks;
    expect(alloc()).toBe(2);
    expect(alloc()).toBe(1); // "ONE of your blocks" — once per sequence
  });

  it('DROP AND SECURE: +1 to the contesting APL total and +1 Atk to melee weapons within 3" (max 4)', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.precursor), 15, 11);
    isolate(state, [me.id]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: SP.dropAndSecure, data: { markerId: 'centre' } },
      ctx,
    ).state;
    expect(markerController(ctx, s, s.markers['centre']!)).toBe('p1');
    const control = ctx.hooks.emit('onMarkerControl', s, {
      state: s,
      markerId: 'centre',
      aplByPlayer: { p1: 2, p2: 2 },
    });
    expect(control.aplByPlayer).toEqual({ p1: 3, p2: 2 });
    // "…add 1 to the Atk stat of its melee weapons (to a maximum of 4)."
    const dagger = profileOf(CARD.precursor, 'Tempestus dagger');
    const bump = (count: number): number =>
      ctx.hooks.emit('onCollectAttackDice', s, {
        state: s,
        ctx: attackCtx(s.operatives[me.id]!, s.operatives[s.teams.p2.operativeIds[0]!]!, dagger, 'Tempestus dagger', 'melee'),
        count,
        mods: zeroStatMods(),
      }).count;
    expect(bump(3)).toBe(4);
    expect(bump(4)).toBe(4); // capped
    // Out of range: no bump.
    s.operatives[me.id]!.pos = { x: 25, y: 3 };
    expect(bump(3)).toBe(3);
    // "Until the Ready step of the NEXT Strategy phase" — it survives the end of the turning
    // point (which is when `scoreEndOfTurningPoint` reads marker control) and dies at Ready.
    ctx.hooks.emit('onEndOfTP', s, { state: s });
    expect(s.effects.some((e) => e.rule === 'tempestus-aquilons.dropAndSecure')).toBe(true);
    s.turningPoint = 2;
    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 1 });
    expect(s.effects.some((e) => e.rule === 'tempestus-aquilons.dropAndSecure')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('HOT DROP: "wholly within your opponent\'s territory… if the target is within 6" of it"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.trooper);
    const me = place(state, id, 20, 11); // the p2 territory is x >= 15 on the test map
    const foe = place(state, opWith(state, 'p2', CARD.trooper), 24, 11);
    isolate(state, [id, foe.id]);
    expect(hotDropReady(state, 'p1', me)).toBe(true);
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, id);
    expect(tempestusAquilons.ploys.find((p) => p.id === FP.hotDrop)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.hotDrop }, ctx).state;
    const profile = profileOf(CARD.trooper, 'Hot‑shot lascarbine');
    const grants = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[id]!, s.operatives[foe.id]!, profile, 'Hot‑shot lascarbine'),
      dice: [],
      rerolls: [],
    });
    expect(grants.rerolls.map((g) => g.id)).toContain('tempestus-aquilons.hotDrop');
    // …and not when the target is further than 6".
    s.operatives[foe.id]!.pos = { x: 28, y: 3 };
    const none = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[id]!, s.operatives[foe.id]!, profile, 'Hot‑shot lascarbine'),
      dice: [],
      rerolls: [],
    });
    expect(none.rerolls).toEqual([]);
    // "…for a friendly TEMPESTUS AQUILON operative" is ONE roll, so the grant is disarmed at the
    // end of that operative's activation rather than living out the turning point.
    s.operatives[foe.id]!.pos = { x: 24, y: 11 };
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    const later = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[id]!, s.operatives[foe.id]!, profile, 'Hot‑shot lascarbine'),
      dice: [],
      rerolls: [],
    });
    expect(later.rerolls).toEqual([]);
    expect(REMINDER_ONLY[`${FP.hotDrop}.fight`]).toContain('shoot.ts ONLY');
  });

  it('HOT DROP also fires for an operative that "landed… during this activation"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.trooper);
    isolate(state, [id]);
    setAbove(state, 'p1', 0);
    state.effects.push({
      id: `above-${state.seq++}`,
      rule: ABOVE,
      source: { kind: 'ability', id: RULE.dropInsertion },
      operativeId: id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    state.operatives[id]!.pos = { x: -22, y: -18 };
    dropMarkerAt(state, 'p1', 0, { x: 3, y: 11 });
    let s = activate(ctx, state, id);
    expect(hotDropReady(s, 'p1', s.operatives[id]!)).toBe(false);
    s = act(ctx, s, id, LAND).state;
    expect(hotDropReady(s, 'p1', s.operatives[id]!)).toBe(true);
  });

  it('HOT DROP also fires for an operative that "dropped from Vantage terrain at least 2" higher"', () => {
    const map = testMap({ features: [vantagePlatform('deck', 10, 9, 6, 6, 3)] });
    const { ctx, state } = setup({ map });
    const id = opWith(state, 'p1', CARD.trooper);
    place(state, id, 12, 11, 3); // standing on the deck
    isolate(state, [id]);
    const s = activate(ctx, state, id); // the ledger records z = 3 on Vantage terrain
    expect(hotDropReady(s, 'p1', s.operatives[id]!)).toBe(false); // it has not dropped yet
    s.operatives[id]!.pos = { x: 8, y: 11 };
    s.operatives[id]!.z = 0;
    expect(hotDropReady(s, 'p1', s.operatives[id]!)).toBe(true);
  });

  it('ADJUST COORDINATES: a 5" landing radius, and no Dash, Shoot or Fight during this turning point', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.marksman); // not a TROOPER, so its base radius is 3"
    isolate(state, [id]);
    setAbove(state, 'p1', 0);
    state.effects.push({
      id: `above-${state.seq++}`,
      rule: ABOVE,
      source: { kind: 'ability', id: RULE.dropInsertion },
      operativeId: id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    state.operatives[id]!.pos = { x: -22, y: -18 };
    dropMarkerAt(state, 'p1', 0, { x: 10, y: 11 });
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, id);
    expect(landingRadius(s, s.operatives[id]!)).toBe(3);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.adjustCoordinates }, ctx).state;
    expect(landingRadius(s, s.operatives[id]!)).toBe(5);
    s = act(ctx, s, id, LAND).state;
    const banned = availableActions(ctx, s, s.operatives[id]!).filter((a) => !a.ok && /ADJUST COORDINATES/.test(a.reason ?? ''));
    expect(banned.map((a) => a.def.id).sort()).toContain('Shoot');
    expect(banned.map((a) => a.def.id)).toContain('Dash');
  });

  it('TEMPESTUS EXEMPLARS: "the Pick Up Marker, Place Marker or a mission action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.trooper);
    const me = place(state, id, 15, 11);
    isolate(state, [id]);
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.tempestusExemplars }, ctx).state;
    expect(actionCost(ctx, s, s.operatives[id]!, getAction('Pick Up Marker')!)).toBe(0);
    expect(actionCost(ctx, s, s.operatives[id]!, getAction('Place Marker')!)).toBe(0);
    expect(actionCost(ctx, s, s.operatives[id]!, getAction('Shoot')!)).toBe(1); // not a named action
  });

  it('TEMPESTUS EXEMPLARS excludes the SERVO-SENTRY and any operative with an APL stat higher than 2', () => {
    const { ctx, state } = setup();
    const usable = tempestusAquilons.ploys.find((p) => p.id === FP.tempestusExemplars)!.usable!;
    let s = activate(ctx, state, opWith(state, 'p1', CARD.servoSentry));
    expect(usable(s, 'p1')).toMatchObject({ ok: false, reason: 'excluding SERVO-SENTRY' });
    s.activeOperativeId = opWith(s, 'p1', CARD.tempestor);
    expect(usable(s, 'p1').ok).toBe(false); // APL 3
    s.activeOperativeId = opWith(s, 'p1', CARD.trooper);
    expect(usable(s, 'p1').ok).toBe(true);
  });

  it('PROGENA: "It regains up to 2D3 lost wounds, and… you can ignore any changes to its APL stat"', () => {
    const { ctx, state } = setup({ script: [3, 3] }); // 2D3 = 2 + 2
    const id = opWith(state, 'p1', CARD.trooper);
    state.operatives[id]!.wounds = 2;
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, id);
    s.operatives[id]!.aplMods.push(-1); // e.g. a stun grenade
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(1);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.progena }, ctx).state;
    expect(s.operatives[id]!.wounds).toBe(6);
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2); // the -1 is ignored
    // A change applied AFTER the ploy is ignored too, and `onStatMod` never mutates the operative.
    s.operatives[id]!.aplMods.push(-1);
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2);
    expect(s.operatives[id]!.aplMods).toEqual([-1, -1]);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('TEMPESTUS DAGGERS: "friendly TEMPESTUS AQUILON operatives (excluding SERVO-SENTRY) have the following melee weapon"', () => {
    const { ctx, state } = setup({ equipment: [EQ.tempestusDaggers] });
    const s = activate(ctx, state, opWith(state, 'p1', CARD.trooper));
    for (const op of aliveOperatives(s, 'p1')) {
      const granted = (op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
      const names = granted.map((w) => w.name).filter((n) => !/grenade/i.test(n)); // the GRENADIER's own
      const expected = op.datacardId === CARD.servoSentry ? [] : ['Tempestus dagger'];
      expect([op.datacardId, names]).toEqual([op.datacardId, expected]);
    }
    // The other side did not take the equipment.
    for (const op of aliveOperatives(s, 'p2')) {
      const granted = (op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
      expect(granted.map((w) => w.name)).not.toContain('Tempestus dagger');
    }
  });

  it('COMBAT STIMMS: "ignore any changes to the Move stat… from being injured"', () => {
    const { ctx, state } = setup({ equipment: [EQ.combatStimms] });
    const id = opWith(state, 'p1', CARD.trooper);
    const foeId = opWith(state, 'p2', CARD.trooper);
    state.operatives[id]!.wounds = 3; // 8 wounds → injured below 4
    state.operatives[foeId]!.wounds = 3;
    expect(moveOf(ctx, state, state.operatives[id]!)).toBe(6);
    expect(moveOf(ctx, state, state.operatives[foeId]!)).toBe(4); // 6 - 2, no stimms
  });

  it('DROP AUGURY: once per battle, and "it cannot be moved closer to your opponent\'s drop zone"', () => {
    const { ctx, state } = setup({ equipment: [EQ.dropAugury] });
    const ids = setAbove(state, 'p1', 1);
    const marker = dropMarkers(state, 'p1')[0]!;
    const before = { ...marker.pos };
    const op = state.operatives[ids[0]!]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    const after = { ...state.markers[marker.id]!.pos };
    expect(after).not.toEqual(before);
    expect(after.x).toBeLessThanOrEqual(before.x); // never toward the p2 drop zone (x = 24..30)
    // Once per battle.
    ctx.hooks.emit('onActivationStart', state, { state, operative: state.operatives[ids[1]!]! });
    expect(state.markers[marker.id]!.pos).toEqual(after);
  });

  it('REMOTE OVERSEER is reminder-only: `rollInitiative` never consults `rerollOffered`', () => {
    expect(printed(EQ.remoteOverseer)).toBe(
      'Once per battle, after rolling off to decide initiative, you can re-roll your dice.',
    );
    expect(REMINDER_ONLY[EQ.remoteOverseer]).toContain('rerollOffered');
    const ctx = teamContext([tempestusAquilons]);
    const reg = new HookRegistry();
    tempestusAquilons.register(reg, 'p1', ctx);
    // `initiativeRollModifiers` IS emitted, but only for a flat modifier before the D6 — this
    // team registers nothing against it rather than shipping a handler that changes nothing.
    expect(reg.has('initiativeRollModifiers')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Module contract', () => {
  it('registers nothing against a hook the engine never emits', () => {
    const NEVER_EMITTED = [
      'onBattleSetup',
      'onAttackDiceRetained',
      'onFreeActions',
      'onOrderChange',
      'onMoveRules',
      'onSetUpAgain',
    ] as const;
    const ctx = teamContext([tempestusAquilons]);
    const reg = new HookRegistry();
    tempestusAquilons.register(reg, 'p1', ctx);
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    for (const hook of [
      'canPerformAction',
      'onCollectAttackDice',
      'onWeaponRules',
      'onSelectWeapon',
      'onStrikeResolved',
      'onBlockAllocation',
      'onMarkerControl',
      'onStatMod',
      'onReadyStep',
      'onEndOfTP',
      'gambitOptions',
      'onPloyUsed',
    ] as const) {
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    }
    expect(hooksFor(ctx, 'p1').player).toBe('p1');
  });

  it('every reminder-only clause carries an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).sort()).toEqual(
      [
        RULE.gravChute,
        `${RULE.dropInsertion}.setup`,
        `${RULE.dropInsertion}.halfByTP1`,
        `${AB.veteran}.commandRerollFight`,
        `${AB.gunfight}.timing`,
        `${AB.viciousKnifeFighter}.block`,
        EQ.remoteOverseer,
        `${FP.hotDrop}.fight`,
      ].sort(),
    );
    for (const [key, reason] of Object.entries(REMINDER_ONLY)) {
      expect([key, reason.length > 60]).toEqual([key, true]);
    }
  });

  it('`aiHints` are complete: a role per datacard, a value per ploy and per equipment option', () => {
    const hints = tempestusAquilons.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    for (const ploy of tempestusAquilons.ploys) expect([ploy.id, hints.ployValue![ploy.id]! > 0]).toEqual([ploy.id, true]);
    // The two extra 0CP STRATEGIC GAMBITs need a value too, or the AI never picks them.
    for (const g of [DROP_MARKER_GAMBIT, RAPID_INSERTION_GAMBIT])
      expect([g, hints.ployValue![g]! > 0]).toEqual([g, true]);
    for (const eq of tempestusAquilons.equipment)
      expect([eq.id, hints.equipmentValue![eq.id] !== undefined]).toEqual([eq.id, true]);
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and
   * offers anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.command, CARD.tempestor],
      [LAND, CARD.trooper],
      [SHOOT_TURRET, CARD.servoSentry],
      [SHOOT_GUNFIGHT, CARD.gunfighter],
      [DASH_DYNAMIC, CARD.precursor],
      [REPOSITION_RAPID, CARD.trooper],
      [SMOKE_GRENADIER, CARD.grenadier],
      [STUN_GRENADIER, CARD.grenadier],
    ];
    const tried = new Map<string, number>();
    /** The board and the activation each action needs before its `check` is asked anything. */
    const arm = (actionId: string): { ctx: GameContext; state: GameState; opId: string; op: OperativeState } => {
      const datacardId = owners.find(([id]) => id === actionId)![1];
      const { ctx, state } = setup({ seed: 5 });
      state.teams.p1.cp = 0; // no Command Re-roll decisions to settle mid-sequence
      state.teams.p2.cp = 0;
      const opId = opWith(state, 'p1', datacardId);
      const mates = state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) state.operatives[id]!.pos = { x: 2 + (n++ % 12) * 1.6, y: 20 };
      place(state, opId, 8, 11);
      // A friendly the SUPPORT action can name (never the SERVO-SENTRY, which COMMAND excludes)…
      const mate = mates.find((id) => state.operatives[id]!.datacardId !== CARD.servoSentry)!;
      place(state, mate, 8, 12.4);
      place(state, foes[0]!, 11, 11); // a valid enemy target, not engaged
      place(state, foes[1]!, 12, 14);
      if (actionId === LAND) {
        dropMarkerAt(state, 'p1', 0, { x: 4, y: 11 });
        state.effects.push({
          id: `above-${state.seq++}`,
          rule: ABOVE,
          source: { kind: 'ability', id: RULE.dropInsertion },
          operativeId: opId,
          player: 'p1',
          expiry: { kind: 'endOfBattle' },
        });
        state.operatives[opId]!.pos = { x: -22, y: -18 };
      }
      if (actionId === SHOOT_GUNFIGHT) {
        state.effects.push({
          id: `debt-${state.seq++}`,
          rule: 'tempestus-aquilons.gunfightDebt',
          source: { kind: 'ability', id: AB.gunfight },
          operativeId: opId,
          player: 'p1',
          data: { targetId: foes[0]!, dice: 3, granted: true },
          expiry: { kind: 'endOfBattle' },
        });
      }
      let s = activate(ctx, state, opId, 'engage');
      s.operatives[opId]!.aplMods.push(1); // room for the prerequisite plus the action itself
      // Turret is the SECOND Shoot; Dash (Dynamic) only exists after a Charge.
      if (actionId === SHOOT_TURRET) {
        const first = act(ctx, s, opId, 'Shoot', { weaponName: 'Flamer', targetId: foes[0]! });
        expect(first.reason).toBeUndefined();
        s = settle(ctx, first.state);
      }
      if (actionId === DASH_DYNAMIC) {
        const charge = act(ctx, s, opId, 'Charge', { path: { points: [{ x: 9.6, y: 11 }] } });
        expect(charge.reason).toBeUndefined();
        s = settle(ctx, charge.state);
      }
      return { ctx, state: s, opId, op: s.operatives[opId]! };
    };
    for (const [actionId] of owners) {
      const probe = arm(actionId);
      const here = probe.op.pos;
      const attempts: Record<string, unknown>[] = [
        {},
        { targetPos: { ...here } },
        { targetPos: { x: 4, y: 11 } },
        { path: { points: [{ x: here.x + 0.4, y: here.y }] } },
        { path: { points: [{ x: here.x - 2, y: here.y }] } },
        { path: { points: [{ x: 6, y: 11 }] } },
        ...aliveOperatives(probe.state).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
      ];
      const def = getAction(actionId)!;
      for (const params of attempts) {
        if (def.available && !def.available(probe.ctx, probe.state, probe.op)) continue;
        if (!def.check(probe.ctx, probe.state, probe.op, params).ok) continue;
        // A fresh board per accepted attempt: the action is really performed, not just checked.
        const run = arm(actionId);
        const out = act(run.ctx, run.state, run.opId, actionId, params);
        tried.set(actionId, (tried.get(actionId) ?? 0) + 1);
        expect({ actionId, params, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    // Every one of the eight was reachable on that board, so no assertion above was vacuous.
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Drop Insertion on a real killzone', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`sets up a third above and lands it on ${mapId}`, () => {
      const map = mapById(mapId);
      const ctx = teamContext([tempestusAquilons], { seed: 3 });
      ctx.maps.set(map.id, map);
      const picks = defaultRoster(DATA);
      const state = battle({
        ctx,
        map,
        p1: { module: tempestusAquilons, picks },
        p2: { module: tempestusAquilons, picks },
      });
      // The harness parks operatives in a column; put p1's inside its real drop zone first.
      const zone = map.dropZones[state.setup.dropZone.p1 ?? 'p1']!;
      const anchor = zone[0]![0]!;
      state.teams.p1.operativeIds.forEach((id, i) => {
        state.operatives[id]!.pos = { x: anchor.x + 1 + (i % 3) * 1.4, y: anchor.y + 1 + Math.floor(i / 3) * 1.4 };
      });
      const ids = setAbove(state, 'p1', 1);
      expect(ids.length).toBeGreaterThan(0);
      const markers = dropMarkers(state, 'p1');
      expect(markers).toHaveLength(1);
      // "…wholly within your drop zone."
      expect(markerWhollyWithin(markers[0]!, zone)).toBe(true);
      const id = ids[0]!;
      let s = activate(ctx, state, id, 'engage');
      const out = act(ctx, s, id, LAND);
      expect([mapId, out.ok, out.reason]).toEqual([mapId, true, undefined]);
      s = out.state;
      expect(isAbove(s, s.operatives[id]!)).toBe(false);
      expect(s.operatives[id]!.pos.x).toBeGreaterThan(0);
      // "Within 3" horizontally of one of your Drop markers, or wholly within your drop zone."
      const gap = Math.hypot(s.operatives[id]!.pos.x - markers[0]!.pos.x, s.operatives[id]!.pos.y - markers[0]!.pos.y);
      expect(gap <= 4 + 0.55 + 0.4 || whollyWithinZone(ctx, s, id, zone)).toBe(true);
    });
  }
});

function whollyWithinZone(ctx: GameContext, state: GameState, id: string, zone: { x: number; y: number }[][]): boolean {
  const op = state.operatives[id]!;
  return baseWhollyWithin(op.pos, ctx.datacards.get(op.datacardId)!.base, op.rot, zone);
}

// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared ring
  // in tests/teams/soak.test.ts covers the batch; this mirror exercises the two extra STRATEGIC
  // GAMBITs, Turret, Salvo, Gunfight and Dynamic on both an open and a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([tempestusAquilons], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'tempestus-aquilons', operatives: roster(), equipment: [EQ.tempestusDaggers, EQ.combatStimms] },
          p2: { teamId: 'tempestus-aquilons', operatives: roster(), equipment: [EQ.dropAugury, EQ.remoteOverseer] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 6000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The team's own STRATEGIC GAMBITs and its unique action really ran.
      const log = result.state.log.map((l) => l.text).join('\n');
      expect(log).toContain('STRATEGIC GAMBIT');
      expect(log).toContain('Rapid Insertion');
      expect(log).toContain('COMMAND');
      // Nothing is set up above in an AI-driven game (the D-017 setter is never called), so no
      // Drop marker is ever placed — the honest consequence recorded in REMINDER_ONLY.
      expect(Object.keys(result.state.markers).filter((k) => k.startsWith('tempestus-aquilons.drop.'))).toEqual([]);
    }, 180000);
  }
});
