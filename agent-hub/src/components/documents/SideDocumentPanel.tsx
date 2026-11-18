import { Suspense } from 'react';
import useTranslation from '../../hooks/useTranslation';
import DocumentEditor from '../../pages/documents/DocumentEditor';
import { useSessionUser } from '../../pages/documents/documentQueries';
import { notebookIdOf } from '../../pages/documents/notebookRef';
import { lazy } from '../../utils/lazyWithReload';
import { projectRoutePath } from '../../utils/projectRoutes';

const NotebookDetail = lazy(() => import('../../pages/documents/notebook/detail/NotebookDetail'));

/**
 * A document in the right-hand chat slot — the sibling of SideWebpagePanel.
 *
 * WHY IT IS FULLY EDITABLE HERE, when SideWebpagePanel is read-only and sends
 * you to Studio to edit. A webpage is a project you build; a document is a page
 * you correct. The whole point of the feature is that the AI drafts an invoice
 * and you fix the amount — asking someone to leave the conversation to change
 * one number would put the chat and the artefact on opposite screens, which is
 * exactly what this panel exists to avoid. So it hosts the real editor,
 * autosave and all, and the expand button is a convenience rather than the
 * place the work happens.
 *
 * A thin wrapper on purpose: forking DocumentEditor would have meant two
 * autosave implementations, and the copy nobody maintains would be this one —
 * the one people actually reach, since a chat link lands here.
 *
 * A notebook comes as `notebook/<id>` (notebookRef), as in the Documents
 * library: its id is a notebook's, not a document's. It opens in the notebook's
 * own editor in its panel form: the chat beside it is the AI, so its sources
 * and its own chat stay in Studio.
 */
interface SideDocumentPanelProps {
    documentId: string;
    onClose?: () => void;
    onNavigate?: (path: string) => void;
    /** Who is signed in, as the chat knows them; read from the session otherwise. */
    user?: unknown;
}

function openProject(projectId: string) {
    window.history.pushState({ page: 'projects' }, '', projectRoutePath(projectId, 'notebooks'));
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function SideNotebookPanel({ notebookId, onClose, onNavigate, user }: { notebookId: string } & Omit<SideDocumentPanelProps, 'documentId'>) {
    const { t } = useTranslation();
    const me = useSessionUser(!user);
    const close = () => onClose?.();
    return (
        <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-tertiary)]" role="status">{t('documents.notebook.loading', 'Opening the notebook…')}</div>}>
            <NotebookDetail
                key={notebookId}
                notebookId={notebookId}
                user={user || me.data || null}
                variant="panel"
                onBack={close}
                onListChanged={() => {}}
                onOpenProject={(projectId) => { close(); openProject(projectId); }}
                onOpenInStudio={() => {
                    // As for a document: one editor on it at a time.
                    close();
                    onNavigate?.(`studio/documents/notebook/${notebookId}`);
                }}
            />
        </Suspense>
    );
}

export default function SideDocumentPanel({ documentId, onClose, onNavigate, user }: SideDocumentPanelProps) {
    const notebookId = notebookIdOf(documentId);
    if (notebookId) return <SideNotebookPanel notebookId={notebookId} onClose={onClose} onNavigate={onNavigate} user={user} />;
    return (
        <DocumentEditor
            key={documentId}
            documentId={documentId}
            variant="panel"
            onBack={onClose}
            onOpenInStudio={(id: string) => {
                // Hand the document over to the full screen and close the slot,
                // so the same document is not open twice with two autosavers.
                onClose?.();
                onNavigate?.(`studio/documents/${id}`);
            }}
        />
    );
}
