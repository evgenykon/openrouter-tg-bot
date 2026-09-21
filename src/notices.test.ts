import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPRESS_START_NOTICE,
  ERR_MODEL,
  formatConsolidatedNotice,
  formatDayCompressError,
  formatDayCompressedNotice,
  formatModelError,
} from './notices.ts'

test('уведомление о сжатии дня содержит дату и оба объёма', () => {
  const text = formatDayCompressedNotice('2026-09-20', 12340, 1100, 4200, 5100)
  assert.match(text, /за дату 2026-09-20/)
  assert.match(text, /День: прежний объем 12340 симв\., новый объем 1100 симв\./)
  assert.match(text, /Блок контекста: прежний объем 4200 симв\., новый объем 5100 симв\./)
})

test('уведомление о консолидации', () => {
  assert.equal(
    formatConsolidatedNotice(9000, 5000),
    'Произведена консолидация блока контекста, объем 9000 симв. → 5000 симв.',
  )
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
  for (const text of [COMPRESS_START_NOTICE, ERR_MODEL]) {
    assert.doesNotMatch(text, /[*_`#>|]/)
  }
})
