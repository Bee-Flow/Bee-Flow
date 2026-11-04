/**
 * The rules of the mailbox "new record" hook, with no I/O: which action may run
 * unattended, what the hook setting looks like, and how many runs one sync and one
 * minute may start. The connector validator, the app validator, the MCP tool and the
 * runner (mailboxNewRecordHook.mts) all read this one module, so "what may run
 * automatically" is written down once.
 *
 * A leaf on purpose: it requires nothing but the pure step-tree helpers, so the
 * validators can load it without pulling the action executor in.
 */

import { childStepLists } from '../shared/appDefinition/stepFlow.mjs';

/** What a new row means: a new conversation, or a new message that came IN. */
export const HOOK_TARGETS = ['thread', 'inbound_message'] as const;
export type HookTarget = typeof HOOK_TARGETS[number];

export type OnNewRecord = { actionId: string; target: HookTarget };

/**
 * The server steps an unattended action may carry. A subset of DATA_MUTATING_STEP_KINDS
 * (the test next to this file keeps it that way), left out on purpose:
 *   send_email, run_automation, request_approval  they reach people, so nothing may
 *                                                 start them from an arriving mail
 *   delete_record                                 nothing erases data unattended
 *   ai_browse                                     it streams to a viewer
 *   copy_document                                 it needs the document pool of a viewer
 * A `transaction` may run: its children are checked like any step (so a delete_record
 * inside one is refused too), and so are the steps of every onError handler.
 */
export const HOOK_STEP_KINDS: readonly string[] = Object.freeze([
    'create_record', 'update_record',
    'ai_extract', 'ai_generate', 'kb_query',
    'dataset_query', 'file_intake',
    'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf',
    'transaction',
]);

/** Control flow the runner evaluates itself; the rest of the client steps do not exist here. */
export const HOOK_CONTROL_KINDS: readonly string[] = Object.freeze(['condition', 'switch']);

/** Steps in one hook action, counted over all branches. */
export const HOOK_MAX_STEPS = 40;

const ACTION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type Step = Record<string, unknown> & { kind?: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The steps of an action in order: a sequence's steps, or a bare action as one step. */
export function hookTopSteps(action: unknown): Step[] {
    if (!isObject(action)) return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps.filter(isObject) : [];
    return [action];
}

/** Hand-written definitions can nest without end; a walk never goes deeper than this. */
const MAX_WALK_DEPTH = 12;

/**
 * Every step of an action, every place that holds steps included (condition then/else,
 * switch cases/default, a loop body, a transaction's children, onError handlers:
 * stepFlow.childStepLists), so a refused kind cannot hide in a handler.
 */
export function hookAllSteps(action: unknown): Step[] {
    const out: Step[] = [];
    const walk = (list: unknown, depth: number): void => {
        for (const step of Array.isArray(list) ? list : []) {
            if (!isObject(step)) continue;
            out.push(step);
            if (depth < MAX_WALK_DEPTH) for (const child of childStepLists(step)) walk(child, depth + 1);
        }
    };
    walk(hookTopSteps(action), 1);
    return out;
}

/**
 * Why this action may not run unattended, as sentences; empty when it may. Used at
 * save time (the app validator, the MCP tool) and again right before every run, because
 * an action can be edited after the connector was saved.
 */
export function hookActionProblems(action: unknown, actionId = 'the action'): string[] {
    if (!isObject(action)) return [`Action "${actionId}" does not exist in the app.`];
    const steps = hookAllSteps(action);
    if (!steps.length) return [`Action "${actionId}" has no steps.`];
    const problems: string[] = [];
    if (steps.length > HOOK_MAX_STEPS) problems.push(`Action "${actionId}" has ${steps.length} steps; at most ${HOOK_MAX_STEPS} may run on an arriving mail.`);
    const refused = new Map<string, number>();
    for (const step of steps) {
        const kind = typeof step.kind === 'string' ? step.kind : '(no kind)';
        if (HOOK_STEP_KINDS.includes(kind) || HOOK_CONTROL_KINDS.includes(kind)) continue;
        refused.set(kind, (refused.get(kind) || 0) + 1);
    }
    for (const kind of refused.keys()) {
        problems.push(kind === 'send_email'
            ? `Action "${actionId}" has a send_email step. Nothing may send mail on its own when a mail arrives; remove it, or let a person press a button for that step.`
            : `Action "${actionId}" has a "${kind}" step, which cannot run unattended. Allowed: ${[...HOOK_STEP_KINDS, ...HOOK_CONTROL_KINDS].join(', ')}.`);
    }
    return problems;
}

/** The setting as the connector stores it, or null when it is absent or not usable. */
export function readOnNewRecord(raw: unknown): OnNewRecord | null {
    if (!isObject(raw) || typeof raw.actionId !== 'string' || !raw.actionId) return null;
    const target = (HOOK_TARGETS as readonly unknown[]).includes(raw.target) ? raw.target as HookTarget : null;
    return target ? { actionId: raw.actionId, target } : null;
}

/** Shape errors of the connector's `onNewRecord`, for the data model validator. Absent is fine (the hook is off). */
export function onNewRecordErrors(raw: unknown, connector: { groupIntoThreads?: unknown }, where: string): string[] {
    if (raw === undefined || raw === null) return [];
    if (!isObject(raw)) return [`${where}.onNewRecord must be { actionId, target }`];
    const errors: string[] = [];
    for (const key of Object.keys(raw)) {
        if (key !== 'actionId' && key !== 'target') errors.push(`${where}.onNewRecord.${key} is not a setting; use actionId and target`);
    }
    if (typeof raw.actionId !== 'string' || !ACTION_ID_RE.test(raw.actionId)) {
        errors.push(`${where}.onNewRecord.actionId must be the id of an action of the app`);
    }
    if (!(HOOK_TARGETS as readonly unknown[]).includes(raw.target)) {
        errors.push(`${where}.onNewRecord.target must be one of ${HOOK_TARGETS.join(', ')}`);
    } else if (raw.target === 'thread' && connector.groupIntoThreads !== true) {
        errors.push(`${where}.onNewRecord.target "thread" needs groupIntoThreads; without it the table holds messages, use "inbound_message"`);
    }
    return errors;
}

export type HookLimits = { perSync: number; perMinute: number };

function capFromEnv(name: string, fallback: number, env: Record<string, string | undefined>): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * The caps of the hook, read on every call (0 = unlimited):
 *   STUDIO_MAILBOX_HOOK_MAX_PER_SYNC    50   most runs one sync of one connector starts
 *   STUDIO_MAILBOX_HOOK_MAX_PER_MINUTE  60   most runs one app starts within a minute
 * A row over a cap is not retried: it is already stored, so a later sync no longer finds it new.
 */
export function hookLimits(env: Record<string, string | undefined> = process.env): HookLimits {
    return {
        perSync: capFromEnv('STUDIO_MAILBOX_HOOK_MAX_PER_SYNC', 50, env),
        perMinute: capFromEnv('STUDIO_MAILBOX_HOOK_MAX_PER_MINUTE', 60, env),
    };
}
