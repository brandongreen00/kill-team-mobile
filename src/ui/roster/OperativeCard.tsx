/**
 * One selected operative: its printed stat line, the loadout choices its selection entry
 * offers, and the weapons it ends up with.
 *
 * The weapon list is split into what the selection option grants and what the operative
 * always has: **every datacard weapon that no selection option for that datacard names is
 * available anyway, including `Limited x` weapons** (the Navis Grenadier's demolition charge).
 * Those are shown as "always carried", never as a choice.
 */
import { alwaysAvailableWeapons } from '../../teams/selection.ts';
import {
  choiceGroups,
  isEitherEntry,
  loadoutModes,
  modeOfPick,
  weaponsOfPick,
  withChoice,
  withMode,
  type EntryRow,
  type RosterPickIn,
  type TeamData,
} from './rules.ts';
import type { Weapon, WeaponProfile } from '../../core/types.ts';

export interface OperativeCardProps {
  data: TeamData;
  row: EntryRow;
  pick: RosterPickIn;
  onChange?: (pick: RosterPickIn) => void;
  onRemove?: () => void;
}

export function baseLabel(card: { base: { shape: string; mm: number | [number, number] } }): string {
  const mm = card.base.mm;
  return Array.isArray(mm) ? `${mm[0]}×${mm[1]}mm oval` : `${mm}mm`;
}

export function profileLine(p: WeaponProfile): string {
  const rules = p.rules.map((r) => r.raw || (r.x === undefined ? r.id : `${r.id} ${r.x}`));
  const head = `${p.type} · A${p.atk} · ${p.hit}+ · ${p.dmgN}/${p.dmgC}`;
  return rules.length > 0 ? `${head} · ${rules.join(', ')}` : head;
}

export function costLabel(cost: number): string | null {
  if (cost === 1) return null;
  if (cost === 0.5) return 'half a selection';
  return `counts as ${cost === 2 ? 'two' : cost === 3 ? 'three' : cost} selections`;
}

export function OperativeCard({ data, row, pick, onChange, onRemove }: OperativeCardProps) {
  const { entry, card } = row;
  // "…with one of the following options: A; B. Or one option from each of the following:
  // (C or D) + (E or F)" is an either/or: pick the mode first, then that mode's options.
  const either = isEitherEntry(entry);
  const mode = modeOfPick(entry, pick) ?? 'options';
  const groups = choiceGroups(entry, mode);
  const chosen = new Set(pick.loadoutIds ?? []);
  const names = weaponsOfPick(data, pick);
  const always = new Set(
    [...entry.alwaysWeapons, ...(card ? alwaysAvailableWeapons(data, card) : [])].map((w) => w.toLowerCase()),
  );
  const weapons: Weapon[] = names
    .map((n) => card?.weapons.find((w) => w.name === n))
    .filter((w): w is Weapon => Boolean(w));
  const cost = costLabel(entry.selectionCost);

  return (
    <div class="op-card">
      <div class="row op-head">
        <strong>{entry.role}</strong>
        <span class="muted">{card?.name ?? entry.datacardId}</span>
        {cost && <span class="tag">{cost}</span>}
        {entry.isLeader && <span class="tag">LEADER</span>}
        <div class="spacer" />
        {onRemove && (
          <button class="op-remove" onClick={onRemove} aria-label={`Remove ${entry.role}`} title="Remove">
            ✕
          </button>
        )}
      </div>

      {card && (
        <div class="row op-stats">
          <span class="tag">APL {card.apl}</span>
          <span class="tag">MOVE {card.move}"</span>
          <span class="tag">SAVE {card.save}+</span>
          <span class="tag">WOUNDS {card.wounds}</span>
          <span class="tag">{baseLabel(card)}</span>
        </div>
      )}

      {either && (
        <label class="op-choice op-mode">
          <span class="muted">This operative is equipped with…</span>
          <select
            value={mode}
            aria-label={`${entry.role} loadout mode`}
            disabled={!onChange}
            onChange={(e) =>
              onChange?.(withMode(entry, pick, (e.target as HTMLSelectElement).value as 'options' | 'each'))
            }
          >
            {loadoutModes(entry).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {groups.map((g) => (
        <label key={g.id} class="op-choice">
          <span class="muted">{g.label}</span>
          <select
            value={g.choices.find((c) => chosen.has(c.id))?.id ?? ''}
            disabled={!onChange}
            onChange={(e) => onChange?.(withChoice(pick, g, (e.target as HTMLSelectElement).value))}
          >
            <option value="">— choose —</option>
            {g.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      <ul class="op-weapons">
        {weapons.map((w) => (
          <li key={w.name}>
            <span>{w.name}</span>
            {always.has(w.name.toLowerCase()) && <span class="tag">always carried</span>}
            {w.profiles.map((p, i) => (
              <div key={`${w.name}-${p.name ?? i}`} class="muted">
                {p.name ? `${p.name}: ` : ''}
                {profileLine(p)}
              </div>
            ))}
          </li>
        ))}
        {weapons.length === 0 && <li class="muted">No weapons resolved — choose this operative's option.</li>}
      </ul>
    </div>
  );
}
