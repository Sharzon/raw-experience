# permission

Система контроля разрешений для pi-coding-agent. Контролирует доступ к файлам и инструментам на основе настраиваемых правил.

## Возможности

- **Allow/Deny правила** для чтения, записи и редактирования
- **Wildcard-поддержка** (`*`, `**`) для путей
- **Глобальная и локальная конфигурация**
- **Подтверждение пользователя** для ограничённых операций

## Конфигурация

- Глобальный: `~/.pi/agent/permission-settings.json`
- Локальный: `.pi/permission-settings.json`

## Команды

- `/permissions` — показать статус
- `/permissions-reload` — перезагрузить конфиг
- `/permissions-clear-session` — очистить сессию

## Инструмент request_permission

Агент может заранее запросить разрешение:

```typescript
request_permission({
  path: ".env",
  action: "read",
  reason: "Need database config"
});
```
