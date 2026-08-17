/**
 * BREACHING CHARGE.
 *
 * "Once per battle, when a friendly operative performs the Breach action, you can use this
 * rule. If you do, that operative can perform that action for 1 less AP (to a minimum of 1AP)
 * as though it had the word 'breach marker' on its datacard."
 *
 * The discount is offered while the charge is unused and is spent at the end of the activation
 * in which a Breach was actually performed.
 */
import { log } from '../state.ts';
import { equipmentText } from './text.ts';
import type { EquipmentModule } from './kit.ts';
import type { GameState, PlayerId } from '../types.ts';

export const BREACHING_CHARGE_ID = 'eq.breachingCharge';
const USED = 'used:eq.breachingCharge';

export const breachingChargeUsed = (state: GameState, player: PlayerId): boolean =>
  (state.teams[player].equipmentUses[USED] ?? 0) > 0;

export const breachingChargeEquipment: EquipmentModule = {
  id: BREACHING_CHARGE_ID,
  name: 'Breaching Charge',
  scope: 'universal',
  text: equipmentText(BREACHING_CHARGE_ID),
  register(reg, player) {
    reg.on(
      'onActionCost',
      { id: `${BREACHING_CHARGE_ID}.cost`, sourceText: equipmentText(BREACHING_CHARGE_ID), player, priority: 20 },
      (ev, b) => {
        if (ev.action !== 'Breach') return;
        if (!b.player || ev.operative.player !== b.player) return;
        if (breachingChargeUsed(ev.state, b.player)) return;
        ev.ap = Math.max(1, ev.ap - 1);
      },
    );
    reg.on(
      'onActivationEnd',
      { id: `${BREACHING_CHARGE_ID}.spend`, sourceText: equipmentText(BREACHING_CHARGE_ID), player, priority: 20 },
      (ev, b) => {
        if (!b.player || ev.operative.player !== b.player) return;
        if (breachingChargeUsed(ev.state, b.player)) return;
        if (!ev.operative.actionsThisActivation.includes('Breach')) return;
        ev.state.teams[b.player].equipmentUses[USED] = 1;
        log(ev.state, { kind: 'system', player: b.player, text: 'Breaching Charge used' });
      },
    );
  },
};
