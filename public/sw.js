// Minimal service worker for the SV Draft Day companion.
// This is a LIVE tool — HTML, /data/*, /api/* and external feeds are NEVER cached here.
// Only immutable-ish static assets (fonts, brand art, icons, MLB team logos) get cache-first.
const CACHE = "svdd-static-v3";
const PRECACHE = [
  "/brand/sv-logo.svg",
  "/brand/sv-logo-white.svg",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const CACHEABLE = [
  /^https?:\/\/[^/]+\/(fonts|brand|icons)\//,
  /^https:\/\/www\.mlbstatic\.com\/team-logos\//,
];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !CACHEABLE.some((rx) => rx.test(req.url))) return; // fall through to network
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
    )
  );
});

// Web push: "SV client drafted" alerts from /api/push (see lib/push.js).
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(d.title || "SV Draft Day", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/");
    })
  );
});
