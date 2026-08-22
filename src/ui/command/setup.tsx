/**
 * Setup: Approved Ops › GAME SEQUENCE steps 1–3.
 *
 *   killzone → roll-off → initiative + drop zone → kill teams (secret) → deployment
 *
 * The deployment screen is the one the owner called out: the old build armed a placement in
 * one tab and put the board in another, with nothing on the board to say what was armed,
 * where it was legal, or that a tap had been rejected. Here the board IS the screen — it is
 * already aimed at your drop zone, everything outside it is dimmed, the operative you are
 * placing is auto-armed and named in the sheet, the ghost shows legality before you commit,
 * and a rejection arrives as the reducer's own sentence instead of silence.
 */
import type { Store } from '../store.ts';
import type { TeamData } from '../data.ts';
import { card } from '../../core/state.ts';
import { otherPlayer, type PlayerId, type Poly, type Vec2 } from '../../core/types.ts';
import { IconCheck, IconDice, IconHandover, IconMap, IconTarget, IconUndo } from '../icons.tsx';
import type { CommandAction, CommandPlan, UiState, WorldRect } from './types.ts';
import { rectOfPolys } from './types.ts';

const LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };
const ZONE_LABEL: Record<'p1' | 'p2', string> = { p1: 'the orange drop zone', p2: 'the grey drop zone' };

export interface PanelArgs {
  store: Store;
  teams: TeamData[];
  ui: UiState;
  setUi: (next: Partial<UiState>) => void;
}

const pts = (poly: readonly Vec2[]): string => poly.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

/** Dim everything outside `zones`, so where you may deploy is unmistakable. */
export function ZoneSpotlight({ zones, board, colour }: { zones: Poly[]; board: { w: number; h: number }; colour: string }) {
  if (zones.length === 0) return null;
  const id = `spot-${colour.replace('#', '')}`;
  return (
    <g class="zone-spotlight" style={{ pointerEvents: 'none' }}>
      <defs>
        <mask id={id}>
          <rect x={0} y={0} width={board.w} height={board.h} fill="#fff" />
          {zones.map((z, i) => (
            <polygon key={i} points={pts(z)} fill="#000" />
          ))}
        </mask>
      </defs>
      <rect x={0} y={0} width={board.w} height={board.h} fill="#05070a" opacity={0.62} mask={`url(#${id})`} />
      {zones.map((z, i) => (
        <polygon key={`o${i}`} class="legal-zone" points={pts(z)} fill={colour} fill-opacity={0.16} stroke={colour} stroke-width={0.1} />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ roll-off */

export function rollOffPlan({ store }: PanelArgs): CommandPlan {
  const { state } = store;
  return {
    id: 'setup.rollOff',
    step: 'Setup · 1 of 3',
    title: 'Roll off for initiative',
    help: 'The winner decides who has initiative; the player with initiative then picks a drop zone, and their opponent receives the Re-roll initiative card.',
    frame: null,
    detent: 'rest',
    actions: [
      {
        id: 'roll',
        label: 'Roll off',
        tone: 'primary',
        icon: <IconDice size={20} />,
        onClick: () => store.dispatch({ t: 'RollOff', kind: 'initiative' }),
      },
    ],
    body: (
      <div class="card">
        <h2>Killzone</h2>
        <p class="muted" style={{ marginTop: 0 }}>
          {state.map.name}
          {state.map.closeQuarters ? ' · Close Quarters' : ''}
        </p>
        <p class="dim" style={{ margin: 0 }}>
          Change it from the menu before the battle begins.
        </p>
      </div>
    ),
  };
}

/* -------------------------------------------------------------- drop zone */

export function dropZonePlan({ store }: PanelArgs): CommandPlan {
  const { state } = store;
  const chooser = state.setup.toAct ?? 'p1';
  const initiativeChosen = state.initiative !== undefined;
  const board = state.map.board;

  if (!initiativeChosen) {
    return {
      id: 'setup.initiative',
      step: 'Setup · 2 of 3',
      title: `${LABEL[chooser]} won the roll-off`,
      help: 'The winner decides who has initiative this turning point.',
      frame: null,
      detent: 'rest',
      turnOf: chooser,
      actions: [
        {
          id: 'take',
          label: 'Take initiative',
          tone: 'primary',
          onClick: () => store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: chooser }),
        },
        {
          id: 'give',
          label: `Give it to ${LABEL[otherPlayer(chooser)]}`,
          onClick: () => store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: otherPlayer(chooser) }),
        },
      ],
    };
  }

  const picker = state.initiative ?? chooser;
  const choose = (zone: 'p1' | 'p2') => store.dispatch({ t: 'ChooseDropZone', player: picker, zone });

  return {
    id: 'setup.dropZone',
    step: 'Setup · 2 of 3',
    title: `${LABEL[picker]} picks a drop zone`,
    help: 'Tap a drop zone on the killzone, or use the buttons. Your opponent takes the other one.',
    frame: null,
    detent: 'rest',
    turnOf: picker,
    // Tapping the zone itself is the obvious thing to try on a map, so it works.
    armed: {
      commit: (world: Vec2) => choose(world.x < board.w / 2 ? 'p1' : 'p2'),
    },
    highlights: (
      <g style={{ pointerEvents: 'none' }}>
        {state.map.dropZones.p1.map((z, i) => (
          <polygon key={`a${i}`} class="legal-zone" points={pts(z)} fill="#ff9a4d" fill-opacity={0.22} stroke="#ff9a4d" stroke-width={0.1} />
        ))}
        {state.map.dropZones.p2.map((z, i) => (
          <polygon key={`b${i}`} class="legal-zone" points={pts(z)} fill="#8fb8d8" fill-opacity={0.22} stroke="#8fb8d8" stroke-width={0.1} />
        ))}
      </g>
    ),
    actions: [
      { id: 'dz-p1', label: `Take ${ZONE_LABEL.p1}`, tone: 'primary', onClick: () => choose('p1') },
      { id: 'dz-p2', label: `Take ${ZONE_LABEL.p2}`, onClick: () => choose('p2') },
    ],
  };
}

/* --------------------------------------------------- select operatives */

export function selectOperativesPlan(args: PanelArgs): CommandPlan {
  const { store, teams, ui, setUi } = args;
  const { state } = store;
  const next = (['p1', 'p2'] as PlayerId[]).find((p) => state.teams[p].operativeIds.length === 0);

  if (!next) {
    return {
      id: 'setup.reveal',
      step: 'Setup · 3 of 3',
      title: 'Reveal both kill teams',
      help: 'Kill teams are selected in secret, then revealed at the same time.',
      frame: null,
      detent: 'half',
      actions: [
        {
          id: 'reveal',
          label: 'Reveal and deploy',
          tone: 'primary',
          icon: <IconCheck size={20} />,
          onClick: () => store.dispatch({ t: 'BeginDeployment' }),
        },
      ],
      body: (
        <div>
          {(['p1', 'p2'] as PlayerId[]).map((p) => (
            <div key={p} class="card">
              <h2>{LABEL[p]}</h2>
              <div class="entry-name">{teams.find((t) => t.id === state.teams[p].teamId)?.name ?? state.teams[p].teamId}</div>
              <div class="entry-meta">{state.teams[p].operativeIds.length} operatives</div>
            </div>
          ))}
        </div>
      ),
    };
  }

  if (ui.handedOverTo !== next) {
    return {
      id: 'setup.handover',
      step: 'Setup · 3 of 3',
      title: `Hand the device to ${LABEL[next]}`,
      help: 'Kill teams are selected secretly. Do not look at your opponent’s screen.',
      frame: null,
      detent: 'rest',
      modal: true,
      turnOf: next,
      actions: [
        {
          id: 'handover',
          label: `I am ${LABEL[next]}`,
          tone: 'primary',
          icon: <IconHandover size={20} />,
          // Straight into the builder: the hand-over and "now choose" are one intention.
          onClick: () => setUi({ handedOverTo: next, route: 'rosters' }),
        },
      ],
    };
  }

  // The builder itself is a full-screen route: choosing six operatives out of a printed list
  // is a task, not a glance, and it must not fight the board for the screen.
  return {
    id: 'setup.selectOperatives',
    step: 'Setup · 3 of 3',
    title: `${LABEL[next]} — choose your kill team`,
    help: 'Pick a kill team, then select operatives as its printed requirements allow.',
    frame: null,
    detent: 'rest',
    modal: true,
    turnOf: next,
    actions: [
      {
        id: 'open-builder',
        label: 'Choose operatives',
        tone: 'primary',
        icon: <IconMap size={20} />,
        onClick: () => setUi({ route: 'rosters' }),
      },
    ],
  };
}

/* ------------------------------------------------------------- deployment */

export interface DeployBatch {
  player: PlayerId;
  /** Operatives of the deploying player still off the board, in letter order. */
  undeployed: { id: string; letter: string }[];
  /** How many this player still puts down before the turn alternates. */
  remainingInBatch: number;
  deployed: number;
  total: number;
}

/** Alternating deployment in thirds, rounding up — the same arithmetic `deployTurn` uses. */
export function deployBatch(store: Store): DeployBatch {
  const { state } = store;
  const init = state.initiative ?? 'p1';
  const other = otherPlayer(init);
  const done = (p: PlayerId) => state.setup.deployedCount[p] ?? 0;
  const size = (p: PlayerId) => state.teams[p].operativeIds.length;
  const third = (p: PlayerId) => Math.max(1, Math.ceil(size(p) / 3));

  const pick = (): PlayerId => {
    if (size(init) === 0) return init;
    if (done(init) >= size(init)) return other;
    if (done(other) >= size(other)) return init;
    return Math.floor(done(init) / third(init)) <= Math.floor(done(other) / third(other)) ? init : other;
  };

  const player = pick();
  const total = size(player);
  const deployed = done(player);
  const batchEnd = Math.min(total, (Math.floor(deployed / third(player)) + 1) * third(player));
  return {
    player,
    undeployed: Object.values(state.operatives)
      .filter((o) => o.player === player && o.pos.x < -50)
      .sort((a, b) => a.letter.localeCompare(b.letter))
      .map((o) => ({ id: o.id, letter: o.letter })),
    remainingInBatch: Math.max(0, batchEnd - deployed),
    deployed,
    total,
  };
}

export function deployPlan({ store, ui, setUi }: PanelArgs): CommandPlan {
  const { state, ctx } = store;
  const batch = deployBatch(store);
  const player = batch.player;
  const zoneKey = state.setup.dropZone[player] ?? player;
  const zones = state.map.dropZones[zoneKey];
  const frame: WorldRect | null = rectOfPolys(zones);
  const colour = player === 'p1' ? '#ff9a4d' : '#8fb8d8';
  const allDeployed = Object.values(state.operatives).every((o) => o.pos.x > -50);

  if (allDeployed) {
    return {
      id: 'setup.deployDone',
      step: 'Setup · 3 of 3',
      title: 'Both kill teams are on the killzone',
      help: 'Every operative starts with a Conceal order.',
      frame: null,
      detent: 'rest',
      actions: [
        {
          id: 'begin',
          label: 'Begin the battle',
          tone: 'primary',
          icon: <IconCheck size={20} />,
          onClick: () => store.dispatch({ t: 'FinishSetup' }),
        },
        ...undoAction(store),
      ],
    };
  }

  // Auto-arm: the next operative in the batch is already selected, so placing three is
  // three taps on the board rather than three round trips through a list.
  const placingId = batch.undeployed.some((o) => o.id === ui.placingId)
    ? ui.placingId
    : batch.undeployed[0]?.id;
  const placing = placingId ? state.operatives[placingId] : undefined;
  const placingCard = placing ? card(ctx, placing) : undefined;

  const armed = placing
    ? {
        base: placingCard?.base,
        rotDeg: placing.rot,
        legal: (world: Vec2) => {
          const probe = store.probe({ t: 'DeployOperative', player, operativeId: placing.id, pos: world });
          return probe.ok ? { ok: true } : { ok: false, ...(probe.reason ? { reason: probe.reason } : {}) };
        },
        commit: (world: Vec2) => {
          const ok = store.dispatch({ t: 'DeployOperative', player, operativeId: placing.id, pos: world });
          if (ok) {
            const rest = batch.undeployed.filter((o) => o.id !== placing.id);
            setUi({ placingId: rest[0]?.id });
          }
        },
      }
    : null;

  return {
    id: 'setup.deploy',
    step: `Setup · 3 of 3 · ${LABEL[player]}`,
    title: placing ? `Place ${placing.letter} — ${placingCard?.name ?? ''}` : 'Deploy your kill team',
    help: 'Set up wholly within your drop zone, on a Conceal order. Tap the board to place; drag to aim, two fingers to pan.',
    armedNote: `${batch.deployed} of ${batch.total} placed · ${batch.remainingInBatch} more before ${LABEL[otherPlayer(player)]} deploys`,
    frame,
    detent: 'rest',
    turnOf: player,
    armed,
    highlights: <ZoneSpotlight zones={zones} board={state.map.board} colour={colour} />,
    actions: undoAction(store),
    body: (
      <div>
        <p class="section-title">Still to place</p>
        <div class="op-strip">
          {batch.undeployed.map((o) => (
            <button
              key={o.id}
              class={`op-chip${player === 'p2' ? ' is-p2' : ''}`}
              aria-pressed={o.id === placingId}
              onClick={() => setUi({ placingId: o.id })}
            >
              <span class="letter">{o.letter}</span>
              <span>
                <span class="op-name">{card(ctx, state.operatives[o.id]!).name}</span>
                <span class="op-sub">{o.id === placingId ? 'placing' : 'tap to place next'}</span>
              </span>
            </button>
          ))}
        </div>
        <p class="rule-text" style={{ marginTop: 12 }}>
          Alternate setting up one third of your kill team (rounding up), starting with the player with
          initiative. Operatives must be set up wholly within your drop zone and given a Conceal order.
        </p>
      </div>
    ),
  };
}

function undoAction(store: Store): CommandAction[] {
  if (!store.canUndo()) return [];
  return [
    {
      id: 'undo',
      label: 'Undo last placement',
      tone: 'quiet',
      icon: <IconUndo size={20} />,
      onClick: () => store.undo(),
    },
  ];
}

/** Placeholder so an unhandled setup step is loud rather than a blank screen. */
export function unknownSetupPlan(step: string): CommandPlan {
  return {
    id: `setup.${step}`,
    step: 'Setup',
    title: `Setup step: ${step}`,
    help: 'This step has no screen yet.',
    frame: null,
    detent: 'rest',
    actions: [],
    body: (
      <p class="err">
        <IconTarget size={16} /> No screen is registered for the setup step “{step}”.
      </p>
    ),
  };
}
