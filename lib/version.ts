/**
 * lib/version.ts
 *
 * Single source of truth for the application version.
 *
 * This value is consumed by:
 *   - The Service Worker (public/sw.js) to build the cache-key prefix
 *     `where-is-it-v${APP_VERSION}` and purge stale caches on upgrade.
 *   - The UI footer to display the running version to the user.
 *   - Any diagnostic / logging utilities that stamp version into log entries.
 *
 * Bump this string whenever you ship a new release so that the Service
 * Worker automatically invalidates old caches on the next activation cycle.
 *
 * Semantic versioning convention for this project:
 *   - Increment the third number (PATCH, e.g. 1.6.1) on every change/fix.
 *   - Increment MAJOR/MINOR only when significant major features are added.
 */

export const APP_VERSION = "1.6.8" as const;

/**
 * The full cache-key prefix used by the Service Worker.
 * Exporting it here keeps sw.js and the rest of the codebase in sync.
 * If you use next-pwa / workbox, inject this value at build time.
 */
export const CACHE_PREFIX = `where-is-it-v${APP_VERSION}` as const;

/**
 * Human-readable label rendered in the UI footer.
 * Example output: "v1.0.0"
 */
export const VERSION_LABEL = `v${APP_VERSION}` as const;
