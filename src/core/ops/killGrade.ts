/**
 * Kill op grades.
 *
 * Approved Ops › KILL OP: "You start without a kill grade. As enemy operatives are
 * incapacitated, your kill grade goes up until it reaches 5... The table below shows how many
 * enemy operatives must be incapacitated to reach each kill grade. The row you use is
 * determined by the starting number of enemy operatives."
 *
 * The printed table only covers starting sizes 5–14. Every printed row is reproduced exactly
 * by `round(start × grade / 5)` (pinned by a test), so larger teams extrapolate with that
 * formula; smaller teams (possible once operatives are "ignored for the kill op") use
 * `min(grade, start)` so each kill is a grade and tabling the enemy always reaches grade 5.
 * Recorded in docs/OPS.md.
 */
import { KILL_OP_TEXT } from './text.ts';

export const MAX_KILL_GRADE = 5;

/** The printed table: starting enemy size -> the kills needed for grades 1..5. */
export const KILL_GRADE_TABLE: Record<number, number[]> = Object.fromEntries(
  Object.entries(KILL_OP_TEXT.table).map(([size, thresholds]) => [Number(size), [...thresholds]]),
);

/** Kills needed for grades 1..5 against a kill team of `startingSize` operatives. */
export function killGradeThresholds(startingSize: number): number[] {
  const printed = KILL_GRADE_TABLE[startingSize];
  if (printed) return printed;
  const grades = [1, 2, 3, 4, 5];
  if (startingSize < 5) return grades.map((g) => Math.max(1, Math.min(g, startingSize)));
  return grades.map((g) => Math.round((startingSize * g) / 5));
}

/** The kill grade reached after `incapacitated` enemy operatives have been incapacitated. */
export function killGradeFor(startingSize: number, incapacitated: number): number {
  if (startingSize <= 0) return 0;
  const thresholds = killGradeThresholds(startingSize);
  let grade = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (incapacitated >= (thresholds[i] ?? Infinity)) grade = i + 1;
  }
  return Math.min(grade, MAX_KILL_GRADE);
}
