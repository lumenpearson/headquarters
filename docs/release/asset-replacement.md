# Asset replacement contract

Scene definition ссылается только на стабильный `assetId`. Физический файл и способ получения
определяются manifest/override. Это позволяет заменить согласованный материал без правки логики cue.

1. Не переименовывать `assetId` после утверждения сцен.
2. Для локального web-preview использовать `kind: static` и URL внутри `public/`.
3. Для материалов bridge/native использовать `kind: projected-file` и канонический virtual path.
4. Для экранных документов без физического файла использовать `kind: emulated`.
5. Статус `missing` блокирует required preflight; `placeholder` разрешён только для rehearsal.
6. Override не коммитить. В Git остаются только example и безопасный placeholder manifest.
7. После замены выполнить config tests, production build и визуальную проверку целевой сцены.

Все изображения и видео получают явный expected MIME. Runtime не угадывает сюжетный смысл по имени
файла: отображение определяется scene/module payload и display override.
