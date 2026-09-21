import { dayKeyFromDate } from './day.ts'
import type { StoredMessage } from './db.ts'
import {
  COMPRESS_START_NOTICE,
  formatConsolidatedNotice,
  formatDayCompressError,
  formatDayCompressedNotice,
} from './notices.ts'
import {
  buildConsolidateMessages,
  buildDaySummaryMessages,
  buildMergeMessages,
} from './prompts.ts'
import type { ChatMessage } from './openrouter.ts'
import { normalizeDaySummary, stripMarkup } from './text.ts'

export interface CompressorStore {
  reindexDays(): Promise<void>
  foldLegacySummary(): Promise<void>
  rawDays(): Promise<string[]>
  compressedDays(): Promise<string[]>
  messagesForDay(day: string): Promise<StoredMessage[]>
  /**
   * Атомарно фиксирует сжатие дня: сводка дня, блок контекста, отметка в
   * индексе сжатых, удаление дня из сырых и прунинг сообщений — один MULTI.
   */
  commitCompression(day: string, summary: string, context: string): Promise<void>
  markDayCompressed(day: string): Promise<void>
  getContext(): Promise<string>
  tryLock(ttlSeconds: number): Promise<boolean>
  touchLock(ttlSeconds: number): Promise<void>
  unlock(): Promise<void>
}

export interface CompressorDeps {
  store: CompressorStore
  complete: (messages: ChatMessage[]) => Promise<string>
  participants: string[]
  contextMaxChars: number
  messageMaxChars: number
  notify: (text: string) => Promise<void>
  now?: () => Date
  log?: (message: string) => void
}

const LOCK_TTL_SECONDS = 300

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function errorReason(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  return ''
}

/**
 * Синхронно сжимает все завершённые (кроме текущего) дни, которых ещё нет в
 * индексе сжатых: сводка дня → мерж в блок контекста → консолидация при
 * превышении лимита → прунинг сырья. После каждого дня шлёт уведомление.
 */
export async function runCompressor(deps: CompressorDeps): Promise<void> {
  const { store } = deps
  const log = deps.log ?? (() => {})

  await store.reindexDays()
  await store.foldLegacySummary()

  const today = dayKeyFromDate((deps.now ?? (() => new Date()))())
  const done = new Set(await store.compressedDays())
  const raw = await store.rawDays()
  const missing = raw.filter((day) => day < today && !done.has(day)).sort()

  if (missing.length === 0) return

  if (!(await store.tryLock(LOCK_TTL_SECONDS))) {
    log('compression skipped: lock is held')
    return
  }

  try {
    await deps.notify(COMPRESS_START_NOTICE)

    for (const day of missing) {
      try {
        const feed = await store.messagesForDay(day)
        if (feed.length === 0) {
          await store.markDayCompressed(day)
          continue
        }

        const dayBefore = feed.reduce((sum, m) => sum + m.text.length, 0)
        const content = feed
          .map((m) => `${m.name}: ${clip(m.text, deps.messageMaxChars)}`)
          .join('\n')

        const summary = normalizeDaySummary(
          await deps.complete(buildDaySummaryMessages(deps.participants, content)),
        )
        if (!summary) {
          log(`empty summary for day ${day}, stopping`)
          await deps.notify(formatDayCompressError(day, 'пустой ответ модели'))
          break
        }

        const prevContext = (await store.getContext()).trim()
        let context = stripMarkup(
          await deps.complete(buildMergeMessages(deps.participants, prevContext, summary)),
        )
        if (!context) context = prevContext || summary

        if (context.length > deps.contextMaxChars) {
          const before = context.length
          const consolidated = stripMarkup(
            await deps.complete(buildConsolidateMessages(deps.participants, context)),
          )
          if (consolidated && consolidated.length < before) {
            context = consolidated
            await deps.notify(formatConsolidatedNotice(before, context.length))
          } else if (consolidated) {
            log(`consolidation did not shrink context (${before} -> ${consolidated.length})`)
          }
        }

        await store.commitCompression(day, summary, context)
        await store.touchLock(LOCK_TTL_SECONDS)

        log(`compressed day ${day}: ${dayBefore} -> ${summary.length} chars`)
        await deps.notify(
          formatDayCompressedNotice(day, dayBefore, summary.length, prevContext.length, context.length),
        )
      } catch (err) {
        log(`failed to compress day ${day}: ${String(err)}`)
        await deps.notify(formatDayCompressError(day, errorReason(err)))
        break
      }
    }
  } finally {
    await store.unlock()
  }
}
