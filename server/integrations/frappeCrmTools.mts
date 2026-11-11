/**
 * Frappe CRM tools: read and write leads, deals, contacts, organisations,
 * tasks and notes of a Frappe CRM site (Frappe Cloud or self-hosted) for chat,
 * agents, automations and apps.
 *
 * Bring-your-own connection like Firebird: a user stores the site address, an
 * API key and an API secret (Settings > Connections); the tools act as the
 * Frappe user that key belongs to, so Frappe's own permissions apply.
 *
 * What keeps the surface narrow:
 *   - Only the DocTypes in frappeCrmToolDefs.DOCTYPES; there is no tool that
 *     takes a DocType from the model, and no delete.
 *   - Record names are shape-checked and encodeURIComponent'd before they go
 *     into a path; filters are built from typed arguments, never passed through.
 *   - A write sends only the fields of WRITABLE_FIELDS for its kind.
 *   - Page size and output size are capped (FRAPPE_CRM_MAX_PAGE_SIZE,
 *     FRAPPE_CRM_MAX_OUTPUT_CHARS; 0 = unlimited).
 *   - The log line names the tool and the HTTP status, never record content
 *     and never the key or secret.
 */

import { createRequire } from 'node:module';
import { DOCTYPES, WRITABLE_FIELDS, FRAPPE_CRM_TOOLS, FRAPPE_CRM_TOOL_NAMES, getMaxPageSize, type DocKind } from './frappeCrmToolDefs.mts';
import {
    ArgError, DEFAULT_FIELDS, parseRecordName, recordPath, optionalFilterText, parseFields, clampLimit, parseOffset, parseOrder,
    parseRecordType, shapeDoc, budgetRows, budgetDoc, dataOf, buildWriteBody, type ToolArgs, type Filter,
} from './frappeCrmArgs.mts';
import {
    frappeRequest, getFrappeCrmCredentials, assertValidCredentials, FrappeCrmError, type FrappeCreds,
} from './frappeCrmClient.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

export { FRAPPE_CRM_TOOLS, FRAPPE_CRM_TOOL_NAMES };

export const NOT_CONFIGURED = 'Frappe CRM is not connected. Add the site address, API key and API secret in Settings > Connections.';
export const CONNECT_FAILED = 'Could not connect to Frappe CRM. Check the site address, the API key and the API secret.';

export { parseRecordName, recordPath, isFieldName, clampLimit, shapeDoc, buildWriteBody } from './frappeCrmArgs.mts';
export type { ToolArgs } from './frappeCrmArgs.mts';

const SEARCH_FIELDS: Partial<Record<DocKind, readonly string[]>> = {
    lead: ['lead_name', 'email', 'organization', 'mobile_no'],
    deal: ['organization', 'lead_name', 'email'],
    contact: ['full_name', 'email_id', 'company_name', 'mobile_no'],
    organization: ['organization_name', 'website'],
};

// ─── Reads ─────────────────────────────────────────────────────

interface ListQuery {
    kind: DocKind;
    fields: string[];
    filters: Filter[];
    orFilters?: Filter[];
    order: string;
    limit: number;
    offset: number;
}

async function listRecords(creds: FrappeCreds, q: ListQuery): Promise<Record<string, unknown>> {
    const unlimited = !Number.isFinite(q.limit);
    const answer = await frappeRequest(creds, 'GET', `/api/resource/${encodeURIComponent(DOCTYPES[q.kind])}`, {
        query: {
            fields: JSON.stringify(q.fields),
            filters: q.filters.length ? JSON.stringify(q.filters) : undefined,
            or_filters: q.orFilters && q.orFilters.length ? JSON.stringify(q.orFilters) : undefined,
            order_by: q.order,
            // One extra row says whether there is a next page; 0 is Frappe's "all".
            limit_page_length: unlimited ? 0 : q.limit + 1,
            limit_start: q.offset,
        },
    });
    const raw = dataOf(answer);
    const all = (Array.isArray(raw) ? raw : []).map(shapeDoc);
    const hasMore = !unlimited && all.length > q.limit;
    const page = hasMore ? all.slice(0, q.limit) : all;
    const { rows, overBudget } = budgetRows(page);
    const out: Record<string, unknown> = { data: rows, count: rows.length, offset: q.offset, has_more: hasMore || overBudget };
    if (overBudget) out.message = `Answer too large: showing ${rows.length} of ${page.length} records. Ask for fewer fields or a smaller limit, or continue with offset ${q.offset + rows.length}.`;
    else if (hasMore) out.message = `More records are available: continue with offset ${q.offset + rows.length}.`;
    return out;
}

function searchFilters(kind: DocKind, search: string | undefined): Filter[] | undefined {
    if (search === undefined) return undefined;
    return (SEARCH_FIELDS[kind] || []).map((f): Filter => [f, 'like', `%${search}%`]);
}

/** A list tool of one of the four searchable kinds. */
async function listKind(creds: FrappeCreds, kind: DocKind, args: ToolArgs, equalityArgs: string[]): Promise<Record<string, unknown>> {
    const filters: Filter[] = [];
    for (const field of equalityArgs) {
        const value = optionalFilterText(args[field], field);
        if (value !== undefined) filters.push([field, '=', value]);
    }
    return listRecords(creds, {
        kind,
        fields: parseFields(args.fields, kind),
        filters,
        orFilters: searchFilters(kind, optionalFilterText(args.search, 'search')),
        order: parseOrder(args.order_by),
        limit: clampLimit(args.limit),
        offset: parseOffset(args.offset),
    });
}

async function getRecord(creds: FrappeCreds, kind: DocKind, args: ToolArgs): Promise<Record<string, unknown>> {
    const name = parseRecordName(args.name);
    const answer = await frappeRequest(creds, 'GET', recordPath(kind, name));
    return { data: budgetDoc(shapeDoc(dataOf(answer))) };
}

async function listTasks(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const filters: Filter[] = [];
    if (args.record_type !== undefined || args.record_name !== undefined) {
        const kind = parseRecordType(args.record_type);
        filters.push(['reference_doctype', '=', DOCTYPES[kind]], ['reference_docname', '=', parseRecordName(args.record_name, 'record_name')]);
    }
    const status = optionalFilterText(args.status, 'status');
    if (status !== undefined) filters.push(['status', '=', status]);
    const assignedTo = optionalFilterText(args.assigned_to, 'assigned_to');
    if (assignedTo !== undefined) filters.push(['assigned_to', '=', assignedTo]);
    return listRecords(creds, {
        kind: 'task', fields: [...DEFAULT_FIELDS.task], filters,
        order: parseOrder(args.order_by), limit: clampLimit(args.limit), offset: parseOffset(args.offset),
    });
}

async function listNotes(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const kind = parseRecordType(args.record_type);
    const name = parseRecordName(args.record_name, 'record_name');
    return listRecords(creds, {
        kind: 'note', fields: [...DEFAULT_FIELDS.note],
        filters: [['reference_doctype', '=', DOCTYPES[kind]], ['reference_docname', '=', name]],
        order: 'creation desc', limit: clampLimit(args.limit), offset: parseOffset(args.offset),
    });
}

async function listStatuses(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const kind = parseRecordType(args.record_type) === 'lead' ? 'lead_status' : 'deal_status';
    return listRecords(creds, {
        kind, fields: [...DEFAULT_FIELDS[kind]], filters: [], order: 'position asc', limit: getMaxPageSize(), offset: 0,
    });
}

// ─── Writes ────────────────────────────────────────────────────

function writeResult(answer: unknown, kind: DocKind, action: string): Record<string, unknown> {
    const doc = shapeDoc(dataOf(answer));
    const summary: Record<string, unknown> = {};
    for (const f of DEFAULT_FIELDS[kind]) if (doc[f] !== undefined) summary[f] = doc[f];
    return { ok: true, action, name: doc.name ?? null, record: summary };
}

async function createLead(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const body = buildWriteBody('lead', args);
    if (!body.first_name) throw new ArgError('first_name is required to create a lead.');
    return writeResult(await frappeRequest(creds, 'POST', `/api/resource/${encodeURIComponent(DOCTYPES.lead)}`, { body }), 'lead', 'created');
}

async function createDeal(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const body = buildWriteBody('deal', args);
    return writeResult(await frappeRequest(creds, 'POST', `/api/resource/${encodeURIComponent(DOCTYPES.deal)}`, { body }), 'deal', 'created');
}

async function updateRecord(creds: FrappeCreds, kind: 'lead' | 'deal', args: ToolArgs): Promise<Record<string, unknown>> {
    const name = parseRecordName(args.name);
    const body = buildWriteBody(kind, args);
    if (Object.keys(body).length === 0) throw new ArgError(`Pass at least one field to change (${WRITABLE_FIELDS[kind].join(', ')}).`);
    const result = writeResult(await frappeRequest(creds, 'PUT', recordPath(kind, name), { body }), kind, 'updated');
    return { ...result, updated_fields: Object.keys(body) };
}

async function addNote(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const kind = parseRecordType(args.record_type);
    const reference = parseRecordName(args.record_name, 'record_name');
    const body: Record<string, string | number> = buildWriteBody('note', args);
    if (!body.title) throw new ArgError('title is required for a note.');
    body.reference_doctype = DOCTYPES[kind];
    body.reference_docname = reference;
    return writeResult(await frappeRequest(creds, 'POST', `/api/resource/${encodeURIComponent(DOCTYPES.note)}`, { body }), 'note', 'created');
}

async function createTask(creds: FrappeCreds, args: ToolArgs): Promise<Record<string, unknown>> {
    const body: Record<string, string | number> = buildWriteBody('task', args);
    if (!body.title) throw new ArgError('title is required for a task.');
    if (!body.status) body.status = 'Todo';
    if (args.record_type !== undefined || args.record_name !== undefined) {
        const kind = parseRecordType(args.record_type);
        body.reference_doctype = DOCTYPES[kind];
        body.reference_docname = parseRecordName(args.record_name, 'record_name');
    }
    return writeResult(await frappeRequest(creds, 'POST', `/api/resource/${encodeURIComponent(DOCTYPES.task)}`, { body }), 'task', 'created');
}

// ─── Dispatch ──────────────────────────────────────────────────

const HANDLERS: Record<string, (creds: FrappeCreds, args: ToolArgs) => Promise<Record<string, unknown>>> = {
    frappe_crm_list_leads: (c, a) => listKind(c, 'lead', a, ['status', 'lead_owner']),
    frappe_crm_get_lead: (c, a) => getRecord(c, 'lead', a),
    frappe_crm_list_deals: (c, a) => listKind(c, 'deal', a, ['status', 'organization', 'deal_owner']),
    frappe_crm_get_deal: (c, a) => getRecord(c, 'deal', a),
    frappe_crm_list_contacts: (c, a) => listKind(c, 'contact', a, []),
    frappe_crm_get_contact: (c, a) => getRecord(c, 'contact', a),
    frappe_crm_list_organizations: (c, a) => listKind(c, 'organization', a, []),
    frappe_crm_get_organization: (c, a) => getRecord(c, 'organization', a),
    frappe_crm_list_tasks: listTasks,
    frappe_crm_list_notes: listNotes,
    frappe_crm_list_statuses: listStatuses,
    frappe_crm_create_lead: createLead,
    frappe_crm_update_lead: (c, a) => updateRecord(c, 'lead', a),
    frappe_crm_create_deal: createDeal,
    frappe_crm_update_deal: (c, a) => updateRecord(c, 'deal', a),
    frappe_crm_add_note: addNote,
    frappe_crm_create_task: createTask,
};

export function isFrappeCrmTool(toolName: string): boolean {
    return FRAPPE_CRM_TOOL_NAMES.has(toolName);
}

/** Run one tool for a user. Answers the result, or `{ error }` with a sentence that is safe to show. */
export async function executeFrappeCrmTool(toolName: string, args: ToolArgs | undefined, userId: string): Promise<Record<string, unknown>> {
    if (!userId) return { error: 'User context required for Frappe CRM.' };
    const handler = isFrappeCrmTool(toolName) ? HANDLERS[toolName] : undefined;
    if (!handler) return { error: `Unknown Frappe CRM tool: ${toolName}` };
    const stored = await getFrappeCrmCredentials(userId);
    if (!stored) return { error: NOT_CONFIGURED };
    try {
        const creds = assertValidCredentials(stored);
        log.info(`[FrappeCRM] ${toolName}`);
        return await handler(creds, args && typeof args === 'object' ? args : {});
    } catch (err) {
        if (err instanceof ArgError) return { error: `Frappe CRM: ${err.message}` };
        const status = err instanceof FrappeCrmError && err.status ? ` (HTTP ${err.status})` : '';
        // The tool name and the status only: a message can quote record content.
        log.warn(`[FrappeCRM] ${toolName} failed${status}`);
        return { error: `Frappe CRM: ${err instanceof Error ? err.message : 'the request failed.'}` };
    }
}

/**
 * Try a connection (stored or not yet saved) for the settings test button:
 * who the API key logs in as.
 */
export async function testFrappeCrmConnection(raw: { url?: unknown; apiKey?: unknown; apiSecret?: unknown }): Promise<{ ok: boolean; user?: string; error?: string }> {
    let creds: FrappeCreds;
    try {
        creds = assertValidCredentials(raw || {});
    } catch (err) {
        // Our own wording about the values: safe to show.
        return { ok: false, error: (err as Error).message };
    }
    try {
        const answer = await frappeRequest(creds, 'GET', '/api/method/frappe.auth.get_logged_user');
        const user = answer && typeof answer === 'object' ? (answer as { message?: unknown }).message : undefined;
        if (typeof user !== 'string' || !user) return { ok: false, error: CONNECT_FAILED };
        return { ok: true, user };
    } catch (err) {
        const status = err instanceof FrappeCrmError && err.status ? ` (HTTP ${err.status})` : '';
        log.warn(`[FrappeCRM] connection test failed${status}`);
        return { ok: false, error: err instanceof FrappeCrmError ? `Frappe CRM: ${err.message}` : CONNECT_FAILED };
    }
}
