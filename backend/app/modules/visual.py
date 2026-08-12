"""Visual comparison engine (V0) — colour analysis, no model in the loop.

Everything here is arithmetic on pixel arrays: the same two images always
produce the same verdict, on any machine, offline. That is what makes a visual
finding defensible — the diff is derived, not judged.

Exactness, precisely stated:

* The colour maths is exact to IEEE-754 double precision. `delta_e_2000` is
  verified against the CIE's own published test vectors (Sharma, Wu & Dalal —
  `tests/fixtures/ciede2000testdata.txt`, 34 pairs), which is the standard way
  an implementation proves it is correct rather than merely plausible.
* `compare(..., tolerance=0.0)` is EXACT comparison: a pixel counts as different
  if any channel differs by one unit. No heuristic can hide a change from it.
* Everything above tolerance 0 is a deliberate, documented trade: the perceptual
  thresholds and the anti-aliasing filter exist to suppress differences a human
  cannot see, and they are the only places accuracy is knowingly given up.

What no comparator can be exact about is whether a change is a DEFECT. That is a
judgement about intent, not a property of the pixels, and it stays with the
reviewer (BO-07's division of labour, applied to images).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# --- sRGB → CIE Lab ---------------------------------------------------------
# IEC 61966-2-1 transfer function, then the sRGB primaries matrix, then CIE
# 15:2004 Lab. Reference white is D65 as sRGB defines it.

_D65 = (0.95047, 1.00000, 1.08883)
_EPS = 216.0 / 24389.0      # (6/29)^3, the CIE standard values in exact rational form
_KAPPA = 24389.0 / 27.0     # (29/3)^3


def _linearize(channel: int) -> float:
    """8-bit sRGB channel → linear-light [0,1] (IEC 61966-2-1)."""
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb_to_xyz(r: int, g: int, b: int) -> tuple[float, float, float]:
    rl, gl, bl = _linearize(r), _linearize(g), _linearize(b)
    x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl
    y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl
    z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl
    return x, y, z


def _f(t: float) -> float:
    return t ** (1.0 / 3.0) if t > _EPS else (_KAPPA * t + 16.0) / 116.0


def srgb_to_lab(r: int, g: int, b: int) -> tuple[float, float, float]:
    x, y, z = srgb_to_xyz(r, g, b)
    fx, fy, fz = _f(x / _D65[0]), _f(y / _D65[1]), _f(z / _D65[2])
    return 116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)


# --- CIEDE2000 --------------------------------------------------------------

def delta_e_2000(lab1: tuple[float, float, float],
                 lab2: tuple[float, float, float]) -> float:
    """Perceptual colour difference, CIE 142-2001 (kL = kC = kH = 1).

    Verified against the CIE's published test vectors; see the module docstring.
    """
    l1, a1, b1 = lab1
    l2, a2, b2 = lab2

    c1 = math.hypot(a1, b1)
    c2 = math.hypot(a2, b2)
    c_bar = (c1 + c2) / 2.0
    c_bar7 = c_bar ** 7
    g = 0.5 * (1.0 - math.sqrt(c_bar7 / (c_bar7 + 25.0 ** 7)))

    a1p, a2p = (1.0 + g) * a1, (1.0 + g) * a2
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)

    def _hue(ap: float, bp: float) -> float:
        if ap == 0.0 and bp == 0.0:
            return 0.0
        h = math.degrees(math.atan2(bp, ap))
        return h + 360.0 if h < 0.0 else h

    h1p, h2p = _hue(a1p, b1), _hue(a2p, b2)

    dlp = l2 - l1
    dcp = c2p - c1p

    if c1p * c2p == 0.0:
        dhp = 0.0
    elif abs(h2p - h1p) <= 180.0:
        dhp = h2p - h1p
    elif h2p - h1p > 180.0:
        dhp = h2p - h1p - 360.0
    else:
        dhp = h2p - h1p + 360.0
    dHp = 2.0 * math.sqrt(c1p * c2p) * math.sin(math.radians(dhp) / 2.0)

    l_bar_p = (l1 + l2) / 2.0
    c_bar_p = (c1p + c2p) / 2.0

    if c1p * c2p == 0.0:
        h_bar_p = h1p + h2p
    elif abs(h1p - h2p) <= 180.0:
        h_bar_p = (h1p + h2p) / 2.0
    elif h1p + h2p < 360.0:
        h_bar_p = (h1p + h2p + 360.0) / 2.0
    else:
        h_bar_p = (h1p + h2p - 360.0) / 2.0

    t = (1.0
         - 0.17 * math.cos(math.radians(h_bar_p - 30.0))
         + 0.24 * math.cos(math.radians(2.0 * h_bar_p))
         + 0.32 * math.cos(math.radians(3.0 * h_bar_p + 6.0))
         - 0.20 * math.cos(math.radians(4.0 * h_bar_p - 63.0)))

    d_theta = 30.0 * math.exp(-(((h_bar_p - 275.0) / 25.0) ** 2))
    c_bar_p7 = c_bar_p ** 7
    rc = 2.0 * math.sqrt(c_bar_p7 / (c_bar_p7 + 25.0 ** 7))
    lb = (l_bar_p - 50.0) ** 2
    sl = 1.0 + (0.015 * lb) / math.sqrt(20.0 + lb)
    sc = 1.0 + 0.045 * c_bar_p
    sh = 1.0 + 0.015 * c_bar_p * t
    rt = -math.sin(math.radians(2.0 * d_theta)) * rc

    return math.sqrt(
        (dlp / sl) ** 2
        + (dcp / sc) ** 2
        + (dHp / sh) ** 2
        + rt * (dcp / sc) * (dHp / sh)
    )


# --- WCAG contrast (free, the luminance is already computed) ----------------

def relative_luminance(r: int, g: int, b: int) -> float:
    return 0.2126 * _linearize(r) + 0.7152 * _linearize(g) + 0.0722 * _linearize(b)


def contrast_ratio(fg: tuple[int, int, int], bg: tuple[int, int, int]) -> float:
    l1, l2 = relative_luminance(*fg), relative_luminance(*bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# --- Images -----------------------------------------------------------------

@dataclass(frozen=True)
class Image:
    """RGB raster. `pixels` is row-major, one (r,g,b) tuple per pixel."""
    width: int
    height: int
    pixels: tuple[tuple[int, int, int], ...]

    def at(self, x: int, y: int) -> tuple[int, int, int]:
        return self.pixels[y * self.width + x]


@dataclass
class Cluster:
    """A connected region of differing pixels — WHERE the change is."""
    x: int
    y: int
    width: int
    height: int
    pixels: int

    @property
    def area(self) -> int:
        return self.width * self.height


@dataclass
class Comparison:
    width: int
    height: int
    compared: int          # pixels actually compared (masked ones excluded)
    different: int
    max_delta_e: float
    mean_delta_e: float
    histogram_distance: float
    clusters: list[Cluster] = field(default_factory=list)
    diff_mask: tuple[bool, ...] = ()

    @property
    def pixel_ratio(self) -> float:
        return self.different / self.compared if self.compared else 0.0

    @property
    def identical(self) -> bool:
        return self.different == 0


def _in_masks(x: int, y: int, masks: tuple[tuple[int, int, int, int], ...]) -> bool:
    for mx, my, mw, mh in masks:
        if mx <= x < mx + mw and my <= y < my + mh:
            return True
    return False


def lab_histogram(img: Image, bins: int = 8,
                  masks: tuple[tuple[int, int, int, int], ...] = ()) -> list[float]:
    """Normalised 3-D Lab histogram.

    This is the measure that survives a one-pixel layout shift: a palette change
    moves it sharply while a reflow barely does, which is exactly the question a
    per-pixel diff cannot answer.
    """
    hist = [0.0] * (bins ** 3)
    total = 0
    for y in range(img.height):
        for x in range(img.width):
            if _in_masks(x, y, masks):
                continue
            l, a, b = srgb_to_lab(*img.at(x, y))
            li = min(bins - 1, max(0, int(l / 100.0 * bins)))
            ai = min(bins - 1, max(0, int((a + 128.0) / 255.0 * bins)))
            bi = min(bins - 1, max(0, int((b + 128.0) / 255.0 * bins)))
            hist[li * bins * bins + ai * bins + bi] += 1.0
            total += 1
    if total:
        hist = [h / total for h in hist]
    return hist


def histogram_distance(h1: list[float], h2: list[float]) -> float:
    """Chi-square distance in [0,1]: 0 identical, 1 disjoint."""
    total = 0.0
    for a, b in zip(h1, h2):
        s = a + b
        if s > 0.0:
            total += (a - b) ** 2 / s
    return total / 2.0


def _is_antialiasing(base: Image, other: Image, x: int, y: int, tolerance: float) -> bool:
    """A differing pixel whose neighbourhood mostly matches is an edge artefact.

    Text edges legitimately shift by a subpixel between renders; without this the
    suite drowns in differences no reviewer would call a change. It only ever
    applies above tolerance 0 — exact mode never suppresses anything.
    """
    close = 0
    checked = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx, ny = x + dx, y + dy
            if not (0 <= nx < base.width and 0 <= ny < base.height):
                continue
            checked += 1
            if delta_e_2000(srgb_to_lab(*base.at(nx, ny)),
                            srgb_to_lab(*other.at(nx, ny))) <= tolerance:
                close += 1
    return checked > 0 and close >= 2


def _clusters(mask: list[bool], width: int, height: int) -> list[Cluster]:
    """Connected components (8-neighbour), iterative so tall diffs cannot recurse away."""
    seen = [False] * len(mask)
    out: list[Cluster] = []
    for start in range(len(mask)):
        if not mask[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = True
        minx = maxx = start % width
        miny = maxy = start // width
        count = 0
        while stack:
            idx = stack.pop()
            count += 1
            x, y = idx % width, idx // width
            minx, maxx = min(minx, x), max(maxx, x)
            miny, maxy = min(miny, y), max(maxy, y)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        n = ny * width + nx
                        if mask[n] and not seen[n]:
                            seen[n] = True
                            stack.append(n)
        out.append(Cluster(minx, miny, maxx - minx + 1, maxy - miny + 1, count))
    out.sort(key=lambda c: c.pixels, reverse=True)
    return out


class SizeMismatch(ValueError):
    """Two images of different dimensions are not comparable.

    Resizing one to fit would invent pixels and make every later number a
    fiction, so this is refused rather than fudged.
    """


def compare(base: Image, other: Image, *, tolerance: float = 0.0,
            masks: tuple[tuple[int, int, int, int], ...] = (),
            suppress_antialiasing: bool = False,
            histogram_bins: int = 8) -> Comparison:
    """Compare two rasters.

    tolerance is a CIEDE2000 threshold. 0.0 means EXACT: any channel difference
    counts. Above 0 the comparison is deliberately perceptual — 1.0 is the
    just-noticeable difference, 2.0 the usual "visible side by side" line.
    """
    if base.width != other.width or base.height != other.height:
        raise SizeMismatch(
            f"{base.width}x{base.height} vs {other.width}x{other.height}")

    mask = [False] * (base.width * base.height)
    compared = 0
    different = 0
    max_de = 0.0
    sum_de = 0.0

    for y in range(base.height):
        for x in range(base.width):
            if _in_masks(x, y, masks):
                continue
            compared += 1
            p1, p2 = base.at(x, y), other.at(x, y)
            if p1 == p2:
                continue
            de = delta_e_2000(srgb_to_lab(*p1), srgb_to_lab(*p2))
            sum_de += de
            max_de = max(max_de, de)
            if tolerance <= 0.0 or de > tolerance:
                if suppress_antialiasing and tolerance > 0.0 and \
                        _is_antialiasing(base, other, x, y, tolerance):
                    continue
                mask[y * base.width + x] = True
                different += 1

    return Comparison(
        width=base.width,
        height=base.height,
        compared=compared,
        different=different,
        max_delta_e=max_de,
        mean_delta_e=sum_de / compared if compared else 0.0,
        histogram_distance=histogram_distance(
            lab_histogram(base, histogram_bins, masks),
            lab_histogram(other, histogram_bins, masks)),
        clusters=_clusters(mask, base.width, base.height),
        diff_mask=tuple(mask),
    )


# --- Verdict ----------------------------------------------------------------

@dataclass(frozen=True)
class Thresholds:
    """Zero everywhere is exact mode: any difference at all fails."""
    tolerance: float = 0.0
    max_pixel_ratio: float = 0.0
    max_cluster_pixels: int = 0
    max_histogram_distance: float = 0.0


def verdict(cmp: Comparison, th: Thresholds) -> tuple[str, list[str]]:
    """passed|failed plus the reasons — the verdict must always explain itself."""
    reasons: list[str] = []
    if cmp.pixel_ratio > th.max_pixel_ratio:
        reasons.append(
            f"pixel ratio {cmp.pixel_ratio:.6f} > {th.max_pixel_ratio:.6f} "
            f"({cmp.different}/{cmp.compared} pixels)")
    if cmp.clusters and cmp.clusters[0].pixels > th.max_cluster_pixels:
        c = cmp.clusters[0]
        reasons.append(
            f"largest cluster {c.pixels}px at ({c.x},{c.y}) {c.width}x{c.height} "
            f"> {th.max_cluster_pixels}")
    if cmp.histogram_distance > th.max_histogram_distance:
        reasons.append(
            f"palette distance {cmp.histogram_distance:.6f} > "
            f"{th.max_histogram_distance:.6f}")
    return ("failed" if reasons else "passed"), reasons
