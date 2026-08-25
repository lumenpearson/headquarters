# Release and shoot-day runbook

## 1. Чистая машина

1. Установить Node 24.3+, pnpm 10.12+, Rust 1.88+ и Microsoft WebView2 Runtime. Если используется
   нативный RTSP-шлюз — дополнительно ffmpeg на PATH или его путь в `HQ_FFMPEG_PATH`: без бинарника
   шлюз отвечает `FfmpegUnavailable`.
2. Клонировать repository в локальный каталог без облачной синхронизации.
3. Выполнить `corepack enable` и `pnpm install --frozen-lockfile`.
4. Создать приватные `apps/hq/public/runtime/project.override.json`,
   `apps/file-bridge/bridge.config.json` и `apps/hq/.env.local` из example-файлов. Для нативного
   RTSP-шлюза — `apps/hq/src-tauri/media-gateway.config.local.json`; для контрольной плоскости —
   `apps/control-plane/.env`.
5. Проверить, что production media хранится внутри разрешённых roots и не является symlink/junction.
6. Запустить `pnpm bridge`. Контрольная плоскость на съёмке не требуется: приложение не содержит
   клиента ни к одному её сервису (см. `docs/release/known-limitations.md`). Если её всё же
   запускают, сначала выполнить `pnpm --filter @gremuchaya/control-plane migrate`, затем
   `pnpm control-plane`.
7. Вызвать gRPC-Web `Health` bridge и проверить `protocol_version = 3`, затем убедиться, что прежний
   `/v1/list` возвращает `404`.

## 2. Release gate

```powershell
pnpm check:release
```

Команда должна подтвердить UI boundary, свежесть сгенерированного Protobuf, lint, strict TypeScript,
unit-тесты всех десяти workspace-пакетов, включая control-plane, обе Next-сборки, Playwright flows и
Cargo tests. Отдельно выполнить:

```powershell
pnpm format:check
cargo fmt --manifest-path apps/hq/src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/hq/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path apps/hq/src-tauri/Cargo.toml
pnpm tauri:build
```

`check:release` не заменяет CI: Prettier, `cargo fmt --check` и `cargo clippy -D warnings` в него не
входят, поэтому сборка, прошедшая релизный gate, всё ещё может не пройти CI. Три команды выше
закрывают этот разрыв на релизной машине.

На машине с заполненным `apps/control-plane/.env` `pnpm check:release` выполняет опциональные
PostgreSQL-наборы: `apps/control-plane/vitest.config.ts` читает тот же `.env`, что сервер и
мигратор, и наборы создают и удаляют базы `hqtest_*` рядом с той, что названа в
`HQ_CONTROL_PLANE_TEST_DATABASE_URL`, а также удаляют забытые `hqtest_*` старше часа. Перед
релизным прогоном убедиться, что этот URL не указывает на боевую базу.

Команда упаковки создаёт проверенный Windows NSIS installer в
`apps/hq/src-tauri/target/release/bundle/nsis/`. Сохранить версию commit, `buildId` и checksum
установщика в съёмочный журнал.

## 3. Материалы

1. Сверить каждый `requiredAssetIds` выбранных сцен с `assets_manifest.json`.
2. Заменить placeholder через `project.override.json`; scene definition не редактировать.
3. Проверить MIME, длительность видео, аудиоканалы и читаемость стоп-кадра вручную: runtime
   объявленный `expectedMimeType` не сверяет, preload проверяет только доступность файла.
4. Запустить preflight каждой снимаемой сцены: required screens online, missing assets = 0.
   Статус `placeholder` preflight не блокирует — это процедурное требование, а не проверка кода.
5. Для входящих файлов дождаться события `FILE_READY`; не открывать файл на `FILE_ADDED`.
6. Материал, загруженный через bridge (`BeginMaterialImport` … `GetMaterialPlaybackGrant`), приходит
   мимо `assetId`: он требует `readOnly: false` и `materialImport.enabled: true`, хранится
   content-addressed под `<materialsMount>/.hq/`, а его привязка к камере лежит в `localStorage`
   под `hq.camera-material-assignments.v1` и не переживает очистку профиля браузера.

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
- держать окно оператора в фокусе и не открывать DevTools; транспорт (`[F7] PREV`, `[F8] GO / NEXT`,
  `[F9] RESET`) живёт в панели Scene Control операционной оболочки, маршрут `/control` остаётся
  рабочим псевдонимом той же оболочки и отдельным экраном больше не является;
- использовать GO/NEXT и точечный cue click только по команде;
- после нештатного состояния применить FREEZE, затем snapshot/RESET;
- FREEZE и BLACKOUT в интерфейсе односторонние: обратной кнопки нет, единственный выход — RESET;
- BLACKOUT является аварийным действием и применяется ко всему экранному контуру;
- production override и реальные пути не копировать в журнал или Git.

## 7. Recovery

1. При падении display window повторно открыть его из Control; текущий state придёт по
   `REQUEST_CURRENT_STATE`/`CURRENT_STATE`.
2. При потере bridge оставить активный media frozen, восстановить процесс `pnpm bridge`, дождаться
   health и `FILE_READY`. Десктопная сборка bridge сама не поднимает: это отдельный процесс.
3. При повреждённом runtime config вернуть последний проверенный override и перезагрузить Control.
4. При полной остановке запустить статический Tauri build: он не требует Next server.
5. Восстановить последний rehearsal snapshot и сверить active scene/cue перед продолжением.
