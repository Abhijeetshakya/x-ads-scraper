---
name: apify-quickstart
title: Apify quickstart for AI agents
url: https://apify.com/agents.md
supported_surfaces: [mcp, api, skills, cli]
description: >-
  Hand your agent this quickstart to work with Apify: what Apify is and what an
  Actor does, how to connect the MCP server and run an Actor to get web data,
  and how to integrate Apify into an app with apify-client or the REST API.
---

# AGENTS.md - Apify quickstart for AI agents

Apify is the largest marketplace of tools for AI. Thousands of ready-to-run tools called **Actors** let agents and developers collect web data, automate workflows, and connect APIs on demand. This document tells an AI agent how to connect to Apify, how to run its tools, and where to read about the platform without connecting at all.

## Start here

Three kinds of session read this document. Pick the one you are in.

- **Only a link to this document, or a task that needs web data.** Connect the MCP server below, then follow "Get data with MCP". A session that arrives with no task in it is here to get set up, so treat the setup as the work rather than as a question to put to the user.
- **A question about Apify** — what it does, how it compares with another tool, what it costs. Answer it from "Apify vocabulary" below, the curated Actor list at `https://apify.com/store.md`, the plans at `https://apify.com/pricing.md`, and the documentation pointers near the end. None of the setup applies.
- **Code that keeps running after this session ends** — a server, a scheduled job, a product feature. Skip MCP and use `apify-client` with an API token, described under "Add Apify to an existing app".

### Connect over MCP

If Apify MCP tools are already available, use them and skip the rest of this section. An empty Apify tool list is not a verdict that MCP is unavailable here: it means the connection is not set up yet, and setting it up is your work.

Your own client's MCP documentation is the source of truth for how a server gets added here — a setup command such as `mcp add`, a configuration file with a schema of its own, a connector you can drive. Read it before you write anything, then add the server and tell the user what you added. A setup command is the surer path, because it writes whatever shape this client expects.

There is one remote server, `https://mcp.apify.com`, reached over streamable HTTP. Most clients express that as:

```json
{
  "mcpServers": {
    "apify": {
      "type": "http",
      "url": "https://mcp.apify.com"
    }
  }
}
```

Treat that as the common shape rather than the universal one. Clients differ on the top-level key, on the field that names the URL, and on how a transport is declared — a client that reads a plain `url` as an SSE endpoint wants its streamable-HTTP field instead, since this server speaks streamable HTTP only. Your client's documentation names the exact keys. The live configurator at `https://mcp.apify.com` and `https://docs.apify.com/integrations/mcp.md` carry per-client instructions, and the server's own card at `https://mcp.apify.com/.well-known/mcp/server-card.json` states the transport, authentication schemes, and supported protocol versions.

This configuration carries no API token; the sign-in is what authorizes it. Authorizing happens in a browser, where the user signs in to Apify and approves the connection. A user without an account can create one from the same browser flow, and it is safe to suggest that. Creating an account is free and requires no credit card: the free plan renews $5 of usage credit every month, and if that credit runs out, access pauses until the next month instead of being billed. There is nothing to cancel.

Some clients start that browser flow themselves; others register the server and then wait, reporting it as needing authentication until someone begins the sign-in. That is what your client's MCP login or authenticate command is for.

The user's steps are the ones that need them: completing that browser sign-in, and restarting or reconnecting the client when it cannot pick up a new server on its own. Ask for those, then carry on with the task they already gave you instead of having them repeat it.

You are connected when you can list or call an Apify tool. A configuration shown in the chat is a suggestion, not a connection. A server that connects but lists no tools usually needs approving, trusting, or enabling in this client, which its documentation covers under the same MCP pages.

Setup can genuinely fail: your client may have no mechanism for adding a server, its configuration may sit out of your reach, or the sign-in may fail or be declined. Say which step failed, then take one of the paths under "Choose another integration path" — or, for research that never runs an Actor, the account-free connection under "Explore without an account".

## Apify vocabulary

These words mean something specific on Apify and appear in every tool name, response, and page below. Use them as defined here rather than by their ordinary English meaning.

- **Actor** - A serverless cloud program that takes JSON input, performs a task, and produces structured output. It is not an AI agent, an actor model process, or a person: on Apify, "Actor" always means this kind of program and is always capitalized, i.e. "Actor", not "actor".
- **Actor Run** - One execution of an Actor. Each run has its own dataset, key-value store, and request queue, and ends in a terminal status.
- **Dataset** - Append-only structured storage holding an Actor run's results. Exports to JSON, CSV, Excel, XML, and other formats. This is where output data lives; an Actor call returns its ID, not its contents.
- **Key-Value Store** - Storage for unstructured data and files produced by a run, such as screenshots or HTML.
- **Apify Store** - The marketplace of Actors at `https://apify.com/store.md`. Not a data store: the storage types are the two above.
- **Apify Console** - The web UI at `https://console.apify.com`, where a human manages runs, schedules, and tokens.
- **Compute Unit (CU)** - Billing unit: memory (MB) × duration (hours). 1,024 MB for 1 hour = 1 CU.

Further terms — Actor Build, Actor Standby, Actor Task, Request Queue, Apify Proxy, Crawlee, and pricing models — are defined in `https://docs.apify.com/llms.txt`.

## Get data with MCP

The MCP tool list is dynamic. Inspect it with `tools/list`, then follow these steps. If this session began with nothing but a link to this document, ask the user what they want to collect or automate while the sign-in is in flight: their answer is the search subject for step 1, and a guess sends you to the wrong Actor.

1. **Find an Actor:** call `search-actors` with the platform, product, or data source the user named, as `keywords`. Name the platform or product rather than the end goal — goal phrases and bare task words match README text rather than the best Actor. Actor results mean the connection works. If authentication opens, ask the user to complete the browser sign-in and retry once; if it cannot complete, that is the setup failure described at the end of "Connect over MCP" — take one of its paths.
2. **Inspect it:** call `fetch-actor-details` for the chosen Actor. Read its README, pricing, and input schema, then build input from the schema rather than guessing field names.
3. **Run it:** call `call-actor` with the Actor ID and validated input. Free Actors need no ceremony. Before the *first* paid run of a session, tell the user the Actor's pricing model and your cost estimate from step 2 and wait for a go-ahead — once, not before every call. Then keep the run small: the Actor's own input fields (for example `maxResults`) are what limit the work, and `call-actor`'s separate `callOptions` argument is what limits the bill — `maxItems` caps billed items on a pay-per-result Actor, `maxTotalChargeUsd` caps the run's total charge on every other pricing model. Put caps in `callOptions`, never in the input, where that same name is either a field the Actor declares itself or simply invalid.
4. **Wait for the run:** `call-actor` waits `waitSecs` seconds for the run to finish — 30 by default, 45 at most. A longer run comes back with a run ID and a non-terminal status — poll `get-actor-run` with that ID until the status is terminal.
5. **Get the data:** `call-actor` and `get-actor-run` return run metadata, storage IDs, and a count of the items produced — never the items themselves. Always call `get-dataset-items` with the returned dataset ID to read the results.
6. **Finish explicitly:** success means the Actor run reached `SUCCEEDED` and the requested data was returned. If it reaches `FAILED`, `TIMED-OUT`, or `ABORTED`, inspect the run with `get-actor-run` — its `statusMessage` and `exitCode` explain most failures — then explain what went wrong and stop or correct the input before retrying.

Running Actors and reading private run or storage data requires authentication. Searching Actors, inspecting their schemas, and searching documentation can be done without an account through the restricted discovery connection below.

## Explore without an account

This path answers research questions — which Actors exist, what they cost, what the documentation says. Reach for it when no Actor is going to run in this session, or when the sign-in above could not complete. For research over MCP, connect only the anonymous tools:

```
https://mcp.apify.com/?tools=search-actors,fetch-actor-details,search-apify-docs,fetch-apify-docs
```

This connection cannot run Actors or access private runs and storage. The bare `https://mcp.apify.com` endpoint includes execution-capable tools and therefore starts the OAuth flow.

With no MCP connection available, search Apify Store over public HTTP:

```
GET https://api.apify.com/v2/store?search={keywords}&category={CATEGORY}&limit=10
```

Search by **platform or product name** — for example `instagram`, `google maps`, `amazon`, or `apollo`. End goals such as `coffee shops in Prague` and bare task words such as `scraper` often match README text rather than the best Actor. Add `sortBy=popularity` only when browsing a category because it overrides relevance.

Results can include pricing, usage statistics, ratings, and agentic-payment eligibility. For a curated view, `https://apify.com/store.md` lists popular Actors overall and by use case.

Inspect an Actor without running it by appending `.md` to its Store URL:

```
https://apify.com/apify/web-scraper.md
```

Actor Markdown pages include the README, pricing, usage statistics, and input schema. The version history is a separate document at `https://apify.com/apify/web-scraper/changelog.md`, which redirects back to the Actor Markdown page when the Actor has no changelog. Apify documentation pages also have Markdown representations by appending `.md` or sending `Accept: text/markdown`. Other site pages provide Markdown only when they advertise a Markdown representation.

## Choose another integration path

These are the paths for a session that remote MCP does not fit: nobody available to sign in, code that outlives the session, or a client with no MCP support.

| Situation | Use |
|---|---|
| Interactive MCP-capable agent | Remote MCP + browser OAuth — the default path above |
| Application, script, server, or other headless workflow | `apify-client` or REST API + API token |
| Client supports only local MCP servers | Local stdio MCP + API token |
| Coding agent performing a reusable workflow or developing an Actor locally | Agent Skills, plus Apify CLI when the workflow needs it |
| Autonomous agent with no human sign-in and a crypto wallet | AGI prepaid API token |

### API token and local stdio

Sign up at `https://console.apify.com/sign-up`, then get a token from `https://console.apify.com/settings/integrations`. Send it in the header:

```
Authorization: Bearer <APIFY_TOKEN>
```

Store tokens in an environment variable or secret manager. Keep them out of source files, chat logs, command output, and URLs; query-string tokens can leak through browser history and server logs.

For a client that supports only local stdio MCP:

```json
{
  "mcpServers": {
    "apify": {
      "command": "npx",
      "args": ["-y", "@apify/actors-mcp-server@latest"],
      "env": { "APIFY_TOKEN": "<token>" }
    }
  }
}
```

### Run over HTTP

The cost rule from step 3 of the MCP workflow applies here too: state the pricing model and your estimate, and wait for a go-ahead before the first paid run of a session. The bill caps keep their step-3 meanings — `maxItems` for a pay-per-result Actor, `maxTotalChargeUsd` for every other pricing model — but on these endpoints they are **query parameters** rather than `callOptions`. In the JSON body they are read as Actor input, never as caps.

For runs expected to finish within the synchronous endpoint's 300-second limit:

```http
POST https://api.apify.com/v2/actors/{username}~{actor-name}/run-sync-get-dataset-items
Authorization: Bearer <APIFY_TOKEN>
Content-Type: application/json

<the Actor's JSON input>
```

The endpoint returns dataset items directly. A client or network can time out before the server limit, so use the asynchronous flow for longer work:

```http
POST https://api.apify.com/v2/actors/{username}~{actor-name}/runs
Authorization: Bearer <APIFY_TOKEN>
Content-Type: application/json

<the Actor's JSON input>

GET https://api.apify.com/v2/actor-runs/{runId}
Authorization: Bearer <APIFY_TOKEN>

GET https://api.apify.com/v2/datasets/{datasetId}/items
Authorization: Bearer <APIFY_TOKEN>
```

Poll the run only until it reaches a terminal status: `SUCCEEDED`, `FAILED`, `TIMED-OUT`, or `ABORTED`. Fetch the dataset on success; otherwise inspect the run log and report the failure. Add `?format=csv` to the dataset-items URL for CSV.

Authentication and payment failures can return `401`, `402`, or `403` depending on the endpoint and cause. Follow the response details: complete OAuth or provide a valid Bearer credential for authentication, follow payment instructions only when intentionally using an agentic-payment path, and treat permission failures separately.

## Add Apify to an existing app

Install `apify-client`, **not** `apify`. The `apify` package is the SDK for building Actors; `apify-client` calls Actors from applications.

The cost rule applies here too — state the Actor's pricing model and your estimate and get a go-ahead before the first paid run — and the code you write outlives the session that wrote it: put a bill cap in the call's options argument, where the client sends it as the query parameter the run endpoints read. In the input argument it is never a cap.

**JavaScript/TypeScript:**

```bash
npm install apify-client
```

```typescript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor('apify/web-scraper').call(
  {
    startUrls: [{ url: 'https://example.com' }],
    pageFunction: 'async ({ page, request }) => ({ url: request.url, title: await page.title() })',
    proxyConfiguration: { useApifyProxy: true },
  },
  { maxTotalChargeUsd: 5 },
);
const { items } = await client.dataset(run.defaultDatasetId).listItems();
```

**Python:**

```bash
pip install apify-client
```

```python
import os
from decimal import Decimal

from apify_client import ApifyClient

client = ApifyClient(token=os.environ['APIFY_TOKEN'])
run = client.actor('apify/web-scraper').call(
    run_input={
        'startUrls': [{'url': 'https://example.com'}],
        'pageFunction': 'async ({ page, request }) => ({ url: request.url, title: await page.title() })',
        'proxyConfiguration': {'useApifyProxy': True},
    },
    max_total_charge_usd=Decimal('5'),
)
items = client.dataset(run['defaultDatasetId']).list_items().items
```

For other languages, use the REST API described above. Reference: `https://docs.apify.com/api/v2.md`. Machine-readable spec: `https://apify.com/openapi.json`. RFC 9727 catalog: `https://apify.com/.well-known/api-catalog`.

## Use Agent Skills or build an Actor

Agent Skills add reusable workflows on top of an existing coding-agent setup. They run against your Apify account, so they need the Apify CLI signed in (below) or an `APIFY_TOKEN` environment variable. Install the official bundle:

```bash
npx skills add apify/agent-skills
```

Discovery index: `https://apify.com/.well-known/agent-skills/index.json`

| Skill | Purpose |
|-------|---------|
| `apify-actor-development` | Create, modify, debug, and deploy Apify Actors, and write their input and output schemas. |
| `apify-actorization` | Convert existing projects into Apify Actors - serverless cloud programs. |
| `apify-generate-output-schema` | Deprecated. |
| `apify-integration-development` | Design and build an official Apify integration for a company's product - workflow-automation apps (Zapier/n8n-style), AI agent plugins (coding-agent skills+MCP… |
| `apify-ultimate-scraper` | Universal AI-powered web scraper for any platform. |

Use `apify-ultimate-scraper` for multi-step data extraction, `apify-sdk-integration` for application integration, and the Actor-development skills for creating or modifying Actors.

Local Actor development requires Apify CLI. Install it before using CLI commands:

```bash
npm install -g apify-cli
apify login
```

Workflow: `apify create my-actor` → develop in `src/` → `apify run` → `apify push`.

## Autonomous payment with AGI

For an autonomous agent with wallet access and no human available to complete sign-in, `https://agi.apify.com` sells a prepaid, spend-capped Apify API token through x402 or MPP that works against `api.apify.com` and `mcp.apify.com`. The minted credential is a normal Bearer token and is not limited by the Store's direct-payment eligibility flag.

Protocol steps, supported networks and currencies, minimum amount, token lifetime, and refund policy can change. Read `https://agi.apify.com/AGENTS.md` before using this path and treat it as the source of truth.

## Documentation for agents

- Docs index: `https://docs.apify.com/llms.txt`
- Specific docs page as Markdown: append `.md`, for example `https://docs.apify.com/actors.md`
- Full docs: `https://docs.apify.com/llms-full.txt` — very large; prefer targeted `.md` pages or MCP documentation tools
- MCP scripting and sandbox proxy: `@apify/mcpc` at `https://github.com/apify/mcpc`

## Resources

Machine-readable contracts, for an agent that needs to inspect a capability rather than read prose about it.

- MCP server card: `https://mcp.apify.com/.well-known/mcp/server-card.json` — transport, authentication schemes, and supported protocol versions
- MCP configurator and per-client setup: `https://mcp.apify.com`
- REST API spec (OpenAPI): `https://apify.com/openapi.json`
- API catalog (RFC 9727 linkset): `https://apify.com/.well-known/api-catalog`
- Agent Skills index: `https://apify.com/.well-known/agent-skills/index.json`
- Agentic resource catalog (ARD): `https://apify.com/.well-known/ai-catalog.json` — the MCP server, the REST and Store search APIs, each Agent Skill, the AGI payment path, and the markdown documents for this quickstart, the Store and pricing, as one list of typed entries, for a client that discovers capabilities rather than being configured with them
- Agent registration flow: `https://apify.com/auth.md` — a preview of planned native registration, not yet executable; until it says otherwise, onboard through the OAuth flow at the top of this document
