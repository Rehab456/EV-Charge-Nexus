
self.addEventListener("push", event => {
    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch (error) {
        data = {};
    }

    const title = data.title || "EVCharge Nexus";

    const options = {
        body: data.body || "You have a new notification.",
        icon: "/static/ev-charging-hero.jpg",
        badge: "/static/ev-charging-hero.jpg",
        tag: "evcharge-" + Date.now(),
        data: {
            url: data.url || "/notifications"
        }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener("notificationclick", event => {
    event.notification.close();

    const target = new URL(
        event.notification.data?.url || "/notifications",
        self.location.origin
    );

    if (target.origin !== self.location.origin) {
        return;
    }

    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true
        }).then(windows => {
            for (const windowClient of windows) {
                if (windowClient.url === target.href) {
                    return windowClient.focus();
                }
            }

            return clients.openWindow(target.href);
        })
    );
});
