import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatRequestBody, completeChat, estimateTokens, type ChatMessage } from './openrouter.ts'

const messages: ChatMessage[] = [{ role: 'user', content: 'привет' }]

function stubFetch(handler: () => { content: string }): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const { content } = handler()
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { calls: () => calls, restore: () => (globalThis.fetch = original) }
}

test('completeChat повторяет запрос при пустом ответе', async () => {
  const stub = stubFetch(() => ({ content: stub.calls() < 3 ? '' : 'готово' }))
  try {
    const out = await completeChat('k', 'm', messages, 100)
    assert.equal(out, 'готово')
    assert.equal(stub.calls(), 3)
  } finally {
    stub.restore()
  }
})

test('completeChat возвращает пустую строку после всех попыток', async () => {
  const stub = stubFetch(() => ({ content: '' }))
  try {
    const out = await completeChat('k', 'm', messages, 100)
    assert.equal(out, '')
    assert.equal(stub.calls(), 3)
  } finally {
    stub.restore()
  }
})

test('без reasoningMaxTokens поле reasoning не добавляется', () => {
  const body = JSON.parse(chatRequestBody('deepseek/deepseek-r1', messages, 8192, true))
  assert.equal(body.reasoning, undefined)
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 8192)
})

test('reasoningMaxTokens добавляет ограничение reasoning', () => {
  const body = JSON.parse(chatRequestBody('deepseek/deepseek-r1', messages, 8192, true, 4096))
  assert.deepEqual(body.reasoning, { max_tokens: 4096 })
})

test('нулевой reasoningMaxTokens не добавляет поле', () => {
  const body = JSON.parse(chatRequestBody('deepseek/deepseek-r1', messages, 8192, false, 0))
  assert.equal(body.reasoning, undefined)
})

test('estimateTokens растёт с длиной текста', () => {
  assert.ok(estimateTokens('привет мир') > estimateTokens('привет'))
})
