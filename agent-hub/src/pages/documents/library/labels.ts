// A document's type, and a person, as the library and the project tables say them.

import useTranslation from '../../../hooks/useTranslation';
import type { People } from '../documentQueries';

export function useDocTypeLabel() {
    const { t } = useTranslation();
    return (docType: string | undefined): string => {
        switch (docType) {
            case 'page': return t('documents.type.page', 'Page');
            case 'notebook': return t('documents.type.notebook', 'Notebook');
            case 'presentation': return t('documents.type.presentation', 'Presentation');
            case 'invoice': return t('documents.type.invoice', 'Invoice');
            case 'quote': return t('documents.type.quote', 'Quote');
            case 'letter': return t('documents.type.letter', 'Letter');
            case 'report': return t('documents.type.report', 'Report');
            case 'security': return t('documents.type.security', 'Security statement');
            default: return t('documents.type.document', 'Document');
        }
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
