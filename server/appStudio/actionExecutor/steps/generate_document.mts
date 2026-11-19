/**
 * The executor of the `generate_document` step (componentSpecs/steps/generate_document.js): the
 * app's own markdown (or HTML) in, a PDF or Word file out, kept as an app attachment.
 *
 *   1. The bindings (`content`, `title`, `fileName`) resolved by the server walk. A content that
 *      resolves to an ai_generate result ({ text, citations }) is read as its text.
 *   2. The AI content marking, only when the author says the content is model output
 *      (`aiGenerated: true`): the same port the automation step and the chat Word tool ask
 *      (core/automationRunner/documentMarking.js, answered by the compliance feature), for the
 *      app OWNER's organisation. A failure to resolve it renders unmarked and says so in the log.
 *   3. The render: core/documents/render/documentRenderer.js renderDocument, the one the
 *      automation step uses (its content cap, sanitiser, browser PDF with the pdfkit fallback
 *      flagged `degraded`, and the marking contract). A Word file wears the owner organisation's
 *      Word house style unless `houseStyle: false`, as the chat Word tool does.
 *   4. The tail every file step shares (shared.js storeStudioAttachment): size gate, quota, blob,
 *      malware scan, ledger row honouring attachToRecordId + attachToFieldKey.
 *
 * The result records what the FILE carries (`marking` from the renderer), never what was asked:
 * an unmarked file recorded as marked is the failure an Art. 50(2) audit must not find.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type StepFailure = { ok: false; error: string; code?: string; retryable?: boolean };
type StepSuccess = { ok: true; result: unknown };
type MarkingResult = { visible: boolean; metadata: boolean } | null;
type Rendered = { buffer: Buffer; contentType: string; degraded: boolean; marking: MarkingResult };
type RenderInput = {
    content: string; contentFormat: string; title: string; format: string;
    marking: object | null; docxStyle: unknown;
};
type StoreInput = { app: App; step: Obj; ctx: Obj; buffer: Buffer; contentType: string; fileName: string; extra: Obj };
type Log = { warn: (msg: string) => void };

export type GenerateDocumentDeps = {
    resolve: (binding: unknown, ctx: Obj) => unknown;
    render: (input: RenderInput) => Promise<Rendered>;
    resolveMarking: (orgId: string | null) => Promise<object | null>;
    docxStyle: (orgId: string | null) => Promise<unknown>;
    store: (input: StoreInput) => Promise<StepSuccess | StepFailure>;
    log: Log;
};

type SharedModule = {
    buildServerScope: (c: Obj) => unknown;
    resolveBinding: (b: unknown, c: Obj, s: unknown) => unknown;
    storeStudioAttachment: (input: StoreInput & { scope: unknown }) => Promise<StepSuccess | StepFailure>;
};
type DocxHouseStyle = {
    resolveHouseStyle: (orgId: string, id: null) => Promise<unknown>;
    buildDocxStylingFromHouseStyle: (style: unknown) => unknown;
    NO_SUCH_STYLE: unknown;
};

function defaultDeps(): GenerateDocumentDeps {
    const shared = () => nodeRequire('../shared.js') as SharedModule;
    const log = nodeRequire('../../../telemetry/log.js') as Log;
    return {
        resolve: (binding, ctx) => shared().resolveBinding(binding, ctx, shared().buildServerScope(ctx)),
        render: (input) => (nodeRequire('../../../core/documents/render/documentRenderer.js') as {
            renderDocument: (i: RenderInput) => Promise<Rendered>;
        }).renderDocument(input),
        resolveMarking: (orgId) => (nodeRequire('../../../core/automationRunner/documentMarking.js') as {
            resolveMarking: (o: string | null, info: Obj) => Promise<object | null>;
        }).resolveMarking(orgId, { automationId: null, aiStepIds: [], provider: null }),
        docxStyle: async (orgId) => {
            if (!orgId) return null;
            const hs = nodeRequire('../../../core/documents/docxHouseStyle.js') as DocxHouseStyle;
            const style = await hs.resolveHouseStyle(orgId, null);
            return style && style !== hs.NO_SUCH_STYLE ? hs.buildDocxStylingFromHouseStyle(style) : null;
        },
        store: (input) => shared().storeStudioAttachment({ ...input, scope: shared().buildServerScope(input.ctx) }),
        log,
    };
}

const FORMATS = ['pdf', 'docx'];

/** Safe as a download attribute, a Content-Disposition value and a MIME header. */
export function documentFileName(raw: unknown, fallback: string): string {
    const flat = String(raw ?? '').replace(/[/\\\r\n\0"<>|?*:;]/g, '').trim().replace(/\.(pdf|docx)$/i, '').trim().slice(0, 120);
    return flat || fallback;
}

/** The text of a resolved `content`: a string, a number, or an ai_generate result's `text`. */
function contentText(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (v && typeof v === 'object' && typeof (v as Obj).text === 'string') return (v as Obj).text as string;
    return undefined;
}

function plain(v: unknown): string {
    const t = contentText(v);
    return t === undefined ? '' : t.trim();
}

async function markingFor(app: App, step: Obj, ctx: Obj, deps: GenerateDocumentDeps): Promise<object | null> {
    if (step.aiGenerated !== true) return null;
    try {
        return await deps.resolveMarking(app.organizationId || (typeof ctx.orgId === 'string' ? ctx.orgId : null) || null);
    } catch (e) {
        deps.log.warn(`[generate_document] app ${app.id}: could not resolve AI content marking, rendering unmarked: ${(e as Error).message}`);
        return null;
    }
}

async function docxStyleFor(app: App, step: Obj, format: string, deps: GenerateDocumentDeps): Promise<unknown> {
    if (format !== 'docx' || step.houseStyle === false) return null;
    try {
        return await deps.docxStyle(app.organizationId || null);
    } catch (e) {
        deps.log.warn(`[generate_document] app ${app.id}: Word house style unavailable, rendering neutral: ${(e as Error).message}`);
        return null;
    }
}

/** What the step asks the renderer for, from its fields; null when `content` gave no text. */
function renderInputOf(step: Obj, ctx: Obj, deps: GenerateDocumentDeps): Omit<RenderInput, 'marking' | 'docxStyle'> | null {
    const content = contentText(deps.resolve(step.content, ctx));
    if (content === undefined) return null;
    return {
        content,
        contentFormat: step.contentFormat === 'html' ? 'html' : 'markdown',
        title: plain(deps.resolve(step.title, ctx)).slice(0, 200),
        format: typeof step.format === 'string' && FORMATS.includes(step.format) ? step.format : 'pdf',
    };
}

/** The renderer's answer, or the step failure its refusal (an `errorClass`) becomes. */
async function renderOrRefuse(input: RenderInput, deps: GenerateDocumentDeps): Promise<Rendered | StepFailure> {
    try {
        return await deps.render(input);
    } catch (e) {
        const errorClass = (e as { errorClass?: unknown })?.errorClass;
        if (typeof errorClass === 'string') return { ok: false, error: (e as Error).message, code: errorClass };
        throw e;
    }
}

export async function runGenerateDocument(app: App, step: Obj, ctx: Obj, deps: GenerateDocumentDeps = defaultDeps()): Promise<StepSuccess | StepFailure> {
    const base = renderInputOf(step, ctx, deps);
    if (!base) return { ok: false, error: 'The generate_document step needs text in `content`; the binding gave none.', code: 'document_empty' };
    const marking = await markingFor(app, step, ctx, deps);
    const docxStyle = await docxStyleFor(app, step, base.format, deps);
    const rendered = await renderOrRefuse({ ...base, marking, docxStyle }, deps);
    if ('ok' in rendered) return rendered;

    const outcome = { requested: !!marking, visible: !!rendered.marking?.visible, metadata: !!rendered.marking?.metadata };
    if (outcome.requested && !outcome.visible) {
        deps.log.warn(`[generate_document] app ${app.id}: AI content marking was resolved but the renderer printed no marking line — the document is NOT marked.`);
    }
    const fileName = `${documentFileName(plain(deps.resolve(step.fileName, ctx)) || base.title, 'document')}.${base.format}`;
    const stored = await deps.store({
        app, step, ctx, buffer: rendered.buffer, contentType: rendered.contentType, fileName,
        extra: {
            format: base.format,
            // True only when the file carries the whole marking: the visible line AND the metadata.
            marked: outcome.visible && outcome.metadata,
            marking: outcome,
            ...(rendered.degraded ? { degraded: true } : {}),
        },
    });
    if (stored.ok && rendered.degraded) {
        deps.log.warn(`[generate_document] app ${app.id}: rendered without a browser — the PDF uses the plain fallback layout.`);
    }
    return stored;
}

/** The registry's executor entry (dispatch.js fileStepHandler). */
export async function runStep(app: App, _model: unknown, step: Obj, ctx: Obj): Promise<StepSuccess | StepFailure> {
    return runGenerateDocument(app, step ?? {}, ctx ?? {});
}
