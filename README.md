# X Ads Scraper & Competitor Monitor

An Apify Actor for collecting public disclosures about **X ads served in the EU** and tracking competitor campaigns.

**Status:** automated tests pass, but live extraction and Apify Store publication still need verification.

## Features

- Filter by advertiser, country, keywords and disclosed targeting.
- Enrich public posts with creative text and links when available.
- Track new, changed and removed campaigns.
- Send webhook, Slack or Discord notifications.
- Export JSON, CSV, Excel and HTML reports.

Built with TypeScript, Node.js 24 and the Apify SDK. HTTP handles lightweight requests; Playwright provides browser fallback.

## Quick start

Requires **Node.js 24+**.

```bash
npm ci
npx playwright install --with-deps chromium
```

Edit `example-input.json` with your advertisers, countries and dates, then run:

```bash
APIFY_CLI_DISABLE_TELEMETRY=1 DISABLE_METERING=1 npx apify run --purge --input-file example-input.json
```

Use `sourceMode: "export"` with a permitted developer `xBearerToken` for CSV exports. Keep credentials in secret inputs.

If Chromium cannot be downloaded locally and Google Chrome is already installed,
prefix the run command with `XADS_BROWSER_CHANNEL=chrome`. The cloud Docker image
installs Chromium and needs no channel override. The Actor name is `x-ads-scraper`,
matching the existing Apify deployment.

The browser adapter selects countries and calendar gridcells, then submits Create
report. Temporary 429/5xx errors are retried up to `maxRetries`, using a fresh page
because the export dialog can disable its Cancel button. Failed queries retain
their cause in the log and `ERRORS`; an HTTP error never becomes an empty success.
Successful UI responses without an explicit completeness guarantee remain partial,
including empty arrays, and cannot establish campaign removals.

On Apify, start with **1 GB memory** and a **one-hour timeout**.

## Monitoring and output

Set `mode: "monitor"`, keep a stable `monitorKey`, and schedule sequential runs in Apify. Add notification URLs in the secret input fields.

Removed campaigns require complete queries covering the previous date window. Partial results never establish removal.

Results appear in the dataset. Reports, `SUMMARY` and `ERRORS` are saved in the run key-value store.

## Development

```bash
npm run check    # Static checks, tests and schema validation
npm run test:browser # Browser controls and Apify CLI regressions; requires Chromium
npm run build
npm run demo     # Synthetic sample reports
```

For the browser tests, `XADS_BROWSER_CHANNEL=chrome npm run test:browser` also works
with an installed Google Chrome. These tests use an explicitly synthetic local
page; live extraction is tested separately with `RUN_LIVE_TESTS=1 npm run test:live`.

## Limitations

- EU-served ads only; no global ads library or spend data.
- Advertisers are required for keyword filtering.
- Missing fields remain `null` with a reason.
- Live CSV headers, cloud execution and Console rendering remain unverified.
- Public HTTP access may fail; the official repository API adapter is currently a stub.

Use only permitted public data and comply with X's terms and applicable law. This project is not affiliated with X.

See [source notes](docs/SOURCE_NOTES.md), [delivery report](docs/DELIVERY_REPORT.md) and [input options](.actor/input_schema.json) for details.
