/**
 * Crit op 9 — Reboot.
 *
 * "When setting up the battle, after setting up objective markers, number each objective
 * marker 1–3. At the start of the Gambit step of each Strategy phase, each player secretly
 * selects one objective marker... then reveal simultaneously: If both players selected the
 * same one, that objective marker is inert during this turning point. If not, the objective
 * marker that neither player selected is inert during this turning point."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import {
  activeControls,
  awardVP,
  binding,
  controlledObjectives,
  objectiveMarkers,
  opScratch,
  pushOpDecision,
  registerSharedOpHooks,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'crit.reboot';

interface RebootScratch extends Record<string, unknown> {
  /** player -> the number they secretly selected this turning point. */
  picks: Record<string, number | undefined>;
  picksTP: number;
}

const scratch = (state: GameState): RebootScratch =>
  opScratch<RebootScratch>(state, ID, () => ({ picks: {}, picksTP: 0 }));

export const markerNumber = (state: GameState, markerId: string): number =>
  Number(state.markers[markerId]?.flags['number'] ?? 0);

export const isInert = (state: GameState, markerId: string): boolean =>
  state.markers[markerId]?.flags['inertTP'] === state.turningPoint;

function raiseRebootDecision(state: GameState, player: PlayerId): void {
  const numbers = objectiveMarkers(state)
    .map((m) => Number(m.flags['number'] ?? 0))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return;
  pushOpDecision(state, {
    id: `reboot-${player}-tp${state.turningPoint}`,
    who: player,
    kind: 'rebootSelect',
    prompt: 'Reboot: secretly select an objective marker number (revealed simultaneously)',
    sourceText: opText(ID),
    options: numbers.map((n) => ({ id: String(n), label: `Objective marker ${n}`, data: { number: n } })),
  });
}

/** Both selections are in: work out which marker goes inert for this turning point. */
function applyReveal(state: GameState): void {
  const s = scratch(state);
  const a = s.picks['p1'];
  const b = s.picks['p2'];
  if (a === undefined || b === undefined) return;
  const markers = objectiveMarkers(state);
  let inert = markers.find((m) => Number(m.flags['number']) === a && a === b);
  if (!inert) {
    // "the objective marker that neither player selected is inert" — with the printed three
    // markers exactly one is left; if a map ever has more, the lowest-numbered one is used.
    const unselected = markers
      .filter((m) => Number(m.flags['number']) !== a && Number(m.flags['number']) !== b)
      .sort((x, y) => Number(x.flags['number']) - Number(y.flags['number']));
    inert = unselected[0];
  }
  s.picks = {};
  if (!inert) return;
  inert.flags['inertTP'] = state.turningPoint;
  log(state, {
    kind: 'system',
    text: `Reboot: P1 selected ${a}, P2 selected ${b} — objective marker ${inert.flags['number']} is inert this turning point`,
  });
}

registerAction({
  id: 'Reboot',
  name: 'Reboot',
  ap: 2,
  type: 'mission',
  sourceText: printedAction(ID, 'Reboot').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    if (state.turningPoint < 2) return { ok: false, reason: 'cannot be performed during the first turning point' };
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!isInert(state, marker.id)) return { ok: false, reason: 'that objective marker is not inert' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    delete marker.flags['inertTP'];
    log(state, { kind: 'action', player: op.player, text: `${op.name} reboots ${marker.id}` });
    return { ok: true };
  },
});

export const rebootOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Reboot',
  text: opText(ID),
  init(_ctx, state) {
    objectiveMarkers(state).forEach((m, i) => {
      m.flags['number'] = i + 1;
    });
  },
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on('onReadyStep', binding(`${ID}.select`, opText(ID), player, 10), (ev, b) => {
      if (b.player !== ev.player) return;
      const s = scratch(ev.state);
      if (s.picksTP !== ev.state.turningPoint) {
        s.picksTP = ev.state.turningPoint;
        s.picks = {};
      }
      raiseRebootDecision(ev.state, ev.player);
    });
  },
  resolveDecision(_ctx, state, decision, _optionId, data) {
    if (decision.kind !== 'rebootSelect') return false;
    const n = Number(data?.['number'] ?? NaN);
    if (!Number.isFinite(n)) return false;
    const s = scratch(state);
    s.picks[decision.who] = n;
    log(state, { kind: 'system', player: decision.who, text: 'Reboot selection made (secret)' });
    applyReveal(state);
    return true;
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const held = controlledObjectives(ctx, state, player, (m) => m.flags['inertTP'] !== state.turningPoint).length;
    if (held > 0)
      awardVP(ctx, state, player, ID, held, `Reboot: controlling ${held} objective marker(s) that are not inert`);
  },
};
