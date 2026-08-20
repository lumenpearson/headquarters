# Original request (prompt #0)

This is the request that started the monorepo rewrite, reproduced verbatim. It
is the specification that
`HQ_CUSTOMIZATION_MEDIA_SYNC_IMPLEMENTATION_PLAN_V2.md` argues from; the
requirement IDs annotated below (`R1`–`R31`) are referenced by that plan's
traceability matrix.

The text is Russian because the request was written in Russian. It is kept
unedited on purpose: a paraphrase would let a later reader mistake an
interpretation for the requirement. Where the original is ambiguous, the plan
says so rather than resolving it silently here.

---

## Verbatim text

> добавь возможность загружать файлы(видео/фото/документы и другие файлы) для
> просмотра их в приложении с любого клиента — материалы будут храниться в
> shared папке моно-репозитория, реализуй это профессионально и оптимизированно,
> можно было бы загрузить новые файлы через само приложение через скрытые
> настройки приложения, настроить вид плиток, скрыть/показать категории/плитки,
> изменить дату, время, информацию, поменять вообще в приложении, у каждой
> категории настроек была бы своя кнопка сброса а также общая кнопка сброса
> настроек, добавь огромное количество настроек персонализации как информации,
> так и визуальной составляющей приложения, в режиме редактирования — появлялась
> бы плавающая панель с магнитным align-ментом по сторонам приложения, которая
> была бы инструментом при помощи которого можно было бы отредактировать всё что
> угодно в приложении по части информационной составляющей и визуальной, так и
> сделать поправку с генерацией описания и ссылки на создание нового issue в
> репозиторий с уже сделанным исправлением. Реализуй пагинацию, фильтры и
> сортировку данных где это требуется, где есть какие-то данные. Если элементы не
> помещаются в актуальный макет приложения (исходя из текущего размера окна) — то
> убирай их на их собственные экраны и плитки. Сделай так, чтобы на экранах не
> было пустот без информации — везде макет экранов подстраивается под каждую
> плитку(если есть пустота — туда идет либо плитка если ей хватает места, либо
> растягиваются остальные уже имеющиеся плитки, нельзя оставлять пустоту —
> используй готовые решения для реализации адаптивных лайаутов экранов). Добавь
> keybind по всему приложению, их красивый список с их подсветкой находился бы в
> настройках и при первом запуске приложения. Добавь в приложение кастомные
> pop-up окна самых разных видов, а также pop-up на правую кнопку мыши, отключи
> выделение текста на не интерактивных элементах и вне режима редактирования,
> сделай цвет выделения черным(если тёмная тема) а фон акцентным цветом, и
> белым(если светлая тема). Добавь в приложение настройку фона приложения с
> динамической анимацией которой тоже можно отключить, добавь настройку включения
> паттерна сетки/пунктирных сеток/barber-like lines и тд на сфокусированные
> элементы и фон — также всё можно настроить. Сделай в настройках персонализации
> — смену тем интерфейса и его стиля, без ломания интерфейса приложения. Добавь в
> приложение акценты с помощью жирного выделения текста. Добавь в приложение
> начальную оптимизированную анимацию при запуске приложения, ее также можно
> настроить и отключить в режиме редактирования, а также в настройках анимаций.
> Пусть в режиме редактирования — можно было бы переключаться между состояниями
> мгновенно. сделай также, как можно больше доступного в отдельной rust оболочке,
> которая будет потом связываться с tauri оболочкой, что невозможно сделать через
> rust — делай через typescript. Добавь в настройки персонализации — настройки
> анимаций, абсолютно все настройки анимаций, а также настройки интерфейса и
> настройки размера каждого элемента без ломания интерфейса приложения(в рамках
> разумного относительно текущего размера элементов в приложении), а в режим
> редактирования — добавь настройки анимации для каждой плитки/категории и
> элемента и приложения в целом. Сделай с помощью сторонней библиотеки комьюнити
> — свою собственную тему плеера как с прошлых референсов, а не нативный
> браузерный плеер. Оптимизируй воспроизведение файлов. При включенном режиме
> редактирования — будет окантовка окна градиентом акцентного цвета. Сделай так,
> чтобы у каждого интерактивного элемента/плитки и поля — был cursor-pointer и
> свой cursor при изменении поля, при изменении ширины и высоты плиток в режиме
> редактирования. Сделай также кастомное верхнее меню управления окном под
> windows 11 и под windows 10(разница только в закруглениях окна — сделай их
> нативным закруглением windows-окна, а не делай велосипед). Сделай настройки
> верхней панели также доступными в самих настройках приложения. Сделай так,
> чтобы в режиме интерактивного редактирования можно было бы переставлять
> элементы через drag-n-drop систему с подсветкой доступных мест для
> переставления (вместе с подсветкой сделай по края доступных мест для
> переставления пунктирную линию и плавную подсветку акцентным цветом). Используй
> как-можно больше нативных фишек, а также оптимизируй работу приложения под все
> версии windows начиная с 10(на версиях старше — vista, 7, 8, 8.1 и тд — делай
> просто квадратное окно с кастомной верхней панелью). У кастомной панели можно
> было бы менять кнопки, менять распорядок элементов в ней, alignment кнопок и
> элементов, в ней, также, можно было бы поместить полезную информацию, а также
> настройка области перемещения мышкой окна по рабочему столу(сенсорная область).
> Сделай так, чтобы в приложении не было скролла страницы при ее переполнении —
> при этом не допускай ее переполнение. Скролл будет доступен только в том
> случае, если это будет таблица — и то, будет скроллиться только список
> выводимой информации, а не таблица или страница приложения. Сделай механизм,
> при котором все остальные сессии приложения — будут абсолютно синхронизированы
> до миллисекунд — можно было бы настроить группы синхронизации и входить в них —
> можно было бы включить главную сессию или сделать все сессии в этой группе
> главными (тогда бы все эти сессии синхронизировались одновременно и каждая
> могла бы переключать состояние целой группы). Добавь в приложение локализацию
> всех текстовых элементов в нем — в режиме редактирования можно было бы
> настроить транслит конкретного элемента, сделать новый пулл-реквест с готовым
> вариантом транслита на конкретный язык и получить ссылку на пулл-реквест. Сделай
> так, чтобы была история изменения режима редактирования и других настроек как в
> режиме синхронизации группой/всех сессий, так и отдельной сессии. Была бы
> история каждой сессии отдельно (локально), и история изменений настроек целой
> группы. Можно было бы просматривать историю изменений через пагинацию с
> сортировкой и фильтрами по дате и времени а также конкретным фильтрам категории
> изменения и даже отдельным элементам как режима редактирования, так и просто
> изменения конкретной настройки приложения. Сделай так, чтобы даже при обрезании
> — не было скролла, а при обрезании элементов — скролл появлялся бы у конкретной
> панели или плитки, или, если это монолитная панель или плитка — она скрывалась
> или подстраивалась под размер лайаута. Сделай все графики, информацию и данные
> mainframe-мов, серверов, сети и других динамических данных — ДИНАМИЧНЫМИ, добавь
> также настройку изменения данных(пресеты изменения данных, насколько они будут
> критичными, график функции(кривая которую можно изменять тянув за ее области
> тем самым изменяя бесшовно моменты максимума и минимума скорости времени
> изменения данных, другой график с настройкой критичности данных — насколько в по
> другому графику — этот график будет определять насколько максимальны показатели
> бесшовно) настройки времени изменения этих данных/графиков и прочего). Перед
> началом, составь отдельный файл .md с описанием каждого шага, вплоть до строчки
> кода, используй библиотеки для работы с изменениями, предлагающие уже готовые
> решения.

---

## Requirement index

Extracted for traceability. The wording is a label, not a restatement — the
verbatim text above governs.

### Materials and files

- **R1** — upload files (video/photo/documents/other) from any client, stored in
  the monorepo `shared/` folder, for viewing in the app.
- **R2** — upload new files through the application itself, via hidden settings.
- **R21** — optimized file playback.

### Personalization and edit mode

- **R3** — configure tile appearance; hide/show categories and tiles.
- **R4** — change date, time and information from inside the app.
- **R5** — a reset button per settings category, plus a global reset.
- **R6** — a very large number of personalization settings, informational and
  visual.
- **R7** — in edit mode, a floating panel with magnetic alignment to the
  application's edges, able to edit anything informational or visual.
- **R17** — instant switching between states while in edit mode.
- **R19** — every animation setting; interface settings; per-element size
  settings without breaking the interface; in edit mode, animation settings per
  tile, category, element and for the application as a whole.
- **R22** — accent-colour gradient border around the window while edit mode is
  on.

### Layout and interaction

- **R9** — pagination, filters and sorting wherever data exists.
- **R10** — elements that do not fit the current layout move to their own
  screens and tiles; no empty areas — a gap is filled by a tile that fits, or
  the remaining tiles stretch; use existing adaptive-layout solutions.
- **R11** — application-wide keybinds, with a highlighted list in settings and
  on first launch.
- **R12** — custom pop-up windows of many kinds, plus a right-click pop-up;
  disable text selection on non-interactive elements and outside edit mode;
  selection colour black on the accent background in dark theme, white in light.
- **R14** — theme and interface-style switching without breaking the interface.
- **R15** — accents via bold text.
- **R23** — `cursor: pointer` on every interactive element, tile and field, plus
  a dedicated cursor while changing a field and while resizing tiles in edit
  mode.
- **R26** — no page scroll on overflow, and no overflow in the first place;
  scrolling only inside a table's output list, never the table or the page.
- **R30** — on truncation, scroll appears on the specific panel or tile; a
  monolithic panel hides itself or adapts to the layout size.
- **R∅** — drag-and-drop reordering in interactive edit mode, with highlighted
  drop targets, a dashed line at their edges and a smooth accent-colour
  highlight. _(Folded into R7 in the plan: it is an edit-mode capability.)_

### Visual effects

- **R13** — animated application background, disableable; grid, dotted-grid and
  barber-like line patterns on focused elements and on the background, all
  configurable.
- **R16** — an optimized startup animation, configurable and disableable both in
  edit mode and in animation settings.

### Native shell

- **R18** — put as much as possible in a separate Rust layer bound to the Tauri
  shell; use TypeScript only for what Rust cannot do. Use as many native
  facilities as possible.
- **R24** — a custom window-control titlebar for Windows 11 and Windows 10,
  differing only in window rounding, using native Windows rounding rather than a
  reimplementation; on Vista/7/8/8.1 a plain square window with the custom
  titlebar.
- **R25** — titlebar settings exposed in the application's own settings:
  changeable buttons, element order, alignment of buttons and elements, room for
  useful information, and a configurable drag region for moving the window.

### Synchronization, history, localization

- **R27** — a mechanism synchronizing all other application sessions to the
  millisecond; configurable synchronization groups that sessions can join; a
  main session, or every session in the group made main, in which case all
  synchronize simultaneously and each can switch the whole group's state.
- **R28** — localization of every text element; in edit mode, configure the
  transliteration of a specific element, open a pull request with the prepared
  translation and receive a link to it.
- **R29** — history of edit-mode changes and of other settings changes, both for
  a group/all-sessions synchronization mode and for a single session; per-session
  history kept locally, plus a whole-group settings history; browsable through
  pagination with sorting and filters by date and time, by change category, and
  by individual elements.
- **R8** — from edit mode, produce a correction with a generated description and
  a link for creating a new repository issue containing the fix already made.

### Media and simulation

- **R20** — a custom player theme built on a community library, matching earlier
  references, rather than the native browser player.
- **R31** — make all charts, information and data for mainframes, servers,
  network and other dynamic data genuinely dynamic; add data-variation settings:
  presets, how critical values become, a function graph whose curve can be
  dragged to seamlessly move the maxima and minima of the rate of change, a
  second graph controlling criticality and how high values may go, plus timing
  settings for those changes.

### Process

- **R∅** — before starting, produce a separate `.md` file describing every step
  down to the line of code, and use existing community libraries that already
  solve these problems. _(This is the instruction that produced the plan
  documents themselves.)_
