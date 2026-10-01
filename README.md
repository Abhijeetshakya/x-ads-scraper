# X (Twitter) Ads Scraper & Competitor Monitor

Extract public X Ads Repository disclosures about EU-served ads. Compare advertiser accounts and served countries, inspect disclosed targeting, enrich public posts where available, and track material changes on a schedule. Built for marketing analysts, researchers and transparency audits.

**Release status:** implementation and synthetic integration tests are available. A successful nonempty live export, real CSV headers, cloud browser execution and Console form rendering are release gates. This package must not be represented as a verified live Store release until those checks pass. See [source evidence](docs/SOURCE_NOTES.md) and [delivery report](docs/DELIVERY_REPORT.md).

## Quick start

1. Use Node.js 24+, run `npm ci`, then `npx playwright install --with-deps chromium`. On Apify, the Dockerfile installs the browser. Set memory to 1 GB and timeout to at least 3,600 seconds in run options.
2. Enter advertiser handles or numeric IDs, served countries and dates. The prefilled example is Nike, France, last 90 days, anonymous `auto` mode. It is a valid configuration; live availability and nonempty results cannot be guaranteed. For the documented export flow, supply your developer bearer token in the secret `xBearerToken` field and prefer numeric advertiser IDs.
3. Run `APIFY_CLI_DISABLE_TELEMETRY=1 DISABLE_METERING=1 npx apify run --purge --input-file example-input.json`. Open the dataset or download `ads.csv`, `ads.json`, `ads.xlsx`, and `report.html` from the run key-value store.

For a completely offline, reproducible example, run `npm run demo`. Its reports and simulated monitor lifecycle are explicitly synthetic.

## Coverage and availability

The repository covers ads served in the EU, starting at the public UI minimum date of 26 August 2023. Its observed country selector contains the EU27, including an Entire EU option. It is not a global ads library. UK, Norway, Iceland and Liechtenstein were not in the live selector. Data may lag or be incomplete. No spend is inferred.

On 1 October 2026 the public UI already displayed a results area, embedded posts and metric/targeting cards. Ordinary HTTP access to its same-origin search services later returned 403 in this environment. The official help still documents asynchronous CSV export. No nonempty live payload or CSV download was captured; the column fixture is synthetic. Future official repository API support is an explicit, tested stub awaiting documentation. We do not guess its endpoints.

Unknown fields are `null`, accompanied by source/status fields and an `availability` reason map. Post creation time is derived from the tweet Snowflake, not campaign start. `adName` is derived from UTM campaign/content, then the first creative line, then handle/ID. Metrics remain available when a public post has been deleted. Funding entity is retained only when explicitly disclosed; the Actor never investigates natural persons behind payments.

## How it works

TypeScript on Node 24 provides typed adapter contracts and the official Apify JavaScript SDK. Lightweight Undici HTTP is preferred; Playwright provides anonymous public UI fallback. Streaming CSV parsing, SQLite disk indices and streamed Excel writing keep row memory bounded. RE2 avoids catastrophic regex backtracking. ExcelJS supplies real Excel dates and hyperlinks. No external services are required for report rendering.

The pipeline validates input, discovers current public page assets and supported countries, probes adapters, resolves advertisers, plans bounded advertiser/country/date jobs, normalizes and deduplicates, enriches unique posts, filters, computes monitor changes, saves dataset batches, meters saved rows, sends one digest, and writes reports and `SUMMARY`/`ERRORS`.

`auto` tries the documented API adapter when implemented, anonymous UI, then configured export. `export` uses only the documented GraphQL flow with your developer token. Runtime operation discovery reads current public assets; IDs are never fixed in source. `ui` uses feature-gated anonymous same-origin services observed in the page, falling back to browser interaction. Set `enablePublicUiTransport=false` to use browser interaction exclusively. No private Ads Manager endpoints, login, credential extraction or CAPTCHA bypass are used. `api` currently fails with an actionable message.

Export jobs are split into disjoint 90-day chunks, one country per job because multi-country export has not been verified. UI queries can request several supported countries. The plan prints job count and estimated latency; the 200-second export estimate is an assumption, not an SLA. Default concurrency is 2, maximum jobs 100, poll cap approximately 15 seconds, and job timeout 15 minutes. Retryable errors include 429, 5xx, capacity errors, network failures and timeouts. `Retry-After` is honored. Auth and invalid-account errors are actionable. Schema drift warns once and makes the scope partial so it cannot imply removal.

Pending export IDs and stage pages survive SDK persistence and migration. Saved dataset rows are reconciled on resume. An interrupted submission without a captured export ID is marked ambiguous and is not blindly resubmitted. Notifications use run-level idempotency keys; external delivery cannot be exactly once when a connection fails after the receiver accepts a request. Charge intents prioritize avoiding duplicate billing and may undercharge after an ambiguous crash.

Cross-chunk impressions are summed only across disjoint windows with verified requested-range metric semantics. Current unverified export/UI window semantics yield null aggregate metrics and retain per-chunk values in extra.chunkMetrics. Unique reach is not added across chunks: `reach=null` with union lower/upper bounds where possible. Across advertisers/countries, summary reach is a sum of disclosed row reach, not a deduplicated audience. Actual campaign duration is reported only with disclosed delivery dates; tweet age never substitutes for campaign duration.

## Input reference

| Field | Default | Purpose |
|---|---|---|
| `advertisers` | `null` | Accounts to inspect. Accepts handles, @handles, public x.com/twitter.com profile URLs, and numeric user IDs. Maximum 200. This source does not support global content search. |
| `countries` | `["FR"]` | ISO alpha-2 served-country codes. Validated against live supported countries. UK/EEA coverage is not assumed. Ignored for a named market preset. |
| `marketPreset` | `"Custom"` | Expand a region to supported served countries. Unsupported members such as CH or GB are skipped with a warning. |
| `startDate` | `"90 days"` | UTC day or relative date (e.g. 90 days). Clamped to the source minimum. Defaults to the last 90 days. |
| `endDate` | `"0 days"` | Inclusive UTC day or relative date. 0 days means today. Future dates clamp to today. |
| `keywords` | `[]` | Match words, quoted phrases, or /RE2 regex/. Runs after enrichment when server-side search is unavailable. |
| `excludeKeywords` | `[]` | Drop known matches before positive keyword matching. Supports quoted phrases and /regex/. |
| `keywordMatch` | `"any"` | Any matches at least one include expression; all requires every include expression. |
| `keywordFields` | `["creativeText", "advertiser", "targeting", "landingUrl"]` | Creative text, advertiser identity, disclosed targeting and landing URL. Selecting creativeText automatically enables creative enrichment. |
| `caseSensitive` | `false` | When off, Unicode compatibility/diacritic folding and case folding support European-language matching. |
| `targetedLocations` | `[]` | Strings matched against disclosed target locations, distinct from the country where the ad was served. |
| `minImpressions` | `null` | Keep rows with at least this many disclosed impressions. |
| `minReach` | `null` | Keep rows with at least this disclosed reach. Unique reach cannot be summed across chunks. |
| `approvalStatuses` | `[]` | Free text, compared without case. Suggested source values include Verified and Halted; new values remain usable. |
| `fundingTypes` | `[]` | Free-text disclosed funding types, compared without case. No payment-person lookup is performed. |
| `mediaTypes` | `[]` | Experimental media metadata must be disclosed by repository/embed/API. Unknown is not treated as text. |
| `strictFilters` | `false` | When on, unavailable fields cannot satisfy a filter. When off, undecidable matches are kept with filterUncertain=true. |
| `enrichCreatives` | `true` | Fetch public oEmbed text, author and links per unique tweet ID. Deleted/protected posts retain repository metrics. |
| `resolveLandingUrls` | `true` | Follow disclosed t.co links with bounded redirects, strict timeouts and public-destination checks; extract domain and UTM fields. |
| `lookupMedia` | `false` | Best-effort asset details through official X API v2 with a supplied token, otherwise public embed metadata. Failures never remove repository metrics. |
| `xBearerToken` | `null` | Optional permitted developer app bearer token. Required for direct documented export mode and official API media lookups. Never logged. |
| `mode` | `"snapshot"` | Snapshot emits matching ads without reading/writing monitor state. Monitor emits only NEW, CHANGED and REMOVED. |
| `monitorKey` | `null` | Optional stable label hashed for state keys. Otherwise derived from advertiser/country/filter inputs. Keep the same value in your scheduled task. |
| `monitorStoreName` | `"x-ads-monitor-state"` | Persistent named Apify KVS. State is sharded by advertiser, country and ad-key bucket. Schedule overlapping runs sequentially. |
| `notifyOn` | `["NEW", "CHANGED", "REMOVED"]` | One digest per run for selected material campaign events. |
| `removalGraceRuns` | `2` | Absent campaigns are removed only after this many fully successful runs of the same scope. Partial/failed queries never increment absence. |
| `metricChangeThresholdPercent` | `null` | Null means impression/reach growth alone is not a material change. Set a percentage to include significant changes relative to the previous observation. |
| `webhookUrl` | `null` | HTTPS digest endpoint. Gets full emitted-event JSON and X-X-Ads-Signature: sha256=<HMAC>. |
| `webhookSecret` | `null` | Required with webhookUrl. HMAC-SHA256 signs the exact UTF-8 request body. |
| `slackWebhookUrl` | `null` | Optional Slack incoming webhook endpoint. Gets native Block Kit digest formatting. |
| `discordWebhookUrl` | `null` | Optional Discord endpoint. Gets a native embed digest. |
| `notifyMaxItems` | `10` | Limit displayed top ads in Slack/Discord and generic highlights. Generic full events remain available in the linked dataset. |
| `notifyOnEmpty` | `false` | Send a summary even when no selected campaign event was emitted. |
| `exportFormats` | `["csv", "json", "xlsx", "html"]` | Files in the run KVS: BOM CSV, JSON, streaming Excel, and self-contained HTML. Native dataset export is always available. |
| `includeRaw` | `false` | Keep raw repository rows for auditing. Increases storage/export sizes. |
| `sortBy` | `"impressions"` | Sort final emitted results on disk. Unknown metrics sort last. |
| `maxAdsPerAdvertiser` | `null` | Null means no output cap. A cap never justifies removal inference; un-emitted new/change events remain pending for the next run. |
| `maxItems` | `null` | Null means no output cap. A cap never justifies removal inference; un-emitted new/change events remain pending for the next run. |
| `sourceMode` | `"auto"` | Auto probes the best verified working source. API is a documented stub until a new official API is verified; export needs a permitted bearer token. |
| `enablePublicUiTransport` | `true` | Feature flag for anonymous endpoints discovered in current public-page assets. They are not a documented API. Logs a warning and falls back to anonymous browser/export if unavailable. |
| `concurrency` | `2` | Polite default is two jobs. Lower to one when the source is slow or rate limited. |
| `requestDelayMs` | `1000` | Token-bucket host pacing shared by repository, enrichment and notifications. |
| `maxRetries` | `3` | Bounded retries with exponential backoff/jitter for retryable errors. Auth/invalid queries do not retry. |
| `jobTimeoutMinutes` | `15` | Maximum time for a submitted CSV job; polling is capped near 15 seconds. Export IDs are checkpointed. |
| `maxExportJobs` | `100` | Fail before submission if advertiser × country × date chunks exceeds this number. |
| `operationIds` | `null` | Optional create/status IDs from a permitted current public-page network capture. Never credentials. Normally discovered from live page assets. |
| `proxyConfiguration` | `{"useApifyProxy": false}` | Off by default. Configure Apify datacenter proxies as the first escalation for permitted access. No identity cycling or CAPTCHA bypass. |

## Example input

```json
{
  "advertisers": ["@Nike", "8940342"],
  "marketPreset": "Custom",
  "countries": ["FR", "DE"],
  "startDate": "30 days",
  "endDate": "0 days",
  "keywords": ["café", "\"free shipping\"", "/electric|hybrid/"],
  "keywordFields": ["creativeText", "targeting"],
  "strictFilters": false,
  "enrichCreatives": true,
  "mode": "monitor",
  "notifyOn": ["NEW", "CHANGED", "REMOVED"],
  "exportFormats": ["csv", "json", "xlsx", "html"],
  "maxItems": 100,
  "sourceMode": "auto"
}
```

Keep tokens and webhook URLs in secret input fields, never in source, public examples or logs. Handles, profile URLs and numeric IDs are trimmed, validated and deduplicated; handles resolving to the same user are deduplicated again. Unsupported countries are skipped with a warning. No-country plans fail clearly. More than 200 advertisers or reversed/invalid dates fail before work. All current adapters require advertisers: content filters narrow supplied accounts, they do not search the whole library.

## Filtering guide

`countries` means where an ad was served. `targetedLocations` matches disclosed geo-targeting labels and does not substitute the served country. Keyword fields include creative text, advertiser identity, targeting and landing URL. Phrases use quotes; regex uses `/pattern/` with optional flags supported by RE2. Backreferences and lookaround are rejected. Text uses Unicode NFKD normalization, diacritic folding and case folding unless case-sensitive. Exclusions always win. `any` needs one inclusion; `all` needs every inclusion. Matched terms and fields are recorded.

If a required filtered field is unknown, default permissive filtering keeps the row with `filterUncertain=true`; `strictFilters=true` drops it. A missing creative must never be interpreted as proof that a keyword is absent. Creative-text filtering automatically enables enrichment. Repository server-side filtering is used whenever the adapter advertises that capability; the future official API mock verifies this contract. Approval and funding suggestions are illustrative free text, not verified exhaustive enums.

Public oEmbed supplies text, author and links where available. It generally does not disclose complete media inventories. `lookupMedia` is experimental and uses official API v2 when a developer token permits it, else observed embed assets. Unknown asset count remains null. Landing links follow public t.co redirects with five-hop and 20-second caps; arbitrary destination websites are not crawled. Multiple external links without an identified destination produce an ambiguity reason rather than a guessed landing page. Cache TTL is 30 days; transient failures are retried on later runs. Snapshot cache is confined to the run store.

## Monitoring and notifications

1. Save an Apify Task with `mode=monitor`, stable advertiser/country/filter scope and `monitorKey` (or accept its generated hash). The default named state store is `x-ads-monitor-state`.
2. Run once: matching rows are NEW. Subsequent runs emit only NEW, CHANGED and REMOVED. Content hashes cover advertiser identity, approval/halted status, targeting, funding, creative text and landing URL. Impression/reach growth is ignored unless you set `metricChangeThresholdPercent`.
3. Configure a generic HTTPS webhook and secret, or a secret Slack/Discord incoming webhook URL. The generic payload includes full selected event rows, counts and highlights. Verify `x-x-ads-signature` as `sha256=` plus HMAC-SHA256 of the exact raw body. Slack uses Block Kit; Discord uses embeds with mentions disabled. `notifyMaxItems` caps highlights, not full generic JSON. Empty digests are off by default. Failed notifications are retried and recorded without failing saved data.
4. In Apify Console create a Schedule for the Task, for example daily. Keep runs sequential: the named KVS lease is a best-effort overlap guard, not a transactional distributed lock. Increase timeout for slow export jobs and avoid overlapping schedules.
5. Inspect SUMMARY and ERRORS after each run. Schedule/runs webhooks or Apify Integrations can connect email, Slack, Google Sheets, Make or Zapier without writing code. Configure those in Console; this repository does not silently create accounts, schedules or outbound integrations.

REMOVED means absent from a fully successful search covering the prior date window, after two consecutive successful misses by default. Failed, partial, drifted and truncated searches never remove rows. A rolling window that excludes a prior window does not establish removal; use a fixed start date and expanding end date when removal tracking matters. Current UI responses lack a verified completeness guarantee, so they are conservatively partial and do not infer removal. This trades removal coverage for fewer false claims.

State is versioned, sharded by monitor/advertiser/country/ad-key prefix and paged below 512 KB. It retains minimal identity, material snapshots needed for previous values, metric comparison, timestamps, misses and cached enrichment. Changing filters/countries on an explicit monitor key fails; use a new key. Snapshot mode never opens the named monitor store. Delete a monitor’s named state only when you intentionally want a fresh baseline.

## Output and exports

One row represents one advertiser/post/line-item/served-country identity. `adKey` is SHA1 of those exact string IDs. Dataset views are Overview, Creatives, Targeting & reach, and Changes. Views flatten nested paths into readable tables.

The run output links expose the dataset, SUMMARY, ERRORS and generated files. Native Apify exports include JSON, CSV, XLSX, HTML, XML, RSS and JSONL. Select a view or field list to control native flattened columns. Generated CSV uses a UTF-8 BOM and neutralizes spreadsheet formulas; JSON preserves nested records; Excel has Ads, Advertisers, Countries, Changes and Summary sheets, frozen headers, filters, date cells and clickable links; HTML is self-contained with search, sorting, inline SVG charts, dark/light mode and mobile layout. All scraped HTML text is escaped. Reports describe emitted rows, so monitor reports contain events rather than a complete current campaign inventory.

Illustrative output excerpt, **synthetic, not a captured live disclosure**:

```json
{
  "tweetId": "1346889436626259968",
  "lineItemId": "line-1",
  "country": "FR",
  "impressions": 1200,
  "reach": 800,
  "adCreatedAt": "2021-01-06T18:40:40.344Z",
  "adCreatedAtSource": "derived_tweet_snowflake",
  "deliveryStart": null,
  "daysActive": null,
  "creative": { "text": null, "assetCount": null, "assetCountSource": "not_disclosed", "enrichmentStatus": "not_attempted" },
  "changeStatus": "NEW"
}
```

The complete generated example is in `artifacts/ads.json` after `npm run demo`. Every nullable field is documented in the dataset schema; the `availability` map contains reason codes beyond the dedicated source/status companions. `extra` preserves new unmapped columns. `raw` is included only on request.

## Pricing and run options

Suggested Store pay-per-event prices: `actor-start` $0.05 and `ad-result` $0.002 per saved output row. These are recommendations requiring Console configuration, not activated billing. The start price covers startup/source discovery; per-row pricing aligns with delivered data. Creative enrichment is included by default; an optional `creative-enriched` event is deliberately not charged in this build. Apify platform resource charges and X API access costs may also apply.

The SDK charges ad-result only after dataset persistence. Failures, empty results, duplicates and unchanged monitor rows are not charged. Remaining event budget limits saved batches and stops output gracefully. The synthetic actor-start event is configured by Apify pricing, not manually charged. `DISABLE_METERING=1` disables code-level charges for local tests.

Use 1 GB memory and at least one hour timeout. Raise Console timeout and `jobTimeoutMinutes` for slow jobs; raise `maxExportJobs` only after reviewing the logged plan. Default proxy is off; explicitly configured Apify datacenter proxy is the first escalation. This implementation does not automatically buy proxy capacity or bypass access controls. Disk staging keeps memory bounded, but storage grows with disclosures. HTTP/UI JSON requests have explicit response-size caps; large/truncated scopes need narrower dates/accounts, and cannot establish removal.

## Development and verification

```bash
npm ci
npm run check
npm run build
npm run demo
RUN_LIVE_TESTS=1 APIFY_CLI_DISABLE_TELEMETRY=1 npm run test:live
```

`check` runs TypeScript checks, ESLint, fixture/unit/mock HTTP tests, real local `apify run` integration/resume and simulated persistent monitor runs, plus Apify schema validation. CLI telemetry is explicitly disabled for integration tests. The live smoke is opt-in, one advertiser/country/30-day scope; set LIVE_ADVERTISER and LIVE_COUNTRY if needed. It must fail when real access fails, never silently replace live data with fixtures. The local mock endpoint flag is restricted to loopback and rejected on Apify cloud. Docker/cloud testing and Apify Console rendering require a deployment environment and are not implied by local schema validation.

The source contract is in `src/types.ts`; adapters are isolated under `src/adapters`. Fixture headers must be updated only from a sanitized real CSV, with added alias/drift tests. When the official API is documented, implement its client behind ApiAdapter, specify capabilities and test completeness/pagination before enabling auto selection.

## FAQ

**Can I search keywords without accounts?** No current verified adapter supports global content search. Supply advertisers; keyword filtering runs after permitted public enrichment.

**Why are creative, asset count or landing URL blank?** They were not disclosed or enrichment was unavailable. Inspect null reasons rather than treating unknown as zero or absence.

**Why no removed campaigns?** The source query must be complete, cover prior dates, and pass the grace period. UI completeness is currently unverified. Rolling windows and source failures suppress removal inference.

**Does firstSeenAt mean campaign start?** No, it is the Actor’s first observation. Post Snowflake time is also not ad delivery start.

**Can I get UK/US ads, spend or payer identities?** No verified global source or spend exists in this build. Unsupported countries are skipped. Funding entity is collected only when publicly disclosed.

**Why can a valid prefill fail?** Anonymous access and developer export permissions depend on X. A valid input is not a guarantee of access. Source notes list the outstanding live release checks.

## Responsible use

Use only public regulator-mandated transparency disclosures and optional public advertiser posts. No login walls, fake accounts, CAPTCHA solving, private Ads Manager access or natural-person payment identification. Collect no personal data beyond public advertiser information. X terms restrict scraping without prior written consent; public visibility and the DSA do not automatically grant an extraction license. Users are responsible for applicable law and X’s terms. Keep concurrency low, minimize retention and secure secrets/state. This Actor is not affiliated with or endorsed by X.

## Changelog

1.0.0 — Initial implementation: dynamic source adapters, streaming export normalization, public enrichment, Unicode filters, durable monitor lifecycle, signed digests, four generated reports and synthetic integration tests. Live nonempty release validation remains pending.

## Store metadata

Title: **X (Twitter) Ads Scraper & Competitor Monitor**. Slug: **x-twitter-ads-scraper**.

SEO description: Extract publicly disclosed EU-served X ads, compare advertisers and countries, monitor material campaign changes, and export audit-friendly reports.

Keywords: X, Twitter, ads library, ads transparency, competitor ads, DSA, EU ads, ad repository, advertising intelligence, campaign monitor, targeting, impressions, reach, marketing research, ad creatives.

Categories: Social media; Marketing. Structured metadata is in `.actor/store_metadata.json`.
