// A document's type, its sharing, a person, and what this reader can make, as
// the library and the project tables say them.

import useTranslation, { readingLocale } from '@/hooks/useTranslation';
import type { People } from '../documentQueries';

export function useDocTypeLabel() {
    const { t } = useTranslation();
    return (docType: string | undefined): string => {
        switch (docType) {
            case 'page': return t('documents.type.page', 'Page');
            case 'notebook': return t('documents.type.notebook', 'Notebook');
            case 'spreadsheet': return t('documents.type.spreadsheet', 'Spreadsheet');
            case 'presentation': return t('documents.type.presentation', 'Presentation');
            case 'invoice': return t('documents.type.invoice', 'Invoice');
            case 'quote': return t('documents.type.quote', 'Quote');
            case 'letter': return t('documents.type.letter', 'Letter');
            case 'report': return t('documents.type.report', 'Report');
            case 'security': return t('documents.type.security', 'Security statement');
            // A laid-out document with fields filled in per customer (the gallery's "Blank customer document").
            default: return t('doc_gallery.type_customer', 'Customer document');
        }
    };
}

/**
 * How a row is shared. `audience` is the sharing the server stored
 * ('restricted': some people or groups; 'organisation': everyone); a row that
 * carries only `visibility: 'team'` is shared without saying with whom.
 */
interface SharedRow { visibility?: string; audience?: string }

/** "Shared", "Organisation", or null for a private document. */
export function useVisibilityLabel() {
    const { t } = useTranslation();
    return (row: SharedRow): string | null => {
        if (row.audience === 'organisation') return t('doc_gallery.visibility_organisation', 'Organisation');
        if (row.audience === 'restricted' || row.visibility === 'team') return t('doc_gallery.visibility_shared', 'Shared');
        return null;
    };
}

/** The library's one-line intro, naming only the types this reader can make. */
export function useLibraryTypesText() {
    const { t, locale, strings } = useTranslation();
    // British English, as the rest of the product: "a, b and c", no serial comma.
    const reading = readingLocale(locale, strings, ['doc_gallery.subtitle']);
    const listLocale = reading === 'en' ? 'en-GB' : reading;
    return ({ notebooks, spreadsheets }: { notebooks: boolean; spreadsheets: boolean }): string => {
        const types = [
            t('doc_gallery.subtitle_pages', 'pages'),
            ...(notebooks ? [t('doc_gallery.subtitle_notebooks', 'notebooks')] : []),
            ...(spreadsheets ? [t('doc_gallery.subtitle_spreadsheets', 'spreadsheets')] : []),
            t('doc_gallery.subtitle_customer', 'customer documents'),
            t('doc_gallery.subtitle_presentations', 'presentations'),
        ];
        const list = new Intl.ListFormat(listLocale, { style: 'long', type: 'conjunction' }).format(types);
        return t('doc_gallery.subtitle', 'Make {types} here, on your own or together.', { types: list });
    };
}

/** "You", the person's name, or "Former member" for somebody no longer named. */
export function usePersonLabel(people: People, currentUserId: string | null | undefined) {
    const { t } = useTranslation();
    return (userId: string | null | undefined): string => {
        if (!userId) return '';
        if (userId === currentUserId) return t('documents.person.you', 'You');
        return people[userId]?.name || t('documents.person.former', 'Former member');
    };
}
