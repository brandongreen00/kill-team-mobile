/**
 * Killzone browser: a contact sheet of all 24 Approved Ops layouts, grouped by killzone,
 * each drawn from the extracted geometry so what you pick is exactly what you play on.
 *
 * The source card PNGs are deliberately NOT bundled — they are Games Workshop artwork and
 * the repository is public. `docs/maps/overlays/*.png` holds the extraction overlays for
 * anyone verifying the geometry locally against their own copy of the cards.
 */
import { Board } from './Board.tsx';
import { createBattle } from '../core/init.ts';
import type { GameContext } from '../core/context.ts';
import type { KillzoneId, KillzoneMap } from '../core/types.ts';

const KILLZONE_LABEL: Record<KillzoneId, string> = {
  volkus: 'Volkus',
  'bheta-decima': 'Bheta-Decima',
  gallowdark: 'Gallowdark',
  'tomb-world': 'Tomb World',
};

export interface MapBrowserProps {
  ctx: GameContext;
  maps: KillzoneMap[];
  selectedId?: string;
  onPick: (map: KillzoneMap) => void;
}

export function MapBrowser({ ctx, maps, selectedId, onPick }: MapBrowserProps) {
  if (maps.length === 0) {
    return (
      <section class="card">
        <h2>Killzones</h2>
        <p class="muted">
          No killzone data. Run <code>pnpm maps:extract</code> to generate <code>data/maps</code> from
          the official Approved Ops card PNGs.
        </p>
      </section>
    );
  }

  const groups = (['volkus', 'bheta-decima', 'gallowdark', 'tomb-world'] as KillzoneId[])
    .map((kz) => ({ kz, list: maps.filter((m) => m.killzone === kz) }))
    .filter((g) => g.list.length > 0);

  return (
    <section class="card">
      <h2>Killzones</h2>
      {groups.map(({ kz, list }) => (
        <div key={kz} style={{ marginBottom: 12 }}>
          <p class="muted" style={{ margin: '4px 0' }}>
            {KILLZONE_LABEL[kz]} · {list.length} layouts
            {list[0]?.closeQuarters ? ' · Close Quarters' : ''}
          </p>
          <div class="contact-sheet">
            {list.map((m) => (
              <button
                key={m.id}
                class={`thumb${selectedId === m.id ? ' thumb-selected' : ''}`}
                onClick={() => onPick(m)}
                aria-pressed={selectedId === m.id}
                title={`${m.name} — ${m.features.length} terrain features`}
              >
                <Board
                  state={createBattle(ctx, { map: m, seed: 1, mode: 'sandbox' })}
                  showGrid={false}
                  showZones={true}
                />
                <span class="thumb-label">{m.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <p class="muted">
        Geometry is extracted from the official cards by <code>tools/maps/extract_cards.py</code>;
        per-map QA numbers are in <code>docs/MAPS.md</code> and overlays in
        <code> docs/maps/overlays/</code>. The card images themselves are not redistributed.
      </p>
    </section>
  );
}
