"""RELEASE GATE — path templates must be bound before the request is sent.

Inventories (OpenAPI, Postman) store paths as templates: /calendars/{calendarId}/events.
Sending that literally produced

    GET https://host/calendars/%7BcalendarId%7D/events?calendarId=example

— a URL that cannot exist on any system under test, so every path-parameterised
case failed with a 404 regardless of the behaviour it was meant to check, and the
value was leaked into the query string on top. `_bind_path_params` fills each
{name} from the step params (removing the key it consumed) or the environment
variables, percent-encoding the value; an unknown placeholder is left alone.

The unit tests below pin the substitution rules; the end-to-end test drives a real
run through a stubbed httpx transport and asserts on the URL that was actually
sent.
"""
import httpx
import pytest
from conftest import add_requirement, confirm_requirement

from app.modules import execution
from app.modules.execution import _bind_path_params, _interpolate


# ---------------------------------------------------------------- unit: binding

def test_value_comes_from_the_step_params_and_leaves_the_query_string():
    # The defect in one line: the value belongs in the path, not in ?calendarId=.
    params = {"calendarId": "example", "maxResults": 10}
    path = _bind_path_params("/calendars/{calendarId}/events", params, {})
    assert path == "/calendars/example/events"
    assert params == {"maxResults": 10}, "the consumed key must not also be sent as a query param"


def test_several_placeholders_in_one_path_are_all_bound():
    params = {"calendarId": "primary", "eventId": "evt-1", "alt": "json"}
    path = _bind_path_params("/calendars/{calendarId}/events/{eventId}", params, {})
    assert path == "/calendars/primary/events/evt-1"
    assert params == {"alt": "json"}


def test_the_same_placeholder_twice_consumes_the_key_once():
    params = {"id": "7"}
    assert _bind_path_params("/a/{id}/b/{id}", params, {}) == "/a/7/b/7"
    assert params == {}


def test_value_falls_back_to_the_environment_context():
    # Environment variables are the second source; nothing is consumed from them.
    params = {"maxResults": 10}
    context = {"calendarId": "from-env"}
    path = _bind_path_params("/calendars/{calendarId}/events", params, context)
    assert path == "/calendars/from-env/events"
    assert params == {"maxResults": 10}
    assert context == {"calendarId": "from-env"}


def test_step_params_win_over_the_environment_context():
    params = {"calendarId": "from-step"}
    path = _bind_path_params("/calendars/{calendarId}/events", params,
                             {"calendarId": "from-env"})
    assert path == "/calendars/from-step/events"
    assert params == {}


def test_a_null_param_falls_through_to_the_context_and_is_not_consumed():
    # An explicit null is "no value", not "the empty value".
    params = {"calendarId": None}
    path = _bind_path_params("/calendars/{calendarId}/events", params,
                             {"calendarId": "from-env"})
    assert path == "/calendars/from-env/events"
    assert params == {"calendarId": None}


def test_an_unknown_placeholder_is_left_literal():
    # Nothing to bind: leave the template alone rather than invent a value. The
    # request will 404, but the evidence shows exactly which variable was missing.
    params = {"other": "x"}
    path = _bind_path_params("/calendars/{calendarId}/events", params, {})
    assert path == "/calendars/{calendarId}/events"
    assert params == {"other": "x"}


def test_a_path_without_placeholders_is_untouched():
    params = {"q": "term"}
    assert _bind_path_params("/customers", params, {"id": "1"}) == "/customers"
    assert params == {"q": "term"}


@pytest.mark.parametrize("value,expected", [
    ("primary cal", "primary%20cal"),          # spaces
    ("a/b", "a%2Fb"),                           # slashes must not create path segments
    ("../admin", "..%2Fadmin"),                 # ... including traversal attempts
    ("id?x=1&y=2", "id%3Fx%3D1%26y%3D2"),      # query delimiters stay in the segment
    ("a#b", "a%23b"),
    ("مستخدم", "%D9%85%D8%B3%D8%AA%D8%AE%D8%AF%D9%85"),  # non-ASCII -> UTF-8 bytes
])
def test_values_are_percent_encoded_with_no_safe_characters(value, expected):
    assert _bind_path_params("/items/{id}", {"id": value}, {}) == f"/items/{expected}"


def test_context_values_are_percent_encoded_too():
    assert _bind_path_params("/items/{id}", {}, {"id": "a b/c"}) == "/items/a%20b%2Fc"


def test_non_string_values_are_stringified():
    params = {"id": 42, "flag": True}
    assert _bind_path_params("/items/{id}/{flag}", params, {}) == "/items/42/True"
    assert params == {}


def test_the_double_brace_interpolation_syntax_is_not_disturbed():
    # {{var}} is resolved earlier by _interpolate; _bind_path_params must not
    # rewrite what is left when that variable was unknown.
    context = {"customerId": "c-1"}
    assert _interpolate("/customers/{{customerId}}", context) == "/customers/c-1"
    assert _bind_path_params("/customers/{{unknown}}", {}, {}) == "/customers/{{unknown}}"


# ---------------------------------------------------------------- end-to-end run

@pytest.fixture()
def sent_requests(monkeypatch):
    """Replace the httpx module inside the execution engine with a shim whose
    Client routes through a MockTransport, and record every request sent."""
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"ok": True})

    class _HttpxShim:
        """Everything (TimeoutException, TransportError, ...) still resolves to
        the real module; only Client is swapped."""

        def __getattr__(self, name):
            return getattr(httpx, name)

        @staticmethod
        def Client(**kwargs):
            kwargs.pop("verify", None)  # unused once an explicit transport is given
            return httpx.Client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(execution, "httpx", _HttpxShim())
    return sent


def _wait_run_terminal(client, headers, run_id, timeout=30.0):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/v1/runs/{run_id}", headers=headers)
        assert r.status_code == 200, r.text
        run = r.json()
        if run["state"] in ("completed", "cancelled", "aborted"):
            return run
        time.sleep(0.1)
    raise AssertionError(f"run {run_id} did not reach a terminal state")


def test_a_run_sends_the_bound_url_not_the_template(client, register_org,
                                                    create_project, sent_requests):
    headers = register_org("Calendar Co")
    pid = create_project(headers, name="Calendar API", automation="manual")
    rid = add_requirement(client, headers, pid, "REQ-CAL-1",
                          "Listing the events of a calendar returns 200.")
    confirm_requirement(client, headers, rid)

    ok = [{"type": "status_code", "expected": 200}]
    r = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Path parameters are bound before the request is sent",
        "requirement_ids": [rid],
        "steps": [
            # value in the step params -> path, and dropped from the query string
            {"method": "GET", "path": "/calendars/{calendarId}/events",
             "request": {"params": {"calendarId": "primary cal/1", "maxResults": 5}},
             "assertions": ok},
            # value only in the environment variables
            {"method": "GET", "path": "/tenants/{tenantId}/status",
             "request": {}, "assertions": ok},
            # nothing to bind it with -> the template survives untouched
            {"method": "GET", "path": "/widgets/{widgetId}",
             "request": {}, "assertions": ok},
        ],
    }, headers=headers)
    assert r.status_code == 201, r.text
    case_id = r.json()["id"]
    r = client.post("/v1/test-cases/bulk", json={"ids": [case_id], "action": "approve"},
                    headers=headers)
    assert r.status_code in (200, 201, 204), r.text

    r = client.post(f"/v1/projects/{pid}/environments", json={
        "name": "stub", "base_url": "https://api.example.test", "auth_type": "none",
        "variables": {"tenantId": "acme corp"}}, headers=headers)
    assert r.status_code == 201, r.text
    eid = r.json()["id"]

    r = client.post(f"/v1/projects/{pid}/runs", json={"environment_id": eid},
                    headers=headers)
    assert r.status_code == 202, r.text
    run = _wait_run_terminal(client, headers, r.json()["run_id"])
    assert run["state"] == "completed"
    assert run["counts"]["passed"] == run["counts"]["total"] == 1, run["counts"]

    assert len(sent_requests) == 3, [str(q.url) for q in sent_requests]
    first, second, third = sent_requests

    # 1. substituted into the path, percent-encoded, and NOT duplicated as ?calendarId=
    assert first.url.path == "/calendars/primary cal/1/events"
    assert "/calendars/primary%20cal%2F1/events" in str(first.url)
    assert "calendarId" not in str(first.url), str(first.url)
    assert dict(first.url.params) == {"maxResults": "5"}, "the other params must survive"

    # 2. bound from the environment variables, encoded the same way
    assert "/tenants/acme%20corp/status" in str(second.url)
    assert not second.url.params

    # 3. unknown placeholder: still literal — the pre-fix symptom, now only when
    #    there genuinely is no value to bind
    assert "widgetId" in str(third.url)

    # the evidence records the URL that was really sent, so a reviewer can see it
    results = client.get(f"/v1/runs/{run['id']}/results", headers=headers).json()["results"]
    assert len(results) == 1 and results[0]["outcome"] == "passed"
    urls = [step["request"]["url"] for step in results[0]["evidence"]]
    assert "/calendars/primary%20cal%2F1/events" in urls[0]
    assert "calendarId=" not in urls[0]
    assert "/tenants/acme%20corp/status" in urls[1]
