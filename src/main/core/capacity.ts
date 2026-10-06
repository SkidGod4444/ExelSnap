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

/** Which GPU implementation a SAPIENT build uses: wgpu in the hybrid/GPU builds, MLX in the Apple-only Metal build. */
export type GpuEngine = 'wgpu' | 'metal'

/**
 * Memory a model of `gb` on disk needs, fitted to measurements on SAPIENT 0.6.5 (Apple M4, 16 GB)
 * with a prompt the size this app sends, in GB resident / peak:
 *
 *   CPU             1.5B 1.5 / 1.7   3B 2.2 / 2.8   7B 5.2 / 6.0
 *   GPU (wgpu)      1.5B 1.4 / 9.5      — a large spike while the weights are uploaded
 *   Hybrid (wgpu)   1.5B 2.7 / 10.0
 *   GPU (Metal)     1.5B 6.3 / 6.3   3B 9.3 / 9.4
 *
 * Only the 1.5B model was measured on wgpu (anything larger risked running the machine out of
 * memory), so those two lines scale its ratio and are deliberately on the careful side.
 */
export function estimateMemory(gb: number, backend: Backend, gpu: GpuEngine = 'wgpu'): { residentGb: number; peakGb: number } {
  if (backend === 'cpu') return { residentGb: gb * 1.02 + 0.15, peakGb: gb * 1.2 + 0.35 }
  if (gpu === 'metal') return { residentGb: gb * 2.9 + 3.3, peakGb: gb * 2.9 + 3.4 }
  return backend === 'hybrid' ? { residentGb: gb * 2.45, peakGb: gb * 9.1 } : { residentGb: gb * 1.3, peakGb: gb * 8.6 }
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * Every chat model that is downloaded or worth downloading, with what it costs on this computer.
 * "Fits" leaves half of memory for macOS and other apps; "tight" may push other apps into swap;
 * "too large" is where loading has run this kind of machine out of memory.
 * The recommended model is the most capable one that fits: small models are quick but skip steps
 * and misread results, so there is no reason to settle for one when a bigger one fits.
 */
export function adviseModels(downloaded: DownloadedModel[], backend: Backend, memoryGb: number, gpu: GpuEngine = 'wgpu'): ModelAdvice[] {
  const known = new Map(CATALOG.map((m) => [m.id, m.gb]))
  const ids = new Set([...downloaded.filter((m) => modelSize(m.id) > 0).map((m) => m.id), ...known.keys()])
  const onDisk = new Map(downloaded.map((m) => [m.id, m.gb]))
  const advice = [...ids]
    .map((id): ModelAdvice => {
      const sizeGb = onDisk.get(id) || known.get(id) || modelSize(id) * 0.67
      const { residentGb, peakGb } = estimateMemory(sizeGb, backend, gpu)
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
