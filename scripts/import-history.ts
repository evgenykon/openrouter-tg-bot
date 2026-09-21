/**
 * Импорт истории из HTML-экспорта Telegram Desktop в Redis.
 *
 * Использование:
 *   REDIS_URL=redis://localhost:6379 npx tsx scripts/import-history.ts \
 *     <messages.html> <chatId> [sourceOffsetMinutes=180] [--clear]
 *
 * Пишет сообщения с реальными датами (пересчёт из локального времени экспорта
 * в UTC), строит дневные индексы и помечает чат как проиндексированный.
 * С флагом --clear сначала удаляет все ключи чата.
 */
import { readFileSync } from 'node:fs'
import { createClient } from 'redis'

const MONTHS: Record<string, number> = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
}

function dayKeyFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

function dayStartUnix(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000)
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseDate(title: string, offsetMinutes: number): number | null {
  const m = /(\d{1,2})\s+([^\s,]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})/.exec(title)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS[m[2]?.toLowerCase() ?? '']
  const year = Number(m[3])
  const hh = Number(m[4])
  const mm = Number(m[5])
  const ss = Number(m[6])
  if (month === undefined) return null
  return Math.floor(Date.UTC(year, month, day, hh, mm, ss) / 1000) - offsetMinutes * 60
}

interface ParsedMessage {
  id: number
  userId: number
  name: string
  text: string
  date: number
  isBot: boolean
}

// Служебное: команды и ответы бота-сервиса (не часть терапевтического диалога).
const SERVICE_PREFIXES = [
  'Я — психологический помощник',
  'Ты — дипломированный семейный терапевт',
  'Доступные чаты',
  'Готово.',
  'Начал процедуру сжатия',
  'Было произведено сжатие',
  'Произведена консолидация',
  'Не удалось сжать',
  'Напиши запрос после упоминания',
  'Неизвестная команда',
]

function isServiceMessage(m: ParsedMessage): boolean {
  if (m.text.startsWith('/')) return true
  if (!m.isBot) return false
  return SERVICE_PREFIXES.some((p) => m.text.startsWith(p))
}

interface Author {
  userId: number
  name: string
  isBot: boolean
}

function parseMessages(html: string, offsetMinutes: number): ParsedMessage[] {
  const out: ParsedMessage[] = []
  const blocks = html.split('<div class="message ')
  // В экспорте у последовательных сообщений одного автора (класс "joined")
  // нет ни аватарки, ни from_name — автора наследуем от предыдущего.
  let last: Author = { userId: 0, name: 'Неизвестный', isBot: false }
  for (const block of blocks) {
    if (block.startsWith('service')) continue
    const idMatch = /id="message(\d+)"/.exec(block)
    if (!idMatch) continue
    const id = Number(idMatch[1])
    const titleMatch = /class="pull_right date details" title="([^"]+)"/.exec(block)
    if (!titleMatch) continue
    const date = parseDate(titleMatch[1] ?? '', offsetMinutes)
    if (date === null) continue

    const nameMatch = /<div class="from_name">\s*([\s\S]*?)\s*<\/div>/.exec(block)
    const authorMatch = /author_(\d+)\.jpg/.exec(block)
    if (nameMatch || authorMatch) {
      const name = nameMatch ? htmlToText(nameMatch[1] ?? '') : last.name
      const userId = authorMatch ? Number(authorMatch[1]) : 0
      last = { userId, name: name || 'Неизвестный', isBot: name === 'PsychologyChatBot' }
    }

    const textMatch = /<div class="text">\s*([\s\S]*?)<\/div>/.exec(block)
    const text = textMatch ? htmlToText(textMatch[1] ?? '') : ''
    if (!text) continue
    out.push({ id, userId: last.userId, name: last.name, text, date, isBot: last.isBot })
  }
  return out.sort((a, b) => a.id - b.id)
}

async function main(): Promise<void> {
  const [htmlPath, chatIdArg, offsetArg, ...flags] = process.argv.slice(2)
  if (!htmlPath || !chatIdArg) {
    console.error('usage: import-history.ts <messages.html> <chatId> [offsetMinutes] [--clear]')
    process.exit(1)
  }
  const chatId = Number(chatIdArg)
  const offsetMinutes = offsetArg ? Number(offsetArg) : 180
  const clear = flags.includes('--clear')

  const html = readFileSync(htmlPath, 'utf8')
  const parsed = parseMessages(html, offsetMinutes)
  const skipService = flags.includes('--skip-service')
  const serviceCount = parsed.filter(isServiceMessage).length
  const messages = skipService ? parsed.filter((m) => !isServiceMessage(m)) : parsed
  console.log(
    `parsed ${parsed.length} messages (offset ${offsetMinutes} min), служебных ${serviceCount}, ` +
      `к записи ${messages.length}${skipService ? ' (--skip-service)' : ''}`,
  )
  if (messages.length === 0) return

  if (flags.includes('--dry')) {
    const perDay = new Map<string, number>()
    for (const [i, m] of messages.entries()) {
      const day = dayKeyFromUnix(m.date)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
      const who = m.isBot ? 'BOT' : `${m.name}#${m.userId}`
      const full = m.text.replace(/\n/g, ' ⏎ ')
      const snippet = flags.includes('--full') ? full : full.slice(0, 90)
      console.log(
        `${String(i + 1).padStart(3)} ${new Date(m.date * 1000).toISOString()} ${day} ${who}: ${snippet}`,
      )
    }
    console.log('\n--- по дням ---')
    for (const [day, count] of [...perDay].sort()) console.log(`${day}: ${count}`)
    console.log(`\nвсего ${messages.length} сообщений, ${perDay.size} дней`)
    return
  }

  const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
  client.on('error', (err) => console.error('[redis]', err))
  await client.connect()

  const base = `chat:${chatId}`
  if (clear) {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${base}:*`, COUNT: 100 })) {
      keys.push(...batch)
    }
    if (keys.length > 0) await client.del(keys)
    console.log(`cleared ${keys.length} keys`)
  }

  const pipe = client.multi()
  for (const m of messages) {
    const day = dayKeyFromUnix(m.date)
    pipe.hSet(`${base}:msg:${m.id}`, {
      user_id: String(m.userId),
      name: m.name,
      text: m.text,
      date: String(m.date),
      is_bot: m.isBot ? '1' : '0',
      is_prompt: '0',
    })
    pipe.zAdd(`${base}:messages`, { score: m.id, value: String(m.id) })
    pipe.zAdd(`${base}:daymsgs:${day}`, { score: m.id, value: String(m.id) })
    pipe.zAdd(`${base}:raw_days`, { score: dayStartUnix(day), value: day })
    if (!m.isBot && m.userId > 0) {
      pipe.sAdd(`${base}:users`, String(m.userId))
      pipe.hSet(`${base}:names`, String(m.userId), m.name)
      pipe.sAdd(`user:${m.userId}:chats`, String(chatId))
    }
  }
  pipe.set(`${base}:indexed`, '1')
  await pipe.exec()

  const days = [...new Set(messages.map((m) => dayKeyFromUnix(m.date)))].sort()
  console.log(`imported ${messages.length} messages, ${days.length} days`)
  console.log(`days: ${days.join(', ')}`)
  console.log(`range: ${dayKeyFromUnix(messages[0]!.date)} .. ${dayKeyFromUnix(messages.at(-1)!.date)}`)

  await client.quit()
}

main().catch((err) => {
  console.error('fatal', err)
  process.exit(1)
})
