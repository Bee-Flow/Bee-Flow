/**
 * The AI builder's wire contract: the persisted session snapshot
 * (server/routes/ai/appStudioBuilder/sessionSnapshot.js, written by
 * turnClosing.js) and the SSE events of `POST /api/studio-apps/builder/stream`
 * (the contract block at the top of chatStream.js).
 */

import type { OpenRecord, ValidationIssue } from './apiTypes';
import type { AppDefinition } from '../core/types';

export interface BuilderMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface BuilderTodo {
    text: string;
    done: boolean;
}

/** `GET /builder/session/:appId` → `{ snapshot }`; 404 = no session yet. */
export interface BuilderSession {
    sessionId: string | null;
    appId: string | null;
    messages: BuilderMessage[];
    lastValidation: OpenRecord | null;
    summary: unknown;
    updatedAt: string | null;
    lastTier: string | null;
    todos: BuilderTodo[];
    brief: unknown;
    approvedPlan: OpenRecord | null;
    pendingPlan: OpenRecord | null;
    continueToken: string | null;
    version: number;
}

export type BuilderPlanMode = 'auto' | 'always' | 'never';

/** The body of one builder turn (`TurnBody` in turnSetup.js, `.strict()`). */
export interface BuilderTurnInput {
    message?: string;
    appId?: string;
    builderSessionId?: string;
    modelTier?: string;
    timezone?: string;
    /** The editor's focus (screen, node); whitelisted server-side. */
    context?: OpenRecord;
    planMode?: BuilderPlanMode;
    plan?: { planId?: string; action: 'approve'; plan: unknown };
    continueToken?: string;
    /** `data:image/...;base64,` URLs; at most 4, 5 MB each. */
    images?: string[];
}

export interface BuilderAddedItem {
    id: string;
    type: string;
    label: string | null;
}

export interface BuilderDataModelTable {
    id: string;
    key: string;
    name: string;
    fieldCount: number;
    rowCount: number;
    linked: OpenRecord | null;
}

/**
 * One builder SSE event, discriminated by `type` (the SSE `event:` name).
 * Fields are read through the allow-list in api/readers/builder.ts; an event
 * the phone does not know arrives as `{ type: 'unknown', event, data }`.
 */
export type BuilderEvent =
    | { type: 'builder_session'; sessionId: string; appId: string | null }
    | { type: 'model_selected'; modelId: string; tier: string | null }
    | { type: 'round_start'; iter: number; modelId: string | null; effort: string | null; local: boolean }
    | { type: 'prompt_progress'; iter: number; total: number; processed: number }
    | { type: 'tool_draft'; iter: number; name: string; items: OpenRecord[] }
    | { type: 'thinking_start'; partId: string | null }
    | { type: 'thinking'; delta: string; partId: string | null }
    | { type: 'thinking_stop'; partId: string | null }
    | { type: 'message'; content: string }
    | {
          type: 'tool_call';
          name: string;
          label: string | null;
          ok: boolean;
          summary: string;
          added: BuilderAddedItem[];
          error: string | null;
          hint: string | null;
      }
    | { type: 'draft'; appId: string | null; definition: AppDefinition | null; version: number | null }
    | {
          type: 'data_model';
          modelVersion: number | null;
          tables: BuilderDataModelTable[];
          datasets: { id: string; name: string }[];
      }
    | { type: 'plan'; planId: string | null; plan: OpenRecord | null; todos: BuilderTodo[] | null }
    | { type: 'phase'; index: number; total: number; label: string }
    | { type: 'checkpoint'; versionId: string | null; summary: string }
    | { type: 'image'; data: string; mimeType: string; caption: string | null }
    | { type: 'validation_errors'; errors: ValidationIssue[]; warnings: ValidationIssue[] }
    | { type: 'usage'; inputTokens: number; outputTokens: number; iter: number | null }
    | { type: 'done'; appId: string | null; finalized: boolean }
    | { type: 'error'; message: string; code: string | null }
    | { type: 'unknown'; event: string; data: unknown };

export type BuilderEventType = BuilderEvent['type'];
