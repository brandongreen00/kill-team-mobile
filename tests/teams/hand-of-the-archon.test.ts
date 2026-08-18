/**
 * HAND OF THE ARCHON. Every test quotes the printed rule it pins, read out of
 * `data/teams/hand-of-the-archon.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/hand-of-the-archon/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { reduce } from '../../src/core/reducer.ts';
import { readyStep } from '../../src/core/phases.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { checkTarget, effectiveRules, startShoot, advanceShoot } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, aplOf, inflictDamage, markerController, moveOf } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import { teamData } from '../../src/teams/data.ts';
import { rareRuleTextFor } from '../../src/teams/helpers.ts';
import rawJson from '../../data/teams/hand-of-the-archon.json';
import { defaultRoster, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  A,
  ACT,
  C,
  DRUGS,
  DRUG_TEXT,
  DUELLIST_FIGHT,
  EQ,
  FP,
  HUNTER_SHOOT,
  INVIGORATIONS,
  INVIGORATION_TEXT,
  PAIN,
  POISON,
  RULE,
  SP,
  SURGE_DASH,
  drugOf,
  handOfTheArchon,
  painOf,
  setCombatDrug,
  setOmen,
} from '../../src/teams/hand-of-the-archon/index.ts';
import { angelOfDeath } from '../../src/teams/angel-of-death/index.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { act, activate, battle, opWith, settle, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, KillzoneMap, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('hand-of-the-archon');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const RAW = rawJson as { notes: string[]; selection: { constraints: Record<string, unknown>[] } };

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};
const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;

/**
 * `defaultRoster` fills the eight list slots with eight AGENTs (the one role the printed
 * uniqueness constraint exempts), so every rule test uses the roster that fields all nine
 * datacards instead — one of each printed row.
 */
const ROSTER: RosterPickIn[] = [
  { datacardId: C.archsybarite, loadoutIds: ['hand-of-the-archon.g1.opt1'] },
  { datacardId: C.agent },
  { datacardId: C.duellist },
  { datacardId: C.disciple },
  { datacardId: C.elixicant },
  { datacardId: C.flayer },
  { datacardId: C.gunner, loadoutIds: ['hand-of-the-archon.g2e6.opt1'] },
  { datacardId: C.heavyGunner, loadoutIds: ['hand-of-the-archon.g2e7.opt1'] },
  { datacardId: C.assassin },
];

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  positions?: Vec2[];
  map?: KillzoneMap;
  /** Angels of Death give us 14–18 wound enemies, which Power From Pain's second bullet needs. */
  foeIsAstartes?: boolean;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const modules = opts.foeIsAstartes ? [handOfTheArchon, angelOfDeath] : [handOfTheArchon];
  const ctx = teamContext(modules, opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: {
      module: handOfTheArchon,
      picks: ROSTER,
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
      ...(opts.positions ? { positions: opts.positions } : {}),
    },
    p2: opts.foeIsAstartes ? { module: angelOfDeath } : { module: handOfTheArchon, picks: ROSTER },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Park every other operative far away so a control-range / distance rule sees only these two. */
function isolate(state: GameState, keep: string[]): void {
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1 + (Number(op.id.replace(/\D/g, '')) % 4), y: 21 };
  }
}

/** Hand an operative n Pain tokens directly, the way Power From Pain would. */
function givePain(state: GameState, op: OperativeState, n: number): void {
  for (let i = 0; i < n; i++) {
    state.effects.push({
      id: `pain-test-${state.seq++}`,
      rule: PAIN,
      source: { kind: 'ability', id: RULE.powerFromPain },
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfBattle' },
    });
  }
}

// ---------------------------------------------------------------------------
describe('HAND OF THE ARCHON data (pinned against data/teams/hand-of-the-archon.json)', () => {
  it('has 9 datacards, all APL 2 / M 7" / Sv 4+ on 25mm bases, the ARCHSYBARITE on 9 wounds', () => {
    expect(DATA.datacards).toHaveLength(9);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, move: 7, save: 4, base: { shape: 'round', mm: 25 } });
      expect(card.keywords).toContain('HAND OF THE ARCHON');
      expect(card.keywords).toContain('DRUKHARI');
      expect(card.keywords).toContain('AELDARI');
    }
    expect(DATA.datacards.find((c) => c.id === C.archsybarite)!.wounds).toBe(9);
    expect(DATA.datacards.filter((c) => c.wounds === 8)).toHaveLength(8);
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(C.archsybarite, 'Blast pistol')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(C.agent, 'Splinter rifle')).toMatchObject({ atk: 4, hit: 3, dmgN: 2, dmgC: 4 });
    expect(profileOf(C.duellist, 'Razorflail')).toMatchObject({ atk: 4, hit: 2, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.disciple, 'Stinger pistol')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 5 });
    expect(profileOf(C.flayer, 'Pain sculptors')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.heavyGunner, 'Dark lance')).toMatchObject({ atk: 4, hit: 3, dmgN: 6, dmgC: 7 });
    expect(profileOf(C.assassin, 'Shardcarbine')).toMatchObject({ atk: 4, hit: 2, dmgN: 2, dmgC: 2 });
    expect(profileOf(C.assassin, 'Razorwing').rules.map((r) => r.id)).toEqual(['Saturate', 'Seek', 'Silent']);
    // Every array of blades is the same 3/3+/3/4 melee profile.
    for (const card of DATA.datacards.filter((c) => c.weapons.some((w) => w.name === 'Array of blades')))
      expect(profileOf(card.id, 'Array of blades')).toMatchObject({ atk: 3, hit: 3, dmgN: 3, dmgC: 4, rules: [] });
    const cannon = DATA.datacards.find((c) => c.id === C.heavyGunner)!.weapons.find((w) => w.name === 'Splinter cannon')!;
    expect(cannon.profiles.map((p) => p.name)).toEqual(['focused', 'sweeping']);
    expect(cannon.profiles[0]).toMatchObject({ atk: 5 });
    expect(cannon.profiles[1]!.rules.map((r) => r.raw)).toContain('Torrent 1"');
  });

  it('exposes 3 faction rules, 4+4 ploys, 4 equipment options, 3 unique actions and 12 abilities', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Power From Pain', 'Invigorations', 'Rifles']);
    expect(handOfTheArchon.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(handOfTheArchon.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(handOfTheArchon.equipment.map((e) => e.id)).toEqual([
      EQ.chainSnare,
      EQ.toxinCoating,
      EQ.wickedBlades,
      EQ.refinedPoison,
    ]);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => `${a.name} ${a.ap}AP`)).toEqual([
      'TORMENT GRENADE 1AP',
      'ADMINISTER DRUG 1AP',
      'MARK 1AP',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(12);
    expect(RAW.notes).toEqual([]);
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('re-roll one of your defence dice.')).toBe(true);
  });

  it('Flay, Stinger and Tangle resolve to this team’s own printed datacard abilities (D-033)', () => {
    expect(DATA.rareWeaponRules).toEqual(['Flay', 'Stinger', 'Tangle']);
    expect(rareRuleTextFor(DATA, 'Flay')).toBe(abilityText(C.flayer, A.flay));
    expect(rareRuleTextFor(DATA, 'Stinger')).toBe(abilityText(C.disciple, A.stinger));
    expect(rareRuleTextFor(DATA, 'Tangle')).toBe(abilityText(C.duellist, A.tangle));
    expect(rareWeaponRuleText('Tangle', 'hand-of-the-archon')).toContain('block two unresolved successes');
    // Each is footnoted on the weapon that carries it.
    expect(profileOf(C.flayer, 'Pain sculptors').rules.map((r) => r.raw)).toContain('Flay*');
    expect(profileOf(C.disciple, 'Stinger pistol').rules.map((r) => r.raw)).toContain('Stinger*');
    expect(profileOf(C.duellist, 'Razorflail').rules.map((r) => r.raw)).toContain('Tangle*');
  });

  it('the four INVIGORATIONS are sliced out of the one printed faction rule', () => {
    const whole = ruleText(RULE.invigorations);
    expect(INVIGORATIONS).toHaveLength(4);
    for (const id of INVIGORATIONS) {
      expect(INVIGORATION_TEXT[id]).not.toBe('');
      expect(whole).toContain(INVIGORATION_TEXT[id]);
      expect(INVIGORATION_TEXT[id]).toContain('When:');
      expect(INVIGORATION_TEXT[id]).toContain('Effect:');
    }
    expect(INVIGORATION_TEXT['dark-animus']).toContain('add 1 to its APL stat');
    expect(INVIGORATION_TEXT['accelerated-rejuvenation']).toContain('regains D3+1 lost wounds');
    expect(INVIGORATION_TEXT['vitalised-surge']).toContain('free Dash action');
    expect(INVIGORATION_TEXT['stimulated-senses']).toContain('re-roll any of your dice results of one result');
  });

  it('the three COMBAT DRUG rules are sliced out of the ELIXICANT’s ability', () => {
    const whole = abilityText(C.elixicant, A.combatDrugs);
    for (const drug of DRUGS) expect(whole).toContain(DRUG_TEXT[drug]);
    expect(DRUG_TEXT.painbringer).toContain('on a 6, subtract 1 from that inflicted damage');
    expect(DRUG_TEXT.adrenalight).toContain('to gain one of your Pain tokens');
    expect(DRUG_TEXT.hypex).toContain('Move stat from being injured');
  });

  it('aiHints cover every datacard, all 8 ploys and all 4 equipment options', () => {
    const hints = handOfTheArchon.aiHints!;
    expect(Object.keys(hints.roles ?? {}).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue ?? {}).sort()).toEqual(handOfTheArchon.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue ?? {}).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });
});

// ---------------------------------------------------------------------------
describe('HAND OF THE ARCHON selection', () => {
  it('defaultRoster is a legal 9-operative kill team — but it is 8 AGENTs plus the ARCHSYBARITE', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(9);
    expect(picks[0]!.datacardId).toBe(C.archsybarite);
    // AGENT is the one role the printed uniqueness constraint exempts and it is first on the
    // list, so the fill loop takes it eight times. Legal, but it means a soak driven by
    // `defaultRoster` exercises 2 of the team's 9 datacards.
    expect(picks.slice(1).every((p) => p.datacardId === C.agent)).toBe(true);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    // The roster the rule tests use — one of each printed row — is legal too.
    expect(validateRosterFor(DATA, ROSTER).ok).toBe(true);
    expect(new Set(ROSTER.map((p) => p.datacardId)).size).toBe(9);
  });

  it('"Other than AGENT operatives, your kill team can only include each operative on this list once"', () => {
    const twoAgents = [...ROSTER.slice(0, 8), { datacardId: C.agent }];
    expect(validateRosterFor(DATA, twoAgents).codes).not.toContain('unique');
    const twoFlayers = [...ROSTER.slice(0, 8), { datacardId: C.flayer }];
    expect(validateRosterFor(DATA, twoFlayers).codes).toContain('unique');
  });

  /**
   * DATA BUG. The printed cap is "Your kill team can only include up to two darklight weapons
   * (blast pistol, blaster and dark lance are darklight weapons)"; `normalise.py` split it at the
   * first comma, so the constraint's `item` is the truncated `"darklight weapons (blast pistol"`.
   * `maxItem` IS enforced now (D-036), but it counts weapons whose NAME equals `item`, and no
   * weapon is called that — so the cap is silently dead and `defaultRoster` fields three
   * darklight weapons.
   */
  it('the printed darklight cap is a scraper mis-parse and is therefore unenforced', () => {
    expect(RAW.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['AGENT'] },
      { kind: 'maxItem', item: 'darklight weapons (blast pistol', max: 2 },
    ]);
    expect(DATA.selection.rawText).toContain(
      'up to two darklight weapons (blast pistol, blaster and dark lance are darklight weapons)',
    );
    const check = validateRosterFor(DATA, ROSTER);
    const weapons = check.weapons.flat().map((w) => w.toLowerCase());
    const darklight = weapons.filter((w) => ['blast pistol', 'blaster', 'dark lance'].includes(w));
    expect(darklight).toEqual(['blast pistol', 'blaster', 'dark lance']);
    // Three darklight weapons where the card prints a cap of two, and the validator still
    // calls the roster legal — the `maxItem` branch counts weapons NAMED `item`, and nothing
    // is called "darklight weapons (blast pistol".
    expect(check.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Power From Pain — "After a friendly HAND OF THE ARCHON operative performs an action, it gains one of your Pain tokens"', () => {
  it('"An enemy operative was incapacitated during that action"', () => {
    const { ctx, state } = setup();
    const killer = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [killer.id, foe.id]);
    place(state, killer.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    let s = activate(ctx, state, killer.id);
    foe.wounds = 1;
    s.operatives[foe.id]!.wounds = 1;
    const out = act(ctx, s, killer.id, 'Fight', { targetId: foe.id, meleeWeaponName: 'Razorflail' });
    s = out.state;
    // Settle the fight so the strike lands.
    let guard = 0;
    while (s.pending.length > 0 && guard++ < 20) {
      const d = s.pending[0]!;
      const strike = d.options.find((o) => o.id.startsWith('strike:') && !o.disabled) ?? d.options[0]!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: strike.id, ...(strike.data ? { data: strike.data } : {}) }, ctx).state;
    }
    expect(s.operatives[foe.id]!.incapacitated).toBe(true);
    expect(painOf(s, s.operatives[killer.id]!)).toBeGreaterThanOrEqual(1);
  });

  it('"If that enemy operative had a Wounds stat of 12 or more, that friendly operative gains two"', () => {
    const { ctx, state } = setup({ foeIsAstartes: true });
    const killer = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const foe = aliveOperatives(state, 'p2')[0]!;
    expect(ctx.datacards.get(foe.datacardId)!.wounds).toBeGreaterThanOrEqual(12);
    isolate(state, [killer.id, foe.id]);
    place(state, killer.id, 10, 10);
    place(state, foe.id, 12, 10);
    const s = activate(ctx, state, killer.id);
    s.operatives[foe.id]!.wounds = 2;
    inflictDamage(ctx, s, s.operatives[foe.id]!, 5, 'other');
    expect(s.log.some((l) => l.text.includes('gains two Pain tokens'))).toBe(true);
    // Two tokens gained; Vitalised Surge then spends one of them on the free Dash.
    expect(painOf(s, s.operatives[killer.id]!) + 1).toBe(2);
  });

  it('"An enemy operative was injured during that action, but was not incapacitated"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.gunner)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    const s = activate(ctx, state, shooter.id);
    // 8 wounds: crossing below 4 is the injury.
    inflictDamage(ctx, s, s.operatives[foe.id]!, 5, 'other');
    expect(painOf(s, s.operatives[shooter.id]!)).toBe(1);
    // A second action against an operative that is ALREADY injured pays nothing more.
    s.operatives[shooter.id]!.actionsThisActivation.push('Shoot');
    inflictDamage(ctx, s, s.operatives[foe.id]!, 1, 'other');
    expect(painOf(s, s.operatives[shooter.id]!)).toBe(1);
  });

  it('pays the operative that performed the action, so a kill made while retaliating pays nobody', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    let s = activate(ctx, state, foe.id); // the ENEMY is the active operative
    s.operatives[mine.id]!.wounds = 8;
    startFight(ctx, s, s.operatives[foe.id]!, 'Pain sculptors', undefined, mine.id);
    s.operatives[mine.id]!.wounds = 1;
    inflictDamage(ctx, s, s.operatives[foe.id]!, 99, 'other'); // my operative "kills" while retaliating
    expect(painOf(s, s.operatives[mine.id]!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Invigorations — "You can spend friendly operatives’ Pain tokens on invigorations"', () => {
  it('Accelerated Rejuvenation: "The operative regains D3+1 lost wounds" while injured', () => {
    const { ctx, state } = setup({ script: [4] }); // D3 = ceil(4/2) = 2
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    op.wounds = 3; // 8-wound card: injured
    givePain(state, op, 1);
    const s = activate(ctx, state, op.id);
    expect(s.operatives[op.id]!.wounds).toBe(6); // 3 + (D3 2 + 1)
    expect(painOf(s, s.operatives[op.id]!)).toBe(0);
  });

  it('Dark Animus: "add 1 to its APL stat" while not injured, and it ends at its next activation', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    givePain(state, op, 2);
    const s = activate(ctx, state, op.id);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(3);
    expect(painOf(s, s.operatives[op.id]!)).toBe(1);
    // "Until the start of the operative's next activation."
    const later = activate(ctx, { ...s, activeOperativeId: undefined, activePlayer: 'p1' }, op.id);
    expect(aplOf(ctx, later, later.operatives[op.id]!)).toBe(2);
  });

  it('"You cannot use more than one invigoration per activation or counteraction"', () => {
    const { ctx, state } = setup({ script: [2] }); // D3 = 1
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    op.wounds = 3;
    givePain(state, op, 3);
    const s = activate(ctx, state, op.id);
    // Accelerated Rejuvenation fired; Dark Animus is barred for the activation.
    expect(painOf(s, s.operatives[op.id]!)).toBe(2);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
  });

  it('Vitalised Surge: "can immediately perform a free Dash action" after incapacitating an enemy', () => {
    const { ctx, state } = setup();
    const killer = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [killer.id, foe.id]);
    place(state, killer.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    givePain(state, killer, 1); // one token: Dark Animus (which needs two) stays out of the way
    const s = activate(ctx, state, killer.id);
    s.operatives[foe.id]!.wounds = 1;
    inflictDamage(ctx, s, s.operatives[foe.id]!, 4, 'other'); // Power From Pain pays the second
    // D-015: the free action is one extra AP restricted to a Dash.
    expect(aplOf(ctx, s, s.operatives[killer.id]!)).toBe(3);
    expect(getAction(SURGE_DASH)!.available!(ctx, s, s.operatives[killer.id]!)).toBe(true);
    expect(painOf(s, s.operatives[killer.id]!)).toBe(1);
  });

  it('Stimulated Senses: "re-roll any of your dice results of one result" after rolling attack dice', () => {
    // Attack dice: 2,2,5,5 → the repeated failing result is 2 (Hit 3+), re-rolled into 6,6.
    const { ctx, state } = setup({ script: [2, 2, 5, 5, 6, 6, 1, 1, 1] });
    const shooter = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    givePain(state, shooter, 1);
    const s = activate(ctx, state, shooter.id);
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, foe.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.attack.dice.filter((d) => d.rerolledFrom === 2)).toHaveLength(2);
    expect(painOf(s, s.operatives[shooter.id]!)).toBe(0);
  });

  it('and does nothing when the operative holds no Pain token', () => {
    const { ctx, state } = setup({ script: [2, 2, 5, 5, 6, 6, 1, 1, 1] });
    const shooter = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    const s = activate(ctx, state, shooter.id);
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, foe.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.attack.dice.some((d) => d.rerolledFrom !== undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Rifles — "that weapon has the Accurate 1 weapon rule"', () => {
  function rulesFor(ctx: GameContext, state: GameState, opId: string): string[] {
    const op = state.operatives[opId]!;
    const target = aliveOperatives(state, 'p2')[0]!;
    return effectiveRules(ctx, state, profileOf(C.agent, 'Splinter rifle'), {
      operative: op,
      target,
      weaponName: 'Splinter rifle',
    }).map((r) => r.raw ?? r.id);
  }

  it('applies to a splinter rifle in an activation with no Charge, Fall Back or Reposition', () => {
    const { ctx, state } = setup();
    const agent = opWith(state, 'p1', C.agent);
    expect(rulesFor(ctx, state, agent)).toContain('Accurate 1 (Rifles)');
    state.operatives[agent]!.actionsThisActivation.push('Dash'); // Dash is not on the printed list
    expect(rulesFor(ctx, state, agent)).toContain('Accurate 1 (Rifles)');
  });

  it('is lost once the operative has performed the Reposition action', () => {
    const { ctx, state } = setup();
    const agent = opWith(state, 'p1', C.agent);
    state.operatives[agent]!.actionsThisActivation.push('Reposition');
    expect(rulesFor(ctx, state, agent)).not.toContain('Accurate 1 (Rifles)');
  });

  it('does not touch a stinger pistol', () => {
    const { ctx, state } = setup();
    const disciple = state.operatives[opWith(state, 'p1', C.disciple)]!;
    const rules = effectiveRules(ctx, state, profileOf(C.disciple, 'Stinger pistol'), {
      operative: disciple,
      weaponName: 'Stinger pistol',
    });
    expect(rules.some((r) => r.id === 'Accurate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('ARCHSYBARITE', () => {
  it('Cunning: "if this operative is in the killzone and you pass at the first opportunity, you gain 1CP"', () => {
    const { ctx, state } = setup();
    const before = state.teams.p1.cp;
    const s = activate(ctx, state, opWith(state, 'p1', C.agent));
    expect(s.teams.p1.cp).toBe(before + 1);
  });

  it('and pays nothing in a turning point in which a STRATEGIC GAMBIT was used', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.bladeArtists);
    const before = state.teams.p1.cp;
    const s = activate(ctx, state, opWith(state, 'p1', C.agent));
    expect(s.teams.p1.cp).toBe(before);
  });

  it('Torturous Vision: "it can gain one of your Pain tokens when you select a valid target"', () => {
    const { ctx, state } = setup();
    const arch = state.operatives[opWith(state, 'p1', C.archsybarite)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [arch.id, foe.id]);
    place(state, arch.id, 8, 10);
    place(state, foe.id, 12, 10);
    const s = activate(ctx, state, arch.id);
    startShoot(ctx, s, s.operatives[arch.id]!, 'Blast pistol', undefined, foe.id);
    expect(painOf(s, s.operatives[arch.id]!)).toBe(1);
    // "Once during each of this operative's activations" — a second shot adds nothing.
    const held = painOf(s, s.operatives[arch.id]!);
    startShoot(ctx, s, s.operatives[arch.id]!, 'Blast pistol', undefined, foe.id);
    expect(painOf(s, s.operatives[arch.id]!)).toBe(held);
  });

  it('and does nothing while it already has one of your Pain tokens', () => {
    const { ctx, state } = setup();
    const arch = state.operatives[opWith(state, 'p1', C.archsybarite)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [arch.id, foe.id]);
    place(state, arch.id, 8, 10);
    place(state, foe.id, 12, 10);
    givePain(state, arch, 1);
    const s = activate(ctx, state, arch.id);
    startShoot(ctx, s, s.operatives[arch.id]!, 'Blast pistol', undefined, foe.id);
    expect(painOf(s, s.operatives[arch.id]!)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('AGENT › Sadistic Competition — "one friendly AGENT operative that doesn’t have one of your Pain tokens can also gain one"', () => {
  it('rides on another operative’s gain, once per turning point', () => {
    const { ctx, state } = setup();
    const arch = state.operatives[opWith(state, 'p1', C.archsybarite)]!;
    const agent = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [arch.id, foe.id, agent.id]);
    place(state, arch.id, 8, 10);
    place(state, foe.id, 12, 10);
    const s = activate(ctx, state, arch.id);
    startShoot(ctx, s, s.operatives[arch.id]!, 'Blast pistol', undefined, foe.id); // Torturous Vision
    expect(painOf(s, s.operatives[arch.id]!)).toBe(1);
    expect(painOf(s, s.operatives[agent.id]!)).toBe(1);
    // Once per turning point: a second gain does not pay the AGENT again.
    const s2 = { ...s };
    s2.effects = s2.effects.filter((e) => !(e.rule === PAIN && e.operativeId === agent.id));
    inflictDamage(ctx, s2, s2.operatives[foe.id]!, 5, 'other');
    expect(painOf(s2, s2.operatives[agent.id]!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('CRIMSON DUELLIST', () => {
  it('"This operative can perform two Fight actions during its activation"', () => {
    const { ctx, state } = setup();
    const duellist = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [duellist.id, foe.id]);
    place(state, duellist.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const s = activate(ctx, state, duellist.id);
    // The extra Fight is refused until the first one has been performed.
    expect(getAction(DUELLIST_FIGHT)!.check(ctx, s, s.operatives[duellist.id]!, { targetId: foe.id }).ok).toBe(false);
    s.operatives[duellist.id]!.actionsThisActivation.push('Fight');
    expect(getAction(DUELLIST_FIGHT)!.check(ctx, s, s.operatives[duellist.id]!, { targetId: foe.id }).ok).toBe(true);
    // …and only the CRIMSON DUELLIST has it.
    expect(getAction(DUELLIST_FIGHT)!.available!(ctx, s, s.operatives[opWith(state, 'p1', C.agent)]!)).toBe(false);
  });

  it('Tangle: "each of your blocks can be allocated to block two unresolved successes (instead of one)"', () => {
    const { ctx, state } = setup();
    const duellist = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [duellist.id, foe.id]);
    place(state, duellist.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const profile = profileOf(C.duellist, 'Razorflail');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: duellist,
        defender: foe,
        weaponName: 'Razorflail',
        profile,
        rules: profile.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
  });

  it('Brutal Display: the marked enemy "cannot control markers or perform the Pick Up Marker or mission actions"', () => {
    const { ctx, state } = setup();
    const duellist = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const victim = state.operatives[opWith(state, 'p2', C.agent)]!;
    const other = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [duellist.id, victim.id, other.id]);
    place(state, duellist.id, 15, 11);
    place(state, victim.id, 15.7, 11);
    place(state, other.id, 17, 11);
    const s = activate(ctx, state, duellist.id);
    startFight(ctx, s, s.operatives[duellist.id]!, 'Razorflail', undefined, victim.id);
    s.operatives[victim.id]!.wounds = 1;
    inflictDamage(ctx, s, s.operatives[victim.id]!, 4, 'other');
    const marked = s.operatives[other.id]!;
    const canPickUp = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: marked,
      action: 'Pick Up Marker',
      allowed: true,
    });
    expect(canPickUp.allowed).toBe(false);
    // "cannot control markers": its APL no longer counts toward the marker it is standing on.
    s.markers['centre'] = {
      id: 'centre',
      kind: 'objective',
      diameterMm: 40,
      pos: { ...marked.pos },
      z: 0,
      owner: undefined as unknown as undefined,
      flags: {},
    };
    expect(markerController(ctx, s, s.markers['centre']!)).not.toBe('p2');
  });
});

// ---------------------------------------------------------------------------
describe('DISCIPLE OF YAELINDRA', () => {
  it('Stinger: "inflict D3 damage on each other operative visible to and within 2" of it"', () => {
    const { ctx, state } = setup({ script: [3, 3, 3] });
    const disciple = state.operatives[opWith(state, 'p1', C.disciple)]!;
    const victim = state.operatives[opWith(state, 'p2', C.agent)]!;
    const bystander = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [disciple.id, victim.id, bystander.id]);
    place(state, disciple.id, 8, 10);
    place(state, victim.id, 12, 10);
    place(state, bystander.id, 13, 10); // within 2" of the victim
    const s = activate(ctx, state, disciple.id);
    startShoot(ctx, s, s.operatives[disciple.id]!, 'Stinger pistol', undefined, victim.id);
    s.operatives[victim.id]!.wounds = 1;
    const before = s.operatives[bystander.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[victim.id]!, 3, 'other');
    expect(s.operatives[victim.id]!.incapacitated).toBe(true);
    expect(s.operatives[bystander.id]!.wounds).toBeLessThan(before);
  });

  it('TORMENT GRENADE: a poison test on the target "and each other operative within 1" of it"', () => {
    const printed = actionOf(C.disciple, ACT.tormentGrenade);
    expect(printed.text).toContain('takes a poison test');
    const { ctx, state } = setup({ script: [5, 2, 5, 2] });
    const disciple = state.operatives[opWith(state, 'p1', C.disciple)]!;
    const target = state.operatives[opWith(state, 'p2', C.agent)]!;
    const near = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [disciple.id, target.id, near.id]);
    place(state, disciple.id, 10, 10);
    place(state, target.id, 14, 10);
    place(state, near.id, 14.9, 10);
    let s = activate(ctx, state, disciple.id);
    const out = act(ctx, s, disciple.id, ACT.tormentGrenade, { targetOperativeId: target.id });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[target.id]!.wounds).toBeLessThan(8);
    expect(s.operatives[near.id]!.wounds).toBeLessThan(8);
    expect(s.effects.some((e) => e.rule === POISON && e.operativeId === target.id)).toBe(true);
    // "Whenever an operative that has one of your Poison tokens is activated, inflict D3 damage."
    const woundsBefore = s.operatives[target.id]!.wounds;
    s.activePlayer = 'p2';
    const s2 = activate(ctx, s, target.id);
    expect(s2.operatives[target.id]!.wounds).toBeLessThan(woundsBefore);
  });

  it('"This operative cannot perform this action while within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const disciple = state.operatives[opWith(state, 'p1', C.disciple)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [disciple.id, foe.id]);
    place(state, disciple.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const s = activate(ctx, state, disciple.id);
    const def = getAction(ACT.tormentGrenade)!;
    expect(def.check(ctx, s, s.operatives[disciple.id]!, { targetOperativeId: foe.id }).ok).toBe(false);
    // D-026: an enemy that is out of range is refused by `check`, never by `perform`.
    place(s, foe.id, 25, 20);
    expect(def.check(ctx, s, s.operatives[disciple.id]!, { targetOperativeId: foe.id }).ok).toBe(false);
    expect(def.check(ctx, s, s.operatives[disciple.id]!, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('ELIXICANT › Combat Drugs', () => {
  it('Painbringer: "on a 6, subtract 1 from that inflicted damage"', () => {
    const { ctx, state } = setup({ script: [6] });
    setCombatDrug(state, 'p1', 'painbringer');
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    expect(drugOf(state, op)).toBe('painbringer');
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: op, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(3);
  });

  it('and leaves damage of less than 3 alone', () => {
    const { ctx, state } = setup({ script: [6] });
    setCombatDrug(state, 'p1', 'painbringer');
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: op, amount: 2, kind: 'attack' });
    expect(ev.amount).toBe(2);
  });

  it('Adrenalight: "In the Ready step of each Strategy phase … gain one of your Pain tokens"', () => {
    const { ctx, state } = setup();
    setCombatDrug(state, 'p1', 'adrenalight');
    readyStep(ctx, state);
    expect(aliveOperatives(state, 'p1').filter((o) => painOf(state, o) > 0).length).toBeGreaterThanOrEqual(1);
    expect(aliveOperatives(state, 'p2').every((o) => painOf(state, o) === 0)).toBe(true);
  });

  it('Hypex: "you can ignore any changes to this operative’s Move stat from being injured"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    op.wounds = 3; // injured: -2"
    expect(moveOf(ctx, state, op)).toBe(5);
    setCombatDrug(state, 'p1', 'hypex');
    expect(moveOf(ctx, state, op)).toBe(7);
  });

  it('ADMINISTER DRUG: "It regains up to 2D3 lost wounds" or a different COMBAT DRUG', () => {
    const { ctx, state } = setup({ script: [4, 6] }); // 2D3 = 2 + 3
    setCombatDrug(state, 'p1', 'painbringer');
    const elixicant = state.operatives[opWith(state, 'p1', C.elixicant)]!;
    const patient = state.operatives[opWith(state, 'p1', C.agent)]!;
    isolate(state, [elixicant.id, patient.id]);
    place(state, elixicant.id, 10, 10);
    place(state, patient.id, 11.5, 10);
    patient.wounds = 2;
    let s = activate(ctx, state, elixicant.id);
    let out = act(ctx, s, elixicant.id, ACT.administerDrug, { targetOperativeId: patient.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[patient.id]!.wounds).toBe(7); // 2 + 2D3(2+3)
    // The other branch replaces that operative's COMBAT DRUG (action restrictions allow one
    // ADMINISTER DRUG per activation, so the second one is a fresh activation).
    s = out.state;
    s.operatives[patient.id]!.wounds = 8;
    s.operatives[elixicant.id]!.actionsThisActivation = [];
    s.operatives[elixicant.id]!.apSpent = 0;
    out = act(ctx, s, elixicant.id, ACT.administerDrug, { targetOperativeId: patient.id, choice: 'drug' });
    expect(out.ok).toBe(true);
    expect(drugOf(out.state, out.state.operatives[patient.id]!)).not.toBe('painbringer');
    expect(drugOf(out.state, out.state.operatives[elixicant.id]!)).toBe('painbringer');
  });

  it('refuses an enemy operative in `check` (D-026)', () => {
    const { ctx, state } = setup();
    const elixicant = state.operatives[opWith(state, 'p1', C.elixicant)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    place(state, foe.id, 11, 10);
    place(state, elixicant.id, 10, 10);
    const def = getAction(ACT.administerDrug)!;
    expect(def.check(ctx, state, elixicant, { targetOperativeId: foe.id }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FLAYER', () => {
  it('Insensible to Pain: "Normal and Critical Dmg of 3 or more inflicts 1 less damage on this operative"', () => {
    const { ctx, state } = setup();
    const flayer = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const other = state.operatives[opWith(state, 'p1', C.agent)]!;
    // A fight inflicts one dice at a time, so the amount IS the Dmg stat.
    expect(ctx.hooks.emit('onDamage', state, { state, ctx: null, target: flayer, amount: 4, kind: 'attack' }).amount).toBe(3);
    expect(ctx.hooks.emit('onDamage', state, { state, ctx: null, target: flayer, amount: 2, kind: 'attack' }).amount).toBe(2);
    expect(ctx.hooks.emit('onDamage', state, { state, ctx: null, target: other, amount: 4, kind: 'attack' }).amount).toBe(4);
  });

  it('Flay: "the first time you strike with a critical success during that sequence" pays a Pain token', () => {
    const { ctx, state } = setup();
    const flayer = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const friend = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [flayer.id, foe.id, friend.id]);
    place(state, flayer.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    place(state, friend.id, 13, 10); // within 6"
    const s = activate(ctx, state, flayer.id);
    startFight(ctx, s, s.operatives[flayer.id]!, 'Pain sculptors', undefined, foe.id);
    const profile = profileOf(C.flayer, 'Pain sculptors');
    const emit = (): void => {
      ctx.hooks.emit('onStrikeResolved', s, {
        state: s,
        ctx: {
          attacker: s.operatives[flayer.id]!,
          defender: s.operatives[foe.id]!,
          weaponName: 'Pain sculptors',
          profile,
          rules: profile.rules,
          type: 'melee',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 0,
        },
        crit: true,
        struck: s.operatives[foe.id]!,
      });
    };
    emit();
    const gained = aliveOperatives(s, 'p1').reduce((n, o) => n + painOf(s, o), 0);
    expect(gained).toBeGreaterThanOrEqual(1);
    emit(); // "the FIRST time … during that sequence"
    expect(aliveOperatives(s, 'p1').reduce((n, o) => n + painOf(s, o), 0)).toBe(gained);
  });
});

// ---------------------------------------------------------------------------
describe('SKYSPLINTER ASSASSIN', () => {
  it('Merciless Hunter: "a razorwing must be selected for one (and only one) of those actions"', () => {
    const { ctx, state } = setup();
    const assassin = state.operatives[opWith(state, 'p1', C.assassin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [assassin.id, foe.id]);
    place(state, assassin.id, 8, 10);
    place(state, foe.id, 14, 10);
    let s = activate(ctx, state, assassin.id);
    const def = getAction(HUNTER_SHOOT)!;
    // Not before the first Shoot action.
    expect(def.check(ctx, s, s.operatives[assassin.id]!, { weaponName: 'Razorwing', targetId: foe.id }).ok).toBe(false);
    const out = act(ctx, s, assassin.id, 'Shoot', { weaponName: 'Shardcarbine', targetId: foe.id });
    s = out.state;
    while (s.pending.length > 0) {
      const d = s.pending[0]!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: d.options[0]!.id }, ctx).state;
    }
    // The first action used a shardcarbine, so the second MUST use the razorwing.
    expect(def.check(ctx, s, s.operatives[assassin.id]!, { weaponName: 'Shardcarbine', targetId: foe.id }).reason).toContain(
      'razorwing',
    );
    expect(def.check(ctx, s, s.operatives[assassin.id]!, { weaponName: 'Razorwing', targetId: foe.id }).ok).toBe(true);
  });

  it('and is switched off for an activation in which it performed MARK', () => {
    const { ctx, state } = setup();
    const assassin = state.operatives[opWith(state, 'p1', C.assassin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [assassin.id, foe.id]);
    place(state, assassin.id, 8, 10);
    place(state, foe.id, 14, 10);
    const s = activate(ctx, state, assassin.id);
    s.operatives[assassin.id]!.actionsThisActivation.push('Shoot', ACT.mark);
    expect(getAction(HUNTER_SHOOT)!.check(ctx, s, s.operatives[assassin.id]!, { weaponName: 'Razorwing', targetId: foe.id }).ok).toBe(
      false,
    );
    // …and the clause bites the other way too: MARK is refused after the second Shoot action.
    const s2 = activate(ctx, { ...s, activeOperativeId: undefined, activePlayer: 'p1' }, assassin.id);
    s2.operatives[assassin.id]!.actionsThisActivation.push('Shoot', HUNTER_SHOOT);
    const ev = ctx.hooks.emit('canPerformAction', s2, {
      state: s2,
      operative: s2.operatives[assassin.id]!,
      action: ACT.mark,
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
  });

  it('MARK: "this operative’s ranged weapons have the Seek Light weapon rule" against that enemy only', () => {
    const { ctx, state } = setup();
    const assassin = state.operatives[opWith(state, 'p1', C.assassin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    const other = state.operatives[opWith(state, 'p2', C.flayer)]!;
    isolate(state, [assassin.id, foe.id, other.id]);
    place(state, assassin.id, 8, 10);
    place(state, foe.id, 14, 10);
    place(state, other.id, 14, 14);
    let s = activate(ctx, state, assassin.id);
    const out = act(ctx, s, assassin.id, ACT.mark, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    s = out.state;
    const rulesVs = (target: OperativeState): string[] =>
      effectiveRules(ctx, s, profileOf(C.assassin, 'Shardcarbine'), {
        operative: s.operatives[assassin.id]!,
        target,
        weaponName: 'Shardcarbine',
      }).map((r) => r.id);
    expect(rulesVs(s.operatives[foe.id]!)).toContain('SeekLight');
    expect(rulesVs(s.operatives[other.id]!)).not.toContain('SeekLight');
  });

  it('MARK: "That enemy operative cannot be obscured"', () => {
    const map = testMap({ features: [heavyBlock('block', 12, 9, 2, 4, 3)] });
    const { ctx, state } = setup({ map });
    const assassin = state.operatives[opWith(state, 'p1', C.assassin)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [assassin.id, foe.id]);
    place(state, assassin.id, 6, 11);
    place(state, foe.id, 20, 11);
    let s = activate(ctx, state, assassin.id);
    const out = act(ctx, s, assassin.id, ACT.mark, { targetOperativeId: foe.id });
    s = out.state;
    startShoot(ctx, s, s.operatives[assassin.id]!, 'Shardcarbine', undefined, foe.id);
    advanceShoot(ctx, s);
    expect((s.sequence as ShootSequence | null)?.obscured ?? false).toBe(false);
  });

  it('Omen: "If it’s an enemy operative, your opponent must re-roll their dice results of 6"', () => {
    const { ctx, state } = setup({ script: [6, 6, 3, 3, 1, 1, 2, 2, 2, 2] });
    const shooter = state.operatives[opWith(state, 'p2', C.agent)]!;
    const target = state.operatives[opWith(state, 'p1', C.agent)]!;
    isolate(state, [shooter.id, target.id]);
    place(state, shooter.id, 20, 10);
    place(state, target.id, 14, 10);
    setOmen(state, 'p1', shooter.id);
    const s = { ...state, activePlayer: 'p2' as const };
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, target.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.attack.dice.filter((d) => d.rerolledFrom === 6).length).toBe(2);
  });

  it('Omen: "If it’s a friendly operative, you can re-roll any of your dice results of 1" (defence dice)', () => {
    const { ctx, state } = setup({ script: [3, 3, 3, 3, 1, 1, 1, 5, 5, 5] });
    const shooter = state.operatives[opWith(state, 'p2', C.agent)]!;
    const target = state.operatives[opWith(state, 'p1', C.agent)]!;
    isolate(state, [shooter.id, target.id]);
    place(state, shooter.id, 20, 10);
    place(state, target.id, 14, 10);
    setOmen(state, 'p1', target.id);
    state.teams.p1.cp = 0;
    state.teams.p2.cp = 0; // no Command Re-roll decision before the defence dice are rolled
    const s = { ...state, activePlayer: 'p2' as const };
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, target.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.defence.dice.some((d) => d.rerolledFrom === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  const asGambit = (state: GameState, id: string): void => {
    state.teams.p1.gambitsUsedTP.push(id);
  };

  it('BLADE ARTISTS: "Friendly HAND OF THE ARCHON operatives’ melee weapons have the Rending weapon rule"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const melee = profileOf(C.flayer, 'Pain sculptors');
    const before = effectiveRules(ctx, state, melee, { operative: op, weaponName: 'Pain sculptors' });
    expect(before.some((r) => r.id === 'Rending')).toBe(false);
    asGambit(state, SP.bladeArtists);
    const after = effectiveRules(ctx, state, melee, { operative: op, weaponName: 'Pain sculptors' });
    expect(after.some((r) => r.id === 'Rending')).toBe(true);
    // Ranged weapons are untouched.
    const ranged = effectiveRules(ctx, state, profileOf(C.agent, 'Splinter rifle'), {
      operative: state.operatives[opWith(state, 'p1', C.agent)]!,
      weaponName: 'Splinter rifle',
    });
    expect(ranged.some((r) => r.id === 'Rending')).toBe(false);
  });

  it('MERCILESS SADISTS: Balanced against a wounded enemy, and not while retaliating', () => {
    const { ctx, state } = setup();
    asGambit(state, SP.mercilessSadists);
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    const profile = profileOf(C.agent, 'Splinter rifle');
    const rulesFor = (retaliating: boolean): string[] =>
      effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: 'Splinter rifle', retaliating }).map(
        (r) => r.id,
      );
    expect(rulesFor(false)).not.toContain('Balanced'); // not wounded yet
    foe.wounds = 5;
    expect(rulesFor(false)).toContain('Balanced');
    expect(rulesFor(true)).not.toContain('Balanced'); // "shooting against or fighting against"
  });

  it('FROM DARKNESS, DEATH: "you can retain one of your normal successes as a critical success instead"', () => {
    const { ctx, state } = setup({ script: [4, 4, 4, 4, 1, 1, 1] });
    asGambit(state, SP.fromDarknessDeath);
    // The DISCIPLE's only ranged weapon is a Range 8" stinger pistol, so an enemy 12" away is
    // "one enemy operative that friendly operative isn't a valid target for".
    const shooter = state.operatives[opWith(state, 'p1', C.disciple)]!;
    const foe = state.operatives[opWith(state, 'p2', C.archsybarite)]!; // lowest-id enemy
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 11);
    place(state, foe.id, 20, 11);
    state.teams.p1.cp = 0;
    state.teams.p2.cp = 0;
    const s = activate(ctx, state, shooter.id);
    expect(s.effects.find((e) => e.rule === 'handOfTheArchon.fromDarkness')?.data?.['targetId']).toBe(foe.id);
    place(s, foe.id, 14, 11); // now within Range 8"
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Stinger pistol', undefined, foe.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.attack.dice.filter((d) => d.note === 'FROM DARKNESS, DEATH')).toHaveLength(1);
    // …and only the first time: the effect is spent.
    expect(s.effects.some((e) => e.rule === 'handOfTheArchon.fromDarkness')).toBe(false);
  });

  it('DENIZENS OF NIGHT: "you can re-roll one of your defence dice" behind Heavy terrain', () => {
    const map = testMap({ features: [heavyBlock('block', 12, 9, 1, 4, 3)] });
    const { ctx, state } = setup({ map });
    asGambit(state, SP.denizensOfNight);
    const shooter = state.operatives[opWith(state, 'p2', C.agent)]!;
    const target = state.operatives[opWith(state, 'p1', C.agent)]!;
    isolate(state, [shooter.id, target.id]);
    place(state, shooter.id, 20, 11);
    place(state, target.id, 6, 11);
    const profile = profileOf(C.agent, 'Splinter rifle');
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: target,
        weaponName: 'Splinter rifle',
        profile,
        rules: profile.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 14,
      },
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('hand-of-the-archon.denizensOfNight');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('CRUEL DECEPTION: "that operative can perform the Fall Back action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [op.id, foe.id]);
    place(state, op.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, op.id);
    expect(actionCost(ctx, s, s.operatives[op.id]!, getAction('Fall Back')!)).toBe(2);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.cruelDeception }, ctx).state;
    expect(actionCost(ctx, s, s.operatives[op.id]!, getAction('Fall Back')!)).toBe(1);
  });

  it('HEINOUS ARROGANCE: "You can skip that activation"', () => {
    const { ctx, state } = setup();
    state.activePlayer = 'p1';
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.heinousArrogance }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.activePlayer).toBe('p2');
    // Nothing is expended: every friendly operative is still ready.
    expect(aliveOperatives(out.state, 'p1').every((o) => o.ready)).toBe(true);
  });

  it('DEVIOUS SCHEME: "The next time they would use that ploy, they must spend 1 additional CP"', () => {
    const { ctx, state } = setup();
    state.teams.p1.cp = 6;
    state.teams.p2.cp = 6;
    // The opponent uses a 1CP firefight ploy during their own activation…
    let s = activate(ctx, state, opWith(state, 'p2', C.agent));
    const cpAfterActivation = s.teams.p2.cp; // Cunning pays 1CP at the first activation
    s = reduce(s, { t: 'UsePloy', player: 'p2', ployId: FP.cruelDeception }, ctx).state;
    expect(s.teams.p2.cp).toBe(cpAfterActivation - 1);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.deviousScheme }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'handOfTheArchon.deviousScheme')).toBe(true);
    // "You cannot use this ploy again during the battle until its effect has ended."
    expect(handOfTheArchon.ploys.find((p) => p.id === FP.deviousScheme)!.usable!(s, 'p1').ok).toBe(false);
    // …and pays 1CP more the next time they use it.
    s.teams.p2.ploysUsedTP = [];
    const before = s.teams.p2.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p2', ployId: FP.cruelDeception }, ctx).state;
    expect(s.teams.p2.cp).toBe(before - 2);
    expect(s.effects.some((e) => e.rule === 'handOfTheArchon.deviousScheme')).toBe(false);
  });

  it('PREY ON THE WOUNDED: "You can re-roll any of your attack dice" against a wounded enemy', () => {
    const { ctx, state } = setup({ script: [2, 2, 2, 2, 5, 5, 5, 5, 5] });
    const shooter = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    foe.wounds = 4; // wounded
    state.teams.p1.cp = 1; // spending it on the ploy leaves no Command Re-roll to offer first
    state.teams.p2.cp = 0;
    let s = activate(ctx, state, shooter.id);
    s.teams.p1.cp = 1;
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, foe.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.preyOnTheWounded }, ctx).state;
    advanceShoot(ctx, s);
    const decision = s.pending.find((d) => d.kind === 'reroll');
    expect(decision?.prompt).toContain('PREY ON THE WOUNDED');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('CHAIN SNARE: "that enemy operative cannot perform that action during that activation"', () => {
    const { ctx, state } = setup({ equipment: [EQ.chainSnare], script: [5, 5] });
    const holder = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [holder.id, foe.id]);
    place(state, holder.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const s = activate(ctx, state, foe.id, 'engage');
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[foe.id]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    expect(s.log.some((l) => l.text.includes('CHAIN SNARE'))).toBe(true);
  });

  it('and rolls one D6 instead of two when the enemy has a higher Wounds stat', () => {
    const { ctx, state } = setup({ equipment: [EQ.chainSnare], foeIsAstartes: true, script: [1] });
    const holder = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = aliveOperatives(state, 'p2')[0]!;
    isolate(state, [holder.id, foe.id]);
    place(state, holder.id, 10, 10);
    place(state, foe.id, 10.9, 10);
    const s = activate(ctx, state, foe.id, 'engage');
    const roll = s.rolls.find((r) => r.kind === 'chainSnare');
    expect(roll?.results).toHaveLength(1);
  });

  it('TOXIN COATING: "that operative’s melee weapon has the Lethal 5+ weapon rule", twice per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.toxinCoating] });
    const mine = state.operatives[opWith(state, 'p1', C.flayer)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const s = activate(ctx, state, mine.id);
    startFight(ctx, s, s.operatives[mine.id]!, 'Pain sculptors', undefined, foe.id);
    const rules = effectiveRules(ctx, s, profileOf(C.flayer, 'Pain sculptors'), {
      operative: s.operatives[mine.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Pain sculptors',
    });
    expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
    const used = s.log.filter((l) => l.text.includes('TOXIN COATING'));
    expect(used).toHaveLength(1);
  });

  it('WICKED BLADES: "Add 1 to the Atk stat of friendly HAND OF THE ARCHON operatives’ array of blades"', () => {
    const { ctx, state } = setup({ equipment: [EQ.wickedBlades] });
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    const profile = profileOf(C.agent, 'Array of blades');
    const collect = (weaponName: string): number =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: {
          attacker: op,
          weaponName,
          profile,
          rules: profile.rules,
          type: 'melee',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 0,
        },
        count: profile.atk,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      }).mods.atk;
    expect(collect('Array of blades')).toBe(1);
    expect(collect('Splinter rifle')).toBe(0);
  });

  it('REFINED POISON: "add 1 to the Normal Dmg stat of that weapon", twice per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.refinedPoison], script: [4, 4, 4, 4, 1, 1, 1] });
    const shooter = state.operatives[opWith(state, 'p1', C.agent)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 8, 10);
    place(state, foe.id, 14, 10);
    const s = activate(ctx, state, shooter.id);
    const before = s.operatives[foe.id]!.wounds;
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Splinter rifle', undefined, foe.id);
    advanceShoot(ctx, s);
    let guard = 0;
    let cur = s;
    while (cur.pending.length > 0 && guard++ < 20) {
      const d = cur.pending[0]!;
      const keep = d.options.find((o) => o.id === 'keep') ?? d.options.find((o) => o.id === 'auto') ?? d.options[0]!;
      cur = reduce(cur, { t: 'ResolveDecision', decisionId: d.id, optionId: keep.id, ...(keep.data ? { data: keep.data } : {}) }, ctx).state;
    }
    // 4 dice of 4 vs Hit 3+ = 4 normal successes at Dmg 2, +1 each from REFINED POISON.
    const damage = before - cur.operatives[foe.id]!.wounds;
    expect(damage).toBeGreaterThan(0);
    expect(cur.log.some((l) => l.text.includes('REFINED POISON'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('contract and coverage', () => {
  it('Insensible to Pain reduces a SHOT per attack dice, not once for the aggregated total', () => {
    // Blast pistol, Normal Dmg 3, Piercing 2: four dice of 4 are four normal successes and the
    // one remaining defence dice fails, so the raw total is 4 × 3 = 12. "Normal … Dmg of 3 or
    // more inflicts 1 less damage" applies to EACH of the four, for 8.
    const { ctx, state } = setup({ script: [4, 4, 4, 4, 1] });
    const shooter = state.operatives[opWith(state, 'p2', C.archsybarite)]!;
    const flayer = state.operatives[opWith(state, 'p1', C.flayer)]!;
    isolate(state, [shooter.id, flayer.id]);
    place(state, shooter.id, 20, 10);
    place(state, flayer.id, 14, 10);
    state.teams.p1.cp = 0;
    state.teams.p2.cp = 0;
    const before = flayer.wounds;
    let s: GameState = { ...state, activePlayer: 'p2' };
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Blast pistol', undefined, flayer.id);
    advanceShoot(ctx, s);
    s = settle(ctx, s);
    expect(before - s.operatives[flayer.id]!.wounds).toBe(8);
  });

  it('Torturous Vision also fires when the ARCHSYBARITE fights', () => {
    const { ctx, state } = setup();
    const arch = state.operatives[opWith(state, 'p1', C.archsybarite)]!;
    const foe = state.operatives[opWith(state, 'p2', C.agent)]!;
    isolate(state, [arch.id, foe.id]);
    place(state, arch.id, 10, 10);
    place(state, foe.id, 10.7, 10);
    const s = activate(ctx, state, arch.id);
    startFight(ctx, s, s.operatives[arch.id]!, 'Venom blade', undefined, foe.id);
    advanceFight(ctx, s);
    expect(painOf(s, s.operatives[arch.id]!)).toBe(1);
  });

  it('the Vitalised Surge Dash ignores "an action that prevents it from performing the Dash action"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.agent)]!;
    isolate(state, [op.id]);
    place(state, op.id, 10, 10);
    const s = activate(ctx, state, op.id);
    const live = s.operatives[op.id]!;
    live.actionsThisActivation.push('Charge'); // the universal Dash refuses after a Charge
    const path = { points: [{ x: 11, y: 10 }] };
    expect(getAction('Dash')!.check(ctx, s, live, { path }).ok).toBe(false);
    s.effects.push({
      id: 'surge-test',
      rule: 'teamFreeAction',
      source: { kind: 'ability', id: RULE.invigorations },
      operativeId: live.id,
      player: 'p1',
      data: { threshold: 2, only: ['Dash', SURGE_DASH] },
      expiry: { kind: 'endOfActivation', operativeId: live.id },
    });
    expect(getAction(SURGE_DASH)!.check(ctx, s, live, { path }).ok).toBe(true);
  });

  it('every unique action honours D-026: whatever `check` accepts, `perform` completes', () => {
    const { ctx, state } = setup();
    const ids = [ACT.tormentGrenade, ACT.administerDrug, ACT.mark];
    let tried = 0;
    for (const actionId of ids) {
      const def = getAction(actionId)!;
      for (const op of aliveOperatives(state, 'p1')) {
        if (def.available && !def.available(ctx, state, op)) continue;
        const candidates: Record<string, unknown>[] = [{}];
        for (const other of aliveOperatives(state)) {
          if (other.id === op.id) continue;
          candidates.push({ targetOperativeId: other.id, targetId: other.id });
        }
        for (const params of candidates) {
          const s = activate(ctx, state, op.id);
          const live = s.operatives[op.id]!;
          if (!def.check(ctx, s, live, params).ok) continue;
          tried++;
          const out = reduce(s, { t: 'PerformAction', operativeId: op.id, action: actionId, params }, ctx);
          expect(out.state.rejected).toHaveLength(0);
          expect(out.ok).toBe(true);
        }
      }
    }
    expect(tried).toBeGreaterThan(0);
  });
});
