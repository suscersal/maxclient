Чтобы добавить свои пункты в меню настроек, используйте объект `settingsMenu` — он создан как экземпляр класса `SettingsMenu`. У него есть методы:

- **`addItem({ id, icon, label, page, badge?, danger? })`** — добавляет пункт меню.
  - `id` — уникальный идентификатор страницы.
  - `icon` — эмодзи или символ.
  - `label` — название.
  - `page` — **функция**, возвращающая HTML-строку содержимого страницы.
  - `badge` (опционально) — красный бейдж (например, количество непрочитанного).
  - `danger: true` (опционально) — пункт выделяется красным (как кнопка выхода).
- **`addDivider()`** — горизонтальная линия-разделитель.
- **`render()`** — перерисовывает всё меню (все старые элементы удаляются, создаются заново на основе текущего списка `items`). Вызывайте его, когда добавляете новые пункты после первой отрисовки.

### Где добавлять

Лучше всего добавлять пункты **до первого вызова `render()`** — в том же блоке, где строится меню (после строки `const settingsMenu = new SettingsMenu()`). Там уже есть пример:

```javascript
const settingsMenu = new SettingsMenu();
settingsMenu
    .addItem({ id: 'vars', icon: '⚙️', label: 'Переменные', page: renderVarsPage })
    .addDivider()
    .addItem({ id: 'account', icon: '👤', label: 'Аккаунт', page: renderAccountPage })
    .render();
```

Вы можете продолжить цепочку вызовов перед `.render()`:

```javascript
settingsMenu
    .addDivider()                                          // разделитель
    .addItem({                                             // новый пункт
        id: 'notifications',
        icon: '🔔',
        label: 'Уведомления',
        page: () => `<div class="settings-empty">⚙️ Настройки уведомлений</div>`
    })
    .addItem({                                             // ещё один
        id: 'help',
        icon: '❓',
        label: 'Помощь',
        page: () => `<div class="settings-empty">📖 Справка по использованию</div>`
    })
    .render(); // перерендерить меню
```

Если меню уже отрендерено (например, после загрузки страницы), просто вызовите `settingsMenu.render()` ещё раз.

### Создание интерактивной страницы

Ваша функция `page` может возвращать любой HTML, включая формы, кнопки и т.д. Например, страница с переключателем:

```javascript
page: function() {
    return `
        <div style="padding:12px;">
            <label style="display:flex;align-items:center;gap:10px;">
                <input type="checkbox" id="soundToggle" onchange="console.log('Sound toggled')">
                Звуки уведомлений
            </label>
        </div>
    `;
}
```

### Удаление пунктов

Если нужно полностью управлять списком, можно очистить массив `settingsMenu.items` и заново добавить нужные:

```javascript
settingsMenu.items = [];
settingsMenu.pages = {};
settingsMenu.addItem(...).addItem(...).render();
```

### Примечание

Все страницы хранятся в объекте `settingsMenu.pages` по ключу `id`. При переключении между пунктами меню они не пересоздаются, так что можно хранить состояние внутри DOM-элементов страницы (например, `document.getElementById('soundToggle')`), но при повторном `render()` всё будет пересоздано.