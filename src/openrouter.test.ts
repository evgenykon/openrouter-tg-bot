import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatRequestBody, estimateTokens, type ChatMessage } from './openrouter.ts'

const messages: ChatMessage[] = [{ role: 'user', content: 'привет' }]

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
