/**
 * importEnvelope.mts: a `beeflow.automation` envelope becomes a NEW inactive
 * draft owned by the importer. Shared by POST /api/automation/import (a file
 * exported from Bee Flow) and the Windmill importer (the converter produces
 * the same envelope), so every import goes through one set of gates.
 *
 *   prepareImport(envelope, ctx)   sanitizeImport (allow-list + format gate) →
 *                                  re-link datatables from the caller's own scopes →
 *                                  validateDefinition hard-fail on the file as sent →
 *                                  rekeyDefinition (fresh step ids per graph) →
 *                                  catalog-aware pass on the draft AS STORED (warnings only) →
 *                                  knowledge-base findings, app back-pointer removed, schedule armed
 *   createPrepared(prepared, ctx, { client? })   createAutomation (always inactive, is_draft);
 *                                  `client` is the caller's transaction (the Windmill import
 *                                  writes its report row on it)
 *   afterCreate(automation, prepared, ctx)       syncDatatableUsage + syncKbSources, after the commit
 *   importEnvelope(envelope, ctx)  the three in a row: what POST /import answers
 *
 * Nothing here reads a request: the route hands in who the caller is and the
 * three lookups that need the request (their datatables, their permitted
 * apps, the knowledge-base findings in their organisation).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Finding = Record<string, unknown>;
type Definition = Record<string, any>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface ImportContext {
    userId: string;
    organizationId: string | null;
    /** The caller's datatables (both tenancies, graded); [] when unavailable. */
    importableDatatables: () => Promise<Array<{ id: string; key: string; name?: string }>>;
    /** The integrations the caller may use (for the catalog-aware pass). */
    permittedApps: () => Promise<Set<string>>;
    /** Knowledge-base findings for the stored definition, at the draft stage. */
    kbFindings: (definition: Definition) => Promise<Finding[]>;
}

export interface PreparedImport {
    incoming: { title: string; description: string; triggerType: string; scheduleCron: string | null; scheduleTz: string | null; definition: Definition };
    definition: Definition;
    renameMap: { root?: Record<string, string>; layers?: Record<string, Record<string, string>> } | null;
    nextRunAt: string | null;
    /** Every finding except the datatable ones (those need the renamed ids). */
    warnings: Finding[];
    datatableFindings: Finding[];
}

export type ImportRefused = { ok: false; status: number; body: { error: string; details: unknown[] } };
export type PrepareResult = { ok: true; prepared: PreparedImport } | ImportRefused;

const log = () => nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void };

/** The renamed id of a step after rekeyDefinition (root or one inline layer). */
export function renamedIdOf(renameMap: PreparedImport['renameMap'], layerKey: string | null | undefined, id: string): string {
    const map = layerKey ? renameMap?.layers?.[layerKey] : renameMap?.root;
    return map && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : id;
}

/** Datatable re-link findings, in the ids the caller asks for. */
function datatableFindingsOf(entries: any[], stepIdOf: (layerKey: string | null, id: string) => string): Finding[] {
    return entries.map((e) => {
        const stepId = stepIdOf(e.layerKey, e.stepId) || '';
        return {
            code: e.datatableId ? 'datatable.relinked' : 'datatable.unlinked',
            severity: 'warning',
            path: e.layerKey ? `layers.${e.layerKey}.steps.${stepId}` : `steps.${stepId}`,
            message: e.message,
            hint: e.datatableId ? 'A table key travels with an exported automation; the table it names here is yours.' : 'Open the step in the builder and pick a table.',
        };
    });
}

/** The catalog-aware pass on the stored draft: findings only, never a refusal. */
async function catalogFindings(definition: Definition, fallback: Finding[], ctx: ImportContext): Promise<Finding[]> {
    try {
        const { TOOL_REGISTRY, loadTools } = nodeRequire('../../automation/toolRegistry');
        const { validateDefinition } = nodeRequire('../../automation/validate');
        const { getDeliverableEvents } = nodeRequire('../../automation/deliverableEvents');
        const permitted = await ctx.permittedApps();
        const availableTools = new Set<string>();
        const toolRequiredParams: Record<string, string[]> = {};
        for (const entry of TOOL_REGISTRY) {
            const permittedApp = permitted.has(entry.app);
            for (const t of loadTools(entry)) {
                const name = t?.function?.name;
                if (!name) continue;
                if (permittedApp) availableTools.add(name);
                const rq = t?.function?.parameters?.required;
                if (Array.isArray(rq)) toolRequiredParams[name] = rq;
            }
        }
        const v2 = validateDefinition(definition, { availableTools, toolRequiredParams, deliverableEvents: getDeliverableEvents() });
        return [...(v2.errors || []), ...(v2.warnings || [])];
    } catch (e) {
        log().warn('[automation/import] tool catalog build failed; importing without tool warnings:', (e as Error).message);
        return fallback;
    }
}

export async function prepareImport(envelope: unknown, ctx: ImportContext): Promise<PrepareResult> {
    const { sanitizeImport, rebindDatatables, rekeyDefinition, stripAppRefs } = nodeRequire('../../automation/portability');
    const { validateDefinition } = nodeRequire('../../automation/validate');
    const { automation: incoming, errors: importErrors } = sanitizeImport(envelope);
    if (!incoming || importErrors.length > 0) return { ok: false, status: 400, body: { error: 'Invalid import file', details: importErrors } };

    // Re-link datatable steps BEFORE validating: export blanks the id and keeps
    // the key, and `datatable.table_missing` blocks at this stage. Only the
    // caller's own tables are offered, so a re-link cannot cross a scope.
    const { entries: datatableEntries } = rebindDatatables(incoming.definition, await ctx.importableDatatables());

    const v = validateDefinition(incoming.definition);
    // A refused file is reported in the ids the file itself uses.
    if (!v.ok) return { ok: false, status: 400, body: { error: 'Invalid definition', details: [...v.errors, ...datatableFindingsOf(datatableEntries, (_l, id) => id)] } };

    // Fresh step ids per graph, so importing the same file twice never collides
    // and crafted ids cannot alias existing drafts' replay data.
    const { definition, renameMap } = rekeyDefinition(incoming.definition);

    // Same construction as the activate route; its findings are warnings here
    // (the draft lands inactive, activate re-checks hard).
    const stored = definition === incoming.definition ? v : validateDefinition(definition);
    const fallback = [...(stored === v ? [] : stored.errors || []), ...(stored.warnings || [])];
    let warnings = await catalogFindings(definition, fallback, ctx);
    warnings = [...warnings, ...await ctx.kbFindings(definition)];

    // The back-pointer to an app button comes off, the same rule as on export.
    if (stripAppRefs(definition, [])) {
        warnings.push({
            code: 'import.app_ref_removed', severity: 'warning', path: 'definition.trigger.appRef',
            message: 'Removed the link back to an app button — it names a screen in the installation this file came from.',
            hint: 'Open the button in App Studio and pick this automation there to link them again.',
        });
    }

    // Best-effort schedule arming: a bad cron never blocks a draft.
    let nextRunAt: string | null = null;
    if (incoming.triggerType === 'schedule' && incoming.scheduleCron) {
        try { nextRunAt = nodeRequire('../../automation/cron').nextRunAt(incoming.scheduleCron, incoming.scheduleTz || 'Europe/Amsterdam', Date.now()); }
        catch (e) {
            warnings.push({ code: 'import.bad_cron', severity: 'warning', path: 'scheduleCron', message: `Schedule "${incoming.scheduleCron}" did not parse (${(e as Error).message}).`, hint: 'Open the trigger and pick a schedule again before activating.' });
        }
    }
    const datatableFindings = datatableFindingsOf(datatableEntries, (layerKey, id) => renamedIdOf(renameMap, layerKey, id));
    return { ok: true, prepared: { incoming, definition, renameMap: renameMap ?? null, nextRunAt, warnings, datatableFindings } };
}

/** The draft row (inactive, is_draft). `client`: the caller's open transaction. */
export async function createPrepared(prepared: PreparedImport, ctx: ImportContext, { client = null }: { client?: Queryable | null } = {}) {
    const automationStore = nodeRequire('../../stores/automationStore');
    const { incoming, definition, nextRunAt } = prepared;
    return automationStore.createAutomation({
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        title: incoming.title,
        description: incoming.description,
        definition,
        triggerType: incoming.triggerType,
        scheduleCron: incoming.scheduleCron,
        scheduleTz: incoming.scheduleTz || 'Europe/Amsterdam',
        nextRunAt,
    }, ...(client ? [{ client }] : []));
}

/** The usage index and the knowledge-base sources follow the stored definition (after the commit). */
export async function afterCreate(automation: { id: string; title: string }, prepared: PreparedImport, ctx: ImportContext): Promise<void> {
    const { syncDatatableUsage } = nodeRequire('../../automation/datatableUsageSync');
    const { syncKbSources } = nodeRequire('../../core/kb/kbSourceSync');
    await syncDatatableUsage(automation.id, ctx.organizationId, prepared.definition, { label: 'automation import' });
    await syncKbSources(automation.id, prepared.definition, { userId: ctx.userId, title: automation.title });
}

/** What POST /api/automation/import answers. */
export async function importEnvelope(envelope: unknown, ctx: ImportContext): Promise<ImportRefused | { ok: true; automation: any; warnings: Finding[] }> {
    const r = await prepareImport(envelope, ctx);
    if (r.ok === false) return r;
    const automation = await createPrepared(r.prepared, ctx);
    await afterCreate(automation, r.prepared, ctx);
    return { ok: true as const, automation, warnings: [...r.prepared.warnings, ...r.prepared.datatableFindings] };
}
