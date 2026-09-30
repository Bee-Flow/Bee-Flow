/**
 * NotebookConflictPanel — somebody saved this notebook while you were writing.
 *
 * Nothing was thrown away: the server kept your text as a version the moment
 * the save lost the race. This panel says so, shows the difference between
 * the saved notebook and your text (the shared version compare), and lets you
 * choose — keep yours (saved over the version you just looked at) or take the
 * saved one (yours stays in the history). Saving waits until you chose; your
 * typing in the meantime is kept.
 *
 * It sits below the header, not in a modal: the editor stays usable.
 */
import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import VersionCompare from '../../../components/versions/VersionCompare';
import { CURRENT } from '../../../api/queries/versions';

interface Props {
    notebookId: string;
    conflictVersionId: string | null;
    busy: boolean;
    error: string | null;
    onKeepMine: () => void;
    onUseTheirs: () => void;
}

export default function NotebookConflictPanel({ notebookId, conflictVersionId, busy, error, onKeepMine, onUseTheirs }: Props) {
    const { t } = useTranslation();
    const [showDiff, setShowDiff] = useState(false);
    return (
        <section
            aria-label={t('notebooks.conflict_label', 'Changes saved elsewhere')}
            className="mx-4 mt-2 rounded-xl border border-[var(--warning)] bg-[var(--bg-secondary)] px-4 py-3 space-y-2"
            data-testid="notebook-conflict"
        >
            <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning-ink)]" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('notebooks.conflict_title', 'Someone else saved this notebook while you were writing')}
                    </p>
                    <p className="m-0 text-[12.5px] text-[var(--text-secondary)]">
                        {t('notebooks.conflict_body', 'Nothing is lost: your text is kept in the version history. Choose which version to continue with; saving waits until you do.')}
                    </p>
                </div>
            </div>
            {conflictVersionId && (
                <div>
                    <button
                        type="button"
                        onClick={() => setShowDiff((v) => !v)}
                        aria-expanded={showDiff}
                        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        data-testid="notebook-conflict-toggle"
                    >
                        {showDiff ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('notebooks.conflict_compare', 'Show what differs from the saved version')}
                    </button>
                    {showDiff && (
                        <div className="mt-2 max-h-[40vh] overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3">
                            <VersionCompare baseUrl={`/api/notebooks/${notebookId}`} fromRef={CURRENT} toRef={conflictVersionId} />
                        </div>
                    )}
                </div>
            )}
            {error && <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onKeepMine}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50"
                    data-testid="notebook-conflict-keep-mine"
                >
                    {t('notebooks.conflict_keep_mine', 'Keep my version')}
                </button>
                <button
                    type="button"
                    onClick={onUseTheirs}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    data-testid="notebook-conflict-use-theirs"
                >
                    {t('notebooks.conflict_use_theirs', 'Use the saved version')}
                </button>
            </div>
        </section>
    );
}
