/**
 * HTTP client wrapper — the single chokepoint for all outbound network
 * requests in the Tramio app.
 *
 * Responsibilities:
 * 1. Block (throw) outbound requests while a tour is active, except
 *    loopback/IPC addresses (Req 3.2).
 * 2. Enforce metered/unmetered network policy: catalog probes are
 *    allowed on any connection, but pack downloads and GTFS feed
 *    downloads are only allowed on unmetered connections unless the
 *    user explicitly opts in (Req 3.6, 18.2).
 *
 * All modules that need to make HTTP requests (Catalog_Client,
 * Entitlement_Client, GTFS updater, pack downloader) go through this
 * wrapper. Nothing else in the codebase opens sockets directly.
 *
 * @see Requirements 3.2, 3.6, 18.2
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of the engine state the HTTP client needs to observe. */
export interface TourStateProvider {
  /** Returns true when a tour session is active (any phase except Idle/Ended). */
  isTourActive(): boolean;
}

/** Network connectivity information provided by the platform layer. */
export interface NetworkInfoProvider {
  /**
   * Returns true when the current connection is unmetered (e.g. WiFi).
   * Returns false for metered connections (cellular) or when offline.
   */
  isUnmetered(): boolean;
}

/** The intent of a request, used to enforce metered/unmetered policy. */
export type RequestIntent =
  /** Lightweight probe (catalog version check, moderation refresh). Allowed on any connection. */
  | 'probe'
  /** Large download (pack assets, GTFS feeds). Only allowed on unmetered unless user opted in. */
  | 'download';

/** Options for a single HTTP request through the chokepoint. */
export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  /** Declares the intent of this request for metered/unmetered policy. Defaults to 'probe'. */
  intent?: RequestIntent;
  /**
   * When true, bypasses the metered-connection restriction for downloads.
   * Used when the user has explicitly opted in to downloading on cellular.
   */
  allowMetered?: boolean;
  /** Abort signal for cancellation support. */
  signal?: AbortSignal;
}

/** Minimal response shape returned by the HTTP client. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Error thrown when a request is blocked by the tour-active guard. */
export class TourActiveBlockError extends Error {
  constructor(url: string) {
    super(`Outbound HTTP request blocked during active tour: ${url}`);
    this.name = 'TourActiveBlockError';
  }
}

/** Error thrown when a download is attempted on a metered connection without opt-in. */
export class MeteredConnectionBlockError extends Error {
  constructor(url: string) {
    super(`Download blocked on metered connection (opt-in required): ${url}`);
    this.name = 'MeteredConnectionBlockError';
  }
}

// ---------------------------------------------------------------------------
// Loopback / IPC detection
// ---------------------------------------------------------------------------

/**
 * Hostnames and IP patterns that are considered loopback/IPC and are
 * exempt from the tour-active block. These are used for communication
 * with co-located services (e.g. the self-hosted backend running on
 * the same device during development, or IPC channels).
 */
const LOOPBACK_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^\[::1\]$/,
  /^0\.0\.0\.0$/,
  /^10\.0\.\d{1,3}\.\d{1,3}$/, // common emulator host addresses
];

/**
 * Returns true if the given URL targets a loopback or IPC address,
 * which is exempt from the tour-active outbound block.
 */
export function isLoopbackOrIpc(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return LOOPBACK_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    // If we can't parse the URL, treat it as non-loopback (block it).
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

/**
 * The actual fetch implementation the client delegates to. This is
 * injected so tests can substitute a mock without touching the network,
 * and so the React Native environment can provide its own fetch.
 */
export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface HttpClientDeps {
  tourState: TourStateProvider;
  networkInfo: NetworkInfoProvider;
  /** The underlying fetch implementation. Defaults to global `fetch`. */
  fetch?: FetchImpl;
}

/**
 * Creates the HTTP client chokepoint. Every outbound request in the app
 * flows through the returned `request` function.
 */
export function createHttpClient(deps: HttpClientDeps) {
  const { tourState, networkInfo } = deps;
  const fetchFn: FetchImpl =
    deps.fetch ?? (globalThis.fetch as unknown as FetchImpl);

  /**
   * Execute an HTTP request through the chokepoint.
   *
   * @throws TourActiveBlockError if a tour is active and the target is not loopback/IPC.
   * @throws MeteredConnectionBlockError if intent is 'download', connection is metered,
   *         and `allowMetered` is not set.
   */
  async function request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers = {}, body, intent = 'probe', allowMetered = false, signal } = options;

    // --- Guard 1: Tour-active block (Req 3.2) ---
    // While a tour is active, no outbound requests are allowed except
    // to loopback/IPC addresses.
    if (tourState.isTourActive() && !isLoopbackOrIpc(url)) {
      throw new TourActiveBlockError(url);
    }

    // --- Guard 2: Metered connection policy (Req 3.6, 18.2) ---
    // Downloads (pack assets, GTFS feeds) are only allowed on unmetered
    // connections unless the user has explicitly opted in.
    if (intent === 'download' && !allowMetered && !networkInfo.isUnmetered()) {
      throw new MeteredConnectionBlockError(url);
    }

    // --- Execute the request ---
    const init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Buffer | Uint8Array;
      signal?: AbortSignal;
    } = { method, headers };
    if (body !== undefined) init.body = body;
    if (signal !== undefined) init.signal = signal;
    const response = await fetchFn(url, init);

    // Collect response headers into a plain object.
    const responseHeaders: Record<string, string> = {};
    // The response.headers may be a Headers object or a map-like.
    // We use .get() for known headers the clients care about.
    const knownHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'x-manifest-lock-sig-url',
      'etag',
      'last-modified',
    ];
    for (const name of knownHeaders) {
      const value = response.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const responseBody = new Uint8Array(arrayBuffer);

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  }

  return { request };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
