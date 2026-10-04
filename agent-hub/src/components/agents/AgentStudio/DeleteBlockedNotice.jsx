import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { blockHasFindings } from './deleteBlock';

/**
 * The second stage of the delete dialog: what a 409 from DELETE /agents/:id
 * actually found, and what it could not check.
 *
 * Its own component because the two halves of that sentence must not blur into
 * one another anywhere — "three automations use this" and "I could not check the
 * automations" arrive in the same response and lead to the same button, but they
 * are not the same fact, and only one of them is a list. `summariseDeleteBlock`
 * keeps them apart; this renders them apart.
 *
 * Deliberately says out loud that deleting does NOT stop these things. An
 * agent schedule whose agent is gone falls back to a plain prompt loop, so it
 * keeps running — without the knowledge, the tools and the guardrails that
 * made its answers safe. Somebody about to press a red button is owed that.
 */
export default function DeleteBlockedNotice({ summary }) {
    const { t } = useTranslation();
    if (!summary) return null;

    // One label per consumer kind. A switch with LITERAL keys on purpose: the
    // i18n guard reads call sites, so a computed `t('agent_usage.kind_' + kind)`
    // would be invisible to it and the key could travel unchecked until it
    // turned up missing in a language nobody tested. The namespace is
    // `agent_usage`, not `agent_studio`, because the subject is what USES an
    // agent — the "Used by" tab (A5) shows the same six words on another
    // screen. A kind the server adds later falls through to its own raw name:
    // ugly and honest beats a label that quietly claims it is something else.
    const kindLabel = (kind) => {
        switch (kind) {
            case 'task': return t('agent_usage.kind_task', 'Scheduled tasks');
            case 'cowork': return t('agent_usage.kind_cowork', 'Cowork schedules');
            case 'support': return t('agent_usage.kind_support', 'Support inboxes');
            case 'automation': return t('agent_usage.kind_automation', 'Automations');
            case 'app': return t('agent_usage.kind_app', 'Apps');
            case 'webpage': return t('agent_usage.kind_webpage', 'Webpages');
            default: return kind;
        }
    };

    return (
        <div className="px-5 py-4 text-sm text-[var(--text-secondary)] space-y-3" data-testid="delete-blocked">
            {blockHasFindings(summary) ? (
                <p>{t('agent_studio.delete_blocked_intro', 'Deleting it does not stop the things below. They keep running without this agent — without its knowledge, its tools and its guardrails.')}</p>
            ) : (
                // Nothing was FOUND — which is not the same as nothing being
                // there. Saying "these things use it" over an empty list would
                // claim a scan succeeded that did not.
                <p>{t('agent_studio.delete_blocked_unknown_intro', 'The check did not finish, so what still uses this agent is unknown. Deleting now is a decision made without that answer.')}</p>
            )}
            {summary.used.length > 0 && (
                <ul className="space-y-1" data-testid="delete-blocked-used">
                    {summary.used.map((u) => (
                        <li key={u.kind} className="flex items-center justify-between gap-3">
                            <span className="text-[var(--text-primary)]">{kindLabel(u.kind)}</span>
                            <span className="tabular-nums text-[var(--text-primary)]">{u.count}</span>
                        </li>
                    ))}
                </ul>
            )}
            {summary.chatUnknown ? (
                <p className="text-[var(--text-tertiary)]" data-testid="delete-blocked-chat-unknown">
                    {t('agent_usage.others_conversations_unknown', 'Conversations by other people could not be counted.')}
                </p>
            ) : summary.othersChats > 0 && (
                <div className="flex items-center justify-between gap-3" data-testid="delete-blocked-chat">
                    <span className="text-[var(--text-primary)]">{t('agent_usage.others_conversations', 'Conversations by other people')}</span>
                    <span className="tabular-nums text-[var(--text-primary)]">{summary.othersChats}</span>
                </div>
            )}
            {summary.unchecked.length > 0 && (
                <p className="text-[var(--text-tertiary)]" data-testid="delete-blocked-unchecked">
                    {t('agent_usage.unchecked', { kinds: summary.unchecked.map((k) => kindLabel(k)).join(', ') })}
                </p>
            )}
            {!summary.readable && (
                <p className="text-[var(--text-tertiary)]" data-testid="delete-blocked-unreadable">
                    {t('agent_usage.unreadable', 'The check did not answer, so this list is not complete.')}
                </p>
            )}
        </div>
    );
}
