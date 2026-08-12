"""Design conformance — comparing a design export to an implementation.

The naive approach, diffing a Figma PNG against a browser screenshot pixel by
pixel, cannot reach 100% and never will: the two images come out of different
rasterizers. A single antialiased edge of an IDENTICAL design differs on ~25% of
its pixels (`tests/test_design.py::test_rasterizers_disagree_on_identical_intent`
measures it). Every "97% match" score from such a tool is that noise, and the
3% that matters is buried inside it.

So this module does not compare pixels. It extracts, exactly, the properties a
design actually specifies — which colours, in what proportion, arranged in what
boxes, on what spacing rhythm — and compares those. Extraction is integer
arithmetic over a lossless raster, so it is reproducible to the bit; the
comparison is then a set and interval comparison, where "exact" is a statement
with content:

* `palette` returns every distinct colour and its exact pixel count. No
  quantisation, no clustering, no sampling.
* `palette_conformance` answers, per design colour, "is this colour present in
  the implementation" — exactly at tolerance 0, or within a stated CIEDE2000
  radius above it.
* `regions` and `projection_profile` recover structure (boxes, gridlines,
  spacing) from flat colour, which is exactly the part of a design that survives
  rasterisation unchanged.

What still cannot be exact is glyph rasterisation. Text is therefore never
compared as pixels here; it is compared as the box it occupies and the colours
it uses. Verifying the typography itself needs the design's own numbers (font,
size, weight, letter-spacing) against `getComputedStyle` — data, not images —
which is the design-token track described in docs/VISUAL_UI_TESTING_PLAN.md.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from .visual import Image, contrast_ratio, delta_e_2000, srgb_to_lab

RGB = tuple[int, int, int]


# --- palette ----------------------------------------------------------------

@dataclass(frozen=True)
class PaletteEntry:
    colour: RGB
    pixels: int
    share: float          # fraction of the image, exact to float division

    @property
    def hex(self) -> str:
        return "#%02X%02X%02X" % self.colour


def palette(img: Image, *, min_share: float = 0.0) -> list[PaletteEntry]:
    """Every distinct colour, most common first. Exact — nothing is binned."""
    counts = Counter(img.pixels)
    total = len(img.pixels)
    out = [PaletteEntry(c, n, n / total) for c, n in counts.most_common()]
    return [e for e in out if e.share >= min_share]


@dataclass(frozen=True)
class ColourMatch:
    expected: RGB
    found: RGB | None
    delta_e: float
    exact: bool
    pixels: int

    @property
    def present(self) -> bool:
        return self.found is not None


def palette_conformance(design: Image, impl: Image, *,
                        tolerance: float = 0.0,
                        min_share: float = 0.0005) -> list[ColourMatch]:
    """For each design colour, the nearest implementation colour.

    tolerance 0.0 demands the exact byte triple — the only honest reading of
    "the button is #FF6B00". Above zero, the nearest colour within that CIEDE2000
    radius counts as present, which is what you want when the implementation
    blends the token against a background.
    """
    impl_palette = palette(impl)
    impl_labs = [(e.colour, srgb_to_lab(*e.colour), e.pixels) for e in impl_palette]
    exact_index = {e.colour: e.pixels for e in impl_palette}

    matches: list[ColourMatch] = []
    for entry in palette(design, min_share=min_share):
        if entry.colour in exact_index:
            matches.append(ColourMatch(entry.colour, entry.colour, 0.0, True,
                                       exact_index[entry.colour]))
            continue
        if tolerance <= 0.0:
            matches.append(ColourMatch(entry.colour, None, float("inf"), False, 0))
            continue
        want = srgb_to_lab(*entry.colour)
        best, best_de, best_px = None, float("inf"), 0
        for colour, lab, px in impl_labs:
            de = delta_e_2000(want, lab)
            if de < best_de:
                best, best_de, best_px = colour, de, px
        if best is not None and best_de <= tolerance:
            matches.append(ColourMatch(entry.colour, best, best_de, False, best_px))
        else:
            matches.append(ColourMatch(entry.colour, None, best_de, False, 0))
    return matches


# --- structure --------------------------------------------------------------

@dataclass
class Region:
    """A maximal connected run of one exact colour — a fill, a bar, a card."""
    colour: RGB
    x: int
    y: int
    width: int
    height: int
    pixels: int

    @property
    def box(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.width, self.height)

    @property
    def fill_ratio(self) -> float:
        """1.0 for a solid rectangle; lower for an L-shape or a ring."""
        area = self.width * self.height
        return self.pixels / area if area else 0.0


def regions(img: Image, *, min_pixels: int = 16,
            ignore: tuple[RGB, ...] = ()) -> list[Region]:
    """Connected components of identical colour, largest first.

    This is the part of a design that rasterisation cannot smear: a flat fill is
    the same bytes in Figma and in Chrome. Antialiased borders form their own
    thin components and fall below min_pixels, which is why the boxes recovered
    here are stable across renderers.
    """
    w, h = img.width, img.height
    seen = [False] * (w * h)
    out: list[Region] = []
    for start in range(w * h):
        if seen[start]:
            continue
        colour = img.pixels[start]
        if colour in ignore:
            seen[start] = True
            continue
        stack = [start]
        seen[start] = True
        minx = maxx = start % w
        miny = maxy = start // w
        count = 0
        while stack:
            idx = stack.pop()
            count += 1
            x, y = idx % w, idx // w
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    n = ny * w + nx
                    if not seen[n] and img.pixels[n] == colour:
                        seen[n] = True
                        stack.append(n)
        if count >= min_pixels:
            out.append(Region(colour, minx, miny, maxx - minx + 1, maxy - miny + 1, count))
    out.sort(key=lambda r: r.pixels, reverse=True)
    return out


@dataclass
class Profile:
    """Per-row and per-column change counts — the layout rhythm as numbers."""
    rows: tuple[int, ...]
    columns: tuple[int, ...]

    def gridlines(self, axis: str, *, threshold: float = 0.5) -> tuple[int, ...]:
        """Indices whose change count exceeds `threshold` x the maximum.

        A boundary between two flat areas — a card edge, a divider, a column gap —
        shows up as a spike. Recovering them turns "does the layout match" into a
        comparison of two integer lists.
        """
        series = self.rows if axis == "row" else self.columns
        if not series:
            return ()
        peak = max(series)
        if peak == 0:
            return ()
        cut = peak * threshold
        hits = [i for i, v in enumerate(series) if v >= cut]
        # A 1px divider produces an edge on each side; report the boundary once,
        # otherwise every measured gap alternates between the rule and its width.
        merged: list[int] = []
        for i in hits:
            if not merged or i - merged[-1] > 1:
                merged.append(i)
        return tuple(merged)


def projection_profile(img: Image) -> Profile:
    """Edge strength per column and per row.

    columns[x] counts the rows in which column x differs from column x-1, i.e.
    how much of a VERTICAL edge stands at x; rows[y] is the same for horizontal
    edges. Counting changes along a line instead would score a solid divider at
    zero — the line is uniform; the edge is beside it, not within it.
    """
    w, h = img.width, img.height
    cols = [0] * w
    for x in range(1, w):
        cols[x] = sum(1 for y in range(h) if img.at(x, y) != img.at(x - 1, y))
    rows = [0] * h
    for y in range(1, h):
        rows[y] = sum(1 for x in range(w) if img.at(x, y) != img.at(x, y - 1))
    return Profile(tuple(rows), tuple(cols))


def spacing(gridlines: tuple[int, ...]) -> tuple[int, ...]:
    """Gaps between consecutive gridlines — the spacing scale, as integers."""
    return tuple(b - a for a, b in zip(gridlines, gridlines[1:]))


# --- report -----------------------------------------------------------------

@dataclass
class Conformance:
    colours: list[ColourMatch] = field(default_factory=list)
    design_regions: int = 0
    impl_regions: int = 0
    box_matches: list[tuple[Region, Region | None, int]] = field(default_factory=list)

    @property
    def colours_present(self) -> int:
        return sum(1 for m in self.colours if m.present)

    @property
    def colour_score(self) -> float:
        return self.colours_present / len(self.colours) if self.colours else 1.0

    @property
    def boxes_matched(self) -> int:
        return sum(1 for _, found, _ in self.box_matches if found is not None)

    @property
    def box_score(self) -> float:
        return self.boxes_matched / len(self.box_matches) if self.box_matches else 1.0


def _box_distance(a: Region, b: Region) -> int:
    """Chebyshev distance between two boxes — the worst edge disagreement, in px."""
    return max(abs(a.x - b.x), abs(a.y - b.y),
               abs(a.width - b.width), abs(a.height - b.height))


def conform(design: Image, impl: Image, *,
            colour_tolerance: float = 0.0,
            box_tolerance: int = 0,
            min_region_pixels: int = 64,
            min_colour_share: float = 0.0005) -> Conformance:
    """Compare a design export to an implementation screenshot, structurally.

    box_tolerance is in pixels and 0 means exact: the implementation's box must
    start and end on the same pixel as the design's. That is achievable when both
    are captured at the same viewport and device pixel ratio, and it is the
    setting to keep — a non-zero tolerance is a decision to stop noticing drift
    smaller than that number.
    """
    if design.width != impl.width or design.height != impl.height:
        raise ValueError(
            f"capture geometry differs: {design.width}x{design.height} vs "
            f"{impl.width}x{impl.height} — compare like with like, do not resample")

    d_regions = regions(design, min_pixels=min_region_pixels)
    i_regions = regions(impl, min_pixels=min_region_pixels)

    used: set[int] = set()
    box_matches: list[tuple[Region, Region | None, int]] = []
    for d in d_regions:
        best_i, best_d = None, None
        for idx, cand in enumerate(i_regions):
            if idx in used:
                continue
            dist = _box_distance(d, cand)
            if best_d is None or dist < best_d:
                best_i, best_d = idx, dist
        if best_i is not None and best_d is not None and best_d <= box_tolerance:
            used.add(best_i)
            box_matches.append((d, i_regions[best_i], best_d))
        else:
            box_matches.append((d, None, best_d if best_d is not None else -1))

    return Conformance(
        colours=palette_conformance(design, impl, tolerance=colour_tolerance,
                                    min_share=min_colour_share),
        design_regions=len(d_regions),
        impl_regions=len(i_regions),
        box_matches=box_matches,
    )


# --- roles ------------------------------------------------------------------
# Contrast is a question about INK on a SURFACE. Asking it of every colour
# against the page background reports a card fill as a contrast failure, which
# is noise: nobody reads a card. Roles are therefore derived from the shape a
# colour makes, not assumed.

@dataclass(frozen=True)
class Role:
    colour: RGB
    pixels: int
    share: float
    solid_ratio: float        # fraction of this colour's pixels whose 4 neighbours match
    kind: str                 # "surface" | "ink"
    on_surface: RGB | None    # for ink: the surface it actually sits on
    contrast: float | None    # ink vs that surface, exact WCAG ratio

    @property
    def hex(self) -> str:
        return "#%02X%02X%02X" % self.colour

    def passes(self, *, large_text: bool = False) -> bool | None:
        """WCAG 2.x AA: 4.5:1 for body text, 3:1 for large text and UI shapes."""
        if self.contrast is None:
            return None
        return self.contrast >= (3.0 if large_text else 4.5)


def roles(img: Image, *, min_share: float = 0.002,
          solid_cut: float = 0.6) -> list[Role]:
    """Classify each significant colour as surface or ink, and pair ink with its background.

    A surface is a colour whose pixels are mostly interior — its four neighbours
    are the same colour. Glyph strokes and icon lines are thin, so most of their
    pixels touch something else; that single ratio separates the two without any
    model, and it is a property of the raster, so it is reproducible exactly.

    For ink, the surface underneath is the most frequent surface colour adjacent
    to its pixels — the background the text is actually read against, which is
    the only surface WCAG is asking about.
    """
    from collections import Counter as _Counter

    w, h = img.width, img.height
    total = w * h
    counts = _Counter(img.pixels)
    significant = {c for c, n in counts.items() if n / total >= min_share}

    solid = _Counter()
    neighbours: dict[RGB, _Counter] = {c: _Counter() for c in significant}
    px = img.pixels
    for y in range(h):
        row = y * w
        for x in range(w):
            c = px[row + x]
            if c not in significant:
                continue
            same = True
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    n = px[ny * w + nx]
                    if n != c:
                        same = False
                        neighbours[c][n] += 1
                else:
                    same = False
            if same:
                solid[c] += 1

    ratios = {c: solid[c] / counts[c] for c in significant}
    surfaces = {c for c in significant if ratios[c] >= solid_cut}

    out: list[Role] = []
    for c in sorted(significant, key=lambda k: -counts[k]):
        if c in surfaces:
            out.append(Role(c, counts[c], counts[c] / total, ratios[c],
                            "surface", None, None))
            continue
        under = None
        for cand, _ in neighbours[c].most_common():
            if cand in surfaces:
                under = cand
                break
        out.append(Role(
            c, counts[c], counts[c] / total, ratios[c], "ink", under,
            contrast_ratio(c, under) if under else None))
    return out


def _mix(a: RGB, b: RGB, t: float) -> RGB:
    """Composite b over a at opacity t, in LINEAR light — how a renderer blends."""
    from .visual import _linearize

    out = []
    for ca, cb in zip(a, b):
        lin = _linearize(ca) * (1.0 - t) + _linearize(cb) * t
        lin = max(0.0, min(1.0, lin))
        srgb = 12.92 * lin if lin <= 0.0031308 else 1.055 * (lin ** (1 / 2.4)) - 0.055
        out.append(max(0, min(255, round(srgb * 255))))
    return tuple(out)  # type: ignore[return-value]


def is_blend(colour: RGB, surface: RGB, candidates: list[RGB], *,
             tolerance: float = 1.5, steps: int = 32) -> RGB | None:
    """Is this colour just `surface` blended with one of `candidates`?

    An antialiased glyph edge and a semi-transparent divider are not design
    decisions — they are the renderer mixing two colours the design DID choose.
    Reporting them as low-contrast text buries the real findings under dozens of
    fringes, which is how an accessibility report becomes unreadable and then
    ignored.

    A blend is detectable exactly: composite the candidate over the surface in
    linear light and see whether any opacity reproduces the colour. Returns the
    candidate it blends towards, or None if the colour stands on its own.
    """
    from .visual import delta_e_2000, srgb_to_lab

    if colour == surface:
        return surface
    want = srgb_to_lab(*colour)
    for cand in candidates:
        if cand == surface:
            continue
        for i in range(1, steps):
            t = i / steps
            if delta_e_2000(want, srgb_to_lab(*_mix(surface, cand, t))) <= tolerance:
                return cand
    return None


def text_inks(img: Image, *, min_share: float = 0.0002,
              blend_tolerance: float = 1.5) -> list[Role]:
    """Ink colours that are a colour in their own right, not a rendering artefact.

    This is the list an accessibility report should show: every entry is a colour
    somebody chose, paired with the surface it is read on and its exact WCAG
    ratio. Fringes and blends are filtered out because a renderer produced them,
    not a designer.
    """
    all_roles = roles(img, min_share=min_share)
    surfaces = [r.colour for r in all_roles if r.kind == "surface"]
    inks = [r for r in all_roles if r.kind == "ink" and r.on_surface is not None]
    standalone = [r.colour for r in inks]
    out: list[Role] = []
    for r in inks:
        others = [c for c in standalone + surfaces if c != r.colour]
        if is_blend(r.colour, r.on_surface, others, tolerance=blend_tolerance) is None:
            out.append(r)
    return out
