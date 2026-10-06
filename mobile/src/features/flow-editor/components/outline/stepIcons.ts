/**
 * The glyph on a step card's tile — the icon each web node component draws
 * (flow/nodes/*Node.jsx), in the web's own spelling, pinned by
 * stepIcons.lockstep.test.ts. A step's own symbol (`step.icon`, picked in the
 * inspector) wins over the type's, as on the web (StepNodeBase's
 * customIconName).
 */

import { isStepIcon, type AnyNode } from '@/features/flow-editor/model';
import type { IconName } from '@/shared/ui';

/** Per step type, the node component's icon (an AI step's depends on its variant: AI_STEP_ICON). */
export const TYPE_ICON: Readonly<Record<string, IconName>> = {
    data_extraction: 'ScanText',
    integration_action: 'Wrench',
    http_request: 'Globe',
    code: 'Code2',
    call_block: 'Box',
    condition: 'Split',
    switch: 'Split',
    filter: 'Split',
    parallel: 'GitFork',
    loop: 'Repeat',
    call_layer: 'Layers',
    wait: 'Hourglass',
    notification: 'Bell',
    form_page: 'ClipboardList',
    approval: 'ShieldCheck',
    guard: 'ShieldAlert',
    tokenize: 'VenetianMask',
    untokenize: 'Eye',
    set: 'Pencil',
    datetime: 'Clock',
    generate_document: 'FileText',
    fill_document: 'FileSignature',
    slide: 'RectangleHorizontal',
    presentation: 'Presentation',
    parse_json: 'Braces',
    limit: 'ChevronsDown',
    datatable: 'Table2',
    knowledge_write: 'BookOpen',
    dedupe: 'Copy',
    aggregate: 'Layers',
    summarize: 'Sigma',
    flatten: 'Rows3',
    stop_error: 'OctagonX',
    return_to_app: 'AppWindow',
    layer_output: 'LogOut',
    // Quoted: a step type, not a copy prop.
    'note': 'StickyNote',
};

/** AiStepNode's VARIANT_ICON: an agent wears the bot, a skill without one the bolt. */
export const AI_STEP_ICON: Readonly<Record<AiStepVariant, IconName>> = {
    agent: 'Bot',
    skill: 'Zap',
    instruction: 'Sparkles',
};

export type AiStepVariant = 'agent' | 'skill' | 'instruction';

/** Which of its three cards an AI step draws (the web's aiToolNodes.aiStepVariant). */
export function aiStepVariant(step: unknown): AiStepVariant {
    const { agentId, skillIds } = (step && typeof step === 'object' ? step : {}) as { agentId?: unknown; skillIds?: unknown };
    if (typeof agentId === 'string' && agentId) return 'agent';
    if (Array.isArray(skillIds) && skillIds.some((s) => typeof s === 'string' && s)) return 'skill';
    return 'instruction';
}

/** TriggerNode's KIND_ICON. */
export const TRIGGER_ICON: Readonly<Record<string, IconName>> = {
    schedule: 'Clock',
    manual: 'MousePointer2',
    webhook: 'Webhook',
    app_event: 'Zap',
    agent_call: 'Bot',
    layer_input: 'LogIn',
    app_trigger: 'AppWindow',
    form: 'ClipboardList',
};

/** TriggerNode's APP_EVENT_ICON: a Gmail-new-email trigger wears Mail, not the bolt. */
export const APP_EVENT_ICON: Readonly<Record<string, IconName>> = {
    'gmail.mail.new': 'Mail',
    'gmail.label.added': 'Tag',
    'google-calendar.event.changed': 'Calendar',
    'google-calendar.event.upcoming': 'BellRing',
    'google-drive.file.new': 'FileUp',
    'nextcloud.file.new': 'FilePlus',
    'nextcloud.file.changed': 'FilePen',
    'nextcloud.share.received': 'Share2',
    'nextcloud.activity.new': 'Activity',
    'nextcloud.notification.new': 'Bell',
};

/** DatatableNode's OP_ICON: "this one deletes" legible without reading. */
export const DATATABLE_OP_ICON: Readonly<Record<string, IconName>> = {
    find_rows: 'Search',
    add_row: 'Plus',
    save_row: 'RefreshCw',
    update_rows: 'RefreshCw',
    delete_rows: 'Trash2',
};

const own = <T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined =>
    typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

function triggerIcon(node: AnyNode): IconName {
    const kind = typeof node.kind === 'string' ? node.kind : 'manual';
    const event = node.appEvent as { provider?: string; event?: string } | null | undefined;
    if (kind === 'app_event' && event) {
        const specific = own(APP_EVENT_ICON, `${event.provider}.${event.event}`);
        if (specific) return specific;
    }
    return own(TRIGGER_ICON, kind) ?? 'MousePointer2';
}

function typeIcon(node: AnyNode): IconName {
    if (node.type === 'datatable') return own(DATATABLE_OP_ICON, node.op) ?? 'Table2';
    if (node.type === 'form_page' && node.mode === 'ending') return 'CheckCircle2';
    if (node.type === 'ai_step') return AI_STEP_ICON[aiStepVariant(node)];
    return own(TYPE_ICON, node.type) ?? 'Box';
}

/** The tile glyph for a node: its own symbol, else its type's (or its trigger kind's). */
export function stepIconName(node: AnyNode | null | undefined): IconName {
    if (!node) return 'Box';
    if (isStepIcon(node.icon)) return node.icon as IconName;
    return node.type === 'trigger' ? triggerIcon(node) : typeIcon(node);
}
