# Release and shoot-day runbook

## 1. Чистая машина

1. Установить Node 24.3+, pnpm 10.12+, Rust 1.88+ и Microsoft WebView2 Runtime.
2. Клонировать repository в локальный каталог без облачной синхронизации.
3. Выполнить `corepack enable` и `pnpm install --frozen-lockfile`.
4. Создать приватные `apps/hq/public/runtime/project.override.json` и
   `apps/file-bridge/bridge.config.json` из example-файлов.
5. Проверить, что production media хранится внутри разрешённых roots и не является symlink/junction.
6. Вызвать gRPC-Web `Health` и проверить `protocol_version = 2`, затем убедиться, что прежний
   `/v1/list` возвращает `404`.

## 2. Release gate

```powershell
pnpm check:release
```

Команда должна подтвердить lint, strict TypeScript, unit/domain/config/bridge tests, обе Next-сборки,
Playwright flows и Cargo tests. Отдельно выполнить:

```powershell
cargo check --manifest-path apps/hq/src-tauri/Cargo.toml
pnpm tauri:build
```

Команда упаковки создаёт проверенный Windows NSIS installer в
`apps/hq/src-tauri/target/release/bundle/nsis/`. Сохранить версию commit, `buildId` и checksum
установщика в съёмочный журнал.

## 3. Материалы

1. Сверить каждый `requiredAssetId` выбранных сцен с `assets_manifest.json`.
2. Заменить placeholder через `project.override.json`; scene definition не редактировать.
3. Проверить MIME, длительность видео, аудиоканалы и читаемость стоп-кадра.
4. Запустить preflight каждой снимаемой сцены: required screens online, missing assets = 0.
5. Для входящих файлов дождаться события `FILE_READY`; не открывать файл на `FILE_ADDED`.

## 4. Мониторы

1. Подключить мониторы до старта Tauri.
2. Проверить `screenWindows[].monitorIndex` и фактический порядок `list_monitors`.
3. Открыть `/wall/hq-standard/`, затем каждый required screen сцены.
4. Проверить fullscreen, частоту обновления, масштаб Windows 100% и отсутствие HDR-конверсии.
5. Проверить heartbeat в инженерной вкладке Screens.

## 5. Репетиция

1. Установить `runtimeMode: rehearsal`.
2. Сохранить snapshot исходного состояния.
3. Пройти все cue вперёд и назад; отдельно проверить reset, freeze и blackout recovery.
4. Для `s16-38` измерить COVER на рабочем оборудовании: целевое время ≤150 ms.
5. Для `s02-58` пройти CLEAN → LIGHT → HEAVY → LOST → TRACKER ONLY.
6. Для `s08-31` пройти VIDEO → ZOOM → SEARCH → RESULTS → PROFILE → PHOTO.
7. Запустить двухчасовой soak test с постоянными heartbeat и gRPC-Web `Watch` stream.

## 6. Съёмка

- не обновлять приложение, зависимости и OS в день смены;
- держать Control в фокусе и не открывать DevTools;
- использовать GO/NEXT и точечный cue click только по команде;
- после нештатного состояния применить FREEZE, затем snapshot/RESET;
- BLACKOUT является аварийным действием и применяется ко всему экранному контуру;
- production override и реальные пути не копировать в журнал или Git.

## 7. Recovery

1. При падении display window повторно открыть его из Control; текущий state придёт по
   `REQUEST_CURRENT_STATE`/`CURRENT_STATE`.
2. При потере bridge оставить активный media frozen, восстановить процесс bridge, дождаться health
   и `FILE_READY`.
3. При повреждённом runtime config вернуть последний проверенный override и перезагрузить Control.
4. При полной остановке запустить статический Tauri build: он не требует Next server.
5. Восстановить последний rehearsal snapshot и сверить active scene/cue перед продолжением.
