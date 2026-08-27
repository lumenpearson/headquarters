# Участие в разработке

Спасибо за интерес к «Гремучая смесь — Оперативный штаб». Документ описывает, как
подготовить окружение, какие границы обязательны и какой шлюз проверок должен пройти
каждый pull request.

Участвуя в проекте, вы соглашаетесь соблюдать [Кодекс поведения](CODE_OF_CONDUCT.md)
и [Положение об использовании ИИ](AI_USAGE_POLICY.md).

## Окружение

Требуется Node 24.3+, pnpm 10.12.3+ и Rust/Cargo 1.88+ для сборки desktop-оболочки.
Версии закреплены в `.tool-versions`, `.nvmrc` и поле `packageManager`.

```powershell
corepack enable
pnpm install
```

Основная цель разработки и релиза — Windows (установщик NSIS, требуется WebView2 Runtime),
поэтому команды в документации приведены для PowerShell.

| Команда                                | Назначение                                           |
| -------------------------------------- | ---------------------------------------------------- |
| `pnpm dev:hq`                          | только Next.js-приложение на `http://127.0.0.1:3000` |
| `pnpm dev:full`                        | hq + file-bridge + control-plane одновременно        |
| `pnpm typecheck` / `lint`              | строгий TypeScript и ESLint по всем пакетам          |
| `pnpm test`                            | unit/integration тесты (Vitest)                      |
| `pnpm test:ui`                         | Playwright-сценарии для `apps/hq`                    |
| `pnpm test:cargo`                      | тесты нативного слоя Tauri                           |
| `pnpm format:check`                    | Prettier без записи — первый шаг CI                  |
| `pnpm check:ui-boundary`               | граница UI (пункт 1 ниже)                            |
| `pnpm check:protocol-generation`       | свежесть сгенерированного Protobuf (пункт 2)         |
| `pnpm build:web` / `build:desktop:web` | обе целевые сборки, обе проверяет CI                 |
| `pnpm check`                           | полный локальный шлюз                                |
| `pnpm check:release`                   | шлюз дня съёмки (см. `docs/release/runbook.md`)      |

Запуск одного файла тестов внутри пакета:

```powershell
pnpm --filter @gremuchaya/hq test -- src/state/operationsStore.test.ts
pnpm --filter @gremuchaya/control-plane test -- src/sync/runtime.test.ts
```

## Обязательные границы

Эти правила проверяются скриптами в `scripts/`, а не только соглашением. Их нарушение
роняет `pnpm check`.

1. **Граница UI.** Прямые импорты `@base-ui/react` разрешены только внутри
   `packages/ui`. Вне этого пакета запрещены и «сырые» интерактивные элементы
   `<button>`, `<input>`, `<select>`, `<textarea>` — используйте публичные обёртки
   `Terminal*`. Проверяет `scripts/check-ui-boundary.mjs`.
2. **Свежесть Protobuf.** После правки любого `.proto` выполните
   `pnpm --filter @gremuchaya/protocol generate` и закоммитьте результат. Устаревшие
   сгенерированные привязки отклоняет `scripts/check-protocol-generation.mjs`.
3. **Только Protobuf-транспорт.** Первичные бизнес-операции идут через ConnectRPC поверх
   бинарного gRPC-Web. Никаких REST-эндпоинтов, нативного gRPC и произвольного JSON
   (ADR 0003, ADR 0008).
4. **Страница не скроллится.** Корень страницы никогда не имеет прокрутки; скроллиться
   могут только ограниченные области — списки, таблицы, деревья, документы и плитки.
   Раскладку считает `@gremuchaya/layout-engine`, применяет
   `apps/hq/src/components/layout/TileGrid.tsx`, а проверяет
   `apps/hq/tests/bounded-layout.spec.ts`.
5. **Загруженное содержимое не исполняется.** Редактор не принимает произвольные HTML,
   JavaScript и CSS.
6. **Локальные данные остаются локальными.** Секреты, ключи устройств, пути файловой
   системы и физическое размещение окон не синхронизируются.

Направление зависимостей описано в `docs/architecture/dependency-map.md` — прочитайте его
перед любой сквозной задачей.

## Стиль кода

- Интерфейс и README — на русском; код, идентификаторы и комментарии — на английском.
- TypeScript строгий везде: включены `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, `verbatimModuleSyntax`.
- Форматирование — Prettier: `pnpm format` перед коммитом. Хук `pre-commit` форматирует
  и линтует только проиндексированные файлы.
- `apps/hq/AGENTS.md` перезаписывается автоматически командой `next dev`; не правьте его
  вручную, просто коммитьте изменения.

## Коммиты

Используется [Conventional Commits](https://www.conventionalcommits.org/ru/v1.0.0/):

```
<тип>(<область>): <краткое описание в повелительном наклонении>
```

Типы: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. Область — обычно пакет или подсистема: `control-plane`, `hq`, `file-bridge`,
`protocol`, `ui`, `realtime`.

Формат проверяет хук `commit-msg`: он же отклоняет заголовок длиннее 100 символов и
пропускает сгенерированные git сообщения (`Merge …`, `Revert …`, `fixup!`, `squash!`).

**Не добавляйте в сообщения коммитов строки `Co-Authored-By` и любые другие упоминания
ИИ-ассистентов.** Почему именно так — в
[Положении об использовании ИИ](AI_USAGE_POLICY.md#указание-авторства-в-коммитах).

## Pull request

1. Ответвитесь от актуального `master` и работайте в отдельной ветке — прямые коммиты
   в `master` не принимаются.
2. Держите PR сфокусированным: одна логическая задача на один PR.
3. Прогоните `pnpm check` и `pnpm format:check` локально. CI на каждый pull request
   дополнительно запускает `pnpm test:ui`, `pnpm build:web`, `pnpm build:desktop:web` и
   полный набор Rust-проверок (`cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo test`) — независимо от того, что
   менялось. Прогоните их же локально, если изменение затрагивает интерфейс, экспорт
   или нативный слой.
4. Заполните шаблон PR, включая раздел с доказательствами проверки — вставьте реальный
   вывод команд, а не утверждение «всё проходит».
5. Опишите, что именно **не** покрыто изменением. Проект ведёт честный учёт незакрытых
   гарантий в `docs/plans/`; не помечайте фазу закрытой, пока её шлюз не пройден.

### Тесты

- Новый код сопровождается тестами на том же уровне, что и изменяемый слой.
- Тесты, требующие внешних сервисов, должны быть opt-in через переменную окружения и
  пропускаться по умолчанию, чтобы `pnpm test` оставался офлайн и детерминированным.
  Примеры — `HQ_CONTROL_PLANE_TEST_DATABASE_URL` и пара
  `HQ_CONTROL_PLANE_REDIS_REST_URL` / `_TOKEN` в `apps/control-plane`: вторую надо
  задавать целиком, одна переменная без другой отклоняется при запуске. У пары есть
  платформенный фолбэк `KV_REST_API_URL` / `KV_REST_API_TOKEN`; схема имён берётся
  целиком, и пара, разорванная между схемами, отклоняется так же.
- Наборы `*.integration.test.ts` в `apps/control-plane` разрушающие: общий бутстрап
  `src/db/liveDatabase.ts` создаёт и удаляет базы `hqtest_*` рядом с той, что названа в
  URL, подметает брошенные старше часа перед стартом и отказывается запускаться, если URL
  разрешается в ту же базу, что `HQ_CONTROL_PLANE_DATABASE_URL`. Направляйте
  `HQ_CONTROL_PLANE_TEST_DATABASE_URL` только на отдельную базу — `hq_scratch`, не на
  боевую. Учтите, что `apps/control-plane/vitest.config.ts` читает `apps/control-plane/.env`:
  на машине с заполненным файлом эти наборы выполняет обычный `pnpm test`, а значит и
  `pnpm check`.
- Контрольная плоскость перед прогоном требует применённых миграций:
  `pnpm --filter @gremuchaya/control-plane migrate`. Полный список переменных с границами
  TTL — в `apps/control-plane/.env.example`.
- Отрицательный тест должен доказуемо ловить регрессию: убедитесь, что он падает, если
  откатить исправление.

## Безопасность

Не открывайте публичный issue для уязвимостей — следуйте [SECURITY.md](.github/SECURITY.md).
