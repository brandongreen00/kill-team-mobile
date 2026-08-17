/**
 * Draws the in-flight Shoot/Fight sequence on the board: attack dice above the shooter,
 * defence dice above the defender, the firing line between them, and — for fights — both
 * pools above their operatives with the alternating strike/block ticker.
 */
import { DicePoolView, FiringLine } from './dice/Dice.tsx';
import type { GameState, PendingDecision } from '../core/types.ts';

export interface SequenceOverlayProps {
  state: GameState;
  /** The decision currently being answered, so its dice can be made selectable. */
  decision?: PendingDecision | undefined;
}

export function SequenceOverlay({ state, decision }: SequenceOverlayProps) {
  const seq = state.sequence;
  if (!seq) return null;

  const selectableFromDecision = (): number[] => {
    if (!decision) return [];
    const ids: number[] = [];
    for (const o of decision.options) {
      const id = typeof o.data?.['dieId'] === 'number' ? (o.data['dieId'] as number) : undefined;
      if (id !== undefined) ids.push(id);
      if (o.id.startsWith('die:')) ids.push(Number(o.id.slice(4)));
      if (o.id.startsWith('strike:')) ids.push(Number(o.id.slice(7)));
      if (o.id.startsWith('block:')) ids.push(Number(o.id.slice(6)));
    }
    return ids;
  };
  const selectable = selectableFromDecision();

  if (seq.kind === 'shoot') {
    const shooter = state.operatives[seq.attackerId];
    const target = state.operatives[seq.targetId];
    if (!shooter || !target) return null;
    const tags: string[] = [];
    if (seq.obscured) tags.push('obscured');
    if (seq.inCover) tags.push('cover save');
    if (seq.vantageAccurate > 0) tags.push(`Vantage Accurate ${seq.vantageAccurate}`);
    if (seq.pointBlank) tags.push('point-blank');
    return (
      <g class="sequence-overlay">
        <FiringLine from={shooter.pos} to={target.pos} />
        <DicePoolView
          dice={seq.attack.dice}
          anchor={shooter.pos}
          caption={`${seq.weaponName}${tags.length ? ` · ${tags.join(' · ')}` : ''}`}
          selectableIds={selectable}
        />
        <DicePoolView dice={seq.defence.dice} anchor={target.pos} caption="defence" selectableIds={selectable} />
      </g>
    );
  }

  const attacker = state.operatives[seq.attackerId];
  const defender = state.operatives[seq.defenderId];
  if (!attacker || !defender) return null;
  return (
    <g class="sequence-overlay">
      <FiringLine from={attacker.pos} to={defender.pos} />
      <DicePoolView
        dice={seq.attackerPool.dice}
        anchor={attacker.pos}
        caption={`${seq.attackerWeapon}${seq.attackerAssists ? ` · +${seq.attackerAssists} assist` : ''}${
          seq.turn === 'attacker' ? ' · to resolve' : ''
        }`}
        selectableIds={selectable}
      />
      <DicePoolView
        dice={seq.defenderPool.dice}
        anchor={defender.pos}
        caption={`${seq.defenderCanRetaliate ? (seq.defenderWeapon ?? 'retaliation') : 'cannot retaliate'}${
          seq.turn === 'defender' ? ' · to resolve' : ''
        }`}
        selectableIds={selectable}
      />
    </g>
  );
}
