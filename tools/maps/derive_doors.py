#!/usr/bin/env python3
"""Fill in the Volkus doors `_volkus_doors` failed to read off the cards.

    python3 tools/maps/derive_doors.py            # rewrite data/maps/volkus/*.json in place
    python3 tools/maps/derive_doors.py --check    # exit 1 if any door is missing (CI gate)

Idempotent: a feature that already carries a door part is left alone, and re-running after a
rewrite is a no-op. See `tools/maps/doors.py` for how a door is recovered from the wall ring
and why it has to be, and `docs/MAPS.md` for the QA table.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import doors as D  # noqa: E402
import terrain as T  # noqa: E402

MAPS = 'data/maps/volkus/*.json'


def door_spec(kind):
    """The `door` part of the piece catalogue — its types, heights and flags."""
    for part in T.PIECES[kind]['parts']:
        if part.get('role') == 'door':
            return part
    return None


def collect(paths):
    docs, instances = {}, []
    for path in paths:
        with open(path) as fh:
            docs[path] = json.load(fh)
        for feat in docs[path]['features']:
            if feat['kind'] not in D.DOOR_KINDS:
                continue
            walls = [p['poly'] for p in feat['parts'] if p.get('role') == 'wall']
            if not walls:
                continue
            instances.append(dict(id=feat['id'], kind=feat['kind'],
                                  placement=feat['placement'], walls=walls,
                                  path=path, feature=feat))
    return docs, instances


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true',
                    help='report missing doors and exit 1 instead of writing')
    args = ap.parse_args()

    paths = sorted(glob.glob(MAPS))
    if not paths:
        print(f'no maps matched {MAPS}', file=sys.stderr)
        return 1
    docs, instances = collect(paths)
    resolved, how = D.derive_doors(instances)

    missing, added, kept, cleared = [], [], 0, []
    touched = set()
    for inst in instances:
        feat = inst['feature']
        existing = next((p for p in feat['parts'] if p.get('role') == 'door'), None)
        # Whether the door came off the card or was derived, a wall bar left floating inside
        # the opening plugs it. Drop those, then renumber.
        box_for_clean = D._bbox(existing['poly']) if existing else resolved.get(inst['id'])
        if box_for_clean is not None:
            wall_parts = [p for p in feat['parts'] if p.get('role') == 'wall']
            overlap = D.clip_walls_out_of_doorway(box_for_clean, [p['poly'] for p in wall_parts])
            if overlap:
                if args.check:
                    missing.append('%s (wall overlaps the doorway)' % inst['id'])
                else:
                    rebuilt = []
                    for p in feat['parts']:
                        if p.get('role') != 'wall' or p not in wall_parts:
                            rebuilt.append(p)
                            continue
                        pieces = overlap.get(wall_parts.index(p))
                        if pieces is None:
                            rebuilt.append(p)
                            continue
                        for rect in pieces:
                            rebuilt.append({**p, 'poly': D.rect_poly(rect)})
                    feat['parts'] = rebuilt
                    for i, p in enumerate(feat['parts']):
                        p['id'] = f"{feat['id']}.p{i}"
                    cleared.append((inst['id'], len(overlap)))
                    touched.add(inst['path'])
        if existing is not None:
            kept += 1
            continue
        box = resolved.get(inst['id'])
        if box is None:
            missing.append(inst['id'])
            continue
        if args.check:
            missing.append(inst['id'])
            continue
        spec = door_spec(inst['kind'])
        if spec is None:
            missing.append(inst['id'])
            continue
        walls = [p for p in feat['parts'] if p.get('role') == 'wall']
        part = {
            'id': '',  # renumbered below
            'featureId': feat['id'],
            'poly': D.rect_poly(box),
            'z0': float(spec['z0']),
            'z1': float(spec['z1']),
            'types': list(spec['types']),
            'role': 'door',
            'blocksVisibility': bool(spec.get('blocksVisibility', True)),
            'standable': bool(spec.get('standable', False)),
            'solid': bool(spec.get('solid', False)),
        }
        # The piece catalogue orders parts wall, door, floor; keep the shipped data in the
        # order a re-extraction would produce, then renumber so ids stay dense.
        feat['parts'].insert(len(walls), part)
        for i, p in enumerate(feat['parts']):
            p['id'] = f"{feat['id']}.p{i}"
        added.append((inst['id'], how.get(inst['id'], '?')))
        touched.add(inst['path'])

    if args.check:
        if missing:
            print(f'{len(missing)} Volkus feature(s) have no door part: ' + ', '.join(missing),
                  file=sys.stderr)
            return 1
        print(f'all {len(instances)} stronghold / large ruin features carry a door')
        return 0

    for path in sorted(touched):
        with open(path, 'w') as fh:
            json.dump(docs[path], fh, indent=1)
            fh.write('\n')

    for fid, tag in added:
        print(f'  + {fid:12} door recovered from the wall {tag}')
    for fid, n in cleared:
        print(f'  - {fid:12} {n} wall part(s) clipped out of the doorway')
    print(f'{len(added)} door(s) added, {kept} already present, {len(cleared)} doorway(s) '
          f'cleared, {len(missing)} unresolved across {len(touched)} map(s)')
    return 1 if missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
