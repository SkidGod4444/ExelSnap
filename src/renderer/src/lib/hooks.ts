import { useEffect, useState } from 'react'

export function useCopy(timeout = 1500): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), timeout)
    return () => clearTimeout(t)
  }, [copied, timeout])
  return [copied, (text) => void navigator.clipboard.writeText(text).then(() => setCopied(true))]
}

/** Resolve CSS custom properties to concrete colors (SVG chart marks need real values) and track theme changes. */
export function useCssVars(names: string[]): string[] {
  const read = () => {
    const cs = getComputedStyle(document.documentElement)
    return names.map((n) => cs.getPropertyValue(n).trim())
  }
  const [values, setValues] = useState(read)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setValues(read())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join()])
  return values
}

export function useOutsideClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])
}
