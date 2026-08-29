/**
 * @vitest-environment jsdom
 *
 * What the shell shows once a seat is not a person.
 *
 * `commandPlan` derives exactly one screen from GameState, and every one of those screens was
 * written on the assumption that whoever is to act is holding the phone. Two things therefore
 * have to be true for a solo battle, and neither is visible from the rules core: the app must
 * never ask one person to hand the device to themselves, and it must never offer the player
 * the opponent's own controls — an armed board with the AI's operatives on it is a board the
 * player can use to play the AI's turn for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { commandPlan, handoverGate, type CommandArgs } from '../src/ui/command/index.tsx';
import { AiDriver } from '../src/ui/ai/driver.ts';
import { aiSelectRoster, playableTeams } from '../src/ui/ai/roster.ts';
import {
  OPPONENT_KEY,
  PASS_AND_PLAY,
  needsHandover,
  readOpponent,
  writeOpponent,
  type OpponentConfig,
} from '../src/ui/ai/opponent.ts';
import { emptyUi, type UiState } from '../src/ui/command/types.ts';
import type { PlayerId } from '../src/core/types.ts';
import { appBattle } from './ai-app-fixture.ts';

const SOLO: OpponentConfig = { p1: 'human', p2: 'ai', difficulty: 'veteran' };
const WATCH: OpponentConfig = { p1: 'ai', p2: 'ai', difficulty: 'veteran' };

/** A `CommandArgs` over a real battle, with the UI state the caller wants to test. */
function args(over: { opponent?: OpponentConfig; ui?: Partial<UiState>; seed?: number } = {}): CommandArgs {
  const { store, teams } = appBattle({ seed: over.seed ?? 5 });
  return {
    store,
    teams,
    ui: { ...emptyUi, ...over.ui },
    setUi: () => {},
    opponent: over.opponent ?? PASS_AND_PLAY,
    setOpponent: () => {},
  };
}

beforeEach(() => localStorage.removeItem(OPPONENT_KEY));

describe('the opponent picker', () => {
  it('is the first screen, and names itself on the topbar', () => {
    const plan = commandPlan(args());
    expect(plan.id).toBe('setup.opponent');
    // A route overlay would leave `data-screen` naming the screen underneath it, which is what
    // the e2e suite and `pnpm ui:review` are keyed on.
    expect(plan.detent).toBe('half');
  });

  it('offers its options inside an `.actions` container, where the harnesses look', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(commandPlan(args({ opponent: SOLO })).body, host);
    const rows = host.querySelectorAll('.actions button');
    expect(rows.length).toBeGreaterThanOrEqual(4 + 3); // four ways to play, three difficulties
    expect([...rows].some((b) => /Play the AI/.test(b.textContent ?? ''))).toBe(true);
    expect([...rows].some((b) => /Watch the AI/.test(b.textContent ?? ''))).toBe(true);
    // The AI's kill team is offered too, and "chosen for you" is one of the choices.
    expect(host.querySelector('.team-list')).not.toBeNull();
    expect(host.textContent).toContain('Surprise me');
    render(null, host);
    host.remove();
  });

  it('steps aside once it has been answered', () => {
    expect(commandPlan(args({ ui: { opponentChosen: true } })).id).toBe('setup.rollOff');
  });

  it('does not offer a kill team or a difficulty for a battle with no AI in it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(commandPlan(args({ opponent: PASS_AND_PLAY })).body, host);
    expect(host.querySelector('.team-list')).toBeNull();
    expect(host.textContent).not.toContain('Veteran');
    render(null, host);
    host.remove();
  });
});

describe('the hand-over', () => {
  it('is for two people, and stands down for every other seating', () => {
    expect(needsHandover(PASS_AND_PLAY)).toBe(true);
    expect(needsHandover(SOLO)).toBe(false);
    expect(needsHandover(WATCH)).toBe(false);

    const two = args({ opponent: PASS_AND_PLAY, ui: { opponentChosen: true } });
    // p2 is not the device holder during setup, so a two-person battle asks for the phone…
    expect(handoverGate(two, 'p2', 'step', 'help')?.id).toBe('handover');
    // …and a solo battle does not, without touching `mode`, which is a rules field.
    const solo = { ...two, opponent: SOLO };
    expect(handoverGate(solo, 'p2', 'step', 'help')).toBeNull();
    expect(handoverGate(solo, 'p1', 'step', 'help')).toBeNull();
    expect(two.store.state.mode).toBe('match');
  });

  it('never appears at the loadout screen either, which has its own inline gate', () => {
    // `loadoutPlan`'s hand-over is written inline in `setup.tsx` and does not go through
    // `handoverGate`, so it needs its own test — and it is reached only once BOTH kill teams
    // are in, which is past where the setup drive below stops.
    const { store, teams } = appBattle({ seed: 5 });
    const driver = new AiDriver({ store, teams, opponent: SOLO });
    driver.newBattle();
    store.dispatch({ t: 'RollOff', kind: 'initiative' });
    const chooser = store.state.setup.toAct ?? 'p1';
    store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: chooser });
    store.dispatch({ t: 'ChooseDropZone', player: store.state.initiative!, zone: store.state.initiative! });
    aiSelectRoster(store, teams, 'p1', playableTeams(teams)[0]!.id);
    // Let the AI take every setup step that is its own, and stop where it hands back.
    for (let i = 0; i < 200 && driver.turn(); i++) if (!driver.step().acted) break;
    expect(store.state.teams.p1.operativeIds.length).toBeGreaterThan(0);
    expect(store.state.teams.p2.operativeIds.length, 'the AI should have chosen its kill team').toBeGreaterThan(0);
    // Equipment and the tac op are taken in player order, so the person is asked first.
    expect(store.state.teams.p1.tacOpId).toBeFalsy();

    const plan = commandPlan({ store, teams, ui: { opponentChosen: true }, setUi: () => {}, opponent: SOLO, setOpponent: () => {} });
    // Straight to the person's own loadout screen, with no "I am Player 1" in front of it.
    expect(plan.id).toBe('setup.loadout');
    expect(plan.turnOf).toBe('p1');

    // …and with two people it does ask.
    const two = commandPlan({ store, teams, ui: { opponentChosen: true }, setUi: () => {}, opponent: PASS_AND_PLAY, setOpponent: () => {} });
    expect(two.id).toBe('setup.loadoutHandover');
  });

  it('never appears in a solo battle, at either of the two screens that ask for it', () => {
    // `setup.handover` and `setup.loadoutHandover` are written inline in `setup.tsx` and do not
    // go through `handoverGate` at all, so they need the same test made separately.
    const seen = new Set<string>();
    const { store, teams } = appBattle({ seed: 5 });
    const driver = new AiDriver({ store, teams, opponent: SOLO });
    driver.newBattle();
    const plan = () =>
      commandPlan({ store, teams, ui: { opponentChosen: true }, setUi: () => {}, opponent: SOLO, setOpponent: () => {} });

    // Drive the person's side the way the screens ask, letting the driver take the AI's.
    for (let i = 0; i < 400 && store.state.phase === 'setup'; i++) {
      const p = plan();
      seen.add(p.id);
      if (driver.turn()) {
        if (!driver.step().acted) break;
        continue;
      }
      // The human's own steps, taken directly — this test is about which SCREEN appears.
      const state = store.state;
      if (state.setup.step === 'rollOff') store.dispatch({ t: 'RollOff', kind: 'initiative' });
      else if (state.setup.step === 'chooseDropZone' && state.initiative === undefined)
        store.dispatch({ t: 'ChooseInitiative', player: state.setup.toAct ?? 'p1', choice: state.setup.toAct ?? 'p1' });
      else if (state.setup.step === 'chooseDropZone')
        store.dispatch({ t: 'ChooseDropZone', player: state.initiative!, zone: state.initiative! });
      else break; // the human's kill team needs the roster builder; the screens above are the point
    }
    expect([...seen].filter((id) => /handover/i.test(id))).toEqual([]);
    expect(seen.has('setup.opponent')).toBe(false); // already answered
  });
});

describe('the opponent’s turn', () => {
  it('replaces the AI’s own screens with one that has nothing to tap', () => {
    const { store, teams } = appBattle({ seed: 5 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    const base = { store, teams, ui: { opponentChosen: true }, setUi: () => {}, setOpponent: () => {} };

    // Deployment is the clearest case: the human screen for it arms the board.
    for (let i = 0; i < 400 && store.state.setup.step !== 'deploy'; i++) if (!driver.step().acted) break;
    expect(store.state.setup.step).toBe('deploy');

    const watched = commandPlan({ ...base, opponent: WATCH });
    expect(watched.id).toBe('ai.acting');
    expect(watched.actions).toEqual([]);
    expect(watched.armed ?? null).toBeNull();
    expect(watched.title).toMatch(/is deploying/);

    // The same state with that seat held by a person is the ordinary deployment screen, armed.
    const deployer = store.state.initiative as PlayerId;
    const solo: OpponentConfig = { p1: deployer === 'p1' ? 'human' : 'ai', p2: deployer === 'p2' ? 'human' : 'ai', difficulty: 'veteran' };
    const mine = commandPlan({ ...base, opponent: solo });
    expect(mine.id).toBe('setup.deploy');
    expect(mine.armed).toBeTruthy();
  });

  it('shows the player their own reactive window even while the AI holds the activation', () => {
    const { store, teams } = appBattle({ seed: 88 });
    const driver = new AiDriver({ store, teams, opponent: WATCH });
    driver.newBattle();
    for (let i = 0; i < 4000 && store.state.pending.length === 0; i++) if (!driver.step().acted) break;
    const decision = store.state.pending[0]!;
    expect(decision).toBeTruthy();

    const theirs: OpponentConfig = {
      p1: decision.who === 'p1' ? 'human' : 'ai',
      p2: decision.who === 'p2' ? 'human' : 'ai',
      difficulty: 'veteran',
    };
    const plan = commandPlan({
      store,
      teams,
      ui: { opponentChosen: true, handedOverTo: decision.who },
      setUi: () => {},
      opponent: theirs,
      setOpponent: () => {},
    });
    expect(plan.id).toMatch(/^decision\./);
    expect(plan.turnOf).toBe(decision.who);
  });

  it('says so, and offers the seat, when the AI stops', () => {
    const plan = commandPlan({ ...args({ opponent: SOLO, ui: { opponentChosen: true } }), aiError: 'it exploded' });
    expect(plan.id).toBe('ai.error');
    expect(plan.help).toBe('it exploded');
    expect(plan.actions[0]?.id).toBe('take-over');
  });
});

describe('the opponent choice outlives the battle it was made for', () => {
  it('round-trips through storage and survives a killzone change', () => {
    // It is deliberately NOT in `UiState`: `pickMap` resets that wholesale, which would hand
    // the AI's seat back to a second person who is not in the room.
    writeOpponent({ p1: 'ai', p2: 'human', difficulty: 'elite', teamId: 'kasrkin' });
    expect(readOpponent()).toEqual({ p1: 'ai', p2: 'human', difficulty: 'elite', teamId: 'kasrkin' });
  });

  it('falls back to pass-and-play for anything it cannot read', () => {
    localStorage.setItem(OPPONENT_KEY, '{"p1":"robot","difficulty":"impossible"}');
    expect(readOpponent()).toEqual(PASS_AND_PLAY);
    localStorage.setItem(OPPONENT_KEY, 'not json at all');
    expect(readOpponent()).toEqual(PASS_AND_PLAY);
  });
});

describe('the picker holds the battle until it is answered', () => {
  it('shows itself, not the opponent’s turn, even when both seats are already AI', () => {
    // Choosing "Watch the AI play itself" makes it the AI's move immediately. The picker has to
    // outrank that, or the battle starts underneath it — and it can never be reached again,
    // because it is only offered while the setup step is still the roll-off.
    const a = args({ opponent: WATCH });
    expect(commandPlan(a).id).toBe('setup.opponent');
    expect(commandPlan({ ...a, ui: { opponentChosen: true } }).id).toBe('ai.acting');
  });
});
