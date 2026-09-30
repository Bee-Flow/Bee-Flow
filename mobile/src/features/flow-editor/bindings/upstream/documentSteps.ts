/**
 * The steps that produce a FILE: make a document, fill a document, a slide, a
 * presentation. Their file half is one shape — `fileId` is what a form page's
 * download field, a mail attachment and an approval attachment bind. Port of
 * agent-hub `Builder/mapping/upstream/documentSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';

import { isObj } from '../json';
import type { FlowNode, VariableGroup } from '../types';
import { stepGroup } from './sampleFields';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Example slide content (data, not copy): the parts of a slide object.
const SLIDE_EXAMPLE = {
    slideTitle: 'Slide title',
    stepTitle: 'Kick-off',
    cardTitle: 'Card',
    cardText: 'Short text',
    statValue: '€ 1,2M',
    statLabel: 'Omzet',
    statDelta: '+12%',
};

export function describeGenerateDocument(node: FlowNode): VariableGroup {
    const ext = node.format === 'docx' ? 'docx' : 'pdf';
    const sample = {
        fileId: 'f_1a2b3c',
        filename: `document.${ext}`,
        mimeType: ext === 'docx' ? DOCX_MIME : 'application/pdf',
        size: 245_760,
        format: ext,
        degraded: false,
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('generate_document', t), kind: 'generate_document' }, sample);
}

/** The file half plus `missing`: the placeholders nothing filled. */
export function describeFillDocument(node: FlowNode): VariableGroup {
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
    return stepGroup(node, { label: node.label || nodeDefaultLabel('fill_document', t), kind: 'fill_document' }, sample);
}

function slideChart(chart: unknown): unknown {
    if (!chart || typeof chart !== 'object') return null;
    const type = (isObj(chart) && chart.type) || 'column';
    return { type, labels: ['Q1', 'Q2'], series: [{ name: 'Series', values: [10, 20] }] };
}

/** The slide OBJECT a presentation's "Pick slides" row binds whole (execSlide). */
export function describeSlide(node: FlowNode): VariableGroup {
    const e = SLIDE_EXAMPLE;
    const slide = {
        layout: node.layout && node.layout !== 'auto' ? node.layout : 'bullets',
        title: node.title || e.slideTitle,
        bullets: [{ text: 'First point', level: 0 }, { text: 'Second point', level: 0 }],
        body: null,
        notes: node.notes || null,
        table: null,
        image: null,
        quote: null,
        columns: null,
        chart: slideChart(node.chart),
        stats: node.stats ? [{ value: e.statValue, label: e.statLabel, delta: e.statDelta }] : null,
        steps: node.layout === 'timeline' ? [{ title: e.stepTitle, text: null }] : null,
        cards: node.layout === 'cards' ? [{ title: e.cardTitle, text: e.cardText }] : null,
        style: node.style || null,
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('slide', t), kind: 'slide' }, { slide });
}

/** The file half plus `sourceHandle`, which an upload binds whole (execPresentation). */
export function describePresentation(node: FlowNode): VariableGroup {
    const ext = node.format === 'pdf' ? 'pdf' : 'pptx';
    const sample = {
        fileId: 'f_1a2b3c',
        filename: `presentation.${ext}`,
        mimeType: ext === 'pdf' ? 'application/pdf' : PPTX_MIME,
        size: 245_760,
        format: ext,
        slideCount: 8,
        degraded: false,
        sourceHandle: { kind: 'generated_file', fileId: 'f_1a2b3c' },
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('presentation', t), kind: 'presentation' }, sample);
}
