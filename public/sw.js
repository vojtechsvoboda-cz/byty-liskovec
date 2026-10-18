// minimální service worker – umožní instalaci na plochu
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("fetch", () => {});
