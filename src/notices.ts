/** Тексты служебных сообщений и ошибок. Только plain text, без markdown. */

export const COMPRESS_START_NOTICE =
  'Начал процедуру сжатия контекста беседы, ответ может занять время…'

export const ERR_MODEL =
  'Не удалось получить ответ от модели. Попробуйте ещё раз позже.'

export function formatDayCompressedNotice(
  day: string,
  dayBefore: number,
  dayAfter: number,
  blockBefore: number,
  blockAfter: number,
): string {
  return (
    `Было произведено сжатие контекста беседы за дату ${day}.\n` +
    `День: прежний объем ${dayBefore} симв., новый объем ${dayAfter} симв.\n` +
    `Блок контекста: прежний объем ${blockBefore} симв., новый объем ${blockAfter} симв.`
  )
}

export function formatConsolidatedNotice(before: number, after: number): string {
  return `Произведена консолидация блока контекста, объем ${before} симв. → ${after} симв.`
}

export function formatDayCompressError(day: string, reason: string): string {
  const tail = reason ? ` ${reason}` : ''
  return `Не удалось сжать контекст за дату ${day}.${tail} Попробую при следующем сообщении.`
}

export function formatModelError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  return ERR_MODEL
}
