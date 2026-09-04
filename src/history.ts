import type { Config } from './config.ts'
import { chatMessages, dmMessages, getChatSummary, getProfile } from './db.ts'
import { completeChat, estimateTokens, getModelContextLength, type ChatMessage } from './openrouter.ts'

const SUMMARY_MAX_CHARS = 2000
const SUMMARIZE_PROMPT =
  'Ты — инструмент сжатия истории чата для долгосрочного контекста. Сохрани ключевое: участники, обсуждаемые темы, важные события, договорённости, эмоционально значимые моменты, незакрытые вопросы и общий контекст отношений. Пиши кратко, связно, на языке диалога. Не выдумывай и не добавляй лишнего.'

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

interface ProfileBlock {
  messages: ChatMessage[]
  tokens: number
}

async function buildProfiles(
  participants: Map<number, string>,
  currentUserId: number,
  maxChars: number,
): Promise<ProfileBlock> {
  const messages: ChatMessage[] = []
  let tokens = 0
  const ordered = [currentUserId, ...[...participants.keys()].filter((uid) => uid !== currentUserId)]
  for (const uid of ordered) {
    const profile = (await getProfile(uid)).trim()
    const line = profile
      ? `Профиль пользователя ${participants.get(uid)} (личные данные, используй для анализа и уточняющих вопросов): ${clip(profile, maxChars)}`
      : `Профиль пользователя ${participants.get(uid)}: не заполнен`
    messages.push({ role: 'user', content: line })
    tokens += estimateTokens(line)
  }
  return { messages, tokens }
}

export async function buildGroupContext(
  chatId: number,
  config: Config,
  currentUserId: number,
  currentUserName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)

  const feed = await chatMessages(chatId, config.maxContextMessages)
  const participants = new Map<number, string>()
  for (const m of feed) {
    if (m.isBot || m.userId === 0) continue
    participants.set(m.userId, m.name)
  }
  participants.set(currentUserId, currentUserName)

  const profiles = await buildProfiles(participants, currentUserId, config.contextMessageMaxChars)

  const summaryRaw = (await getChatSummary(chatId)).trim()
  const summaryLine = summaryRaw ? `Сводка предыдущего диалога: ${clip(summaryRaw, SUMMARY_MAX_CHARS)}` : ''
  const summaryTokens = summaryLine ? estimateTokens(summaryLine) : 0

  const historyBudget = Math.max(0, budget - profiles.tokens - summaryTokens)
  const acc: Accumulator = { tokens: 0, count: 0 }

  const history: ChatMessage[] = []
  for (const m of feed) {
    const line = `${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`
    if (fits(acc, line, historyBudget, config.maxContextMessages, config.contextMessageMaxChars)) {
      history.push({ role: 'user', content: line })
    }
  }

  const context = [...profiles.messages]
  if (summaryLine) context.push({ role: 'user', content: summaryLine })
  return [...context, ...history.reverse()]
}

export async function buildDmContext(
  userId: number,
  config: Config,
  userName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)

  const profile = await getProfile(userId)
  const profiles: ProfileBlock = { messages: [], tokens: 0 }
  if (profile.trim()) {
    const line = `Профиль пользователя ${userName} (личные данные, используй для аналитики и вопросов): ${clip(profile.trim(), config.contextMessageMaxChars)}`
    profiles.messages.push({ role: 'user', content: line })
    profiles.tokens += estimateTokens(line)
  }

  const historyBudget = Math.max(0, budget - profiles.tokens)
  const acc: Accumulator = { tokens: 0, count: 0 }

  const feed = await dmMessages(userId, config.maxContextMessages)
  const history: ChatMessage[] = []
  for (const m of feed) {
    const line = `${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`
    if (fits(acc, line, historyBudget, config.maxContextMessages, config.contextMessageMaxChars)) {
      history.push({ role: 'user', content: line })
    }
  }

  return [...profiles.messages, ...history.reverse()]
}

/** Сжимает историю группового чата в краткую сводку для последующего контекста. */
export async function compressChat(chatId: number, config: Config): Promise<string> {
  const feed = await chatMessages(chatId, config.maxContextMessages)
  const lines: string[] = []
  for (const m of feed) {
    lines.push(`${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`)
  }
  if (lines.length === 0) return ''
  const content = lines.reverse().join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: SUMMARIZE_PROMPT },
    { role: 'user', content: content },
  ]
  const summary = await completeChat(config.openrouterApiKey, config.model, messages, config.maxTokens)
  return summary.trim()
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
