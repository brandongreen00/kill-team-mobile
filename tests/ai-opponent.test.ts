/**
 * The AI opponent, driven through the app's own `Store`.
 *
 * `tests/soak` already pins that the AI plays a legal game through `playGame`. That is not the
 * same claim: `playGame` scripts setup by hand, owns the flow intents itself, and never shares
 * a battle with anyone. These tests pin the channel a person actually plays through.
 *
 * The bar is the AI package's own (docs/AI.md §1): **zero rejected intents**. A rejection is
 * not a rules result here, it is a defect — so every assertion below reads `state.rejected`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deployToAct } from '../src/core/phases.ts';
import { canDeployAt } from '../src/core/reducer.ts';
import type { Intent } from '../src/core/intents.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';
import { createBattle } from '../src/core/init.ts';
import { SeededRng } from '../src/core/rng.ts';
import { equipmentItems } from '../src/core/equipment/index.ts';
import { loadoutOf } from '../src/teams/selection.ts';
import { deployPositions } from '../src/ai/deploy.ts';
import { AiDriver, aiTurn } from '../src/ui/ai/driver.ts';
import { aiTeamIdFor } from '../src/ui/ai/setup.ts';
import { aiEquipmentIds, aiSelectRoster, defaultRosterOf, playableTeams } from '../src/ui/ai/roster.ts';
import { PASS_AND_PLAY, type OpponentConfig } from '../src/ui/ai/opponent.ts';
import { appBattle } from './ai-app-fixture.ts';

const WATCH: OpponentConfig = { p1: 'ai', p2: 'ai', difficulty: 'veteran' };
const SOLO: OpponentConfig = { p1: 'human', p2: 'ai', difficulty: 'veteran' };

interface RunResult {
  store: ReturnType<typeof appBattle>['store'];
  driver: AiDriver;
  steps: number;
}

/** Play a whole battle with both seats driven, failing loudly on the first thing the AI cannot do. */
function playOut(opts: { seed?: number; mapId?: string; maxSteps?: number } = {}): RunResult {
  const { store, teams } = appBattle(opts);
  const driver = new AiDriver({ store, teams, opponent: WATCH });
  driver.newBattle();
  const max = opts.maxSteps ?? 6000;
  let steps = 0;
  while (store.state.phase !== 'battleEnd' && steps < max) {
    const result = driver.step();
    if (result.error) throw new Error(`${result.error} (after ${steps} steps, in ${store.state.phase})`);
    if (!result.acted) throw new Error(`the driver had nothing to do in ${store.state.phase} after ${steps} steps`);
    steps++;
  }
  return { store, driver, steps };
}

describe('the AI opponent plays a whole battle through the Store', () => {
  // One battle, every claim about it: full games on a real killzone with real kill teams are
  // the expensive part of this file, so they are not paid for three times. In `beforeAll`
  // rather than the describe body so that a failure is reported as a hook failure against this
  // suite, and so it is covered by `testTimeout`.
  let played: RunResult;
  beforeAll(() => {
    played = playOut({ seed: 7 });
  });

  it('reaches battleEnd with no rejected intents', () => {
    expect(played.store.state.phase).toBe('battleEnd');
    expect(played.store.state.rejected).toEqual([]);
    expect(played.store.state.turningPoint).toBe(played.store.state.maxTurningPoints);
    expect(played.steps).toBeGreaterThan(50);
  });

  it('sets up both kill teams, both drop zones and — the one that scores — both tac ops', () => {
    const { state } = played.store;
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      expect(state.teams[p].teamId).not.toBe('');
      expect(state.teams[p].operativeIds.length).toBeGreaterThan(0);
      expect(state.setup.dropZone[p]).toBeTruthy();
      // `SelectTacOp` is the only caller of `ctx.initOps`, and only once BOTH teams have one.
      expect(state.teams[p].tacOpId).toBeTruthy();
    }
    expect(state.initiative).toBeTruthy();
  });

  it('scores the battle rather than playing four empty turning points', () => {
    const { state } = played.store;
    expect(state.teams.p1.vp + state.teams.p2.vp).toBeGreaterThan(0);
    expect(state.winner).toBeTruthy();
  });
});

describe('the driver does nothing on a seat a person is holding', () => {
  it('returns no turn at all for pass-and-play', () => {
    const { store, teams } = appBattle({ seed: 3 });
    const driver = new AiDriver({ store, teams, opponent: PASS_AND_PLAY });
    expect(driver.turn()).toBeNull();
    expect(driver.step()).toEqual({ acted: false });
  });

  it('leaves the roll-off, the reveal and the turning-point beats to the player in a solo game', () => {
    const { store, teams } = appBattle({ seed: 3 });
    const driver = new AiDriver({ store, teams, opponent: SOLO });
    // Setup step one is the roll-off: nobody owns it, so in a solo game it stays a button.
    expect(store.state.setup.step).toBe('rollOff');
    expect(driver.turn()).toBeNull();
  });
});

describe('deployment', () => {
  it('never proposes a placement canDeployAt would refuse, and honours alternating thirds', () => {
    const { store, teams } = appBattle({ seed: 21 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();

    const placements: { player: PlayerId; expected: PlayerId | null; legal: boolean }[] = [];
    const dispatched: Intent[] = [];
    const original = store.dispatch.bind(store);
    (store as unknown as { dispatch: (i: Intent) => boolean }).dispatch = (intent: Intent): boolean => {
      if (intent.t === 'DeployOperative') {
        const before: GameState = store.state;
        const op = before.operatives[intent.operativeId]!;
        placements.push({
          player: intent.player,
          expected: deployToAct(before),
          legal: canDeployAt(store.ctx, before, op, intent.pos, intent.rotDeg ?? 0, intent.z).ok,
        });
      }
      dispatched.push(intent);
      return original(intent);
    };

    let steps = 0;
    while (store.state.phase === 'setup' && steps++ < 500) {
      const r = driver.step();
      if (r.error) throw new Error(r.error);
    }

    expect(placements.length).toBeGreaterThan(4);
    expect(placements.filter((p) => !p.legal)).toEqual([]);
    expect(placements.filter((p) => p.player !== p.expected)).toEqual([]);

    // Agreeing with `deployToAct` is circular — it is the selector the driver asked. So check
    // the printed rule directly: the run lengths in the dispatched order are one third of the
    // kill team, rounding up, until that player runs out. The runner's one-at-a-time
    // alternation (`runner.ts`) would produce runs of exactly 1 and fail this.
    const runs: { player: PlayerId; n: number }[] = [];
    for (const p of placements) {
      const last = runs[runs.length - 1];
      if (last && last.player === p.player) last.n += 1;
      else runs.push({ player: p.player, n: 1 });
    }
    const size = (p: PlayerId) => store.state.teams[p].operativeIds.length;
    const third = (p: PlayerId) => Math.max(1, Math.ceil(size(p) / 3));
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs.slice(0, -2)) expect(run.n, `${run.player} placed ${run.n} in one turn`).toBe(third(run.player));
    // The reveal is a real step, not something the runner's short-cut skips.
    expect(dispatched.some((i) => i.t === 'BeginDeployment')).toBe(true);
    expect(store.state.setup.revealed.p1).toBe(true);
  });
});

describe('the AI\'s kill team, equipment and tac op', () => {
  it('fields a legal kill team for every one of the bundled teams, with its loadout recorded', () => {
    const { store, teams } = appBattle({ seed: 4 });
    const playable = playableTeams(teams);
    // Not a hard-coded 48: the claim is that EVERY bundled team can be fielded, so adding one
    // must extend this test rather than break it.
    expect(playable.map((t) => t.id)).toEqual(teams.map((t) => t.id));
    expect(playable.length).toBeGreaterThanOrEqual(48);

    for (const team of playable) {
      // A fresh battle per team: `SelectRoster` letters operatives from zero and a second call
      // for the same player leaves the first team's records behind.
      const fresh = appBattle({ seed: 4 });
      expect(aiSelectRoster(fresh.store, fresh.teams, 'p1', team.id), `${team.id} could not be fielded`).toBe(true);
      const ids = fresh.store.state.teams.p1.operativeIds;
      expect(ids.length, `${team.id} fielded nobody`).toBeGreaterThan(0);
      expect(fresh.store.state.rejected).toEqual([]);
      // The invisible half: without `applyLoadouts`, `weaponsOf` falls back to the whole
      // datacard and every operative carries every weapon printed on its card at once — no
      // rejection, nothing in the log. An operative that resolves to no weapons at all (the
      // Inquisitorial Agent's tome skull) legitimately has nothing to record.
      const resolved = defaultRosterOf(team)!.weapons;
      ids.forEach((id, i) => {
        if ((resolved[i] ?? []).length === 0) return;
        expect(loadoutOf(fresh.store.state, id), `${team.id}/${id} has no loadout`).toEqual(resolved[i]);
      });
    }
    expect(store.state.rejected).toEqual([]);
  });

  it('only ever selects universal equipment that needs no setting up', () => {
    const { store } = appBattle({ seed: 9 });
    for (let seed = 0; seed < 12; seed++) {
      const ids = aiEquipmentIds(store.ctx, seed);
      expect(ids.length).toBeLessThanOrEqual(4);
      for (const id of ids) {
        // Faction equipment is not in `ctx.equipment` at all, so it would be rejected as
        // `unknown equipment`; anything with `items` has to be placed on the killzone.
        expect(store.ctx.equipment.has(id), `${id} is not a registered equipment option`).toBe(true);
        expect(equipmentItems(id), `${id} has to be set up on the killzone`).toEqual([]);
      }
    }
  });

});

describe('the driver is deterministic and does not leak between battles', () => {
  /** Play a bounded prefix of a battle, so a determinism check does not cost two full games. */
  const prefix = (seed: number, steps: number): { history: string; rolls: number } => {
    const { store, teams } = appBattle({ seed });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    for (let i = 0; i < steps && store.state.phase !== 'battleEnd'; i++) {
      const r = driver.step();
      if (r.error) throw new Error(r.error);
      if (!r.acted) break;
    }
    return { history: JSON.stringify(store.history), rolls: store.state.rolls.length };
  };

  it('replays byte-identically from the same seed, and differently from another', () => {
    // A battle is `(rosters, map, seed, intents[])`. `App` built its RNG once at boot and no
    // reset ever replaced it, so a second battle continued the first one's dice; the driver's
    // `newBattle()` and the app's single new-battle path are what make this true.
    const a = prefix(55, 90);
    const b = prefix(55, 90);
    expect(b.history).toBe(a.history);
    expect(b.rolls).toBe(a.rolls);
    expect(prefix(56, 90).history).not.toBe(a.history);
  });

  it('plays a second battle in the same process, to the end, on the same driver', () => {
    // `playGame` calls `resetAiCaches()` per game; nothing in the app did, and the AI's
    // module-level caches are keyed on ids that repeat across battles (map id, datacard id,
    // position). `tests/soak/soak.test.ts` pins the same regression for the runner.
    const { store, teams } = appBattle({ seed: 61 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    const run = (): number => {
      driver.newBattle();
      let steps = 0;
      while (store.state.phase !== 'battleEnd' && steps < 6000) {
        const r = driver.step();
        if (r.error) throw new Error(r.error);
        if (!r.acted) break;
        steps++;
      }
      return steps;
    };
    const first = run();
    expect(store.state.phase).toBe('battleEnd');

    store.ctx.rng = new SeededRng(62);
    store.reset(createBattle(store.ctx, { map: store.state.map, seed: 62, mode: 'match', critOpId: 'crit.secure' }));
    const second = run();
    expect(store.state.phase).toBe('battleEnd');
    expect(store.state.rejected).toEqual([]);
    expect(second).toBeGreaterThan(first * 0.25);
    expect(second).toBeLessThan(first * 4);
  });
});

describe('the driver never plays the other side', () => {
  it('leaves an activation the player owns alone, even when it is nominally the AI\'s turn', () => {
    // `PerformAction` and `EndActivation` carry no player field — the reducer authorises them
    // on `activeOperativeId` alone — so a driver keyed on "whose turn is it" rather than on who
    // owns the active operative would happily play the person's activation for them.
    const { store, teams } = appBattle({ seed: 77 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    for (let i = 0; i < 4000 && store.state.phase !== 'firefight'; i++) if (!driver.step().acted) break;
    for (let i = 0; i < 400 && !store.state.activeOperativeId; i++) if (!driver.step().acted) break;

    const activeId = store.state.activeOperativeId;
    expect(activeId).toBeTruthy();
    const owner = store.state.operatives[activeId!]!.player;
    // Hand that seat back to a person mid-activation: the driver must stand down at once.
    const solo: OpponentConfig = { p1: owner === 'p1' ? 'human' : 'ai', p2: owner === 'p2' ? 'human' : 'ai', difficulty: 'veteran' };
    expect(aiTurn(store.ctx, store.state, solo)).toBeNull();
    driver.configure(solo);
    expect(driver.step()).toEqual({ acted: false });
    expect(store.state.activeOperativeId).toBe(activeId);
  });

  it('answers only the reactive window the screen is showing', () => {
    const { store, teams } = appBattle({ seed: 88 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    for (let i = 0; i < 4000 && store.state.pending.length === 0; i++) if (!driver.step().acted) break;
    const decision = store.state.pending[0];
    expect(decision).toBeTruthy();
    // The same decision, with the seat it belongs to held by a person: not the AI's to answer.
    const theirs: OpponentConfig = {
      p1: decision!.who === 'p1' ? 'human' : 'ai',
      p2: decision!.who === 'p2' ? 'human' : 'ai',
      difficulty: 'veteran',
    };
    expect(aiTurn(store.ctx, store.state, theirs)).toBeNull();
    // …and the other way round.
    const mine: OpponentConfig = { ...theirs, [decision!.who]: 'ai' } as OpponentConfig;
    expect(aiTurn(store.ctx, store.state, mine)?.player).toBe(decision!.who);
  });
});

describe('the two branches a battle rarely reaches', () => {
  /** Drive a watched battle to the first activation, then hand the state back for surgery. */
  const inFirefight = () => {
    const { store, teams } = appBattle({ seed: 13 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    for (let i = 0; i < 4000 && !store.state.activeOperativeId; i++) if (!driver.step().acted) break;
    expect(store.state.activeOperativeId).toBeTruthy();
    return { store, teams, driver };
  };

  it('ends the activation of an operative that was killed holding it — whoever owns it', () => {
    // `removeIncapacitated` leaves `activeOperativeId` pointing at the corpse and nothing ever
    // ends that activation, so it is never expended, the activation clock never ticks it and
    // `onActivationEnd` never fires. Two people walk past it; a solo battle dead-ends on it.
    const { store, teams, driver } = inFirefight();
    const active = store.state.operatives[store.state.activeOperativeId!]!;
    active.removed = true;

    // Owned by the AI…
    expect(aiTurn(store.ctx, store.state, WATCH)).toMatchObject({ kind: 'cleanup', player: active.player });
    // …and owned by the person, which is the case that matters: nobody else will do it.
    const theirs: OpponentConfig = {
      p1: active.player === 'p1' ? 'human' : 'ai',
      p2: active.player === 'p2' ? 'human' : 'ai',
      difficulty: 'veteran',
    };
    expect(aiTurn(store.ctx, store.state, theirs)).toMatchObject({ kind: 'cleanup', player: active.player });

    driver.configure(theirs);
    expect(driver.step()).toEqual({ acted: true });
    expect(store.state.activeOperativeId).toBeUndefined();
    expect(store.state.operatives[active.id]!.expended).toBe(true);
    expect(store.state.rejected).toEqual([]);
  });

  it('answers an On Guard offer addressed to the AI, and leaves the player’s alone', () => {
    // On Guard is not a `PendingDecision`: the reducer writes `opState.guardOffer` and does not
    // block on it, so nothing but this branch enforces the window. Raised only on a Close
    // Quarters killzone, which is why the soak covers it and a battle on the app's default
    // killzone never would.
    const { store } = inFirefight();
    const active = store.state.operatives[store.state.activeOperativeId!]!;
    const defender = active.player === 'p1' ? 'p2' : 'p1';
    const guards = store.state.teams[defender].operativeIds.slice(0, 1);
    store.state.opState['guardOffer'] = { player: defender, operativeIds: guards };

    const mine: OpponentConfig = { p1: defender === 'p1' ? 'ai' : 'human', p2: defender === 'p2' ? 'ai' : 'human', difficulty: 'veteran' };
    expect(aiTurn(store.ctx, store.state, mine)).toMatchObject({ kind: 'interrupt', player: defender });

    const theirs: OpponentConfig = { p1: defender === 'p1' ? 'human' : 'ai', p2: defender === 'p2' ? 'human' : 'ai', difficulty: 'veteran' };
    expect(aiTurn(store.ctx, store.state, theirs)).toBeNull();
  });

  it('falls back to a kill team from the seed when the stored one is no longer in the data', () => {
    // The choice is persisted, so it outlives the data it names.
    const { store, teams } = appBattle({ seed: 19 });
    const gone: OpponentConfig = { p1: 'ai', p2: 'ai', difficulty: 'veteran', teamId: 'a-team-that-was-deleted' };
    expect(aiTeamIdFor(store.state, teams, gone, 'p2')).toBeTruthy();
    expect(aiTeamIdFor(store.state, teams, gone, 'p2')).not.toBe('a-team-that-was-deleted');

    const kept: OpponentConfig = { ...gone, teamId: playableTeams(teams)[3]!.id };
    expect(aiTeamIdFor(store.state, teams, kept, 'p2')).toBe(kept.teamId);
    // …and the seat it does NOT name still comes from the seed, so a watched battle is not a
    // mirror match.
    expect(aiTeamIdFor(store.state, teams, kept, 'p1')).not.toBe(kept.teamId);
  });
});

describe('an opponent that has moved commits the player’s turn', () => {
  it('leaves nothing on the undo stack for a player to rewind the AI\'s deployment with', () => {
    // The player's own placements DO push a snapshot, and that snapshot predates the AI's whole
    // batch: undoing across it would rewind the AI's operatives off the board, rewind
    // `setup.deployedCount` with them, and truncate `history` so the battle no longer replays.
    const { store, teams } = appBattle({ seed: 23 });
    const solo: OpponentConfig = { p1: 'human', p2: 'ai', difficulty: 'veteran' };
    const driver = new AiDriver({ store, teams, opponent: solo });
    driver.newBattle();

    // Get to deployment with the person's side rostered the short way.
    store.dispatch({ t: 'RollOff', kind: 'initiative' });
    const chooser = store.state.setup.toAct ?? 'p1';
    store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: chooser });
    store.dispatch({ t: 'ChooseDropZone', player: store.state.initiative!, zone: store.state.initiative! });
    aiSelectRoster(store, teams, 'p1', playableTeams(teams)[0]!.id);
    store.dispatch({ t: 'SelectTacOp', player: 'p1', tacOpId: 'tac.dominate' });
    for (let i = 0; i < 200 && driver.turn(); i++) if (!driver.step().acted) break;
    // The reveal belongs to nobody, so in a solo battle it waits for the person (D-109).
    expect(store.state.teams.p2.tacOpId).toBeTruthy();
    store.dispatch({ t: 'BeginDeployment' });
    for (let i = 0; i < 200 && store.state.setup.step !== 'deploy'; i++) if (!driver.step().acted) break;
    expect(store.state.setup.step).toBe('deploy');

    // Place one of the player's, by hand, the way the deployment screen does.
    let undid = 0;
    for (let i = 0; i < 200 && store.state.phase === 'setup'; i++) {
      if (driver.turn()) {
        // The AI has just moved: whatever the person had banked is now committed.
        if (!driver.step().acted) break;
        expect(store.canUndo(), 'the AI moved, so nothing of the player\'s is still undoable').toBe(false);
        continue;
      }
      const who = deployToAct(store.state);
      if (!who) break;
      const op = store.state.teams[who].operativeIds.map((id) => store.state.operatives[id]!).find((o) => o.pos.x < -50);
      if (!op) break;
      const pos = deployPositions(store.ctx, store.state, op, 8).find((p) => canDeployAt(store.ctx, store.state, op, p, op.rot).ok);
      if (!pos) break;
      store.dispatch({ t: 'DeployOperative', player: who, operativeId: op.id, pos });
      // Within their own batch the player can still take a placement back.
      if (store.canUndo()) undid = 1;
    }
    expect(undid, 'the player should still be able to undo inside their own batch').toBe(1);
    expect(store.state.rejected).toEqual([]);
  });
});
