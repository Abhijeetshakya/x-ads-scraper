# Delivery report — 1 October 2026

## Delivered

A complete TypeScript/Node 24 Actor project with Apify manifests, grouped input schema, described output model and four dataset views. ExportAdapter uses the documented create/poll/download contract, runtime operation discovery, pending job checkpoints and streaming CSV. The feature-gated public UI adapter reads observed anonymous services with browser fallback. ApiAdapter is a tested documented-client interface/stub, disabled until an official API is verified.

The pipeline includes string-safe IDs, BigInt Snowflake dates, header aliases/schema drift, quarantine outside the ads dataset, disk-backed deduplication, bounded fan-out and dataset batches, public oEmbed enrichment/TTL caching, cautious destination resolution, optional official API media, Unicode/RE2 filters, sharded versioned monitor state, grace/complete-scope removal, saved-row charge intent, HMAC webhooks and native Slack/Discord digests. JSON, BOM CSV, five-sheet streaming Excel and a self-contained interactive HTML report are generated. README includes input reference, tutorials, pricing recommendations, limitations and Store metadata.

## Verified

- TypeScript static checks and ESLint.
- 23 fixture/unit/mock HTTP tests: reordered/renamed/new CSV columns, empty and 100,000-row streams, exact Snowflake/unsafe-ID behavior, input parsing, Unicode phrases/regex/exclusions/nulls, diff lifecycle/grace/partial/rolling scopes, retry/backoff, enrichment parsing/cache, notification retry/HMAC/native formats, metering budget/deduplication, dataset reconciliation and cautious metric aggregation.
- Two integration tests execute actual local `apify run`: export submission/poll/download, output persistence, all four KVS reports, resurrection without duplicate ads/jobs; five distinct monitor runs sharing a named state store demonstrate NEW, unchanged, CHANGED, missed run and REMOVED.
- Apify CLI validates input, dataset and output schemas. This is structural validation, not a claim of Console UI rendering.
- Build emits runnable JavaScript. Synthetic demonstration exports and monitor lifecycle are in `artifacts/` and reproduce with `npm run demo`.

The command `npm run check` runs the static, lint, automated test, local integration and schema suite. CLI telemetry is disabled through Apify's official configuration in all CLI tests; an earlier attempt was rejected by automatic approval review for an unapproved telemetry request, and no telemetry is needed for the passing tests.

## Live result and remaining release gates

The opt-in real smoke ran for Nike × France × the last 30 days. Live page discovery succeeded: 27 countries, current export operations and public UI search paths were found. The anonymous HTTP probe failed; the browser fallback could not launch because Chromium was unavailable. Its installation download had failed in this environment. The smoke exited 91 and is reported as failed, not skipped or substituted with mock data.

Earlier anonymous browser inspection observed the EU27 selector, Entire EU checkbox, direct result cards and an export preparation dialog. A nonempty response and CSV download were not captured. No developer bearer token or Apify account credentials were supplied. Docker is unavailable here, so Docker build and cloud execution remain untested. Console input-form rendering, native download/view layout, Store publishing and actual PPE price configuration have not been performed.

Before publishing:

1. Install Chromium in a deployment environment and validate anonymous UI search against a known nonempty account/date/country; capture sanitized response and establish pagination/completeness.
2. Provide a permitted developer bearer token, validate one nonempty export, capture actual CSV headers, date boundaries, metric window semantics, auth permission tier, download host, statuses and observed latency/rate behavior. Update aliases/fixtures from that evidence.
3. Confirm dates/countries/terms again; UI implementation can change. Do not activate a guessed official API endpoint.
4. Run the opt-in live smoke, build the Docker image/cloud Actor, inspect Console grouped input and all dataset views/download links, and configure one-hour timeout and recommended PPE events/prices. Then publish the listing.

The package is implementation-complete and locally verified against explicit synthetic source contracts. It is **not certified Store-ready for live extraction** until those gates pass. A first-click input is valid but cannot guarantee X access or nonempty data.

## Assumptions and intentional limits

- No global library or account-free content search is claimed. Current support is EU repository disclosure only.
- Unknown values are null with reason metadata; creative enrichment is optional public-post context, not proof of complete repository creative content.
- The known public UI transport is undocumented, explicitly feature-gated and backed by browser/export options. Direct HTTP may receive 403.
- Export multi-country behavior and end-date/window semantics remain unverified. Export uses one country/job. Cross-chunk aggregate impressions/reach remain null until metric-window semantics are verified, with original chunk values retained. Disjoint verified adapter windows may sum impressions; reach stays non-additive with bounds.
- UI responses are conservative partial outcomes without explicit completeness. They cannot generate REMOVED. Rolling date windows excluding prior scope also cannot prove removal.
- Named KVS leases are best-effort; schedule sequential runs. Notification delivery and dataset/billing/state are not cross-system atomic. Journals/reconciliation favor no duplicate billing and recover saved rows; an ambiguous charge may be missed rather than repeated.
- A crash before an export ID is saved requires manual verification of the ambiguous submission. No blind duplicate submission is made.
- Broad UI JSON responses are bounded; narrower date scopes may be necessary. CSV, staging, dataset output and file writers stream, while per-ad state/content is bounded by record caps.
- Low concurrency, public-only access, no bypass or payment-person investigation. Users must assess X terms and applicable law. No source credentials are included; fixture-only mock strings are labelled and never logged.
