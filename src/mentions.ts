import type { Message } from '@grammyjs/types'

export function isMentioningBot(
  msg: Message,
  botId: number,
  botUsername: string,
): boolean {
  if (!msg.text) return false
  for (const e of msg.entities ?? []) {
    if (e.type === 'mention') {
      const token = msg.text.slice(e.offset, e.offset + e.length)
      if (token.toLowerCase() === `@${botUsername.toLowerCase()}`) return true
    } else if (e.type === 'text_mention' && e.user.id === botId) {
      return true
    }
  }
  return false
}

export function isCommandMessage(msg: Message): boolean {
  return (msg.entities ?? []).some((e) => e.type === 'bot_command')
}

/** Возвращает текст сообщения без самой команды (/cmd или /cmd@botname). */
export function stripCommand(text: string, botUsername: string): string {
  return text
    .replace(new RegExp(`^/\\w+@${escapeRegExp(botUsername)}\\s*`, 'i'), '')
    .replace(/^\/\w+\s*/, '')
    .trimStart()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Убирает из текста упоминания бота (@username и text_mention), чистит пунктуацию. */
export function stripMention(
  text: string,
  msg: Message,
  botId: number,
  botUsername: string,
): string {
  const spans: Array<[number, number]> = []
  for (const e of msg.entities ?? []) {
    if (e.type === 'mention') {
      const token = text.slice(e.offset, e.offset + e.length)
      if (token.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        spans.push([e.offset, e.offset + e.length])
      }
    } else if (e.type === 'text_mention' && e.user.id === botId) {
      spans.push([e.offset, e.offset + e.length])
    }
  }
  if (spans.length === 0) return text.trim()

  let out = ''
  let last = 0
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    out += text.slice(last, start)
    last = end
  }
  out += text.slice(last)

  return out
    .replace(/^[\s,.:;!?]+/, '')
    .replace(/[\s,.:;!?]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function displayName(msg: Message): string {
  const u = msg.from
  if (!u) return 'Неизвестный'
  const first = u.first_name ?? ''
  const last = u.last_name ?? ''
  const full = `${first} ${last}`.trim()
  return full || (u.username ? `@${u.username}` : `id${u.id}`)
}

export function displayNameOf(from: { id: number; first_name?: string; last_name?: string; username?: string }): string {
  const first = from.first_name ?? ''
  const last = from.last_name ?? ''
  const full = `${first} ${last}`.trim()
  return full || (from.username ? `@${from.username}` : `id${from.id}`)
}
