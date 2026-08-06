# План: Telegram-бот психологической помощи через OpenRouter

## Цель
Бот для группового чата (и лички): отвечает только по тегу `@bot <запрос>` / по командам.
Психологическая поддержка через OpenRouter, контекст — история чата, ограниченная
токен-бюджетом модели. Работает только для пользователей из конфига.

## Стек
- Node.js 26 + TypeScript
- grammY (long polling, без webhook)
- Redis (контейнер `redis:7-alpine`) с персистентностью — AOF `appendonly yes`, данные на volume `./data/redis`
- Клиент Redis: пакет `redis` (node-redis)
- Зависимости: `grammY`, `redis`, `typescript`, `tsx`, `@types/node`

## Структура проекта
```
Dockerfile / docker-compose.yml
.env.example, config.example.json, .gitignore (.env, config.json, data/)
README.md
src/
├── index.ts        # запуск, polling, handlers, команды
├── config.ts       # загрузка и валидация .env + config.json
├── db.ts           # Redis: лента, память, dm
├── history.ts      # выборка контекста по токен-бюджету
├── mentions.ts     # детекция тега, вырезание упоминания
└── openrouter.ts   # /models (context_length) + chat/completions, estimateTokens
```

## Docker
- Сервис `redis` (redis:7-alpine, `--appendonly yes`, volume `./data/redis:/data`) + сервис `bot`.
- Бот: `node:26-alpine`, запуск `tsx src/index.ts`, не-root пользователь.
- `docker-compose.yml` монтирует `./config.json`, `./.env`; переменная `REDIS_URL`.
- Запуск: `docker compose up -d --build`.

## Конфиг (gitignored; шаблоны .env.example / config.example.json)
- `.env`: `BOT_TOKEN`, `OPENROUTER_API_KEY`, `REDIS_URL` (в compose — `redis://redis:6379`)
- `config.json`:
  - `model` — модель OpenRouter
  - `allowedUserIds[]` — разрешённые Telegram user id
  - `systemPrompt` — промпт психолога (эмпатия, активное слушание,
    дисклеймер о кризисных ситуациях и горячих линиях)
  - `maxContextMessages` — потолок сообщений в контексте (по умолчанию 200)
  - `fallbackContextTokens` — запасное окно, если /models недоступен (32768)
  - `safetyMarginPercent` — резерв токен-бюджета (30)
  - `maxTokens` — лимит ответа
  - `contextMessageMaxChars` — обрезка длинных сообщений в контексте

## База (Redis, персистентно, без прунинга)
Ключи по схеме (sorted set = порядок/идентификаторы, hash = содержимое):
- `chat:{chatId}:messages` (zset: score/member = message_id) +
  `chat:{chatId}:msg:{messageId}` (hash: user_id, name, text, date, is_bot,
  is_prompt) — все сообщения групп; записываются только от разрешённых юзеров;
  редактирование перезаписывает hash (тот же message_id).
- `dm:{userId}:messages` (zset) + `dm:{userId}:msg:{messageId}` (hash) —
  приватные сообщения; контекст лички строится только из сообщений этого
  пользователя.

## Гейт доступа (первым в цепочке обработки)
1. `from.id` вне `allowedUserIds` → немедленный reply
   «Service not available for you» → return.
2. Без вызовов OpenRouter, без команд, без детекции тега.
3. Сообщения неизвестных не пишутся в БД вообще.
4. Неизвестным в группе отвечаем ТОЛЬКО на запросы (тег / команда / личка),
   обычные сообщения игнорируются.

## Команды (setMyCommands, scope для групп → видны в подсказке при @bot и в меню)
- `/remember` — с reply: сохраняет реплайнутое сообщение в память
  («Сохранил в память»); без reply: «Отметь (reply) сообщение, которое нужно
  сохранить». Только в группах.
- `/forget` — очищает память чата (группа) / личка не имеет памяти.
- `/reset` — очищает историю и память чата (группа);
  для лички — `dm:{userId}:*` этого юзера.
- `/help` — краткое описание.
- Все команды — только для разрешённых юзеров.

## Поведение в группах
1. Каждое сообщение разрешённого юзера сохраняется в `messages`, без автоответа.
2. Детекция тега: entities `mention` (`@botusername`) или `text_mention`
   (id = id бота). Промпт = текст минус упоминание, обрезанный.
3. Мультиюзерность: история — «Имя: текст»; текущий запрос —
   «Имя: текст» как последнее user-сообщение; системный промпт требует
   отвечать автору последнего сообщения, опираясь на его реплики.
   При `reply_to` в блок запроса добавляется
   «в ответ на сообщение от {имя}: {текст}».
4. Контекст по токен-бюджету:
   - при старте `GET https://openrouter.ai/api/v1/models` → `context_length`
     модели (кэш; fallback — `fallbackContextTokens`);
   - бюджет = окно − `maxTokens` − системный промпт − резерв 30%;
   - заполнение: память чата (старые→новые) → лента (новые→старые);
   - из ленты исключаются: другие промпты (сообщения с тегом бота),
     ответы бота; сообщения из памяти не дублируются;
   - `estimateTokens(text)` ≈ символы / 2.5–3 + оверхед на роль сообщения.
5. OpenRouter: `[system, ...контекст, user[промпт]]`,
   `sendChatAction('typing')`, не-streaming, `maxTokens` из конфига.
   Ошибки API (429 / нет средств) → внятный reply.
6. Ответ — reply на сообщение, длинные ответы режутся по 4096 символов
   с переносом по абзацам.

## Поведение в личке
1. Разрешается только разрешённым юзерам.
2. Сообщение сохраняется в `dm:{userId}:*`.
3. Любое сообщение = запрос (тега нет).
4. Контекст — только сообщения этого пользователя из `dm:{userId}:messages`
   (новые→старые, токен-бюджет, ответы бота не включаются).

## Требования к настройке
- В BotFather: privacy mode **Disabled** (`/setprivacy`), иначе бот не получит
  обычные сообщения группы.
- `.env` и `config.json` заполнить из шаблонов, добавить бота в группу,
  разрешённые user id — в `allowedUserIds`.
- Redis поднимается автоматически через docker-compose с AOF-персистентностью.

## Порядок реализации
1. Каркас: package.json, tsconfig, конфиги, Docker, .gitignore.
2. config.ts + db.ts (Redis-ключи chat / memory / dm).
3. mentions.ts (детекция тега) + openrouter.ts (models, chat, estimateTokens).
4. history.ts (запись, токен-бюджетная сборка контекста, память).
5. index.ts (гейт доступа, handlers, команды, приватный чат).
6. README.md.
