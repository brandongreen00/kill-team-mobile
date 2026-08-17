/**
 * Visible dice.
 *
 * The owner's requirement: attack dice appear ABOVE THE SHOOTER on the board, defence dice
 * above the defender, they roll with a short animation, then resolve into retained/discarded
 * with weapon-rule tags. Rerolls replay the animation on those dice only.
 *
 * The pool is drawn inside the board's world transform, so it follows pan and zoom. On very
 * small screens `DiceDock` docks the same component to a bottom sheet and draws a leader line
 * back to the operative.
 */
import type { Die, DieState } from '../../core/dice.ts';
import type { Vec2 } from '../../core/types.ts';

const FACE_PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [
    [0.28, 0.28],
    [0.72, 0.72],
  ],
  3: [
    [0.26, 0.26],
    [0.5, 0.5],
    [0.74, 0.74],
  ],
  4: [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.28, 0.72],
    [0.72, 0.72],
  ],
  5: [
    [0.26, 0.26],
    [0.74, 0.26],
    [0.5, 0.5],
    [0.26, 0.74],
    [0.74, 0.74],
  ],
  6: [
    [0.28, 0.24],
    [0.72, 0.24],
    [0.28, 0.5],
    [0.72, 0.5],
    [0.28, 0.76],
    [0.72, 0.76],
  ],
};

const STATE_STYLE: Record<DieState, { fill: string; ink: string; label: string }> = {
  crit: { fill: '#f6c445', ink: '#20170a', label: 'critical success' },
  normal: { fill: '#e7e9ec', ink: '#15181d', label: 'normal success' },
  fail: { fill: '#4a4f58', ink: '#9aa3af', label: 'fail' },
  discarded: { fill: '#33373e', ink: '#6b7280', label: 'discarded' },
  blocked: { fill: '#3b6ea5', ink: '#dce8f5', label: 'blocked' },
  struck: { fill: '#e0574a', ink: '#2a0f0c', label: 'struck' },
};

export interface DieViewProps {
  die: Die;
  /** Side length in world inches. */
  size: number;
  x: number;
  y: number;
  /** Animate this die as freshly rolled / re-rolled. */
  rolling?: boolean;
  onClick?: (die: Die) => void;
  selectable?: boolean;
}

export function DieView({ die, size, x, y, rolling, onClick, selectable }: DieViewProps) {
  const style = STATE_STYLE[die.state];
  const pips = die.rolled ? (FACE_PIPS[die.value] ?? []) : [];
  const label = die.rolled ? `${die.value}, ${style.label}` : `auto ${style.label}${die.note ? ` (${die.note})` : ''}`;
  return (
    <g
      class={`die die-${die.state}${rolling ? ' die-rolling' : ''}`}
      transform={`translate(${x} ${y}) scale(1 -1)`}
      role="img"
      aria-label={label}
      onClick={onClick ? () => onClick(die) : undefined}
      style={{ cursor: selectable ? 'pointer' : 'default' }}
    >
      <rect
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        rx={size * 0.18}
        fill={style.fill}
        stroke={selectable ? '#ffffff' : '#0b0d10'}
        stroke-width={selectable ? size * 0.09 : size * 0.05}
        opacity={die.state === 'discarded' ? 0.55 : 1}
      />
      {pips.map(([px, py], i) => (
        <circle
          key={i}
          cx={-size / 2 + px * size}
          cy={-size / 2 + py * size}
          r={size * 0.085}
          fill={style.ink}
        />
      ))}
      {!die.rolled && (
        <text text-anchor="middle" dy={size * 0.12} font-size={size * 0.5} fill={style.ink} font-weight="700">
          ✓
        </text>
      )}
      {die.rerolledFrom !== undefined && (
        <text text-anchor="middle" dy={-size * 0.62} font-size={size * 0.32} fill="#9aa3af">
          ↻{die.rerolledFrom}
        </text>
      )}
      <title>{label}</title>
    </g>
  );
}

export interface DicePoolViewProps {
  dice: Die[];
  /** World anchor — the operative the dice belong to. */
  anchor: Vec2;
  /** How far above the anchor the row floats, in inches. */
  offset?: number;
  size?: number;
  caption?: string;
  /** Die ids the player may currently pick (reroll / discard / strike choices). */
  selectableIds?: number[];
  onDieClick?: (die: Die) => void;
  /** Die ids that were just (re-)rolled, for the animation. */
  rollingIds?: number[];
}

/** A row of dice floating above an operative, in world coordinates. */
export function DicePoolView({
  dice,
  anchor,
  offset = 1.9,
  size = 0.78,
  caption,
  selectableIds,
  onDieClick,
  rollingIds,
}: DicePoolViewProps) {
  if (dice.length === 0) return null;
  const gap = size * 1.18;
  const width = (dice.length - 1) * gap;
  const y = anchor.y + offset;
  const selectable = new Set(selectableIds ?? []);
  const rolling = new Set(rollingIds ?? []);
  return (
    <g class="dice-pool">
      <rect
        x={anchor.x - width / 2 - size * 0.75}
        y={y - size * 0.8}
        width={width + size * 1.5}
        height={size * 1.6}
        rx={size * 0.4}
        fill="#0b0d10"
        opacity={0.72}
      />
      {dice.map((d, i) => (
        <DieView
          key={d.id}
          die={d}
          size={size}
          x={anchor.x - width / 2 + i * gap}
          y={y}
          selectable={selectable.has(d.id)}
          rolling={rolling.has(d.id)}
          {...(onDieClick && selectable.has(d.id) ? { onClick: onDieClick } : {})}
        />
      ))}
      {caption && (
        <g transform={`translate(${anchor.x} ${y + size * 1.15}) scale(1 -1)`}>
          <text text-anchor="middle" font-size={size * 0.5} fill="#9aa3af">
            {caption}
          </text>
        </g>
      )}
    </g>
  );
}

/** Floating damage number, animated away from the target. */
export function DamageFloat({ anchor, amount }: { anchor: Vec2; amount: number }) {
  return (
    <g class="dmg-float" transform={`translate(${anchor.x} ${anchor.y + 1}) scale(1 -1)`}>
      <text text-anchor="middle" font-size="1.1" fill="#e0574a" font-weight="800" stroke="#0b0d10" stroke-width="0.06">
        −{amount}
      </text>
    </g>
  );
}

/** The firing line drawn between shooter and target while a sequence is live. */
export function FiringLine({ from, to }: { from: Vec2; to: Vec2 }) {
  return (
    <g class="firing-line">
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke="#f6c445"
        stroke-width={0.06}
        stroke-dasharray="0.3 0.2"
        opacity={0.85}
      />
      <circle cx={to.x} cy={to.y} r={0.95} fill="none" stroke="#e0574a" stroke-width={0.07} stroke-dasharray="0.25 0.2" />
    </g>
  );
}
