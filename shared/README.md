# Общая логика

Эти модули используются Windows-приложением и браузерным модулем LuCI:

- `profile.js` — модель профиля, проверка данных, импорт WireGuard и ссылок,
  каталог готовых наборов правил.
- `config-generator.js` — генерация конфигурации sing-box, DNS и правил.
- `subscription.js` — разбор подписок и объединение подключений.

Особенности роутера добавляет [`openwrt/lib/config.js`](../openwrt/lib/config.js).
Скрипт `scripts/build-openwrt-core.js` собирает эти исходники в модуль LuCI;
Node.js на роутере не требуется.

После изменения общих модулей выполните из корня репозитория:

```sh
npm run openwrt:core
npm test
npm run test:openwrt:ui
```
