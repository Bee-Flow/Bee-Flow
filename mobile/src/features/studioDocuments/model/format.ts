/**
 * Labels for Studio Documents, in the web's words. Every function takes the
 * translate function so the words come from the catalogue: the web's own key
 * where one exists in both dictionaries, `mobile.studio_documents.*` otherwise.
 */

import type { TranslateFn } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { Condition, DocKind, ParamType, SectionState } from './types';

export const isDeck = (doc: { docType: string }): boolean => doc.docType === 'presentation';

export const docIcon = (doc: { docType: string }): IconName => (isDeck(doc) ? 'Presentation' : 'FileText');

/** The web shows the raw type for a page and "Presentation" for a deck. */
export function docTypeLabel(t: TranslateFn, docType: string): string {
    switch (docType) {
        case 'invoice':
            return t('documents.type.invoice', 'Invoice');
        case 'quote':
            return t('documents.type.quote', 'Quote');
        case 'letter':
            return t('documents.type.letter', 'Letter');
        case 'report':
            return t('documents.type.report', 'Report');
        case 'presentation':
            return t('mobile.studio_documents.type.presentation', 'Presentation');
        case 'security':
            return t('mobile.studio_documents.type.security', 'Security');
        default:
            return t('documents.type.document', 'Document');
    }
}

export function kindLabel(t: TranslateFn, kind: DocKind, deck = false): string {
    if (kind === 'template') return t('mobile.studio_documents.kind.template', 'Template');
    if (kind === 'section') return t('mobile.studio_documents.kind.section', 'Reusable section');
    return deck ? docTypeLabel(t, 'presentation') : t('documents.type.document', 'Document');
}

/** The library views the web's list is split into. */
export function kindTabLabel(t: TranslateFn, kind: DocKind): string {
    if (kind === 'template') return t('mobile.studio_documents.tab.templates', 'Templates');
    if (kind === 'section') return t('mobile.studio_documents.tab.sections', 'Reusable sections');
    return t('documents.title', 'Documents');
}

export function paramTypeLabel(t: TranslateFn, type: ParamType): string {
    const labels: Record<ParamType, string> = {
        text: t('mobile.studio_documents.param.text', 'Text'),
        number: t('mobile.studio_documents.param.number', 'Number'),
        boolean: t('mobile.studio_documents.param.boolean', 'Yes / no'),
        date: t('common.date', 'Date'),
        choice: t('mobile.studio_documents.param.choice', 'Choice'),
        list: t('mobile.studio_documents.param.list', 'List'),
    };
    return labels[type];
}

export function operatorLabel(t: TranslateFn, operator: string): string {
    switch (operator) {
        case 'equals':
            return t('mobile.studio_documents.op.equals', 'Equals');
        case 'not_equals':
            return t('mobile.studio_documents.op.not_equals', 'Does not equal');
        case 'contains':
            return t('mobile.studio_documents.op.contains', 'Contains');
        case 'greater_than':
            return t('mobile.studio_documents.op.greater_than', 'Greater than');
        case 'less_than':
            return t('mobile.studio_documents.op.less_than', 'Less than');
        default:
            return t('mobile.studio_documents.op.is_set', 'Is set');
    }
}

export function sectionStateLabel(t: TranslateFn, state: SectionState): string {
    if (state === 'included') return t('mobile.studio_documents.state.included', 'Included');
    if (state === 'excluded') return t('mobile.studio_documents.state.excluded', 'Excluded');
    return t('mobile.studio_documents.state.unresolved', 'Needs input');
}

/** A rule as one readable line: "remoteAccess equals true AND seats greater than 5". */
export function conditionText(t: TranslateFn, condition: Condition | null): string {
    if (!condition) return t('mobile.studio_documents.always', 'Always included');
    if ('parameter' in condition) {
        const value = condition.operator === 'is_set' ? '' : ` ${String(condition.value ?? '')}`;
        return `${condition.parameter} ${operatorLabel(t, condition.operator).toLowerCase()}${value}`.trim();
    }
    const all = 'all' in condition;
    const parts = (all ? condition.all : condition.any).map((c) => {
        const text = conditionText(t, c);
        return 'parameter' in c ? text : `(${text})`;
    });
    return parts.join(all ? ' AND ' : ' OR ');
}

/** A cache-safe file name for a download (the server's pdfFilename, simplified). */
export function fileNameFor(name: string, extension: 'pdf' | 'pptx' | 'html'): string {
    const base = name.normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';
    return `${base}.${extension}`;
}
