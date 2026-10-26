// The surface the Bee Flow host injects into a Hub module (`createModule(host)`, hostApiVersion 2),
// and the pieces of it the SDK's own code (test-kit/hostMock.js, the bundled modules) type against.
// A file pulls a name in with
//   /** @typedef {import('../types/host').HostDb} HostDb */
// The .d.ts is read by the type checker only; nothing here is loaded at run time.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** One row of a query result: the columns by name, as the driver returns them. */
export type DbRow = Record<string, unknown>;

export interface DbClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: DbRow[]; rowCount: number | null }>;
  release(): void;
}

export interface HostDb {
  run(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }>;
  getOne(sql: string, params?: readonly unknown[]): Promise<DbRow | null>;
  getAll(sql: string, params?: readonly unknown[]): Promise<DbRow[]>;
  exec(sql: string): Promise<unknown>;
  getClient(): Promise<DbClient>;
  tx<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
}

export interface HostLog {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ── AI seam ──────────────────────────────────────────────────────────────

/** A tool call in the OpenAI shape; adapters also hand back flat `{ name, arguments | input }` ones. */
export interface ToolCall {
  id: string;
  type?: 'function';
  function?: { name: string; arguments?: string | Record<string, unknown> };
  name?: string;
  arguments?: string | Record<string, unknown>;
  input?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface UnifiedTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ChatUsage {
  input_tokens?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cached_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_tokens?: number;
}

export interface ChatResponse {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: ChatUsage;
  stopReason?: string | null;
  raw?: { choices?: { finish_reason?: string }[] };
}

export interface LlmAdapter {
  chat(
    apiKey: string | undefined,
    url: string | undefined,
    modelId: string,
    messages: ChatMessage[],
    options: { maxTokens?: number; tools?: UnifiedTool[]; toolChoice?: 'auto' },
  ): Promise<ChatResponse>;
}

/** The provider that serves a model: where to call it and with what credentials. */
export interface ProviderRecord {
  apiKey?: string;
  serviceAccountKey?: string;
  providerType?: string;
  providerName?: string;
  url?: string;
}

/** A model reference: an id, a `tier:<name>` alias, or an object carrying the model. */
export type ModelRef = string | { model?: string } | null | undefined;

export interface HostAi {
  resolveModelForTier(ref: ModelRef, opts?: { userOrgId?: string | null; userId?: string }): Promise<string | null>;
  getProviderForModel(modelId: string): Promise<ProviderRecord | null>;
  getAdapter(type: string | undefined, url: string | undefined): LlmAdapter | null;
}

export interface UsageEntry {
  user_id: string;
  organization_id: string | null;
  agent_type: string;
  source: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  stop_reason: string | null;
}

export interface HostUsage {
  logUsage(entry: UsageEntry): Promise<unknown>;
}

export interface HostLimits {
  /** Falsy when the subscription allows the run, else the reason to show the user. */
  checkSubscription(orgId: string | null | undefined, agentType: string, userId: string): Promise<unknown>;
}

export interface HostStorage {
  getPresignedUrl(key: string, expiresIn?: number): Promise<string>;
}

/** The page a module asks the host to store (a generated report, for one). */
export interface WebpageDraft {
  userId: string;
  name?: string;
  [field: string]: unknown;
}

export interface HostWebpages {
  persist(page: WebpageDraft): Promise<string>;
}

export interface HostNet {
  /** True for a URL that resolves to a private, loopback or non-http(s) target. */
  isPrivateTarget(url: string): boolean;
}

export interface ConfigStore {
  getConfig(key: string): Promise<unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
  getSecret(key: string): Promise<unknown>;
  setSecret(key: string, value: unknown): Promise<void>;
}

export interface HostMiddleware {
  requireCapability(capability: string): RequestHandler;
  requirePermission(permission: string): RequestHandler;
}

/** The host API of hostApiVersion 2. */
export interface Host {
  hostApiVersion: number;
  moduleId?: string;
  db: HostDb;
  /** The product's own express, so a module's router and middleware match the host's. */
  express: typeof import('express');
  middleware: HostMiddleware;
  stores: { configStore: ConfigStore };
  ai: HostAi;
  usage: HostUsage;
  limits: HostLimits;
  storage: HostStorage;
  webpages: HostWebpages;
  net: HostNet;
  log: HostLog;
  isModuleActive(moduleId: string): Promise<boolean>;
  fetch: typeof globalThis.fetch;
}

/** The session the host's auth middleware attaches before a module's routes run. */
export interface HostSession {
  user?: { id: string; role?: string; organizationId?: string | null };
  isAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      session?: HostSession;
    }
  }
}

export type { NextFunction, Request, Response };
