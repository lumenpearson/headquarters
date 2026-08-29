# «Гремучая смесь — Оперативный штаб»

Production-ready local-first оперативная система для съёмочной площадки. Единый нормализованный
мир связывает операцию, 8 секторов, 32 объекта, 30 дел, 24 материала, 16 симулированных каналов и
120 событий: тревоги, задачи, маршруты, каналы связи, сенсоры, аналитику и отчёты. Проект работает
как Next.js
web SPA и как нативная Tauri 2 оболочка со статическим offline export. Основной контур остаётся
local-first; сеть требуется только для опционального слоя Yandex Maps JavaScript API v3.

## Что реализовано

- Next.js 16.3 App Router, React 19.2, React Compiler и Turbopack;
- 18 взаимосвязанных оперативных маршрутов: обзор, объекты, дела, карта, видео, связь, файлы,
  архив, аналитика, отчёты, поиск, настройки, система и детальные карточки;
- два Zustand-store — оперативный снимок с нормализованными сущностями и локальной persistence
  и небольшой держатель runtime-состояния — с синхронизацией BroadcastChannel между окнами;
- детерминированная симуляция событий, телеметрии, каналов и системных ресурсов с паузой и
  масштабом времени;
- полноэкранная production-панель: 9 пресетов, camera-safe, фиксированные часы, 6 monitor ID,
  auto-demo и continuity snapshots;
- терминальный квадратный UI для 720p, Full HD, ultrawide и 4K: без скруглений и теней, с восемью
  темами — от `terminal-red` по умолчанию до `light-operations` и двух high-contrast — и четырьмя
  режимами подачи;
- полноразмерная flex/grid-матрица без фиксированного `max-width`: панели занимают доступный монитор,
  а плотные экраны используют внутреннюю прокрутку вместо обрезки или горизонтального overflow;
- CCTV-плеер на Vidstack React 1.15.6 с собственной terminal-компоновкой: demo/archive timeline,
  frame step, ±10 секунд, скорость, громкость, mute, snapshot, Picture-in-Picture, fullscreen,
  PTZ и реестр 16 каналов с фильтрами, сортировкой и пагинацией 12+4; декодируется только выбранный
  источник, а остальные каналы используют статические thumbnails; штатные источники — встроенные
  демо-ролики, назначенные локальные материалы и явно разрешённая пользователем веб-камера;
- тактическая карта на Yandex Maps JavaScript API v3 с объектами, маршрутами, тревогами,
  ограниченными зонами, датчиками и сохранением географического viewport; настройка `map.mode`
  даёт три представления — `tactical`, `map` и `satellite`, причём последнее намеренно скрывает
  зоны, датчики и маршруты, пока к нему не подключены снимки;
- типизированные domain/application/infrastructure/UI границы в Turborepo;
- Base UI 1.7 как headless-основа 25 публичных Terminal-компонентов без изменения терминальной
  дизайн-системы; прямые Base UI imports и нативные JSX-controls вне `packages/ui` запрещены CI;
- безопасный персонализационный draft: 71 schema-bound определение в 32 категориях и 7 разделах —
  темы, стили, цвета, типографика, фон, узоры, плотность, плитки, анимации, таблицы, доступность,
  плеер, карта, локализация — с поиском по всему каталогу, фильтром «только изменённые»,
  category/all reset, undo/redo, discard/publish, JSON export и import со схемной проверкой и
  локальной историей, без arbitrary HTML/CSS/JS;
- общий deterministic `@gremuchaya/layout-engine`: bounded tile packing, compact presentation,
  relocation и explicit overflow policy вместо document-scroll как способа скрыть контент;
- версионированный Protobuf-контур `gremuchaya.*.v1`: common, control, materials, settings, sync,
  telemetry, integrations и локальный bridge с генерируемыми TypeScript bindings;
- Node ConnectRPC control-plane foundation с typed health/capabilities, бинарным gRPC-Web,
  Connect protocol, binary Protobuf WebSocket-resume, CORS allowlist, security headers и ленивыми
  Neon/Upstash adapters;
- 52 Zod-валидируемые scene definition с отдельными cue и asset requirements;
- 19 модулей: idle, map, satellite, CCTV, dossier, OSINT, face/vehicle recognition, comms,
  graph, news, access, system tables, audio, photo archive, interrogation, security, explorer и print;
- маршруты Control, 9 независимых `/screen/*`, 3 `/wall/*` и 52 `/scene/*`;
- BroadcastChannel screen bus с localStorage fallback и heartbeat;
- Virtual Explorer: эмулированная файловая система, реальная папка браузера, localhost bridge и
  зарегистрированные Tauri roots;
- локальный file bridge, read-only по умолчанию, с CORS allowlist, защитой от
  traversal/symlink escape, бинарным gRPC-Web, server-streaming watcher и
  явным opt-in для ограниченного локального импорта в `shared/materials`;
- Tauri-команды для мониторов, managed windows, безопасного чтения и native watcher;
- режим редактирования `Ctrl+Shift+E`: скрыть плитку или целую группу по имени прямо на экране,
  переупорядочить и растянуть их, с необязательным каналом live-edit, который открывается только
  при явном включении `advanced.liveEdit`;
- контекстные меню по правой кнопке над оболочкой и записями, карточка сочетаний `Ctrl+/` и
  терминальная последовательность запуска;
- скрытый инженерный контур, simulation flags, локальные snapshots, JSON export;
- local placeholders и runtime asset override без изменения scene-файлов.

## Быстрый запуск

Требования: Node 24.3+, pnpm 10.12+, Rust/Cargo 1.88+ для desktop-сборки.

```powershell
corepack enable
pnpm install
pnpm dev:hq
```

Операторская страница: `http://127.0.0.1:3000`. Основные маршруты:

- `/` и `/overview/` — сводка единого оперативного мира;
- `/objects/`, `/objects/K-17/` — реестр и карточка объекта;
- `/cases/`, `/cases/CASE-01/` — дела и досье;
- `/map/` — интерактивная тактическая карта;
- `/video/`, `/video/cameras/`, `/video/archive/` — видео, video wall и архив;
- `/communications/`, `/files/`, `/archive/` — связь и материалы;
- `/analytics/`, `/reports/`, `/search/` — аналитика, отчёты и единый поиск;
- `/settings/`, `/system/`, `/dev/ui/` — настройки, ресурсы и UI-каталог;
- `/control/` — совместимый оператор 52 сцен и Virtual Explorer;
- `/screen/wall-center/` — отдельный экран;
- `/wall/hq-standard/` — стеновой preset;
- `/scene/s02-58/` — прямой вход в сцену;
- `/dev/` — защищённый прямой вход в инженерный контур.

В новом штабе действует одна из трёх схем, которую выбирает настройка `keybinds.scheme`. В схеме
по умолчанию `terminal-default`: `Ctrl+K` открывает глобальный поиск, `Ctrl+Shift+P` —
production-панель, `F` — fullscreen, цифры `1–9` переключают разделы, `Space` управляет
видеопотоком, `Ctrl+/` показывает карточку сочетаний, `Ctrl+Shift+E` включает режим
редактирования, `Esc` закрывает drawer или production-панель. Схема `accessibility` заменяет
многомодификаторные аккорды функциональными клавишами и одиночным Ctrl, `vim-inspired` — на
`hjkl`, `/` и последовательности с префиксом `g`. Актуальный список всегда виден по `Ctrl+/` и в
разделе «НАСТРОЙКИ». Реестр смонтирован на весь документ, поэтому те же клавиши и инженерный
overlay `Ctrl+Shift+Alt+D` работают и на совместимом `/control/`.

На экране «ФАЙЛЫ» сочетание `Ctrl+Shift+Alt+S` открывает скрытый локальный import dialog. Он
доступен только при явном opt-in loopback bridge из раздела ниже; если bridge не запущен или
оставлен read-only, диалог честно показывает локальную ошибку и не отправляет файл в сеть.

### Черновик персонализации

В «НАСТРОЙКИ» работает локальный **SAFE DRAFT**. Каталог из 71 настройки — от темы и плотности до
межбуквенного интервала, ширины фокусного кольца и размера страницы таблиц — применяется как
обратимый preview, а `[CTRL+ENTER] ОПУБЛИКОВАТЬ` атомарно фиксирует revision. `[R]` сбрасывает
категорию, `[RR]` — весь draft, `[CTRL+Z]` и `[CTRL+Y]` отменяют и повторяют шаг, `[ESC]`
отменяет неподтверждённые изменения, `[↓]` формирует JSON export, `[↑]` принимает его обратно
через ту же schema validation. Значения проходят централизованную schema validation, поэтому ни
сохранённый draft, ни edit mode не могут внедрить HTML, JavaScript или произвольное CSS.

Реестр насчитывает 158 определений (16 групповых, 142 машинных), и почти каждое читает либо
корень документа, либо названный потребитель. Два — `simulation.preset` и
`layout.tileMinimumWidth` — пока не читает никто: их функции ещё нет. Учёт ведётся в
`apps/hq/src/application/personalization/presentation.ts`, где тест не даёт третьему
определению тихо присоединиться к этим двум.

## Терминальный режим оператора

Весь интерфейс собран на Signal Mesh design system: глубокий чёрный холст, тонкие серые rails,
яркий красно-оранжевый системный сигнал, белая/дымчатая типографика, ASCII-поле, прямые углы,
bracket controls и выделенные верхней оранжевой линией панели. Заголовки используют крупный
геометрический sans, данные — моноширинный шрифт. Это тема по умолчанию: настройка `themes.id`
даёт ещё семь, включая `light-operations` и две high-contrast. Декоративные скругления и тени
отключены во всём операторском контуре, включая совместимые scene/wall/control маршруты, —
радиус равен нулю в самих токенах. Blur остаётся ровно в двух местах: подложка палитры команд и
панель разработчика, — и как явная настройка `backgrounds.blur` для операторского фонового
изображения или видео. Навигация и действия доступны мышью и терминальными сочетаниями схемы
`terminal-default`:

- `1–9` — основные разделы;
- `Ctrl+K` — глобальный поиск;
- `Ctrl+Shift+P` — production-панель;
- `F` — fullscreen / kiosk;
- `Space` — play/pause в видеоконтуре;
- `Ctrl+/` — карточка сочетаний;
- `Ctrl+Shift+E` — режим редактирования;
- `Esc` — закрыть drawer или production-панель.

Клавиши сценового оператора живут в том же реестре и той же схеме; на `/control/` их владелец —
сценовая оболочка:

- `F2` — раздел «ФАЙЛЫ» с Virtual Explorer;
- `F3` — раздел «КАРТА»;
- `F7` — предыдущий cue;
- `F8` — выполнить следующий cue;
- `F9` — сбросить текущую сцену;
- `Ctrl+Shift+K` — командная строка `:COMMAND`;
- `Esc` — закрыть командную строку;
- `Ctrl+Shift+Alt+D` — инженерный контур.

## Подключение настоящих материалов

### Папка из браузера

Откройте раздел «ФАЙЛЫ», нажмите «ПОДКЛЮЧИТЬ ПАПКУ» и предоставьте read-only доступ. Источник
работает через File System Access API и никогда не передаёт файлы на сервер.

### Localhost file bridge

```powershell
Copy-Item apps/file-bridge/bridge.config.example.json apps/file-bridge/bridge.config.json
$env:HQ_BRIDGE_CONFIG = (Resolve-Path apps/file-bridge/bridge.config.json)
pnpm --filter @gremuchaya/file-bridge build
pnpm bridge
```

В `bridge.config.json` замените `mounts[].root` на точный каталог съёмочной машины. Bridge слушает
только `127.0.0.1`, принимает только разрешённые Origin и обслуживает бинарный gRPC-Web поверх
HTTP/1.1. Прикладного REST и WebSocket endpoints нет: единственный не-gRPC путь —
`/v1/material-playback/…`, data plane для байтовых диапазонов крупного локального медиа,
описанный ниже. Контракт находится в
`packages/protocol/proto/gremuchaya/bridge/v1/bridge.proto`: unary RPC `Health`/`List`,
material-import RPC и server-streaming RPC `ReadFile`/`ReadImportedMaterial`/`Watch`.
Статические runtime JSON остаются локальными ресурсами приложения и не являются сетевым REST API.

По умолчанию bridge остаётся строго read-only. Для локального импорта в content-addressed mirror
`shared/materials/.hq` оператор должен сознательно включить **оба** флага в локальном, не
коммитимом `bridge.config.json`:

```json
{
  "readOnly": false,
  "materialImport": {
    "enabled": true,
    "maxFileBytes": 5368709120,
    "chunkSizeBytes": 1048576
  }
}
```

Импорт сначала рассчитывает ожидаемый BLAKE3 digest в потоковом module worker браузера (с
потоковым fallback для legacy shell), а bridge заново и независимо проверяет его перед commit.
Затем он принимает упорядоченные ограниченные чанки, кладёт объект атомарно по content hash и
создаёт отдельную мета-запись. Файлы служебной директории `.hq` никогда не выдаются через обычный
Explorer RPC. Загруженные материалы сразу показываются в реестре «ФАЙЛЫ» как `LOCAL MIRROR /
GRPC-WEB`; UI передаёт файл в ограниченных Protobuf-чанках, может отменить текущий импорт и
отображает cursor-paginated recent list. Локальный viewer уже безопасно показывает изображения,
PDF, plain/structured text и local audio/video: содержимое читается тем же gRPC-Web stream и
только в ограниченные 2 MiB (text) либо 32 MiB (image/PDF/media) buffers. Последний вариант
использует тот же custom Vidstack player. Крупное локальное аудио и видео в буфер не читается:
viewer запрашивает playback-grant и играет файл диапазонами через тот же loopback data plane.
Metadata-only остаются только неизвестные типы и превысившие лимит изображения, PDF и текст.
Это пока локальный foundation: облачный Blob, преобразования и межклиентская синхронизация в
браузерном контуре ещё не включены. Версии, корзину и возобновляемую загрузку уже реализует
`MaterialService` control-plane, но клиента к нему в `apps/hq` нет ни одного.

### Control-plane foundation

Локальный control-plane запускается отдельно от UI и file bridge:

```powershell
Copy-Item apps/control-plane/.env.example apps/control-plane/.env
pnpm --filter @gremuchaya/control-plane build
pnpm control-plane
```

`apps/control-plane/.env` читают все три точки входа пакета — `dev`, `start` и `migrate` —
через `--env-file-if-exists`, а набор тестов через `vitest.config.ts`. Файл игнорируется
git. Без него сервис поднимается в health-only режиме, а не падает: флаг именно
`--env-file-if-exists`, а не `--env-file`, чтобы отсутствие файла не ломало `pnpm dev`.

RPC `gremuchaya.control.v1.ControlPlaneService/Health` и `GetCapabilities` доступны через
Connect/gRPC-Web. Каждая из десяти capability выводится из того, что корень композиции
действительно собрал, а не из константы: `sync` включается вместе с устойчивым журналом событий,
`sync.device-lifecycle` — вместе с durable-рантаймом, `sync.realtime-admission` — вместе с
допуском, а `materials`, `settings`, `telemetry` и `integration` — вместе с соответствующими
durable-хранилищами. Health-only запуск объявляет включёнными только `control.health` и два
транспорта. В полной конфигурации `Health` отдельно сообщает состояние `database` и `redis`,
читая его из конфигурации, а не проверяя соединением: health-check, открывающий сеть, падал бы
по причине, не имеющей отношения к тому, обслуживает ли сервис запросы; в health-only режиме
список зависимостей пуст — сообщать не о чем. Endpoint `/api/health` намеренно отсутствует:
прикладной REST не используется.

`SyncService` реализован целиком: семнадцать объявленных RPC плюс `GetDocumentSnapshot`,
добавленный в F6 — без него `ResyncRequired` говорил клиенту «возьми снимок», а взять его
было неоткуда.

Рядом с ним зарегистрированы ещё четыре сервиса того же контракта: `SettingsService` (13 RPC),
`MaterialService` (16 RPC, включая версии, корзину и streaming `WatchMaterialEvents`),
`TelemetryService` (7 из 10 — `ListDataSources`, `GetTelemetrySnapshot` и `StreamTelemetry`
намеренно оставлены `unimplemented` до отдельного источника телеметрии) и `IntegrationService`
(7 RPC). RPC, которым нужен не заданный здесь секрет — выдача storage-grant, GitHub-egress, —
отвечают `FAILED_PRECONDITION` или `unimplemented` с именем недостающего, а не пустым успехом.

Все пять сервисов включаются только вместе с durable auth. Для этого нужны
`HQ_CONTROL_PLANE_DATABASE_URL` и две независимые серверные тайны не короче 32 непробельных
символов — `HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER` и `HQ_CONTROL_PLANE_BOOTSTRAP_SECRET`. Полный
список с границами TTL — в `apps/control-plane/.env.example`. Без них поднимается только
`ControlPlaneService`.

Ни один из пяти сервисов пока не вызывается из приложения: в `apps/hq` есть только два
ConnectRPC-клиента, и оба идут в локальный `FileBridgeService`.

Schema Neon разложена на восемь проверяемых миграций — от `0001_control_plane_foundation` до
`0008_service_documents_and_receipt_scopes`; вместе они создают 30 постоянных таблиц. `0007`
добавляет `group_event_sequences`, откуда PostgreSQL выдаёт номера событий, а `0008` — документы
сервисов настроек, материалов, телеметрии и интеграций. Соединение не открывается при старте
health-only сервиса: чтобы применить миграции к предварительно созданной приватной базе Neon,
пользователь задаёт секрет только в окружении процесса и запускает отдельную команду:

```powershell
$env:HQ_CONTROL_PLANE_DATABASE_URL = "postgresql://<role>:<password>@<neon-host>/<database>?sslmode=require"
pnpm --filter @gremuchaya/control-plane migrate
```

Мигратор использует таблицу `hq_schema_migrations`, SHA-256 checksum и PostgreSQL advisory
transaction lock. Ту же процедуру выполняет сам сервер при старте в полной конфигурации: он
завершает миграции до регистрации первого RPC. URL базы и любые другие секреты не попадают в
репозиторий, браузерный bundle или gRPC-ответы.

Тот же `.env` читает и `vitest.config.ts`, поэтому на машине с заданным
`HQ_CONTROL_PLANE_TEST_DATABASE_URL` `pnpm test` дополнительно выполняет десять наборов против
настоящего PostgreSQL: они создают и удаляют базы `hqtest_*` рядом с указанной и отказываются
работать, если URL совпадает с боевым. CI эту переменную не задаёт, поэтому наборы там
пропускаются целиком.

Для presence и ограничения частоты публикаций control-plane использует отдельный ленивый Upstash
Redis adapter. Для включения надо передать **обе** server-only переменные;
одна переменная без другой отклоняется при запуске. Когда ни одно из явных имён
не задано, конфигурация берёт пару `KV_REST_API_URL` / `KV_REST_API_TOKEN`,
которую пишет интеграция Vercel Marketplace; у явных имён приоритет, а пара,
разорванная между двумя схемами имён, отклоняется так же, как половина одной:

```powershell
$env:HQ_CONTROL_PLANE_REDIS_REST_URL = "https://<redis-id>.upstash.io"
$env:HQ_CONTROL_PLANE_REDIS_REST_TOKEN = "<upstash-rest-token>"
pnpm control-plane
```

PostgreSQL остаётся источником истины. Redis содержит лишь быстро истекающее присутствие,
координационные lease и счётчики; state не может быть восстановлен из Redis после перезапуска.

С заданной парой присутствие отвечает `OFFLINE` для устройства, чей ключ живучести истёк, —
строка в `presence_snapshots` этого знать не может, потому что не истекает, — а групповые
публикации ограничиваются по частоте: `PublishDocumentDelta` и `PublishSessionCommand` —
единственные RPC, дописывающие в журнал без естественного потолка. Без пары control-plane
работает: присутствие отдаёт последнее записанное состояние, публикации не ограничены, и
`Health` говорит, какой из двух режимов действует.

`nextSequence` сознательно не подключён. Он возвращает `number`, что теряет точность против
`GroupEvent.sequence`, а сброс Redis отмотал бы счётчик вразрез с `sync_events.sequence`,
чьё уникальное ограничение после этого начало бы отклонять публикации. Номера событий
выдаёт PostgreSQL — таблица `group_event_sequences`. Вместе с ним не подключён и lease лидера
сессии: он реализован в адаптере, но авторитет группы пока живёт в `groups.leader_device_id`, а
не в истекающем ключе.

#### Realtime transport

Тот же process control-plane принимает **только бинарные Protobuf WebSocket frames** на
`/realtime`. После `ClientHello` с идентификаторами группы/устройства сервер возвращает `ready`,
переигрывает события с cursor `after_sequence` и продолжает доставку новых событий. Если cursor
старее ограниченной retained history, клиент получает явный `resync_required`, а не неполное
состояние. Text frames и повреждённые Protobuf messages получают типизированный error envelope;
upgrade с неразрешённого Origin отвергается.

Этот слой аутентифицирован: допуск проверяет тот же access-token, группу и устройство, что и
SyncService, и перепроверяет их перед каждой защищённой операцией. Историю переигрывает не память
процесса, а таблица `sync_events`, поэтому перезапущенный control-plane отвечает на resume теми
же событиями. Незакрытым остаётся одно: живая рассылка между несколькими экземплярами — набор
слушателей принадлежит процессу, а Upstash REST не даёт pub/sub, поэтому разрыв закрывает
очередной resume клиента. Реальный Vercel проект, секреты и WebSocket provider не настраиваются
автоматически и требуют отдельного интерактивного входа пользователя.

Полный исходный контракт находится в `packages/protocol/proto/gremuchaya/*/v1`. После изменения
`.proto` необходимо выполнить:

```powershell
pnpm --filter @gremuchaya/protocol generate
pnpm --dir packages/protocol exec buf lint
pnpm --filter @gremuchaya/protocol test
```

#### Собственное развёртывание (Docker)

Контрольную плоскость можно поднять у себя — со своей базой, своими секретами и без учётной записи
где бы то ни было. Нужны Docker с Compose v2 и Node для генератора секретов:

```powershell
node scripts/generate-env.mjs
docker compose up -d --build --wait
docker compose ps
docker compose down
```

Генератор пишет `.env` рядом с `compose.yaml`, печатает имена переменных и путь — но не значения — и
без `--force` существующий файл не перезаписывает. Плоскость отвечает на `http://127.0.0.1:4100`
поверх PostgreSQL в соседнем контейнере, а `--wait` возвращает управление только после того, как
миграции прошли и `sync.device-lifecycle` с `sync.realtime-admission` включены.

Что этот уровень умеет, чего не умеет и как подняться до объектного хранилища —
`docs/release/self-hosting.md`. Почему в образ входит только `apps/control-plane` —
`docs/adr/0010-container-deployment.md`.

### Tauri native roots

Перед запуском Tauri задайте allowlist каталогов через стандартный path-list разделитель Windows:

```powershell
$env:HQ_NATIVE_ROOTS = "D:\HQ\INCOMING;D:\HQ\APPROVED"
pnpm tauri:dev
```

Абсолютные пользовательские пути, `..` и symlink/junction внутри зарегистрированного root
отклоняются native-командами.

### Симулированные каналы, локальные материалы и веб-камера

Экран `/video/cameras` использует единый типизированный реестр всех 16 симулированных каналов. На
одном viewport
показывается не более 12 статических thumbnails; оставшиеся каналы доступны через локальную
пагинацию, фильтры и сортировку. Только выбранный поток передаётся Vidstack, поэтому скрытые и
внеэкранные плитки не создают дополнительные media decoders.

Основная source model намеренно не требует настоящих камер:

- `DEMO_VIDEO` — встроенный WebM-ролик, зацикленный для выбранного симулированного канала;
- `LOCAL_MATERIAL` — видео, выбранное для симулированного канала через поле источника на `/video`.
  В local storage сохраняется только `cameraId → materialId` (UUID), а не файловый путь, `blob:` URL
  или байты. Материалы до 32 MiB читаются ограниченным binary gRPC-Web запросом и получают временный
  `blob:` URL. Для более крупных видео UI сначала запрашивает через gRPC-Web пятиминутный
  playback-grant, а затем Vidstack читает только нужные диапазоны файла через защищённый loopback
  HTTP Range data plane. Grant URL хранится только в памяти, не раскрывает путь материала,
  продлевается лишь при разрешённом чтении и явно отзывается при смене канала, источника либо
  размонтировании экрана. HTTP здесь переносит только байты медиа и не является прикладным REST API;
- `WEBCAM` — локальный `MediaStream`, который запрашивается только после `[W] WEBCAM` или клавиши
  `W`, никогда не включается при загрузке страницы и не отправляется в bridge, control-plane или
  групповую синхронизацию.

При смене канала, повторном нажатии кнопки и размонтировании экрана все tracks веб-камеры
останавливаются. Отказ разрешения, отсутствие устройства, занятое устройство и завершение track
показываются внутри terminal-панели; после остановки плеер возвращается на демо-источник. UI явно
маркирует `DEMO LOOP`, `LOCAL MATERIAL` и `LOCAL WEBCAM`, поэтому симуляция не выдаётся за реальное
наблюдение.

Если локальный каталог материалов недоступен, назначенный канал сохраняет своё UUID-назначение, но
безопасно возвращается к демо-циклу и показывает terminal-статус ошибки. Это не открывает произвольный
локальный путь и не пытается восстановить устаревший runtime `blob:` URL. Источник веб-камеры остаётся
отдельным временным override и не заменяет назначение материала.

Range-grant выдаётся только для зарегистрированного локального аудио/видео, привязан к
`127.0.0.1`, допускает один RFC 7233 byte range за запрос, поддерживает `GET`/`HEAD`, возвращает
`416` для некорректного диапазона и проверяет точный origin приложения. В памяти bridge хранится
только SHA-256 digest capability-token; исходный токен существует лишь в непрозрачном URL. При
отзыве, истечении idle TTL или остановке bridge последующее чтение возвращает `404`.

### Локальная синхронизация воспроизведения

Для демо-роликов и загруженных материалов browser-сессии одного профиля синхронизируют `PLAY`,
`PAUSE`, `SEEK`, скорость и выбор канала через отдельный `BroadcastChannel`-контур. Команда несёт
только `epoch`, последовательность, момент выполнения, безопасный source identity
`cameraId + DEMO_VIDEO | LOCAL_MATERIAL + materialId`, позицию и скорость. Она никогда не несёт
путь, `blob:` URL, capability URL, token или `MediaStream`; локальная веб-камера и выключенный RTSP
adapter намеренно остаются несинхронизируемыми.

Локальная команда исполняется через 40 ms, а получатель применяет только новую валидную команду для
того же source identity. Повторные и устаревшие последовательности отбрасываются; в режиме
`LEADER` принимаются только команды назначенного leader device. Общий Zustand snapshot bus больше
не реплицирует transient `videoPlaying`, `videoLive` и `videoPosition`, чтобы не обгонять этот
упорядоченный playback-поток. Подключение того же command contract к control-plane WebSocket/Protobuf
остаётся отдельным следующим checkpoint: он нужен для синхронизации между разными браузерными
профилями, устройствами и группами.

### Необязательный RTSP compatibility adapter

Ранее реализованный Tauri RTSP→HLS модуль сохранён для совместимости и тестирования, но выключен по
умолчанию, не является production-требованием и не участвует в обычном сценарии. Без opt-in в
browser registry нет ни одного `RTSP_GATEWAY` source, пустая native-конфигурация не запускает FFmpeg
workers, а loopback health возвращает `disabled`.

Для осознанного compatibility-теста его можно включить отдельно:

```powershell
$env:NEXT_PUBLIC_HQ_ENABLE_NATIVE_RTSP_GATEWAY = "true"
$env:HQ_CAMERA_STREAMS_CONFIG = `
  (Resolve-Path "apps/hq/src-tauri/media-gateway.config.local.json").Path
pnpm tauri:dev
```

Шаблон `apps/hq/src-tauri/media-gateway.config.example.json` намеренно содержит пустой массив
`cameras`. Если compatibility adapter действительно нужен, создайте игнорируемый Git локальный
файл и заполните его самостоятельно; credentials не должны попадать в example, Next.js environment,
browser state или логи. Внешний browser gateway также остаётся opt-in и принимает только
credential-free HTTP(S) origin через `NEXT_PUBLIC_HQ_RTSP_GATEWAY_ORIGIN`.

Сохранённый adapter по-прежнему имеет следующие ограничения и гарантии:

- bind выполняется только на `127.0.0.1` и случайном свободном порту;
- CORS разрешён только dev-origin приложения и Tauri origins;
- браузер повторно проверяет protocol, hostname, stream ID, grant и HLS filename;
- одновременно работает не больше двух FFmpeg workers в безопасном example, допустимый предел — 16;
- один worker может обслуживать несколько окон через consumer leases;
- worker останавливается после выхода последнего consumer;
- `kill_on_drop` и shutdown control-window завершают дочерние процессы;
- supervisor проверяет workers каждые 500 мс и после завершения FFmpeg перезапускает тот же поток;
- reconnect сохраняет прежние `stream_id`, 256-битный grant, generation и manifest URL;
- повторный запуск использует exponential backoff от 500 мс до 30 секунд с детерминированным
  per-camera jitter; после пяти последовательных сбоев поток помечается `degraded`;
- после 30 секунд стабильной работы счётчик последовательных сбоев сбрасывается;
- native status сообщает `starting`, `ready`, `reconnecting` или `degraded`, число consumer leases,
  перезапусков и возраст последнего manifest; публичный loopback health содержит только агрегаты;
- Tauri-клиент повторяет неуспешный startup с паузами 500 мс, 1, 2, 4 и максимум 8 секунд;
- после временного перехода Vidstack на локальный fallback клиент повторно проверяет native lease и
  возвращает плеер на тот же HLS URL, когда worker снова становится `ready`;
- HLS playlist ограничен шестью двухсекундными сегментами;
- `delete_segments` удаляет вышедшие из окна сегменты;
- traversal и произвольные имена файлов не обслуживаются;
- недоступный FFmpeg при первом spawn приводит к локальному WebM fallback; завершившийся после
  запуска worker остаётся под контролем supervisor и восстанавливается на прежнем HLS URL.

Проверка с настоящей RTSP/RTSPS камерой, Credential Manager, persistent recording и camera fleet
hardening сознательно исключены из Definition of Done. Они могут появиться только как отдельный
future compatibility scope, если требования проекта изменятся.

### Yandex Maps JavaScript API v3

Карта использует официальный JavaScript API v3 в векторном режиме и не содержит прежней
рисованной SVG-подложки. Создайте JavaScript API v3-ключ в панели разработчика Яндекса,
разрешите HTTP Referer для каждого web-origin приложения и выберите один из способов:

1. На установленной машине откройте `/map/`, вставьте v3-ключ в локальную форму и нажмите
   `[APPLY] ПОДКЛЮЧИТЬ`. Ключ сохраняется только в localStorage текущего приложения. Старый
   localStorage-ключ v2 намеренно не импортируется: требуется явно выдать или вставить ключ v3.
2. Для заранее настроенной сборки скопируйте `apps/hq/.env.example` в `apps/hq/.env.local` и задайте:

```powershell
$env:NEXT_PUBLIC_YANDEX_MAPS_API_KEY = "ваш_ключ"
pnpm --filter @gremuchaya/hq build
```

В кабинете ключа разрешите домен web-версии и используйте точные HTTP Referer origins. Для
desktop-сборки учитывайте origin Tauri webview. Без ключа или при недоступном provider приложение
продолжает работать: карта показывает наполненный координатами и объектами терминальный fallback,
а остальные экраны и локальный CCTV-поток остаются автономными.

## Runtime-конфигурация

Коммитятся безопасные defaults:

- `apps/hq/public/runtime/project.default.json`;
- `apps/hq/public/runtime/assets_manifest.json`;
- `apps/hq/public/runtime/filesystem.emulated.json`.

Для площадки скопируйте `project.override.example.json` в `project.override.json`. Файл override
игнорируется Git. В нём можно сменить runtime mode и направить asset ID на статический URL,
виртуальный файл или emulated renderer. При старте default, manifest, filesystem и override проходят
Zod-валидацию до инициализации UI; некорректный ввод даёт диагностический boot screen.

## Проверки

```powershell
pnpm format:check
pnpm check:ui-boundary
pnpm check:protocol-generation
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ui
pnpm build:offline
pnpm test:cargo
```

Полный локальный gate: `pnpm check` — он же запускает `check:ui-boundary` и
`check:protocol-generation`, без которых устаревшие сгенерированные bindings и прямые Base UI
imports проходят незамеченными. Полный release gate: `pnpm check:release`; Prettier и
`cargo fmt`/`cargo clippy` в него не входят и выполняются отдельно, как в CI. Нативная упаковка:
`pnpm tauri:build`; проверенный Windows NSIS installer появится в
`apps/hq/src-tauri/target/release/bundle/nsis/`.

## Архитектурные документы

- [Карта зависимостей](docs/architecture/dependency-map.md)
- [Information state machines](docs/adr/0004-information-state-machines.md)
- [Offline/static routes](docs/adr/0006-static-route-generation.md)
- [Release runbook](docs/release/runbook.md)
- [Известные ограничения](docs/release/known-limitations.md)
- [Protobuf control-plane contracts](docs/adr/0008-control-plane-protobuf-contracts.md)
