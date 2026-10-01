import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daysToLoad, participantsLine } from './history.ts'

test('при включённой компрессии грузится только текущий день', () => {
  const days = daysToLoad(['2026-09-19', '2026-09-20', '2026-09-21'], [], '2026-09-21', true)
  assert.deepEqual(days, ['2026-09-21'])
})

test('несжатые прошлые дни не попадают в запрос', () => {
  const days = daysToLoad(['2026-09-01', '2026-09-02'], [], '2026-09-21', true)
  assert.deepEqual(days, ['2026-09-21'])
})

test('без истории всё равно только текущий день', () => {
  assert.deepEqual(daysToLoad([], [], '2026-09-21', true), ['2026-09-21'])
})

test('состав чата: участники без дублей и пустых имён', () => {
  assert.equal(
    participantsLine(['Евгений', 'Настя', 'Настя', ' ']),
    'В чате участвуют: Евгений, Настя.',
  )
  assert.equal(participantsLine([]), '')
  assert.equal(participantsLine(['  ']), '')
})

test('при выключенной компрессии грузятся все несжатые сырые дни', () => {
  const days = daysToLoad(
    ['2026-09-20', '2026-09-19', '2026-09-18'],
    ['2026-09-19'],
    '2026-09-21',
    false,
  )
  assert.deepEqual(days, ['2026-09-18', '2026-09-20'])
})
