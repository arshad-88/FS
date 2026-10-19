#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deprecated shim -> tools/gen_icons_from_art.py.

The launcher icons used to be drawn here from hand-tuned vector colours
(gradient plate + neon shield glyph). They are now rendered from the brand
artwork instead, so that there is exactly one source of truth for the icon:

    art/ic_launcher_source.png   (1254 x 1254 neon shield emblem)
        -> tools/gen_icons_from_art.py
        -> app/res/mipmap-*/ic_launcher[_round].png  (48..192 px)
        -> app/res/drawable-nodpi/ic_launcher_art.png (adaptive foreground)

This module is kept only so that older notes and scripts that call
``gen_launcher_icons.py`` keep working: it forwards the arguments to the art
renderer, which refuses to overwrite icons with anything but the brand art.

Usage (unchanged):
    python tools/gen_launcher_icons.py             # write every icon
    python tools/gen_launcher_icons.py --check     # verify only
    python tools/gen_launcher_icons.py --preview   # ASCII proof
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import gen_icons_from_art  # noqa: E402  (path set up just above)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    print(
        "[icons] gen_launcher_icons.py is deprecated - "
        "rendering from art/ic_launcher_source.png instead",
        file=sys.stderr,
    )
    return gen_icons_from_art.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
