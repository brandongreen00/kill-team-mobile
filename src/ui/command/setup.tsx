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
import { canDeployAt } from '../../core/reducer.ts';
import { deployBatchRemaining, deployToAct } from '../../core/phases.ts';
import { availableOps } from '../../core/game.ts';
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

  // Both kill teams chosen: equipment and the tac op come next. This is not decoration —
  // `SelectTacOp` is the ONLY caller of `ctx.initOps`, so a battle that skips it initialises
  // no op at all and scores nothing for the whole four turning points.
  if (!next) {
    const owing = (['p1', 'p2'] as PlayerId[]).find((p) => !state.teams[p].tacOpId);
    if (owing) return loadoutPlan(args, owing);
  }

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

/* --------------------------------------------------- equipment + tac op */

/**
 * One secret screen per player: up to four equipment options and one tac op, confirmed
 * together. They are one screen rather than two because `tacOpId` is then the single
 * derivable marker for "this player has finished choosing" — the UI holds no step of its own,
 * and a reload or a re-render lands back on exactly the same question.
 */
function loadoutPlan({ store, teams, ui, setUi }: PanelArgs, player: PlayerId): CommandPlan {
  const { state, ctx } = store;

  if (ui.handedOverTo !== player) {
    return {
      id: 'setup.loadoutHandover',
      step: 'Setup · 3 of 3',
      title: `Hand the device to ${LABEL[player]}`,
      help: 'Equipment and tac ops are chosen secretly.',
      frame: null,
      detent: 'rest',
      modal: true,
      turnOf: player,
      actions: [
        {
          id: 'handover',
          label: `I am ${LABEL[player]}`,
          tone: 'primary',
          icon: <IconHandover size={20} />,
          onClick: () => setUi({ handedOverTo: player }),
        },
      ],
    };
  }

  const teamData = teams.find((t) => t.id === state.teams[player].teamId);
  const universal = [...ctx.equipment.values()].filter((e) => e.scope === 'universal');
  const faction = [...ctx.equipment.values()].filter((e) => e.teamId === state.teams[player].teamId);
  const equipment = [...faction, ...universal];
  const chosen = ui.equipment ?? [];
  const archetypes = state.teams[player].archetypes;
  const tacOps = availableOps().filter(
    (o) => o.kind === 'tac' && (!o.archetype || archetypes.length === 0 || archetypes.includes(o.archetype)),
  );
  const tacOpId = ui.tacOpId;

  const toggle = (id: string) =>
    setUi({ equipment: chosen.includes(id) ? chosen.filter((e) => e !== id) : chosen.length >= 4 ? chosen : [...chosen, id] });

  return {
    id: 'setup.loadout',
    step: 'Setup · 3 of 3',
    title: `${LABEL[player]} — equipment and tac op`,
    help: `Choose up to four equipment options and exactly one tac op for ${teamData?.name ?? 'your kill team'}. Both are secret until the battle ends.`,
    frame: null,
    detent: 'half',
    modal: true,
    turnOf: player,
    actions: [
      {
        id: 'confirm-loadout',
        label: tacOpId ? 'Confirm' : 'Choose a tac op',
        tone: 'primary',
        disabled: !tacOpId,
        hint: tacOpId ? undefined : 'A tac op is required — it is how your kill team scores.',
        icon: <IconCheck size={20} />,
        onClick: () => {
          if (!tacOpId) return;
          if (chosen.length > 0) store.dispatch({ t: 'SelectEquipment', player, equipment: chosen });
          store.dispatch({ t: 'SelectTacOp', player, tacOpId });
          setUi({ handedOverTo: undefined, equipment: undefined, tacOpId: undefined });
        },
      },
    ],
    body: (
      <>
        <p class="section-title">Tac op — pick one</p>
        <div class="actions tac-ops">
          {tacOps.length === 0 && <p class="dim">No tac op is available to this kill team.</p>}
          {tacOps.map((o) => (
            <button key={o.id} aria-pressed={tacOpId === o.id} onClick={() => setUi({ tacOpId: o.id })}>
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                <span class="entry-name">{o.name}</span>
                <span class="entry-meta" title={o.text}>
                  {o.text}
                </span>
              </span>
              {tacOpId === o.id && <IconCheck size={20} />}
            </button>
          ))}
        </div>
        <p class="section-title" style={{ marginTop: 16 }}>
          Equipment — up to four ({chosen.length}/4)
        </p>
        <div class="actions equipment-options">
          {equipment.map((e) => (
            <button
              key={e.id}
              aria-pressed={chosen.includes(e.id)}
              disabled={!chosen.includes(e.id) && chosen.length >= 4}
              onClick={() => toggle(e.id)}
            >
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                <span class="entry-name">{e.name}</span>
                <span class="entry-meta" title={e.text}>
                  {e.text}
                </span>
              </span>
              {chosen.includes(e.id) && <IconCheck size={20} />}
            </button>
          ))}
        </div>
      </>
    ),
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

/**
 * Who deploys next, and how many they place before the turn passes.
 *
 * The alternating-thirds rule lives in `core/phases.ts` (`deployToAct`), quoting its printed
 * text, because it IS a rule: the reducer does not enforce turn order on `DeployOperative`,
 * so if the UI derived it privately the app would be the only thing that knew it, and no test
 * would cover it.
 */
export function deployBatch(store: Store): DeployBatch {
  const { state } = store;
  const player = deployToAct(state) ?? state.initiative ?? 'p1';
  return {
    player,
    undeployed: Object.values(state.operatives)
      .filter((o) => o.player === player && o.pos.x < -50)
      .sort((a, b) => a.letter.localeCompare(b.letter))
      .map((o) => ({ id: o.id, letter: o.letter })),
    remainingInBatch: deployBatchRemaining(state, player),
    deployed: state.setup.deployedCount[player] ?? 0,
    total: state.teams[player].operativeIds.length,
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
        // `canDeployAt` is the reducer's own legality body, exported: the ghost gets the same
        // answer in the same words as the intent it is about to send, and gets it without
        // cloning the whole GameState through `reduce` on every frame of a drag.
        legal: (world: Vec2) => canDeployAt(ctx, state, placing, world, placing.rot),
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
