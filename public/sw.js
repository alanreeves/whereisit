/**
 * public/sw.js
 * Service Worker — Where Is It? PWA
 *
 * Strategy
 * --------
 * - Static assets  : Cache-First  (fast repeat loads)
 * - API routes      : Network-First with stale-while-revalidate fallback
 *                     (so the app stays usable offline but always tries
 *                      to get fresh data when online)
 * - Navigation reqs : Network-First, fallback to cached /offline.html
 *
 * Cache naming
 * ------------
 * All caches are prefixed with the current APP_VERSION so that
 * bumping the version in lib/version.ts automatically triggers the
 * `activate` phase to delete every cache from previous versions.
 *
 * Cache busting flow
 * ------------------
 * 1. Browser downloads the new sw.js.
 * 2. `install` event fires — new static assets are pre-cached under
 *    the new versioned key.  skipWaiting() is called immediately so
 *    the new worker activates without waiting for all tabs to close.
 * 3. `activate` event fires — all caches whose key does NOT start with
 *    CURRENT_CACHE_PREFIX are deleted.
 * 4. clients.claim() is called so open tabs switch to the new worker
 *    right away (no manual refresh required).
 */

// ─── Version ──────────────────────────────────────────────────────────────────
// Keep this in sync with lib/version.ts  ↓
const APP_VERSION = "1.6.1";

// ─── Cache key constants ───────────────────────────────────────────────────────
const CURRENT_CACHE_PREFIX = `where-is-it-v${APP_VERSION}`;

const CACHE_NAMES = {
  /** Versioned cache for pre-cached static assets (JS, CSS, fonts, icons). */
  static:     `${CURRENT_CACHE_PREFIX}-static`,
  /** Versioned cache for runtime API responses. */
  api:        `${CURRENT_CACHE_PREFIX}-api`,
  /** Versioned cache for page/navigation responses. */
  pages:      `${CURRENT_CACHE_PREFIX}-pages`,
  /** Versioned cache for images and media. */
  images:     `${CURRENT_CACHE_PREFIX}-images`,
};

// ─── Pre-cache manifest ───────────────────────────────────────────────────────
// List every shell asset that must be available offline immediately after
// installation.  Next.js build hashes change per build; adjust accordingly
// or use a build-time injection step (e.g. next-pwa / workbox-cli) to
// populate this list automatically.
const PRECACHE_URLS = [
  "/",
  "/offline",                 // Offline fallback page (create pages/offline.tsx)
  "/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

// ─── URL-matching helpers ─────────────────────────────────────────────────────

/** Returns true for same-origin requests to /api/* routes. */
function isApiRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/api/");
}

/** Returns true for same-origin image requests. */
function isImageRequest(request) {
  return request.destination === "image";
}

/** Returns true for same-origin navigation (HTML page) requests. */
function isNavigationRequest(request) {
  return request.mode === "navigate";
}

/** Returns true for any asset we want to handle with cache-first. */
function isStaticAsset(url) {
  const staticExtensions = [".js", ".css", ".woff", ".woff2", ".ttf", ".otf", ".ico", ".svg"];
  return staticExtensions.some((ext) => url.pathname.endsWith(ext));
}

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log(`[SW] Installing version ${APP_VERSION}`);

  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAMES.static);

        // Cache each URL individually so a single bad URL doesn't abort the
        // entire install.
        await Promise.allSettled(
          PRECACHE_URLS.map(async (urlPath) => {
            try {
              const response = await fetch(urlPath, { cache: "no-cache" });
              if (response.ok) {
                await cache.put(urlPath, response);
                console.log(`[SW] Pre-cached: ${urlPath}`);
              } else {
                console.warn(`[SW] Pre-cache skipped (${response.status}): ${urlPath}`);
              }
            } catch (err) {
              console.warn(`[SW] Pre-cache failed: ${urlPath}`, err);
            }
          })
        );
      } catch (err) {
        console.error("[SW] Install failed:", err);
      }

      // Take control immediately — do not wait for existing tabs to close.
      self.skipWaiting();
      console.log(`[SW] skipWaiting() called — version ${APP_VERSION} will activate immediately.`);
    })()
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log(`[SW] Activating version ${APP_VERSION} — purging old caches.`);

  event.waitUntil(
    (async () => {
      // Enumerate ALL existing caches.
      const allCacheKeys = await caches.keys();

      const staleCaches = allCacheKeys.filter(
        // Delete any cache that belongs to an older version.
        (key) => !key.startsWith(CURRENT_CACHE_PREFIX)
      );

      if (staleCaches.length === 0) {
        console.log("[SW] No stale caches to purge.");
      } else {
        console.log(`[SW] Purging ${staleCaches.length} stale cache(s):`, staleCaches);
        await Promise.all(staleCaches.map((key) => caches.delete(key)));
        console.log("[SW] Stale caches purged successfully.");
      }

      // Claim all open clients so they immediately use the new worker
      // without needing a manual page refresh.
      await clients.claim();
      console.log("[SW] clients.claim() — all open tabs now controlled by the new SW.");

      // Notify all clients of the version update so the UI can surface a
      // "Updated to v1.0.0" toast / banner if desired.
      const allClients = await clients.matchAll({ includeUncontrolled: true, type: "window" });
      allClients.forEach((client) => {
        client.postMessage({
          type: "SW_ACTIVATED",
          version: APP_VERSION,
          cachePrefix: CURRENT_CACHE_PREFIX,
        });
      });
    })()
  );
});

// ─── Fetch strategies ─────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin and known CDN requests; let cross-origin
  // analytics / third-party requests pass through untouched.
  if (url.origin !== self.location.origin) {
    return; // fall through to browser default
  }

  // ── Strategy 1: API routes — Network-First ──────────────────────────────────
  if (isApiRequest(url)) {
    event.respondWith(networkFirstWithApiCache(event.request));
    return;
  }

  // ── Strategy 2: Images — Cache-First ────────────────────────────────────────
  if (isImageRequest(event.request)) {
    event.respondWith(cacheFirstWithFallback(event.request, CACHE_NAMES.images));
    return;
  }

  // ── Strategy 3: Static assets — Cache-First ─────────────────────────────────
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstWithFallback(event.request, CACHE_NAMES.static));
    return;
  }

  // ── Strategy 4: Navigation requests — Network-First ──────────────────────────
  if (isNavigationRequest(event.request)) {
    event.respondWith(networkFirstWithPageFallback(event.request));
    return;
  }

  // ── Default: Network-only (passes straight through) ──────────────────────────
});

// ─── Strategy implementations ─────────────────────────────────────────────────

/**
 * Cache-First strategy.
 * Serves from cache if available; otherwise fetches from network,
 * caches the response, then returns it.
 *
 * @param {Request} request
 * @param {string}  cacheName  - which versioned cache to use
 * @returns {Promise<Response>}
 */
async function cacheFirstWithFallback(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    console.debug(`[SW] Cache-First HIT: ${request.url}`);
    return cached;
  }

  console.debug(`[SW] Cache-First MISS — fetching: ${request.url}`);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Clone because a Response body can only be consumed once.
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.error(`[SW] Cache-First fetch failed: ${request.url}`, err);
    return new Response("Offline — resource unavailable.", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/**
 * Network-First strategy for API routes.
 * Always tries the network first; on failure returns the cached response
 * (stale-while-revalidate fallback).  Never caches error responses.
 *
 * API responses are cached with a TTL header so the app can decide whether
 * a stale entry is acceptable — the actual TTL enforcement is left to the
 * consuming code (the SW only stores and retrieves).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirstWithApiCache(request) {
  const cache = await caches.open(CACHE_NAMES.api);

  try {
    const response = await fetch(request.clone());

    if (response.ok) {
      // Store a stamped clone so callers can inspect the cached-at timestamp.
      const clonedHeaders = new Headers(response.headers);
      clonedHeaders.set("X-SW-Cached-At", new Date().toISOString());
      clonedHeaders.set("X-SW-Cache-Version", APP_VERSION);

      const stampedResponse = new Response(await response.clone().blob(), {
        status: response.status,
        statusText: response.statusText,
        headers: clonedHeaders,
      });
      await cache.put(request, stampedResponse);
      console.debug(`[SW] API cached: ${request.url}`);
    }

    return response;
  } catch (err) {
    console.warn(`[SW] API network failed — checking cache: ${request.url}`, err);
    const cached = await cache.match(request);
    if (cached) {
      console.info(`[SW] Serving stale API response for: ${request.url}`);
      return cached;
    }

    // Nothing in cache either — return a structured JSON error.
    return new Response(
      JSON.stringify({
        error: "offline",
        message: "You are offline and no cached response is available.",
        version: APP_VERSION,
      }),
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Network-First strategy for page/navigation requests.
 * Falls back to the cached /offline page when the network is unreachable.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirstWithPageFallback(request) {
  const cache = await caches.open(CACHE_NAMES.pages);

  try {
    const response = await fetch(request);

    if (response.ok) {
      await cache.put(request, response.clone());
      console.debug(`[SW] Page cached: ${request.url}`);
    }

    return response;
  } catch (err) {
    console.warn(`[SW] Page network failed — checking cache: ${request.url}`, err);
    const cached = await cache.match(request);

    if (cached) {
      console.info(`[SW] Serving cached page: ${request.url}`);
      return cached;
    }

    // Fall back to the pre-cached offline shell.
    const offlinePage = await caches.match("/offline");
    if (offlinePage) {
      console.info("[SW] Serving offline fallback page.");
      return offlinePage;
    }

    // Last resort: plain text offline message.
    return new Response(
      "<!doctype html><html><head><title>Offline</title></head><body>" +
        "<h1>You are offline</h1>" +
        "<p>Where Is It? cannot reach the server. Please check your connection and try again.</p>" +
        `<p style='color:grey;font-size:12px'>v${APP_VERSION}</p>` +
        "</body></html>",
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}

// ─── Message handling ─────────────────────────────────────────────────────────

/**
 * Listen for messages posted from the main thread.
 *
 * Supported message types:
 *   SKIP_WAITING        – force the waiting SW to activate immediately.
 *   GET_VERSION         – reply with the current APP_VERSION.
 *   CLEAR_API_CACHE     – delete all entries from the API cache (useful after
 *                         a user logs out to prevent stale data leakage).
 */
self.addEventListener("message", (event) => {
  const { type } = event.data || {};
  console.log(`[SW] Message received: ${type}`);

  switch (type) {
    case "SKIP_WAITING":
      console.log("[SW] SKIP_WAITING requested — activating now.");
      self.skipWaiting();
      break;

    case "GET_VERSION":
      event.ports[0]?.postMessage({ version: APP_VERSION, cachePrefix: CURRENT_CACHE_PREFIX });
      break;

    case "CLEAR_API_CACHE":
      caches.delete(CACHE_NAMES.api).then((deleted) => {
        console.log(`[SW] API cache cleared: ${deleted}`);
        event.ports[0]?.postMessage({ success: deleted });
      });
      break;

    default:
      console.warn(`[SW] Unknown message type: "${type}"`);
  }
});

// ─── Background sync (future hook) ───────────────────────────────────────────
// Uncomment and expand when you add Background Sync for offline STORE/MOVE ops.
//
// self.addEventListener("sync", (event) => {
//   if (event.tag === "sync-pending-items") {
//     event.waitUntil(syncPendingItems());
//   }
// });

// ─── Push notifications (future hook) ────────────────────────────────────────
// Uncomment and expand when you add push reminders (e.g. "Don't forget where
// you put your passport!").
//
// self.addEventListener("push", (event) => {
//   const data = event.data?.json() ?? { title: "Where Is It?", body: "" };
//   event.waitUntil(
//     self.registration.showNotification(data.title, {
//       body: data.body,
//       icon: "/icons/icon-192x192.png",
//       badge: "/icons/badge-72x72.png",
//     })
//   );
// });
