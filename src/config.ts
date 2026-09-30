import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

export interface Config {
  botToken: string
  openrouterApiKey: string
  redisUrl: string
  model: string
  allowedUserIds: number[]
  ownerId?: number
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
  compressModel: string
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

function optionalNum(json: Record<string, unknown>, name: string): number | undefined {
  const v = json[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(json: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = json[name]
  return typeof v === 'boolean' ? v : fallback
}

/** Env-переопределения: пустая строка значит «не задано» — берём значение из config.json. */
function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]?.trim()
  return v ? v : undefined
}

function envNumber(env: Record<string, string | undefined>, name: string): number | undefined {
  const v = envString(env, name)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function envBool(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const v = envString(env, name)?.toLowerCase()
  if (v === undefined) return undefined
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return undefined
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

  const model =
    envString(env, 'MODEL') ??
    (typeof json.model === 'string' ? json.model : 'openai/gpt-4o-mini')

  return {
    botToken: reqString(env, 'BOT_TOKEN'),
    openrouterApiKey: reqString(env, 'OPENROUTER_API_KEY'),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    model,
    allowedUserIds: allowed,
    ownerId: envNumber(env, 'OWNER_ID') ?? optionalNum(json, 'ownerId'),
    systemPrompt:
      typeof json.systemPrompt === 'string'
        ? json.systemPrompt
        : 'Ты — доброжелательный психологический помощник. Отвечай на языке пользователя.',
    privateSystemPrompt:
      typeof json.privateSystemPrompt === 'string'
        ? json.privateSystemPrompt
        : 'Ты — доброжелательный психологический помощник. Отвечай на языке пользователя.',
    maxContextMessages:
      envNumber(env, 'MAX_CONTEXT_MESSAGES') ?? num(json, 'maxContextMessages', 200),
    fallbackContextTokens:
      envNumber(env, 'FALLBACK_CONTEXT_TOKENS') ?? num(json, 'fallbackContextTokens', 32768),
    safetyMarginPercent:
      envNumber(env, 'SAFETY_MARGIN_PERCENT') ?? num(json, 'safetyMarginPercent', 30),
    maxTokens: envNumber(env, 'MAX_TOKENS') ?? num(json, 'maxTokens', 1024),
    contextMessageMaxChars:
      envNumber(env, 'CONTEXT_MESSAGE_MAX_CHARS') ?? num(json, 'contextMessageMaxChars', 1000),
    contextMaxChars:
      envNumber(env, 'CONTEXT_MAX_CHARS') ?? num(json, 'contextMaxChars', 6000),
    compressEnabled: envBool(env, 'COMPRESS_ENABLED') ?? bool(json, 'compressEnabled', true),
    reasoningMaxTokens:
      envNumber(env, 'REASONING_MAX_TOKENS') ?? num(json, 'reasoningMaxTokens', 4096),
    compressModel:
      envString(env, 'COMPRESS_MODEL') ??
      (typeof json.compressModel === 'string' && json.compressModel.trim()
        ? json.compressModel
        : model),
  }
}
