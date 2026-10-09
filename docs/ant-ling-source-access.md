# Ant Ling native source access

Checked 2026-10-09 for #267. The adapter reads Ant Ling's hosted API documentation
and prices under https://developer.ant-ling.com/en/docs/ using Cloudflare Browser
Rendering. It parses the rendered HTML directly; no AI extraction, manually
entered catalog values, or substitute provider data is used.

The production scheduled poll previously received an Alipay WAF/CAPTCHA page
instead of all six documentation articles. Actual remote Cloudflare browser
reads returned all six native articles. The existing deterministic parser
extracted eight models, including the three requested in the issue, with native
prices and controls where published and null where unknown.

The reader requires the BROWSER binding and validates the browser response,
native HTTP status, exact final URL, and documentation article before caching.
It also validates cached articles. A browser-specific cache key excludes prior
challenge responses. Cache misses load sequentially to bound browser capacity.
Missing bindings, failed reads, malformed responses, and challenge pages produce
explicit source errors; there is no recovery fetch or injected cache data.

The remote reader was tested with the production Worker's existing compatibility
date. Production acceptance still requires the deployed scheduled sync and
public API checks; successful isolated reads alone do not establish production
completeness.
