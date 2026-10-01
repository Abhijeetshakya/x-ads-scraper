# X Ads Repository — investigation, 1 October 2026

## Evidence and confidence

Live public page: https://ads.x.com/ads-repository. Official help:
https://help.x.com/en/business-and-advertising/ads-transparency.
The investigation used anonymous browser interaction, public page assets, ordinary
HTTP, and the official documentation. No account, cookie export, application token
extraction, CAPTCHA solving, or Ads Manager access was used. Evidence collected
earlier in this conversation survived as observations; a scratch environment reset
discarded the pending anonymous export before it could be downloaded. Therefore
**no real CSV header or successful export download has been verified**.

Apify documentation was read before implementation: `llms.txt`, `agents.md`, input
schema v1, dataset schema, output schema, key-value stores, and pay-per-event.
Reference copies are in `evidence/`; they are vendor documentation, not instructions
for this project. Store UX reviewed: harshmaur/facebook-ads-library-scraper and
jmlp/meta-ad-library-scraper. Useful conventions: small first-run limits, clear field
availability, advertiser inputs, readable tables, and native exports. No code or
listing text was copied.

## What differs from the supplied hypotheses

1. The UI **already shows results directly**, including embedded public posts,
   targeting and performance cards. Selecting @Nike, France, September 1–30 showed
   "No promoted tweets found". This is an observed UI message, **not proof of zero
   ads**: its JavaScript catches request failures and displays the same empty state.
2. The UI supports a multi-select country list and "Entire EU". Exactly EU27 is
   selectable; EEA non-EU members, Switzerland and the UK were not listed.
3. Public JS includes same-origin JSON services for search and handle resolution.
   They are browser-facing implementation details, **not a documented public API**.
4. The UI links a commercial-communications CSV at
   `https://ton.twitter.com/ads-repository/commercial_communications.csv`; one
   ordinary request returned 404. This is not used as an alternate ads source.
5. The production date-picker minimum in the inspected asset is **2023-08-26**.
6. The export UI still submits only the first selected country (`country`), while
   direct UI search passes the whole `countries` list. Thus multi-country **search**
   is supported; an EU-wide/multi-country **export** has not been verified. Never
   pass an invented EU geo code to GraphQL.

## Endpoints and sanitized contracts

The following were read from the actual assets loaded by the anonymous page:

| Endpoint | Method | Availability |
|---|---|---|
| `/ads-repository/api/user-search` on `ads.x.com` | POST | Anonymous UI service, feature-gated |
| `/ads-repository/api/ads-search` on `ads.x.com` | POST | Anonymous UI service, feature-gated |
| `/graphql/{discovered ID}/CreateExportReportMutation` on `api.x.com` | POST | Documented export operation |
| `/graphql/{discovered ID}/GetExportReportStatusQuery` on `api.x.com` | GET | Documented export operation; use URL-encoded variables as current UI does |
| `/1.1/users/search.json` on `api.x.com` | GET | Legacy anonymous UI resolution path; not called directly by this Actor |
| `/1.1/guest/activate.json` on `api.x.com` | POST | Browser manages its own guest session; Actor never extracts credentials |
| `https://publish.twitter.com/oembed` | GET | Public post enrichment; official oEmbed interface |
| `https://api.x.com/2/tweets/{id}` | GET | Optional official API v2 media lookup with user-supplied bearer token |

Public UI requests:

```json
{"screenName":"Nike"}
```

```json
{"userId":"8940342","countries":["FR"],"startDate":"2026-09-01","endDate":"2026-09-30"}
```

The inspected UI sends `userId` as a JavaScript number. This Actor sends JSON numeric
lexemes without floating-point conversion where that transport requires a number.
All internal and output IDs are strings. The source itself may have precision
limitations for large advertiser IDs; such values must not silently round.

UI search consumes `{ "ads": [...] }`. Card code references `tweetId`, `lineItemId`,
`country`, `account.name`, `promotedTweet.approvalStatus`,
`fundingInstrument.fundingInstrumentType`, `fundingInstrument.currency`,
`targeting[].targetingName`, `targeting[].targetingType`, `impressions`, and `reach`.
These are **asset-observed field names**, not a captured nonempty live response.

Documented export creation request (IDs resolved dynamically, never checked in):

```json
{"variables":{"user":"8940342","geoLocation":"FR","deliveryRange":{"start_date":"2026-09-01","end_date":"2026-09-30"}}}
```

Asset-derived response selections (contract fixtures, **not live captures**):

```json
{"data":{"create_digital_services_act_export_insert":{"export_id":"<opaque export ID>"}}}
```

```json
{"data":{"digital_services_act_export_status":{"export_id":"<opaque export ID>","export_status":"Finished","export_download_url":"<host/path supplied by X>"}}}
```

## Authentication and access limits

The public page and advertiser selector rendered anonymously. Clicking Create
report reached a "Preparing your report…" dialog. Completion was not observed.
Official help requires an X developer account/app bearer token for direct export
calls. HTTP export mode uses only the optional secret `xBearerToken` supplied by
the user; missing-token errors explain how to obtain it. Anonymous UI mode lets the
page manage any guest authentication in an isolated browser. No token is copied
from bundles, cookies, headers or another session.

After an environment reset, direct unauthenticated POST requests to both public UI
services returned HTTP 403. This does not establish a bot block or a required login.
HTTP UI transport must be opt-in through `enablePublicUiTransport`; auto probes
it only when enabled, then falls back to the anonymous browser and, when a token
is supplied, the documented export flow. A 403 is never interpreted as an empty
successful query. Responses with an ambiguous completeness contract are partial
and cannot trigger removal notifications.

## Countries and date semantics

Observed list: AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO
SK SI ES SE. "Entire EU" expands to this list for direct UI search. Export mode
uses one country per advertiser/date chunk until X documents a combined export.
Runtime discovery re-reads the public UI assets; if unavailable, EU/EEA defaults
are labelled unverified and unsupported choices are logged. Dates are UTC days;
the calendar uses an exclusive end boundary. The Actor treats user endDate as
inclusive and submits the next UTC day for UI search; export date semantics must
be confirmed with a known ad and are reported in provenance.

## CSV schema: unverified, no invented "real headers"

Official help confirms advertiser, funding entity, main targeting, impressions,
reach and halted ads. Supplied hypotheses additionally mention tweet, line-item,
account IDs, country, funding instrument type/currency, approval status. Tests use
**synthetic** CSV fixtures with explicit labels and plausible aliases for those
fields. They are not advertised as real X exports. Unknown fields are retained in
`extra`. Missing identity/country fields quarantine a row in ERRORS, never generate
an adKey with guessed values. Schema drift marks the affected query partial.

## Rate limits, latency, and terms

No load test was performed. No numeric live rate quota, Retry-After value, or
nonempty export latency was measured. The supplied ~200-second export estimate
is a planning assumption only. Default concurrency is 2, 15-minute export timeout,
exponential polling up to 15 seconds, per-host request pacing, Retry-After and
bounded retries for 429/5xx/over-capacity/network failures. Authentication and other
4xx errors do not retry blindly.

`https://ads.x.com/robots.txt` returned `User-Agent: *` and `Disallow: /transparency/`;
the repository path is not disallowed by that file. Robots permission is not a
legal authorization. X Terms of Service at https://x.com/en/tos restrict scraping
without prior written consent and require published interfaces under applicable
terms. Users must assess permissions and applicable law. Do not infer a general
scraping license from the DSA. Funding-person request forms are outside scope.

Commission announcement, July 2026:
https://digital-strategy.ec.europa.eu/en/news/commission-accepts-xs-corrective-measures-terminate-breaches-dsa
confirms content/targeting filters, direct results, faster delivery, full content,
destination URLs and API commitments, with six months to implement. A future
documented API is not assumed to exist today. ApiAdapter deliberately remains
unavailable without an explicitly implemented, documented client.

## Manual release checks still required

- Capture a nonempty live UI JSON response and confirm whether results are
  paginated/truncated and how completeness is declared.
- Obtain a permitted developer bearer token and finish one export. Save exact
  header line, status values, filename, download host and end-date behavior.
- Verify reordered/new targeting representations and whether metrics are per
  country and per requested date range; reach must not be summed across chunks.
- Confirm export permission tier, current operation discovery, rate/latency and
  any published API documentation. No rotating operation IDs belong in source.
- Recheck countries, earliest date, terms and robots before publication.
- Run the opt-in live smoke test, then Store Console schema/render/build checks.
  Local fixture tests cannot certify Store publication or live completeness.

## Implemented live smoke result

The opt-in Node/Apify run on 1 October 2026 successfully discovered the EU27, current operation definitions and same-origin service paths from the live public assets. Public HTTP probing failed; Chromium was unavailable after browser-install downloads failed. The run exited 91 (NO_WORKING_SOURCE). No nonempty payload or CSV was obtained. This failure is retained as a release gate, not turned into a passing fixture smoke.
