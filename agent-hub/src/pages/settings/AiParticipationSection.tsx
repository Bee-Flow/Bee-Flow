import React, { useState } from 'react';
import { ApiError } from '../../api/client';
import { useMyAiParticipation, useSaveMyAiParticipation } from '../../api/queries/aiParticipation';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Profile › Preferences › "AI in team chats": one person's opt-out from the
 * AI that joins conversations by itself. Off means this person's messages
 * never make the AI join on its own; asking it with @ai still works, and
 * their messages still count as context when someone else asks.
 *
 * Shown only where Projects can be used (`enabled`, the host's answer from
 * useProjectsAvailable): the setting acts in project team chats and comment
 * threads, nowhere else, and the server keeps answering it either way. Also
 * hides itself on an older server without the route (404), says so when the
 * choice could not be read, and puts the switch back when a save fails.
 */
export default function AiParticipationSection({ enabled = true }: { enabled?: boolean } = {}) {
    const { t } = useTranslation();
    const query = useMyAiParticipation(enabled);
    const save = useSaveMyAiParticipation();
    const [failed, setFailed] = useState(false);
    if (!enabled) return null;
    if (query.error instanceof ApiError && query.error.status === 404) return null;

    const label = t('project_participation.me_label', 'Let the AI join in after my messages');
    const on = query.data?.autoJoinOnMyMessages !== false;
    const toggle = () => {
        setFailed(false);
        save.mutate({ autoJoinOnMyMessages: !on }, { onError: () => setFailed(true) });
    };

    return (
        <div data-testid="ai-participation-preferences">
            <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">
                {t('project_participation.me_title', 'AI in team chats')}
            </p>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5">
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">{label}</p>
                        <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                            {t('project_participation.me_desc', 'In team chats set to Auto, the AI may answer on its own when your message asks something it can help with. Turn this off and your messages never make it join by itself. You can still ask it with @ai.')}
                        </p>
                        {query.isError && (
                            <p className="text-[11px] mt-1 text-[var(--error-ink)]" role="alert">
                                {t('project_participation.me_load_failed', 'Could not load this setting.')}{' '}
                                <button type="button" className="underline" onClick={() => query.refetch()}>{t('project_participation.retry', 'Try again')}</button>
                            </p>
                        )}
                        {failed && (
                            <p className="text-[11px] mt-1 text-[var(--error-ink)]" role="alert">
                                {t('project_participation.me_save_failed', 'Could not save this setting. Try again.')}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={label}
                        disabled={!query.data || save.isPending}
                        onClick={toggle}
                        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
                    </button>
                </div>
            </div>
        </div>
    );
}
