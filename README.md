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

You don't install SAPIENT yourself. **Every time the app opens** it looks for `sapient` (PATH, `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`):

- not found → it runs SAPIENT's own installer (`install.sh` from the latest release, hybrid build, checksum
  verified by the script) into `~/.local/bin`, no administrator password needed;
- found → it runs `sapient update`, so the engine stays on the latest release.

Both need the network and send none of your data; offline the app uses what is installed. A path in
Settings ▸ SAPIENT binary is used as it is and never updated. `EXELSNAP_SAPIENT_DIR=/some/folder` makes the app use
(and install into) that folder only. The first time, download a model from the prompt on the start screen or the
model menu, or:

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

### Debug log

The app keeps a log of what it does in `<userData>/logs/exelsnap.log` (one JSON object per line, 5 MB, one older
generation kept): start-up and system details, settings changes, the model server's start/stop/errors, every question,
the SQL the model wrote, timings, the decisions the agent loop made (retries, recovered tool calls) and every error from
the main process or the window. It never contains spreadsheet rows or query results, only row and column counts, and
home-directory paths are shortened to `~`.

**Help ▸ Export Debug Log…** (or Settings ▸ Debug log ▸ Export…) saves one file with the system details, settings,
SAPIENT's state, that log and the last 200 lines of SAPIENT's own output — the file to ask a user for with a bug report.

### UI screenshots

`npm run snap` drives the real app (throwaway profile), runs one question through SAPIENT and saves
screenshots of each state to `snaps/`.

### Build the Mac app

Build on the Mac itself — DuckDB's native binding is installed per platform **and per CPU**, so the DMG
is built for the Mac you run this on (Apple Silicon → arm64, Intel → x64):

```bash
npm ci && npm run dist:mac      # → dist/ExelSnap-*.dmg, ad-hoc signed, for this Mac
npm run release:mac             # → signed with your Developer ID and notarized, for distribution
```

`release:mac` (config in `build/release.cjs`) needs a **Developer ID Application** certificate in the login keychain
(Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates ▸ + ▸ Developer ID Application) and notarization credentials:
`xcrun notarytool store-credentials exelsnap --apple-id <id> --team-id <team>` once, then run with
`APPLE_KEYCHAIN_PROFILE=exelsnap`.

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
- **Memory.** Measured on an M4 with 16 GB while answering questions in the app (GB resident / peak):
  CPU 1.5B 1.5 / 1.7, 3B 2.2 / 2.8, 7B 5.2 / 6.0; GPU (wgpu, the hybrid build the app installs) 1.5B 1.4 / 9.5; hybrid 1.5B 2.7 / 10.0;
  GPU on the Metal build 1.5B 6.3, 3B 9.3 / 9.4. The GPU modes spike while weights are uploaded, and SAPIENT keeps the
  last 3 models loaded by default; loading 7B that way ran the Mac out of memory. ExelSnap therefore starts SAPIENT
  with `--max-models 1` and on the CPU unless you choose otherwise.
- **Run models on (Settings): CPU / GPU / Hybrid.** Switching restarts the server. Hybrid (GPU reads the prompt, CPU
  writes the answer) needs a SAPIENT build with wgpu; if the chosen mode isn't in your build, ExelSnap falls back
  to CPU and says so. For a server you started yourself, set the mode you started it in.
- **Which model.** `src/main/core/capacity.ts` estimates each model's memory for the chosen mode. The model menu
  marks every model as recommended / tight / too large for this computer, offers the recommended one as a download
  if you don't have it, and Auto uses the best downloaded one that loads into half of memory. A model that is too
  large is refused instead of loaded. `node out/main/cli.js --advise [--ram 8] [--backend gpu]` prints the same advice.
- When a spreadsheet is attached the first model turn must call a tool (`tool_choice: required`). Without that,
  small models answer from the few example values in the schema instead of querying the file.
