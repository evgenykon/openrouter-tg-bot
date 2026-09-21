/**
 * Очистка ответов модели: контекст и сводки хранятся и отправляются только
 * как обычный текст — без markdown, списков, таблиц, кода и reasoning-блоков.
 */

const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`([^`]*)`/g
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm
const BULLET = /^[ \t]{0,3}[-*+][ \t]+/gm
const ORDERED = /^[ \t]{0,3}\d+[.)][ \t]+/gm
const BOLD_AST = /\*\*([^*]+)\*\*/g
const BOLD_UND = /__([^_]+)__/g
const ITALIC_AST = /\*([^*]+)\*/g
const ITALIC_UND = /_([^_]+)_/g
const BLOCKQUOTE = /^[ \t]{0,3}>[ \t]?/gm
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/gm
const HR = /^[ \t]*([-*_])[ \t]*\1[ \t]*\1[\s\S]*?$/gm
const REASONING_TAG = /<\/?think>/gi
const REASONING_TAG_RU = /<\/?размышлени[ея]>?/gi
const REASONING_BLOCK = /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, '').replace(/[ \t]{2,}/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripMarkup(text: string): string {
  let out = text.replace(/\r\n?/g, '\n')
  out = out.replace(REASONING_BLOCK, ' ')
  out = out.replace(REASONING_TAG, '')
  out = out.replace(REASONING_TAG_RU, '')
  out = out.replace(CODE_FENCE, ' ')
  out = out.replace(INLINE_CODE, '$1')
  out = out.replace(HEADING, '')
  out = out.replace(BULLET, '')
  out = out.replace(ORDERED, '')
  out = out.replace(BOLD_AST, '$1')
  out = out.replace(BOLD_UND, '$1')
  out = out.replace(ITALIC_AST, '$1')
  out = out.replace(ITALIC_UND, '$1')
  out = out.replace(BLOCKQUOTE, '')
  out = out.replace(TABLE_ROW, '')
  out = out.replace(HR, '')
  out = out.replace(HTML_TAG, '')
  return tidy(out)
}

/** Сводка дня: только непустые строки, одна строка — одна тема. */
export function normalizeDaySummary(text: string): string {
  return stripMarkup(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}
