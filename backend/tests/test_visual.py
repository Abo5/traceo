"""Visual comparison engine — exactness proven, not asserted.

The CIEDE2000 implementation is checked against the CIE's own published test
vectors (Sharma, Wu & Dalal 2005), which exist precisely because the formula has
several discontinuities that a plausible-looking implementation gets wrong.
"""
import math
from pathlib import Path

import pytest

from app.modules.visual import (
    Image, SizeMismatch, Thresholds, compare, contrast_ratio, delta_e_2000,
    histogram_distance, lab_histogram, relative_luminance, srgb_to_lab, verdict,
)

DATA = Path(__file__).parent / "fixtures" / "ciede2000testdata.txt"


def _reference_pairs():
    rows = []
    for line in DATA.read_text().splitlines():
        parts = line.split()
        if len(parts) < 7:
            continue
        try:
            nums = [float(p) for p in parts[:7]]
        except ValueError:
            continue  # header
        rows.append((tuple(nums[0:3]), tuple(nums[3:6]), nums[6]))
    return rows


def test_reference_data_is_present():
    pairs = _reference_pairs()
    assert len(pairs) >= 34, f"expected the full CIE vector set, got {len(pairs)}"


@pytest.mark.parametrize("lab1,lab2,expected", _reference_pairs())
def test_ciede2000_matches_the_published_vectors(lab1, lab2, expected):
    # The reference table is quoted to 4 decimals, so that is the achievable bar.
    assert delta_e_2000(lab1, lab2) == pytest.approx(expected, abs=5e-5)


def test_delta_e_is_zero_for_identical_colours():
    for lab in [(0, 0, 0), (100, 0, 0), (50, 2.6772, -79.7751), (32.1, -40.0, 88.8)]:
        assert delta_e_2000(lab, lab) == 0.0


def test_delta_e_is_symmetric():
    for lab1, lab2, _ in _reference_pairs():
        assert delta_e_2000(lab1, lab2) == pytest.approx(delta_e_2000(lab2, lab1), abs=1e-12)


def test_srgb_anchors():
    assert srgb_to_lab(255, 255, 255) == pytest.approx((100.0, 0.0, 0.0), abs=1e-3)
    assert srgb_to_lab(0, 0, 0) == pytest.approx((0.0, 0.0, 0.0), abs=1e-9)
    l, a, b = srgb_to_lab(255, 0, 0)
    assert (l, a, b) == pytest.approx((53.2408, 80.0925, 67.2032), abs=1e-3)


def test_wcag_contrast_anchors():
    assert contrast_ratio((0, 0, 0), (255, 255, 255)) == pytest.approx(21.0, abs=1e-9)
    assert contrast_ratio((255, 255, 255), (255, 255, 255)) == pytest.approx(1.0, abs=1e-9)
    assert relative_luminance(255, 255, 255) == pytest.approx(1.0, abs=1e-9)


# --- images ------------------------------------------------------------------

def img(w, h, fill=(255, 255, 255), overrides=None):
    px = [fill] * (w * h)
    for (x, y), c in (overrides or {}).items():
        px[y * w + x] = c
    return Image(w, h, tuple(px))


def test_identical_images_are_exactly_identical():
    a = img(8, 8, (12, 34, 56))
    c = compare(a, img(8, 8, (12, 34, 56)))
    assert c.identical and c.different == 0 and c.pixel_ratio == 0.0
    assert c.max_delta_e == 0.0 and c.histogram_distance == 0.0
    assert verdict(c, Thresholds())[0] == "passed"


def test_exact_mode_catches_a_single_unit_change():
    """A one-unit channel change is invisible to a human and to a ΔE threshold —
    exact mode must still see it, or "exact" means nothing."""
    a = img(4, 4, (100, 100, 100))
    b = img(4, 4, (100, 100, 100), {(2, 1): (100, 100, 101)})
    c = compare(a, b, tolerance=0.0)
    assert c.different == 1
    assert c.max_delta_e == pytest.approx(0.6372, abs=1e-3)  # under the JND
    assert verdict(c, Thresholds())[0] == "failed"
    # and a perceptual threshold deliberately lets it pass
    assert compare(a, b, tolerance=1.0).different == 0


def test_clusters_locate_the_change():
    overrides = {(x, y): (0, 0, 0) for x in range(3, 6) for y in range(2, 4)}
    c = compare(img(10, 10), img(10, 10, overrides=overrides))
    assert c.different == 6
    assert len(c.clusters) == 1
    cl = c.clusters[0]
    assert (cl.x, cl.y, cl.width, cl.height, cl.pixels) == (3, 2, 3, 2, 6)


def test_two_separate_changes_are_two_clusters():
    overrides = {(0, 0): (0, 0, 0), (9, 9): (0, 0, 0)}
    c = compare(img(10, 10), img(10, 10, overrides=overrides))
    assert len(c.clusters) == 2


def test_masked_regions_are_excluded_from_the_denominator():
    overrides = {(x, 0): (0, 0, 0) for x in range(4)}
    c = compare(img(4, 4), img(4, 4, overrides=overrides), masks=((0, 0, 4, 1),))
    assert c.different == 0 and c.compared == 12 and c.identical


def test_palette_change_moves_the_histogram_and_a_reflow_barely_does():
    base = img(16, 16, (250, 250, 250))
    palette = img(16, 16, (20, 20, 20))                       # every pixel recoloured
    shifted = img(16, 16, (250, 250, 250),
                  {(x, 0): (240, 240, 240) for x in range(16)})  # one row nudged
    d_palette = histogram_distance(lab_histogram(base), lab_histogram(palette))
    d_shift = histogram_distance(lab_histogram(base), lab_histogram(shifted))
    assert d_palette > 0.9
    assert d_shift < 0.1
    assert d_palette > d_shift * 5


def test_size_mismatch_is_refused_not_resized():
    with pytest.raises(SizeMismatch):
        compare(img(4, 4), img(5, 4))


def test_comparison_is_deterministic():
    a = img(12, 12, (33, 66, 99))
    b = img(12, 12, (33, 66, 99), {(3, 3): (34, 66, 99), (8, 9): (33, 67, 99)})
    first = compare(a, b, tolerance=0.5)
    for _ in range(5):
        again = compare(a, b, tolerance=0.5)
        assert (again.different, again.max_delta_e, again.mean_delta_e,
                again.histogram_distance, again.diff_mask) == (
               first.different, first.max_delta_e, first.mean_delta_e,
               first.histogram_distance, first.diff_mask)


def test_verdict_always_explains_itself():
    a = img(6, 6)
    b = img(6, 6, overrides={(1, 1): (0, 0, 0)})
    state, reasons = verdict(compare(a, b), Thresholds())
    assert state == "failed" and reasons
    assert any("pixel ratio" in r for r in reasons)


def test_antialiasing_suppression_only_applies_above_exact_mode():
    """An isolated changed pixel is a change; one surrounded by matches is an edge."""
    base = img(5, 5, (255, 255, 255))
    # dE00 ~= 0.396, so a 0.2 tolerance sees it and a 0.5 tolerance does not.
    edge = img(5, 5, (255, 255, 255), {(2, 2): (253, 253, 253)})
    assert compare(base, edge, tolerance=0.0, suppress_antialiasing=True).different == 1
    assert compare(base, edge, tolerance=0.2, suppress_antialiasing=True).different == 0
    assert compare(base, edge, tolerance=0.2, suppress_antialiasing=False).different == 1


# --- remediation --------------------------------------------------------------

from app.modules.visual import lab_to_srgb, nearest_accessible  # noqa: E402


def test_lab_round_trips_through_srgb():
    """The inverse must land back on the same byte, or a suggestion would drift."""
    for rgb in [(0, 0, 0), (255, 255, 255), (140, 140, 140), (60, 136, 76),
                (240, 144, 63), (92, 142, 220), (17, 17, 17)]:
        assert lab_to_srgb(srgb_to_lab(*rgb)) == rgb


def test_a_passing_colour_is_returned_untouched():
    r = nearest_accessible((0, 0, 0), (255, 255, 255))
    assert r.suggested == (0, 0, 0) and r.delta_e == 0.0
    assert r.ratio_after == pytest.approx(21.0, abs=1e-9)


def test_the_suggestion_reaches_the_target_and_no_further():
    """Overshooting would change the design more than the standard requires."""
    r = nearest_accessible((140, 140, 140), (255, 255, 255), target=4.5)
    assert r.ratio_before < 4.5 <= r.ratio_after
    assert r.ratio_after < 5.0                      # minimal, not "just make it black"
    assert r.suggested == (118, 118, 118)


def test_the_suggestion_keeps_the_hue():
    """Only lightness moves: a green stays the same green, a blue the same blue."""
    for ink, surface in [((60, 136, 76), (255, 255, 255)),
                         ((92, 142, 220), (255, 255, 255))]:
        r = nearest_accessible(ink, surface)
        _, a0, b0 = srgb_to_lab(*ink)
        _, a1, b1 = srgb_to_lab(*r.suggested)
        assert a1 == pytest.approx(a0, abs=1.5)
        assert b1 == pytest.approx(b0, abs=1.5)
        assert r.ratio_after >= 4.5


def test_it_darkens_on_a_light_surface_and_lightens_on_a_dark_one():
    dark_ink = nearest_accessible((140, 140, 140), (255, 255, 255))
    light_ink = nearest_accessible((90, 90, 90), (17, 17, 17))
    assert sum(dark_ink.suggested) < sum((140, 140, 140))
    assert sum(light_ink.suggested) > sum((90, 90, 90))


def test_an_impossible_target_says_so_instead_of_pretending():
    """On mid-grey, no text colour reaches 7:1 — the SURFACE has to change."""
    r = nearest_accessible((130, 130, 130), (128, 128, 128), target=7.0)
    assert r.achievable is False
    assert r.ratio_after < 7.0
    assert r.suggested in ((0, 0, 0), (255, 255, 255))   # it reports the extreme it tried


def test_remediation_is_deterministic():
    first = nearest_accessible((140, 140, 140), (245, 245, 245))
    for _ in range(5):
        assert nearest_accessible((140, 140, 140), (245, 245, 245)) == first
