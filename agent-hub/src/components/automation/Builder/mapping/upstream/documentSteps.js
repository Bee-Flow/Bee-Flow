/**
 * The steps that produce a FILE: make a document, fill a document, a slide,
 * a presentation.
 *
 * Their file half is deliberately one shape — a Form page's download field, a
 * send_email attachment and an approval attachment all bind `fileId`, and two
 * file shapes would have meant teaching each of them a second one.
 */
import { sampleToFields } from './sampleFields';

/**
 * What a Make-a-document step offers downstream. `fileId` is the one that
 * matters: a Form page's download field binds to it. The sample must mirror
 * execGenerateDocument's real return shape, or the picker offers fields that
 * resolve to nothing at run time.
 */
export function describeGenerateDocument(node) {
    const ext = node.format === 'docx' ? 'docx' : 'pdf';
    const sample = {
        fileId: 'f_1a2b3c',
        filename: `document.${ext}`,
        mimeType: ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/pdf',
        size: 245_760,
        format: ext,
        degraded: false,
    };
    return {
        id: node.id,
        label: node.label || 'Make a document',
        kind: 'generate_document',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * What a Fill-a-document step offers downstream. The FILE half is deliberately
 * identical to a Make-a-document step's — a Form page's download field, a
 * send_email attachment and an approval attachment all bind `fileId`, and two
 * file shapes would have meant teaching each of them a second one.
 *
 * `missing` is the half that is this step's own: the names of the placeholders
 * nothing filled. It is offered downstream so a routine can branch on an
 * incomplete invoice — the alternative is discovering it on the paper.
 */
export function describeFillDocument(node) {
    const sample = {
        fileId: 'f_1a2b3c',
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        size: 245_760,
        documentId: node.documentId || 'doc_1a2b3c',
        documentName: node.documentName || 'Invoice',
        degraded: false,
        missing: [],
        notLists: [],
    };
    return {
        id: node.id,
        label: node.label || 'Fill a document',
        kind: 'fill_document',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * What a Slide step offers downstream: the slide OBJECT, which a Presentation
 * step's "Pick slides" row binds whole. Mirrors execSlide's return shape.
 */
export function describeSlide(node) {
    const sample = {
        slide: {
            layout: node.layout && node.layout !== 'auto' ? node.layout : 'bullets',
            title: node.title || 'Slide title',
            bullets: [{ text: 'First point', level: 0 }, { text: 'Second point', level: 0 }],
            body: null,
            notes: node.notes || null,
            table: null,
            image: null,
            quote: null,
            columns: null,
            chart: node.chart && typeof node.chart === 'object' ? { type: node.chart.type || 'column', labels: ['Q1', 'Q2'], series: [{ name: 'Series', values: [10, 20] }] } : null,
            stats: node.stats ? [{ value: '€ 1,2M', label: 'Omzet', delta: '+12%' }] : null,
            steps: node.layout === 'timeline' ? [{ title: 'Kick-off', text: null }] : null,
            cards: node.layout === 'cards' ? [{ title: 'Card', text: 'Short text' }] : null,
            style: node.style || null,
        },
    };
    return {
        id: node.id,
        label: node.label || 'Slide',
        kind: 'slide',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * What a Presentation step offers downstream. The FILE half is identical to a
 * Make-a-document step's (a Form page's download field and an approval
 * attachment bind `fileId`); `sourceHandle` is what a Nextcloud/Drive upload
 * binds whole to push the deck on. Mirrors execPresentation's return shape.
 */
export function describePresentation(node) {
    const ext = node.format === 'pdf' ? 'pdf' : 'pptx';
    const sample = {
        fileId: 'f_1a2b3c',
        filename: `presentation.${ext}`,
        mimeType: ext === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 245_760,
        format: ext,
        slideCount: 8,
        degraded: false,
        sourceHandle: { kind: 'generated_file', fileId: 'f_1a2b3c' },
    };
    return {
        id: node.id,
        label: node.label || 'Presentation',
        kind: 'presentation',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}
