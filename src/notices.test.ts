import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERR_MODEL,
  formatConsolidatedNotice,
  formatContextNotice,
  formatDayCompressError,
  formatDayCompressedNotice,
  formatModelError,
} from './notices.ts'

const CHAT = '«Тестовый чат» (-1)'

test('уведомление о сжатии дня начинается с чата, содержит дату и оба объёма', () => {
  const text = formatDayCompressedNotice(CHAT, '2026-09-20', 12340, 1100, 4200, 5100)
  assert.match(text, /^Чат: «Тестовый чат» \(-1\)\n/)
  assert.match(text, /за дату 2026-09-20/)
  assert.match(text, /День: прежний объем 12340 симв\., новый объем 1100 симв\./)
  assert.match(text, /Блок контекста: прежний объем 4200 симв\., новый объем 5100 симв\./)
})

test('уведомление о консолидации', () => {
  assert.equal(
    formatConsolidatedNotice(CHAT, 9000, 5000),
    'Чат: «Тестовый чат» (-1)\n' +
      'Произведена консолидация блока контекста, объем 9000 симв. → 5000 симв.',
  )
})

test('уведомление с содержимым блока контекста', () => {
  const text = formatContextNotice(CHAT, 'Тема: отношения\nПозиция Аня: устала')
  assert.match(text, /^Чат: «Тестовый чат» \(-1\)\nСодержимое блока контекста чата:/)
  assert.match(text, /Позиция Аня: устала/)
})

test('ошибка сжатия дня', () => {
  const text = formatDayCompressError('2026-09-20', 'пустой ответ модели')
  assert.match(text, /Не удалось сжать контекст за дату 2026-09-20\./)
  assert.match(text, /пустой ответ модели/)
  assert.match(text, /Попробую при следующем сообщении\./)
})

test('formatModelError отдаёт сообщение ошибки, иначе шаблон', () => {
  assert.equal(formatModelError(new Error('HTTP 500')), 'HTTP 500')
  assert.equal(formatModelError(undefined), ERR_MODEL)
  assert.equal(formatModelError(new Error('   ')), ERR_MODEL)
})

test('служебные тексты не содержат markdown', () => {
  assert.doesNotMatch(ERR_MODEL, /[*_`#>|]/)
})
