import type { Config } from './config.ts'
import {
  chatParticipants,
  chatSpace,
  compressedDays,
  dmSpace,
  getContext,
  getProfile,
  messagesForDay,
  rawDays,
  type Space,
} from './db.ts'
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

export function clip(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
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

/** Сырые сообщения только непожатых дней (в норме — текущий день), хронологически. */
async function collectHistoryLines(s: Space, config: Config): Promise<string[]> {
  const done = new Set(await compressedDays(s))
  const pending = (await rawDays(s)).filter((day) => !done.has(day)).sort()
  const lines: string[] = []
  for (const day of pending) {
    const msgs = await messagesForDay(s, day)
    for (const m of msgs) {
      lines.push(`${m.name}: ${clip(m.text, config.contextMessageMaxChars)}`)
    }
  }
  return lines
}

function assembleContext(
  profiles: ProfileBlock,
  contextText: string,
  historyLines: string[],
  budget: number,
  config: Config,
): ChatMessage[] {
  const contextLine = contextText
    ? `Контекст предыдущих дней:\n${clip(contextText, config.contextMaxChars)}`
    : ''
  const contextTokens = contextLine ? estimateTokens(contextLine) : 0
  const historyBudget = Math.max(0, budget - profiles.tokens - contextTokens)

  const acc: Accumulator = { tokens: 0, count: 0 }
  const history: ChatMessage[] = []
  for (let i = historyLines.length - 1; i >= 0; i--) {
    const line = historyLines[i]
    if (line === undefined) continue
    if (fits(acc, line, historyBudget, config.maxContextMessages, config.contextMessageMaxChars)) {
      history.push({ role: 'user', content: line })
    }
  }

  const out: ChatMessage[] = [...profiles.messages]
  if (contextLine) out.push({ role: 'user', content: contextLine })
  return [...out, ...history.reverse()]
}

export async function buildGroupContext(
  chatId: number,
  config: Config,
  currentUserId: number,
  currentUserName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)
  const s = chatSpace(chatId)

  const participants = await chatParticipants(chatId)
  participants.set(currentUserId, currentUserName)

  const profiles = await buildProfiles(participants, currentUserId, config.contextMessageMaxChars)
  const contextText = (await getContext(s)).trim()
  const historyLines = await collectHistoryLines(s, config)

  return assembleContext(profiles, contextText, historyLines, budget, config)
}

export async function buildDmContext(
  userId: number,
  config: Config,
  userName: string,
): Promise<ChatMessage[]> {
  const budget = await computeBudget(config)
  const s = dmSpace(userId)

  const profiles: ProfileBlock = { messages: [], tokens: 0 }
  const profile = (await getProfile(userId)).trim()
  if (profile) {
    const line = `Профиль пользователя ${userName} (личные данные, используй для аналитики и вопросов): ${clip(profile, config.contextMessageMaxChars)}`
    profiles.messages.push({ role: 'user', content: line })
    profiles.tokens += estimateTokens(line)
  }

  const contextText = (await getContext(s)).trim()
  const historyLines = await collectHistoryLines(s, config)

  return assembleContext(profiles, contextText, historyLines, budget, config)
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
