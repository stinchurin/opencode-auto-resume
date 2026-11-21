# opencode-auto-resume (плагин v2)

Порт локального форка `opencode-auto-resume` (v1, коммит `ca5507a7`) на контракт
плагинов `opencode 2.3.2`. Поведение v1 сохранено: возобновление после зависания
потока, ожидание окна провайдерского лимита по `codex-limits`, защита работающего
инструмента и ожидающего подтверждения, снятие ожидания по ESC с перевзводом на
следующем пользовательском вводе, ограничение попыток с бэкоффом, loop-guard.

## Подключение

```jsonc
// config/opencode/opencode.json
"plugins": ["/Users/<you>/.local/share/opencode-v2-migration/stage/auto-resume"]
```

Каталог обязан содержать `index.js` — v2 грузит каталог через него, файл `plugin.js`
по прямому пути не принимается.

Опции через элемент `plugins` передать нельзя: v2 принимает только строки, кортеж
`["<dir>", {...}]` отбрасывается нормализацией конфига (`$.plugins.0 kind=invalid`),
`ctx.options` всегда `{}`. Настройки читаются из `config.json` рядом с плагином.

## Настройки

`config.json` в этом каталоге, необязательный; мерж «умолчания → `config.json` →
`ctx.options`». Умолчания в примере ниже приведены к `DEFAULTS` в `plugin.js`.

```json
{
  "usageLimitEnabled": true,
  "usageLimitProviders": ["openai"],
  "usageLimitScript": "~/.local/bin/codex-limits",
  "chunkTimeoutMs": 45000,
  "gracePeriodMs": 3000,
  "restartDelayMs": 1000,
  "warmupMs": 15000,
  "maxRetries": 3,
  "loopMaxContinues": 3,
  "loopWindowMs": 600000,
  "claimDir": "~/.local/state/opencode/auto-resume/claims",
  "claimTtlMs": 60000,
  "logFile": "~/.local/share/opencode-v2-migration/tmp/auto-resume.log"
}
```

Файл `config.json` читается из каталога плагина. Переменная `AUTO_RESUME_OPTIONS_FILE` или `$OPENCODE_DIR/stage/auto-resume/config.json` заменяют его целиком; `AUTO_RESUME_OPTIONS` содержит inline-JSON поверх любых настроек.

`claimDir` (по умолчанию `~/.local/state/opencode/auto-resume/claims`) — каталог claim-файлов межэкземплярной блокировки; `claimTtlMs` (60000 мс) — срок жизни чужого claim, после которого он перехватывается (например, если экземпляр умер, не сняв блокировку).

`restartDelayMs` (1000 мс) — пауза перед переподпиской на поток событий после его разрыва. Поток переподписывается до остановки плагина: без этого состояние сессий застывает после первого разрыва.

## Защиты от ложного возобновления

Watchdog отправляет `continue`, только когда сессия в состоянии `busy` и по ней нет активности дольше `chunkTimeoutMs + gracePeriodMs`. Поверх этого действуют suppression-условия:

- **открытый вопрос**: сессия ждёт ответа пользователя через вопрос-инструмент — события `form.created` / `form.replied` / `form.cancelled` и `execute.before` / `execute.after` инструмента `question`. Нажатие «continue» в момент ожидания ответа — тот дефект, из-за которого guard возвращён из v1. Канала два, и оба обязательны: tool-хуки достаются только тому процессу, который исполняет сессию, а шина событий — всем экземплярам (инцидент 21.11.2026, вечер: «чужие» экземпляры шлют «continue» в открытый диалог вопросов, потому что `form.created` не разбирался — см. контракт ниже);
- **права не выданы** (`permission.asked` до `permission.replied`);
- **инструмент в полёте** (`execute.before` без `execute.after`);
- **ESC пользователя**: до следующего пользовательского ввода;
- **лимит провайдера**: пауза по контракту `codex-limits`.

Watchdog не доверяет собственной тени событий: если за всё окно ожидания (timeout + grace) по шине не пришло **ни одного** события ни по одной сессии, подписка считается оглохшей — поток пересоздаётся, а нудж откладывается на одно окно. Без этого оглохшая подписка давала ложный stall по сессии, которая в этот момент активно стримила (инцидент 21.11.2026: шесть «continue» в стримящий ответ). Цена защиты — задержка истинного нуджа на одно окно на машине без сторонних событий.

Поверх сторожа действует межэкземплярный claim: перед отправкой resume плагин создаёт файл `claims/<sessionID>.json` в `~/.local/state/opencode/auto-resume/` (настраивается `claimDir`). Свежий claim другого экземпляра блокирует нудж; протухший (старше `claimTtlMs`, 60 с) перехватывается. Claim снимается при первом событии по сессии, при удалении сессии и при остановке плагина. Это убирает одновременные дубли «continue» между процессами; между копиями модуля в одном процессе дубли не возникают вовсе (см. ниже). Протухание учитывается и для держателя claim: если после доставки не было ни одного события (например, turn подвешен открытым вопросом), файл стареет, и держатель при следующей попытке обязан атомарно перезахватить его (unlink + create c `wx`), а не обходить проверку по сохранённому пути — иначе два экземпляра проходят guard в одну и ту же миллисекунду (инцидент 21.11.2026, вечер: два «continue» в 17:32:18.330).

Один инстанс плагина активен одновременно: новый вызов `setup()` останавливает предыдущий. Ссылка на активный инстанс хранится в `globalThis`, а не в переменной модуля: на каждый config-reload хост заново импортирует модуль (21.11.2026 зафиксировано четыре импорта auto-resume за одну секунду в одном процессе), и переменная на уровне модуля делала guard бесполезным — параллельные watchdogs отправляли дубли «continue» в одну сессию.

`usageLimitScript` получает `--json --model <id> --grace <сек>` и должен отдавать
контракт E9: коды `0` (лимита нет), `3` (лимит, срок известен), `4` (лимит, срок
неизвестен), `1` (ошибка). Срок сброса берётся только из ответа скрипта:
`retryAfterMs` из события v2 — клиентский бэкофф, а не время сброса окна.

## Контракт событий шины (opencode 2.3.2)

Подписка принимает отфильтрованный список типов; проверено пробой 21.11.2026
(`opencode run`, модели `opencode-go/glm-5.3-flash` и `lanit/DKS-Leo`):

- приходят с `data.sessionID` верхнего уровня: `session.created`, `session.inbox.*`,
  `session.execution.started/succeeded/failed/interrupted`, `session.step.started/ended`,
  `session.text.delta/started/ended`, `session.reasoning.delta/started/ended`,
  `session.tool.called/progress/success`, `session.tool.input.started/ended`;
- **`form.created` приходит с `sessionID` внутри `data.form`** (`data: { form: { id, sessionID, title, metadata } }`),
  `form.replied` / `form.cancelled` — с верхнеуровневым `data.sessionID` (проба 21.11.2026, вечер).
  Разбор `form.created` без учёта вложенности молча пропускал событие и оставлял
  `questionPending=false` во всех экземплярах, кроме исполняющего;
- не приходят вовсе: `session.status` (понятие v1), `message.updated`,
  `message.part.updated`, `message.removed`, `session.error`, `session.updated`;
  `session.idle` в пробах `run` не наблюдался, но оставлен в подписке — busy
  сбрасывается и через `session.execution.succeeded`;
- подписка не имеет `dispose` (E12), поэтому принудительное пересоздание после
  глухоты оставляет старую корутину подвешенной до конца жизни процесса.

## Состав

| Файл | Назначение |
|---|---|
| `plugin.js` | плагин: `export default { id, async setup(ctx) }` |
| `index.js` | entrypoint каталога (`export { default } from './plugin.js'`) |
| `test/plugin.test.mjs` | контрактные тесты на fake host |
| `probe/index.js` | пробный плагин, снявший контракт 2.3.2 (пишет JSONL) |
| `probe/stub429.py` | HTTP stub с 429 `usage_limit_reached` |
| `probe/fake-limits-*.sh` | двойники `codex-limits` для тестов |
| `src/` | исходники v1 как референс (без `node_modules`) |

## Проверка

```bash
cd "$(dirname "$0")" && bun test test/plugin.test.mjs   # 24 pass
```

Живой прогон требует долгоживущего процесса: таймеры в `run --standalone` не
доживают до срабатывания, поэтому проверять через `opencode-v2 service restart` и
`api POST /api/session/<id>/prompt`.

## Пробелы

- Наджи о «готово» при открытых todo не отправляются: в v2 нет todo-инструмента,
  то есть нет источника истины. Шаблоны `DONE_CLAIM_PATTERNS` оставлены заготовкой.
- Отдельной логики зависшего субагента нет: в v2 субагент — отдельная сессия со
  своим watchdog.
