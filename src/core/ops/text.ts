/**
 * The printed op text, loaded from `data/ops/*.json` (bundled at build time — the core
 * never fetches anything). Mechanics live in the op modules; only text + parameters here.
 */
import critOpsData from '../../../data/ops/crit-ops.json';
import tacOpsData from '../../../data/ops/tac-ops.json';
import killOpData from '../../../data/ops/kill-op.json';
import initiativeCardData from '../../../data/ops/initiative-cards.json';

export interface PrintedAction {
  id: string;
  name: string;
  ap: number;
  text: string;
}

export interface PrintedOp {
  id: string;
  name: string;
  number?: number;
  archetype?: string;
  reveal?: string;
  additional?: string;
  actions?: PrintedAction[];
  vp: string;
  perTPCap?: number;
  tokens?: string[];
}

export interface PrintedCard {
  id: string;
  name: string;
  kind: string;
  magnitude?: number;
  text: string;
}

const critOps = critOpsData as unknown as {
  tournamentGroups: { id: string; label: string; ops: string[] }[];
  ops: PrintedOp[];
};
const tacOps = tacOpsData as unknown as { archetypes: string[]; ops: PrintedOp[] };
const killOp = killOpData as unknown as {
  id: string;
  name: string;
  text: string;
  maxGrade: number;
  table: Record<string, number[]>;
  extrapolation: string;
};
const initiativeCards = initiativeCardData as unknown as {
  rules: string;
  cards: PrintedCard[];
  cardForTurningPoint: Record<string, string>;
};

export const CRIT_OP_TEXT: PrintedOp[] = critOps.ops;
export const TAC_OP_TEXT: PrintedOp[] = tacOps.ops;
export const KILL_OP_TEXT = killOp;
export const INITIATIVE_CARD_TEXT = initiativeCards;
export const ARCHETYPES: string[] = tacOps.archetypes;

/** Tournament companion groupings — "organisers can select one from each of these groupings". */
export const CRIT_OP_GROUPS = critOps.tournamentGroups;

export function printedOp(id: string): PrintedOp {
  const found = [...CRIT_OP_TEXT, ...TAC_OP_TEXT].find((o) => o.id === id);
  if (!found) throw new Error(`No printed text for op '${id}' — data/ops/*.json and src/core/ops/* disagree.`);
  return found;
}

/** The full card text, assembled in the printed order (reveal → additional → actions → VP). */
export function opText(id: string): string {
  const op = printedOp(id);
  const parts: string[] = [];
  if (op.reveal) parts.push(`REVEAL: ${op.reveal}`);
  if (op.additional) parts.push(`ADDITIONAL RULES: ${op.additional}`);
  for (const a of op.actions ?? []) parts.push(`${a.name.toUpperCase()} ${a.ap}AP: ${a.text}`);
  parts.push(`VICTORY POINTS: ${op.vp}`);
  return parts.join('\n\n');
}

export function printedAction(opId: string, actionId: string): PrintedAction {
  const found = (printedOp(opId).actions ?? []).find((a) => a.id === actionId);
  if (!found) throw new Error(`Op '${opId}' has no printed action '${actionId}'.`);
  return found;
}
