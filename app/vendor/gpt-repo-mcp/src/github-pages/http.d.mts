import type { PagesRequest, PagesReaders } from './core.d.mts';

export type PagesTransport = (
  url: string,
  options?: { json?: boolean; signal?: AbortSignal; timeoutMs?: number }
) => Promise<{ status: number; body: unknown }>;

/**
 * The SSRF-checked reader used for anonymous GitHub and published-site reads.
 * Exposed so a caller with a credential can wrap it for the API host while
 * still reading the attacker-influenced site URL through this transport.
 */
export declare const getPublicHttps: PagesTransport;

export declare function createPublicReaders(
  input: PagesRequest,
  options?: { signal?: AbortSignal; transport?: PagesTransport }
): PagesReaders;
