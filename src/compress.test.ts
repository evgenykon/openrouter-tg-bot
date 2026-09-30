import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCompressor, type CompressorStore } from './compress.ts'
import type { StoredMessage } from './db.ts'
import type { ChatMessage } from './openrouter.ts'

function msg(id: number, name: string, text: string, date: number): StoredMessage {
  return { id, userId: id, name, text, date, isBot: false, isPrompt: false }
}

class FakeStore implements CompressorStore {
  raw = new Map<string, StoredMessage[]>()
  compressed = new Set<string>()
  summaries = new Map<string, string>()
  context = ''
  pruned: string[] = []
  commits: string[] = []
  lockFree = true
  reindexed = false
  folded = false

  async reindexDays(): Promise<void> {
    this.reindexed = true
  }
  async foldLegacySummary(): Promise<void> {
    this.folded = true
  }
  async rawDays(): Promise<string[]> {
    return [...this.raw.keys()]
  }
  async compressedDays(): Promise<string[]> {
    return [...this.compressed]
  }
  async messagesForDay(day: string): Promise<StoredMessage[]> {
    return this.raw.get(day) ?? []
  }
  async commitCompression(day: string, summary: string, context: string): Promise<void> {
    this.summaries.set(day, summary)
    this.context = context
    this.compressed.add(day)
    this.pruned.push(day)
    this.commits.push(day)
  }
  async markDayCompressed(day: string): Promise<void> {
    this.compressed.add(day)
  }
  async getContext(): Promise<string> {
    return this.context
  }
  async tryLock(): Promise<boolean> {
    return this.lockFree
  }
  async touchLock(): Promise<void> {}
  async unlock(): Promise<void> {}
}

const NOW = () => new Date('2026-09-21T12:00:00Z')

function deps(store: FakeStore, complete: (m: ChatMessage[]) => Promise<string>, extra = {}) {
  const notices: string[] = []
  const ownerNotices: string[] = []
  return {
    notices,
    ownerNotices,
    deps: {
      store,
      complete,
      participants: ['Аня', 'Борис'],
      chatLabel: '«Тестовый чат» (-1)',
      contextMaxChars: 10_000,
      messageMaxChars: 1000,
      notify: async (text: string) => {
        notices.push(text)
      },
      notifyOwner: async (text: string) => {
        ownerNotices.push(text)
      },
      now: NOW,
      ...extra,
    },
  }
}

const defaultComplete = async (messages: ChatMessage[]): Promise<string> => {
  const sys = messages[0]?.content ?? ''
  if (sys.includes('сжатия одного дня')) return '- Тема дня'
  if (sys.includes('Сожми блок')) return 'сжатый блок'
  if (sys.includes('долгосрочный блок')) return 'Тема: отношения\nПозиция Аня: устала'
  return ''
}

test('нет пропущенных дней — ничего не делает и не берёт лок', async () => {
  const store = new FakeStore()
  const { deps: d, notices } = deps(store, defaultComplete)
  await runCompressor(d)
  assert.equal(notices.length, 0)
  assert.equal(store.commits.length, 0)
  assert.equal(store.context, '')
  assert.equal(store.reindexed, true)
  assert.equal(store.folded, true)
})

test('текущий день не сжимается', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-21', [msg(1, 'Аня', 'привет', 0)])
  const { deps: d, notices } = deps(store, defaultComplete)
  await runCompressor(d)
  assert.equal(notices.length, 0)
  assert.equal(store.compressed.size, 0)
})

test('сжимает дни от старых к новым, уведомляет владельца по каждому и прунит', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-19', [msg(1, 'Аня', 'aaa', 0)])
  store.raw.set('2026-09-20', [msg(2, 'Борис', 'bbbb', 0)])
  const { deps: d, notices, ownerNotices } = deps(store, defaultComplete)
  await runCompressor(d)

  assert.equal(store.summaries.get('2026-09-19'), 'Тема дня')
  assert.equal(store.summaries.get('2026-09-20'), 'Тема дня')
  assert.deepEqual([...store.compressed].sort(), ['2026-09-19', '2026-09-20'])
  assert.deepEqual(store.pruned, ['2026-09-19', '2026-09-20'])
  assert.deepEqual(store.commits, ['2026-09-19', '2026-09-20'])
  assert.equal(store.context, 'Тема: отношения\nПозиция Аня: устала')

  // отчёт и содержимое блока контекста на каждый день — владельцу, не в чат
  assert.equal(notices.length, 0)
  assert.equal(ownerNotices.length, 4)
  assert.match(
    ownerNotices[0] ?? '',
    /^Чат: «Тестовый чат» \(-1\)\nБыло произведено сжатие контекста беседы за дату 2026-09-19/,
  )
  assert.match(
    ownerNotices[1] ?? '',
    /^Чат: «Тестовый чат» \(-1\)\nСодержимое блока контекста чата:\nТема: отношения/,
  )
  assert.match(
    ownerNotices[2] ?? '',
    /^Чат: «Тестовый чат» \(-1\)\nБыло произведено сжатие контекста беседы за дату 2026-09-20/,
  )
  assert.match(
    ownerNotices[3] ?? '',
    /^Чат: «Тестовый чат» \(-1\)\nСодержимое блока контекста чата:\nТема: отношения/,
  )
})

test('ошибка модели на дне — уведомление об ошибке, день не помечен, цикл остановлен', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-19', [msg(1, 'Аня', 'aaa', 0)])
  store.raw.set('2026-09-20', [msg(2, 'Борис', 'bbbb', 0)])
  const complete = async (messages: ChatMessage[]): Promise<string> => {
    const sys = messages[0]?.content ?? ''
    if (sys.includes('сжатия одного дня')) throw new Error('HTTP 429')
    return 'ok'
  }
  const { deps: d, notices, ownerNotices } = deps(store, complete)
  await runCompressor(d)

  assert.equal(store.compressed.size, 0)
  assert.equal(store.pruned.length, 0)
  assert.equal(notices.length, 1)
  assert.match(notices[0] ?? '', /HTTP 429/)
  assert.match(notices[0] ?? '', /2026-09-19/)
  assert.equal(ownerNotices.length, 0)
})

test('пустая сводка дня — ошибка, день не помечен', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-20', [msg(1, 'Аня', 'aaa', 0)])
  const complete = async (): Promise<string> => ''
  const { deps: d, notices } = deps(store, complete)
  await runCompressor(d)
  assert.equal(store.compressed.size, 0)
  assert.match(notices[0] ?? '', /пустой ответ модели/)
})

test('консолидация блока при превышении лимита + отдельное уведомление', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-20', [msg(1, 'Аня', 'aaa', 0)])
  const complete = async (messages: ChatMessage[]): Promise<string> => {
    const sys = messages[0]?.content ?? ''
    if (sys.includes('сжатия одного дня')) return 'сводка'
    if (sys.includes('Сожми блок')) return 'коротко'
    if (sys.includes('долгосрочный блок')) return 'x'.repeat(100)
    return ''
  }
  const { deps: d, notices, ownerNotices } = deps(store, complete, { contextMaxChars: 20 })
  await runCompressor(d)

  assert.equal(store.context, 'коротко')
  assert.equal(notices.length, 0)
  const joined = ownerNotices.join('\n')
  assert.match(joined, /Произведена консолидация блока контекста/)
  assert.match(joined, /за дату 2026-09-20/)
  assert.match(joined, /Содержимое блока контекста чата:\nкоротко/)
})

test('если консолидация не уменьшила блок — оставляем прежний без уведомления', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-20', [msg(1, 'Аня', 'aaa', 0)])
  const complete = async (messages: ChatMessage[]): Promise<string> => {
    const sys = messages[0]?.content ?? ''
    if (sys.includes('сжатия одного дня')) return 'сводка'
    if (sys.includes('Сожми блок')) return 'y'.repeat(200)
    if (sys.includes('долгосрочный блок')) return 'x'.repeat(100)
    return ''
  }
  const { deps: d, notices, ownerNotices } = deps(store, complete, { contextMaxChars: 20 })
  await runCompressor(d)
  assert.equal(store.context, 'x'.repeat(100))
  assert.equal(notices.length, 0)
  assert.doesNotMatch(ownerNotices.join('\n'), /консолидация/)
  assert.match(ownerNotices.join('\n'), /Содержимое блока контекста чата:\nx{100}/)
})

test('если лок занят — сжатие пропускается без уведомлений', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-20', [msg(1, 'Аня', 'aaa', 0)])
  store.lockFree = false
  const { deps: d, notices } = deps(store, defaultComplete)
  await runCompressor(d)
  assert.equal(notices.length, 0)
  assert.equal(store.compressed.size, 0)
})

test('пустой день помечается сжатым без уведомления', async () => {
  const store = new FakeStore()
  store.raw.set('2026-09-20', [])
  const { deps: d, notices } = deps(store, defaultComplete)
  await runCompressor(d)
  assert.equal(store.compressed.has('2026-09-20'), true)
  // пустой день — без уведомлений
  assert.equal(notices.length, 0)
})
