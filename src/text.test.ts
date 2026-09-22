import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDaySummary, stripMarkup, stripSpeakerPrefix } from './text.ts'

test('stripMarkup убирает markdown-заголовки и списки', () => {
  const out = stripMarkup('# Тема\n- первый пункт\n* второй пункт\n1. третий пункт')
  assert.equal(out, 'Тема\nпервый пункт\nвторой пункт\nтретий пункт')
})

test('stripMarkup убирает выделение и код', () => {
  const out = stripMarkup('Это **важно**, а это `код` и __тоже__')
  assert.equal(out, 'Это важно, а это код и тоже')
})

test('stripMarkup убирает таблицы и цитаты', () => {
  const out = stripMarkup('> цитата\n| a | b |\n|---|---|\n| 1 | 2 |\nфинал')
  assert.equal(out, 'цитата\n\nфинал')
})

test('stripMarkup вырезает reasoning-блок', () => {
  const out = stripMarkup('<think>долгие размышления</think>Ответ')
  assert.equal(out, 'Ответ')
})

test('stripMarkup сохраняет кавычки и абзацы', () => {
  const out = stripMarkup('Тема один\n\n«Я устал», — сказал он.\n\nВывод: нужно отдохнуть')
  assert.equal(out, 'Тема один\n\n«Я устал», — сказал он.\n\nВывод: нужно отдохнуть')
})

test('stripMarkup схлопывает лишние пустые строки', () => {
  const out = stripMarkup('a\n\n\n\nb')
  assert.equal(out, 'a\n\nb')
})

test('normalizeDaySummary оставляет по строке на тему', () => {
  const out = normalizeDaySummary('- тема один\n\n* тема два\n   \nтема три')
  assert.equal(out, 'тема один\nтема два\nтема три')
})

test('normalizeDaySummary на пустом входе даёт пустую строку', () => {
  assert.equal(normalizeDaySummary('   \n\n'), '')
})

test('stripSpeakerPrefix убирает одинарный префикс', () => {
  assert.equal(
    stripSpeakerPrefix('PsychologyChatBot: привет', ['PsychologyChatBot']),
    'привет',
  )
})

test('stripSpeakerPrefix убирает повторный префикс', () => {
  assert.equal(
    stripSpeakerPrefix('PsychologyChatBot: PsychologyChatBot: привет', ['PsychologyChatBot']),
    'привет',
  )
})

test('stripSpeakerPrefix не трогает текст без префикса', () => {
  assert.equal(stripSpeakerPrefix('просто ответ', ['PsychologyChatBot']), 'просто ответ')
})

test('stripSpeakerPrefix учитывает несколько имён (имя и username)', () => {
  assert.equal(
    stripSpeakerPrefix('deepseekpsybot: ответ', ['PsychologyChatBot', 'deepseekpsybot']),
    'ответ',
  )
})
