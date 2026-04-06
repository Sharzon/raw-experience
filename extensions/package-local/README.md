# package-local

Pi-extension для управления локальными кэшами пакетов. Позволяет агенту читать код и документацию зависимостей без обращения к интернету.

## Возможности

- **Показ расположения локальных пакетов** при загрузке (агент сразу знает, где искать)
- **Скачивание новых пакетов** по запросу агента в локальную папку
- **Поддержка JavaScript/TypeScript** (npm) и **Python** (PyPI)
- **Поддержка scoped packages** (@scope/package)

## Использование

### Инструмент `package_local`

Агент может вызвать этот инструмент для скачивания пакета:

```
package_local(language: "javascript", package: "axios")
package_local(language: "python", package: "requests")
package_local(language: "typescript", package: "@tanstack/react-query")
```

### Команда `/packages-list`

Показать список скачанных пакетов:

```
/packages-list
```

## Конфигурация

По умолчанию пакеты хранятся в `~/.pi/packages/`:

```
~/.pi/packages/
├── JS/                    # JavaScript и TypeScript пакеты
│   ├── axios/
│   ├── lodash/
│   └── @tanstack/         # Scoped packages
│       └── react-query/
└── Python/                # Python пакеты
    ├── requests/
    └── pandas/
```

Изменить директорию можно через переменную окружения `PI_PACKAGES_DIR`.

## Структура расширения

```
extensions/package-local/
└── index.ts          # Главный файл расширения
```
