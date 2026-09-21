import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConsolidateMessages,
  buildDaySummaryMessages,
  buildMergeMessages,
  CONTEXT_CONSOLIDATE_SYSTEM,
  CONTEXT_MERGE_SYSTEM,
} from './prompts.ts'

test('промпт мержа требует даты у каждой темы', () => {
  assert.match(CONTEXT_MERGE_SYSTEM, /Даты:/)
  assert.match(CONTEXT_MERGE_SYSTEM, /YYYY-MM-DD/)
})

test('промпт консолидации сохраняет даты', () => {
  assert.match(CONTEXT_CONSOLIDATE_SYSTEM, /Даты:/)
})

test('buildMergeMessages передаёт дату нового дня', () => {
  const msgs = buildMergeMessages(['Evgeny', 'Настя'], '2026-08-19', '', 'сводка дня')
  const user = msgs[1]?.content ?? ''
  assert.match(user, /Сводка нового дня \(2026-08-19\)/)
  assert.match(user, /Текущий блок контекста:\n\(пусто\)/)
  assert.match(user, /сводка дня/)
  assert.match(user, /Участники: Evgeny, Настя\./)
})

test('buildDaySummaryMessages включает участников и контент', () => {
  const msgs = buildDaySummaryMessages(['Evgeny'], 'строка дня')
  assert.match(msgs[1]?.content ?? '', /Участники: Evgeny\./)
  assert.match(msgs[1]?.content ?? '', /строка дня/)
})

test('buildConsolidateMessages включает контекст', () => {
  const msgs = buildConsolidateMessages(['Evgeny'], 'блок контекста')
  assert.match(msgs[1]?.content ?? '', /блок контекста/)
})
