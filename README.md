# «Гремучая смесь — Оперативный штаб»

Production-ready local-first оперативная система для съёмочной площадки. Единый нормализованный
мир связывает операцию, 8 секторов, 32 объекта, 30 дел, 24 материала, 16 камер, 120 событий,
тревоги, задачи, маршруты, каналы связи, сенсоры, аналитику и отчёты. Проект работает как Next.js
web SPA и как нативная Tauri 2 оболочка со статическим offline export. Основной контур остаётся
local-first; сеть требуется только для опционального слоя Yandex Maps API 2.1.

## Что реализовано

- Next.js 16.3 App Router, React 19.2, React Compiler и Turbopack;
- 18 взаимосвязанных оперативных маршрутов: обзор, объекты, дела, карта, видео, связь, файлы,
  архив, аналитика, отчёты, поиск, настройки, система и детальные карточки;
- единый Zustand-store с нормализованными сущностями, локальной persistence и синхронизацией
  BroadcastChannel между окнами;
- детерминированная симуляция событий, телеметрии, каналов и системных ресурсов с паузой и
  масштабом времени;
- полноэкранная production-панель: 9 пресетов, camera-safe, фиксированные часы, 6 monitor ID,
  auto-demo и continuity snapshots;
- терминальный квадратный UI для 720p, Full HD, ultrawide и 4K: без скруглений, blur и теней;
- полноразмерная flex/grid-матрица без фиксированного `max-width`: панели занимают доступный монитор,
  а плотные экраны используют внутреннюю прокрутку вместо обрезки или горизонтального overflow;
- настоящий CCTV-плеер на HTML Video: live/archive timeline, frame step, ±10 секунд, скорость,
  громкость, mute, snapshot, Picture-in-Picture, fullscreen, PTZ и сетка из 12 каналов;
- тактическая карта на Yandex Maps JavaScript API 2.1 с объектами, маршрутами, тревогами,
  ограниченными зонами, датчиками и сохранением географического viewport;
- типизированные domain/application/infrastructure/UI границы в Turborepo;
- 52 Zod-валидируемые scene definition с отдельными cue и asset requirements;
- 19 модулей: idle, map, satellite, CCTV, dossier, OSINT, face/vehicle recognition, comms,
  graph, news, access, system tables, audio, photo archive, interrogation, security, explorer и print;
- маршруты Control, 9 независимых `/screen/*`, 3 `/wall/*` и 52 `/scene/*`;
- BroadcastChannel screen bus с localStorage fallback и heartbeat;
- Virtual Explorer: эмулированная файловая система, реальная папка браузера, localhost bridge и
  зарегистрированные Tauri roots;
- локальный read-only file bridge с CORS allowlist, защитой от traversal/symlink escape,
  бинарным gRPC-Web, server-streaming watcher и `FILE_READY` после проверки стабильности записи;
- Tauri-команды для мониторов, managed windows, безопасного чтения и native watcher;
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

В новом штабе `Ctrl+K` открывает глобальный поиск, `Ctrl+Shift+P` — production-панель, `F` —
fullscreen, цифры `1–9` переключают разделы, `Space` управляет видеопотоком, `Esc` закрывает
drawer или production-панель. В совместимом `/control/` сохранены прежние сочетания и инженерный
overlay `Ctrl+Shift+Alt+D`.

## Терминальный режим оператора

Весь интерфейс собран на Signal Mesh design system: глубокий чёрный холст, тонкие серые rails,
яркий красно-оранжевый системный сигнал, белая/дымчатая типографика, ASCII-поле, прямые углы,
bracket controls и выделенные верхней оранжевой линией панели. Заголовки используют крупный
геометрический sans, данные — моноширинный шрифт. Декоративные скругления, тени, стекло и blur
отключены во всём операторском контуре, включая совместимые scene/wall/control маршруты.
Навигация и действия доступны мышью и терминальными сочетаниями:

- `1–9` — основные разделы;
- `Ctrl+K` — глобальный поиск;
- `Ctrl+Shift+P` — production-панель;
- `F` — fullscreen / kiosk;
- `Space` — play/pause в видеоконтуре;
- `Esc` — закрыть drawer или production-панель.

Совместимый `/control/` сохраняет клавиши сценового оператора:

- `F2` — Virtual Explorer;
- `F3` — карта;
- `F7` — предыдущий cue;
- `F8` — выполнить следующий cue;
- `F9` — сбросить текущую сцену;
- `Ctrl+K` — командная строка `:COMMAND`;
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
HTTP/1.1. REST `/v1/*` и WebSocket endpoints отсутствуют. Контракт находится в
`packages/protocol/proto/gremuchaya/bridge/v1/bridge.proto`: unary RPC `Health`/`List` и
server-streaming RPC `ReadFile`/`Watch`. Статические runtime JSON остаются локальными ресурсами
приложения и не являются сетевым REST API.

### Tauri native roots

Перед запуском Tauri задайте allowlist каталогов через стандартный path-list разделитель Windows:

```powershell
$env:HQ_NATIVE_ROOTS = "D:\HQ\INCOMING;D:\HQ\APPROVED"
pnpm tauri:dev
```

Абсолютные пользовательские пути, `..` и symlink/junction внутри зарегистрированного root
отклоняются native-командами.

### Yandex Maps API 2.1

Карта использует официальный JavaScript API 2.1 и не содержит прежней рисованной SVG-подложки.
Создайте браузерный API-ключ в панели разработчика Яндекса и выберите один из способов:

1. На установленной машине откройте `/map/`, вставьте ключ в локальную форму и нажмите
   `[APPLY] ПОДКЛЮЧИТЬ`. Ключ сохраняется только в localStorage текущего приложения.
2. Для заранее настроенной сборки скопируйте `apps/hq/.env.example` в `apps/hq/.env.local` и задайте:

```powershell
$env:NEXT_PUBLIC_YANDEX_MAPS_API_KEY = "ваш_ключ"
pnpm --filter @gremuchaya/hq build
```

В кабинете ключа разрешите домен web-версии. Для desktop-сборки учитывайте origin Tauri webview.
Без ключа приложение продолжает работать, а карта показывает терминальное состояние настройки;
остальные экраны и локальный CCTV-поток остаются автономными.

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
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ui
pnpm build:offline
pnpm test:cargo
```

Полный release gate: `pnpm check:release`. Нативная упаковка: `pnpm tauri:build`; проверенный
Windows NSIS installer появится в `apps/hq/src-tauri/target/release/bundle/nsis/`.

## Архитектурные документы

- [Карта зависимостей](docs/architecture/dependency-map.md)
- [Scene state machines](docs/architecture/adr/0004-scene-state-machines.md)
- [Offline/static routes](docs/architecture/adr/0006-static-export-routes.md)
- [Release runbook](docs/release/runbook.md)
- [Известные ограничения](docs/release/known-limitations.md)
