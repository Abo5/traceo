"""Headless-browser driver for FR-021 / FR-022 — an OPTIONAL component.

Playwright is deliberately not in requirements.txt: it pulls a browser binary that an
air-gapped installation may not want, and every other part of discovery works without
it. `capture.crawl` imports this module lazily and returns a 501 with installation
instructions when Playwright is absent, so the HAR/DOM import endpoints remain the
supported path on a minimal deployment.

The driver produces exactly the two artefacts the parsers already consume:
a HAR-shaped document and a list of form descriptors.
"""
from urllib.parse import urljoin, urlparse

try:
    from playwright.sync_api import sync_playwright
except ImportError as exc:  # re-raised as ImportError by the caller
    raise ImportError("playwright is not installed") from exc


_FORM_SCRIPT = """
() => Array.from(document.querySelectorAll('form')).map(form => ({
  id: form.id || '',
  name: form.getAttribute('name') || '',
  action: form.getAttribute('action') || location.pathname,
  method: (form.getAttribute('method') || 'POST').toUpperCase(),
  dir: getComputedStyle(form).direction,
  rtl: getComputedStyle(form).direction === 'rtl',
  locale_switch: !!document.querySelector('[data-locale],[lang-switch],.locale-switch'),
  fields: Array.from(form.querySelectorAll('input,select,textarea'))
    .filter(el => el.name)
    .map(el => ({
      name: el.name,
      type: el.type || el.tagName.toLowerCase(),
      required: el.required || false,
      pattern: el.pattern || null,
      minlength: el.minLength > 0 ? el.minLength : null,
      maxlength: el.maxLength > 0 ? el.maxLength : null,
      min: el.min || null,
      max: el.max || null,
    })),
}))
"""


def crawl_application(url: str, max_pages: int = 5,
                      wait_ms: int = 1500) -> tuple[dict, list[dict]]:
    """Visit up to `max_pages` same-origin pages, recording network traffic and forms.

    Returns (har_document, form_descriptors). Raises RuntimeError with a readable
    reason when the browser cannot be launched or the entry page cannot be reached."""
    entries: list[dict] = []
    forms: list[dict] = []
    origin = urlparse(url).netloc
    visited: set[str] = set()
    queue = [url]

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(
                    f"could not launch Chromium ({e}); run `playwright install chromium`")
            context = browser.new_context()
            page = context.new_page()

            def on_response(response):
                try:
                    request = response.request
                    if urlparse(response.url).netloc != origin:
                        return
                    body = ""
                    try:
                        body = response.text()
                    except Exception:  # noqa: BLE001 — binary or already consumed
                        body = ""
                    entries.append({
                        "request": {
                            "method": request.method,
                            "url": response.url,
                            "headers": [{"name": k, "value": v}
                                        for k, v in (request.headers or {}).items()],
                            "queryString": [],
                            "postData": {"text": request.post_data or ""},
                        },
                        "response": {
                            "status": response.status,
                            "content": {
                                "mimeType": (response.headers or {}).get("content-type", ""),
                                "text": body[:200000],
                            },
                        },
                    })
                except Exception:  # noqa: BLE001 — a bad entry must not sink the crawl
                    pass

            page.on("response", on_response)

            while queue and len(visited) < max_pages:
                target = queue.pop(0)
                if target in visited:
                    continue
                visited.add(target)
                try:
                    page.goto(target, wait_until="networkidle", timeout=30000)
                except Exception as e:  # noqa: BLE001
                    if not visited - {target}:
                        raise RuntimeError(f"could not load {target}: {e}")
                    continue
                page.wait_for_timeout(wait_ms)
                try:
                    forms.extend(page.evaluate(_FORM_SCRIPT) or [])
                except Exception:  # noqa: BLE001
                    pass
                try:
                    hrefs = page.eval_on_selector_all(
                        "a[href]", "els => els.map(e => e.getAttribute('href'))") or []
                except Exception:  # noqa: BLE001
                    hrefs = []
                for href in hrefs:
                    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
                        continue
                    absolute = urljoin(target, href)
                    if urlparse(absolute).netloc == origin and absolute not in visited:
                        queue.append(absolute)

            browser.close()
    except RuntimeError:
        raise
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"crawl failed: {type(e).__name__}: {e}")

    return {"log": {"version": "1.2", "entries": entries}}, forms
