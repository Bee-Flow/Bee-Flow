/**
 * "Add to project" on the form under a chat answer: files the person's own
 * filled-in document into one of their projects (api/documentFilingApi.ts),
 * so the project's members see and edit it there. Lists only the projects the
 * person owns or edits; afterwards it links to the document in the project.
 */
import { useState } from 'react';
import { FolderInput } from 'lucide-react';

import { addDocumentToProject, listFilingTargets, projectDocumentUrl, type FilingTarget } from '@/api/documentFilingApi';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';

const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-[var(--text-primary)] bg-[var(--bg-primary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

/** In-app navigation, as DocumentLinkCard does it: the shell listens for popstate. */
function openInApp(path: string) {
    window.history.pushState({ page: 'projects' }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'projects' } }));
}

type State =
    | { step: 'closed' }
    | { step: 'loading' }
    | { step: 'choose', projects: FilingTarget[] }
    | { step: 'saving', projects: FilingTarget[] }
    | { step: 'added', project: FilingTarget }
    | { step: 'failed' };

export default function AddToProjectButton({ documentId }: { documentId: string }) {
    const { t } = useTranslation();
    const [state, setState] = useState<State>({ step: 'closed' });

    const open = async () => {
        setState({ step: 'loading' });
        try {
            setState({ step: 'choose', projects: await listFilingTargets() });
        } catch (err) {
            logger.debug('project list for filing failed', err);
            setState({ step: 'failed' });
        }
    };
    const choose = async (projects: FilingTarget[], project: FilingTarget) => {
        setState({ step: 'saving', projects });
        try {
            await addDocumentToProject(project.id, documentId);
            setState({ step: 'added', project });
        } catch (err) {
            logger.debug('filing into project failed', err);
            setState({ step: 'failed' });
        }
    };

    if (state.step === 'added') {
        return (
            <a href={projectDocumentUrl(state.project.id, documentId)} data-testid="template-fill-added-to-project"
                onClick={(e) => { e.preventDefault(); openInApp(projectDocumentUrl(state.project.id, documentId)); }}
                className="text-sm text-[var(--accent-primary)] underline">
                {t('chat_templates.added_to_project', 'In project {name}', { name: state.project.name })}
            </a>
        );
    }
    const projects = state.step === 'choose' || state.step === 'saving' ? state.projects : null;
    return (
        <div className="relative">
            <button type="button" className={BUTTON} data-testid="template-fill-add-to-project"
                aria-expanded={projects !== null} disabled={state.step === 'loading' || state.step === 'saving'}
                onClick={() => (projects ? setState({ step: 'closed' }) : void open())}>
                <FolderInput size={14} aria-hidden="true" />
                {t('chat_templates.add_to_project', 'Add to project')}
            </button>
            {state.step === 'failed' && (
                <p role="alert" className="m-0 mt-1 text-xs text-[var(--error)]">
                    {t('chat_templates.add_to_project_failed', 'Could not add it to the project. Try again.')}
                </p>
            )}
            {projects && (
                <div role="menu" className="absolute bottom-full mb-1 left-0 z-20 min-w-[220px] max-h-64 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-lg py-1">
                    {projects.length === 0 && (
                        <p className="m-0 px-3 py-2 text-xs text-[var(--text-secondary)]">
                            {t('chat_templates.add_to_project_none', 'You have no project you can add documents to.')}
                        </p>
                    )}
                    {projects.map((p) => (
                        <button key={p.id} type="button" role="menuitem" disabled={state.step === 'saving'}
                            onClick={() => void choose(projects, p)}
                            className="block w-full text-left px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50">
                            {p.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
