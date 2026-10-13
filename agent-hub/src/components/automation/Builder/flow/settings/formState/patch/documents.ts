/**
 * buildPatch for the steps that make or read documents: generated documents,
 * slides, presentations, filled templates and data extraction.
 */
import { isEmptyExtractionSource, MAX_EXTRACTION_INSTRUCTIONS, sanitizeExtractionFields } from '../extractionFields';
import { clamp } from '../primitives';
import { applyForEachPatch } from '../stepOptions';
import type { FormRecord, JsonValue, TypePatcher } from '../types';

export const documentPatchers: Record<string, TypePatcher> = {
    generate_document: (patch, step, draft) => {
        patch.content = draft.content || '';
        patch.contentFormat = draft.contentFormat === 'html' ? 'html' : 'markdown';
        patch.format = draft.format === 'docx' ? 'docx' : 'pdf';
        patch.title = draft.title || '';
        patch.fileName = draft.fileName || '';
        // Clamp must match validate.js's expiry_range AND builderTools'
        // normalizePatchField, or the canvas and the AI disagree about what a
        // legal value is.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    },
    slide: (patch, step, draft) => {
        patch.title = draft.title || '';
        patch.content = draft.content || '';
        patch.notes = draft.notes || '';
        // Absent, not '', when nothing is set: the validator accepts a missing
        // image/layout and the runner reads absent layout as "pick one".
        patch.image = (draft.image || '').trim() || undefined;
        patch.layout = draft.layout && draft.layout !== 'auto' ? draft.layout : undefined;
        // The visual picker decides which stored field survives; the others
        // are cleared so a slide never carries two visuals at once.
        const visual = draft.visual || 'none';
        const chartData = (draft.chartData || '').trim();
        if (visual === 'chart' && (chartData || draft.chartType)) {
            let data = chartData;
            if (/^\s*[[{]/.test(chartData)) { try { data = JSON.parse(chartData); } catch { data = chartData; } }
            patch.chart = {
                type: draft.chartType || 'column',
                ...(chartData ? { data } : {}),
                ...((draft.chartLabels || '').trim() ? { labels: draft.chartLabels.trim() } : {}),
                ...((draft.chartValues || '').trim() ? { values: draft.chartValues.trim() } : {}),
                ...(draft.chartStacked ? { stacked: true } : {}),
                ...((draft.chartUnit || '').trim() ? { unit: draft.chartUnit.trim() } : {}),
            };
        } else {
            patch.chart = undefined;
        }
        patch.stats = visual === 'stats' && (draft.stats || '').trim() ? draft.stats.trim() : undefined;
        if (visual !== 'image') patch.image = undefined;
        if (visual === 'timeline') patch.layout = 'timeline';
        else if (patch.layout === 'timeline') patch.layout = undefined;
        patch.style = draft.style === 'accent' || draft.style === 'dark' ? draft.style : undefined;
        applyForEachPatch(patch, step, draft);
    },
    presentation: (patch, step, draft) => {
        if (draft.slidesMode === 'list') {
            // Blank rows are dropped; a row that reads as JSON (an inline
            // slide object) is kept as that object.
            patch.slides = (draft.slideRows || []).map((r: JsonValue) => (typeof r === 'string' ? r.trim() : r)).filter((r: JsonValue) => r !== '' && r !== null && r !== undefined)
                .map((r: JsonValue) => { if (typeof r === 'string' && /^\s*\{/.test(r)) { try { return JSON.parse(r); } catch { return r; } } return r; });
        } else {
            patch.slides = draft.slides || '';
        }
        patch.title = draft.title || '';
        patch.subtitle = draft.subtitle || '';
        patch.fileName = draft.fileName || '';
        patch.format = draft.format === 'pdf' ? 'pdf' : 'pptx';
        patch.houseStyle = draft.houseStyle !== false;
        // Look fields travel as a value or ABSENT — never '' — so a cleared
        // choice hands the decision back to the house style.
        for (const k of ['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText']) {
            const v = typeof draft[k] === 'string' ? draft[k].trim() : '';
            patch[k] = v || undefined;
        }
        patch.slideNumbers = draft.slideNumbers === 'true' ? true : (draft.slideNumbers === 'false' ? false : undefined);
        patch.template = draft.template === 'none' ? 'none' : undefined;
        patch.saveCopy = draft.saveCopy === true ? true : undefined;
        patch.copyName = draft.saveCopy === true && draft.copyName ? draft.copyName : undefined;
        // Same clamp as generate_document: canvas and AI must agree.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    },
    fill_document: (patch, step, draft) => {
        patch.documentId = draft.documentId || '';
        if (draft.documentVersionId) patch.documentVersionId = draft.documentVersionId;
        patch.sectionOverrides = { ...(draft.sectionOverrides || {}) };
        patch.documentName = draft.documentName || '';
        // Blank values are dropped rather than written: an empty string and an
        // absent binding fill the same nothing, and keeping the key would make
        // "which placeholders are still unbound" unanswerable from the step.
        const values: FormRecord = {};
        for (const [k, v] of Object.entries(draft.values || {})) {
            const val = typeof v === 'string' ? v.trim() : v;
            if (val !== '' && val !== undefined && val !== null) values[k] = val;
        }
        patch.values = values;
        patch.fileName = draft.fileName || '';
        patch.format = draft.format === 'pdf' || draft.format === 'pptx' ? draft.format : undefined;
        patch.saveCopy = draft.saveCopy === true;
        patch.copyName = draft.saveCopy === true ? (draft.copyName || '') : '';
        // Same clamp as generate_document, and for the same reason: the canvas
        // and the AI must agree about what a legal value is.
        patch.expiresInDays = clamp(Math.round(Number(draft.expiresInDays) || 7), 1, 90);
    },
    data_extraction: (patch, step, draft) => {
        // Absent, not null, when nothing is bound: `typeof null === 'object'`
        // is exactly the shape a "must be a binding object" rule lets through
        // and then trips over. `source_missing` is a completeness code, so the
        // gap autosaves amber.
        patch.source = isEmptyExtractionSource(draft.source) ? undefined : draft.source;
        patch.fields = sanitizeExtractionFields(draft.fields);
        patch.instructions = (draft.instructions || '').slice(0, MAX_EXTRACTION_INSTRUCTIONS) || undefined;
        applyForEachPatch(patch, step, draft);
    },
};
