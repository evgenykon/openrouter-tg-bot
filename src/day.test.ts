import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dayKeyFromDate, dayKeyFromUnix, dayStartUnix, isBefore, isValidDay } from './day.ts'

test('dayKeyFromUnix считает день по UTC', () => {
  assert.equal(dayKeyFromUnix(Date.UTC(2026, 8, 21, 12, 0, 0) / 1000), '2026-09-21')
})

test('граница дня: 23:59 UTC и 00:00 UTC — разные дни', () => {
  const before = Date.UTC(2026, 8, 21, 23, 59, 59) / 1000
  const after = Date.UTC(2026, 8, 22, 0, 0, 0) / 1000
  assert.equal(dayKeyFromUnix(before), '2026-09-21')
  assert.equal(dayKeyFromUnix(after), '2026-09-22')
})

test('dayStartUnix и dayKeyFromUnix взаимно обратны', () => {
  const day = '2026-01-02'
  assert.equal(dayKeyFromUnix(dayStartUnix(day)), day)
})

test('dayKeyFromDate', () => {
  assert.equal(dayKeyFromDate(new Date('2026-09-21T00:00:00Z')), '2026-09-21')
})

test('isValidDay', () => {
  assert.equal(isValidDay('2026-09-21'), true)
  assert.equal(isValidDay('2026-13-01'), false)
  assert.equal(isValidDay('nonsense'), false)
  assert.equal(isValidDay('2026-9-1'), false)
})

test('isBefore сравнивает хронологически', () => {
  assert.equal(isBefore('2026-09-20', '2026-09-21'), true)
  assert.equal(isBefore('2026-09-21', '2026-09-21'), false)
})

test('addDays переходит через границу месяца', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01')
  assert.equal(addDays('2026-10-01', -1), '2026-09-30')
})
