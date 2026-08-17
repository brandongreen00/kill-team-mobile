#!/usr/bin/env python3
"""Scratch probe (not part of the deliverable pipeline)."""
import sys, numpy as np
from PIL import Image

p = sys.argv[1]
a = np.array(Image.open(p).convert('RGB')).astype(int)
H, W, _ = a.shape
print('size', W, H)

# find the white page background vs board: board interior = non-white
nonwhite = (a.sum(2) < 720)
cols = nonwhite.sum(0); rows = nonwhite.sum(1)
xs = np.where(cols > H*0.5)[0]; ys = np.where(rows > W*0.5)[0]
print('dense cols', xs.min(), xs.max(), 'dense rows', ys.min(), ys.max())

# grid line detection: look for periodic darker lines within tint regions
def gridlines(axis):
    # difference from local median
    pass

# print row of pixels at some y
for y in [5, 10, 11, 12, 20, H//2]:
    print('y=%d' % y, [tuple(a[y, x]) for x in (0,5,10,11,12,20,W//2)])
for x in [5, 10, 11, 12, 20, W//2]:
    print('x=%d' % x, [tuple(a[y, x]) for y in (0,5,10,11,12,20,H//2)])
