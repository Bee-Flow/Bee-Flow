/**
 * windmillImport.mts: Windmill flows become INACTIVE draft automations, each
 * with a migration report (PLAN B1-F, B1-W, B5).
 *
 *   windmillLimits()                    the AUTOMATION_IMPORT_WINDMILL_* settings (0 = unlimited)
 *   convertWindmill(input, limits)      parse + convert (pure: automation/importers/windmill)
 *   previewOf(conversion)               what the dialog shows per flow before anything is written
 *   commitWindmill(conversion, opts)    per selected flow: the shared import pipeline
 *                                       (usecases/automation/importEnvelope.mts), then the
 *                                       automation row and its report row in ONE transaction;
 *                                       a flow that fails does not stop the batch
 *   importReportView(automation, row)   GET /:id/import-report: the report, the gate state and
 *                                       the "Complete with AI" briefing
 *
 * Stateless on purpose: preview and commit get the same input and convert it
 * again (the converter is deterministic), so no preview state sits between
 * replicas and the client sends the file again on commit.
 *
 * What never happens here: a secret is read or stored (the converter drops
 * resource and variable values and scrubs every source it keeps), a token is
 * stored (source W passes it to windmillRemote.mts and nowhere else), code
 * from the export runs (it is parsed, never executed), or an automation goes
 * live (createAutomation writes an inactive draft; activation is gated by
 * automation/importGate.mts).
 */

import { createRequire } from 'node:module';
import type { ImportContext, PreparedImport } from './importEnvelope.mts';
import { prepareImport, createPrepared, afterCreate, renamedIdOf } from './importEnvelope.mts';
import { buildConversionBrief } from './windmillConversionBrief.mts';
import { gateState, markChecklist } from '../../automation/importGate.mts';
import type { ImportRow, NewImportRow, SourceKind } from '../../stores/automationImportStore.mts';

const nodeRequire = createRequire(import.meta.url);

type Json = Record<string, any>;

export interface WindmillLimits {
    maxBytes: number;
    maxUnzippedBytes: number;
    maxEntries: number;
    maxFlows: number;
    rpm: number;
    briefPerItemChars: number;
    briefTotalChars: number;
}

/** The import's limits; every one is an env var, 0 = unlimited (docs/docs/self-hosting/env.md). */
export function windmillLimits(): WindmillLimits {
    const { envInt } = nodeRequire('../../utils/envNumber.mts') as { envInt: (n: string, d: number, b?: { min?: number }) => number };
    const MB = 1024 * 1024;
    return {
        maxBytes: envInt('AUTOMATION_IMPORT_WINDMILL_MAX_BYTES', 25 * MB, { min: 0 }),
        maxUnzippedBytes: envInt('AUTOMATION_IMPORT_WINDMILL_MAX_UNZIPPED_BYTES', 200 * MB, { min: 0 }),
        maxEntries: envInt('AUTOMATION_IMPORT_WINDMILL_MAX_ENTRIES', 5000, { min: 0 }),
        maxFlows: envInt('AUTOMATION_IMPORT_WINDMILL_MAX_FLOWS', 200, { min: 0 }),
        rpm: envInt('AUTOMATION_IMPORT_WINDMILL_RPM', 20, { min: 0 }),
        briefPerItemChars: envInt('AUTOMATION_IMPORT_WINDMILL_BRIEF_CHARS_PER_ITEM', 6000, { min: 0 }),
        briefTotalChars: envInt('AUTOMATION_IMPORT_WINDMILL_BRIEF_CHARS_TOTAL', 40000, { min: 0 }),
    };
}

// ── Converting ───────────────────────────────────────────────────────────

type Converter = {
    toIntermediate: (input: unknown, limits?: Json) => Promise<Json>;
    toBeeFlow: (bundle: Json, opts?: Json) => { flows: Json[]; notMigrated: string[]; readWarnings: string[] };
    BundleError: new (...a: any[]) => Error;
    PathRefused: new (...a: any[]) => Error;
    YamlError: new (...a: any[]) => Error;
};

const converter = (): Converter => nodeRequire('../../automation/importers/windmill/index.mts') as Converter;

export interface Conversion {
    flows: Json[];
    notMigrated: string[];
    readWarnings: string[];
    /** Windmill path → 'flow_exapp' (CORE:LISTEN_TO_EVENT) | 'standalone' (native trigger) | null. */
    generations: Map<string, string | null>;
    notes: string[];
}

/** Whether code steps can run here (isolated-vm installed). Without, scripts become checklist items. */
function codeStepAvailable(): boolean {
    try { return !!(nodeRequire('../../automation/codeSandbox') as { isAvailable: () => boolean }).isAvailable(); } catch { return false; }
}

/** The export → converter output. An unreadable or oversized input is a 400 with the converter's own sentence. */
export async function convertWindmill(input: unknown, limits: WindmillLimits, notes: string[] = []): Promise<Conversion> {
    const c = converter();
    let bundle: Json;
    try {
        bundle = await c.toIntermediate(input, { maxEntries: limits.maxEntries, maxTotalBytes: limits.maxUnzippedBytes, maxFileBytes: limits.maxUnzippedBytes });
    } catch (e) {
        if (e instanceof c.BundleError || e instanceof c.PathRefused || e instanceof c.YamlError) {
            const { HttpError } = nodeRequire('../../core/http/errors');
            throw new HttpError(400, 'import.windmill.unreadable', `The Windmill export could not be read: ${(e as Error).message}`);
        }
        throw e;
    }
    const result = c.toBeeFlow(bundle, { capabilities: { codeStep: codeStepAvailable() } });
    const generations = new Map<string, string | null>();
    for (const f of bundle.flows as Array<{ path: string; dialect?: string }>) {
        generations.set(f.path, f.dialect === 'exapp' ? 'flow_exapp' : f.dialect === 'native' ? 'standalone' : null);
    }
    return { flows: result.flows, notMigrated: result.notMigrated, readWarnings: result.readWarnings, generations, notes };
}

// ── Preview ──────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low' | 'none';

/** The flow's overall confidence: its weakest module (PLAN B5 table). */
export function overallConfidence(report: Json): Confidence {
    const modules: Array<{ status?: string; confidence?: string }> = Array.isArray(report.modules) ? report.modules : [];
    if (modules.some((m) => m.status === 'unsupported')) return 'none';
    if (modules.some((m) => m.status === 'ai' || m.confidence === 'low') || (report.aiChecklist?.length ?? 0) > 0) return 'low';
    if (modules.some((m) => m.status === 'shim' || m.confidence === 'medium')) return 'medium';
    return 'high';
}

export function previewOf(conv: Conversion) {
    return {
        flows: conv.flows.map((f) => {
            const r = f.report as Json;
            const errors: string[] = r.validation?.errors ?? [];
            return {
                path: String(f.flowPath),
                title: String(f.title),
                triggerType: String(f.envelope?.automation?.triggerType ?? 'manual'),
                generation: conv.generations.get(f.flowPath) ?? null,
                counts: r.counts,
                confidence: overallConfidence(r),
                modules: r.modules,
                aiChecklist: (r.aiChecklist ?? []).map((i: Json) => ({ wmId: i.wmId, stepId: i.stepId ?? null, title: i.title, why: i.why })),
                warnings: r.warnings ?? [],
                connections: r.connections ?? [],
                outboundHosts: r.outboundHosts ?? [],
                suggestedRunPolicy: r.suggestedRunPolicy ?? {},
                ...(r.suggestedWebhookAuth ? { suggestedWebhookAuth: r.suggestedWebhookAuth } : {}),
                validationErrors: errors,
                importable: errors.length === 0,
            };
        }),
        notMigrated: conv.notMigrated,
        readWarnings: conv.readWarnings,
        notes: conv.notes,
    };
}

// ── Commit ───────────────────────────────────────────────────────────────

/**
 * The suggested run policy goes INTO the definition where the run-policy
 * schema takes it (concurrency, duration, retention); whatever it refuses
 * stays a suggestion in the report.
 */
export function applyRunPolicy(definition: Json, suggested: Json): { applied: Json; leftOver: Json } {
    const { sanitizeRunPolicy } = nodeRequire('../../core/automationRunner/runPolicy') as { sanitizeRunPolicy: (raw: unknown) => { value?: Json; errors: unknown[] } };
    const applied: Json = {};
    const leftOver: Json = {};
    for (const [k, v] of Object.entries(suggested ?? {})) {
        const one = sanitizeRunPolicy({ [k]: v });
        if (one.errors.length || one.value?.[k] === undefined) leftOver[k] = v;
        else applied[k] = one.value[k];
    }
    if (Object.keys(applied).length) definition.runPolicy = { ...(definition.runPolicy ?? {}), ...applied };
    return { applied, leftOver };
}

/** Which inline layer (if any) of the file's definition holds step `id`. */
function layerOf(definition: Json, id: string): string | null {
    const layers = definition?.layers;
    if (!layers || typeof layers !== 'object') return null;
    for (const [key, layer] of Object.entries(layers as Json)) {
        if (JSON.stringify((layer as Json)?.steps ?? []).includes(`"id":${JSON.stringify(id)}`)) return key;
    }
    return null;
}

/** The checklist with the stored (renamed) step ids and each source cut to the per-item cap. */
function storedChecklist(items: Json[], fileDefinition: Json, prepared: PreparedImport, perItemChars: number): Json[] {
    return items.map((i) => {
        const stepId = typeof i.stepId === 'string' && i.stepId ? renamedIdOf(prepared.renameMap, layerOf(fileDefinition, i.stepId), i.stepId) : null;
        const source = typeof i.source === 'string' ? (perItemChars > 0 && i.source.length > perItemChars ? i.source.slice(0, perItemChars) : i.source) : undefined;
        const inputsJson = i.inputs ? JSON.stringify(i.inputs) : '';
        return {
            wmId: String(i.wmId), stepId, title: i.title, why: i.why,
            ...(i.language ? { language: i.language } : {}),
            ...(source ? { source } : {}),
            ...(inputsJson && inputsJson.length <= 4000 ? { inputs: i.inputs } : {}),
        };
    });
}

function storedModules(modules: Json[], fileDefinition: Json, prepared: PreparedImport): Json[] {
    return modules.map((m) => ({ ...m, stepIds: (m.stepIds ?? []).map((id: string) => renamedIdOf(prepared.renameMap, layerOf(fileDefinition, id), id)) }));
}

export interface FlowResult {
    path: string;
    title: string;
    ok: boolean;
    automationId?: string;
    openItems?: number;
    error?: string;
    details?: unknown[];
    warnings?: unknown[];
}

export interface CommitOptions {
    select?: string[] | null;
    sourceKind: SourceKind;
    limits: WindmillLimits;
    ctx: ImportContext;
}

async function commitOne(flow: Json, conv: Conversion, opts: CommitOptions): Promise<FlowResult> {
    const base = { path: String(flow.flowPath), title: String(flow.title) };
    const envelope = structuredClone(flow.envelope) as Json;
    const fileDefinition = envelope.automation.definition as Json;
    const r = flow.report as Json;
    const { applied, leftOver } = applyRunPolicy(fileDefinition, r.suggestedRunPolicy ?? {});
    const prep = await prepareImport(envelope, opts.ctx);
    if (prep.ok === false) return { ...base, ok: false, error: prep.body.error, details: prep.body.details };
    const prepared = prep.prepared;
    const report = {
        title: base.title,
        flowPath: base.path,
        generation: conv.generations.get(base.path) ?? null,
        counts: r.counts,
        confidence: overallConfidence(r),
        modules: storedModules(r.modules ?? [], fileDefinition, prepared),
        aiChecklist: storedChecklist(r.aiChecklist ?? [], fileDefinition, prepared, opts.limits.briefPerItemChars),
        warnings: r.warnings ?? [],
        connections: r.connections ?? [],
        outboundHosts: r.outboundHosts ?? [],
        appliedRunPolicy: applied,
        suggestedRunPolicy: leftOver,
        ...(r.suggestedWebhookAuth ? { suggestedWebhookAuth: r.suggestedWebhookAuth } : {}),
        importWarnings: [...prepared.warnings, ...prepared.datatableFindings].slice(0, 100)
            .map((w) => ({ code: String((w as Json).code ?? ''), message: String((w as Json).message ?? '') })),
        notes: conv.notes,
    };
    const { insertImportReport } = nodeRequire('../../stores/automationStore') as { insertImportReport: (client: unknown, row: NewImportRow) => Promise<unknown> };
    const { withTransaction } = nodeRequire('../../db') as { withTransaction: <T>(fn: (client: any) => Promise<T>) => Promise<T> };
    const automation = await withTransaction(async (client) => {
        const a = await createPrepared(prepared, opts.ctx, { client });
        // Fingerprints of the steps as STORED, so the gate can tell what was finished since.
        report.aiChecklist = markChecklist(report.aiChecklist, a.definition);
        await insertImportReport(client, {
            orgId: opts.ctx.organizationId, userId: opts.ctx.userId, automationId: a.id,
            sourceKind: opts.sourceKind, windmillPath: base.path, windmillGeneration: report.generation, report,
        });
        return a;
    });
    // The draft is committed: an index that fails to follow it is logged, never a failed flow.
    try { await afterCreate(automation, prepared, opts.ctx); } catch (e) {
        (nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void }).warn('[automation/import/windmill] usage index not updated:', (e as Error).message);
    }
    return { ...base, ok: true, automationId: automation.id, openItems: report.aiChecklist.length, warnings: [...prepared.warnings, ...prepared.datatableFindings] };
}

/** Each selected flow in its own transaction; one that fails is reported and the batch goes on. */
export async function commitWindmill(conv: Conversion, opts: CommitOptions): Promise<FlowResult[]> {
    const wanted = opts.select?.length ? new Set(opts.select) : null;
    const chosen = conv.flows.filter((f) => (wanted ? wanted.has(String(f.flowPath)) : true));
    if (opts.limits.maxFlows > 0 && chosen.length > opts.limits.maxFlows) {
        const { HttpError } = nodeRequire('../../core/http/errors');
        throw new HttpError(400, 'import.windmill.too_many_flows', `At most ${opts.limits.maxFlows} flows can be imported at once; select fewer.`);
    }
    const out: FlowResult[] = [];
    for (const flow of chosen) {
        try {
            out.push(await commitOne(flow, conv, opts));
        } catch (e) {
            const log = nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void };
            log.warn('[automation/import/windmill] one flow did not import:', (e as Error).message);
            out.push({ path: String(flow.flowPath), title: String(flow.title), ok: false, error: 'This flow could not be imported.' });
        }
    }
    return out;
}

// ── The report of one imported automation ───────────────────────────────

export function importReportView(automation: { id: string; version?: number | null; definition?: Json | null }, row: ImportRow, limits: WindmillLimits) {
    const gate = gateState(row, automation);
    const report = row.report ?? {};
    return {
        automationId: automation.id,
        sourceKind: row.sourceKind,
        windmillPath: row.windmillPath,
        windmillGeneration: row.windmillGeneration,
        createdAt: row.createdAt,
        acknowledged: row.acknowledged,
        dryRunOkAt: row.dryRunOkAt,
        gate: { applies: gate.applies, open: gate.open, dryRunRequired: gate.dryRunRequired, cleared: !!row.clearedAt },
        report: {
            ...report,
            // The source stays in the briefing and on the canvas (note steps), not in the panel.
            aiChecklist: (report.aiChecklist ?? []).map((i: Json) => ({ wmId: i.wmId, stepId: i.stepId ?? null, title: i.title, why: i.why, ...(i.language ? { language: i.language } : {}) })),
        },
        brief: gate.open.length
            ? buildConversionBrief({ ...report, aiChecklist: (report.aiChecklist ?? []).filter((i: Json) => gate.open.some((o) => o.wmId === i.wmId)) }, { perItemChars: limits.briefPerItemChars, totalChars: limits.briefTotalChars })
            : null,
    };
}
