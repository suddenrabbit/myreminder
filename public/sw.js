/* RabbitReminder Service Worker — 发布前同步更新 VERSION 与 index.html 资源版本。 */
const VERSION = 'rabbit-v14';
const CACHE = `rabbitreminder-${VERSION}`;
const APP_SHELL = ['/', '/index.html', `/style.css?v=${VERSION}`, `/app.js?v=${VERSION}`,
  `/brands.js?v=${VERSION}`, `/manifest.webmanifest?v=${VERSION}`,
  '/networks/unionpay.svg', '/networks/visa.svg', '/networks/mastercard.svg', '/networks/amex.svg', '/networks/jcb.svg',
  '/rabbit-wallet-192.png', '/rabbit-wallet-512.png', '/rabbit-wallet-apple.png'];

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE && /^(myreminder-|rabbitreminder-)/.test(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // 在线优先取新资源；缓存仅用于离线兜底。API 和银行卡数据不进入缓存。
  const response = (async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request, { cache: 'no-cache' });
      if (fresh.ok) {
        await cache.put(request, fresh.clone());
        return fresh;
      }
      const cached = await cache.match(request);
      return cached || fresh;
    } catch (_) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => {}, () => {}));
});
