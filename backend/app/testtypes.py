"""The five kinds of testing Traceo performs, and the one place they are named.

A project declares which of them it is for, and every engine that produces
cases answers to that declaration. The vocabulary lived inside the web-target
module while it was the only consumer; it is shared now, and a second copy of
this tuple anywhere would be a bug waiting to happen — a type the UI offers and
the backend rejects is indistinguishable, from the user's side, from a broken
product.
"""
from __future__ import annotations

from fastapi import HTTPException

# In the order the UI shows them.
TEST_TYPES: tuple[str, ...] = ("functional", "api", "ui", "performance", "security")

# A project with nothing said about it is for every kind of testing: narrowing
# is a decision the owner makes, not a default they inherit.
DEFAULT_PROJECT_TEST_TYPES: tuple[str, ...] = TEST_TYPES


def project_test_types(project) -> list[str]:
    """The types a project is for, always as a canonical, non-empty list.

    A project stored before this field existed has an empty list, and so does
    one whose value was cleared by hand. Both mean "nothing was said", which is
    read as all five — reading it as "test nothing" would silently disable every
    project that predates the field. Unknown values are dropped rather than
    raising: this is a read path, and refusing to display a project because of
    one bad string in its column would be worse than showing the rest.
    """
    stored = getattr(project, "test_types", None) or []
    known = [t for t in TEST_TYPES if t in {str(v).strip().lower() for v in stored}]
    return known or list(DEFAULT_PROJECT_TEST_TYPES)


def validate_test_types(requested: list[str] | None,
                        *, allow_empty: bool = False) -> list[str]:
    """Normalise the requested types, or raise 422 naming the legal list.

    An unknown type is rejected rather than ignored: silently dropping
    "perfomance" would run four tracks and report success for five.

    Returns them de-duplicated in canonical order, so a caller cannot change
    what runs — or the order it runs in — by reordering its list.
    """
    values = [str(t).strip().lower() for t in (requested or []) if str(t).strip()]
    unknown = [t for t in values if t not in TEST_TYPES]
    if unknown:
        raise HTTPException(422, detail={
            "code": "invalid_test_type",
            "message": f"Unknown test type(s): {', '.join(sorted(set(unknown)))}.",
            "errors": list(TEST_TYPES)})
    if not values and not allow_empty:
        raise HTTPException(422, detail={
            "code": "invalid_test_type",
            "message": "Select at least one test type.",
            "errors": list(TEST_TYPES)})
    return [t for t in TEST_TYPES if t in set(values)]
