// Types for the Pages verifier consumed by the MCP bridge. The report is
// deliberately typed loosely: it is a bounded JSON document produced by
// core.mjs and forwarded verbatim, not a shape the bridge constructs.
export interface PagesRequest {
  repository: string;
  repository_id: number;
  commit: string;
  branch?: string;
  workflow_id?: number | string;
  approved_site_origin?: string;
  live?: { path?: string; assertion: { kind: string; value?: string; field?: string } };
}
export interface PagesReaders {
  origin: string;
  readApi(path: string): Promise<unknown>;
  readSite(url: string): Promise<unknown>;
}
export declare class VerificationError extends Error {
  code: string;
}
export declare function inspectPages(
  input: PagesRequest,
  readers: PagesReaders
): Promise<Record<string, unknown>>;
export declare function validateRequest(input: unknown): PagesRequest;
export declare function apiPath(request: PagesRequest, kind: string): string;
export declare function exitCode(report: Record<string, unknown>): number;
