/**
 * App Studio action executor — redact_pdf: a PDF in, a copy without the marks
 * that identify a person or the customer out.
 *
 * A sibling of generate_file / fill_document / generate_presentation: same
 * storage tail (shared.js storeStudioAttachment), same `studio_attachment`
 * descriptor, so file_preview, download_file and send_email.attachments take
 * the cleaned file as is. The descriptor also carries `removed`, the list of
 * what went, because a person should see that before the file goes anywhere.
 *
 * The rules in core/documents/pdfRedaction find contact details, the value next
 * to an Author/Checked label and the customer's logo. They cannot know that
 * "Jan de Vries" on a notes line is a person; the optional AI pass can. It sees
 * the text runs only (never the file), answers with run references, and may
 * only flag runs that contain words: a model can never take a dimension off a
 * drawing.
 */

'use strict';

const { buildServerScope, resolveBinding, storeStudioAttachment } = require('./shared');
const log = require('../../telemetry/log');

const MAX_REMOVED_LISTED = 100; // the result rides in every later step's body
const AI_CATEGORIES = ['person', 'company', 'contact', 'address'];
const CATEGORY_LABELS = { person: 'Person', company: 'Company', contact: 'Contact details', address: 'Address', logo: 'Logo' };

const AI_SYSTEM = `You help remove identifying information from a document before it is sent to a third party (for example a technical drawing going to a supplier).
You get the document's text runs, one per line: "ref | position on the page | text".
Flag every run that identifies a PERSON or the COMPANY that owns or ordered the document:
- names and initials of people (e.g. the value next to Author, Drawn, Checked, Approved, Contact)
- company names, brand names and ownership or copyright notices that name the company
- addresses, phone numbers, e-mail addresses, websites
Never flag technical content: dimensions, tolerances, materials, finishes, part names and descriptions, standards (ISO, DIN), drawing numbers, article numbers, project numbers, order numbers, dates, scales, generic labels such as "Author" or "Date" themselves.
When unsure whether something is technical, leave it.`;

/** Safe as a download attribute, a Content-Disposition value and a MIME header. */
function sanitizeFileName(name, fallback) {
    const flat = String(name == null ? '' : name).replace(/[/\\\r\n\0"<>|?*:;]/g, '').replace(/\.pdf$/i, '').trim().slice(0, 120);
    return flat || fallback;
}

/** `terms` binding → list: a comma/semicolon/newline separated string or an array. */
function parseTerms(value) {
    const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,;\n]/);
    return list.map((t) => String(t == null ? '' : t).trim()).filter((t) => t.length >= 3).slice(0, 50);
}

/**
 * Ask the owner's model which text runs identify someone. Returns `{ marks, warning }`;
 * never throws, because the rules alone still produce a useful, safe result.
 * `aiRuntime` is a parameter so tests can hand in a fake model.
 */
async function aiMarks(app, runs, terms, aiRuntime = require('../aiRuntime')) {
    if (!runs.length) return { marks: [] };
    let model;
    try {
        model = await aiRuntime.resolveOwnerModel(app, 'fast');
    } catch (e) {
        return { marks: [], warning: 'The AI check was skipped: no AI model is configured.' };
    }
    const lines = runs.map((r) => `${r.ref} | ${r.position} | ${r.text.replace(/\s+/g, ' ')}`).join('\n');
    const user = (terms.length ? `The customer is also known as: ${terms.join(', ')}.\n\n` : '') + `Text runs:\n${lines}`;
    const parameters = {
        type: 'object',
        properties: {
            remove: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { ref: { type: 'string' }, category: { type: 'string', enum: AI_CATEGORIES } },
                    required: ['ref', 'category'],
                    additionalProperties: false,
                },
            },
        },
        required: ['remove'],
        additionalProperties: false,
    };
    let structured;
    try {
        ({ structured } = await aiRuntime.runStructured(app, model, {
            system: AI_SYSTEM, user, parameters, toolName: 'flag_identifying_text',
            toolDescription: 'List the text runs that identify a person or the owning company.',
        }));
    } catch (e) {
        log.warn(`[redact_pdf] app ${app.id}: AI check failed: ${e && e.message}`);
        return { marks: [], warning: 'The AI check failed, so only the built-in rules were applied.' };
    }
    const byRef = new Map(runs.map((r) => [r.ref, r]));
    const marks = [];
    for (const item of Array.isArray(structured && structured.remove) ? structured.remove : []) {
        const run = item && byRef.get(String(item.ref));
        // Only runs with words in them: a model may flag "JDO", never "45°" or "14-07-2026".
        if (!run || (run.text.match(/\p{L}/gu) || []).length < 2) continue;
        marks.push({ page: run.page, id: run.id, category: AI_CATEGORIES.includes(item.category) ? item.category : 'person' });
    }
    return { marks };
}

async function redactPdfStep(app, model, step, ctx) {
    const scope = buildServerScope(ctx);
    const { resolveFileBinding, redeemPendingDescriptors } = require('./aiSteps');
    const descriptors = await redeemPendingDescriptors(app, model, await resolveFileBinding(app, model, step.source, ctx, scope), ctx);
    if (!descriptors.length) return { ok: false, error: 'No PDF was provided' };
    if (descriptors.length > 1) return { ok: false, error: 'redact_pdf cleans one PDF at a time; use a loop for several' };

    const aiRuntime = require('../aiRuntime');
    const viewer = { id: ctx.viewerId ?? null, role: ctx.role ?? null, organizationId: app.organizationId || null };
    const file = await aiRuntime.loadAttachment(app, descriptors[0], { viewer, model });
    const buffer = Buffer.from(file.content, 'base64');
    if (!/pdf/i.test(String(file.type || '')) && !/\.pdf$/i.test(file.name || '')) {
        return { ok: false, error: 'redact_pdf only takes PDF files' };
    }

    const { redactPdf, listTextRuns, PdfRedactionError } = require('../../core/documents/pdfRedaction/redactPdf');
    const terms = parseTerms(resolveBinding(step.terms, ctx, scope));
    const warnings = [];
    let result;
    try {
        let flagged = [];
        if (step.useAi !== false) {
            const { runs, truncated } = await listTextRuns(buffer);
            const ai = await aiMarks(app, runs, terms);
            flagged = ai.marks;
            if (ai.warning) warnings.push(ai.warning);
            if (truncated) warnings.push('The document is long; the AI check read the first part only.');
        }
        result = await redactPdf(buffer, { terms, aiMarks: flagged });
        warnings.unshift(...result.warnings);
    } catch (e) {
        if (e instanceof PdfRedactionError) return { ok: false, error: e.message, code: `redact_${e.code}` };
        throw e;
    }

    const removed = result.removed.slice(0, MAX_REMOVED_LISTED).map((r) => ({
        page: r.page,
        category: r.category,
        label: `${CATEGORY_LABELS[r.category] || 'Removed'} · page ${r.page}`,
        text: r.text ? r.text.slice(0, 120) : `Logo (${r.count} shape${r.count === 1 ? '' : 's'})`,
    }));
    const base = sanitizeFileName(resolveBinding(step.fileName, ctx, scope) || `${file.name.replace(/\.pdf$/i, '')}-clean`, 'document-clean');
    return storeStudioAttachment({
        app, step, ctx, scope, buffer: result.buffer, contentType: 'application/pdf', fileName: `${base}.pdf`,
        extra: {
            removed,
            removedCount: result.removed.length,
            pages: result.summary.pages,
            ...(warnings.length ? { warnings } : {}),
        },
    });
}

module.exports = { redactPdfStep, _test: { parseTerms, sanitizeFileName, aiMarks } };
