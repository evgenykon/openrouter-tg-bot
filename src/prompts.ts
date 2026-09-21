import type { ChatMessage } from './openrouter.ts'

const PLAIN_TEXT_RULES =
  'Формат ответа строго: только обычный текст с переносами строк. ' +
  'Запрещены markdown, списки, нумерация, таблицы, заголовки с решёткой, звёздочки, ' +
  'дефисы в начале строки, обратные кавычки, ссылки, код и вложения.'

export const DAY_SUMMARY_SYSTEM =
  'Ты — инструмент сжатия одного дня переписки для долгосрочного контекста. ' +
  'Сохрани ключевое за день: участников, обсуждаемые темы, важные события, договорённости, ' +
  'эмоционально значимые моменты и незакрытые вопросы. ' +
  'Одна строка — одна тема разговора. Можно добавлять короткие дословные цитаты участников ' +
  'в кавычках, если они передают настроение или яркость эмоций. ' +
  'Не выдумывай и не добавляй лишнего. Пиши на языке диалога. ' +
  PLAIN_TEXT_RULES

export const CONTEXT_MERGE_SYSTEM =
  'Ты ведёшь долгосрочный блок контекста переписки. ' +
  'На входе — текущий блок контекста и сводка нового дня с его датой. Обнови блок, включив новый день. ' +
  'Структура блока: для каждой темы отдельный раздел. В разделе: строка "Тема: <название>", ' +
  'затем строка "Даты: <YYYY-MM-DD, ...>" со всеми датами, когда эта тема обсуждалась, ' +
  'затем позиции сторон (что каждый участник думает, чувствует и хочет), затем тезисы. ' +
  'При обновлении добавляй дату нового дня к тем темам, которых он касается, не дублируя даты; ' +
  'у прежних тем даты сохраняй. Не добавляй дату, если тема в этот день не обсуждалась. ' +
  'После разделов — несколько абзацев общей динамики, мыслей и выводов: что изменилось, ' +
  'что осталось нерешённым, куда движутся отношения. ' +
  'Сохраняй прежние темы, пока они актуальны, объединяй дубли и убирай потерявшее значение. ' +
  'Если участник один, вместо позиций сторон опиши его позицию и динамику. ' +
  PLAIN_TEXT_RULES

export const CONTEXT_CONSOLIDATE_SYSTEM =
  'Сожми блок долгосрочного контекста переписки, сохранив его структуру: темы, строки "Даты:" ' +
  'у каждой темы, позиции сторон, тезисы и абзацы мыслей и выводов. ' +
  'Ничего важного не теряй, объединяй повторы. ' +
  PLAIN_TEXT_RULES

function participantsLine(participants: string[]): string {
  const list = participants.filter((p) => p.trim()).join(', ')
  return list ? `Участники: ${list}.` : ''
}

function messages(system: string, user: string): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildDaySummaryMessages(participants: string[], content: string): ChatMessage[] {
  const head = participantsLine(participants)
  return messages(DAY_SUMMARY_SYSTEM, head ? `${head}\n\n${content}` : content)
}

export function buildMergeMessages(
  participants: string[],
  day: string,
  prevContext: string,
  daySummary: string,
): ChatMessage[] {
  const head = participantsLine(participants)
  const prev = prevContext.trim() || '(пусто)'
  const user =
    `${head}\n\nТекущий блок контекста:\n${prev}\n\nСводка нового дня (${day}):\n${daySummary}`
  return messages(CONTEXT_MERGE_SYSTEM, user)
}

export function buildConsolidateMessages(
  participants: string[],
  context: string,
): ChatMessage[] {
  const head = participantsLine(participants)
  return messages(CONTEXT_CONSOLIDATE_SYSTEM, head ? `${head}\n\n${context}` : context)
}
