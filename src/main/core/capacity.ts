import { cpus, totalmem } from 'node:os'
import type { Backend, DeviceInfo, ModelAdvice } from '@shared/types'

export interface DownloadedModel {
  id: string
  /** Size of the weights on disk in GB (0 when `sapient list` doesn't say). */
  gb: number
}

/** The model family this app's prompts and tool-call recovery are written for and tested on. */
const CATALOG: DownloadedModel[] = [
  { id: 'openhorizon/qwen2.5-0.5b-q4', gb: 0.3 },
  { id: 'openhorizon/qwen2.5-1.5b-q4', gb: 1.1 },
  { id: 'openhorizon/qwen2.5-3b-q4', gb: 2.1 },
  { id: 'openhorizon/qwen2.5-7b-q4', gb: 4.7 }
]

/** Parameter count in billions from a model id ("qwen2.5-7b-q4" → 7); 0 when the id doesn't say (vision/speech models). */
export function modelSize(id: string): number {
  const m = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_])/i.exec(id)
  return m ? Number(m[1]) : 0
}

export function deviceInfo(): DeviceInfo {
  const cores = cpus()
  return { memoryGb: Math.round(totalmem() / 2 ** 30), chip: cores[0]?.model ?? 'Unknown processor', cores: cores.length }
}

/**
 * Memory a model of `gb` on disk needs, fitted to measurements on SAPIENT 0.6.5 (Apple M4, 16 GB)
 * while answering real questions in this app (schema prompt + tools), in GB resident / peak:
 *
 *   CPU    1.5B 1.3 / 1.7   3B 2.2 / 2.8   7B 5.2 / 6.0
 *   GPU    3B 9.3 / 9.4 (4.6 / 7.9 for a one-line prompt); 1.5B 3.0 / 5.0 for a one-line prompt
 *
 * The GPU (Metal) backend keeps its own copy of the weights next to the one in main memory and its
 * working memory grows with the prompt, so it costs several times what the CPU backend does.
 * Hybrid could not be measured (it needs a wgpu build of SAPIENT) and is budgeted like GPU.
 */
export function estimateMemory(gb: number, backend: Backend): { residentGb: number; peakGb: number } {
  if (backend === 'cpu') return { residentGb: gb * 1.02 + 0.15, peakGb: gb * 1.2 + 0.35 }
  const peakGb = gb * 2.9 + 3.4
  return { residentGb: peakGb - 0.1, peakGb }
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * Every chat model that is downloaded or worth downloading, with what it costs on this computer.
 * "Fits" leaves half of memory for macOS and other apps; "tight" may push other apps into swap;
 * "too large" is where loading has run this kind of machine out of memory.
 * The recommended model is the most capable one that fits: small models are quick but skip steps
 * and misread results, so there is no reason to settle for one when a bigger one fits.
 */
export function adviseModels(downloaded: DownloadedModel[], backend: Backend, memoryGb: number): ModelAdvice[] {
  const known = new Map(CATALOG.map((m) => [m.id, m.gb]))
  const ids = new Set([...downloaded.filter((m) => modelSize(m.id) > 0).map((m) => m.id), ...known.keys()])
  const onDisk = new Map(downloaded.map((m) => [m.id, m.gb]))
  const advice = [...ids]
    .map((id): ModelAdvice => {
      const sizeGb = onDisk.get(id) || known.get(id) || modelSize(id) * 0.67
      const { residentGb, peakGb } = estimateMemory(sizeGb, backend)
      const fit = peakGb <= memoryGb * 0.5 ? 'fits' : peakGb <= memoryGb * 0.7 ? 'tight' : 'too-large'
      return { id, sizeGb: round(sizeGb), residentGb: round(residentGb), peakGb: round(peakGb), fit, downloaded: onDisk.has(id), recommended: false }
    })
    .sort((a, b) => modelSize(a.id) - modelSize(b.id) || a.id.localeCompare(b.id))
  // Prefer a tested catalog model when two are the same size.
  const best = [...advice].reverse().find((m) => m.fit === 'fits' && known.has(m.id)) ?? [...advice].reverse().find((m) => m.fit === 'fits')
  if (best) best.recommended = true
  return advice
}

/** What "Auto" uses: the most capable downloaded model that fits, else the smallest one there is. */
export function autoModel(advice: ModelAdvice[]): string | null {
  const have = advice.filter((m) => m.downloaded)
  return ([...have].reverse().find((m) => m.fit === 'fits') ?? have[0])?.id ?? null
}
