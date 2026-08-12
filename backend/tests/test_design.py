"""Design conformance — the claim under test is that structure survives
rasterisation while pixels do not."""
import pytest

from app.modules.design import (
    conform, palette, palette_conformance, projection_profile, regions, spacing,
)
from app.modules.visual import Image, compare

WHITE = (255, 255, 255)
BRAND = (255, 107, 0)
INK = (17, 17, 17)


def canvas(w, h, fill=WHITE):
    return [fill] * (w * h)


def paint(px, w, x, y, bw, bh, colour):
    for yy in range(y, y + bh):
        for xx in range(x, x + bw):
            px[yy * w + xx] = colour
    return px


def test_rasterizers_disagree_on_identical_intent():
    """The measurement behind this module's premise: the SAME black-on-white
    edge, rendered by two engines, differs on a quarter of its pixels."""
    def row(vals):
        return tuple((v, v, v) for v in vals)
    figma = Image(8, 1, row([255, 255, 255, 128, 0, 0, 0, 0]))
    chrome = Image(8, 1, row([255, 255, 255, 140, 10, 0, 0, 0]))
    assert compare(figma, chrome, tolerance=0.0).pixel_ratio == pytest.approx(0.25)
    assert compare(figma, chrome, tolerance=2.0).pixel_ratio == pytest.approx(0.125)


# --- palette -----------------------------------------------------------------

def test_palette_is_exact_and_counted():
    px = paint(canvas(10, 10), 10, 0, 0, 4, 5, BRAND)   # 20 px of brand
    img = Image(10, 10, tuple(px))
    p = palette(img)
    assert [e.colour for e in p] == [WHITE, BRAND]
    assert [e.pixels for e in p] == [80, 20]
    assert p[1].share == pytest.approx(0.2)
    assert p[1].hex == "#FF6B00"


def test_palette_has_no_quantisation():
    """Two colours one unit apart stay two colours — nothing is binned away."""
    px = canvas(4, 1, (10, 10, 10))
    px[0] = (10, 10, 11)
    assert len(palette(Image(4, 1, tuple(px)))) == 2


def test_exact_conformance_demands_the_exact_token():
    design = Image(4, 4, tuple(canvas(4, 4, BRAND)))
    same = Image(4, 4, tuple(canvas(4, 4, BRAND)))
    off_by_one = Image(4, 4, tuple(canvas(4, 4, (255, 107, 1))))
    assert palette_conformance(design, same)[0].exact
    m = palette_conformance(design, off_by_one)[0]
    assert not m.present and not m.exact       # tolerance 0 refuses it


def test_tolerance_accepts_a_near_colour_and_reports_its_distance():
    design = Image(4, 4, tuple(canvas(4, 4, BRAND)))
    near = Image(4, 4, tuple(canvas(4, 4, (255, 109, 4))))
    m = palette_conformance(design, near, tolerance=2.0)[0]
    assert m.present and not m.exact
    assert 0 < m.delta_e <= 2.0
    assert m.found == (255, 109, 4)


def test_a_missing_brand_colour_is_reported_missing():
    design = Image(8, 8, tuple(paint(canvas(8, 8), 8, 1, 1, 4, 4, BRAND)))
    impl = Image(8, 8, tuple(paint(canvas(8, 8), 8, 1, 1, 4, 4, (0, 90, 255))))
    missing = [m for m in palette_conformance(design, impl, tolerance=2.0)
               if not m.present]
    assert BRAND in [m.expected for m in missing]


# --- structure ---------------------------------------------------------------

def test_regions_recover_the_boxes():
    px = canvas(40, 20)
    paint(px, 40, 4, 4, 12, 6, BRAND)
    paint(px, 40, 24, 4, 10, 6, INK)
    found = regions(Image(40, 20, tuple(px)), min_pixels=16, ignore=(WHITE,))
    boxes = sorted(r.box for r in found)
    assert boxes == [(4, 4, 12, 6), (24, 4, 10, 6)]
    assert all(r.fill_ratio == 1.0 for r in found)


def test_projection_profile_finds_the_gridlines_and_the_spacing():
    px = canvas(60, 10)
    for x in (10, 25, 40):                       # three vertical dividers
        paint(px, 60, x, 0, 1, 10, INK)
    prof = projection_profile(Image(60, 10, tuple(px)))
    lines = prof.gridlines("column")
    assert lines == (10, 25, 40)
    assert spacing(lines) == (15, 15)


def test_conformance_passes_on_an_identical_implementation():
    px = paint(canvas(40, 20), 40, 4, 4, 12, 6, BRAND)
    design = Image(40, 20, tuple(px))
    impl = Image(40, 20, tuple(px))
    c = conform(design, impl)
    assert c.colour_score == 1.0 and c.box_score == 1.0
    assert c.design_regions == c.impl_regions


def test_conformance_catches_a_two_pixel_shift_at_zero_tolerance():
    design = Image(40, 20, tuple(paint(canvas(40, 20), 40, 4, 4, 12, 6, BRAND)))
    shifted = Image(40, 20, tuple(paint(canvas(40, 20), 40, 6, 4, 12, 6, BRAND)))
    c = conform(design, shifted, box_tolerance=0)
    assert c.box_score < 1.0
    _, found, dist = next(m for m in c.box_matches if m[0].colour == BRAND)
    assert found is None and dist == 2          # and it says HOW far off
    # a stated 2px tolerance accepts it — a decision, not an accident
    assert conform(design, shifted, box_tolerance=2).box_score == 1.0


def test_conformance_catches_a_wrong_size():
    design = Image(40, 20, tuple(paint(canvas(40, 20), 40, 4, 4, 12, 6, BRAND)))
    fat = Image(40, 20, tuple(paint(canvas(40, 20), 40, 4, 4, 16, 6, BRAND)))
    c = conform(design, fat, box_tolerance=0)
    assert c.box_score < 1.0


def test_conformance_refuses_mismatched_capture_geometry():
    with pytest.raises(ValueError, match="do not resample"):
        conform(Image(4, 4, tuple(canvas(4, 4))), Image(5, 4, tuple(canvas(5, 4))))


def test_structure_survives_a_rasterisation_difference_that_pixels_do_not():
    """The whole point: soften every edge by one pixel, as a renderer would.
    A pixel diff calls that a failure; the structural comparison does not."""
    px = paint(canvas(40, 20), 40, 8, 5, 16, 8, BRAND)
    design = Image(40, 20, tuple(px))
    soft = list(px)
    for x in range(8, 24):                       # antialias the top and bottom edges
        soft[4 * 40 + x] = (255, 181, 128)
        soft[13 * 40 + x] = (255, 181, 128)
    impl = Image(40, 20, tuple(soft))
    assert compare(design, impl, tolerance=0.0).different == 32     # pixels: differs
    c = conform(design, impl, box_tolerance=0, min_region_pixels=64)
    assert c.box_score == 1.0                                       # structure: matches
    assert c.colour_score == 1.0
