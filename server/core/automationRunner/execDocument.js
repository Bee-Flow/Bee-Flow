/**
 * generate_document step (extracted verbatim from engine.js): renders a
 * PDF/Word document from upstream text and records it in the run's file
 * ledger.
 */

const crypto = require('crypto');
const automationStore = require('../../stores/automationStore');
const { interpolateTemplate } = require('../../automation/bind');
const automationGraph = require('../../automation/automationGraph');
const { deckThemeFor } = require('../documents/documentHouseStyle');
const log = require('../../telemetry/log');

// ── AI content marking (EU AI Act Art. 50(2)) ──────────────────────────────
//
// A document that carries model output is marked — visible footer + file
// metadata — when the org has switched marking on. "Carries model output" is
// decided here, per run, from two signals: an AI step (ai_step |
// data_extraction | ai_tool; summarize is an aggregate, not AI) that EXECUTED
// earlier in this run, or a content/title/fileName template that reads
// `steps.<aiStepId>`. The second catches a reference the run order would miss
// (a pinned output, a step in another branch); the first catches an indirect
// reference through a set/aggregate step. Either is enough — an unmarked
// AI document is the compliance failure, an over-marked one is a footer.
// The org's on/off switch is the compliance feature's business: it registers
// a resolver on ./documentMarking.js at boot, and nothing here names it.

const EXECUTED_STATUSES = new Set(['success', 'pinned']);

/** The automation definition for this run: ctx carries it; a bare ctx loads it once. */
async function definitionFor(ctx) {
    if (ctx && ctx.definition && typeof ctx.definition === 'object') return ctx.definition;
    if (ctx && ctx._markingDefinition) return ctx._markingDefinition;
    if (!ctx || !ctx.automationId) return null;
    try {
        const automation = await automationStore.getAutomation(ctx.automationId);
        const def = automation && automation.definition && typeof automation.definition === 'object' ? automation.definition : null;
        if (def) ctx._markingDefinition = def;
        return def;
    } catch {
        return null;
    }
}

/** A best-effort provider label for the metadata: the step's own model/provider hint, else its recorded output. */
function providerHint(aiStep, recorded) {
    const out = recorded && recorded.output && typeof recorded.output === 'object' ? recorded.output : null;
    const candidates = [
        aiStep && (aiStep.provider || aiStep.providerType),
        out && (out.provider || out.providerType),
        aiStep && typeof aiStep.model === 'string' ? aiStep.model.split(/[/:]/)[0] : null,
        out && typeof out.model === 'string' ? out.model.split(/[/:]/)[0] : null,
    ];
    const hit = candidates.find(c => typeof c === 'string' && c.trim());
    return hit ? hit.trim().toLowerCase() : null;
}

/**
 * The AI steps this document draws on, or null when there are none:
 * `{ aiStepIds, provider }`. Pure apart from the definition load.
 */
async function resolveAiUpstream(step, ctx, runState) {
    const def = await definitionFor(ctx);
    if (!def) return null;
    const aiById = new Map();
    automationGraph.walkSteps(def, (s) => { if (automationGraph.isAiStep(s) && s.id) aiById.set(s.id, s); });
    if (!aiById.size) return null;

    const ids = [];
    // 1. Template references — the graph helper's 'reference' signal for THIS step.
    for (const g of automationGraph.generatingStepsDownstreamOfAi(def)) {
        if (g.step && g.step.id === step.id && g.signal === 'reference') {
            for (const id of g.aiStepIds) if (!ids.includes(id)) ids.push(id);
        }
    }
    // 2. AI steps that produced output earlier in this run.
    const recorded = runState && runState.steps && typeof runState.steps === 'object' ? runState.steps : {};
    for (const [id, rec] of Object.entries(recorded)) {
        if (!aiById.has(id) || !rec || !EXECUTED_STATUSES.has(rec.status)) continue;
        if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return null;

    let provider = null;
    for (const id of ids) {
        provider = providerHint(aiById.get(id), recorded[id]);
        if (provider) break;
    }
    return { aiStepIds: ids, provider };
}

function orgOf(ctx) {
    return (ctx && (ctx.orgId || ctx.userHomeOrgId)) || null;
}

/**
 * What the run log records about the marking: booleans only.
 *
 * `requested` is the org's policy answer (a marking object came back from the
 * port), `visible`/`metadata` are documentRenderer's report of what it put in
 * the file. They differ: the renderer drops a marking with an empty footer
 * line, and returns metadata:false when pdf-lib cannot be loaded. Recording
 * the request as if it were the result puts an unmarked PDF in the run history
 * as an AI-marked one — the one thing an Art. 50(2) audit must not find.
 *
 * BFSF-441: an explicit allow-list of three booleans. The marking object
 * itself carries the org name and the footer sentence; neither belongs in a
 * run log.
 *
 * @param {object|null} marking resolved marking (what was asked for)
 * @param {{visible?: boolean, metadata?: boolean}|null} result documentRenderer's `marking`
 */
function markingOutcome(marking, result) {
    return {
        requested: !!marking,
        visible: !!(result && result.visible),
        metadata: !!(result && result.metadata),
    };
}

/**
 * The AI-content marking this document must carry, or null.
 *
 * Shared by both document steps — `generate_document`, which renders text into
 * a file, and `fill_document`, which fills a designed template. They differ in
 * everything except this: whether model output went into the artefact is the
 * same question with the same answer, and Art. 50(2) is not a rule one of them
 * gets to interpret differently.
 *
 * A failure to RESOLVE the marking never fails the document — the render goes
 * ahead unmarked and says so in the log. What must not happen is the opposite:
 * silently recording an unmarked file as marked, which `markingOutcome` above
 * is what prevents.
 */
async function resolveDocumentMarking(step, ctx, runState, stepLabel) {
    try {
        const aiUpstream = await resolveAiUpstream(step, ctx, runState);
        if (!aiUpstream) return null;
        const { resolveMarking } = require('./documentMarking');
        return await resolveMarking(orgOf(ctx), {
            automationId: ctx.automationId || null,
            aiStepIds: aiUpstream.aiStepIds,
            provider: aiUpstream.provider,
        });
    } catch (e) {
        log.warn(`[${stepLabel}] ${step.id}: could not resolve AI content marking, rendering unmarked: ${e.message}`);
        return null;
    }
}

// ── generate_document ───────────────────────────────────────────────────────

// A generated document is something a person opens, not a data export. 25 MB is
// already a very large report and bounds what one run can push into storage.
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
// How long the file stays fetchable. Bounded at both ends on purpose: 0 would
// make the step pointless, and "forever" is not a thing a privacy product hands
// out on an anonymously-reachable URL.
const DOCUMENT_TTL_MIN_DAYS = 1;
const DOCUMENT_TTL_MAX_DAYS = 90;
const DOCUMENT_TTL_DEFAULT_DAYS = 7;

/**
 * Turn whatever the author bound into a name that is safe as a filename and as
 * a `Content-Disposition` value. Everything outside a conservative set goes,
 * because this string ends up in an HTTP header: a stray quote or newline there
 * is a header-injection bug, not a cosmetic one.
 */
function safeDocumentName(raw, fallback = 'document') {
    const cleaned = String(raw || '')
        .normalize('NFKD')
        .replace(/[\x00-\x1f\x7f]/g, '')      // control chars, CR/LF included
        .replace(/[\\/:*?"<>|]/g, ' ')              // reserved on Windows + quotes
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')                        // no leading dots (hidden / traversal-ish)
        .slice(0, 120)
        .trim();
    return cleaned || fallback;
}

/**
 * Render a PDF or Word document from upstream text and keep it for the visitor.
 *
 * The step does NOT return a URL. The only place this file can be fetched is a
 * form page belonging to the same journey, and that route builds its own
 * session-scoped URL when the page is served — a URL minted here would either
 * have to be a bearer token (a second, weaker credential) or would be wrong the
 * moment the visitor's session changed.
 */
async function execGenerateDocument(step, ctx, runState, mode) {
    const { renderDocument, FORMATS, CONTENT_TYPES } = require('../../services/documentRenderer');

    const content = interpolateTemplate(step.content || '', runState);
    const title = interpolateTemplate(step.title || '', runState).trim();
    const nameBinding = interpolateTemplate(step.fileName || '', runState);
    const format = FORMATS.includes(step.format) ? step.format : 'pdf';
    const contentFormat = step.contentFormat === 'html' ? 'html' : 'markdown';
    // 'slides' renders the PDF as a landscape deck (cover from the h1, one
    // slide per h2). Anything else — including absent, which is every
    // pre-existing step — is the linear document.
    const layout = step.layout === 'slides' ? 'slides' : 'document';

    const days = Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : DOCUMENT_TTL_DEFAULT_DAYS;
    const ttlDays = Math.min(DOCUMENT_TTL_MAX_DAYS, Math.max(DOCUMENT_TTL_MIN_DAYS, Math.round(days)));

    const base = safeDocumentName(nameBinding || title, 'document');
    const filename = `${base}.${format}`;
    const mimeType = CONTENT_TYPES[format];

    // A dry-run must not render, store or bill anything — it exists to prove
    // the wiring. The shape it returns is exactly the live shape so downstream
    // bindings resolve identically.
    if (mode === 'dry_run') {
        return {
            output: {
                fileId: 'dry-run', filename, mimeType, size: 0, format, degraded: false,
                marked: false, marking: markingOutcome(null, null),
                sourceHandle: { kind: 'generated_file', fileId: 'dry-run' },
                _dryRun: true,
            },
            dryRunSynthesised: true,
        };
    }

    const storageStore = require('../../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        throw Object.assign(
            new Error('generate_document: file storage is not available, so the document cannot be kept.'),
            { errorClass: 'storage_unavailable' },
        );
    }

    // Art. 50(2): mark the file when model output went into it and the org
    // marks.
    const marking = await resolveDocumentMarking(step, ctx, runState, 'generate_document');

    // The deck layout is painted in the org's house style (band colour, brand
    // mark, logo); a linear document carries its own styling in the content.
    const theme = layout === 'slides' ? await deckThemeFor(orgOf(ctx)) : null;

    const { buffer, contentType, degraded, marking: markingResult } = await renderDocument({ content, contentFormat, title, format, layout, marking, theme });

    // What the FILE carries, not what the policy resolved to. The renderer
    // DROPS a marking whose footer line is empty (and one switched off), and
    // reports metadata:false when the PDF Info pass could not run — in both
    // cases the resolved `marking` above is still truthy. The run log is the
    // evidence an Art. 50(2) audit reads, so it records what came back.
    const outcome = markingOutcome(marking, markingResult);
    if (outcome.requested && !outcome.visible) {
        log.warn(`[generate_document] ${step.id}: AI content marking was resolved but the renderer printed no marking line — the document is NOT marked.`);
    } else if (outcome.requested && !outcome.metadata) {
        log.warn(`[generate_document] ${step.id}: AI marking footer printed but the file metadata could not be written (pdf-lib unavailable).`);
    }

    const row = await keepGeneratedFile({ ctx, step, buffer, contentType, filename, ttlDays, stepLabel: 'generate_document' });

    if (degraded) {
        log.warn(`[generate_document] ${step.id}: rendered without a browser — the PDF uses the plain fallback layout.`);
    }

    return {
        output: {
            fileId: row.id,
            filename,
            mimeType: contentType,
            size: buffer.length,
            format,
            // True when no headless browser was reachable and the plain pdfkit
            // layout was used. Surfaced so "why does this PDF look basic?" is
            // answerable from the run log rather than a mystery.
            degraded,
            // True only when the file actually carries the whole Art. 50(2)
            // AI-content marking: the visible line AND the machine-readable
            // file metadata. A footer without metadata is not a marked
            // document for Art. 50(2) purposes, so it reads false here and
            // `marking` below says which half landed.
            marked: outcome.visible && outcome.metadata,
            marking: outcome,
            // The handle nextcloud_upload_file / drive_upload_file take to push
            // this file on (sourceHandle:{kind:"ref",path:"steps.<id>.output.sourceHandle"}).
            sourceHandle: { kind: 'generated_file', fileId: row.id },
        },
    };
}

/**
 * Keep a rendered file for the run: the size gate, the content-addressed
 * storage object and the ledger row. Shared by every step that produces a
 * file (generate_document, fill_document, presentation) so the three agree
 * on what "kept" means — one cap, one key scheme, one TTL clamp.
 *
 * @returns {Promise<object>} the automation_generated_files row
 */
async function keepGeneratedFile({ ctx, step, buffer, contentType, filename, ttlDays, stepLabel = 'generate_document' }) {
    if (buffer.length > MAX_DOCUMENT_BYTES) {
        throw Object.assign(
            new Error(`${stepLabel}: the document is ${Math.round(buffer.length / 1048576)} MB; the limit is ${MAX_DOCUMENT_BYTES / 1048576} MB.`),
            { errorClass: 'document_too_large' },
        );
    }
    const storageStore = require('../../stores/storageStore');
    // Content-addressed: the same document rendered twice costs one object.
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = storageStore.buildAutomationFileKey(ctx.userId, ctx.automationId, sha);
    await storageStore.uploadFile(key, buffer, contentType);

    const days = Math.min(DOCUMENT_TTL_MAX_DAYS, Math.max(DOCUMENT_TTL_MIN_DAYS, Math.round(Number(ttlDays) || DOCUMENT_TTL_DEFAULT_DAYS)));
    return automationStore.recordGeneratedFile({
        runId: ctx.runId,
        automationId: ctx.automationId,
        stepId: step.id,
        storageKey: key,
        filename,
        mimeType: contentType,
        size: buffer.length,
        ttlMs: days * 24 * 60 * 60 * 1000,
    });
}

module.exports = {
    MAX_DOCUMENT_BYTES, DOCUMENT_TTL_MIN_DAYS, DOCUMENT_TTL_MAX_DAYS, DOCUMENT_TTL_DEFAULT_DAYS,
    safeDocumentName, execGenerateDocument, keepGeneratedFile,
    resolveDocumentMarking, markingOutcome, orgOf,
    _marking: { resolveAiUpstream, definitionFor, providerHint, orgOf, markingOutcome },
};
