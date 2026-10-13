const KEYWORDS = {
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return self True False try while with yield',
  javascript: 'async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new null of return static super switch this throw true false try typeof undefined var void while yield',
  shell: 'if then else fi for do done while case esac function in export set',
  yaml: 'true false null',
  toml: 'true false',
  sql: 'select from where create table index insert into values primary key not null default references on delete cascade',
}
const COMMENT = { python: '#', shell: '#', yaml: '#', toml: '#', javascript: '//', css: null, sql: '--' }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function tokenRegex(lang) {
  const parts = []
  const c = COMMENT[lang]
  if (c) parts.push(`(?<c>${c.replace(/[/-]/g, '\\$&')}.*$)`)
  if (lang === 'html') parts.push('(?<c><!--.*?-->)', '(?<t></?[\\w-]+)')
  parts.push('(?<s>"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)')
  if (lang === 'python') parts.push('(?<d>@[\\w.]+)')
  parts.push('(?<n>\\b\\d[\\d_.]*\\b)')
  const kw = KEYWORDS[lang]
  if (kw) parts.push(`(?<k>\\b(?:${kw.split(' ').join('|')})\\b)`)
  return new RegExp(parts.join('|'), 'g')
}

const cache = new Map()

export function highlightLines(text, lang) {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (!cache.has(lang)) cache.set(lang, tokenRegex(lang))
  const re = cache.get(lang)
  let inDoc = false

  return lines.map((line) => {
    if (lang === 'python') {
      const quotes = (line.match(/"""|'''/g) ?? []).length
      if (inDoc || quotes) {
        const wasIn = inDoc
        if (quotes % 2 === 1) inDoc = !inDoc
        if (wasIn || quotes) return `<span class="tk-s">${esc(line)}</span>`
      }
    }
    re.lastIndex = 0
    let out = ''
    let last = 0
    for (const m of line.matchAll(re)) {
      const kind = Object.entries(m.groups).find(([, v]) => v !== undefined)?.[0]
      out += esc(line.slice(last, m.index)) + `<span class="tk-${kind}">${esc(m[0])}</span>`
      last = m.index + m[0].length
    }
    return out + esc(line.slice(last))
  })
}
