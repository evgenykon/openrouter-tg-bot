import { createClient, type RedisClientType } from 'redis'
import type { CompressorStore } from './compress.ts'
import { dayKeyFromUnix, dayStartUnix } from './day.ts'

export interface StoredMessage {
  id: number
  userId: number
  name: string
  text: string
  date: number
  isBot: boolean
  isPrompt: boolean
}

export type SpacePrefix = 'chat' | 'dm'

export interface Space {
  prefix: SpacePrefix
  id: number
}

let client: RedisClientType

export async function initRedis(url: string): Promise<void> {
  client = createClient({ url })
  client.on('error', (err) => console.error('[redis]', err))
  await client.connect()
}

export function chatSpace(chatId: number): Space {
  return { prefix: 'chat', id: chatId }
}

export function dmSpace(userId: number): Space {
  return { prefix: 'dm', id: userId }
}

function base(s: Space): string {
  return `${s.prefix}:${s.id}`
}

function messagesKey(s: Space): string {
  return `${base(s)}:messages`
}

function msgKey(s: Space, messageId: number): string {
  return `${base(s)}:msg:${messageId}`
}

function dayMsgsKey(s: Space, day: string): string {
  return `${base(s)}:daymsgs:${day}`
}

function rawDaysKey(s: Space): string {
  return `${base(s)}:raw_days`
}

function indexedKey(s: Space): string {
  return `${base(s)}:indexed`
}

function daysKey(s: Space): string {
  return `${base(s)}:days`
}

function daySummaryKey(s: Space, day: string): string {
  return `${base(s)}:day:${day}`
}

function contextKey(s: Space): string {
  return `${base(s)}:context`
}

function lockKey(s: Space): string {
  return `${base(s)}:compress_lock`
}

function namesKey(s: Space): string {
  return `${base(s)}:names`
}

function usersKey(s: Space): string {
  return `${base(s)}:users`
}

function userChatsKey(userId: number): string {
  return `user:${userId}:chats`
}

function hashToMessage(id: number, h: Record<string, string>): StoredMessage {
  return {
    id,
    userId: Number(h['user_id'] ?? 0),
    name: h['name'] ?? '',
    text: h['text'] ?? '',
    date: Number(h['date'] ?? 0),
    isBot: h['is_bot'] === '1',
    isPrompt: h['is_prompt'] === '1',
  }
}

async function fetchHashes(prefix: string, ids: number[]): Promise<StoredMessage[]> {
  if (ids.length === 0) return []
  const pipe = client.multi()
  for (const id of ids) pipe.hGetAll(`${prefix}${id}`)
  const res = await pipe.exec()
  return ids.map((id, i) => hashToMessage(id, (res[i] ?? {}) as Record<string, string>))
}

async function saveMessage(s: Space, m: StoredMessage, trackMembership: boolean): Promise<void> {
  const day = dayKeyFromUnix(m.date)
  const pipe = client
    .multi()
    .zAdd(messagesKey(s), { score: m.id, value: String(m.id) })
    .hSet(msgKey(s, m.id), {
      user_id: String(m.userId),
      name: m.name,
      text: m.text,
      date: String(m.date),
      is_bot: m.isBot ? '1' : '0',
      is_prompt: m.isPrompt ? '1' : '0',
    })
    .zAdd(dayMsgsKey(s, day), { score: m.id, value: String(m.id) })
    .zAdd(rawDaysKey(s), { score: dayStartUnix(day), value: day })
  if (trackMembership && !m.isBot && m.userId > 0) {
    pipe
      .sAdd(usersKey(s), String(m.userId))
      .hSet(namesKey(s), String(m.userId), m.name)
      .sAdd(userChatsKey(m.userId), String(s.id))
  }
  await pipe.exec()
}

export async function saveChatMessage(chatId: number, m: StoredMessage): Promise<void> {
  await saveMessage(chatSpace(chatId), m, true)
}

export async function saveDmMessage(userId: number, m: StoredMessage): Promise<void> {
  await saveMessage(dmSpace(userId), m, false)
}

export async function updateChatMessageText(
  chatId: number,
  messageId: number,
  text: string,
  isPrompt: boolean,
): Promise<void> {
  const key = msgKey(chatSpace(chatId), messageId)
  if ((await client.exists(key)) === 0) return
  await client.hSet(key, {
    text,
    is_prompt: isPrompt ? '1' : '0',
  })
}

export async function chatMessageIds(chatId: number, maxCount: number): Promise<number[]> {
  return (await client.zRange(messagesKey(chatSpace(chatId)), 0, maxCount - 1, { REV: true })).map(
    Number,
  )
}

export async function chatMessages(chatId: number, maxCount: number): Promise<StoredMessage[]> {
  const ids = await chatMessageIds(chatId, maxCount)
  return fetchHashes(`${base(chatSpace(chatId))}:msg:`, ids)
}

export async function dmMessages(userId: number, maxCount: number): Promise<StoredMessage[]> {
  const ids = (
    await client.zRange(messagesKey(dmSpace(userId)), 0, maxCount - 1, { REV: true })
  ).map(Number)
  return fetchHashes(`${base(dmSpace(userId))}:msg:`, ids)
}

export async function messagesForDay(s: Space, day: string): Promise<StoredMessage[]> {
  const ids = (await client.zRange(dayMsgsKey(s, day), 0, -1)).map(Number)
  return fetchHashes(`${base(s)}:msg:`, ids)
}

export async function rawDays(s: Space): Promise<string[]> {
  return await client.zRange(rawDaysKey(s), 0, -1)
}

export async function compressedDays(s: Space): Promise<string[]> {
  return await client.zRange(daysKey(s), 0, -1)
}

export async function getDaySummary(s: Space, day: string): Promise<string> {
  return (await client.get(daySummaryKey(s, day))) ?? ''
}

export async function setDaySummary(s: Space, day: string, text: string): Promise<void> {
  if (!text.trim()) {
    await client.del(daySummaryKey(s, day))
    return
  }
  await client.set(daySummaryKey(s, day), text)
}

export async function markDayCompressed(s: Space, day: string): Promise<void> {
  await client.zAdd(daysKey(s), { score: dayStartUnix(day), value: day })
}

export async function getContext(s: Space): Promise<string> {
  return (await client.get(contextKey(s))) ?? ''
}

export async function setContext(s: Space, text: string): Promise<void> {
  if (!text.trim()) {
    await client.del(contextKey(s))
    return
  }
  await client.set(contextKey(s), text)
}

export async function getLastCompressedDay(s: Space): Promise<string | null> {
  const res = await client.zRange(daysKey(s), -1, -1)
  return res[0] ?? null
}

export async function pruneDay(s: Space, day: string): Promise<void> {
  const ids = await client.zRange(dayMsgsKey(s, day), 0, -1)
  const pipe = client.multi().del(dayMsgsKey(s, day)).zRem(rawDaysKey(s), day)
  for (const id of ids) {
    pipe.del(msgKey(s, Number(id))).zRem(messagesKey(s), id)
  }
  await pipe.exec()
}

/**
 * Атомарная фиксация сжатого дня: сводка, блок контекста, индекс сжатых,
 * удаление дня из сырых и прунинг сообщений — всё в одном MULTI/EXEC.
 */
export async function commitCompression(
  s: Space,
  day: string,
  summary: string,
  context: string,
): Promise<void> {
  const ids = await client.zRange(dayMsgsKey(s, day), 0, -1)
  const pipe = client
    .multi()
    .set(daySummaryKey(s, day), summary)
    .set(contextKey(s), context)
    .zAdd(daysKey(s), { score: dayStartUnix(day), value: day })
    .zRem(rawDaysKey(s), day)
    .del(dayMsgsKey(s, day))
  for (const id of ids) {
    pipe.del(msgKey(s, Number(id))).zRem(messagesKey(s), id)
  }
  await pipe.exec()
}

export async function tryLockCompress(s: Space, ttlSeconds: number): Promise<boolean> {
  const res = await client.set(lockKey(s), String(Date.now()), { NX: true, EX: ttlSeconds })
  return res === 'OK'
}

export async function refreshLockCompress(s: Space, ttlSeconds: number): Promise<void> {
  await client.expire(lockKey(s), ttlSeconds)
}

export async function unlockCompress(s: Space): Promise<void> {
  await client.del(lockKey(s))
}

/**
 * Одноразовая миграция: пока индекс не помечен, строим `daymsgs`/`raw_days`
 * (и членство для групп) из существующих хэшей. Отдельный маркер нужен потому,
 * что новые сообщения создают `raw_days` раньше, чем просканирована старая история.
 */
export async function reindexDays(s: Space): Promise<void> {
  if ((await client.exists(indexedKey(s))) === 1) return
  const ids = (await client.zRange(messagesKey(s), 0, -1)).map(Number)
  if (ids.length === 0) return

  const msgs = await fetchHashes(`${base(s)}:msg:`, ids)
  const pipe = client.multi()
  const names: Record<string, string> = {}
  let touched = false
  for (const m of msgs) {
    if (!m.date) continue
    const day = dayKeyFromUnix(m.date)
    pipe
      .zAdd(dayMsgsKey(s, day), { score: m.id, value: String(m.id) })
      .zAdd(rawDaysKey(s), { score: dayStartUnix(day), value: day })
    touched = true
    if (s.prefix === 'chat' && !m.isBot && m.userId > 0) {
      pipe.sAdd(usersKey(s), String(m.userId)).sAdd(userChatsKey(m.userId), String(s.id))
      names[String(m.userId)] = m.name
    }
  }
  if (Object.keys(names).length > 0) pipe.hSet(namesKey(s), names)
  if (touched) {
    await pipe.exec()
    await client.set(indexedKey(s), '1')
  }
}

/** Переносит старую сводку (`chat:{id}:summary`) в блок контекста и удаляет её. */
export async function foldLegacySummary(s: Space): Promise<void> {
  if (s.prefix !== 'chat') return
  const legacy = (await client.get(`${base(s)}:summary`))?.trim()
  if (!legacy) return
  if (!(await getContext(s)).trim()) await setContext(s, legacy)
  await client.del([`${base(s)}:summary`, `${base(s)}:summary_date`])
}

export async function chatParticipants(chatId: number): Promise<Map<number, string>> {
  const raw = (await client.hGetAll(namesKey(chatSpace(chatId)))) as Record<string, string>
  const out = new Map<number, string>()
  for (const [id, name] of Object.entries(raw)) out.set(Number(id), name)
  return out
}

async function deletePattern(pattern: string): Promise<void> {
  const keys: string[] = []
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    keys.push(...batch)
  }
  if (keys.length > 0) await Promise.all(keys.map((key) => client.del(key)))
}

export async function resetChat(chatId: number): Promise<void> {
  const s = chatSpace(chatId)
  const users = await client.sMembers(usersKey(s))
  if (users.length > 0) {
    const pipe = client.multi()
    for (const uid of users) pipe.sRem(userChatsKey(Number(uid)), String(chatId))
    await pipe.exec()
  }
  await deletePattern(`${base(s)}:*`)
}

export async function resetDm(userId: number): Promise<void> {
  await deletePattern(`${base(dmSpace(userId))}:*`)
}

export async function getProfile(userId: number): Promise<string> {
  const v = await client.get(`profile:${userId}`)
  return v ?? ''
}

export async function setProfile(userId: number, text: string): Promise<void> {
  if (!text.trim()) {
    await client.del(`profile:${userId}`)
    return
  }
  await client.set(`profile:${userId}`, text)
}

async function chatHasUser(chatId: number, userId: number): Promise<boolean> {
  const ids = await chatMessageIds(chatId, 200)
  if (ids.length === 0) return false
  const msgs = await fetchHashes(`${base(chatSpace(chatId))}:msg:`, ids)
  return msgs.some((m) => m.userId === userId)
}

/** Групповые чаты, где есть пользователь (лички исключены). */
export async function listUserGroupChats(userId: number): Promise<number[]> {
  const direct = await client.sMembers(userChatsKey(userId))
  if (direct.length > 0) {
    return direct.map(Number).filter((id) => Number.isInteger(id))
  }

  const out: number[] = []
  for await (const batch of client.scanIterator({ MATCH: 'chat:*:messages', COUNT: 100 })) {
    for (const key of batch) {
      const m = /^chat:(-?\d+):messages$/.exec(String(key))
      if (!m) continue
      const chatId = Number(m[1])
      if (await chatHasUser(chatId, userId)) {
        await client.sAdd(userChatsKey(userId), String(chatId))
        out.push(chatId)
      }
    }
  }
  return out
}

function storeFor(s: Space): CompressorStore {
  return {
    reindexDays: () => reindexDays(s),
    foldLegacySummary: () => foldLegacySummary(s),
    rawDays: () => rawDays(s),
    compressedDays: () => compressedDays(s),
    messagesForDay: (day) => messagesForDay(s, day),
    commitCompression: (day, summary, context) => commitCompression(s, day, summary, context),
    markDayCompressed: (day) => markDayCompressed(s, day),
    getContext: () => getContext(s),
    tryLock: (ttl) => tryLockCompress(s, ttl),
    touchLock: (ttl) => refreshLockCompress(s, ttl),
    unlock: () => unlockCompress(s),
  }
}

export function chatStore(chatId: number): CompressorStore {
  return storeFor(chatSpace(chatId))
}

export function dmStore(userId: number): CompressorStore {
  return storeFor(dmSpace(userId))
}

export async function closeRedis(): Promise<void> {
  await client.quit()
}
