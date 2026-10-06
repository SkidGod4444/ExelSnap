// Headless agent runner — exercises workbook loading + SAPIENT tool calling without Electron.
//   npm run build && node out/main/cli.js --file data.xlsx [--model openhorizon/qwen2.5-7b-q4] [--url http://localhost:11435/v1] "question"
//   node out/main/cli.js --file data.xlsx --schema      (just print what the model would see)
//   node out/main/cli.js --advise [--ram 8] [--backend cpu|gpu|hybrid] [--gpu-engine wgpu|metal] [--have id,id]   (which model suits a computer)
//   node out/main/cli.js --file data.xlsx --tables      (how each sheet was read, as JSON)
//   node out/main/cli.js --file data.xlsx --sql "SELECT …" [--export out.xlsx|out.csv]
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { ModelMessage } from 'ai'
import { runAgent } from './core/agent'
import { ModelClient } from './core/model'
import type { Backend } from '@shared/types'
import { adviseModels, autoModel, deviceInfo } from './core/capacity'
import { DEFAULT_BASE_URL, FALLBACK_MODEL, findSapientBinary, listDownloaded, openHorizonDefaultModel } from './core/sapient'
import { systemPrompt } from './core/tools'
import { resultToCsv, resultToXlsx, WorkbookSession } from './core/workbook'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string', multiple: true, short: 'f' },
      model: { type: 'string', short: 'm' },
      url: { type: 'string' },
      schema: { type: 'boolean' },
      tables: { type: 'boolean' },
      sql: { type: 'string' },
      export: { type: 'string' },
      advise: { type: 'boolean' },
      ram: { type: 'string' },
      backend: { type: 'string' },
      have: { type: 'string' },
      'gpu-engine': { type: 'string' },
      // Ask several questions in one chat: -q "first" -q "follow-up"
      question: { type: 'string', multiple: true, short: 'q' }
    }
  })
  if (values.advise) {
    const binary = findSapientBinary()
    const downloaded = values.have !== undefined ? values.have.split(',').filter(Boolean).map((id) => ({ id, gb: 0 })) : binary ? await listDownloaded(binary) : []
    const models = adviseModels(downloaded, (values.backend ?? 'cpu') as Backend, values.ram ? Number(values.ram) : deviceInfo().memoryGb, values['gpu-engine'] === 'metal' ? 'metal' : 'wgpu')
    console.log(JSON.stringify({ device: deviceInfo(), auto: autoModel(models), models }, null, 2))
    return
  }
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
  if (values.tables) {
    console.log(JSON.stringify(session.tables, null, 2))
    return
  }
  if (values.sql && values.export) {
    const result = await session.queryAll(values.sql)
    writeFileSync(values.export, /\.csv$/i.test(values.export) ? resultToCsv(result) : resultToXlsx(result))
    console.error(`wrote ${result.rowCount} rows to ${values.export}`)
    return
  }
  if (values.sql) {
    console.log(JSON.stringify(await session.query(values.sql), null, 2))
    return
  }
  const questions = values.question ?? (positionals.length ? [positionals.join(' ')] : [])
  if (questions.length === 0) throw new Error('Pass a question.')
  const model = values.model ?? openHorizonDefaultModel() ?? FALLBACK_MODEL
  const provider = new ModelClient(values.url ?? DEFAULT_BASE_URL)
  console.error(`model: ${model}\n`)
  const history: ModelMessage[] = []
  for (const question of questions) {
    if (questions.length > 1) console.log(`\n❓ ${question}`)
    const out: ModelMessage[] = []
    const t0 = Date.now()
    await runAgent({
      provider,
      model,
      session,
      history,
      userText: question,
      out,
      onEvent: (e) => {
        if (e.type === 'step-text' && e.text) console.log(`\n💬 ${e.text}`)
        if (e.type === 'tool-start') console.log(`\n🔧 ${e.name} ${JSON.stringify(e.args)}`)
        if (e.type === 'tool-end') console.log(`   → ${e.outcome.error ? 'ERROR ' + e.outcome.error : e.outcome.forModel.split('\n').slice(0, 8).join('\n     ')} (${e.durationMs} ms)`)
      }
    })
    history.push(...out)
    console.error(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s, ${out.length} messages)`)
  }
  session.close()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
