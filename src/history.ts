import type { Config } from './config.ts'
import { chatMessages, dmMessages, getProfile } from './db.ts'
import { estimateTokens, getModelContextLength, type ChatMessage } from './openrouter.ts'

export interface PromptRequest {
  name: string
  text: string
  replyTo?: { name: string; text: string }
}

export function formatCurrentPrompt(p: PromptRequest): string {
  let out = `${p.name}: ${p.text}`
  if (p.replyTo) {
    out += `\n(в ответ на сообщение от ${p.replyTo.name}: ${p.replyTo.text})`
  }
  return out
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

async function modelContextTokens(config: Config): Promise<number> {
  const length = await getModelContextLength(config.model, config.openrouterApiKey)
  return length ?? config.fallbackContextTokens
}

export async function computeBudget(config: Config): Promise<number> {
  const contextLength = await modelContextTokens(config)
  const systemTokens = estimateTokens(config.systemPrompt)
  const margin = config.safetyMarginPercent / 100
  const budget = contextLength - config.maxTokens - systemTokens
  return Math.max(1024, Math.floor(budget * (1 - margin)))
}

interface Accumulator {
  tokens: number
  count: number
}

function fits(
  acc: Accumulator,
  line: string,
  budget: number,
  maxCount: number,
  maxChars: number,
): boolean {
  if (acc.count >= maxCount) return false
  const t = estimateTokens(line)
  if (acc.tokens + t > budget) return false
  acc.tokens += t
  acc.count++
  return true
}

export async function buildGroupContext(
  chatId: number,
  config: Config,
  currentUserId: number,
  currentUserName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)
  const acc: Accumulator = { tokens: 0, count: 0 }
  const out: ChatMessage[] = []

  const feed = await chatMessages(chatId, config.maxContextMessages)
  const participants = new Map<number, string>()
  for (const m of feed) {
    if (m.isBot || m.userId === 0) continue
    participants.set(m.userId, m.name)
  }
  participants.set(currentUserId, currentUserName)
  const ordered = [currentUserId, ...[...participants.keys()].filter((uid) => uid !== currentUserId)]
  for (const uid of ordered) {
    const profile = (await getProfile(uid)).trim()
    const line = profile
      ? `Профиль пользователя ${participants.get(uid)} (личные данные, используй для анализа и уточняющих вопросов): ${profile}`
      : `Профиль пользователя ${participants.get(uid)}: не заполнен`
    if (fits(acc, line, budget, config.maxContextMessages, config.contextMessageMaxChars)) {
      out.push({ role: 'user', content: line })
    }
  }

  const history: ChatMessage[] = []
  for (const m of feed) {
    if (m.isBot || m.isPrompt) continue
    const line = `${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`
    if (fits(acc, line, budget, config.maxContextMessages, config.contextMessageMaxChars)) {
      history.push({ role: 'user', content: line })
    }
  }

  return [...out, ...history.reverse()]
}

export async function buildDmContext(
  userId: number,
  config: Config,
  userName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)
  const acc: Accumulator = { tokens: 0, count: 0 }
  const out: ChatMessage[] = []

  const profile = await getProfile(userId)
  if (profile.trim()) {
    const line = `Профиль пользователя ${userName} (личные данные, используй для аналитики и вопросов): ${profile.trim()}`
    if (fits(acc, line, budget, config.maxContextMessages, config.contextMessageMaxChars)) {
      out.push({ role: 'user', content: line })
    }
  }

  const feed = await dmMessages(userId, config.maxContextMessages)
  const history: ChatMessage[] = []
  for (const m of feed) {
    if (m.isBot) continue
    const line = `${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`
    if (fits(acc, line, budget, config.maxContextMessages, config.contextMessageMaxChars)) {
      history.push({ role: 'user', content: line })
    }
  }

  return [...out, ...history.reverse()]
}

export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const part = rest.slice(0, limit)
    let cut = part.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = part.lastIndexOf('\n')
    if (cut < limit / 2) cut = part.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    chunks.push(part.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}
