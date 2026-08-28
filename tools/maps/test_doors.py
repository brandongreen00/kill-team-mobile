#!/usr/bin/env python3
"""Pins `tools/maps/doors.py` against the doors the card extractor DID read.

    python3 tools/maps/test_doors.py

The derivation only earns trust if, told nothing but the wall geometry, it reproduces the six
Stronghold B doors `_volkus_doors` found on the cards. It does — exactly, to the rounding of
the stored polygons — and that is what makes the eighteen it recovers elsewhere credible.
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import doors as D  # noqa: E402

FAILURES = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  -- ' + detail))
    if not ok:
        FAILURES.append(name)


def load():
    """Every stronghold / large ruin instance in the shipped Volkus maps."""
    instances, extracted = [], {}
    for path in sorted(glob.glob(os.path.join(ROOT, 'data/maps/volkus/*.json'))):
        with open(path) as fh:
            doc = json.load(fh)
        for feat in doc['features']:
            if feat['kind'] not in D.DOOR_KINDS:
                continue
            walls = [p['poly'] for p in feat['parts'] if p.get('role') == 'wall']
            instances.append(dict(id=feat['id'], kind=feat['kind'],
                                  placement=feat['placement'], walls=walls))
            for p in feat['parts']:
                if p.get('role') == 'door':
                    extracted[feat['id']] = D._bbox(p['poly'])
    return instances, extracted


def test_reproduces_the_extracted_doors():
    """Given only walls, the derivation lands on the doors read off the cards."""
    instances, extracted = load()
    # Stronghold B is the one piece `_volkus_doors` resolves, on all six maps.
    known = {k: v for k, v in extracted.items() if k.endswith('.B')}
    check('the card extractor found six Stronghold B doors', len(known) == 6, str(len(known)))
    resolved, _how = D.derive_doors(instances)
    for fid, want in sorted(known.items()):
        got = resolved.get(fid)
        err = max(abs(got[i] - want[i]) for i in range(4)) if got else float('inf')
        check('%s is derived where the card put it' % fid, err < 0.02, 'max error %.4f' % err)


def test_every_piece_with_a_door_resolves_one():
    """Killzones: the stronghold and large ruin doors are Accessible and Heavy terrain."""
    instances, _ = load()
    resolved, how = D.derive_doors(instances)
    unresolved = [i['id'] for i in instances if i['id'] not in resolved]
    check('all %d door-bearing features resolve' % len(instances), not unresolved, str(unresolved))
    # A physical piece has one door of one width; a wildly different width means the ring
    # gap that was picked is a tracing artefact, not the doorway.
    widths = {}
    for inst in instances:
        box = resolved.get(inst['id'])
        if not box:
            continue
        # the opening, not the wall thickness
        widths.setdefault(inst['kind'], []).append(max(box[2] - box[0], box[3] - box[1]))
    for kind, w in sorted(widths.items()):
        spread = max(w) - min(w)
        check('%s door width is consistent across instances (%.2f")' % (kind, sum(w) / len(w)),
              spread <= D.WIDTH_TOL, 'spread %.3f' % spread)
    check('the fallback was needed at most once', sum(1 for v in how.values() if v == 'consensus') <= 1,
          str([k for k, v in how.items() if v == 'consensus']))


def test_shipped_data_carries_every_door():
    """The committed maps, not just the derivation, must have the doors."""
    missing = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'data/maps/volkus/*.json'))):
        with open(path) as fh:
            doc = json.load(fh)
        for feat in doc['features']:
            if feat['kind'] not in D.DOOR_KINDS:
                continue
            n = sum(1 for p in feat['parts'] if p.get('role') == 'door')
            if n != 1:
                missing.append('%s has %d' % (feat['id'], n))
    check('every shipped stronghold / large ruin has exactly one door', not missing, str(missing))


def test_doors_are_accessible_and_heavy():
    """Killzones: "The door is Accessible and Heavy terrain.\""""
    bad = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'data/maps/volkus/*.json'))):
        with open(path) as fh:
            doc = json.load(fh)
        for feat in doc['features']:
            for p in feat['parts']:
                if p.get('role') != 'door':
                    continue
                types = set(p.get('types', []))
                if types != {'Accessible', 'Heavy'} or p.get('solid') is not False:
                    bad.append('%s %s solid=%s' % (p['id'], sorted(types), p.get('solid')))
    check('every door is Accessible + Heavy and not solid', not bad, str(bad))


if __name__ == '__main__':
    for t in (test_reproduces_the_extracted_doors, test_every_piece_with_a_door_resolves_one,
              test_shipped_data_carries_every_door, test_doors_are_accessible_and_heavy):
        print(t.__name__)
        t()
    print()
    if FAILURES:
        print('%d failure(s)' % len(FAILURES))
        raise SystemExit(1)
    print('all door checks passed')
