# Appscript2tg

**Telegram Bot API релей на Google Apps Script.** Принимает HTTP-запрос, пересылает
его в `api.telegram.org` и возвращает ответ Telegram как есть.

```
ваш скрипт → https://script.google.com/macros/s/<ID>/exec?k=<SECRET>&m=sendMessage
           → https://api.telegram.org/bot<token>/sendMessage
```

## Что это

Один файл `src/Code.gs` (~320 строк), опубликованный как web app в Google Apps
Script и работающий транзитным прокси для Bot API. Ничего не хостится: ни
сервера, ни контейнера, ни DNS-записи. Токен бота лежит в Script Properties на
стороне Google — клиенту он не нужен и в репозитории не появляется.

Всё, что делает релей с запросом: проверяет секрет, подставляет токен, отправляет
тело в `https://api.telegram.org/bot<token>/<method>` и отдаёт ответ назад в
JSON-конверте. Путь и тело уходят дословно, вместе с Content-Type — поэтому JSON,
`application/x-www-form-urlencoded` и multipart с файлами работают без
специальных случаев.

## Зачем это

Бывает, что с машины, где идёт разработка, не открывается `api.telegram.org`:
корпоративный файрвол, блокировка на уровне провайдера, отфильтрованные
датацентровые подсети. Публичные прокси из бесплатных списков живут недолго и
отваливаются в самый неподходящий момент — обычно когда уведомление нужно срочно.

Релей даёт одну постоянную точку входа, до которой дотягивается почти любой хост:
`script.google.com`. Google доступен оттуда, где Telegram недоступен, а сам релей
дёргает Bot API уже со своих адресов.

Что это даёт:

- **Меняется одна строка.** Базовый URL в коде; сами вызовы Bot API остаются
  прежними.
- **Токен не уезжает в клиент.** Он в свойствах скрипта, в URL едет только общий
  секрет релея.
- **Ноль инфраструктуры.** Бесплатно, без сервера, сертификатов, обновлений и
  мониторинга.
- **Журнал в Google Sheet по желанию.** Каждый вызов пишется строкой — видно, что
  и когда отправлялось.

Чем платите: 20 000 запросов в день, холодный старт 1–5 с, отсутствие своего
HTTP-статуса (всегда 200, успех — в поле `ok`) и обязательное следование
302-редиректу на стороне клиента. Подробности — в разделе «Грабли».

## Что уже проверено

`npm test` — 22 теста на Node, гоняют `src/Code.gs` в песочнице с заглушками
`UrlFetchApp` / `ContentService` / `PropertiesService` / `SpreadsheetApp`.
Логика проверена локально, до всякого деплоя.

## Быстрый старт

```bash
npm install
npm run login                 # откроется браузер, вход в Google-аккаунт
npm run create                # создаст Apps Script-проект, запишет .clasp.json
npm run push                  # зальёт src/ в проект
npm run deploy                # создаст web app, вернёт URL .../exec
```

`.clasp.json`, `scriptId` и `deploymentId` в git не попадают (см. `.gitignore`) —
это состояние твоей машины, а не исходники.

### Script Properties

Project Settings → Script properties (или `clasp` → ⚙️):

| Свойство | Обяз. | Что делает |
|---|---|---|
| `RELAY_SECRET` | да | секрет из query. Пусто → релей отвечает `not_configured` |
| `BOT_TOKEN` | да* | токен бота по умолчанию |
| `BOTS` | нет | JSON `{"lead":"123:AAA","hermes":"456:BBB"}`, выбор через `&b=lead` |
| `ALLOWED_METHODS` | нет | список через запятую. Пусто = любые методы |
| `RETRIES` | нет | `0` — выключить единственный ретрай на 5xx |
| `LOG_SHEET_ID` | нет | id таблицы: по строке на каждый вызов |
| `LOG_SHEET_NAME` | нет | имя листа, по умолчанию `relay_log` |
| `LOG_TEXT` | нет | `1` — писать в лог обрезанный текст сообщения |

\* нужен либо `BOT_TOKEN`, либо запись в `BOTS` под запрошенным `&b=`.

`RELAY_SECRET` генерировать так: `openssl rand -hex 24`.

### Деплой web app

В `appsscript.json` уже стоит нужное:

```json
"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
```

`ANYONE_ANONYMOUS` значит «без авторизации Google» — защита только на
`RELAY_SECRET`, поэтому секрет не должен утекать в публичный репозиторий.

После правки кода URL меняется, если делать новый деплой. Чтобы сохранить URL:

```bash
npm run deployments                                  # посмотреть ID
npx clasp deploy --deploymentId <ID> --description "update"
```

## Интерфейс

```
POST <exec_url>?k=<SECRET>&m=<method>[&b=<alias>]
Content-Type: application/json | application/x-www-form-urlencoded | multipart/form-data
<body>
```

Тело уходит в Telegram дословно, вместе с Content-Type (включая boundary для
multipart). Параметры из query, кроме `k` / `m` / `b`, тоже приклеиваются к URL
наверх — так работают и GET-вызовы.

Ответ всегда:

```json
{
  "ok": true,
  "status": 200,
  "method": "sendMessage",
  "ms": 148,
  "data": { "ok": true, "result": { "message_id": 42, ... } }
}
```

`ok: true` — только если Telegram вернул HTTP 200 **и** `data.ok === true`.
Ошибки самого релея: `ok: false`, `status: 0`, поля `error` / `message`
(`unauthorized`, `method_required`, `method_not_allowed`, `unknown_bot`,
`no_token`, `not_configured`, `fetch_failed`).

### Служебный вызов

```
GET <exec_url>?k=<SECRET>&m=__health
```

Отвечает без обращения к Telegram: жив ли релей, какие алиасы ботов настроены.
Позволяет отличить «релей лежит» от «релей жив, но Telegram недоступен».

## Клиент

curl (`-L` обязателен, см. «Грабли»):

```bash
curl -sSL -X POST "$RELAY_URL?k=$RELAY_SECRET&m=sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":203925128,"text":"привет"}'
```

Python:

```python
import os
import requests

RELAY = os.environ["TG_RELAY_URL"]        # .../exec
SECRET = os.environ["TG_RELAY_SECRET"]

def send(text: str, chat_id: int) -> dict:
    r = requests.post(
        RELAY,
        params={"k": SECRET, "m": "sendMessage"},
        json={"chat_id": chat_id, "text": text},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if not body.get("ok"):
        raise RuntimeError(f"telegram relay: {body}")
    return body["data"]["result"]
```

Проверка живого деплоя:

```bash
RELAY_URL=".../exec" RELAY_SECRET="..." npm run probe
RELAY_URL=".../exec" RELAY_SECRET="..." node scripts/probe.mjs --health
```

## Грабли, о которых надо знать заранее

- **Всегда HTTP 200.** Apps Script не умеет ставить статус ответа. Клиент обязан
  смотреть на `ok` в теле, а не на код ответа.
- **302 редирект.** Ответ приходит не напрямую, а редиректом на
  `script.googleusercontent.com`. Клиент должен ходить по редиректам: `curl -L`,
  `requests`, `fetch` — умеют; самописные «не следую за 3xx» — нет. На этом
  ломается большинство попыток.
- **Заголовки запроса не видны.** `doPost` не отдаёт `e.headers`, поэтому секрет
  едет в query, а не в `X-*`. Следствие: секрет попадает в логи Google — он
  должен быть отдельным от токена бота и меняться независимо.
- **Холодный старт 1–5 с**, `ms` в ответе показывает уже только время апстрима.
- **20 000 `UrlFetch`/день** (100 000 на Workspace) и **6 минут на исполнение**.
- **Файлы не гонять через релей.** Для документов сначала `getFile`/`file_id`,
  потом `sendDocument` с `file_id` — иначе упрётесь в лимиты размера и времени.
- **Google-домены троттлятся из РФ.** Если дев-сервер не достаёт Telegram,
  проверьте сначала `m=__health` — возможно, он и до Google не достаёт.

## Структура

```
src/Code.gs            вся логика релея (doPost/doGet)
src/appsscript.json    манифест: V8, web app ANYONE_ANONYMOUS
test/harness.mjs       песочница с заглушками GAS-глобалок
test/relay.test.mjs    22 теста, node --test
scripts/probe.mjs      живая проверка задеплоенного релея
```

## Лицензия

MIT
