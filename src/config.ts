import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

export interface Config {
  botToken: string
  openrouterApiKey: string
  redisUrl: string
  model: string
  allowedUserIds: number[]
  systemPrompt: string
  privateSystemPrompt: string
  maxContextMessages: number
  fallbackContextTokens: number
  safetyMarginPercent: number
  maxTokens: number
  contextMessageMaxChars: number
  contextMaxChars: number
  compressEnabled: boolean
  reasoningMaxTokens: number
}

function loadDotEnv(path: string): void {
  try {
    process.loadEnvFile(path)
  } catch {
    // .env может отсутствовать — секреты могут прийти из окружения
  }
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path} (скопируй config.example.json)`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function reqString(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env variable: ${name}`)
  }
  return v
}

function num(json: Record<string, unknown>, name: string, fallback: number): number {
  const v = json[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function bool(json: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = json[name]
  return typeof v === 'boolean' ? v : fallback
}

export function loadConfig(): Config {
  loadDotEnv('.env')

  const env = process.env as Record<string, string | undefined>
  const json = readJson(process.env.CONFIG_PATH ?? 'config.json')

  const allowed = Array.isArray(json.allowedUserIds)
    ? (json.allowedUserIds as unknown[]).filter((x): x is number => typeof x === 'number')
    : []
  if (allowed.length === 0) {
    throw new Error('config.json: allowedUserIds не может быть пустым')
  }

  return {
    botToken: reqString(env, 'BOT_TOKEN'),
    openrouterApiKey: reqString(env, 'OPENROUTER_API_KEY'),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    model: typeof json.model === 'string' ? json.model : 'openai/gpt-4o-mini',
    allowedUserIds: allowed,
    systemPrompt:
      typeof json.systemPrompt === 'string'
        ? json.systemPrompt
        : 'Ты — доброжелательный психологический помощник. Отвечай на языке пользователя.',
    privateSystemPrompt:
      typeof json.privateSystemPrompt === 'string'
        ? json.privateSystemPrompt
        : 'Ты — доброжелательный психологический помощник. Отвечай на языке пользователя.',
    maxContextMessages: num(json, 'maxContextMessages', 200),
    fallbackContextTokens: num(json, 'fallbackContextTokens', 32768),
    safetyMarginPercent: num(json, 'safetyMarginPercent', 30),
    maxTokens: num(json, 'maxTokens', 1024),
    contextMessageMaxChars: num(json, 'contextMessageMaxChars', 1000),
    contextMaxChars: num(json, 'contextMaxChars', 6000),
    compressEnabled: bool(json, 'compressEnabled', true),
    reasoningMaxTokens: num(json, 'reasoningMaxTokens', 4096),
  }
}
