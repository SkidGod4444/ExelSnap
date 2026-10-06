import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { useCopy } from '../lib/hooks'

const SQL_KW =
  /\b(select|from|where|group|by|order|limit|having|join|left|right|inner|outer|full|on|as|and|or|not|in|is|null|case|when|then|else|end|with|union|all|distinct|asc|desc|over|partition|between|like|ilike|count|sum|avg|min|max|round|cast|date_trunc|strftime|extract|year|month|coalesce|filter|qualify|pivot|using|offset|true|false)\b/gi

/** Tiny SQL highlighter — enough to make queries scannable without a syntax-highlighting dependency. */
export function highlightSql(code: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    if (m[1]) out.push(<span key={i++} className="tok-com">{m[1]}</span>)
    else if (m[2]) out.push(<span key={i++} className="tok-str">{m[2]}</span>)
    else if (m[3]) out.push(<span key={i++} className="tok-num">{m[3]}</span>)
    else if (m[4] && SQL_KW.test(m[4])) out.push(<span key={i++} className="tok-kw">{m[4]}</span>)
    else out.push(m[0])
    SQL_KW.lastIndex = 0
    last = re.lastIndex
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, copy] = useCopy()
  const isSql = !lang || /sql|duckdb/i.test(lang)
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'sql'}</span>
        <button onClick={() => copy(code)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{isSql ? highlightSql(code) : code}</code>
      </pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            const text = String(children ?? '')
            if (!lang && !text.includes('\n')) return <code>{children}</code>
            return <CodeBlock code={text.replace(/\n$/, '')} lang={lang ?? 'text'} />
          },
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
