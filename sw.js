// Service Worker для Web Push уведомлений от MAX-клиента.
// Файл должен лежать в том же каталоге, что и index.html (корень сайта),
// иначе scope будет ограничен и push'и не придут.

self.addEventListener('push', event => {
    if (!event.data) return;
    let data = {};
    try { data = event.data.json(); } catch (e) { data = { title: 'MAX', body: event.data.text() }; }

    const title = data.title || 'MAX';
    const options = {
        body: data.body || '',
        icon: data.icon || '/favicon.ico',
        badge: data.badge || '/favicon.ico',
        tag: data.tag || 'max-msg',          // группируем уведомления от одного чата
        renotify: data.renotify !== false,    // вибрация при каждом новом
        data: { url: data.url || '/', chatId: data.chatId },
        silent: false,
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (const client of windowClients) {
                if (client.url === url && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
