#!/usr/bin/env python3
"""Scratch crop/zoom helper (not part of the deliverable pipeline)."""
import sys
from PIL import Image

p, x0, y0, x1, y1 = sys.argv[1], *[int(v) for v in sys.argv[2:6]]
scale = int(sys.argv[6]) if len(sys.argv) > 6 else 4
out = sys.argv[7] if len(sys.argv) > 7 else '/tmp/crop.png'
im = Image.open(p).convert('RGB').crop((x0, y0, x1, y1))
im = im.resize((im.width*scale, im.height*scale), Image.NEAREST)
im.save(out)
print(out, im.size)
