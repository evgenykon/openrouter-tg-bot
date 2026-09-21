import { Bot, GrammyError, type Context } from 'grammy'
import type { Message } from '@grammyjs/types'
import type { Config } from './config.ts'
import { loadConfig } from './config.ts'
import { runCompressor } from './compress.ts'
import {
  chatParticipants,
  chatStore,
  closeRedis,
  dmStore,
  getProfile,
  initRedis,
  listUserGroupChats,
  resetChat,
  resetDm,
  saveChatMessage,
  saveDmMessage,
  setProfile,
  updateChatMessageText,
  type StoredMessage,
} from './db.ts'
import {
  buildDmContext,
  buildGroupContext,
  formatCurrentPrompt,
  splitMessage,
  type PromptRequest,
} from './history.ts'
import { ERR_MODEL, formatModelError } from './notices.ts'
import {
  displayName,
  displayNameOf,
  isCommandMessage,
  isMentioningBot,
  stripCommand,
  stripMention,
} from './mentions.ts'
import {
  completeChat,
  getModelContextLength,
  OpenRouterError,
  streamAnswer,
  type ChatMessage,
} from './openrouter.ts'

const config: Config = loadConfig()

const bot = new Bot(config.botToken)

function replyError(ctx: Context, messageId?: number): Promise<unknown> {
  return ctx.reply('Service not available for you', {
    reply_to_message_id: messageId,
  })
}

function commandName(msg: Message): string | null {
  const e = (msg.entities ?? []).find((x) => x.type === 'bot_command')
  if (!e) return null
  const token = (msg.text ?? '').slice(e.offset, e.offset + e.length)
  return token.replace('/', '').split('@')[0]?.toLowerCase() ?? null
}

function commandArgs(msg: Message): string {
  const e = (msg.entities ?? []).find((x) => x.type === 'bot_command')
  if (!e) return ''
  return (msg.text ?? '').slice(e.offset + e.length).trim()
}

function toStored(msg: Message, isPrompt: boolean, textOverride?: string): StoredMessage {
  return {
    id: msg.message_id,
    userId: msg.from?.id ?? 0,
    name: displayName(msg),
    text: textOverride ?? msg.text ?? '',
    date: msg.date,
    isBot: false,
    isPrompt,
  }
}

async function replyMarkdown(
  ctx: Context,
  text: string,
  opts: { reply_to_message_id?: number } = {},
): Promise<Message | undefined> {
  try {
    return await ctx.reply(text, { ...opts, parse_mode: 'Markdown' })
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400) {
      return ctx.reply(text, opts)
    }
    throw err
  }
}

/** Отправка служебного текста напрямую, без записи в историю и без markdown. */
async function sendPlain(chatId: number, text: string): Promise<void> {
  try {
    for (const chunk of splitMessage(text)) {
      await bot.api.sendMessage(chatId, chunk)
    }
  } catch (err) {
    console.error('[notify]', err)
  }
}

async function compressIfNeeded(ctx: Context, msg: Message): Promise<void> {
  if (!config.compressEnabled || !msg.from) return
  const isPrivate = msg.chat.type === 'private'
  const targetChatId = isPrivate ? msg.from.id : msg.chat.id
  const store = isPrivate ? dmStore(msg.from.id) : chatStore(msg.chat.id)

  try {
    // переиндексация нужна до чтения участников (миграция старых чатов)
    await store.reindexDays()
    let participants: string[]
    if (isPrivate) {
      participants = [displayName(msg)]
    } else {
      const map = await chatParticipants(msg.chat.id)
      map.set(msg.from.id, displayName(msg))
      participants = [...map.values()]
    }

    await runCompressor({
      store,
      complete: (messages) =>
        completeChat(config.openrouterApiKey, config.model, messages, config.maxTokens),
      participants,
      contextMaxChars: config.contextMaxChars,
      messageMaxChars: config.contextMessageMaxChars,
      notify: (text) => sendPlain(targetChatId, text),
      log: (message) => console.log(`[compress] chat=${targetChatId} ${message}`),
    })
  } catch (err) {
    console.error(`[compress] chat=${targetChatId} fatal`, err)
    await sendPlain(targetChatId, ERR_MODEL)
  }
}

async function answer(
  ctx: Context,
  msg: Message,
  buildContext: () => Promise<ChatMessage[]>,
  prompt: PromptRequest,
): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing')
    await compressIfNeeded(ctx, msg)

    const context = await buildContext()
    const promptText = formatCurrentPrompt(prompt)

    let full = ''
    let lastTyping = Date.now()
    const systemPrompt =
      msg.chat.type === 'private' ? config.privateSystemPrompt : config.systemPrompt
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...context,
      { role: 'user', content: promptText },
    ]

    console.log(`Bot ----> AI chat=${msg.chat.id} user=${msg.from?.id} model=${config.model}`)
    for (const m of messages) {
      console.log(`  ${m.role}: ${m.content}`)
    }

    for await (const delta of streamAnswer(
      config.openrouterApiKey,
      config.model,
      messages,
      config.maxTokens,
    )) {
      full += delta
      if (Date.now() - lastTyping > 4000) {
        lastTyping = Date.now()
        await ctx.replyWithChatAction('typing').catch(() => {})
      }
    }

    console.log(`AI ----> Bot chat=${msg.chat.id} user=${msg.from?.id}`, full || '(empty)')
    if (!full.trim()) {
      console.log(`[error] chat=${msg.chat.id} user=${msg.from?.id} пустой ответ от модели`)
      await ctx.reply(ERR_MODEL, { reply_to_message_id: msg.message_id }).catch(() => {})
      return
    }
    const chunks = splitMessage(full)
    let firstId: number | undefined
    for (const [i, chunk] of chunks.entries()) {
      const sent = await replyMarkdown(
        ctx,
        chunk,
        i === 0 ? { reply_to_message_id: msg.message_id } : {},
      )
      if (i === 0 && sent) firstId = sent.message_id
    }
    if (firstId !== undefined) {
      const stored: StoredMessage = {
        id: firstId,
        userId: bot.botInfo.id,
        name: bot.botInfo.first_name || bot.botInfo.username,
        text: full,
        date: Math.floor(Date.now() / 1000),
        isBot: true,
        isPrompt: false,
      }
      if (msg.chat.type === 'private') await saveDmMessage(msg.from?.id ?? 0, stored)
      else await saveChatMessage(msg.chat.id, stored)
    }
  } catch (err) {
    console.error(`[error] chat=${msg.chat.id} user=${msg.from?.id}`, err)
    const text = err instanceof OpenRouterError ? formatModelError(err) : ERR_MODEL
    await ctx.reply(text, { reply_to_message_id: msg.message_id }).catch(() => {})
  }
}

function replyToPrompt(msg: Message): PromptRequest['replyTo'] {
  const r = msg.reply_to_message
  if (!r?.text || !r.from) return undefined
  return { name: displayNameOf(r.from), text: r.text }
}

async function chatStatus(chatId: number): Promise<string> {
  const store = chatStore(chatId)
  const days = await store.compressedDays()
  const last = days.at(-1) ?? 'нет'
  const size = (await store.getContext()).length
  return `последний сжатый день: ${last}, блок контекста: ${size} симв.`
}

async function forceCompress(notifyChatId: number, chatId: number): Promise<void> {
  const store = chatStore(chatId)
  await store.reindexDays()
  const participants = [...(await chatParticipants(chatId)).values()]
  await runCompressor({
    store,
    complete: (messages) =>
      completeChat(config.openrouterApiKey, config.model, messages, config.maxTokens),
    participants,
    contextMaxChars: config.contextMaxChars,
    messageMaxChars: config.contextMessageMaxChars,
    notify: (text) => sendPlain(notifyChatId, text),
    log: (message) => console.log(`[compress] chat=${chatId} ${message}`),
  })
}

bot.on('message', async (ctx) => {
  const msg = ctx.message
  if (!msg.from) return

  const botId = bot.botInfo.id
  const botUsername = bot.botInfo.username
  const isPrivate = ctx.chat.type === 'private'
  const allowed = config.allowedUserIds.includes(msg.from.id)
  const isCmd = isCommandMessage(msg)
  const mention = isMentioningBot(msg, botId, botUsername)

  console.log(
    `[msg] chat=${ctx.chat.id} type=${ctx.chat.type} user=${msg.from.id} name=${displayName(msg)}` +
      ` cmd=${isCmd} mention=${mention} allowed=${allowed}` +
      (msg.text ? ` text="${msg.text}"` : ''),
  )

  if (isCmd) {
    if (!allowed) {
      await replyError(ctx, msg.message_id)
      return
    }
    const cmd = commandName(msg)
    const chatId = ctx.chat.id
    switch (cmd) {
      case 'show_prompt':
        await ctx.reply(
          ctx.chat.type === 'private' ? config.privateSystemPrompt : config.systemPrompt,
          { reply_to_message_id: msg.message_id },
        )
        break
      case 'compress_chat':
      case 'compress-chat': {
        const uid = msg.from.id
        const rest = commandArgs(msg)
        if (!rest) {
          const chats = await listUserGroupChats(uid)
          if (chats.length === 0) {
            await ctx.reply('Нет доступных групповых чатов, где ты находишься.', {
              reply_to_message_id: msg.message_id,
            })
            break
          }
          const lines: string[] = []
          for (const cid of chats) {
            lines.push(`- \`${cid}\`: ${await chatStatus(cid)}`)
          }
          await replyMarkdown(
            ctx,
            'Доступные чаты (для сжатия: /compress_chat <id>):\n' + lines.join('\n'),
            { reply_to_message_id: msg.message_id },
          )
          break
        }
        const requested = Number(rest)
        if (!Number.isInteger(requested)) {
          await ctx.reply('Формат: /compress_chat <id>. Укажи числовой id чата.', {
            reply_to_message_id: msg.message_id,
          })
          break
        }
        const chats = await listUserGroupChats(uid)
        // часть клиентов отрезает минус у отрицательных id — ищем реальный чат независимо от знака
        const targetId = chats.find((cid) => cid === requested || cid === -requested)
        if (targetId === undefined) {
          await ctx.reply(`Ты не найден в чате ${requested}.`, { reply_to_message_id: msg.message_id })
          break
        }
        await ctx.replyWithChatAction('typing')
        try {
          await forceCompress(chatId, targetId)
          await ctx.reply(`Готово. ${await chatStatus(targetId)}`, {
            reply_to_message_id: msg.message_id,
          })
        } catch (err) {
          console.error(`[compress] chat=${targetId} fatal`, err)
          await ctx.reply(formatModelError(err), { reply_to_message_id: msg.message_id })
        }
        break
      }
      case 'profile': {
        const rest = stripCommand(msg.text ?? '', botUsername)
        const [mode, ...contentParts] = rest.split(/\s+/)
        const content = contentParts.join(' ').trim()
        const uid = msg.from.id
        if ((mode === 'set' || mode === 'save') && content) {
          await setProfile(uid, content)
          await ctx.reply('Профиль сохранён.', { reply_to_message_id: msg.message_id })
          break
        }
        if ((mode === 'add' || mode === 'append') && content) {
          const current = (await getProfile(uid)).trim()
          await setProfile(uid, current ? `${current}\n${content}` : content)
          await ctx.reply('Профиль дополнен.', { reply_to_message_id: msg.message_id })
          break
        }
        if (mode === 'clear') {
          await setProfile(uid, '')
          await ctx.reply('Профиль очищен.', { reply_to_message_id: msg.message_id })
          break
        }
        const current = (await getProfile(uid)).trim()
        if (!current) {
          await ctx.reply(
            'Профиль пуст.\nОтправь: /profile set <текст> — сохранить, /profile add <текст> — дополнить, /profile clear — очистить.',
            { reply_to_message_id: msg.message_id },
          )
          break
        }
        await ctx.reply(current, { reply_to_message_id: msg.message_id })
        break
      }
      case 'ext_profile': {
        const rest = stripCommand(msg.text ?? '', botUsername)
        const parts = rest.split(/\s+/)
        const isSet = parts[0] === 'set'
        const idArg = isSet ? parts[1] : parts[0]
        const targetId = Number(idArg)
        if (!idArg || !Number.isInteger(targetId)) {
          await ctx.reply(
            'Формат: /ext_profile <id> — просмотр, /ext_profile set <id> <текст> — установить.',
            { reply_to_message_id: msg.message_id },
          )
          break
        }
        if (isSet) {
          const content = parts.slice(2).join(' ').trim()
          if (!content) {
            await ctx.reply('Пустой профиль — отправь текст после id.', { reply_to_message_id: msg.message_id })
            break
          }
          await setProfile(targetId, content)
          await ctx.reply(`Профиль пользователя ${targetId} сохранён.`, { reply_to_message_id: msg.message_id })
          break
        }
        const current = (await getProfile(targetId)).trim()
        if (!current) {
          await ctx.reply(`Профиль пользователя ${targetId} пуст.`, { reply_to_message_id: msg.message_id })
          break
        }
        await ctx.reply(`Профиль пользователя ${targetId}:\n${current}`, { reply_to_message_id: msg.message_id })
        break
      }
      case 'start':
        await answer(
          ctx,
          msg,
          isPrivate
            ? () => buildDmContext(msg.from.id, config, displayName(msg))
            : () => buildGroupContext(chatId, config, msg.from.id, displayName(msg)),
          {
            name: displayName(msg),
            text: 'Начало диалога. Поздоровайся со мной и задай свой вступительный вопрос, чтобы мы начали разбираться.',
          },
        )
        break
      case 'help':
        await ctx.reply(
          'Я — психологический помощник. Тегни меня (@' + botUsername + ') с вопросом.\n' +
            '/start — приветствие и начало диалога\n' +
            '/profile — посмотреть профиль; /profile set|add <текст> — сохранить или дополнить\n' +
            '/ext_profile <id> — чужой профиль; set <id> <текст> — установить\n' +
            '/compress_chat — статус чатов; /compress_chat <id> — сжать историю чата\n' +
            '/reset — очистить историю чата\n' +
            '/help — список команд\n' +
            '/show_prompt — показать текущий системный промпт',
          { reply_to_message_id: msg.message_id },
        )
        break
      case 'reset':
        if (isPrivate) await resetDm(msg.from.id)
        else await resetChat(chatId)
        await ctx.reply('История очищена.', { reply_to_message_id: msg.message_id })
        break
      default:
        if (isPrivate) {
          await ctx.reply('Неизвестная команда. /help — список команд.')
        }
    }
    return
  }

  if (!allowed) {
    if (isPrivate || mention) {
      await replyError(ctx, msg.message_id)
    }
  }

  if (isPrivate) {
    if (!allowed) return
    await answer(ctx, msg, () => buildDmContext(msg.from.id, config, displayName(msg)), {
      name: displayName(msg),
      text: msg.text ?? '',
      replyTo: replyToPrompt(msg),
    })
    await saveDmMessage(msg.from.id, toStored(msg, false))
    return
  }

  const prompt = mention ? stripMention(msg.text ?? '', msg, botId, botUsername) : ''
  if (mention) {
    if (!prompt) {
      await ctx.reply('Напиши запрос после упоминания.', {
        reply_to_message_id: msg.message_id,
      })
      return
    }
    if (!allowed) {
      await saveChatMessage(ctx.chat.id, toStored(msg, true, prompt))
      return
    }
    await answer(ctx, msg, () => buildGroupContext(ctx.chat.id, config, msg.from.id, displayName(msg)), {
      name: displayName(msg),
      text: prompt,
      replyTo: replyToPrompt(msg),
    })
    await saveChatMessage(ctx.chat.id, toStored(msg, true, prompt))
  } else {
    await saveChatMessage(ctx.chat.id, toStored(msg, false))
    if (!allowed) return
  }
})

bot.on('edited_message', async (ctx) => {
  const msg = ctx.editedMessage
  if (!msg?.text || !msg.from) return
  if (ctx.chat.type === 'private') return
  const botId = bot.botInfo.id
  const mention = isMentioningBot(msg, botId, bot.botInfo.username)
  const text = mention ? stripMention(msg.text, msg, botId, bot.botInfo.username) : msg.text
  await updateChatMessageText(ctx.chat.id, msg.message_id, text, mention)
})

bot.catch(async (err) => {
  console.error('[bot]', err.error)
  try {
    await err.ctx.reply(ERR_MODEL)
  } catch {
    // не удалось сообщить об ошибке — остаётся только лог
  }
})

async function main(): Promise<void> {
  await initRedis(config.redisUrl)
  await bot.init()

  const commands = [
    { command: 'start', description: 'Приветствие и начало диалога' },
    { command: 'profile', description: 'Профиль: просмотр, set/add <текст>, clear' },
    { command: 'ext_profile', description: 'Профиль другого юзера: <id> или set <id> <текст>' },
    { command: 'compress_chat', description: 'Статус чатов или сжать историю: <id>' },
    { command: 'reset', description: 'Очистить историю чата' },
    { command: 'show_prompt', description: 'Показать текущий системный промпт' },
    { command: 'help', description: 'Помощь' },
  ]
  await bot.api.setMyCommands(commands)
  await bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } })
  await bot.api.setMyCommands(commands, { scope: { type: 'all_group_chats' } })

  const contextLength = await getModelContextLength(config.model, config.openrouterApiKey)
  console.log(
    `[bot] @${bot.botInfo.username} запущен, модель: ${config.model}` +
      (contextLength ? `, контекст: ${contextLength} токенов` : ', контекст: fallback'),
  )

  await bot.start({
    onStart: () => console.log('[bot] polling...'),
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

async function shutdown(): Promise<void> {
  console.log('[bot] остановка...')
  await bot.stop()
  await closeRedis().catch(() => {})
  process.exit(0)
}

main().catch((err) => {
  console.error('[bot] fatal:', err)
  process.exit(1)
})
