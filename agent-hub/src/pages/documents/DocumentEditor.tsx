// A document, opened: the entry every place that shows one uses (the Studio
// library, a project's documents tab, the panel beside a chat). It loads the
// document once and hands it to the editor for its kind: a PAGE to the
// rich-text PageEditor (edited live together when filed in a project), any
// other document to the DesignedEditor (the sheet in its frame).
//
// Loading, not found and could not load are three different screens.

import { AlertTriangle, Loader2 } from 'lucide-react';
import React, { Suspense } from 'react';
import useTranslation from '../../hooks/useTranslation';
import { lazy } from '../../utils/lazyWithReload';
import { useDocumentView, useSessionUser, type StudioDocument } from './documentQueries';
import DesignedEditor from './editor/DesignedEditor';
import { LINK_BUTTON } from './editor/ui';

const PageEditor = lazy(() => import('./PageEditor'));

export interface DocumentEditorProps {
    documentId: string;
    onBack?: () => void;
    onRenamed?: (doc: StudioDocument) => void;
    /** 'page' (Studio, a project) | 'panel' (beside the chat). */
    variant?: 'page' | 'panel';
    onOpenInStudio?: (id: string) => void;
    /** Who is signed in, when the host knows; read from the session otherwise. */
    currentUser?: { id: string; name?: string } | null;
}

function Centered({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center bg-[var(--bg-primary)]">{children}</div>;
}

export function EditorLoading() {
    const { t } = useTranslation();
    return (
        <Centered>
            <Loader2 className="animate-spin text-[var(--accent-primary)]" size={22} aria-hidden="true" />
            <span className="sr-only" role="status">{t('documents.loading', 'Opening the document…')}</span>
        </Centered>
    );
}

function LoadProblem({ missing, onRetry, onBack, backLabel }: { missing: boolean; onRetry: () => void; onBack?: () => void; backLabel: string }) {
    const { t } = useTranslation();
    return (
        <Centered>
            <AlertTriangle size={20} aria-hidden="true" className="text-[var(--text-tertiary)]" />
            <p className="text-sm text-[var(--text-secondary)]" role={missing ? undefined : 'alert'}>
                {missing ? t('documents.not_found', 'Document not found.') : t('documents.load_failed', 'The document could not be loaded.')}
            </p>
            <div className="flex gap-3 text-sm text-[var(--accent-primary)]">
                {!missing && <button type="button" className={LINK_BUTTON} onClick={onRetry}>{t('documents.retry', 'Try again')}</button>}
                {onBack && <button type="button" className={LINK_BUTTON} onClick={onBack}>{backLabel}</button>}
            </div>
        </Centered>
    );
}

export default function DocumentEditor({ documentId, onBack, onRenamed, variant = 'page', onOpenInStudio, currentUser }: DocumentEditorProps) {
    const { t } = useTranslation();
    const view = useDocumentView(documentId);
    const session = useSessionUser(currentUser === undefined);
    const me = currentUser !== undefined ? currentUser : (session.data || null);
    const backLabel = variant === 'panel' ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents');

    if (view.isPending) return <EditorLoading />;
    if (view.isError || !view.data?.document) {
        const status = (view.error as { status?: number } | null)?.status;
        return <LoadProblem missing={status === 404 || !view.isError} onRetry={() => view.refetch()} onBack={onBack} backLabel={backLabel} />;
    }
    const { document: doc, people } = view.data;
    if (doc.docType === 'page') {
        return (
            <Suspense fallback={<EditorLoading />}>
                <PageEditor key={doc.id} initial={doc} people={people} variant={variant} currentUser={me}
                    onBack={onBack} onRenamed={onRenamed} onOpenInStudio={onOpenInStudio} />
            </Suspense>
        );
    }
    return <DesignedEditor key={doc.id} initial={doc} people={people} variant={variant} currentUser={me} onBack={onBack} onRenamed={onRenamed} onOpenInStudio={onOpenInStudio} />;
}
