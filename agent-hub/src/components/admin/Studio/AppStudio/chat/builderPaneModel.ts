/**
 * The AI builder chat pane's pure parts: the error-code copy, the data cache
 * families an AI turn invalidates, the auto-send rule, the component count the
 * build farewell reports, and the table a selection is bound to.
 */
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { BuildCueValue } from '../editor/BuildCueContext';
import type { AppDefinition } from '../inspector/appDefinition';
import { findNode } from '../state/definitionOps';

/**
 * The editor shell's handles for the chat pane (EditorChromeContext). Every
 * member is optional: the pane also mounts outside the shell (Playbooks).
 */
export interface EditorChrome {
    commitTurn?: (definition: AppDefinition | null | undefined) => void;
    markSaved?: (definition: AppDefinition | null | undefined, version: unknown) => void;
    flush?: () => unknown;
    undoTurn?: () => void;
    publishBuildCue?: (cue: BuildCueValue | null) => void;
    focusAiChat?: () => void;
}

/**
 * The table a node is bound to, if any — from a record/records source binding
 * or a relation input's tableId. Used to ground an AI turn on the selection.
 */
export function boundTableIdFor(definition: AppDefinition | null | undefined, nodeId: string | null): string | null {
    if (!definition || !nodeId) return null;
    const found = findNode(definition, nodeId);
    const props = found?.node?.props;
    if (!props) return null;
    const src = props.source;
    if (src && typeof src === 'object' && (src.kind === 'records' || src.kind === 'record') && src.tableId) {
        return src.tableId;
    }
    return typeof props.tableId === 'string' ? props.tableId : null;
}

// React-query cache families that render the app's DATA side. When the AI
// mutates tables/rows/roles/datasets mid-stream (`data_model` SSE event),
// every family is invalidated so the canvas, TablesManager, QueryBuilder and
// RolesManager reflect the AI's work live. Keys must match:
//   bi/useAppTables.ts         → ['studio-app-tables', appId]
//   bi/useDatasets.ts          → ['studio-app-datasets', appId]
//   rbac/useAppRoles.js        → ['studio-app-schema', appId] + ['studio-app-members', appId]
//   runtime/useAppDataSource.js / AppDataScope → ['studio-app-data', appId]
export const DATA_QUERY_KEY_FAMILIES = (appId: string): Array<[string, string]> => [
    ['studio-app-tables', appId],
    ['studio-app-datasets', appId],
    ['studio-app-schema', appId],
    ['studio-app-members', appId],
    ['studio-app-data', appId],
];

interface ErrorCopy {
    key: string;
    en: string;
    canRetry: boolean;
}

// Wave 6c: map the builder route's SSE error-taxonomy `code` to product copy
// and a retry affordance. `canRetry` gates a "Try again" button on the error
// item (only for the codes where re-sending the same turn can plausibly work).
// Unknown/absent codes fall back to the raw server/drop message (existing
// behaviour) so nothing regresses.
// Keyed, not bare: every code's copy lives in both dictionaries so the pane
// answers in Dutch with the rest of the editor (i18nGuard check 8 hunts the
// bare-English table this used to be).
const ERROR_COPY: Record<string, ErrorCopy> = {
    subscription_limit: { key: 'app_studio.builder.chat.err_subscription_limit', en: "You've reached your plan's AI limit. Upgrade your plan to keep building with AI.", canRetry: false },
    rate_limited: { key: 'app_studio.builder.chat.err_rate_limited', en: "You're sending build requests too quickly. Wait a moment, then try again.", canRetry: true },
    model_unavailable: { key: 'app_studio.builder.chat.err_model_unavailable', en: 'The AI model is unavailable right now. Try again shortly, or pick a different model tier.', canRetry: true },
    transient_upstream: { key: 'app_studio.builder.chat.err_transient_upstream', en: 'The AI provider had a brief hiccup. Your progress is saved — try again in a moment.', canRetry: true },
    model_rejected: { key: 'app_studio.builder.chat.err_model_rejected', en: 'The AI model rejected the request. Your progress is saved — check the model or tier settings before trying again.', canRetry: false },
    model_truncated: { key: 'app_studio.builder.chat.err_model_truncated', en: 'The model ran out of room while reasoning and never got to building. Switch to a tier with thinking off, or shorten the request.', canRetry: false },
    model_empty_reply: { key: 'app_studio.builder.chat.err_model_empty_reply', en: 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch to another tier.', canRetry: true },
    budget_exhausted: { key: 'app_studio.builder.chat.err_budget_exhausted', en: "I ran out of build turns for this request, but your progress is saved. Send another message and I'll keep going.", canRetry: true },
    validation_failed: { key: 'app_studio.builder.chat.err_validation_failed', en: "The app had validation errors the AI couldn't clear. Review the issues below and try again.", canRetry: false },
    save_conflict: { key: 'app_studio.builder.chat.err_save_conflict', en: 'The app changed in another tab while the AI was building. Reopen it and try again.', canRetry: false },
    internal: { key: 'app_studio.builder.chat.err_internal', en: 'The AI builder ran into an unexpected problem. Your progress is saved.', canRetry: false },
};

/** Friendly copy + retry flag for a builder error `code`; falls back to `raw`. */
export function friendlyBuilderError(code: string | null | undefined, raw: string | null | undefined, t: TranslateFn | null = null): { message: string; canRetry: boolean } {
    const c: ErrorCopy | undefined = code ? ERROR_COPY[code] : undefined;
    if (c) return { message: t ? t(c.key, c.en) : c.en, canRetry: c.canRetry };
    return { message: raw || (t ? t('app_studio.builder.chat.err_generic', 'The AI builder ran into a problem.') : 'The AI builder ran into a problem.'), canRetry: false };
}

interface CountableNode {
    children?: CountableNode[];
}

/** Every component on every screen — the number the build farewell reports. */
export function countComponents(def: AppDefinition | null | undefined): number {
    let n = 0;
    const walk = (children: CountableNode[] | undefined) => { for (const c of children || []) { n += 1; if (Array.isArray(c.children)) walk(c.children); } };
    for (const scr of (def && def.screens) || []) for (const sec of scr.sections || []) walk(sec.children);
    return n;
}

/**
 * Should a pane mounted with `autoSend` fire it? Once, at mount, on a pane
 * with no conversation yet and nothing in flight — the same rule as the
 * automation builder's canAutoSend. A host remounts the pane (React `key`) to
 * fire again. Pure.
 */
export function canAutoSendApp({ autoSend, messageCount, busy }: { autoSend: unknown; messageCount?: number; busy?: boolean }): boolean {
    return typeof autoSend === 'string' && autoSend.trim() !== '' && !busy && (messageCount || 0) === 0;
}
