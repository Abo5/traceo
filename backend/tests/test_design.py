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


# --- roles -------------------------------------------------------------------

from app.modules.design import roles  # noqa: E402


def test_roles_separate_a_surface_from_ink():
    """A filled block is a surface; a one-pixel stroke through it is ink.
    The separator is interior-ness, which is a property of the raster — no model."""
    px = canvas(30, 30, WHITE)
    paint(px, 30, 5, 5, 20, 20, (240, 240, 240))          # a card
    for x in range(8, 22):                                 # a thin dark line on the card
        px[12 * 30 + x] = (60, 60, 60)
    found = {r.colour: r for r in roles(Image(30, 30, tuple(px)), min_share=0.001)}
    assert found[WHITE].kind == "surface"
    assert found[(240, 240, 240)].kind == "surface"
    assert found[(60, 60, 60)].kind == "ink"


def test_ink_is_paired_with_the_surface_it_sits_on_not_the_page():
    """The contrast question is about the background actually behind the glyph."""
    px = canvas(30, 30, WHITE)
    paint(px, 30, 5, 5, 20, 20, (30, 30, 30))             # a dark panel on a white page
    for x in range(8, 22):
        px[12 * 30 + x] = (250, 250, 250)                  # light text ON the dark panel
    ink = next(r for r in roles(Image(30, 30, tuple(px)), min_share=0.001)
               if r.colour == (250, 250, 250))
    assert ink.kind == "ink"
    assert ink.on_surface == (30, 30, 30)                  # not WHITE
    assert ink.contrast > 15                               # and the ratio is against the panel


def test_role_contrast_is_the_exact_wcag_ratio():
    px = canvas(20, 20, (255, 255, 255))
    for x in range(4, 16):
        px[10 * 20 + x] = (0, 0, 0)
    ink = next(r for r in roles(Image(20, 20, tuple(px)), min_share=0.001)
               if r.colour == (0, 0, 0))
    assert ink.contrast == pytest.approx(21.0, abs=1e-9)   # the WCAG maximum, exactly
    assert ink.passes() is True and ink.passes(large_text=True) is True


def test_a_failing_contrast_is_reported_as_failing():
    px = canvas(20, 20, (255, 255, 255))
    for x in range(4, 16):
        px[10 * 20 + x] = (140, 140, 140)                  # 3.36:1 — the classic muted grey
    ink = next(r for r in roles(Image(20, 20, tuple(px)), min_share=0.001)
               if r.colour == (140, 140, 140))
    assert ink.contrast == pytest.approx(3.363, abs=1e-3)
    assert ink.passes() is False                            # body text: fails
    assert ink.passes(large_text=True) is True              # large text: passes


# --- blends ------------------------------------------------------------------

from app.modules.design import is_blend, text_inks  # noqa: E402


def test_an_antialiasing_fringe_is_recognised_as_a_blend():
    """Half-way between the surface and the glyph is the renderer's doing."""
    surface, glyph = (255, 255, 255), (0, 0, 0)
    for t in (0.25, 0.5, 0.75):
        from app.modules.design import _mix
        fringe = _mix(surface, glyph, t)
        assert is_blend(fringe, surface, [glyph]) == glyph


def test_a_chosen_colour_is_not_a_blend():
    """A brand colour is not on the line between the page and the text."""
    assert is_blend((60, 136, 76), (255, 255, 255), [(0, 0, 0), (30, 30, 30)]) is None


def test_text_inks_drop_the_fringes_and_keep_the_colour():
    from app.modules.design import _mix
    px = canvas(40, 40, WHITE)
    for x in range(6, 34):                       # a muted grey "line of text"
        px[20 * 40 + x] = (140, 140, 140)
        px[19 * 40 + x] = _mix(WHITE, (140, 140, 140), 0.5)   # its antialiased edge
        px[21 * 40 + x] = _mix(WHITE, (140, 140, 140), 0.5)
    found = text_inks(Image(40, 40, tuple(px)))
    colours = {r.colour for r in found}
    assert (140, 140, 140) in colours
    assert _mix(WHITE, (140, 140, 140), 0.5) not in colours
    ink = next(r for r in found if r.colour == (140, 140, 140))
    assert ink.on_surface == WHITE
    assert ink.passes() is False                  # 3.36:1 — the finding survives


# --- design facts ------------------------------------------------------------

from app.modules.design import Fact, design_facts  # noqa: E402


def _screen():
    """A miniature screen: page, card, field, primary button — sharing a left edge."""
    px = canvas(120, 90, (19, 18, 23))                 # page
    paint(px, 120, 20, 10, 80, 70, (27, 26, 32))       # card
    paint(px, 120, 30, 30, 60, 12, (34, 33, 42))       # input
    paint(px, 120, 30, 50, 60, 14, (240, 144, 63))     # primary button
    return Image(120, 90, tuple(px))


def test_facts_cover_palette_elements_alignment_and_spacing():
    kinds = {f.kind for f in design_facts(_screen(), min_element_pixels=100)}
    assert {"palette", "surface", "element", "alignment", "spacing"} <= kinds


def test_every_fact_is_identifiable_and_states_something():
    facts = design_facts(_screen(), min_element_pixels=100)
    assert len({f.id for f in facts}) == len(facts)      # ids are unique
    assert all(f.statement.strip() for f in facts)
    assert all(f.value is not None for f in facts)


def test_element_facts_carry_the_box_as_evidence():
    facts = design_facts(_screen(), min_element_pixels=100)
    button = next(f for f in facts
                  if f.kind == "element" and f.value["colour"] == (240, 144, 63))
    assert button.evidence == (30, 50, 60, 14)
    assert button.value["box"] == (30, 50, 60, 14)


def test_the_shared_left_edge_is_stated_as_a_fact():
    """The input and the button start at the same x — that is a design decision,
    and it is the kind of thing no written requirement ever records."""
    facts = design_facts(_screen(), min_element_pixels=100)
    align = [f for f in facts if f.kind == "alignment" and f.value["axis"] == "left"]
    assert any(f.value["coordinate"] == 30 and f.value["elements"] >= 2 for f in align)


def test_extraction_is_deterministic():
    screen = _screen()
    first = [(f.kind, f.subject, f.statement) for f in design_facts(screen)]
    for _ in range(3):
        assert [(f.kind, f.subject, f.statement) for f in design_facts(screen)] == first


def test_facts_are_not_invented_for_an_empty_canvas():
    """A flat image states its palette and nothing else — no phantom elements."""
    facts = design_facts(Image(40, 40, tuple(canvas(40, 40, WHITE))))
    assert not [f for f in facts if f.kind == "element"]
    assert [f for f in facts if f.kind == "surface"]


# --- UI cases ----------------------------------------------------------------

from app.modules.design import ui_cases  # noqa: E402


def test_every_case_is_grounded_in_a_fact_that_exists():
    """The rule that makes this trustworthy: no case without a design fact."""
    facts = design_facts(_screen(), min_element_pixels=100)
    ids = {f.id for f in facts}
    cases = ui_cases(facts)
    assert cases
    for c in cases:
        assert c["design_fact_ids"]
        for fid in c["design_fact_ids"]:
            assert fid in ids


def test_no_facts_means_no_cases():
    assert ui_cases([]) == []


def test_cases_match_the_generator_shape():
    """Review, approval and the matrix treat them like any other case."""
    cases = ui_cases(design_facts(_screen(), min_element_pixels=100))
    for c in cases:
        assert {"title", "description", "type", "priority", "technique", "steps"} <= set(c)
        assert c["type"] in ("positive", "negative")
        assert len(c["steps"]) == 1
        step = c["steps"][0]
        assert step["order"] == 0 and step["check"] and step["assertions"]


def test_an_element_case_carries_the_box_and_a_tolerance():
    cases = ui_cases(design_facts(_screen(), min_element_pixels=100), box_tolerance=2)
    box_case = next(c for c in cases if c["steps"][0]["check"] == "element_box")
    exp = box_case["steps"][0]["expected"]
    assert len(exp["box"]) == 4 and exp["tolerance"] == 2


def test_a_failing_contrast_still_becomes_a_case():
    """The design itself can be the defect; omitting it would certify an
    inaccessible screen as covered."""
    px = canvas(60, 60, WHITE)
    for x in range(10, 50):
        px[30 * 60 + x] = (150, 150, 150)          # ~2.96:1 on white
    facts = design_facts(Image(60, 60, tuple(px)), min_share=0.001)
    cases = ui_cases(facts)
    a11y = [c for c in cases if c["technique"] == "a11y"]
    assert a11y
    failing = [c for c in a11y if c["type"] == "negative"]
    assert failing and failing[0]["priority"] == "high"
    assert failing[0]["steps"][0]["expected"]["min_ratio"] == 4.5


def test_failing_contrast_can_be_excluded_when_asked():
    px = canvas(60, 60, WHITE)
    for x in range(10, 50):
        px[30 * 60 + x] = (150, 150, 150)
    facts = design_facts(Image(60, 60, tuple(px)), min_share=0.001)
    kept = ui_cases(facts, include_failing_contrast=False)
    assert not [c for c in kept if c["technique"] == "a11y" and c["type"] == "negative"]


def test_the_palette_case_closes_the_set():
    """A colour the design never used appearing in the build is a regression."""
    cases = ui_cases(design_facts(_screen(), min_element_pixels=100))
    closed = next(c for c in cases if c["steps"][0]["check"] == "palette_closed")
    assert closed["type"] == "negative" and closed["priority"] == "high"
    assert len(closed["steps"][0]["expected"]["allowed"]) >= 3


def test_generation_is_deterministic():
    facts = design_facts(_screen(), min_element_pixels=100)
    first = [c["title"] for c in ui_cases(facts)]
    for _ in range(3):
        assert [c["title"] for c in ui_cases(facts)] == first
