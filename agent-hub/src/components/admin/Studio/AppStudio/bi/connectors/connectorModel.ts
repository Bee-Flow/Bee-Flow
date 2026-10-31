/**
 * The connectors editor's pure parts: a connector's shape, the four kinds and
 * how they are named, what a connector is still missing, how the list groups
 * by app, the test preview grid, and the chain hints derived from the
 * integration catalog.
 */
import { AppWindow, Globe, Mail, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import { missingRequiredParams as missingRequiredParamsJs } from '../ActionParamsForm';
import type { SyncBlock } from '../sync/syncModel';

/** One viewer param a connector declares. */
export interface ConnectorParam {
    key?: string;
    type?: string;
    required?: boolean;
}

/** An owner-authored external data source (server/appStudio/connectors.js). */
export interface Connector {
    id: string;
    /** A row the server sent may carry none. */
    kind?: string;
    name?: string;
    tool?: string;
    integrationId?: string;
    automationId?: string;
    url?: string;
    headers?: Record<string, unknown>;
    auth?: { type?: string; header?: string; credentialProvider?: string };
    rowsPath?: string;
    nextPagePath?: string;
    maxRows?: number;
    fixedArgs?: Record<string, unknown>;
    params?: ConnectorParam[];
    chain?: Array<{ argsFrom?: Record<string, unknown> } | null>;
    runAs?: string;
    provider?: string;
    mode?: string;
    address?: string;
    folder?: string;
    query?: string;
    sync?: SyncBlock | null;
    [key: string]: unknown;
}

/** One action of the integration catalog. */
export interface CatalogAction {
    name: string;
    label?: string;
    sideEffect?: boolean;
    outputSample?: unknown;
    inputSchema?: { required?: string[]; [key: string]: unknown };
    [key: string]: unknown;
}

/** useIntegrationCatalog's answer, as far as the editor reads it. */
export interface IntegrationCatalog {
    failed: boolean;
    lookup: (toolName: string | undefined) => { app: { id?: string; label?: string; available?: boolean | null }; action: CatalogAction } | null;
    siblingsOf: (toolName: string | undefined) => CatalogAction[];
}

/** What /inspect learned about a connector's rows. */
export interface InspectResult {
    fields?: Array<{ sourcePath: string; key: string }>;
    chainSuggestions?: ChainSuggestion[];
    [key: string]: unknown;
}

export interface ChainSuggestion {
    param: string;
    tool: string;
    label: string;
    field: string;
    why: string;
}

const missingRequiredParams = missingRequiredParamsJs;

export interface KindOption {
    value: string;
    tag: string;
    label: string;
    description: string;
    Icon: LucideIcon;
    badge?: string;
}

export const kinds = (t: TranslateFn): KindOption[] => [
    {
        value: 'mailbox',
        tag: t('studio_apps_bi.connectors.kind_mailbox_tag', 'Mailbox'),
        label: t('studio_apps_bi.connectors.kind_mailbox_label', 'My mailbox'),
        description: t('studio_apps_bi.connectors.kind_mailbox_desc', 'Reads mail into a table using the Google or Microsoft account you signed in to Bee Flow with. Your own inbox, or a shared one you have access to.'),
        Icon: Mail,
        badge: t('studio_apps_bi.connectors.kind_mailbox_badge', 'For inboxes'),
    },
    {
        value: 'integration_tool',
        tag: t('studio_apps_bi.connectors.kind_app_tag', 'App'),
        label: t('studio_apps_bi.connectors.kind_app_label', 'An app you already use'),
        description: t('studio_apps_bi.connectors.kind_app_desc', 'Gmail, Slack, Google Sheets… — pick the app, then what it should fetch.'),
        Icon: AppWindow,
        badge: t('studio_apps_bi.connectors.kind_app_badge', 'Easiest'),
    },
    {
        value: 'automation',
        tag: t('studio_apps_bi.connectors.kind_automation_tag', 'Automation'),
        label: t('studio_apps_bi.connectors.kind_automation_label', 'One of my Automations'),
        description: t('studio_apps_bi.connectors.kind_automation_desc', 'Run an automation you already built and show whatever it hands back.'),
        Icon: Workflow,
    },
    {
        value: 'rest',
        tag: t('studio_apps_bi.connectors.kind_rest_tag', 'Web address'),
        label: t('studio_apps_bi.connectors.kind_rest_label', 'Another system via its web address'),
        description: t('studio_apps_bi.connectors.kind_rest_desc', 'Advanced. For a system with no ready-made app — you need its web address and sign-in details from whoever runs it.'),
        Icon: Globe,
    },
];

export const PARAM_TYPES = ['text', 'number', 'boolean'];

/**
 * The fields a mailbox connector carries that FOLLOW from the provider and are
 * never chosen by the author: the integration a viewer must have connected,
 * and how a "shared" mailbox is reached (Outlook opens a real delegated
 * mailbox; the Gmail API can only read the signed-in user's own, so "shared"
 * there means a team alias delivered into it). The server refuses a model
 * whose derived values disagree with its provider, so every provider change
 * has to rewrite them in the same edit.
 */
export function mailboxProviderFields(provider: string | undefined): { integrationId: string | undefined; sharedMode: string | undefined } {
    if (provider !== 'gmail' && provider !== 'outlook') return { integrationId: undefined, sharedMode: undefined };
    return { integrationId: provider, sharedMode: provider === 'outlook' ? 'delegated_mailbox' : 'delivered_alias' };
}

export const INPUT = 'w-full rounded-md px-2 py-1.5 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)]';
export const LABEL = 'text-xs font-medium text-[var(--text-secondary)]';

function randHex(n: number): string {
    let s = '';
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a local schema id for a new connector, not a secret or a token
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, n);
}
export function newConnectorId(): string { return `conn_${randHex(6)}`; }

export function labelForKind(kind: string | undefined, t: TranslateFn): string | undefined {
    return kinds(t).find((k) => k.value === kind)?.tag || kind;
}

// connectorProblem is also called outside React (at save time), so `t` is
// optional: without it the English default is used, with placeholders filled.
function plainT(_key: string, english?: string | TranslateParams, params?: TranslateParams): string {
    return String(english).replace(/\{(\w+)\}/g, (m, k: string) => (params && Object.hasOwn(params, k) ? String(params[k]) : m));
}

/**
 * What a connector is still missing before it can work — the per-kind required
 * field in server/appStudio/dataModel.js, plus (when we know the action's
 * schema) any REQUIRED parameter nothing supplies.
 *
 * That second half is what turns the old failure mode — pick `gmail_read`, get
 * an empty JSON box, press "Test it", read "Connector failed to run" — into a
 * sentence on screen before anything is attempted. `action` is optional so the
 * function still works when the catalog hasn't loaded (TablesManager calls it
 * for every connector at save time, catalog or no catalog).
 *
 * Returns null when the connector is complete.
 */
export function connectorProblem(connector: Connector | null | undefined, action: CatalogAction | null = null, t: TranslateFn = plainT): string | null {
    if (!connector) return null;
    if (connector.kind === 'rest' && !connector.url) return t('studio_apps_bi.connectors.problem_rest_url', 'still needs the web address it reads from');
    if (connector.kind === 'integration_tool' && !connector.tool) return t('studio_apps_bi.connectors.problem_tool', 'still needs an app and an action');
    if (connector.kind === 'automation' && !connector.automationId) return t('studio_apps_bi.connectors.problem_automation', 'still needs the automation it runs');
    if (connector.kind === 'mailbox') {
        if (!connector.provider) return t('studio_apps_bi.connectors.problem_provider', 'still needs to know whether it reads Gmail or Outlook');
        if (connector.mode === 'shared' && !connector.address) return t('studio_apps_bi.connectors.problem_address', 'still needs the address of the shared mailbox');
        if (!connector.sync?.tableId) return t('studio_apps_bi.connectors.problem_table', 'still needs the table it writes messages into');
    }
    if (connector.kind === 'integration_tool' && action) {
        const missing = missingRequiredParams(action, connector);
        if (missing.length) {
            return t('studio_apps_bi.connectors.problem_params', 'still needs {params} — pin a value, ask the viewer, or get it from another action', { params: missing.join(` ${t('studio_apps_bi.filter.and', 'and')} `) });
        }
    }
    return null;
}

export interface ConnectorGroup {
    appId: string;
    label: string;
    items: Connector[];
}

/**
 * Group the list by app so ticking five Gmail actions reads as "Gmail, five
 * things" rather than five unrelated rows. Automations and REST connectors have no
 * app, so they fall into their own bucket at the bottom.
 */
export function groupConnectors(list: Connector[], catalog: IntegrationCatalog, t: TranslateFn): ConnectorGroup[] {
    const groups = new Map<string, ConnectorGroup>();
    for (const c of list) {
        const appId = c.kind === 'integration_tool' ? (c.integrationId || catalog.lookup(c.tool)?.app?.id || 'other') : 'other';
        const label = appId === 'other'
            ? t('studio_apps_bi.connectors.group_other', 'Automations & web addresses')
            : (catalog.lookup(c.tool)?.app?.label || c.integrationId || appId);
        if (!groups.has(appId)) groups.set(appId, { appId, label, items: [] });
        (groups.get(appId) as ConnectorGroup).items.push(c);
    }
    return [...groups.values()].sort((a, b) => (a.appId === 'other' ? 1 : 0) - (b.appId === 'other' ? 1 : 0)
        || a.label.localeCompare(b.label));
}

function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// The first rows as a small grid. Rows that aren't objects (a connector may
// return plain strings) collapse to one unnamed column rather than nothing.
export function previewGrid(rows: unknown[]): { columns: string[]; cells: Array<Record<string, string>> } {
    const sample = rows.slice(0, 3);
    const objects = sample.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    if (!sample.length || objects.length !== sample.length) {
        return { columns: ['value'], cells: sample.map((r) => ({ value: cellText(r) })) };
    }
    const columns = [...new Set(objects.flatMap((r) => Object.keys(r)))].slice(0, 4);
    return { columns, cells: objects.map((r) => Object.fromEntries(columns.map((c) => [c, cellText(r[c])]))) };
}

/** What the server's failure means for the person who pressed the button. */
export function testFailureMessage(status: number, body: { code?: string; provider?: string; error?: string } | null, t: TranslateFn): string {
    if (status === 404) return t('studio_apps_bi.connectors.test_save_first', 'Save your changes first — a test always runs the last saved version of this connector.');
    if (body?.code === 'connection_required') {
        const app = body.provider || t('studio_apps_bi.sync.err_connect_that_app', 'that app');
        return t('studio_apps_bi.connectors.test_connect_first', 'Connect {app} to your account first (Settings → Connections), then test again.', { app });
    }
    if (status === 429) return t('studio_apps_bi.connectors.test_rate_limited', 'That is a lot of tests in one minute. Wait a moment and try again.');
    return body?.error || t('studio_apps_bi.sync.err_failed', 'It did not work ({status}).', { status });
}

/** The first object row in an output sample: an array of rows, or an object holding one. */
function firstSampleRow(sample: unknown): Record<string, unknown> | null {
    const rows = Array.isArray(sample) ? sample : Object.values((sample as Record<string, unknown>) || {}).find((v) => Array.isArray(v));
    return Array.isArray(rows) ? rows.find((v) => v && typeof v === 'object') || null : null;
}

/**
 * The row shape the chain editor binds against. /inspect fills this in when
 * the owner sets up a table; before that we fall back to the action's
 * declared output sample so bindings are still offered real field names.
 */
export function availableFieldsOf(inspected: InspectResult | null, action: CatalogAction | null): Array<{ sourcePath: string; key: string }> {
    if (inspected?.fields?.length) return inspected.fields;
    const sample = action?.outputSample;
    const first = Array.isArray(sample)
        ? sample.find((v) => v && typeof v === 'object')
        : (sample && typeof sample === 'object'
            ? (Object.values(sample).find((v) => Array.isArray(v)) as unknown[] | undefined)?.find?.((v) => v && typeof v === 'object') || null
            : null);
    return first ? Object.keys(first).map((k) => ({ sourcePath: k, key: k })) : [];
}

/** The required params of an action that nothing — pinned, asked or chained — supplies yet. */
function unsuppliedParams(action: CatalogAction, connector: Connector): string[] {
    return (action.inputSchema?.required || []).filter((k) => {
        const pinned = connector.fixedArgs && Object.hasOwn(connector.fixedArgs, k);
        const asked = (connector.params || []).some((p) => p?.key === k);
        const chained = (connector.chain || []).some((s) => s?.argsFrom && Object.hasOwn(s.argsFrom, k));
        return !pinned && !asked && !chained;
    });
}

/**
 * Chain suggestions. They come from /inspect; until then, derive them
 * client-side from the catalog so the "gmail read needs a messageId" hint is
 * there on first sight rather than only after a run.
 */
export function chainSuggestionsOf(
    inspected: InspectResult | null, action: CatalogAction | null, catalog: IntegrationCatalog, connector: Connector, t: TranslateFn,
): ChainSuggestion[] {
    if (inspected?.chainSuggestions?.length) return inspected.chainSuggestions;
    if (!action) return [];
    const required = unsuppliedParams(action, connector);
    if (!required.length) return [];
    const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const out: ChainSuggestion[] = [];
    for (const param of required) {
        for (const sibling of catalog.siblingsOf(connector.tool)) {
            if (sibling.sideEffect) continue;
            const first = firstSampleRow(sibling.outputSample);
            if (!first) continue;
            const field = Object.keys(first).find((f) => norm(f) === norm(param)
                || (norm(param).endsWith('id') && norm(f) === 'id'));
            if (!field) continue;
            out.push({
                param,
                tool: sibling.name,
                label: sibling.label || sibling.name,
                field,
                why: t('studio_apps_bi.connectors.suggestion_why', '{action} needs {param} — {sibling} gives one as `{field}`', { action: action.label || action.name, param, sibling: sibling.label || sibling.name, field }),
            });
            break;
        }
    }
    return out;
}
