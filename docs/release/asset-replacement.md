# Asset replacement contract

Scene definition ссылается только на стабильный `assetId`. Физический файл и способ получения
определяются manifest/override. Это позволяет заменить согласованный материал без правки логики cue.

1. Не переименовывать `assetId` после утверждения сцен.
2. Для локального web-preview использовать `kind: static` и URL внутри `public/`.
3. Для материалов bridge/native использовать `kind: projected-file`: в override — канонический
   `virtualPath`, в самом manifest — `nodeId`. Loader переводит первый во второй как
   `virtual:<virtualPath>`.
4. Для экранных документов без физического файла использовать `kind: emulated`.
5. Статус `missing` блокирует required preflight — это проверяет runtime. `placeholder` в production
   запрещён процедурой, а не кодом: `runtimeMode` на пропуск ассета не влияет.
6. Override не коммитить. В Git остаются только example и безопасный placeholder manifest.
7. После замены выполнить `pnpm --filter @gremuchaya/config test`, `pnpm build:desktop:web` и
   визуальную проверку целевой сцены.

Override заменяет только `location`. Статус переносится без изменений, и пути от override к статусу
ассета в схеме нет: все 86 записей текущего `assets_manifest.json` объявлены `placeholder`, и
единственный способ вывести ассет из этого статуса — правка самого закоммиченного manifest. Пункты 6
и 7 такую правку не запрещают; она проходит обычным review, как код.

Все изображения и видео объявляют явный expected MIME, но runtime его не сверяет: preload проверяет
только доступность файла, а `projected-file` считается готовым вообще без запроса. Несовпадение MIME
ловится ручной проверкой по пункту 3 съёмочного runbook. Runtime не угадывает сюжетный смысл по имени
файла: отображение определяется scene/module payload и display override.

Материал, импортированный через bridge, приходит четвёртым путём и этим контрактом не покрыт: он
адресуется содержимым под `<materialsMount>/.hq/`, попадает в плеер как
`http://127.0.0.1:<port>/v1/material-playback/<grant>/<token>` и `assetId` не имеет вовсе.
