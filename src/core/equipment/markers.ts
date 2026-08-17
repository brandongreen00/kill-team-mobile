/**
 * The three marker-only universal equipment options: Comms Device, Mines, and the terrain-free
 * half of the kit list. (Ammo Cache lives in ammoCache.ts because it also adds an action.)
 */
import { markerContestedBy, markerController } from '../state.ts';
import { equipmentText } from './text.ts';
import type { GameContext } from '../context.ts';
import type { EquipmentModule } from './kit.ts';
import type { GameState, OperativeState } from '../types.ts';

export const COMMS_ID = 'eq.commsDevice';
export const MINES_ID = 'eq.mines';

/**
 * "While a friendly operative controls this marker, add 3" to the distance requirements of its
 * SUPPORT rules that refer to friendly operatives... you cannot benefit from your opponent's
 * Comms Device markers."
 */
export function commsDeviceBonus(ctx: GameContext, state: GameState, op: OperativeState): number {
  const marker = Object.values(state.markers).find(
    (m) =>
      m.kind === 'commsDevice' &&
      m.owner === op.player &&
      markerContestedBy(ctx, state, m, op) &&
      markerController(ctx, state, m) === op.player,
  );
  return marker ? 3 : 0;
}

export const commsDeviceEquipment: EquipmentModule = {
  id: COMMS_ID,
  name: 'Comms Device',
  scope: 'universal',
  text: equipmentText(COMMS_ID),
  items: [{ kind: 'marker', markerKind: 'commsDevice', constraints: ['whollyWithinTerritory'] }],
};

/**
 * "Before the battle, you can set up one of your Mines markers wholly within your territory and
 * more than 2" from other markers, access points and Accessible terrain. The first time that
 * marker is within an operative's control range, remove that marker and inflict D3+3 damage on
 * that operative." (The trigger itself lives in `actions.ts`, which checks it after every move.)
 */
export const minesEquipment: EquipmentModule = {
  id: MINES_ID,
  name: 'Mines',
  scope: 'universal',
  text: equipmentText(MINES_ID),
  items: [
    {
      kind: 'marker',
      markerKind: 'mine',
      constraints: [
        'whollyWithinTerritory',
        'moreThan2FromMarkers',
        'moreThan2FromAccessPoints',
        'moreThan2FromAccessible',
      ],
    },
  ],
};
