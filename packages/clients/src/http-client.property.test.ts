// Property-based test for the HTTP client tour-active guard (task 6.3).
//
// Feature: urban-narrative-mvp, Property 15: No cellular network calls during an active tour
//
// **Validates: Requirements 3.2**
//
// Strategy:
//   1. Generate random URLs (external hosts, loopback/IPC addresses) and tour states.
//   2. Assert: when isTourActive() returns true and the URL is non-loopback,
//      the request always throws TourActiveBlockError.
//   3. Assert: when isTourActive() returns false, requests succeed normally.
//   4. Assert: loopback/IPC addresses are always exempt regardless of tour state.

import * as fc from 'fast-check';
import {
  createHttpClient,
  isLoopbackOrIpc,
  TourActiveBlockError,
  type FetchImpl,
  type NetworkInfoProvider,
  type TourStateProvider,
} from './http-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTourState(active: boolean): TourStateProvider {
  return { isTourActive: () => active };
}

function makeNetworkInfo(unmetered: boolean): NetworkInfoProvider {
  return { isUnmetered: () => unmetered };
}

function makeFetch(status = 200): FetchImpl {
  return async (_url, _init) => ({
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates a random external (non-loopback) URL. */
const externalUrlArb = fc
  .record({
    protocol: fc.constantFrom('http', 'https'),
    host: fc.oneof(
      // Random domain names
      fc.tuple(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 3, maxLength: 12 }),
        fc.constantFrom('.com', '.app', '.org', '.net', '.io', '.dev'),
      ).map(([name, tld]) => name + tld),
      // External IPs (non-loopback, non-emulator)
      fc.tuple(
        fc.integer({ min: 11, max: 223 }), // avoid 0.x, 10.0.x, 127.x
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
      ).filter(([a, b]) => {
        // Exclude loopback (127.x.x.x), 0.0.0.0, and emulator (10.0.x.x)
        if (a === 127) return false;
        if (a === 10 && b === 0) return false;
        return true;
      }).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    ),
    port: fc.option(fc.integer({ min: 80, max: 65535 }), { nil: undefined }),
    path: fc.stringOf(fc.constantFrom(...'/abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), { minLength: 1, maxLength: 30 }),
  })
  .map(({ protocol, host, port, path }) => {
    const portStr = port !== undefined ? `:${port}` : '';
    const pathStr = path.startsWith('/') ? path : `/${path}`;
    return `${protocol}://${host}${portStr}${pathStr}`;
  })
  // Final safety filter: ensure the generated URL is actually non-loopback
  .filter((url) => !isLoopbackOrIpc(url));

/** Generates a random loopback/IPC URL. */
const loopbackUrlArb = fc
  .record({
    protocol: fc.constantFrom('http', 'https'),
    host: fc.oneof(
      fc.constant('localhost'),
      fc.constant('LOCALHOST'),
      fc.tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      ).map(([b, c, d]) => `127.${b}.${c}.${d}`),
      fc.constant('[::1]'),
      fc.constant('0.0.0.0'),
      fc.tuple(
        fc.constantFrom(2, 3),
        fc.integer({ min: 0, max: 255 }),
      ).map(([sub, d]) => `10.0.${sub}.${d}`),
    ),
    port: fc.option(fc.integer({ min: 1024, max: 65535 }), { nil: undefined }),
    path: fc.stringOf(fc.constantFrom(...'/abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), { minLength: 1, maxLength: 20 }),
  })
  .map(({ protocol, host, port, path }) => {
    const portStr = port !== undefined ? `:${port}` : '';
    const pathStr = path.startsWith('/') ? path : `/${path}`;
    return `${protocol}://${host}${portStr}${pathStr}`;
  });

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 15: No cellular network calls during an active tour', () => {
  it('blocks all non-loopback requests when tour is active', () => {
    fc.assert(
      fc.asyncProperty(externalUrlArb, async (url) => {
        const client = createHttpClient({
          tourState: makeTourState(true),
          networkInfo: makeNetworkInfo(true),
          fetch: makeFetch(),
        });

        try {
          await client.request({ url });
          // If we reach here, the request was not blocked — property violated.
          throw new Error(
            `Expected TourActiveBlockError for external URL "${url}" during active tour, but request succeeded.`,
          );
        } catch (err) {
          if (!(err instanceof TourActiveBlockError)) {
            throw new Error(
              `Expected TourActiveBlockError for external URL "${url}" during active tour, ` +
                `but got: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
      { numRuns: 100, seed: 42 },
    );
  });

  it('allows all requests when tour is NOT active', () => {
    fc.assert(
      fc.asyncProperty(externalUrlArb, async (url) => {
        const client = createHttpClient({
          tourState: makeTourState(false),
          networkInfo: makeNetworkInfo(true),
          fetch: makeFetch(200),
        });

        const response = await client.request({ url });
        if (response.status !== 200) {
          throw new Error(
            `Expected request to succeed for URL "${url}" when tour is inactive, ` +
              `but got status ${response.status}.`,
          );
        }
      }),
      { numRuns: 100, seed: 42 },
    );
  });

  it('always exempts loopback/IPC addresses regardless of tour state', () => {
    fc.assert(
      fc.asyncProperty(
        loopbackUrlArb,
        fc.boolean(),
        async (url, tourActive) => {
          const client = createHttpClient({
            tourState: makeTourState(tourActive),
            networkInfo: makeNetworkInfo(true),
            fetch: makeFetch(200),
          });

          const response = await client.request({ url });
          if (response.status !== 200) {
            throw new Error(
              `Expected loopback URL "${url}" to be exempt (tourActive=${tourActive}), ` +
                `but got status ${response.status}.`,
            );
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('the invariant holds universally across random tour states and URL types', () => {
    fc.assert(
      fc.asyncProperty(
        fc.oneof(
          externalUrlArb.map((url) => ({ url, isLoopback: false })),
          loopbackUrlArb.map((url) => ({ url, isLoopback: true })),
        ),
        fc.boolean(),
        async ({ url, isLoopback }, tourActive) => {
          const client = createHttpClient({
            tourState: makeTourState(tourActive),
            networkInfo: makeNetworkInfo(true),
            fetch: makeFetch(200),
          });

          if (tourActive && !isLoopback) {
            // Must throw TourActiveBlockError
            try {
              await client.request({ url });
              throw new Error(
                `Expected TourActiveBlockError for non-loopback URL "${url}" ` +
                  `during active tour, but request succeeded.`,
              );
            } catch (err) {
              if (!(err instanceof TourActiveBlockError)) {
                throw new Error(
                  `Expected TourActiveBlockError for non-loopback URL "${url}" ` +
                    `during active tour, but got: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          } else {
            // Must succeed
            const response = await client.request({ url });
            if (response.status !== 200) {
              throw new Error(
                `Expected request to succeed for URL "${url}" ` +
                  `(tourActive=${tourActive}, isLoopback=${isLoopback}), ` +
                  `but got status ${response.status}.`,
              );
            }
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});
