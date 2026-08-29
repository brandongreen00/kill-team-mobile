/**
 * Two screens that only exist because somebody might not be in the room.
 *
 * `setup.opponent` is the first thing the app shows: who is playing which side. It is a
 * `commandPlan` branch rather than a route or a modal, for the reason every other screen is —
 * the shell has exactly one thing to do at a time and publishes which one on `data-screen`, so
 * a full-screen overlay would leave the topbar naming the roll-off underneath it.
 *
 * `ai.acting` is the other side of the same coin. Every screen in the battle is derived from
 * "whose turn is it", and until now the answer was always "the person holding the phone" — so
 * when the answer is "nobody", the board must stop being tappable. Without this branch a solo
 * player would be shown the opponent's activation screen, with the opponent's operatives
 * ringed and armed, and could simply play the AI's turn for it.
 */
import { rectAround, rectOfPolys, type CommandAction, type CommandPlan, type WorldRect } from './types.ts';
import type { CommandArgs } from './index.tsx';
import type { AiTurn } from '../ai/driver.ts';
import {
  DIFFICULTY_BLURB,
  DIFFICULTY_LABEL,
  isAi,
  isWatching,
  type OpponentConfig,
  type Seat,
} from '../ai/opponent.ts';
import { playableTeams } from '../ai/roster.ts';
import { IconCheck, IconHandover, IconTarget } from '../icons.tsx';
import type { Difficulty } from '../../ai/types.ts';
import type { PlayerId } from '../../core/types.ts';

const LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };
const DIFFICULTIES: readonly Difficulty[] = ['recruit', 'veteran', 'elite'];

interface Mode {
  id: string;
  label: string;
  blurb: string;
  seats: { p1: Seat; p2: Seat };
}

/** The four ways a battle can be staffed, as one list rather than two coupled toggles. */
export const MODES: Mode[] = [
  {
    id: 'pass-and-play',
    label: 'Pass and play',
    blurb: 'Two players, one device. It asks for a hand-over before anything either of you keeps secret.',
    seats: { p1: 'human', p2: 'human' },
  },
  {
    id: 'ai-p2',
    label: 'Play the AI — you are Player 1',
    blurb: 'You take the first drop zone. The AI chooses its own kill team, deploys, and plays its own turns.',
    seats: { p1: 'human', p2: 'ai' },
  },
  {
    id: 'ai-p1',
    label: 'Play the AI — you are Player 2',
    blurb: 'The AI rolls off and picks first, which is the harder side of most killzones.',
    seats: { p1: 'ai', p2: 'human' },
  },
  {
    id: 'watch',
    label: 'Watch the AI play itself',
    blurb: 'Both sides driven, including the beats you would otherwise press. Useful for reading a killzone.',
    seats: { p1: 'ai', p2: 'ai' },
  },
];

export const modeOf = (opponent: OpponentConfig): Mode =>
  MODES.find((m) => m.seats.p1 === opponent.p1 && m.seats.p2 === opponent.p2) ?? MODES[0]!;

/** One line for the topbar-adjacent places that need to say what kind of battle this is. */
export function opponentSummary(opponent: OpponentConfig, teamName?: string): string {
  const mode = modeOf(opponent);
  if (mode.id === 'pass-and-play') return 'Pass and play';
  const who = mode.id === 'watch' ? 'AI vs AI' : `vs the AI as ${opponent.p1 === 'human' ? 'Player 1' : 'Player 2'}`;
  return `${who} · ${DIFFICULTY_LABEL[opponent.difficulty]}${teamName ? ` · ${teamName}` : ''}`;
}

/* ------------------------------------------------------------------ picker */

export function opponentPlan(args: CommandArgs): CommandPlan {
  const { store, teams, opponent, setOpponent, setUi } = args;
  const mode = modeOf(opponent);
  const anyAi = isAi(opponent, 'p1') || isAi(opponent, 'p2');
  const buildable = playableTeams(teams);
  const chosenTeam = buildable.find((t) => t.id === opponent.teamId);

  // One line, and short enough not to wrap: the peek's height sets `--sheet-rest`, and what
  // was chosen is already ticked in the rows below. The difficulty and the kill team do not
  // belong here for the same reason.
  const START_LABEL: Record<string, string> = {
    'pass-and-play': 'Play — pass and play',
    'ai-p2': 'Play as Player 1',
    'ai-p1': 'Play as Player 2',
    watch: 'Watch the battle',
  };
  const start: CommandAction = {
    id: 'start',
    label: START_LABEL[mode.id] ?? 'Play',
    tone: 'primary',
    icon: <IconCheck size={20} />,
    hint: anyAi ? opponentSummary(opponent, chosenTeam?.name) : undefined,
    onClick: () => setUi({ opponentChosen: true }),
  };

  return {
    id: 'setup.opponent',
    step: 'Before the battle',
    title: 'Who is playing?',
    help:
      'The AI drives its side through the same rules you do — it selects a kill team, deploys, spends its command points and answers its own re-rolls. Everything it does is in the battle log.',
    // The board is background on this screen, so it keeps whatever framing it had — the same
    // choice `setup.rollOff` makes. Asking for `fit` here would letterbox the killzone behind
    // a sheet that covers half of it anyway.
    frame: null,
    detent: 'half',
    modal: true,
    actions: [start],
    body: (
      <>
        <p class="section-title">This battle</p>
        <div class="actions tac-ops">
          {MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={m.id === mode.id}
              onClick={() => setOpponent({ ...opponent, p1: m.seats.p1, p2: m.seats.p2 })}
            >
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                <span class="entry-name">{m.label}</span>
                <span class="entry-meta">{m.blurb}</span>
              </span>
              {m.id === mode.id && <IconCheck size={20} />}
            </button>
          ))}
        </div>

        {anyAi && (
          <>
            <p class="section-title" style={{ marginTop: 16 }}>
              How well it plays
            </p>
            <div class="actions tac-ops">
              {DIFFICULTIES.map((d) => (
                <button key={d} aria-pressed={d === opponent.difficulty} onClick={() => setOpponent({ ...opponent, difficulty: d })}>
                  <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                    <span class="entry-name">{DIFFICULTY_LABEL[d]}</span>
                    <span class="entry-meta">{DIFFICULTY_BLURB[d]}</span>
                  </span>
                  {d === opponent.difficulty && <IconCheck size={20} />}
                </button>
              ))}
            </div>

            <p class="section-title" style={{ marginTop: 16 }}>
              The AI’s kill team {chosenTeam ? `— ${chosenTeam.name}` : '— chosen for you'}
            </p>
            <ul class="team-list">
              <li>
                <button aria-pressed={!opponent.teamId} onClick={() => setOpponent({ ...opponent, teamId: undefined })}>
                  <span>
                    <span class="team-name">Surprise me</span>
                    <span class="team-sub">A different kill team each battle, chosen from the seed.</span>
                  </span>
                  {!opponent.teamId && <IconCheck size={20} />}
                </button>
              </li>
              {buildable.map((t) => (
                <li key={t.id}>
                  <button aria-pressed={t.id === opponent.teamId} onClick={() => setOpponent({ ...opponent, teamId: t.id })}>
                    <span>
                      <span class="team-name">{t.name}</span>
                      <span class="team-sub">{t.archetypes?.join(' · ') || t.faction || ''}</span>
                    </span>
                    {t.id === opponent.teamId && <IconCheck size={20} />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {!anyAi && (
          <p class="rule-text" style={{ marginTop: 12 }}>
            Kill teams, equipment and tac ops are chosen in secret, so a pass-and-play battle asks you to
            confirm who is holding the device before each of those screens. {store.state.map.name} is the
            killzone; change it from the menu before the battle begins.
          </p>
        )}
      </>
    ),
  };
}

/* -------------------------------------------------------------- the AI's turn */

/** Where to point the board while the AI works, so the player can see what it is doing. */
function aiFrame(args: CommandArgs, turn: AiTurn): WorldRect | 'fit' | null {
  const { state } = args.store;
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && !active.removed) return rectAround(active, 9);
  if (state.phase === 'setup' && state.setup.step === 'deploy') {
    const zone = state.map.dropZones[state.setup.dropZone[turn.player] ?? turn.player];
    return zone ? rectOfPolys(zone) : null;
  }
  // Anything else: leave the player's own framing where they put it.
  return null;
}

/**
 * The opponent's turn, with nothing to press.
 *
 * `actions` is deliberately empty. The board is not armed, no operative is offered for a tap,
 * and the sheet sits at `rest` so the killzone — the thing actually changing — owns the screen.
 * The last few log lines are the body, because the log is the only record of what the AI did
 * and reaching it through the menu mid-turn is exactly the friction this shell exists to remove.
 */
export function aiActingPlan(args: CommandArgs, turn: AiTurn): CommandPlan {
  const { store } = args;
  const { state } = store;
  const recent = state.log.slice(-6).reverse();

  const step =
    state.phase === 'setup'
      ? 'Setup'
      : state.phase === 'endOfTP'
        ? `Turning point ${state.turningPoint} of ${state.maxTurningPoints || 4}`
        : `Turning point ${state.turningPoint} · ${state.phase === 'strategy' ? 'Strategy' : 'Firefight'}`;

  return {
    id: 'ai.acting',
    step,
    title: `${LABEL[turn.player]} ${turn.note}`,
    help: isWatching(args.opponent)
      ? 'Both sides are being played for you. Open the battle log from the menu for the full record.'
      : 'Your opponent is playing. The board updates as it acts; nothing here is yours to tap.',
    frame: aiFrame(args, turn),
    detent: 'rest',
    turnOf: turn.player,
    actions: [],
    body: (
      <>
        <p class="section-title">Just now</p>
        <div class="log">
          {recent.length === 0 && <p class="dim">Nothing yet.</p>}
          {recent.map((l) => (
            <div key={l.seq} class={l.player ? `${l.kind} is-${l.player}` : l.kind}>
              <span class="tp">{l.tp > 0 ? `TP${l.tp}` : 'SET'}</span>
              {l.player && <span class={`who is-${l.player}`}>{LABEL[l.player].replace('Player ', 'P')}</span>}
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      </>
    ),
  };
}

/**
 * The AI stopped.
 *
 * Its acceptance bar is zero rejected intents, so anything that lands here is a defect and
 * says so rather than pretending the battle is fine. The way out is the honest one: take the
 * seat over and keep playing, which needs no rules state at all — the side simply becomes a
 * human one and every screen it owns comes back.
 */
export function aiErrorPlan(args: CommandArgs, message: string): CommandPlan {
  const { opponent, setOpponent, setUi } = args;
  const stuck: PlayerId = isAi(opponent, 'p1') ? 'p1' : 'p2';
  return {
    id: 'ai.error',
    step: 'The AI stopped',
    title: 'The AI could not take its turn',
    help: message,
    frame: null,
    detent: 'half',
    modal: true,
    actions: [
      {
        id: 'take-over',
        label: `Play ${LABEL[stuck]} yourself`,
        tone: 'primary',
        icon: <IconHandover size={20} />,
        onClick: () => {
          setOpponent({ ...opponent, [stuck]: 'human' } as OpponentConfig);
          setUi({ handedOverTo: undefined });
        },
      },
    ],
    body: (
      <p class="err">
        <IconTarget size={16} /> This is a bug, not a rules result: the AI only ever offers intents it has
        already re-checked against the engine. The battle log and the killzone are intact — taking the seat
        over continues the same battle.
      </p>
    ),
  };
}
