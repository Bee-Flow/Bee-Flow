/**
 * NotebooksPage — the notebook library (the card grid) and, once one is
 * opened, that notebook (pages/notebooks/detail).
 *
 * Opening navigates at once (the notebook shows a skeleton while it loads);
 * the URL follows the open notebook (`onNotebookChange`), and back/forward to
 * another notebook's URL opens that one. The page is gated twice, like the
 * server: the plan must include notebooks (licence) and the user's role the
 * "Use Notebooks" permission.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useLicenseContext } from '../components/licensing/LicenseContext';
import useTranslation from '../hooks/useTranslation';
import { projectRoutePath } from '../utils/projectRoutes';
import useNotebookList from './notebooks/hooks/useNotebookList';
import NotebooksOverview from './notebooks/overview/NotebooksOverview';
import NotebookDetail from './notebooks/detail/NotebookDetail';

export interface NotebooksPageProps {
    user: any;
    onBack?: () => void;
    initialNotebookId?: string | null;
    onNotebookChange?: (id: string | null) => void;
}

/** Open a project inside the app (the app routes on the URL, like the back button). */
function openProjectInApp(projectId: string) {
    window.history.pushState({ page: 'projects' }, '', projectRoutePath(projectId, 'notebooks'));
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function NotebooksDisabled({ onBack }: { onBack?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-full flex items-center justify-center bg-[var(--bg-primary)]">
            <div className="text-center p-8 rounded-2xl border max-w-md bg-[var(--bg-secondary)] border-[var(--border-default)]">
                <div className="w-14 h-14 mx-auto mb-3 rounded-full flex items-center justify-center bg-[var(--bg-tertiary)]">
                    <AlertCircle className="w-7 h-7 text-[var(--error)]" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold mb-1 text-[var(--text-primary)]">{t('notebooks.disabled_title', 'Notebooks disabled')}</h2>
                <p className="text-sm mb-4 text-[var(--text-muted)]">{t('notebooks.disabled_body', 'Your role does not include access to notebooks. Ask an administrator to grant the "Use Notebooks" permission.')}</p>
                {onBack && (
                    <button type="button" onClick={onBack} className="px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                        {t('notebooks.go_back', 'Go back')}
                    </button>
                )}
            </div>
        </div>
    );
}

export default function NotebooksPage({ user, onBack, initialNotebookId = null, onNotebookChange }: NotebooksPageProps) {
    const canUseNotebooks = !!(user?.permissions?.includes('all') || user?.permissions?.includes('use_notebooks'));
    // The plan must grant notebooks, as the licence gate on /api/notebooks does.
    // The context is untyped JS whose default `hasFeature` takes no argument.
    const { hasFeature } = useLicenseContext() as unknown as { hasFeature: (name: string) => boolean };
    const licensed = hasFeature('notebooks');
    useEffect(() => { if (!licensed) onBack?.(); }, [licensed, onBack]);

    // Owned here (not in the overview) so search, sort, filter and page
    // survive while a notebook is open.
    const list = useNotebookList();
    const [openId, setOpenId] = useState<string | null>(initialNotebookId || null);
    const [focusChat, setFocusChat] = useState(false);

    // Back/forward to another notebook's URL opens that one.
    useEffect(() => {
        if (initialNotebookId && initialNotebookId !== openId) setOpenId(initialNotebookId);
        // Only the URL's notebook drives this; opening from the grid sets both.
    }, [initialNotebookId]);

    const open = useCallback((nb: { id: string }, opts: { focusChat?: boolean } = {}) => {
        if (!nb?.id) return;
        if (opts.focusChat) {
            // The workspace reads its drawer state from storage when it mounts.
            try { localStorage.setItem('bf.workspace.notebook.rightOpen', '1'); } catch { /* private mode */ }
        }
        setFocusChat(!!opts.focusChat);
        setOpenId(nb.id);
        onNotebookChange?.(nb.id);
    }, [onNotebookChange]);

    const { refetch } = list;
    const back = useCallback(() => {
        setOpenId(null);
        onNotebookChange?.(null);
        // Card counts, previews and activity changed while it was open.
        refetch();
    }, [onNotebookChange, refetch]);

    if (!licensed) return null;
    if (!canUseNotebooks) return <NotebooksDisabled onBack={onBack} />;

    if (openId) {
        return (
            <NotebookDetail
                key={`${openId}:${focusChat ? 'chat' : 'doc'}`}
                notebookId={openId}
                user={user}
                onBack={back}
                onListChanged={refetch}
                onOpenProject={openProjectInApp}
            />
        );
    }

    const Overview = NotebooksOverview as unknown as React.ComponentType<any>;
    return (
        <Overview
            list={list}
            onBack={onBack}
            onOpen={(nb: { id: string }) => open(nb)}
            onOpenChat={(nb: { id: string }) => open(nb, { focusChat: true })}
        />
    );
}
