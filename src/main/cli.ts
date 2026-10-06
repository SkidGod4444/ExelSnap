// Headless agent runner — exercises workbook loading + SAPIENT tool calling without Electron.
//   npm run build && node out/main/cli.js --file data.xlsx [--model openhorizon/qwen2.5-7b-q4] [--url http://localhost:11435/v1] "question"
//   node out/main/cli.js --file data.xlsx --schema      (just print what the model would see)
import { parseArgs } from 'node:util'
import type { LlmMessage } from '@shared/types'
import { runAgent } from './core/agent'
import { OpenAICompatibleProvider } from './core/provider'
import { DEFAULT_BASE_URL, FALLBACK_MODEL, openHorizonDefaultModel } from './core/sapient'
import { systemPrompt } from './core/tools'
import { WorkbookSession } from './core/workbook'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string', multiple: true, short: 'f' },
      model: { type: 'string', short: 'm' },
      url: { type: 'string' },
      schema: { type: 'boolean' },
      sql: { type: 'string' }
    }
  })
  const session = await WorkbookSession.create()
  for (const f of values.file ?? []) {
    const att = await session.addFile(f)
    if (att.status === 'error') console.error(`✗ ${att.name}: ${att.error}`)
    else console.error(`✓ ${att.name}: ${att.tables.map((t) => `${t.table} (${t.rowCount} rows)`).join(', ')}`)
  }
  if (values.schema) {
    console.log(systemPrompt(session.tables))
    return
  }
  if (values.sql) {
    console.log(JSON.stringify(await session.query(values.sql), null, 2))
    return
  }
  const question = positionals.join(' ')
  if (!question) throw new Error('Pass a question.')
  const model = values.model ?? openHorizonDefaultModel() ?? FALLBACK_MODEL
  const provider = new OpenAICompatibleProvider(values.url ?? DEFAULT_BASE_URL)
  console.error(`model: ${model}\n`)
  const out: LlmMessage[] = []
  const t0 = Date.now()
  await runAgent({
    provider,
    model,
    session,
    history: [],
    userText: question,
    out,
    onEvent: (e) => {
      if (e.type === 'step-text' && e.text) console.log(`\n💬 ${e.text}`)
      if (e.type === 'tool-start') console.log(`\n🔧 ${e.name} ${JSON.stringify(e.args)}`)
      if (e.type === 'tool-end') console.log(`   → ${e.outcome.error ? 'ERROR ' + e.outcome.error : e.outcome.forModel.split('\n').slice(0, 8).join('\n     ')} (${e.durationMs} ms)`)
    }
  })
  console.error(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s, ${out.length} messages)`)
  session.close()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
