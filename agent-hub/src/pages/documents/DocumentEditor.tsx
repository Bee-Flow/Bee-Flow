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
import ManagedPartBanner from '../../components/shared/ManagedPartBanner';
import { managedOf, type ManagedPart } from '../../components/shared/managedPart';
import { lazy } from '../../utils/lazyWithReload';
import { useDocumentView, useSessionUser, type StudioDocument } from './documentQueries';
import DesignedEditor from './editor/DesignedEditor';
import { LINK_BUTTON } from './editor/ui';

const PageEditor = lazy(() => import('./PageEditor'));
// A spreadsheet's cells live in a datatable; its own grid editor.
const SpreadsheetEditor = lazy(() => import('./spreadsheet/SpreadsheetEditor'));

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

/**
 * A template a Solution stage manages (design 9) is read-only: the banner on
 * top, and the document handed to its editor as one nobody may write: not
 * editable, and not filed in a project, because a project is what an editor
 * joins the live co-editing room through. Reading needs no room.
 */
function Managed({ managed, children }: { managed: ManagedPart; children: React.ReactNode }) {
    return (
        <div className="flex flex-col h-full min-h-0">
            <ManagedPartBanner managed={managed} />
            <div className="flex-1 min-h-0">{children}</div>
        </div>
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
    const { people } = view.data;
    const managed = managedOf(view.data);
    const doc = managed ? { ...view.data.document, editable: false, deletable: false, projectId: null } : view.data.document;
    let editor;
    if (doc.docType === 'spreadsheet') {
        editor = (
            <Suspense fallback={<EditorLoading />}>
                <SpreadsheetEditor key={doc.id} initial={doc} people={people} variant={variant} currentUser={me}
                    onBack={onBack} onRenamed={onRenamed} />
            </Suspense>
        );
    } else if (doc.docType === 'page') {
        editor = (
            <Suspense fallback={<EditorLoading />}>
                <PageEditor key={doc.id} initial={doc} people={people} variant={variant} currentUser={me}
                    onBack={onBack} onRenamed={onRenamed} onOpenInStudio={onOpenInStudio} />
            </Suspense>
        );
    } else {
        editor = <DesignedEditor key={doc.id} initial={doc} people={people} variant={variant} currentUser={me} onBack={onBack} onRenamed={onRenamed} onOpenInStudio={onOpenInStudio} />;
    }
    return managed ? <Managed managed={managed}>{editor}</Managed> : editor;
}
