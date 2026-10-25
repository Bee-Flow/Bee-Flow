/**
 * extractFormState for the steps that make or read documents: generated
 * documents, slides, presentations, filled templates and data extraction.
 */
import { isEmptyExtractionSource, readExtractionFields } from '../extractionFields';
import type { TypeExtractor } from '../types';

/** `value || ''`: the editor wants a string for anything unset. */
const orEmpty = <T>(value: T): T | '' => value || '';

/** How long a generated file's link lives; 7 days unless the step names a number. */
const expiryDays = (step: { expiresInDays?: unknown }): number => (Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7);

export const documentExtractors: Record<string, TypeExtractor> = {
    generate_document: (step, base) => ({
        ...base,
        content: step.content || '',
        contentFormat: step.contentFormat === 'html' ? 'html' : 'markdown',
        format: step.format === 'docx' ? 'docx' : 'pdf',
        title: step.title || '',
        fileName: step.fileName || '',
        expiresInDays: Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7,
    }),
    slide: (step, base) => {
        // The visual picker is a VIEW over the stored fields: a chart object →
        // chart, stats → stats, an image → image, layout timeline → timeline.
        const chart = step.chart && typeof step.chart === 'object' && !Array.isArray(step.chart) ? step.chart : null;
        const chartData = chart ? (typeof chart.data === 'string' ? chart.data : (chart.data !== undefined ? JSON.stringify(chart.data) : '')) : '';
        const stats = Array.isArray(step.stats) ? step.stats.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : (typeof step.stats === 'string' ? step.stats : '');
        const visual = chart || typeof step.chart === 'string' ? 'chart' : (stats ? 'stats' : (step.image ? 'image' : (step.layout === 'timeline' ? 'timeline' : 'none')));
        return {
            ...base,
            title: step.title || '',
            content: step.content || '',
            notes: step.notes || '',
            image: step.image || '',
            layout: step.layout || 'auto',
            visual,
            chartType: chart ? (chart.type || 'column') : (typeof step.chart === 'string' ? step.chart : 'column'),
            chartData,
            chartLabels: chart && typeof chart.labels === 'string' ? chart.labels : '',
            chartValues: chart && typeof chart.values === 'string' ? chart.values : '',
            chartStacked: !!(chart && chart.stacked),
            chartUnit: chart && typeof chart.unit === 'string' ? chart.unit : '',
            stats,
            style: step.style === 'accent' || step.style === 'dark' ? step.style : '',
            forEach: step.forEach || null,
        };
    },
    presentation: (step, base) => ({
        ...base,
        // `slides` has two faces in the editor — ONE source (a template) or a
        // LIST of references — and one shape in the step. The mode follows
        // the stored shape, so an AI-built list opens as a list.
        slidesMode: Array.isArray(step.slides) ? 'list' : 'source',
        slides: typeof step.slides === 'string' ? step.slides : '',
        slideRows: Array.isArray(step.slides) ? step.slides.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))) : [],
        title: orEmpty(step.title),
        subtitle: orEmpty(step.subtitle),
        fileName: orEmpty(step.fileName),
        format: step.format === 'pdf' ? 'pdf' : 'pptx',
        houseStyle: step.houseStyle !== false,
        // The look: '' means "the house style decides".
        preset: orEmpty(step.preset),
        accent: orEmpty(step.accent),
        background: orEmpty(step.background),
        font: orEmpty(step.font),
        titleFont: orEmpty(step.titleFont),
        coverStyle: orEmpty(step.coverStyle),
        tableStyle: orEmpty(step.tableStyle),
        logo: orEmpty(step.logo),
        logoPlacement: orEmpty(step.logoPlacement),
        footerText: orEmpty(step.footerText),
        // Three states: '' follows the house style, true/false overrides it.
        slideNumbers: typeof step.slideNumbers === 'boolean' ? String(step.slideNumbers) : '',
        template: step.template === 'none' ? 'none' : '',
        saveCopy: step.saveCopy === true,
        copyName: orEmpty(step.copyName),
        expiresInDays: expiryDays(step),
    }),
    fill_document: (step, base) => ({
        ...base,
        documentId: step.documentId || '',
        documentVersionId: step.documentVersionId || '',
        sectionOverrides: { ...(step.sectionOverrides || {}) },
        // The picker writes the NAME alongside the id so the card and the
        // header can say which document without a fetch. It is a cache, never
        // a second source of truth: the runner resolves the id.
        documentName: step.documentName || '',
        // A plain object of placeholder → template string. Rebuilt wholesale on
        // save (see the patch below), so a placeholder the person removed from
        // the document does not keep a value nobody can see.
        values: (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) ? { ...step.values } : {},
        fileName: step.fileName || '',
        // Only a presentation document reads it; '' = the default (.pptx).
        format: step.format === 'pdf' ? 'pdf' : (step.format === 'pptx' ? 'pptx' : ''),
        saveCopy: step.saveCopy === true,
        copyName: step.copyName || '',
        expiresInDays: Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : 7,
    }),
    data_extraction: (step, base) => ({
        ...base,
        // An absent source opens as an EMPTY REF, not an empty literal: the
        // field then starts in expression mode, so a value dragged in lands as
        // the bare `{ kind: 'ref', path }` the runtime and the fan-out chooser
        // both want, rather than as a `{{…}}` template string.
        source: isEmptyExtractionSource(step.source) ? { kind: 'ref', path: '' } : step.source,
        // ONE blank row when the step has none, so the panel never opens on
        // nothing but an "Add field" link. The row is draft-only: buildPatch
        // drops a nameless row (an INTEGRITY error server-side), and the sync
        // re-seeds it from here the moment the list comes back empty.
        fields: readExtractionFields(step.fields),
        instructions: typeof step.instructions === 'string' ? step.instructions : '',
        forEach: step.forEach || null,
    }),
};
