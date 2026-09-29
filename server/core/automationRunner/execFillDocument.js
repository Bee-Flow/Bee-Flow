/**
 * fill_document step: take a Document the person DESIGNED in Studio, fill its
 * placeholders with this run's values, and keep the PDF.
 *
 * THE DIFFERENCE WITH generate_document, because picking the wrong one is the
 * likely mistake: `generate_document` turns TEXT into a file — a summary, a
 * report, whatever an AI step just wrote — and the layout is the renderer's
 * standard one. `fill_document` renders a DESIGNED artefact: the invoice, the
 * quote, the letter on letterhead that somebody laid out by hand in the
 * Documents editor and that must come out identical every single time. Text in
 * → generate_document. A form to fill → fill_document.
 *
 * WHAT IT PRODUCES is deliberately the same shape as generate_document's
 * output — `{ fileId, filename, mimeType, size, ... }` — because everything
 * downstream (an email attachment, an approval attachment, a form page's
 * download field) already accepts exactly that. A second file shape would have
 * meant teaching all of them a second one.
 *
 * WHOSE DOCUMENT. documentStore.getDocument is owner-scoped, and the owner
 * here is the routine's owner (`ctx.userId`) — the same identity the rest of
 * the run acts as. A template id belonging to somebody else is simply not
 * found, which is the behaviour every other owner-scoped read in this codebase
 * has: a 404, never a 403 that confirms the id exists.
 */

const crypto = require('crypto');
const automationStore = require('../../stores/automationStore');
const { interpolateTemplate, resolveValue, walkPath } = require('../../automation/bind');
const { renderFilledDocument, documentFileName } = require('../documents/renderFilledDocument');
const { resolveDocumentMarking, markingOutcome } = require('./execDocument');
const log = require('../../telemetry/log');

// The same ceilings generate_document uses — one idea of "a file a run may
// keep", not two.
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const TTL_MIN_DAYS = 1;
const TTL_MAX_DAYS = 90;
const TTL_DEFAULT_DAYS = 7;

// A template with more holes than this is not a document being filled, it is a
// dataset being printed — and every hole costs a binding resolution.
const MAX_VALUES = 200;

/** A string that is exactly one `{{path}}` and nothing else. */
const SOLE_TOKEN_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/**
 * Resolve one bound value for a placeholder.
 *
 * THE RULE THAT MATTERS: a field whose whole value is a single `{{path}}`
 * resolves to the REAL value at that path — an array stays an array, a number
 * stays a number. Anything else is interpolated into a string, as every other
 * step's text field is.
 *
 * Without that rule a list could not be bound at all: `interpolateTemplate`
 * JSON-stringifies an array, so `{{#each lines}}` would receive the text
 * `[{"description":…}]` and render nothing — the failure looks like "the
 * template is broken" and is actually "the binding was flattened on the way
 * in". Mixed text ("Factuur {{steps.x.output.number}}") keeps its old
 * behaviour because there is only one sensible reading of it.
 */
function resolveBoundValue(raw, runState) {
    if (raw === null || raw === undefined) return raw;
    if (typeof raw === 'object') return resolveValue(raw, runState);
    if (typeof raw !== 'string') return raw;
    const sole = SOLE_TOKEN_RE.exec(raw);
    if (sole) {
        const v = walkPath(sole[1], runState);
        return v === undefined ? undefined : v;
    }
    return interpolateTemplate(raw, runState);
}

/**
 * The values map, resolved.
 *
 * Keys are placeholder paths as they appear in the template
 * (`customer.name`, `lines`), so the map is flat and reads like the document.
 * A dotted key is expanded into the nested object the filler looks up, which
 * is what lets `{{customer.name}}` and `{{customer.city}}` be bound as two
 * separate fields in the editor instead of as one JSON blob.
 */
function buildValues(rawValues, runState) {
    const out = {};
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) return out;
    if (Object.keys(rawValues).length > MAX_VALUES) throw new Error('Too many document values');
    const keys = Object.keys(rawValues);
    for (const key of keys) {
        const value = resolveBoundValue(rawValues[key], runState);
        if (value === undefined) continue;          // let the filler report the hole
        if (!require('../documents/documentContract').safePath(key)) throw new Error('Unsafe document parameter path');
        const parts = String(key).split('.').filter(Boolean);
        if (!parts.length) continue;
        let cur = out;
        for (let i = 0; i < parts.length - 1; i++) {
            // A key that collides with a scalar already written (`customer`
            // and `customer.name` both bound) loses the scalar rather than
            // throwing: the deeper binding is the more specific intent.
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
    }
    return out;
}

/** What the run log says about the holes — names only, never the values. */
function fillReport(fill) {
    return {
        missing: fill.missing,
        sections: fill.sections,
        validation: fill.issues,
        notLists: fill.notLists,
        ...(fill.truncated.length ? { truncated: fill.truncated } : {}),
        ...(fill.tooDeep.length ? { tooDeep: fill.tooDeep } : {}),
        ...(fill.errors.length ? { templateErrors: fill.errors } : {}),
    };
}

async function execFillDocument(step, ctx, runState, mode) {
    const documentId = String(step.documentId || '').trim();
    if (!documentId) {
        throw Object.assign(
            new Error('fill_document: no document is selected, so there is nothing to fill.'),
            { errorClass: 'document_missing' },
        );
    }

    const values = buildValues(step.values, runState);
    const nameBinding = interpolateTemplate(step.fileName || '', runState).trim();

    const days = Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : TTL_DEFAULT_DAYS;
    const ttlDays = Math.min(TTL_MAX_DAYS, Math.max(TTL_MIN_DAYS, Math.round(days)));

    const documentStore = require('../../stores/documentStore');
    const doc = await documentStore.getDocumentVersion(documentId, ctx.userId, step.documentVersionId);
    if (!doc) {
        throw Object.assign(
            new Error('fill_document: that document does not exist, or it belongs to someone else.'),
            { errorClass: 'document_not_found' },
        );
    }

    // A presentation document renders as a real .pptx unless the step asks
    // for the PDF deck; a page document is always a PDF.
    const isDeck = doc.docType === 'presentation';
    const format = isDeck ? (step.format === 'pdf' ? 'pdf' : 'pptx') : 'pdf';
    const filename = documentFileName(nameBinding || doc.name, 'document', format);
    const mimeType = format === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf';

    // A dry run proves the wiring without rendering, storing or billing
    // anything — but it DOES fill the template, because "which placeholders
    // have no binding" is exactly what a dry run is for. The shape is the live
    // shape so downstream bindings resolve identically.
    if (mode === 'dry_run') {
        const { prepareDocument, assertFinal } = require('../documents/documentContract');
        const fill = prepareDocument(doc, values, step.sectionOverrides);
        assertFinal(fill);
        return {
            output: {
                fileId: 'dry-run', filename, mimeType, size: 0, format,
                documentId: doc.id,
            documentVersionId: doc.versionId, documentName: doc.name,
                degraded: false, marked: false, marking: markingOutcome(null, null),
                sourceHandle: { kind: 'generated_file', fileId: 'dry-run' },
                ...fillReport(fill),
                _dryRun: true,
            },
            dryRunSynthesised: true,
        };
    }

    const storageStore = require('../../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        throw Object.assign(
            new Error('fill_document: file storage is not available, so the document cannot be kept.'),
            { errorClass: 'storage_unavailable' },
        );
    }

    const marking = await resolveDocumentMarking(step, ctx, runState, 'fill_document');

    const { buffer, contentType, degraded, marking: markingResult, fill, slideCount } = await renderFilledDocument({
        document: doc,
        sectionOverrides: step.sectionOverrides,
        values,
        orgId: (ctx && (ctx.orgId || ctx.userHomeOrgId)) || null,
        marking,
        format,
        // A slide's picture is a storage reference the owner may read.
        resolveImage: isDeck ? require('../../services/presentationRenderer').makeUserImageResolver(ctx.userId) : null,
    });

    const outcome = markingOutcome(marking, markingResult);
    if (outcome.requested && !outcome.visible) {
        log.warn(`[fill_document] ${step.id}: AI content marking was resolved but the renderer printed no marking line — the document is NOT marked.`);
    }

    if (buffer.length > MAX_DOCUMENT_BYTES) {
        throw Object.assign(
            new Error(`fill_document: the document is ${Math.round(buffer.length / 1048576)} MB; the limit is ${MAX_DOCUMENT_BYTES / 1048576} MB.`),
            { errorClass: 'document_too_large' },
        );
    }

    // Content-addressed, like every other generated file: the same invoice
    // rendered twice costs one object.
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = storageStore.buildAutomationFileKey(ctx.userId, ctx.automationId, sha);
    await storageStore.uploadFile(key, buffer, contentType);

    const row = await automationStore.recordGeneratedFile({
        runId: ctx.runId,
        automationId: ctx.automationId,
        stepId: step.id,
        storageKey: key,
        filename,
        mimeType: contentType,
        size: buffer.length,
        ttlMs: ttlDays * 24 * 60 * 60 * 1000,
    });

    // Optionally keep the FILLED document in the library as its own document,
    // so a person can correct a line by hand before it goes out. Off by
    // default: a routine that runs nightly would otherwise mint a document a
    // day forever. A failure here never fails the step — the PDF, which is
    // what the rest of the run uses, already exists.
    let savedCopy = null;
    if (step.saveCopy) {
        try {
            const copyName = interpolateTemplate(step.copyName || '', runState).trim()
                || `${doc.name} — ${new Date().toISOString().slice(0, 10)}`;
            const copy = await documentStore.createDocument({
                userId: ctx.userId,
                name: copyName.slice(0, 200),
                docType: doc.docType,
                description: `Filled in by the routine on ${new Date().toISOString().slice(0, 10)}.`,
                // For a presentation the filled OUTLINE is what is kept, so the
                // copy opens as slides and can still be edited.
                bodyHtml: fill.bodyHtml,
                css: doc.css,
                settings: { ...doc.settings, generatedFrom: { documentId: doc.id, versionId: doc.versionId }, contract: { instructions: '', parameters: [], sections: [] }, sampleValues: {}, sectionOverrides: {} },
            });
            savedCopy = { documentId: copy.id, url: `/app/studio/documents/${copy.id}` };
        } catch (e) {
            log.warn(`[fill_document] ${step.id}: the filled copy could not be saved: ${e.message}`);
        }
    }

    if (degraded) {
        log.warn(`[fill_document] ${step.id}: rendered without a browser — the PDF uses the plain fallback layout, so the document's own styling is lost.`);
    }

    return {
        output: {
            fileId: row.id,
            filename,
            mimeType: contentType,
            size: buffer.length,
            format,
            ...(isDeck ? { slideCount: slideCount || 0 } : {}),
            // Which template this came from, so a run log answers "which
            // invoice layout did this go out on" without a second lookup.
            documentId: doc.id,
            documentVersionId: doc.versionId,
            documentName: doc.name,
            // True when no headless browser was reachable. It matters MORE
            // here than for generate_document: the fallback renderer ignores
            // the document's stylesheet, so a degraded invoice is a plain one.
            degraded,
            marked: outcome.visible && outcome.metadata,
            marking: outcome,
            // The handle nextcloud_upload_file / drive_upload_file take to push this file on.
            sourceHandle: { kind: 'generated_file', fileId: row.id },
            // Names of the placeholders that had nothing to fill them, never
            // the values — a run log is not a place for customer data.
            ...fillReport(fill),
            ...(savedCopy ? { savedDocumentId: savedCopy.documentId, savedDocumentUrl: savedCopy.url } : {}),
        },
    };
}

module.exports = {
    MAX_DOCUMENT_BYTES, TTL_MIN_DAYS, TTL_MAX_DAYS, TTL_DEFAULT_DAYS, MAX_VALUES,
    execFillDocument,
    _test: { buildValues, resolveBoundValue, fillReport },
};
