import { createClient, type RedisClientType } from 'redis'

export interface StoredMessage {
  id: number
  userId: number
  name: string
  text: string
  date: number
  isBot: boolean
  isPrompt: boolean
}

let client: RedisClientType

export async function initRedis(url: string): Promise<void> {
  client = createClient({ url })
  client.on('error', (err) => console.error('[redis]', err))
  await client.connect()
}

function chatMsgKey(chatId: number, messageId: number): string {
  return `chat:${chatId}:msg:${messageId}`
}

function dmMsgKey(userId: number, messageId: number): string {
  return `dm:${userId}:msg:${messageId}`
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

async function fetchHashes(keyPrefix: string, ids: number[]): Promise<StoredMessage[]> {
  if (ids.length === 0) return []
  const pipe = client.multi()
  for (const id of ids) pipe.hGetAll(`${keyPrefix}${id}`)
  const res = await pipe.exec()
  return ids.map((id, i) => hashToMessage(id, (res[i] ?? {}) as Record<string, string>))
}

export async function saveChatMessage(
  chatId: number,
  m: StoredMessage,
): Promise<void> {
  const pipe = client
    .multi()
    .zAdd(`chat:${chatId}:messages`, { score: m.id, value: String(m.id) })
    .hSet(chatMsgKey(chatId, m.id), {
      user_id: String(m.userId),
      name: m.name,
      text: m.text,
      date: String(m.date),
      is_bot: m.isBot ? '1' : '0',
      is_prompt: m.isPrompt ? '1' : '0',
    })
  await pipe.exec()
}

export async function updateChatMessageText(
  chatId: number,
  messageId: number,
  text: string,
  isPrompt: boolean,
): Promise<void> {
  await client.hSet(chatMsgKey(chatId, messageId), {
    text,
    is_prompt: isPrompt ? '1' : '0',
  })
}

export async function chatMessageIds(
  chatId: number,
  maxCount: number,
): Promise<number[]> {
  return (await client.zRange(`chat:${chatId}:messages`, 0, maxCount - 1, { REV: true })).map(Number)
}

export async function chatMessages(chatId: number, maxCount: number): Promise<StoredMessage[]> {
  const ids = await chatMessageIds(chatId, maxCount)
  return fetchHashes(`chat:${chatId}:msg:`, ids)
}

export async function saveDmMessage(userId: number, m: StoredMessage): Promise<void> {
  const pipe = client
    .multi()
    .zAdd(`dm:${userId}:messages`, { score: m.id, value: String(m.id) })
    .hSet(dmMsgKey(userId, m.id), {
      user_id: String(m.userId),
      name: m.name,
      text: m.text,
      date: String(m.date),
      is_bot: m.isBot ? '1' : '0',
      is_prompt: m.isPrompt ? '1' : '0',
    })
  await pipe.exec()
}

export async function dmMessages(userId: number, maxCount: number): Promise<StoredMessage[]> {
  const ids = (await client.zRange(`dm:${userId}:messages`, 0, maxCount - 1, { REV: true })).map(Number)
  return fetchHashes(`dm:${userId}:msg:`, ids)
}

async function deletePattern(pattern: string): Promise<void> {
  const keys: string[] = []
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    keys.push(...batch)
  }
  if (keys.length > 0) await Promise.all(keys.map((key) => client.del(key)))
}

export async function resetChat(chatId: number): Promise<void> {
  await deletePattern(`chat:${chatId}:*`)
}

export async function resetDm(userId: number): Promise<void> {
  await deletePattern(`dm:${userId}:*`)
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

export async function closeRedis(): Promise<void> {
  await client.quit()
}
