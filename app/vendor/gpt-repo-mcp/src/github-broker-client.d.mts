export type BrokerEnvironment = Record<string, string | undefined>;
import type { z } from 'zod';
export function receiptZodSchema(namespace: typeof z): z.ZodObject;
export function projectOperationReceipt(value: unknown): Record<string, unknown>;
export function runtimeStatus(client: BrokerClient | null, readOnlySurface: boolean, configurationState?: string): Promise<BrokerToolResult>;
export type BrokerRoute = '/github/status' | '/github/plan' | '/github/apply'
  | '/github/create_repository' | '/github/create_repository/apply'
  | '/runtime/status' | '/github/operation_status' | '/github/pages_context'
  | '/github/repo_ensure' | '/github/repo_ship' | '/github/pages_ensure';
export interface BrokerClient {
  call(route: BrokerRoute, input: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}
export class BrokerClientError extends Error {
  code: string;
  outcome: string;
  constructor(code: string, message: string, outcome?: string);
}
export function validateBrokerInput(route: string, input: unknown): Record<string, unknown>;
export function createBrokerClient(env?: BrokerEnvironment, options?: {
  timeoutMs?: number; maxResponseBytes?: number; maxConcurrent?: number;
}): BrokerClient | null;
export interface BrokerToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
}
export function createGitHubHandlers(client: BrokerClient | null, readOnlySurface?: boolean): {
  status(args?: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  operationStatus(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  plan(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  apply(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  createRepository(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  createRepositoryApply(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  pagesContext(args?: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  repoEnsure(args?: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  repoShip(args: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
  pagesEnsure(args?: unknown, extra?: { signal?: AbortSignal }): Promise<BrokerToolResult>;
};
