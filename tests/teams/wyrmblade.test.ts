/**
 * WYRMBLADE. Every test quotes the printed rule it pins, read out of
 * `data/teams/wyrmblade.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/wyrmblade/
 */
import { describe, expect, it } from 'vitest';
import { getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, successes, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { resolveFightDie } from '../../src/core/sequences/fight.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  inflictDamage,
  markerController,
  statMods,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/wyrmblade.json';
import { selectionEntries, teamData } from '../../src/teams/data.ts';
import { defaultRoster, entryId, validateRosterFor } from '../../src/teams/selection.ts';
import { FREE_ACTION_RULE } from '../../src/teams/helpers.ts';
import {
  ACT_ASSASSINATE,
  ACT_SNIPER_SOULSIGHT,
  ACT_TALON_SOULSIGHT,
  ACT_TARGET_VULN,
  AB_BLADED_STANCE,
  AB_GROUP,
  AB_OVERTHROW,
  BLASTING_CHARGE,
  CHARGE_CREEPING,
  CHARGE_QUICKSILVER,
  CHARGE_SWORDSMAN,
  CULT_KNIFE,
  DASH_CREEPING,
  EQ_BLASTING,
  EQ_KNIVES,
  EQ_SPOTLIGHTS,
  EQ_TRAPS,
  FIGHT_SWORDSMAN,
  FP_COILED,
  FP_LOYALTY,
  FP_PLAN,
  FP_SLINK,
  GUNNER,
  HEAVY_GUNNER,
  ICON_BEARER,
  KELERMORPH,
  LEADER,
  LOCUS,
  R_CULT_AGENT,
  R_CULT_AMBUSH,
  R_FAMILIAR,
  REMINDER_ONLY,
  SANCTUS_SNIPER,
  SANCTUS_TALON,
  SHOOT_GUNSLINGER,
  SOULSIGHT_TOKEN,
  SP_CROSSFIRE,
  SP_DAY,
  SP_DIVERT,
  SP_SHADOWS,
  TRAP_MARKER,
  WARRIOR,
  ambushFlags,
  orderFlipped,
  recordedOrder,
  trapMarkers,
  wyrmblade,
} from '../../src/teams/wyrmblade/index.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import { heavyBlock, rect, testMap } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type {
  GameState,
  KillzoneMap,
  OperativeState,
  PlayerId,
  TerrainFeature,
  WeaponProfile,
} from '../../src/core/types.ts';

const DATA = teamData('wyrmblade');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const RAW = rawJson as {
  notes: string[];
  selection: { constraints: { kind: string; role?: string; roles?: string[]; max?: number; group?: string; cost?: number }[] };
  strategyPloys: { text: string }[];
  firefightPloys: { text: string }[];
  equipment: { id: string; weapons?: { name: string; profiles: { rules: unknown[] }[] }[] }[];
};

const ROLES = [
  LEADER,
  KELERMORPH,
  LOCUS,
  GUNNER,
  HEAVY_GUNNER,
  ICON_BEARER,
  SANCTUS_SNIPER,
  SANCTUS_TALON,
  WARRIOR,
];

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  picks?: { datacardId: string }[];
  map?: KillzoneMap;
  script?: number[];
  seed?: number;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([wyrmblade], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.picks ?? rosterIncluding(wyrmblade, opts.roles ?? ROLES);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: wyrmblade, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: wyrmblade, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a distance / control-range rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

/** Lay both kill teams out well clear of each other, so nobody is accidentally engaged. */
function spread(state: GameState): void {
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    state.teams[player].operativeIds.forEach((id, i) => {
      const op = state.operatives[id];
      if (!op) return;
      op.pos = { x: (player === 'p1' ? 2 : 24) + (i % 2) * 2.5, y: 1.5 + Math.floor(i / 2) * 2.5 };
      op.z = 0;
    });
  }
}

/**
 * The module shadows every friendly operative's order at the moments the engine exposes; the
 * Gambit step is one of them, so this is exactly what a real turning point does before any
 * operative is activated.
 */
const snapshotOrders = (ctx: GameContext, state: GameState, player: PlayerId = 'p1'): void => {
  gambitOptions(ctx, state, player);
};

/** Activate `id` with an Engage order after recording the order it had before. */
function activateFrom(ctx: GameContext, state: GameState, id: string, from: 'engage' | 'conceal'): GameState {
  const op = state.operatives[id]!;
  op.order = from;
  op.ready = true;
  op.expended = false;
  snapshotOrders(ctx, state, op.player);
  return activate(ctx, state, id, 'engage');
}

const useGambit = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>): GameState => {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: id, ...(data ? { data } : {}) }, ctx);
  expect(out.ok, out.reason).toBe(true);
  out.state.phase = 'firefight';
  out.state.firefightStep = 'performActions';
  return out.state;
};

const usePloy = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>) =>
  reduce(state, { t: 'UsePloy', player: 'p1', ployId: id, ...(data ? { data } : {}) }, ctx);

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
  type: 'ranged' | 'melee' = 'ranged',
  rules = profile.rules,
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules,
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
  };
}

function shootSeq(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'retention',
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

function fightSeq(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attacker' | 'defender' | 'attackerWeapon'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'retention',
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    free: false,
    hatchway: false,
    ...over,
  };
}

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

/** A thin Light wall, for ONE WITH THE SHADOWS. */
function lightWall(id: string, x: number, y: number, w: number, h: number): TerrainFeature {
  return {
    id,
    kind: 'test.light',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [{ id: `${id}.body`, featureId: id, poly: rect(x, y, w, h), z0: 0, z1: 2, types: ['Light'], role: 'wall' }],
  };
}

// ---------------------------------------------------------------------------
describe('WYRMBLADE data (pinned against data/teams/wyrmblade.json)', () => {
  it('has 9 datacards: three APL 3 / Save 4+ CULT AGENTs on 32mm bases, six APL 2 / Save 5+ NEOPHYTEs', () => {
    expect(DATA.datacards).toHaveLength(9);
    for (const card of DATA.datacards) {
      expect(card.keywords).toContain('WYRMBLADE');
      expect(card.keywords).toContain('GENESTEALER CULTS');
      expect(card.keywords).toContain('TYRANIDS');
      expect(card.move).toBe(6);
    }
    const agents = DATA.datacards.filter((c) => c.keywords.includes('CULT AGENT'));
    expect(agents.map((c) => c.id)).toEqual([KELERMORPH, LOCUS, SANCTUS_SNIPER, SANCTUS_TALON]);
    for (const c of agents) expect(c).toMatchObject({ apl: 3, save: 4, wounds: 9, base: { shape: 'round', mm: 32 } });
    const neophytes = DATA.datacards.filter((c) => c.keywords.includes('NEOPHYTE'));
    expect(neophytes.map((c) => c.id)).toEqual([LEADER, GUNNER, HEAVY_GUNNER, ICON_BEARER, WARRIOR]);
    for (const c of neophytes) expect(c).toMatchObject({ apl: 2, save: 5 });
    expect(DATA.datacards.find((c) => c.id === LEADER)).toMatchObject({ wounds: 8, base: { shape: 'round', mm: 25 } });
    // Only the HEAVY GUNNER of the NEOPHYTEs is on a 32mm base.
    expect(neophytes.filter((c) => c.base.shape === 'round' && c.base.mm === 32).map((c) => c.id)).toEqual([
      HEAVY_GUNNER,
    ]);
  });

  it('exposes 3 faction rules, 4+4 ploys, 4 equipment options, 12 abilities and 4 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Familiar Territory', 'Cult Agent', 'Cult Ambush']);
    expect(wyrmblade.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(wyrmblade.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(wyrmblade.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(12);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(4);
    // Every ploy is 1CP and no name or id carries a glued-on "1CP" (the batch-3/4 scraper bug).
    for (const p of wyrmblade.ploys) {
      expect(p.cp).toBe(1);
      expect(p.id).not.toMatch(/1cp$/i);
      expect(p.name).not.toMatch(/1CP$/);
    }
    expect(RAW.notes).toEqual([]);
  });

  it('pins the weapon profiles the rules read', () => {
    const autostubs = DATA.datacards.find((c) => c.id === KELERMORPH)!.weapons.find((w) => w.name === 'Liberator autostubs')!;
    expect(autostubs.profiles.map((p) => p.name)).toEqual(['hypersense', 'long range', 'short range']);
    expect(profileOf(KELERMORPH, 'Liberator autostubs', 'hypersense')).toMatchObject({ atk: 5, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(KELERMORPH, 'Liberator autostubs', 'hypersense').rules.map((r) => r.raw)).toEqual([
      'Range 6"',
      'Saturate',
      'Seek Light',
      'Hypersense*',
    ]);
    const rifle = DATA.datacards.find((c) => c.id === SANCTUS_SNIPER)!.weapons.find((w) => w.name === 'Sanctus sniper rifle')!;
    expect(rifle.profiles.map((p) => p.name)).toEqual(['mobile', 'stationary']);
    expect(profileOf(SANCTUS_SNIPER, 'Sanctus sniper rifle', 'stationary').rules.map((r) => r.id)).toEqual([
      'Devastating',
      'Heavy',
      'Silent',
    ]);
    expect(profileOf(SANCTUS_TALON, 'Sanctus bio-dagger')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 6 });
    expect(profileOf(SANCTUS_TALON, 'Sanctus bio-dagger').rules.map((r) => r.raw)).toEqual(['Lethal 4+', 'Shock']);
    expect(profileOf(LOCUS, 'Locus blades')).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 6 });
    expect(profileOf(HEAVY_GUNNER, 'Heavy stubber', 'focused')).toMatchObject({ atk: 5, hit: 4, dmgN: 4, dmgC: 5 });
    expect(profileOf(GUNNER, 'Webber').rules.map((r) => r.id)).toEqual(['Range', 'Severe', 'Stun']);
  });

  it('Hypersense is the team’s one rare weapon rule and resolves to the KELERMORPH’s own ability (D-033)', () => {
    expect(DATA.rareWeaponRules).toEqual(['Hypersense']);
    expect(rareWeaponRuleText('Hypersense', 'wyrmblade')).toBe(
      abilityText(KELERMORPH, 'wyrmblade.kelermorph.hypersense'),
    );
    expect(rareWeaponRuleText('Hypersense', 'wyrmblade')).toContain('enemy operatives cannot be obscured');
  });

  it('the ploy section overrun is trimmed at load; the committed bytes still carry it', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(RAW.strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect(RAW.firefightPloys[3]!.text).toContain('Faction Equipment');
    expect(ruleText(SP_DIVERT).endsWith('subtract 1 from its APL stat until the end of its next activation.')).toBe(true);
  });

  it('DATA PROBLEM: the equipment weapon tables parse to rules: [] — the Blasting charge WR row is sliced out of the text', () => {
    const printed = RAW.equipment.find((e) => e.id === EQ_BLASTING)!;
    expect(printed.weapons![0]!.profiles[0]!.rules).toEqual([]); // the scraper lost the WR row
    expect(ruleText(EQ_BLASTING)).toContain('Range 4", Blast 1", Saturate');
    // The module parses it back out of the printed text.
    expect(BLASTING_CHARGE.profiles[0]!.rules.map((r) => r.raw)).toEqual(['Range 4"', 'Blast 1"', 'Saturate']);
    expect(BLASTING_CHARGE.profiles[0]).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 5, type: 'ranged' });
    // CULT KNIVES prints no WR row at all, so an empty rules list is correct there.
    expect(CULT_KNIFE.profiles[0]).toMatchObject({ atk: 3, hit: 4, dmgN: 3, dmgC: 4, type: 'melee' });
    expect(CULT_KNIFE.profiles[0]!.rules).toEqual([]);
  });

  it('the printed HEAVY GUNNER and CULT AGENT caps are live maxCount constraints, and both are enforced', () => {
    const printed = DATA.selection.rawText;
    expect(printed).toContain(
      'up to two GUNNER operatives, up to two HEAVY GUNNER operatives and up to two CULT AGENT operatives',
    );
    // That compound sentence used to collapse its last two caps into ONE constraint whose role was
    // the leftover string 'HEAVY GUNNER operatives and up to two CULT AGENT' — a role no selection
    // row and no datacard keyword carries, so it counted 0 and both printed caps went unenforced.
    // The scraper now emits one live row per printed cap.
    const caps = RAW.selection.constraints.filter((c) => c.kind === 'maxCount');
    expect(caps).toEqual([
      { kind: 'maxCount', role: 'GUNNER', max: 2 },
      { kind: 'maxCount', role: 'HEAVY GUNNER', max: 2 },
      { kind: 'maxCount', role: 'CULT AGENT', max: 2 },
    ]);
    // HEAVY GUNNER names three printed rows; CULT AGENT names none, so that cap counts through the
    // datacard KEYWORD its four starred operatives share.
    expect(DATA.selection.list.filter((e) => e.role === 'HEAVY GUNNER')).toHaveLength(3);
    expect(DATA.selection.list.some((e) => e.role === 'CULT AGENT')).toBe(false);
    expect(DATA.datacards.filter((c) => c.keywords.includes('CULT AGENT')).map((c) => c.id)).toEqual([
      KELERMORPH,
      LOCUS,
      SANCTUS_SNIPER,
      SANCTUS_TALON,
    ]);

    // Both caps now fire, and each counts ACROSS the different printed rows of its role rather than
    // per row: the default roster sits exactly on both, and one more of either is refused.
    const rowId = (needle: string): string => {
      const index = selectionEntries(DATA).findIndex((e) => e.rawText.includes(needle));
      expect(index).toBeGreaterThan(-1);
      return entryId(DATA, index);
    };
    const base = defaultRoster(DATA);
    expect(validateRosterFor(DATA, base).ok).toBe(true);
    const warriors = base.flatMap((p, i) => (p.datacardId === WARRIOR ? [i] : []));
    // A third HEAVY GUNNER, taken on the mining-laser row, so no single row is repeated three times.
    const threeHeavy = base.map((p, i) =>
      i === warriors[0]! ? { datacardId: HEAVY_GUNNER, entryId: rowId('mining laser') } : p,
    );
    expect(validateRosterFor(DATA, threeHeavy).errors).toEqual([
      'you cannot select more than 2 HEAVY GUNNER operatives (3 selected)',
    ]);
    // A third CULT AGENT: the SANCTUS SNIPER counts as two selections, so two WARRIORs make room.
    const threeAgents = [
      ...base.filter((_, i) => i !== warriors[0]! && i !== warriors[1]!),
      { datacardId: SANCTUS_SNIPER, entryId: rowId('SANCTUS SNIPER') },
    ];
    expect(validateRosterFor(DATA, threeAgents).errors).toEqual([
      'you cannot select more than 2 CULT AGENT operatives (3 selected)',
    ]);
  });

  it('DATA PROBLEM: markerGuide is empty and uniqueActions[].keywords is not emitted at all', () => {
    // FAMILIAR'S SOULSIGHT places "Soulsight tokens" and EXPLOSIVE TRAPS uses Mines markers, but
    // the guide the UI reads for a token's name and art is an empty string (the Elucidian STAKE
    // CLAIM / Legionary Grisly marker gap).
    expect((rawJson as { markerGuide: string }).markerGuide).toBe('');
    expect(actionOf(SANCTUS_SNIPER, ACT_SNIPER_SOULSIGHT).text).toContain('Soulsight tokens');
    // …and no unique action carries the `keywords` field the schema provides (confirmed on every
    // batch since it was first reported; here it is not emitted at all, the corsair shape).
    for (const card of DATA.datacards)
      for (const a of card.uniqueActions) expect(Object.keys(a)).not.toContain('keywords');
  });

  it('no printed effect list is truncated, and the section overrun drags a POPULATED weapons array', () => {
    // The batch-3/4 "text ends at a colon with the bullet list absent" bug is absent here.
    const bodies = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
      ...DATA.datacards.flatMap((c) => c.abilities),
      ...DATA.datacards.flatMap((c) => c.uniqueActions),
    ];
    for (const r of bodies) expect(r.text.trim().endsWith(':')).toBe(false);
    // The overrun's `weapons` array is populated (the Spectre Squad variant), not empty.
    const sp = (rawJson as { strategyPloys: { weapons?: { name: string }[] }[] }).strategyPloys[3]!;
    const fp = (rawJson as { firefightPloys: { weapons?: { name: string }[] }[] }).firefightPloys[3]!;
    expect(sp.weapons?.map((w) => w.name)).toEqual(['Blasting charge', 'Cult knife']);
    expect(fp.weapons?.map((w) => w.name)).toEqual(['Blasting charge', 'Cult knife']);
  });

  it('the printed selectionCost footnote is already encoded per entry, so the constraint is redundant', () => {
    expect(DATA.selection.footnotes['*']).toBe('These operatives count as two selections each.');
    const cost = RAW.selection.constraints.find((c) => c.kind === 'selectionCost');
    expect(cost).toMatchObject({ group: '*', cost: 2 });
    // `validateRosterFor` has no `selectionCost` branch — but every starred row already carries
    // `selectionCost: 2`, which the slot, group and half-selection counts all read.
    const starred = DATA.selection.list.filter((e) => e.footnoteGroup === '*');
    expect(starred.map((e) => e.role)).toEqual(['KELERMORPH', 'LOCUS', 'SANCTUS SNIPER', 'SANCTUS TALON']);
    for (const e of starred) expect(e.selectionCost).toBe(2);
    for (const e of DATA.selection.list.filter((x) => x.footnoteGroup !== '*')) expect(e.selectionCost).toBe(1);
  });

  it('defaultRoster is legal for the validator, fields 7 of 9 datacards and obeys every printed cap', () => {
    const picks = defaultRoster(DATA);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(picks).toHaveLength(12);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect([...DATA.datacards.map((c) => c.id)].filter((id) => !fielded.has(id))).toEqual([
      SANCTUS_SNIPER,
      SANCTUS_TALON,
    ]);
    // With the HEAVY GUNNER and CULT AGENT caps live, the roster that used to break both now sits
    // exactly on each: "up to two GUNNER operatives, up to two HEAVY GUNNER operatives and up to
    // two CULT AGENT operatives". The freed selections go to WARRIORs — the one role the printed
    // uniqueness exemption lets repeat — which is why the pick count rose from 11 to 12.
    expect(picks.filter((p) => p.datacardId === GUNNER)).toHaveLength(2); // printed cap: two
    expect(picks.filter((p) => p.datacardId === HEAVY_GUNNER)).toHaveLength(2); // printed cap: two
    const agents = new Set([KELERMORPH, LOCUS, SANCTUS_SNIPER, SANCTUS_TALON]);
    expect(picks.filter((p) => agents.has(p.datacardId))).toHaveLength(2); // printed cap: two
    expect(picks.filter((p) => p.datacardId === WARRIOR)).toHaveLength(4);
  });

  it('the enforced selection constraints do fire: uniqueExcept WARRIOR and maxCount GUNNER 2', () => {
    expect(DATA.selection.rawText).toContain('Other than WARRIOR operatives');
    const base = defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
    // "Other than WARRIOR operatives…" — three WARRIORs are legal, three ICON BEARERs are not.
    const swap = (from: string, to: string) =>
      base.map((p) => (p.datacardId === from ? { datacardId: to } : p));
    expect(validateRosterFor(DATA, swap(HEAVY_GUNNER, WARRIOR)).codes).not.toContain('unique');
    expect(validateRosterFor(DATA, swap(HEAVY_GUNNER, ICON_BEARER)).codes).toContain('unique');
    // "…up to two GUNNER operatives" — a third GUNNER is refused by the maxCount branch.
    const threeGunners = validateRosterFor(DATA, swap(ICON_BEARER, GUNNER));
    expect(threeGunners.codes).toContain('maxCount');
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE faction rules', () => {
  it('Familiar Territory is reminder-only: nothing can be "set up in HIDING"', () => {
    expect(ruleText(R_FAMILIAR)).toContain('one third of your kill team can be set up in HIDING');
    expect(ruleText(R_FAMILIAR)).toContain('Friendly operatives still in HIDING at the end of the second turning point');
    expect(REMINDER_ONLY[R_FAMILIAR]).toContain('no off-killzone reserve state');
    // No hook is registered for it — a declared-but-inert handler is the silent no-op
    // CLAUDE.md architecture rule 5 forbids.
    const { ctx, state } = setup();
    const before = state.operatives[opWith(state, 'p1', WARRIOR)]!.pos;
    expect(before.x).toBeGreaterThan(-50);
    expect(ctx.hooks.bindings().some((b) => b.id.startsWith(`${R_FAMILIAR}.`))).toBe(false);
  });

  it('Cult Agent: "Ignore the Piercing and Saturate weapon rules" when shooting a friendly CULT AGENT', () => {
    expect(ruleText(R_CULT_AGENT)).toContain('Ignore the Piercing and Saturate weapon rules');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const agent = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const flamer = profileOf(GUNNER, 'Flamer'); // Range 8", Saturate, Torrent 2"
    const rules = effectiveRules(ctx, state, flamer, { operative: shooter, target: agent, weaponName: 'Flamer' });
    expect(rules.some((r) => r.id === 'Saturate')).toBe(false);
    expect(rules.some((r) => r.id === 'Torrent')).toBe(true); // only Piercing and Saturate go
    const laser = profileOf(HEAVY_GUNNER, 'Mining laser'); // Heavy, Piercing 1
    const laserRules = effectiveRules(ctx, state, laser, {
      operative: shooter,
      target: agent,
      weaponName: 'Mining laser',
    });
    expect(laserRules.some((r) => r.id === 'Piercing')).toBe(false);
    expect(laserRules.some((r) => r.id === 'Heavy')).toBe(true);
  });

  it('Cult Agent leaves a NEOPHYTE alone, and applies whoever is shooting', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const neophyte = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const flamer = profileOf(GUNNER, 'Flamer');
    const rules = effectiveRules(ctx, state, flamer, { operative: shooter, target: neophyte, weaponName: 'Flamer' });
    expect(rules.some((r) => r.id === 'Saturate')).toBe(true);
  });

  it('Cult Agent: "you can retain one additional cover save", not cumulative with Vantage', () => {
    expect(ruleText(R_CULT_AGENT)).toContain('you can retain one additional cover save');
    expect(ruleText(R_CULT_AGENT)).toContain('isn’t cumulative with improved cover saves from Vantage terrain');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const agent = state.operatives[opWith(state, 'p1', LOCUS)]!;
    const autogun = profileOf(WARRIOR, 'Autogun');
    state.sequence = shootSeq({
      step: 'rollDefence',
      attackerId: shooter.id,
      targetId: agent.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autogun',
      inCover: true,
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, agent, autogun, 'Autogun'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(1);

    (state.sequence as ShootSequence).vantageImprovedCover = true;
    const vantage = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, agent, autogun, 'Autogun'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(vantage.extraCoverSaves).toBe(0);
  });

  it('Cult Ambush: an order changed from Conceal to Engage gives the operative’s weapons Ceaseless', () => {
    expect(ruleText(R_CULT_AMBUSH)).toContain('order was changed from Conceal to Engage at the start of that activation');
    expect(ruleText(R_CULT_AMBUSH)).toContain('weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const s = activateFrom(ctx, state, shooter, 'conceal');
    expect(orderFlipped(s, shooter)).toBe(true);
    const autogun = profileOf(WARRIOR, 'Autogun');
    const rules = effectiveRules(ctx, s, autogun, {
      operative: s.operatives[shooter]!,
      target: foe,
      weaponName: 'Autogun',
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
  });

  it('Cult Ambush gives nothing to an operative that was already on an Engage order and is seen', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const s = activateFrom(ctx, state, shooter, 'engage');
    expect(ambushFlags(s, shooter)).toEqual({ changed: false, unseen: false });
    const rules = effectiveRules(ctx, s, profileOf(WARRIOR, 'Autogun'), {
      operative: s.operatives[shooter]!,
      target: foe,
      weaponName: 'Autogun',
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('Cult Ambush: "or it wasn’t visible to enemy operatives at the start of that activation"', () => {
    const map = testMap({ features: [heavyBlock('divider', 14, 0, 2, 22, 6)] });
    const { ctx, state } = setup({ map });
    const shooter = opWith(state, 'p1', WARRIOR);
    place(state, shooter, 10, 11);
    for (const foe of aliveOperatives(state, 'p2')) place(state, foe.id, 20, 11);
    const s = activateFrom(ctx, state, shooter, 'engage'); // no order change at all
    expect(ambushFlags(s, shooter)).toEqual({ changed: false, unseen: true });
    const rules = effectiveRules(ctx, s, profileOf(WARRIOR, 'Autogun'), {
      operative: s.operatives[shooter]!,
      weaponName: 'Autogun',
      target: s.operatives[opWith(s, 'p2', WARRIOR)]!,
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
  });

  it('Cult Ambush is "during its activation" only — never while retaliating', () => {
    const { ctx, state } = setup();
    const locus = opWith(state, 'p1', LOCUS);
    const foe = state.operatives[opWith(state, 'p2', LOCUS)]!;
    const s = activateFrom(ctx, state, locus, 'conceal');
    const blades = profileOf(LOCUS, 'Locus blades');
    const own = effectiveRules(ctx, s, blades, {
      operative: s.operatives[locus]!,
      target: foe,
      weaponName: 'Locus blades',
    });
    expect(own.some((r) => r.id === 'Ceaseless')).toBe(true);
    const retaliating = effectiveRules(ctx, s, blades, {
      operative: s.operatives[locus]!,
      target: foe,
      weaponName: 'Locus blades',
      retaliating: true,
    });
    expect(retaliating.some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('the shadow order ledger records the order an operative ENDS its activation with', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    let s = activateFrom(ctx, state, id, 'conceal');
    expect(recordedOrder(s, id)).toBe('conceal'); // the pre-activation order survives the emit
    s.operatives[id]!.order = 'conceal'; // e.g. SLINK INTO DARKNESS
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    expect(recordedOrder(s, id)).toBe('conceal');
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE strategy ploys', () => {
  it('THE DAY IS AT HAND: ranged weapons have Rending until the end of that activation', () => {
    expect(ruleText(SP_DAY)).toContain('Its ranged weapons have the Rending weapon rule');
    const { ctx, state } = setup();
    const s0 = useGambit(ctx, state, SP_DAY);
    const id = opWith(s0, 'p1', WARRIOR);
    const s = activateFrom(ctx, s0, id, 'conceal');
    const rules = effectiveRules(ctx, s, profileOf(WARRIOR, 'Autogun'), {
      operative: s.operatives[id]!,
      target: s.operatives[opWith(s, 'p2', WARRIOR)]!,
      weaponName: 'Autogun',
    });
    expect(rules.some((r) => r.id === 'Rending')).toBe(true);
  });

  it('THE DAY IS AT HAND: "Add 1 to the Atk stat of its melee weapons (to a maximum of 5)"', () => {
    expect(ruleText(SP_DAY)).toContain('(to a maximum of 5)');
    const { ctx, state } = setup();
    const s0 = useGambit(ctx, state, SP_DAY);
    const locus = opWith(s0, 'p1', LOCUS);
    const s = activateFrom(ctx, s0, locus, 'conceal');
    const foe = s.operatives[opWith(s, 'p2', WARRIOR)]!;
    const gunButt = profileOf(LEADER, 'Gun butt'); // Atk 3
    const bumped = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[locus]!, foe, gunButt, 'Gun butt', 'melee'),
      count: gunButt.atk,
      mods: zeroStatMods(),
    });
    expect(bumped.mods.atk).toBe(1);
    const blades = profileOf(LOCUS, 'Locus blades'); // Atk 5 — already at the printed maximum
    const capped = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[locus]!, foe, blades, 'Locus blades', 'melee'),
      count: blades.atk,
      mods: zeroStatMods(),
    });
    expect(capped.mods.atk).toBe(0);
  });

  it('THE DAY IS AT HAND does nothing without the Conceal-to-Engage flip', () => {
    const { ctx, state } = setup();
    const s0 = useGambit(ctx, state, SP_DAY);
    const id = opWith(s0, 'p1', WARRIOR);
    const s = activateFrom(ctx, s0, id, 'engage');
    const rules = effectiveRules(ctx, s, profileOf(WARRIOR, 'Autogun'), {
      operative: s.operatives[id]!,
      target: s.operatives[opWith(s, 'p2', WARRIOR)]!,
      weaponName: 'Autogun',
    });
    expect(rules.some((r) => r.id === 'Rending')).toBe(false);
  });

  it('CROSSFIRE: the SECOND friendly operative to shoot a target gets Accurate 1', () => {
    expect(ruleText(SP_CROSSFIRE)).toContain(
      'an operative that another friendly WYRMBLADE operative has already shot during this turning point',
    );
    const { ctx, state } = setup();
    const s = useGambit(ctx, state, SP_CROSSFIRE);
    const first = s.operatives[opWith(s, 'p1', WARRIOR)]!;
    const second = s.operatives[opWith(s, 'p1', GUNNER)]!;
    const foe = s.operatives[opWith(s, 'p2', WARRIOR)]!;
    const autogun = profileOf(WARRIOR, 'Autogun');
    // Before anyone has shot: nothing.
    expect(
      effectiveRules(ctx, s, autogun, { operative: second, target: foe, weaponName: 'Autogun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
    // The first operative's shot writes the ledger…
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(first, foe, autogun, 'Autogun'),
      count: autogun.atk,
      mods: zeroStatMods(),
    });
    const rules = effectiveRules(ctx, s, autogun, { operative: second, target: foe, weaponName: 'Autogun' });
    expect(rules.find((r) => r.id === 'Accurate')?.x).toBe(1);
    // …but never for the operative that shot it (a lone operative cannot cross-fire itself).
    expect(
      effectiveRules(ctx, s, autogun, { operative: first, target: foe, weaponName: 'Autogun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });

  it('CROSSFIRE does nothing while the gambit has not been used', () => {
    const { ctx, state } = setup();
    const first = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const second = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const autogun = profileOf(WARRIOR, 'Autogun');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(first, foe, autogun, 'Autogun'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(
      effectiveRules(ctx, state, autogun, { operative: second, target: foe, weaponName: 'Autogun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });

  it('ONE WITH THE SHADOWS: intervening Light terrain obscures a Conceal-order friendly', () => {
    expect(ruleText(SP_SHADOWS)).toContain('if Light terrain is intervening, that friendly operative is obscured');
    const map = testMap({ features: [lightWall('shade', 12.4, 8, 0.3, 6)] });
    const { ctx, state } = setup({ map });
    const s = useGambit(ctx, state, SP_SHADOWS);
    const target = s.operatives[opWith(s, 'p1', WARRIOR)]!;
    const shooter = s.operatives[opWith(s, 'p2', GUNNER)]!;
    isolate(s, [target.id, shooter.id]);
    place(s, target.id, 9, 10.5);
    place(s, shooter.id, 16, 10.5);
    target.order = 'conceal';
    const autogun = profileOf(WARRIOR, 'Autogun');
    s.sequence = shootSeq({
      step: 'rollAttack',
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autogun',
    });
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shooter, target, autogun, 'Autogun'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((s.sequence as ShootSequence).obscured).toBe(true);
  });

  it('ONE WITH THE SHADOWS: "unless the intervening Light terrain is within 1" of either operative"', () => {
    const map = testMap({ features: [lightWall('shade', 12.4, 8, 0.3, 6)] });
    const { ctx, state } = setup({ map });
    const s = useGambit(ctx, state, SP_SHADOWS);
    const target = s.operatives[opWith(s, 'p1', WARRIOR)]!;
    const shooter = s.operatives[opWith(s, 'p2', GUNNER)]!;
    isolate(s, [target.id, shooter.id]);
    place(s, target.id, 12, 10.5); // base practically touching the wall
    place(s, shooter.id, 16, 10.5);
    target.order = 'conceal';
    s.sequence = shootSeq({
      step: 'rollAttack',
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autogun',
    });
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shooter, target, profileOf(WARRIOR, 'Autogun'), 'Autogun'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((s.sequence as ShootSequence).obscured).toBe(false);
  });

  it('DIVERT AND DISAPPEAR: up to three operatives, and a CULT AGENT "counts as two"', () => {
    expect(ruleText(SP_DIVERT)).toContain('Up to three friendly WYRMBLADE operatives');
    expect(ruleText(SP_DIVERT)).toContain('it counts as two operatives');
    const { ctx, state } = setup();
    const agent = opWith(state, 'p1', KELERMORPH);
    const one = opWith(state, 'p1', WARRIOR);
    const two = opWith(state, 'p1', GUNNER);
    spread(state); // nobody engaged
    const s = useGambit(ctx, state, SP_DIVERT, { operativeIds: [agent, one, two] });
    // "…can immediately perform a free Dash or Charge action" is AP outside the APL budget
    // (D-100), so the APL stat of every one of them is left exactly where the datacard prints it.
    expect(freeApOf(s, s.operatives[agent]!)).toBe(1);
    expect(freeApOf(s, s.operatives[one]!)).toBe(1);
    expect(s.operatives[agent]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s, s.operatives[agent]!)).toBe(3); // KELERMORPH, printed APL 3
    expect(apBudgetOf(ctx, s, s.operatives[agent]!)).toBe(4);
    expect(aplOf(ctx, s, s.operatives[one]!)).toBe(2); // NEOPHYTE WARRIOR, printed APL 2
    expect(apBudgetOf(ctx, s, s.operatives[one]!)).toBe(3);
    // 2 + 1 = the whole budget; the third named operative gets nothing.
    expect(freeApOf(s, s.operatives[two]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[two]!)).toBe(aplOf(ctx, s, s.operatives[two]!));
    const grant = s.effects.find((e) => e.rule === FREE_ACTION_RULE && e.operativeId === one);
    expect(grant?.data?.['only']).toEqual(['Dash', 'Charge']);
  });

  it('DIVERT AND DISAPPEAR: the free Charge "cannot move more than 3""', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    isolate(state, [id]);
    place(state, id, 10, 10);
    const s0 = useGambit(ctx, state, SP_DIVERT, { operativeIds: [id] });
    const s = activate(ctx, s0, id, 'engage');
    const op = s.operatives[id]!;
    op.apSpent = 2; // spending the granted AP
    const ev = ctx.hooks.emit('onMoveDistance', s, { state: s, operative: op, action: 'Charge', inches: 8 });
    expect(ev.inches).toBe(3);
    const own = ctx.hooks.emit('onMoveDistance', s, { state: s, operative: op, action: 'Reposition', inches: 6 });
    expect(own.inches).toBe(6);
  });

  it('DIVERT AND DISAPPEAR: the free action is a window, not a banked AP', () => {
    expect(ruleText(SP_DIVERT)).toContain('can immediately perform a free Dash or Charge action');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    spread(state);
    const s0 = useGambit(ctx, state, SP_DIVERT, { operativeIds: [id] });
    // The grant is AP outside the APL budget, so the printed APL 2 stays 2 (D-100).
    expect(s0.operatives[id]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s0, s0.operatives[id]!)).toBe(2);
    expect(apBudgetOf(ctx, s0, s0.operatives[id]!)).toBe(3);
    // "immediately": the grant expires with the activation it is spent in…
    let s = activate(ctx, s0, id, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    expect(s.effects.some((e) => e.rule === FREE_ACTION_RULE && e.operativeId === id)).toBe(false);
    expect(freeApOf(s, s.operatives[id]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[id]!)).toBe(2);
    // …and an operative that never spends it does not carry it into the next turning point.
    const stale = { ...s0, turningPoint: 2 };
    ctx.hooks.emit('onReadyStep', stale, { state: stale, player: 'p1', cp: 1 });
    expect(freeApOf(stale, stale.operatives[id]!)).toBe(0);
  });

  it('DIVERT AND DISAPPEAR: an engaged CULT AGENT is offered the free Fall Back and pays the −1 APL', () => {
    expect(ruleText(SP_DIVERT)).toContain('it can perform a free Fall Back action instead');
    const { ctx, state } = setup();
    const agent = opWith(state, 'p1', KELERMORPH);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [agent, foe]);
    place(state, agent, 10, 10);
    place(state, foe, 11.3, 10); // within control range
    const s0 = useGambit(ctx, state, SP_DIVERT, { operativeIds: [agent] });
    const grant = s0.effects.find((e) => e.rule === FREE_ACTION_RULE && e.operativeId === agent);
    expect(grant?.data?.['only']).toEqual(['Fall Back']);
    let s = activate(ctx, s0, agent, 'engage');
    const out = act(ctx, s, agent, 'Fall Back', { path: { points: [{ x: 12.5, y: 6 }] } });
    expect(out.ok, out.reason).toBe(true);
    s = reduce(out.state, { t: 'EndActivation', operativeId: agent }, ctx).state;
    expect(statMods(ctx, s, s.operatives[agent]!).apl).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE firefight ploys', () => {
  it('SLINK INTO DARKNESS changes an Engage order to Conceal, once per operative per battle', () => {
    expect(ruleText(FP_SLINK)).toContain('If that operative has an Engage order, change it to Conceal');
    expect(ruleText(FP_SLINK)).toContain('cannot use this ploy for each friendly operative more than once per battle');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    let s = activate(ctx, state, id, 'engage');
    const used = usePloy(ctx, s, FP_SLINK);
    expect(used.ok, used.reason).toBe(true);
    s = used.state;
    expect(s.operatives[id]!.order).toBe('conceal');
    // A second use for the SAME operative is refused, even in a later turning point.
    s.teams.p1.ploysUsedTP = [];
    s.operatives[id]!.order = 'engage';
    const again = usePloy(ctx, s, FP_SLINK);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('already been used for that operative');
  });

  it('COILED SERPENT retains a normal success as a critical success when SHOOTING', () => {
    expect(ruleText(FP_COILED)).toContain('you can retain one of your normal successes as a critical success instead');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    let s = activateFrom(ctx, state, id, 'conceal');
    const used = usePloy(ctx, s, FP_COILED);
    expect(used.ok, used.reason).toBe(true);
    s = used.state;
    const autogun = profileOf(WARRIOR, 'Autogun');
    const seq = shootSeq({
      attackerId: id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autogun',
      attack: pool([5, 5, 2, 2], 4),
    });
    s.sequence = seq;
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(0);
    effectiveRules(ctx, s, autogun, { operative: s.operatives[id]!, target: foe, weaponName: 'Autogun' });
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
    // "cannot come into effect more than once per activation"
    effectiveRules(ctx, s, autogun, { operative: s.operatives[id]!, target: foe, weaponName: 'Autogun' });
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('COILED SERPENT also lands in a FIGHT — the retention step is a seam both sequences share', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', LOCUS);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    let s = activateFrom(ctx, state, id, 'conceal');
    s = usePloy(ctx, s, FP_COILED).state;
    const blades = profileOf(LOCUS, 'Locus blades');
    const seq = fightSeq({
      attackerId: id,
      defenderId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      attackerWeapon: 'Locus blades',
      attackerPool: pool([4, 4, 1], 3),
    });
    s.sequence = seq;
    effectiveRules(ctx, s, blades, { operative: s.operatives[id]!, target: foe, weaponName: 'Locus blades' });
    expect(seq.attackerPool.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('COILED SERPENT is refused without the Conceal-to-Engage flip, and after the first Shoot or Fight', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', WARRIOR);
    const flat = activate(ctx, state, id, 'engage');
    expect(usePloy(ctx, flat, FP_COILED).reason).toContain('not changed from Conceal to Engage');

    const s = activateFrom(ctx, state, id, 'conceal');
    s.operatives[id]!.actionsThisActivation.push('Shoot');
    expect(usePloy(ctx, s, FP_COILED).reason).toContain('already performed the Shoot or Fight action');
  });

  it('UNQUESTIONING LOYALTY redirects the shot to a NEOPHYTE within 3", inheriting cover/obscured', () => {
    expect(ruleText(FP_LOYALTY)).toContain('to become the valid target');
    expect(ruleText(FP_LOYALTY)).toContain('that other operative is only in cover or obscured if the original target was');
    const { ctx, state } = setup();
    const agent = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const shield = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [agent.id, shield.id, shooter.id]);
    place(state, agent.id, 10, 10);
    place(state, shield.id, 11.5, 10);
    place(state, shooter.id, 18, 10);
    const s = usePloy(ctx, state, FP_LOYALTY).state;
    const autogun = profileOf(WARRIOR, 'Autogun');
    const ev = ctx.hooks.emit('onSelectTarget', s, {
      state: s,
      attacker: shooter,
      target: agent,
      weaponName: 'Autogun',
      profile: autogun,
      rules: autogun.rules,
    });
    expect(ev.redirectTo).toBe(shield.id);
  });

  it('UNQUESTIONING LOYALTY "has no effect … if the ranged weapon has the Blast or Torrent weapon rule"', () => {
    const { ctx, state } = setup();
    const agent = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const shield = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [agent.id, shield.id, shooter.id]);
    place(state, agent.id, 10, 10);
    place(state, shield.id, 11.5, 10);
    place(state, shooter.id, 18, 10);
    const s = usePloy(ctx, state, FP_LOYALTY).state;
    const flamer = profileOf(GUNNER, 'Flamer'); // Torrent 2"
    const ev = ctx.hooks.emit('onSelectTarget', s, {
      state: s,
      attacker: shooter,
      target: agent,
      weaponName: 'Flamer',
      profile: flamer,
      rules: flamer.rules,
    });
    expect(ev.redirectTo).toBeUndefined();
  });

  it('UNQUESTIONING LOYALTY’s Fight half is reminder-only', () => {
    expect(ruleText(FP_LOYALTY)).toContain('or to fight against during the Fight action');
    expect(REMINDER_ONLY[`${FP_LOYALTY}.fight`]).toContain('startShoot');
  });

  it('A PLAN GENERATIONS IN THE MAKING is reminder-only, and the AI never spends CP on it', () => {
    expect(ruleText(FP_PLAN)).toContain('It can perform a free mission action before it’s removed from the killzone');
    expect(REMINDER_ONLY[FP_PLAN]).toContain('onIncapacitated.freeActions is never consumed');
    expect(wyrmblade.aiHints?.ployValue?.[FP_PLAN]).toBe(0);
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    expect(usePloy(ctx, state, FP_PLAN).ok).toBe(false); // nobody has been incapacitated
    victim.incapacitated = true;
    const out = usePloy(ctx, state, FP_PLAN);
    expect(out.ok).toBe(true);
    const rec = out.state.effects.find((e) => e.rule === 'wyrmblade.aPlanReminder');
    expect(rec?.data?.['reminderOnly']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE faction equipment', () => {
  it('BLASTING CHARGES grants the printed weapon to NEOPHYTEs only, once per turning point', () => {
    expect(ruleText(EQ_BLASTING)).toContain('Once per turning point, a friendly WYRMBLADE NEOPHYTE operative');
    const { ctx, state } = setup({ equipment: [EQ_BLASTING] });
    const neophyte = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const agent = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const names = (op: OperativeState): string[] =>
      ctx.hooks.emit('availableWeapons', state, { state, operative: op, weapons: [] }).weapons;
    names(neophyte);
    names(agent);
    const has = (op: OperativeState): boolean =>
      ((op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).some(
        (w) => w.name === BLASTING_CHARGE.name,
      );
    expect(has(neophyte)).toBe(true);
    expect(has(agent)).toBe(false);
  });

  it('BLASTING CHARGES: the second throw of a turning point is refused at Select Weapon (D-032)', () => {
    const { ctx, state } = setup({ equipment: [EQ_BLASTING] });
    const thrower = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const ctxObj = attackCtx(thrower, foe, BLASTING_CHARGE.profiles[0]!, BLASTING_CHARGE.name);
    const dry = ctx.hooks.emit('onSelectWeapon', state, { state, ctx: ctxObj, allowed: true, dryRun: true });
    expect(dry.allowed).toBe(true); // a dry run must never claim the allowance
    const real = ctx.hooks.emit('onSelectWeapon', state, { state, ctx: ctxObj, allowed: true, dryRun: false });
    expect(real.allowed).toBe(true);
    const second = ctx.hooks.emit('onSelectWeapon', state, { state, ctx: ctxObj, allowed: true, dryRun: false });
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('once per turning point');
  });

  it('BLASTING CHARGES is not granted to a kill team that did not select it', () => {
    const { ctx, state } = setup();
    const neophyte = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    ctx.hooks.emit('availableWeapons', state, { state, operative: neophyte, weapons: [] });
    expect((neophyte as OperativeState & { grantedWeapons?: unknown[] }).grantedWeapons ?? []).toHaveLength(0);
  });

  it('CULT KNIVES: "Friendly WYRMBLADE NEOPHYTE operatives have the following melee weapon"', () => {
    expect(ruleText(EQ_KNIVES)).toContain('Friendly WYRMBLADE NEOPHYTE operatives have the following melee weapon');
    const { ctx, state } = setup({ equipment: [EQ_KNIVES] });
    const neophyte = state.operatives[opWith(state, 'p1', ICON_BEARER)]!;
    const agent = state.operatives[opWith(state, 'p1', SANCTUS_SNIPER)]!;
    for (const op of [neophyte, agent])
      ctx.hooks.emit('availableWeapons', state, { state, operative: op, weapons: [] });
    const knives = (op: OperativeState): boolean =>
      ((op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).some(
        (w) => w.name === CULT_KNIFE.name,
      );
    expect(knives(neophyte)).toBe(true);
    expect(knives(agent)).toBe(false);
  });

  it('EXPLOSIVE TRAPS sets up two Mines markers wholly within your territory', () => {
    expect(ruleText(EQ_TRAPS)).toContain('allows you to select two mines');
    const { ctx, state } = setup({ equipment: [EQ_TRAPS] });
    const id = opWith(state, 'p1', WARRIOR);
    const s = activate(ctx, state, id, 'engage');
    const traps = trapMarkers(s, 'p1');
    expect(traps).toHaveLength(2);
    for (const m of traps) {
      expect(m.kind).toBe('mine');
      expect(m.pos.x).toBeLessThan(15); // p1's territory is x < 15 on the test map
    }
    expect(s.markers[TRAP_MARKER('p1', 0)]).toBeDefined();
  });

  it('EXPLOSIVE TRAPS: "friendly WYRMBLADE operatives … cannot trigger or take damage from them"', () => {
    expect(ruleText(EQ_TRAPS)).toContain('cannot trigger or take damage from them');
    const { ctx, state } = setup({ equipment: [EQ_TRAPS] });
    const id = opWith(state, 'p1', WARRIOR);
    const s = activate(ctx, state, id, 'engage');
    const trap = trapMarkers(s, 'p1')[0]!;
    const victim = s.operatives[id]!;
    const wounds = victim.wounds;
    // Reproduce exactly what `checkMines` does: remove the marker, then inflict the damage.
    delete s.markers[trap.id];
    inflictDamage(ctx, s, victim, 5, 'mine');
    expect(victim.wounds).toBe(wounds); // "cannot take damage from them"
    expect(s.markers[trap.id]).toBeDefined(); // "cannot trigger" — the marker is put back
  });

  it('EXPLOSIVE TRAPS caps the kill team at two mines when the universal option is also taken', () => {
    expect(ruleText(EQ_TRAPS)).toContain('You cannot also select that equipment as normal (i.e. to give you three)');
    expect(REMINDER_ONLY[`${EQ_TRAPS}.exclusive`]).toContain('no veto');
    const { ctx, state } = setup({ equipment: [EQ_TRAPS] });
    // The harness context only carries this team's faction equipment, so the universal Mines
    // option is added to the kill team's list directly.
    state.teams.p1.equipment = [EQ_TRAPS, 'eq.mines'];
    const id = opWith(state, 'p1', WARRIOR);
    const s = activate(ctx, state, id, 'engage');
    expect(trapMarkers(s, 'p1')).toHaveLength(1); // + the universal Mines marker = two
  });

  it('EXPLOSIVE TRAPS finds legal positions on a real Approved Ops map too', () => {
    const ctx = teamContext([wyrmblade], { seed: 5 });
    const map = mapById('volkus-1');
    ctx.maps.set(map.id, map);
    const picks = rosterIncluding(wyrmblade, ROLES);
    const state = battle({
      ctx,
      map,
      p1: { module: wyrmblade, picks, equipment: [EQ_TRAPS] },
      p2: { module: wyrmblade, picks },
    });
    const s = activate(ctx, state, opWith(state, 'p1', WARRIOR), 'engage');
    expect(trapMarkers(s, 'p1')).toHaveLength(2);
  });

  it('SPOTLIGHTS: the target cannot be obscured while a free NEOPHYTE sees it within 6"', () => {
    expect(ruleText(EQ_SPOTLIGHTS)).toContain('the target cannot be obscured');
    const { ctx, state } = setup({ equipment: [EQ_SPOTLIGHTS] });
    const shooter = state.operatives[opWith(state, 'p1', HEAVY_GUNNER)]!;
    const lamp = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [shooter.id, lamp.id, foe.id]);
    place(state, shooter.id, 6, 10);
    place(state, foe.id, 16, 10);
    place(state, lamp.id, 12, 10);
    const seq = shootSeq({
      step: 'rollAttack',
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Heavy stubber',
      obscured: true,
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, foe, profileOf(HEAVY_GUNNER, 'Heavy stubber', 'focused'), 'Heavy stubber'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(false);
    // …and not while that NEOPHYTE is within control range of an enemy operative.
    place(state, lamp.id, 15.4, 10);
    seq.obscured = true;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, foe, profileOf(HEAVY_GUNNER, 'Heavy stubber', 'focused'), 'Heavy stubber'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE datacard abilities', () => {
  it('NEOPHYTE LEADER › Shadow Vector refunds SLINK INTO DARKNESS once per turning point', () => {
    expect(abilityText(LEADER, 'wyrmblade.neophyte-leader.shadow-vector')).toContain('for 0CP');
    const { ctx, state } = setup();
    const leader = opWith(state, 'p1', LEADER);
    const neophyte = opWith(state, 'p1', WARRIOR);
    isolate(state, [leader, neophyte]);
    place(state, leader, 10, 10);
    place(state, neophyte, 12, 10);
    let s = activate(ctx, state, neophyte, 'engage');
    const cp = s.teams.p1.cp;
    s = usePloy(ctx, s, FP_SLINK).state;
    expect(s.teams.p1.cp).toBe(cp); // 1CP charged, 1CP refunded
    expect(s.log.some((l) => l.text.includes('Shadow Vector'))).toBe(true);
  });

  it('KELERMORPH › Hypersense: "enemy operatives cannot be obscured" with that profile', () => {
    const { ctx, state } = setup();
    const kel = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const hyper = profileOf(KELERMORPH, 'Liberator autostubs', 'hypersense');
    const seq = shootSeq({
      step: 'rollAttack',
      attackerId: kel.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Liberator autostubs',
      profileName: 'hypersense',
      obscured: true,
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(kel, foe, hyper, 'Liberator autostubs'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(false);
    // The other two profiles carry no Hypersense, so they leave obscured alone.
    seq.obscured = true;
    const longRange = profileOf(KELERMORPH, 'Liberator autostubs', 'long range');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(kel, foe, longRange, 'Liberator autostubs'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(true);
  });

  it('KELERMORPH › Expert Gunslinger is a second Shoot action with its own restriction key', () => {
    expect(abilityText(KELERMORPH, 'wyrmblade.kelermorph.expert-gunslinger')).toContain('two Shoot actions');
    const def = getAction(SHOOT_GUNSLINGER)!;
    expect(def.ap).toBe(1);
    expect(def.treatedAs).toBeUndefined();
    const { ctx, state } = setup();
    const kel = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [kel.id, foe.id]);
    place(state, kel.id, 10, 10);
    place(state, foe.id, 13, 10);
    kel.order = 'engage';
    const params = { weaponName: 'Liberator autostubs', profileName: 'short range', targetId: foe.id };
    expect(def.check(ctx, state, kel, params).reason).toContain('second Shoot action');
    kel.actionsThisActivation.push('Shoot');
    expect(def.check(ctx, state, kel, params).ok).toBe(true);
    expect(def.available!(ctx, state, state.operatives[opWith(state, 'p1', WARRIOR)]!)).toBe(false);
  });

  it('KELERMORPH › Heroic Inspiration gives Severe when shooting, fighting AND retaliating', () => {
    const printed = abilityText(KELERMORPH, 'wyrmblade.kelermorph.heroic-inspiration');
    expect(printed).toContain('is shooting, fighting or retaliating');
    const { ctx, state } = setup();
    const kel = state.operatives[opWith(state, 'p1', KELERMORPH)]!;
    const mate = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [kel.id, mate.id, foe.id]);
    place(state, kel.id, 10, 10);
    place(state, mate.id, 11.5, 10);
    place(state, foe.id, 18, 10);
    const autogun = profileOf(WARRIOR, 'Autogun');
    const before = effectiveRules(ctx, state, autogun, { operative: mate, target: foe, weaponName: 'Autogun' });
    expect(before.some((r) => r.id === 'Severe')).toBe(false);

    // The KELERMORPH incapacitates an enemy this turning point.
    state.sequence = shootSeq({
      attackerId: kel.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Liberator autostubs',
    });
    const victim = state.operatives[opWith(state, 'p2', GUNNER)]!;
    inflictDamage(ctx, state, victim, victim.wounds, 'attack');
    expect(victim.incapacitated).toBe(true);
    state.sequence = undefined;

    for (const retaliating of [false, true]) {
      const rules = effectiveRules(ctx, state, autogun, {
        operative: mate,
        target: foe,
        weaponName: 'Autogun',
        retaliating,
      });
      expect(rules.some((r) => r.id === 'Severe')).toBe(true);
    }
    // Not for a CULT AGENT, and not beyond 3".
    const agent = state.operatives[opWith(state, 'p1', LOCUS)]!;
    place(state, agent.id, 11.5, 10);
    expect(
      effectiveRules(ctx, state, profileOf(LOCUS, 'Locus blades'), {
        operative: agent,
        target: foe,
        weaponName: 'Locus blades',
      }).some((r) => r.id === 'Severe'),
    ).toBe(false);
    place(state, mate.id, 18, 14);
    expect(
      effectiveRules(ctx, state, autogun, { operative: mate, target: foe, weaponName: 'Autogun' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(false);
  });

  it('LOCUS › Expert Swordsman is a second Fight action, plus a free Charge of at most 3"', () => {
    const printed = abilityText(LOCUS, 'wyrmblade.locus.expert-swordsman');
    expect(printed).toContain('two Fight actions');
    expect(printed).toContain('it cannot move more than 3"');
    expect(getAction(FIGHT_SWORDSMAN)!.ap).toBe(1);
    const charge = getAction(CHARGE_SWORDSMAN)!;
    expect(charge.ap).toBe(0); // "a free Charge action"
    expect(charge.treatedAs).toBeUndefined(); // so the Dash afterwards is still legal

    const { ctx, state } = setup();
    const locus = state.operatives[opWith(state, 'p1', LOCUS)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [locus.id, foe.id]);
    place(state, locus.id, 10, 10);
    place(state, foe.id, 14, 10);
    locus.order = 'engage';
    const path = { points: [{ x: 12.6, y: 10 }] };
    expect(charge.check(ctx, state, locus, { path }).reason).toContain('has not ended the Fight action');
    locus.actionsThisActivation.push('Fight');
    expect(charge.check(ctx, state, locus, { path }).ok).toBe(true);
    // …but "it cannot move more than 3" during that action".
    place(state, locus.id, 6, 10);
    expect(charge.check(ctx, state, locus, { path: { points: [{ x: 12.6, y: 10 }] } }).ok).toBe(false);
  });

  it('Fight (Expert Swordsman) refuses a friendly target, which src/ai/legal.ts offers freely (D-026)', () => {
    const { ctx, state } = setup();
    const locus = state.operatives[opWith(state, 'p1', LOCUS)]!;
    const mate = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [locus.id, mate.id, foe.id]);
    place(state, locus.id, 10, 10);
    place(state, mate.id, 10.9, 10);
    place(state, foe.id, 11.1, 10);
    locus.actionsThisActivation.push('Fight');
    const def = getAction(FIGHT_SWORDSMAN)!;
    expect(def.check(ctx, state, locus, { targetId: mate.id }).ok).toBe(false);
    expect(def.check(ctx, state, locus, { targetId: foe.id }).ok).toBe(true);
  });

  it('LOCUS › Bladed Stance: a retaliating LOCUS resolves first; the block clause is reminder-only', () => {
    expect(abilityText(LOCUS, AB_BLADED_STANCE)).toContain('resolve one of your successes before the normal order');
    expect(REMINDER_ONLY[`${AB_BLADED_STANCE}.block`]).toContain('strike/block options');
    const { ctx, state } = setup();
    const locus = state.operatives[opWith(state, 'p1', LOCUS)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const seq = fightSeq({
      step: 'rollAttack',
      attackerId: foe.id,
      defenderId: locus.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Gun butt',
      defenderWeapon: 'Locus blades',
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(locus, foe, profileOf(LOCUS, 'Locus blades'), 'Locus blades', 'melee'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect(seq.turn).toBe('defender');
  });

  it('LOCUS › Quicksilver Strike arms after an enemy moves and grants a 3" Charge into its control range', () => {
    const printed = abilityText(LOCUS, 'wyrmblade.locus.quicksilver-strike');
    expect(printed).toContain('after an enemy operative performs an action in which it moves');
    expect(printed).toContain('it must end that move within control range of that enemy operative');
    const { ctx, state } = setup();
    const locus = state.operatives[opWith(state, 'p1', LOCUS)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [locus.id, foe.id]);
    place(state, locus.id, 10, 10);
    place(state, foe.id, 12.5, 10);
    locus.order = 'conceal';
    const charge = getAction(CHARGE_QUICKSILVER)!;
    expect(charge.check(ctx, state, locus, { path: { points: [{ x: 11.4, y: 10 }] } }).reason).toContain(
      'has not been triggered',
    );

    // The enemy repositions and its activation ends: the interrupt is taken there.
    let s = activate(ctx, state, foe.id, 'engage');
    s.operatives[foe.id]!.actionsThisActivation.push('Reposition');
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    const armed = s.effects.find((e) => e.rule === 'wyrmblade.quicksilverMark' && e.operativeId === locus.id);
    expect(armed?.data?.['enemyId']).toBe(foe.id);

    s = activate(ctx, s, locus.id, 'conceal');
    const ok = charge.check(ctx, s, s.operatives[locus.id]!, { path: { points: [{ x: 11.4, y: 10 }] } });
    expect(ok.ok, ok.reason).toBe(true);
    // A move that does not end within control range of THAT enemy is refused.
    expect(charge.check(ctx, s, s.operatives[locus.id]!, { path: { points: [{ x: 10, y: 12 }] } }).ok).toBe(false);
    const out = act(ctx, s, locus.id, CHARGE_QUICKSILVER, { path: { points: [{ x: 11.4, y: 10 }] } });
    expect(out.ok, out.reason).toBe(true);
    expect(out.state.operatives[locus.id]!.order).toBe('engage'); // "you can change its order to do so"
    expect(out.state.operatives[locus.id]!.apSpent).toBe(0); // free
  });

  it('HEAVY GUNNER › Heavy Weapon Bipod: Ceaseless when it has not moved, Relentless on top of Cult Ambush', () => {
    const printed = abilityText(HEAVY_GUNNER, 'wyrmblade.neophyte-heavy-gunner.heavy-weapon-bipod');
    expect(printed).toContain('that weapon has the Ceaseless weapon rule');
    expect(printed).toContain('it has the Relentless weapon rule');
    const { ctx, state } = setup();
    const hg = opWith(state, 'p1', HEAVY_GUNNER);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const stubber = profileOf(HEAVY_GUNNER, 'Heavy stubber', 'focused');

    // Activated Engage-to-Engage and seen: Cult Ambush is off, so the Bipod gives Ceaseless.
    let s = activateFrom(ctx, state, hg, 'engage');
    let rules = effectiveRules(ctx, s, stubber, {
      operative: s.operatives[hg]!,
      target: foe,
      weaponName: 'Heavy stubber',
    });
    expect(rules.map((r) => r.id)).toContain('Ceaseless');
    expect(rules.map((r) => r.id)).not.toContain('Relentless');

    // After moving, the Bipod stands down.
    s.operatives[hg]!.actionsThisActivation.push('Reposition');
    rules = effectiveRules(ctx, s, stubber, {
      operative: s.operatives[hg]!,
      target: foe,
      weaponName: 'Heavy stubber',
    });
    expect(rules.map((r) => r.id)).not.toContain('Ceaseless');

    // Conceal-to-Engage: Cult Ambush grants Ceaseless first, so the Bipod upgrades it.
    const fresh = setup();
    const hg2 = opWith(fresh.state, 'p1', HEAVY_GUNNER);
    const s2 = activateFrom(fresh.ctx, fresh.state, hg2, 'conceal');
    const both = effectiveRules(fresh.ctx, s2, stubber, {
      operative: s2.operatives[hg2]!,
      target: s2.operatives[opWith(s2, 'p2', WARRIOR)]!,
      weaponName: 'Heavy stubber',
    });
    expect(both.map((r) => r.id)).toContain('Ceaseless');
    expect(both.map((r) => r.id)).toContain('Relentless');
  });

  it('Heavy Weapon Bipod is "a weapon from its datacard" — never a granted Blasting charge', () => {
    const { ctx, state } = setup({ equipment: [EQ_BLASTING] });
    const hg = opWith(state, 'p1', HEAVY_GUNNER);
    const s = activateFrom(ctx, state, hg, 'engage');
    const rules = effectiveRules(ctx, s, BLASTING_CHARGE.profiles[0]!, {
      operative: s.operatives[hg]!,
      target: s.operatives[opWith(s, 'p2', WARRIOR)]!,
      weaponName: BLASTING_CHARGE.name,
    });
    expect(rules.map((r) => r.id)).not.toContain('Ceaseless');
  });

  it('ICON BEARER › Icon Bearer: "treat this operative’s APL stat as 1 higher" for marker control', () => {
    expect(abilityText(ICON_BEARER, 'wyrmblade.neophyte-icon-bearer.icon-bearer')).toContain(
      'treat this operative’s APL stat as 1 higher',
    );
    const { ctx, state } = setup();
    const bearer = opWith(state, 'p1', ICON_BEARER);
    const foe = opWith(state, 'p2', LOCUS); // APL 3
    isolate(state, [bearer, foe]);
    const marker = state.markers['centre']!;
    place(state, bearer, marker.pos.x - 1.2, marker.pos.y);
    place(state, foe, marker.pos.x + 1.2, marker.pos.y);
    // APL 2 + 1 (Icon Bearer) = 3, tying the LOCUS's 3 — nobody controls it.
    expect(markerController(ctx, state, marker)).toBeNull();
    // Without the ICON BEARER's bonus the LOCUS would control it: swap in a WARRIOR to show it.
    const warrior = opWith(state, 'p1', WARRIOR);
    place(state, bearer, 1, 1);
    place(state, warrior, marker.pos.x - 1.2, marker.pos.y);
    expect(markerController(ctx, state, marker)).toBe('p2');
  });

  it('ICON BEARER › Overthrow the Oppressors is reminder-only (the free-action-on-death gap)', () => {
    const printed = abilityText(ICON_BEARER, AB_OVERTHROW);
    expect(printed).toContain('it can either perform one free Shoot action');
    expect(REMINDER_ONLY[AB_OVERTHROW]).toContain('D-024');
    const { ctx, state } = setup();
    const bearer = opWith(state, 'p1', ICON_BEARER);
    const victim = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    isolate(state, [bearer, victim.id]);
    place(state, bearer, 10, 10);
    place(state, victim.id, 12, 10);
    inflictDamage(ctx, state, victim, victim.wounds, 'attack');
    const rec = state.effects.find((e) => e.rule === 'wyrmblade.aPlanReminder' && e.operativeId === victim.id);
    expect(rec?.data?.['reminderOnly']).toBe(true);
    expect(victim.incapacitated).toBe(true); // nothing is granted, nothing is prevented
  });

  it('SANCTUS TALON › Creeping Shadow: Charge with a Conceal order, then a free Dash or Fall Back', () => {
    const printed = abilityText(SANCTUS_TALON, 'wyrmblade.sanctus-talon.creeping-shadow');
    expect(printed).toContain('can perform the Charge action while it has a Conceal order');
    expect(printed).toContain('a free Dash or Fall Back action afterwards');
    const charge = getAction(CHARGE_CREEPING)!;
    expect(charge.treatedAs).toBe('Charge');
    const { ctx, state } = setup();
    const talon = state.operatives[opWith(state, 'p1', SANCTUS_TALON)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [talon.id, foe.id]);
    place(state, talon.id, 10, 10);
    place(state, foe.id, 14, 10);
    talon.order = 'conceal';
    const path = { points: [{ x: 12.6, y: 10 }] };
    // The universal Charge refuses a Conceal order; this one does not.
    expect(getAction('Charge')!.check(ctx, state, talon, { path }).reason).toContain('Conceal order');
    expect(charge.check(ctx, state, talon, { path }).ok).toBe(true);

    const dash = getAction(DASH_CREEPING)!;
    expect(dash.ap).toBe(0);
    expect(dash.check(ctx, state, talon, { path: { points: [{ x: 11, y: 10 }] } }).reason).toContain(
      'has not performed the Fight action',
    );
    talon.actionsThisActivation.push('Charge', 'Fight');
    expect(dash.check(ctx, state, talon, { path: { points: [{ x: 11, y: 10 }] } }).ok).toBe(true);
  });

  it('NEOPHYTE WARRIOR › Group Activation records the pairing (partial: no activation-order seam)', () => {
    expect(abilityText(WARRIOR, AB_GROUP)).toContain('you must then activate one other ready friendly');
    expect(REMINDER_ONLY[`${AB_GROUP}.order`]).toContain('no activation-order seam');
    const twoWarriors = [...defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }))];
    twoWarriors[twoWarriors.length - 1] = { datacardId: WARRIOR };
    twoWarriors[twoWarriors.length - 2] = { datacardId: WARRIOR };
    const { ctx, state } = setup({ picks: twoWarriors });
    const warriors = aliveOperatives(state, 'p1').filter((o) => o.datacardId === WARRIOR);
    expect(warriors.length).toBeGreaterThan(1);
    let s = activate(ctx, state, warriors[0]!.id, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: warriors[0]!.id }, ctx).state;
    const pairing = s.effects.find((e) => e.rule === 'wyrmblade.groupActivation');
    expect(pairing?.operativeId).toBe(warriors[1]!.id);
    expect(pairing?.data?.['afterOperativeId']).toBe(warriors[0]!.id);
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE unique actions', () => {
  it('all four unique actions are priced as the card prints them and refuse an engaged operative', () => {
    expect(actionOf(SANCTUS_SNIPER, ACT_TARGET_VULN).ap).toBe(1);
    expect(actionOf(SANCTUS_SNIPER, ACT_SNIPER_SOULSIGHT).ap).toBe(1);
    expect(actionOf(SANCTUS_TALON, ACT_TALON_SOULSIGHT).ap).toBe(1);
    expect(actionOf(SANCTUS_TALON, ACT_ASSASSINATE).ap).toBe(2);
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', SANCTUS_SNIPER)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [sniper.id, foe.id]);
    place(state, sniper.id, 10, 10);
    place(state, foe.id, 11.2, 10); // within control range
    for (const id of [ACT_TARGET_VULN, ACT_SNIPER_SOULSIGHT]) {
      const res = getAction(id)!.check(ctx, state, sniper, {});
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('within control range');
    }
  });

  it('TARGET VULNERABILITY gives Lethal 5+ to the stationary profile only, for that activation', () => {
    expect(actionOf(SANCTUS_SNIPER, ACT_TARGET_VULN).text).toContain(
      'the stationary profile of its Sanctus sniper rifle has the Lethal 5+ weapon rule',
    );
    const { ctx, state } = setup();
    const sniper = opWith(state, 'p1', SANCTUS_SNIPER);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [sniper, foe.id]);
    place(state, sniper, 8, 10);
    place(state, foe.id, 18, 10);
    let s = activate(ctx, state, sniper, 'engage');
    const out = act(ctx, s, sniper, ACT_TARGET_VULN, {});
    expect(out.ok, out.reason).toBe(true);
    s = out.state;
    const stationary = profileOf(SANCTUS_SNIPER, 'Sanctus sniper rifle', 'stationary');
    const mobile = profileOf(SANCTUS_SNIPER, 'Sanctus sniper rifle', 'mobile');
    const withRule = effectiveRules(ctx, s, stationary, {
      operative: s.operatives[sniper]!,
      target: foe,
      weaponName: 'Sanctus sniper rifle',
    });
    expect(withRule.find((r) => r.id === 'Lethal')?.x).toBe(5);
    const without = effectiveRules(ctx, s, mobile, {
      operative: s.operatives[sniper]!,
      target: foe,
      weaponName: 'Sanctus sniper rifle',
    });
    expect(without.some((r) => r.id === 'Lethal')).toBe(false);
  });

  it('FAMILIAR’S SOULSIGHT (SNIPER): Saturate and "that enemy operative cannot be obscured"', () => {
    expect(actionOf(SANCTUS_SNIPER, ACT_SNIPER_SOULSIGHT).text).toContain('gains one of your Soulsight tokens');
    const { ctx, state } = setup();
    const sniper = opWith(state, 'p1', SANCTUS_SNIPER);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [sniper, foe.id]);
    place(state, sniper, 8, 10);
    place(state, foe.id, 18, 10);
    let s = activate(ctx, state, sniper, 'engage');
    const out = act(ctx, s, sniper, ACT_SNIPER_SOULSIGHT, { targetOperativeId: foe.id });
    expect(out.ok, out.reason).toBe(true);
    s = out.state;
    expect(s.effects.some((e) => e.rule === SOULSIGHT_TOKEN && e.operativeId === foe.id && e.player === 'p1')).toBe(true);
    const mobile = profileOf(SANCTUS_SNIPER, 'Sanctus sniper rifle', 'mobile');
    const rules = effectiveRules(ctx, s, mobile, {
      operative: s.operatives[sniper]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Sanctus sniper rifle',
    });
    expect(rules.some((r) => r.id === 'Saturate')).toBe(true);
    const seq = shootSeq({
      step: 'rollAttack',
      attackerId: sniper,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Sanctus sniper rifle',
      profileName: 'mobile',
      obscured: true,
    });
    s.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[sniper]!, s.operatives[foe.id]!, mobile, 'Sanctus sniper rifle'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(false);
  });

  it('FAMILIAR’S SOULSIGHT (TALON): Brutal and Balanced when fighting AND retaliating, one token at a time', () => {
    expect(actionOf(SANCTUS_TALON, ACT_TALON_SOULSIGHT).text).toContain('has the Brutal and Balanced weapon rules');
    expect(actionOf(SANCTUS_TALON, ACT_TALON_SOULSIGHT).text).toContain(
      'until this action is performed again by a friendly operative',
    );
    const { ctx, state } = setup();
    const talon = opWith(state, 'p1', SANCTUS_TALON);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const other = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [talon, foe.id, other.id]);
    place(state, talon, 8, 10);
    place(state, foe.id, 18, 10);
    place(state, other.id, 19, 12);
    let s = activate(ctx, state, talon, 'engage');
    s = act(ctx, s, talon, ACT_TALON_SOULSIGHT, { targetOperativeId: foe.id }).state;
    const dagger = profileOf(SANCTUS_TALON, 'Sanctus bio-dagger');
    for (const retaliating of [false, true]) {
      const rules = effectiveRules(ctx, s, dagger, {
        operative: s.operatives[talon]!,
        target: s.operatives[foe.id]!,
        weaponName: 'Sanctus bio-dagger',
        retaliating,
      });
      expect(rules.map((r) => r.id)).toEqual(expect.arrayContaining(['Brutal', 'Balanced']));
    }
    // Performing it again moves the token.
    s.operatives[talon]!.actionsThisActivation = [];
    s = act(ctx, s, talon, ACT_TALON_SOULSIGHT, { targetOperativeId: other.id }).state;
    expect(s.effects.filter((e) => e.rule === SOULSIGHT_TOKEN && e.player === 'p1')).toHaveLength(1);
    expect(s.effects.some((e) => e.rule === SOULSIGHT_TOKEN && e.operativeId === other.id)).toBe(true);
  });

  it('ASSASSINATE charges an unseen enemy, fights it, and resolves a second strike first', () => {
    const printed = actionOf(SANCTUS_TALON, ACT_ASSASSINATE).text;
    expect(printed).toContain('Select one enemy operative this operative isn’t visible to');
    expect(printed).toContain('you can immediately resolve another of your successes as a strike');
    const map = testMap({ features: [heavyBlock('screen', 12, 4, 1, 6, 6)] });
    const { ctx, state } = setup({ map, seed: 3 });
    const talon = opWith(state, 'p1', SANCTUS_TALON);
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [talon, foe.id]);
    place(state, talon, 10.5, 9.5);
    place(state, foe.id, 14, 9.5); // behind the screen: not visible
    // The straight-line default cannot route around terrain, so the caller supplies the path
    // (5" of the TALON's 6" Move, no Charge bonus — "don't add 2\"").
    const params = { targetOperativeId: foe.id, path: { points: [{ x: 12.5, y: 11.5 }, { x: 14, y: 11 }] } };
    const def = getAction(ACT_ASSASSINATE)!;
    let s = activate(ctx, state, talon, 'conceal');
    const legal = def.check(ctx, s, s.operatives[talon]!, params);
    expect(legal.ok, legal.reason).toBe(true);
    const out = act(ctx, s, talon, ACT_ASSASSINATE, params);
    expect(out.ok, out.reason).toBe(true);
    s = out.state;
    expect(s.operatives[talon]!.actionsThisActivation).toContain('Charge');
    expect(s.operatives[talon]!.actionsThisActivation).toContain('Fight');
    expect(s.sequence?.kind === 'fight' || s.operatives[foe.id]!.incapacitated || s.pending.length > 0).toBe(true);
  });

  it('ASSASSINATE: "The first time you strike … resolve another of your successes as a strike (before your opponent)"', () => {
    const { ctx, state } = setup();
    const talon = state.operatives[opWith(state, 'p1', SANCTUS_TALON)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [talon.id, foe.id]);
    place(state, talon.id, 10, 10);
    place(state, foe.id, 11, 10);
    const seq = fightSeq({
      step: 'resolve',
      attackerId: talon.id,
      defenderId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      attackerWeapon: 'Sanctus bio-dagger',
      defenderWeapon: 'Gun butt',
      attackerPool: pool([3, 4], 3),
      defenderPool: pool([4], 4),
    });
    state.sequence = seq;
    // Without ASSASSINATE's flag the strike is a plain one and the turn passes.
    const plain = successes(seq.attackerPool)[0]!;
    resolveFightDie(ctx, state, seq, 'attacker', plain.id, 'strike');
    expect(seq.attackerPool.dice.filter((d) => d.state === 'struck')).toHaveLength(1);
    expect(seq.turn).toBe('defender');

    // With it, a second success is resolved as a strike before the opponent gets the turn.
    const armed = setup();
    const t2 = armed.state.operatives[opWith(armed.state, 'p1', SANCTUS_TALON)]!;
    const f2 = armed.state.operatives[opWith(armed.state, 'p2', WARRIOR)]!;
    isolate(armed.state, [t2.id, f2.id]);
    place(armed.state, t2.id, 10, 10);
    place(armed.state, f2.id, 11, 10);
    const seq2 = fightSeq({
      step: 'resolve',
      attackerId: t2.id,
      defenderId: f2.id,
      attacker: 'p1',
      defender: 'p2',
      attackerWeapon: 'Sanctus bio-dagger',
      defenderWeapon: 'Gun butt',
      attackerPool: pool([3, 4], 3),
      defenderPool: pool([4], 4),
    });
    armed.state.sequence = seq2;
    armed.state.effects.push({
      id: 'test-assassinate',
      rule: 'wyrmblade.assassinate',
      source: { kind: 'ability', id: ACT_ASSASSINATE },
      operativeId: t2.id,
      player: 'p1',
      data: { enemyId: f2.id },
      expiry: { kind: 'endOfActivation', operativeId: t2.id },
    });
    const first = successes(seq2.attackerPool)[0]!;
    resolveFightDie(armed.ctx, armed.state, seq2, 'attacker', first.id, 'strike');
    expect(seq2.attackerPool.dice.filter((d) => d.state === 'struck')).toHaveLength(2);
    expect(seq2.turn).toBe('defender'); // "(before your opponent)"
    // …and only the FIRST time: the effect is spent.
    expect(armed.state.effects.some((e) => e.rule === 'wyrmblade.assassinate')).toBe(false);
  });

  it('ASSASSINATE is refused with an Engage order, or against an enemy it can already see', () => {
    const { ctx, state } = setup();
    const talon = state.operatives[opWith(state, 'p1', SANCTUS_TALON)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [talon.id, foe.id]);
    place(state, talon.id, 10, 10);
    place(state, foe.id, 13, 10);
    const def = getAction(ACT_ASSASSINATE)!;
    talon.order = 'engage';
    expect(def.check(ctx, state, talon, { targetOperativeId: foe.id }).reason).toContain('Engage order');
    talon.order = 'conceal';
    expect(def.check(ctx, state, talon, { targetOperativeId: foe.id }).reason).toContain('isn’t visible to');
  });
});

// ---------------------------------------------------------------------------
describe('WYRMBLADE AI hints', () => {
  it('every datacard has a role, every ploy a value and every equipment option a value', () => {
    const hints = wyrmblade.aiHints!;
    expect(Object.keys(hints.roles ?? {}).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue ?? {}).sort()).toEqual(wyrmblade.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue ?? {}).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
    for (const v of Object.values(hints.ployValue ?? {})) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('every REMINDER_ONLY entry names a printed rule and an engine reason', () => {
    const known = new Set<string>([
      ...DATA.factionRules.map((r) => r.id),
      ...DATA.strategyPloys.map((r) => r.id),
      ...DATA.firefightPloys.map((r) => r.id),
      ...DATA.equipment.map((r) => r.id),
      ...DATA.datacards.flatMap((c) => c.abilities.map((a) => a.id)),
      ...DATA.datacards.flatMap((c) => c.uniqueActions.map((a) => a.id)),
    ]);
    for (const [key, reason] of Object.entries(REMINDER_ONLY)) {
      const id = key.includes('.') ? key.replace(/\.(fight|block|order|exclusive)$/, '') : key;
      expect(known.has(id), key).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});


