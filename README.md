# OpenCode Stats Dashboard

A read-only local usage dashboard for OpenCode. Runtime data comes from
OpenCode's local SQLite database only: no OpenCode HTTP API, no provider API, no
hosted service, no telemetry, and no runtime dependency downloads. All browser
assets are bundled locally.

The dashboard includes Overview, Models, Projects, Tools, Sessions with statistical
detail, and Errors. Recorded assistant-step cost and offline API-equivalent
estimates are separate values. Final operational verification is in progress.

## Requirements

- Node.js **24.4 or newer** (the server runs `.ts` files directly through Node's
  type stripping; there is no server build step)
- npm (for installing dependencies and running scripts)

## Install

```sh
npm install
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

## Database path resolution

1. `--db <path>`
2. nonempty `OPENCODE_DB`
3. `$XDG_DATA_HOME/opencode/opencode.db`
4. `~/.local/share/opencode/opencode.db`

An empty or relative `XDG_DATA_HOME` does not replace the default data home, as
the XDG base directory specification requires. A relative `--db` or
`OPENCODE_DB` path resolves against the working directory.

Use `--db` to point at a backup: `npm run start -- --db /path/to/backup.db`.

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
