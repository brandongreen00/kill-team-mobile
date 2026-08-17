/**
 * Every module-level cache in the AI, in one place.
 *
 * The caches are keyed by things that REPEAT across battles — operative ids (`p1-0`),
 * datacard ids, map ids, board positions — so a stale entry from a previous game can silently
 * answer a query in the next one. Keys carry a map/datacard fingerprint to make that
 * impossible in principle, and `resetAiCaches()` drops everything at the start of each game
 * so it is impossible in practice too. `playGame` calls it; anything else that plays more
 * than one battle in a process should as well.
 */
import { clearValueCache } from './combat.ts';
import { clearDeployCache } from './deploy.ts';
import { clearThreatCache } from './eval.ts';
import { clearMoveCache } from './moves.ts';

export function resetAiCaches(): void {
  clearMoveCache();
  clearDeployCache();
  clearValueCache();
  clearThreatCache();
}
