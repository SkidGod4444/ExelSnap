// Read-only guard for model-written SQL. DuckDB is additionally locked down
// (enable_external_access=false, lock_configuration=true), so this is the first of two layers.

const FORBIDDEN =
  /\b(insert|update|delete|drop|create|alter|attach|detach|copy|export|import|install|load|pragma|set|reset|call|checkpoint|vacuum|use|begin|commit|rollback|truncate|grant|revoke|merge)\b/i
const ALLOWED_START = /^(select|with|from|values|pivot|unpivot|table|summarize|describe|show)\b/i
const WRAPPABLE_START = /^(select|with|from|values|pivot|unpivot|table)\b/i

/** Remove comments, string literals and quoted identifiers so keyword checks only see SQL syntax. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
}

/** Returns cleaned SQL (trimmed, no trailing semicolon, fences removed) or throws a model-readable error. */
export function guardSql(input: string): string {
  let sql = input.trim()
  const fence = sql.match(/^```(?:sql|duckdb)?\s*([\s\S]*?)```$/i)
  if (fence) sql = fence[1].trim()
  sql = sql.replace(/;+\s*$/, '').trim()
  if (!sql) throw new Error('Empty SQL query.')
  const bare = stripLiterals(sql)
  if (bare.includes(';')) throw new Error('Only one SQL statement is allowed per call.')
  if (!ALLOWED_START.test(bare.trim())) throw new Error('Only read-only queries (SELECT / WITH / SUMMARIZE / DESCRIBE) are allowed.')
  const bad = bare.match(FORBIDDEN)
  if (bad) throw new Error(`"${bad[1].toUpperCase()}" is not allowed; the data is read-only.`)
  return sql
}

export function isWrappable(sql: string): boolean {
  return WRAPPABLE_START.test(stripLiterals(sql).trim())
}
