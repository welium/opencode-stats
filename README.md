# OpenCode Stats Dashboard

A read-only local usage dashboard for OpenCode. Runtime data comes from
OpenCode's local SQLite database only: no OpenCode HTTP API, no provider API, no
hosted service, no telemetry, and no runtime dependency downloads. All browser
assets are bundled locally.

The dashboard includes Overview, Models, Projects, Tools, Sessions with statistical
detail, and Errors. Recorded assistant-step cost and offline API-equivalent
estimates are separate values.

## Requirements

- Node.js **24 LTS, version 24.15 or newer within 24.x**. The SQLite connection
  uses `limits.attach`, added in 24.15; older versions can silently ignore this
  option. The server runs `.ts`
  files directly through Node's type stripping; there is no server build step.
- npm (for installing dependencies and running scripts)

The minimum follows the [Node 24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html),
not just TypeScript support. Node's built-in SQLite and online backup API require
no separately installed SQLite command-line tool.

## Install

```sh
npm ci
```

A built dashboard runs offline. Dependencies are never installed at startup.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development listener plus the loopback API server behind Vite's `/api` proxy |
| `npm run build` | Build the browser client into `dist/client` |
| `npm run start` | Start the dashboard server; serves the built client from `dist/client` |
| `npm test` | Run the test suite with Node's built-in test runner |
| `npm run typecheck` | Type-check the server project and the client project (`typecheck:server`, `typecheck:client`) |

```sh
npm run build
npm run start                        # binds 127.0.0.1:3848
npm run start -- --host 0.0.0.0      # bind all interfaces
npm run dev -- --host 0.0.0.0        # development listener on all interfaces
```

`npm run start` runs `node src/server/main.ts`, so no build step is needed for the
server. `npm run build` is only needed for the browser client.

If the client has not been built, document requests answer `503` with a local
build instruction while `/api/health` and the rest of the API stay usable. The
server never installs or builds anything at runtime.

## CLI

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <address>` | `127.0.0.1` | Address to listen on |
| `--port <number>` | `3848` | Port to listen on; `0` selects a free port |
| `--db <path>` | resolved (see below) | OpenCode SQLite database to read |
| `--help` | | Print help and exit |
| `--version` | | Print the version and exit |

Arguments are forwarded by npm with `--`, for example
`npm run start -- --host 0.0.0.0 --port 9000`. A port that is already in use is
reported as an error; no other process is terminated and the port is never
changed silently. There is no `--open` in v1: the listening address is printed
and opening a browser is left to you.

### Hosting addresses

The selected host is used exactly as given, including a private address,
`0.0.0.0`, or `::`. No second opt-in flag, confirmation, exposure warning, or
substitution is applied, and there is no Host/Origin allowlist. This keeps
loopback, LAN, VPN, and reverse-proxy access on the same code path. The server
prints the address it bound.

Anyone who can reach a non-loopback listener can read the statistics and session
metadata it exposes, and the dashboard has no built-in login or TLS. Firewall,
NAT, VPN, and authentication decisions belong to whoever runs the server; the
application does not inspect or verify them.

The development listener behaves the same way: `--host` is forwarded to the Vite
listener, and development host checking is disabled so a VPN or NAT hostname
works without an extra flag. In development the API stays on loopback behind
Vite's `/api` proxy.

Development defaults to `127.0.0.1:5173`, with its API on `127.0.0.1:3848`.
`--port` selects the browser port; `--api-port` selects the proxy's API port.
Use Ctrl-C to stop either launcher; SIGTERM also shuts down both development
listeners. Check `curl --fail http://127.0.0.1:3848/api/health` (or development
port 5173) for `status: "ok"`. An unavailable database returns HTTP 503 instead.

## Database path resolution

1. `--db <path>`
2. nonempty `OPENCODE_DB`
3. `$XDG_DATA_HOME/opencode/opencode.db`
4. `~/.local/share/opencode/opencode.db`

An empty or relative `XDG_DATA_HOME` does not replace the default data home, as
the XDG base directory specification requires. A relative `--db` or
`OPENCODE_DB` path resolves against the working directory.

Use `--db` to point at a backup: `npm run start -- --db /path/to/backup.db`.

### Supported storage

The adapter supports the SQLite layout inspected in OpenCode v2.0.28, not older
JSON/JSONL storage. It probes `session_v2`, `session_message`, and `project`,
including the required columns listed in `src/server/database.ts`. Extra columns
are allowed; missing required columns produce an incompatible state. The optional
`kv` catalog only affects estimates. Future or imported schemas and token formats
are not assumed compatible; this tool never migrates them.

### Safe inspection backup

If live read-only access fails, use a consistent backup rather than granting the
dashboard write access. The following POSIX-shell example writes only a new private
temporary destination. Set `SOURCE_DB` to the database you want to inspect first;
the default below is the usual Linux location. It uses SQLite's online backup API
from a read-only source, so committed WAL data is included.

```sh
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
case "$DATA_HOME" in /*) ;; *) DATA_HOME="$HOME/.local/share" ;; esac
SOURCE_DB="${SOURCE_DB:-${OPENCODE_DB:-$DATA_HOME/opencode/opencode.db}}"
export SOURCE_DB
BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opencode-stats.XXXXXXXX")
chmod 700 "$BACKUP_DIR"
export BACKUP_DIR
node --input-type=module <<'JS'
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
process.umask(0o077);
const source = new DatabaseSync(process.env.SOURCE_DB, {
  readOnly: true, allowExtension: false, timeout: 2500, limits: { attach: 0 },
});
try {
  const destination = join(process.env.BACKUP_DIR, 'opencode.db');
  await backup(source, destination);
  chmodSync(destination, 0o600);
} finally {
  source.close();
}
JS
npm run start -- --db "$BACKUP_DIR/opencode.db"
# After stopping the dashboard, remove this private backup:
rm -r -- "$BACKUP_DIR"
```

Backups contain private transcripts and credentials even though the dashboard does
not display them. Never put one in this repository or an issue report. A backup
reflects only its own contents; Refresh cannot fetch newer live data into it.

## Read-only guarantee

OpenCode's records, schema, and configuration are never modified.

- The database is opened with `readOnly: true`, a bounded busy timeout, and
  extension loading disabled.
- Immutable mode is not used, so recent WAL commits stay visible.
- The dashboard never checkpoints, changes journal mode, creates indexes,
  attaches other databases, or executes user-supplied SQL. Query values are
  bound; the only interpolated identifiers are the adapter's own table names.
- Every statistics request reads inside one fresh, short read transaction that
  ends before the response is written, so newly committed data becomes visible
  without restarting either application.
- A missing database is reported as unavailable rather than as an empty usage
  history, and an unsupported schema is unavailable rather than an all-zero
  result. Failed opens are retried on the next request, and a replaced database
  file is detected and reopened.
- Accessing a WAL database may touch SQLite's shared-memory coordination files
  (`-wal`/`-shm`); read-only SQL is not a promise that SQLite never touches them.
  Do not copy `.db`, `-wal`, and `-shm` separately — use SQLite's backup API for a
  consistent snapshot.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Database state and supported-schema status |
| `GET /api/stats/overview` | Assistant usage, activity, agents and estimates |
| `GET /api/stats/models` | Provider/model usage and estimates |
| `GET /api/stats/projects` | Project usage and estimates |
| `GET /api/stats/tools` | Tool outcomes and durations |
| `GET /api/stats/errors` | Assistant error types/models, tool failures and session links |
| `GET /api/sessions` | Searchable, paginated session usage and estimates |
| `GET /api/sessions/:id` | Statistical detail and paginated step metadata |

`/api/health` answers `200` with `status: "ok"` when the database is readable and
schema-compatible, and `503` with `status: "unavailable"` plus a typed error
envelope otherwise. The database state is one of `ready`, `missing`,
`unreadable`, `incompatible`, `corrupt`, `busy`, or `error`.

API responses are always `Cache-Control: no-store` with
`X-Content-Type-Options: nosniff`. Unknown `/api/*` paths always return JSON, never
the SPA document. Unsupported methods return `405` with an `Allow` header.

### Errors and offline estimates

Errors use the same eligible assistant-step, project and range rules as usage.
Only recognized assistant error-name tags and normalized failed tool status are
returned; unknown names become `UnknownError`. Error messages, error data, tool
state and transcripts are not exposed. `/api/stats/errors` accepts `range`,
`projectId`, `limit` (default 50, maximum 200), and `offset` (maximum 1,000,000).
Counts describe the whole selection; entries are paginated newest-first with
stable message/kind tie-breaks. Type/model groups are bounded to the top 100.

Estimates read the optional `kv` entry `models-dev:catalog` on every usage request,
inside the response's read transaction. Its JSON envelope must contain a numeric
`updatedAt` and a JSON-string `body` holding the provider catalog. Missing tables,
missing entries, or malformed catalogs leave recorded usage available. No catalog
refresh, provider discovery, or external request is performed.

Provider/model keys and explicit IDs must match exactly. Prices are finite,
nonnegative USD per million tokens. Each step is priced as
`(input*inputRate + (output+reasoning)*outputRate + cacheRead*cacheReadRate + cacheWrite*cacheWriteRate) / 1,000,000`.
Context is `input + cacheRead + cacheWrite`. Base prices and `tiers` are supported;
the largest context threshold **strictly less** than context applies. Equality
retains the previous tier/base. Tier prices replace, not inherit from, base prices.
The legacy `context_over_200k` field is ignored. Invalid tier descriptors and
duplicate applicable thresholds are rejected rather than guessed.

All five token categories must be measured. A positive category requires its
rate; zero-token categories do not. Explicit zero prices are valid. Missing or
invalid rates produce unpriced steps, not free usage. Responses distinguish
`complete`, `partial` (priced subtotal), and `unavailable`, with unpriced step/model
counts and catalog timestamp. Unpriced identity lists are bounded to 50 rows.
Daily estimates are returned separately from the recorded daily series; the
Overview chart offers an Estimate metric, and chart data tables keep both costs
separate. Partial series are labeled as priced subtotals.
Catalog bodies and arbitrary digest strings are never returned. Current cached
prices are not historical invoices and are never added to recorded cost.

Usage describes assistant-message steps only, excludes copied pre-fork history,
and does not add separate compaction events or session rollups. It is not full
service spending or a claim of billing/CLI parity.

## Ranges and metrics

`7d`, `30d`, and `90d` include today and the preceding N−1 local calendar dates,
from local midnight through the request's captured current instant. `all` has no
lower bound. Bounds are `[from, to)`; daily charts and activity use the **server's
timezone**, returned with the resolved range in each response, not the browser's.
Missing dates have zero activity. Project filters use the owning session.

| Metric | Definition |
| --- | --- |
| Sessions / subagents | Distinct root / child sessions with user or assistant activity in range, including old sessions with new activity |
| Prompts | User messages in root sessions only |
| Steps | Assistant-message rows, including subagents |
| Tokens | Non-overlapping uncached input + visible output + reasoning + cache read + cache write |
| Recorded cost | Recorded assistant costs only; session rollups are never added |
| Cache rate | Summed cache read / (input + cache read + cache write) |
| Assistant errors | Steps with a non-null error, separate from tool failures |
| Tool outcomes | Completed = succeeded; error = failed; other/missing = unfinished |
| Tool failure rate | Failed / (succeeded + failed) |
| Tool duration | Terminal calls with finite nonnegative `completed − (ran ?? created)` from the tool's top-level time |
| p50 / p95 | Arithmetic median / nearest-rank 95th percentile of valid tool durations |
| Active days / longest streak | Dates with steps / longest consecutive run of active dates in range |

Copied messages before a fork's creation are excluded. Model identity comes from
each message's provider/model pair; variants are combined and missing identities
stay in an unknown group. Session detail uses the selected range unless “All
session activity” is chosen; children are not recursively added to parents.
Missing measurements are not zeros: complete combined totals/rates require the
needed coverage; measured subtotals are labeled, and unavailable values show `—`.
TTFT and generation speed are not inferred from completion timestamps.

Refresh re-reads health and every active-page breakdown/detail, without polling.
Inactive pages fetch again on the next visit. API reads bypass HTTP caches; older
in-flight responses cannot overwrite newer results. Inserts, updates, deletions,
catalog changes, recovered missing files and replaced database files are visible
without restarting. Read failures display an error instead of stale fresh values.

### Differences from `opencode stats`

The accounting reference is pinned to OpenCode v2.0.28. This dashboard excludes
separate compaction usage, combines model variants, retains unknown identities,
and leaves zero-denominator rates unavailable rather than zero. Estimates use
current offline rates with stricter missing-rate coverage, not billing invoices.
Compare only identical snapshots, ranges, server timezone and filters; a live CLI
and a frozen backup do not describe the same selection. The CLI is a development
cross-check, never a runtime data source.

## Privacy

The browser receives aggregate usage and statistical session metadata, including
session titles/IDs, project names/worktree paths and model/agent names. These may
still be sensitive. Prompts, reasoning, tool arguments/output, raw errors, provider
state and credentials are not returned. Values are rendered as text, not HTML.
Only theme/range preferences are persisted in browser storage; returned session
data is not. All assets and data requests are same-origin; there are no CDNs,
analytics, update checks or automatic catalog downloads.

## Development notes

- The server runs `.ts` directly, so server code must stay erasable-syntax-only
  TypeScript (no enums, no parameter properties, no namespaces), use explicit
  `.ts` import specifiers, and use `import type` for type-only imports.
- `tsconfig.server.json` covers Node contexts (server, tests, scripts, Vite
  config); `tsconfig.client.json` covers the browser. Vite transforms TypeScript
  but does not type-check it, so `npm run typecheck` runs both projects.
- Client structure lives in `src/client/`, shared response types in
  `src/shared/`, tests and synthetic fixtures in `tests/`.

## Testing

Tests use Node's test runner and build their own SQLite databases under the OS
temporary directory (`TMPDIR`). They never read, copy, or modify the live
OpenCode database, and they need no running OpenCode service, provider
credentials, or network access.

```sh
npm test
```

For the built-client stale-response regression, start the dashboard against a
synthetic fixture and use an installed `playwright-cli` in a fresh named browser
session. The script holds the first Overview response (even ignoring its abort),
refreshes successfully, then releases the older response and asserts unchanged
visible values. It does not write the database.

```sh
playwright-cli -s=refresh open http://127.0.0.1:3848/
playwright-cli -s=refresh run-code --filename=tests/browser/stale-refresh.js
playwright-cli -s=refresh close
```
