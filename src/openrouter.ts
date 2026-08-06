export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const contextLengthCache = new Map<string, number>()

export class OpenRouterError extends Error {}

export async function getModelContextLength(
  model: string,
  apiKey: string,
): Promise<number | null> {
  const cached = contextLengthCache.get(model)
  if (cached !== undefined) return cached

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> }
    const found = (data.data ?? []).find((m) => m.id === model)
    const length = found?.context_length ?? null
    contextLengthCache.set(model, length ?? -1)
    return length
  } catch {
    contextLengthCache.set(model, -1)
    return null
  }
}

/** Эвристика: кириллица ~2 символа/токен, остальное ~4 символа/токен. */
export function estimateTokens(text: string): number {
  let cyr = 0
  let other = 0
  for (const ch of text) {
    if (/\p{Script=Cyrillic}/u.test(ch)) cyr++
    else if (!/\s/u.test(ch)) other++
  }
  return Math.ceil(cyr / 2 + other / 4) + 4
}



async function throwHttpError(res: Response): Promise<never> {
  if (res.status === 429) {
    throw new OpenRouterError('Слишком много запросов к модели, попробуй чуть позже.')
  }
  if (res.status === 402) {
    throw new OpenRouterError('Недостаточно средств на аккаунте OpenRouter.')
  }
  let detail = `HTTP ${res.status}`
  try {
    const j = (await res.json()) as { error?: { message?: string } | string }
    if (typeof j?.error === 'string') detail = j.error
    else if (j?.error?.message) detail = j.error.message
  } catch {
    // тело не JSON — оставляем HTTP-статус
  }
  throw new OpenRouterError(`Ошибка OpenRouter: ${detail}`)
}

function chatRequestBody(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  stream: boolean,
): string {
  return JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
    stream,
  })
}

export async function completeChat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: chatRequestBody(model, messages, maxTokens, false),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) await throwHttpError(res)

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

/** Стриминговый вызов: отдаёт фрагменты текста по мере прихода из SSE. */
export async function* streamAnswer(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
): AsyncGenerator<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: chatRequestBody(model, messages, maxTokens, true),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) await throwHttpError(res)
  if (!res.body) return

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      if (!payload) continue
      try {
        const j = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const delta = j.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // невалидная строка SSE — пропускаем
      }
    }
  }
}