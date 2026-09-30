// At most ONE gentle compliance hint in a project, for the people who can act
// on it (owner; an editor for unscanned files). Never in the chat or document
// views, never a modal or a toast: a quiet strip the reader can open, put off
// for 7 or 30 days, or dismiss — stored on the server, so it stays dismissed
// on every device. No hint (or a failed read) renders nothing at all; there is
// no "all good" badge.
//
// `onOpenTab(tab)` lets the host switch the workspace section in place (the
// hint's target is `/app/projects/<id>[/<tab>]`); without it the link is a
// plain navigation. `here` is the section the hint stands on: a hint whose
// target is that same section gets no Review, which would go nowhere.

import { Info, X } from 'lucide-react';
import React from 'react';
import {
    useDecideProjectComplianceHint, useProjectComplianceHint, type HintDecision,
} from '../../../api/queries/projectComplianceHints';
import type { ProjectRole } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';

const FALLBACK: Record<string, string> = {
    project_foreign_members: 'Members from outside your organisation ({count})',
    project_dangling_members: 'Memberships of accounts or groups that no longer exist ({count})',
    project_orphaned_content: 'Items that belong to people who have left ({count})',
    project_files_unscanned: 'Files not yet checked for personal data ({count})',
};

/** The workspace tab a hint target points at, or null for the project's overview. */
export function tabOfTarget(target: string, projectId: string): string | null {
    const prefix = `/app/projects/${projectId}`;
    if (!target.startsWith(prefix)) return null;
    const rest = target.slice(prefix.length).replace(/^\/+/, '');
    return rest ? rest.split('/')[0] : 'overview';
}

const LINK = 'inline-flex items-center h-7 px-2 rounded-[8px] text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-60';

export default function ProjectComplianceHint({ projectId, role, onOpenTab, here }: {
    projectId: string;
    role: ProjectRole | null | undefined;
    onOpenTab?: (tab: string) => void;
    /** The workspace section this strip is shown on (e.g. 'overview'). */
    here?: string;
}) {
    const { t } = useTranslation();
    const canAct = role === 'owner' || role === 'editor';
    const query = useProjectComplianceHint(projectId, { enabled: canAct });
    const decide = useDecideProjectComplianceHint(projectId);
    const hint = canAct ? query.data?.hint ?? null : null;
    // A refused dismiss or snooze puts the hint back (the mutation restores
    // it), so the quiet note has to live INSIDE the strip, next to the buttons
    // the person just pressed — outside it, it could never show.
    const failed = decide.isError ? (
        <p role="status" className="m-0 w-full text-[11px] text-[var(--text-tertiary)]" data-testid="project-compliance-hint-failed">
            {t('compliance.project_hint.failed', 'That did not save. Try again.')}
        </p>
    ) : null;
    if (!hint) return failed;

    const title = t(hint.titleKey, FALLBACK[hint.key] || hint.key, { count: hint.params.count });
    const put = (decision: HintDecision) => decide.mutate({ hintKey: hint.key, decision });
    const tab = tabOfTarget(hint.action.target, projectId);
    const goesNowhere = !!onOpenTab && !!here && tab === here;
    const review = () => {
        if (onOpenTab && tab) onOpenTab(tab);
        // Only a path inside the app: never another origin, whatever the answer says.
        else if (/^\/app\//.test(hint.action.target)) window.location.assign(hint.action.target);
    };

    return (
        <section
            aria-label={t('compliance.project_hint.aria', 'Suggestion for this project')}
            data-testid="project-compliance-hint"
            data-hint={hint.key}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5"
        >
            <Info size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="min-w-0 flex-1 text-[12px] text-[var(--text-primary)]">{title}</span>
            {!goesNowhere && (
                <button type="button" className={`${LINK} text-[var(--text-primary)] font-semibold`} onClick={review} data-testid="project-compliance-hint-review">
                    {t('compliance.project_hint.review', 'Review')}
                </button>
            )}
            <button type="button" className={LINK} disabled={decide.isPending} onClick={() => put({ kind: 'snooze', days: 7 })} data-testid="project-compliance-hint-snooze-7">
                {t('compliance.project_hint.snooze_7', 'Remind me in 7 days')}
            </button>
            <button type="button" className={LINK} disabled={decide.isPending} onClick={() => put({ kind: 'snooze', days: 30 })} data-testid="project-compliance-hint-snooze-30">
                {t('compliance.project_hint.snooze_30', 'Remind me in 30 days')}
            </button>
            <button
                type="button"
                className={`${LINK} w-7 justify-center px-0`}
                disabled={decide.isPending}
                onClick={() => put({ kind: 'dismiss' })}
                aria-label={t('compliance.project_hint.dismiss', 'Dismiss')}
                title={t('compliance.project_hint.dismiss', 'Dismiss')}
                data-testid="project-compliance-hint-dismiss"
            >
                <X size={13} aria-hidden="true" />
            </button>
            {failed}
        </section>
    );
}
