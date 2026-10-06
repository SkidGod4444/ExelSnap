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

## What it reads

`.xlsx` `.xlsm` `.xlsb` `.xls` `.ods` `.csv` `.tsv`, several files per chat (they can be joined in one query).

| In the file | What happens |
|---|---|
| Title rows above the header, tables that start at C5 | Header row is found; title rows are skipped |
| Merged cells, two-row headers ("2024" over "Q1 \| Q2") | Merged values are filled in; columns become `2024 Q1`, `2024 Q2` |
| Several tables stacked on one sheet | Each becomes its own table |
| Total / subtotal rows | Left out when the row is labelled "… total" **and** its number equals the sum of the rows above; named in the table's notes |
| Footer lines ("Source: …") | Left out and named in the notes |
| Numbers typed as text: `1,234.50`, `(250)`, `12.5%`, `€ 99`, `1.234,56` | Read as numbers; decimal comma is decided per column |
| Codes: `00123`, 16-digit card numbers | Stay text (leading zeros and digits are kept) |
| Dates typed as text: `2025-01-31`, `31/01/2025`, `31.01.2025` | Become real dates; if day/month order can't be told, the column stays text and the model is told how to convert it |
| `N/A`, `-`, `#DIV/0!`, `#REF!` | Empty |
| Hidden sheets, formulas without a saved result | Loaded, with a note the model sees |
| Sheet or column names that are SQL words, start with a digit, or use non-Latin scripts | Renamed safely (`select_`, `c_123`) or kept quoted (`"数据"`) |

Every result table and chart has **Export**: the query is run again in full (not just the 500 rows on screen) and
saved as an Excel workbook or CSV, with numbers and dates as real cell values.

Not supported: recalculating formulas (saved results are used), editing the original workbook in place,
tables placed side by side on one sheet, password-protected files, charts/pivot tables/macros inside the file.

`npm test` builds the app and checks all of the above against generated workbooks (`tests/`).

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
sapient pull openhorizon/qwen2.5-7b-q4      # recommended (4.7 GB on disk, about 6 GB of memory)
```

**Auto** in the model menu (top left) uses the most capable downloaded model that loads into half of this
computer's memory, so on a 16 GB Mac it picks the 7B model and on an 8 GB Mac the 3B one. You can still pick any model by hand.

### Headless agent (no UI)

```bash
npm run build
node out/main/cli.js -f samples/sales_demo.xlsx --schema                # what the model sees
node out/main/cli.js -f samples/sales_demo.xlsx --tables                # how each sheet was read (JSON)
node out/main/cli.js -f samples/sales_demo.xlsx --sql "SUMMARIZE sales"  # run SQL directly
node out/main/cli.js -f a.xlsx --sql "SELECT …" --export out.xlsx        # save a full result (.xlsx or .csv)
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
| `src/main/core/workbook.ts` | Parses spreadsheets (SheetJS), finds tables and headers, infers column types (see "What it reads"), loads DuckDB and locks it down, exports results |
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
- 0.5B–3B models can call tools, but they loop, pick odd tools and misread numbers. Use 7B for real work.
- **Memory.** On the default (Metal) backend a model holds about 2.2× its size on disk and peaks at 3.4× while
  loading (3B q4: 4.6 GB resident, up to 7.9 GB peak), and the server keeps the last 3 models loaded. Two models on
  a 16 GB Mac is enough to run it out of memory. ExelSnap therefore starts SAPIENT with `--backend cpu --max-models 1`:
  1.0× resident, 1.3× peak (7B q4: 4.8–5.2 GB, 6.0 GB peak) and no slower at these sizes. A server you start
  yourself uses SAPIENT's defaults; Auto then sizes the model for those.
- When a spreadsheet is attached the first model turn must call a tool (`tool_choice: required`). Without that,
  small models answer from the few example values in the schema instead of querying the file.
