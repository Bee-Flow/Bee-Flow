/**
 * The data family, files: documents and presentations.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const DOCUMENT_DEFS: Record<string, NodeDefSource> = {
    generate_document: {
        family: 'data',
        typeLabel: 'Make a document',
        defaultLabel: 'Make a document',
        desc: 'Turn text from an earlier step into a PDF or Word file',
        help: 'Takes text an earlier step produced and renders it as a real PDF or Word file, with headings, bold and links intact. Put a Form page after it to offer the file as a download. The file is deleted once its retention window is up.',
        sectionKeys: ['content', 'output', 'options'],
        simpleSections: ['content', 'output'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                content: 'content',
                contentFormat: 'content',
                format: 'output',
                'title': 'output',
                fileName: 'output',
                expiresInDays: 'options',
            },
        },
        labelFallback: 'Make a document',
    },
    slide: {
        family: 'data',
        typeLabel: 'Slide',
        defaultLabel: 'Slide',
        desc: 'One slide of a presentation: a title with bullet points, a table, a quote or an image',
        help: 'Builds one slide as a value — no file yet. Give it a title and some content (bullets, a paragraph, a table, a quote), optionally speaker notes, and bind them to earlier steps. Use "one per item" to make a slide for every row of a list, then feed the slides to a Presentation step. Visuals: a chart from data rows, KPI tiles, a timeline of steps, or an accent-coloured emphasis slide.',
        sectionKeys: ['content', 'options'],
        simpleSections: ['content'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                'title': 'content',
                content: 'content',
                image: 'content',
                chart: 'content',
                stats: 'content',
                notes: 'options',
                layout: 'options',
                style: 'options',
                forEach: 'options',
            },
        },
        labelFallback: 'Slide',
    },
    presentation: {
        family: 'data',
        typeLabel: 'Presentation',
        defaultLabel: 'Presentation',
        desc: 'Turn slides or a written outline into a PowerPoint (or PDF deck) in your house style',
        help: 'Takes slides — the outline an AI step wrote ("# " title, "## " per slide), a list of Slide steps, or the results of a loop — and builds a real PowerPoint file (or a PDF deck) in your organisation\'s house style. Put a Form page after it to offer the file as a download, or a Nextcloud upload to keep it where it opens in Nextcloud Office. The file is deleted once its retention window is up. Under Look you can set the style, colours, typeface, a logo (or none) and a footer line for this deck only.',
        sectionKeys: ['slides', 'output', 'options'],
        simpleSections: ['slides', 'output'],
        issueSections: {
            fallback: 'slides',
            map: {
                label: FLAT,
                slides: 'slides',
                'title': 'output',
                'subtitle': 'output',
                fileName: 'output',
                format: 'output',
                houseStyle: 'options',
                preset: 'options',
                accent: 'options',
                background: 'options',
                font: 'options',
                titleFont: 'options',
                coverStyle: 'options',
                tableStyle: 'options',
                logo: 'options',
                logoPlacement: 'options',
                footerText: 'options',
                slideNumbers: 'options',
                template: 'options',
                expiresInDays: 'options',
            },
        },
        labelFallback: 'Presentation',
    },
    fill_document: {
        family: 'data',
        typeLabel: 'Fill a document',
        defaultLabel: 'Fill a document',
        desc: 'Fill one of your designed documents and keep the PDF',
        help: 'Takes a document you designed in Studio → Documents — an invoice, a quote, a letter on your letterhead — fills its placeholders with values from this run, and keeps the PDF. Use "Make a document" instead when there is no design and the step should lay out text for you.',
        sectionKeys: ['document', 'values', 'output', 'options'],
        simpleSections: ['document', 'values'],
        issueSections: {
            fallback: 'document',
            map: {
                label: FLAT,
                documentId: 'document',
                values: 'values',
                fileName: 'output',
                saveCopy: 'output',
                copyName: 'output',
                expiresInDays: 'options',
            },
        },
        labelFallback: 'Fill a document',
    },
};
