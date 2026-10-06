# ExelSnap

Chat with your spreadsheets, fully offline. A ChatGPT-style desktop app (Electron + React) where a local
model served by **OpenHorizon SAPIENT** answers questions about Excel/CSV files by querying them with **DuckDB**.
Model calls go through the **Vercel AI SDK**, the chat UI is built from **AI Elements**, and chats are stored in **SQLite**.

```
React renderer ──(contextBridge IPC)──▶ Electron main ──▶ agent loop ──▶ SAPIENT  (localhost:11435, via AI SDK)
                                             │                 │
                                             │                 └──▶ tools: run_sql, make_chart
                                             ├──▶ WorkbookSession: SheetJS → typed DuckDB tables (in-memory, sandboxed)
                                             └──▶ Store: chats + settings in SQLite (userData/exelsnap.db)
```

The model never sees the spreadsheet itself — only a compact schema (column names, types, ranges, top
values) plus the results of the queries it asks for. Every number in an answer comes from a DuckDB query
whose result table is shown right under it.

## Run it

```bash
npm install
npm run dev            # app with hot reload
npm run sample         # (re)generate samples/sales_demo.xlsx to try it with
```

SAPIENT must be installed (`npm i -g openhorizon`, then `openhorizon update`). ExelSnap finds the `sapient`
binary (PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) and starts `sapient serve` itself if
it isn't running. Pull a capable model first:

```bash
sapient pull openhorizon/qwen2.5-7b-q4      # recommended (~4.2 GB, needs 16 GB RAM)
```

then pick it from the model menu (top left).

### Headless agent (no UI)

```bash
npm run build
node out/main/cli.js -f samples/sales_demo.xlsx --schema                # what the model sees
node out/main/cli.js -f samples/sales_demo.xlsx --sql "SUMMARIZE sales"  # run SQL directly
node out/main/cli.js -f samples/sales_demo.xlsx -m openhorizon/qwen2.5-7b-q4 "Top 3 products by revenue?"
```

Set `EXELSNAP_DEBUG_LOG=/tmp/exelsnap.jsonl` (app or CLI) to log every request/response sent to SAPIENT.

### UI screenshots

`npm run snap` drives the real app (throwaway profile), runs one question through SAPIENT and saves
screenshots of each state to `snaps/`.

### Build the Mac app

Build on the Mac itself — DuckDB's native binding is installed per platform **and per CPU**, so the DMG
is built for the Mac you run this on (Apple Silicon → arm64, Intel → x64):

```bash
npm ci && npm run dist:mac      # → dist/ExelSnap-*.dmg
```

The app is ad-hoc signed (no Apple Developer ID, not notarized). It runs as-is on the Mac that built it.
On another Mac, Gatekeeper blocks the downloaded copy; clear the quarantine flag once with
`xattr -cr /Applications/ExelSnap.app`. For real distribution, set a Developer ID in `build.mac.identity`,
turn `hardenedRuntime` back on with a `disable-library-validation` entitlement (DuckDB's `.node` file), and notarize.

Spreadsheets can be opened with ExelSnap from Finder ("Open With") or by dropping them on the Dock icon.

## Layout

| Path | What |
|---|---|
| `src/main/core/workbook.ts` | Parses xlsx/xls/csv/ods (SheetJS), detects header rows, drops "Total" rows, infers column types, loads DuckDB, locks it down |
| `src/main/core/sql.ts` | Read-only guard for model-written SQL (DuckDB also has file access + config changes disabled) |
| `src/main/core/model.ts` | Model client on the Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`), recovery of tool calls written as text, request serialization |
| `src/main/core/agent.ts` | Tool loop: model → tools → results → model; loop/empty-reply guards |
| `src/main/core/tools.ts` | `run_sql`, `make_chart` (AI SDK tools with zod schemas) and the system prompt (schema summary) |
| `src/main/core/sapient.ts` | Finds/starts/stops `sapient serve`, lists models |
| `src/main/chat.ts` | Conversations, per-chat DuckDB sessions, agent runs |
| `src/main/store.ts` | SQLite persistence (`node:sqlite`, WAL): one row per chat and per message. Imports the JSON files of older versions once and keeps them as `*.imported` |
| `src/renderer/src` | The ChatGPT-style UI |
| `src/renderer/src/components/ai-elements` | [AI Elements](https://elements.ai-sdk.dev) (conversation, message, prompt input, tool, code block), installed as source with `npx shadcn add @ai-elements/<name>` |
| `src/renderer/src/components/ui`, `styles/tailwind.css` | shadcn/ui primitives and the Tailwind theme that maps their tokens onto the app palette |

## Known SAPIENT behaviour (v0.6.5)

- **With `tools` in the request, replies are not streamed token by token.** SAPIENT generates the whole
  reply, then parses tool calls, then sends it in one chunk. The UI shows a "Thinking" state until then.
- **Overlapping requests corrupt the server's model state.** After two generations ran at the same
  time, every reply became fragments (`"cludes the header row."`, a single `仑`) until the server
  was restarted. ExelSnap therefore sends one request at a time and starts SAPIENT with
  `--max-concurrency 1`. Worth reporting upstream.
- 0.5B–1.5B models can call tools, but they loop, pick odd tools and misread numbers. Use 7B for real work.
