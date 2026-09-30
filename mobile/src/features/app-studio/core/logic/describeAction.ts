/**
 * What an action is CALLED, in the author's language. Port of agent-hub
 * AppStudio/inspector/actionLabels.js (pinned by logicRows.lockstep.test.ts).
 *
 * The web's sentences are English literals; here they go through `t` with
 * `mobile.app_studio.action.*` keys and the web's words as the fallback, so
 * without a `t` the result is the web's exact string.
 */

import { EN_ONLY, type Translate } from '../msg';
import type { AppAction, AppDefinition, AppNode } from '../types';

export interface DescribeOptions {
    /** Resolves an automation id to its title; without it, "Run routine" unqualified. */
    titleFor?: ((automationId: unknown) => string | null | undefined) | null;
    t?: Translate;
}

/** The title of the modal node with this id, anywhere in the app. */
function findModalTitle(definition: AppDefinition | null | undefined, modalId: unknown): unknown {
    if (!modalId) return null;
    let found: unknown = null;
    const walk = (nodes: AppNode[] | undefined): boolean => {
        for (const n of nodes || []) {
            if (n?.id === modalId && n.type === 'modal') {
                found = n.props?.title || null;
                return true;
            }
            if (Array.isArray(n?.children) && walk(n.children)) return true;
        }
        return false;
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) if (walk(section.children)) return found;
    }
    return found;
}

type Describe = (action: AppAction, definition: AppDefinition | null | undefined, o: Required<DescribeOptions>) => string;

const K = (key: string) => `mobile.app_studio.action.${key}`;

function describeModal(action: AppAction, definition: AppDefinition | null | undefined, { t }: Required<DescribeOptions>): string {
    const open = action.kind === 'open_modal';
    const modal = findModalTitle(definition, action.modalId);
    if (modal) {
        return open
            ? t(K('open_named_dialog'), 'Open the “{name}” dialog', { name: String(modal) })
            : t(K('close_named_dialog'), 'Close the “{name}” dialog', { name: String(modal) });
    }
    return open ? t(K('open_dialog'), 'Open a dialog') : t(K('close_dialog'), 'Close a dialog');
}

const DESCRIBE: Readonly<Record<string, Describe>> = {
    run_automation: (action, _def, { titleFor, t }) => {
        const title = typeof titleFor === 'function' ? titleFor(action.automationId) : null;
        return title ? t(K('run_routine_named'), 'Run routine — {title}', { title: String(title) }) : t(K('run_routine'), 'Run routine');
    },
    navigate: (action, def, { t }) => {
        const screen = (def?.screens || []).find((s) => s.id === action.screenId);
        return screen?.name
            ? t(K('go_to_named'), 'Go to {name}', { name: screen.name })
            : t(K('go_to_screen'), 'Go to screen');
    },
    toast: (action, _def, { t }) => {
        const msg = String(action.message || '').slice(0, 24);
        return msg ? t(K('show_message_named'), 'Show a message: “{text}”', { text: msg }) : t(K('show_message'), 'Show a message');
    },
    open_url: (action, _def, { t }) =>
        action.url ? t(K('open_url_named'), 'Open {url}', { url: String(action.url) }) : t(K('open_url'), 'Open a web page'),
    open_modal: describeModal,
    close_modal: describeModal,
    sequence: (action, _def, { t }) => {
        const n = Array.isArray(action.steps) ? action.steps.length : 0;
        if (!n) return t(K('flow'), 'A flow');
        return n === 1 ? t(K('flow_steps'), 'A flow of {count} step', { count: n }) : t(K('flow_steps_plural'), 'A flow of {count} steps', { count: n });
    },
    send_email: (_a, _d, { t }) => t(K('send_email'), 'Send an e-mail'),
    create_record: (_a, _d, { t }) => t(K('create_record'), 'Add a row'),
    ai_extract: (_a, _d, { t }) => t(K('ai_extract'), 'AI · extract from document'),
    ai_generate: (_a, _d, { t }) => t(K('ai_generate'), 'AI · generate / summarize'),
    kb_query: (_a, _d, { t }) => t(K('kb_query'), 'AI · search knowledge base'),
};

/** A sentence naming the action; an unknown kind reads as its id (the only true label). */
export function describeAction(
    id: string,
    action: AppAction | null | undefined,
    definition: AppDefinition | null | undefined,
    { titleFor = null, t = EN_ONLY }: DescribeOptions = {},
): string {
    const kind = action?.kind;
    const describe = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(DESCRIBE, kind) ? DESCRIBE[kind] : undefined;
    return describe && action ? describe(action, definition, { titleFor, t }) : id;
}

/** `[{ id, label }]` for every action in the app: what a picker lists. */
export function actionOptions(definition: AppDefinition | null | undefined, options: DescribeOptions = {}): { id: string; label: string }[] {
    const actions = definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};
    return Object.entries(actions).map(([id, action]) => ({ id, label: describeAction(id, action, definition, options) }));
}
