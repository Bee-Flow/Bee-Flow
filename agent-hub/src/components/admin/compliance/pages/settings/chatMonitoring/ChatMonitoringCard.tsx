import { QueryClientContext } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import React, { useContext, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import useConfirm from '../../../../../shared/useConfirm';
import {
    refusalOf, useChatMonitoringConfig, useDeleteChatMonitoringCounts, type ChatMonitoringConfig,
} from '../../../data/useChatMonitoring';
import { useDateFormat } from '../../../shared/formatDates';
import { ActionButton, StatusPill } from './formAtoms';
import ChatMonitoringIntro from './ChatMonitoringIntro';
import ChatMonitoringSetup from './ChatMonitoringSetup';
import ChatMonitoringStatus from './ChatMonitoringStatus';

/**
 * Chat signals (optional): a card of its own in Compliance Settings, below
 * the framework groups, with its own route and its own Save. Not a settings
 * group: none of its columns travel through the generic settings form.
 *
 * Off, it explains what chat signals are and are not, with the legal
 * caveat, and offers "Set up". On or scheduled, it says since or from when,
 * what is counted, what is paused, and offers the figures, "Change" and
 * "Switch off". A server without the route (an older version, the public
 * demo) shows no card at all.
 *
 * The card reads through React Query. The app and the demo both mount a
 * QueryClientProvider; a tree without one (the settings form's own unit
 * test) gets no card rather than a crash.
 */

export interface ChatMonitoringCardProps {
    /** The organisation's name, for the notice template; null leaves a gap to fill in. */
    orgName?: string | null;
    /** Opens the GDPR framework page, where the chat-signals checks live. */
    onOpenChecks?: (() => void) | null;
}

function HeaderPill({ config }: { config: ChatMonitoringConfig | undefined }) {
    const { t } = useTranslation();
    const { formatDay } = useDateFormat();
    if (!config?.settings.enabled || config.effective.state === 'off') {
        return <StatusPill testId="cm-state-pill">{t('chat_monitoring.state_off', 'Off')}</StatusPill>;
    }
    if (config.effective.state === 'scheduled') {
        return <StatusPill tone="warning" testId="cm-state-pill">{t('chat_monitoring.starts_on', 'Starts on {date}', { date: formatDay(config.effective.from) })}</StatusPill>;
    }
    return <StatusPill testId="cm-state-pill">{t('chat_monitoring.on_since', 'On since {date}', { date: formatDay(config.effective.from) })}</StatusPill>;
}

function OffView({ config, onSetUp }: { config: ChatMonitoringConfig; onSetUp: () => void }) {
    const { t } = useTranslation();
    const remove = useDeleteChatMonitoringCounts();
    const { confirm, confirmDialog } = useConfirm();
    // Configured before: counts may still be kept until their retention ends.
    const hadCounts = config.settings.surfaces.length > 0;
    const deleteCounts = async () => {
        const ok = await confirm({
            title: t('chat_monitoring.delete_counts', 'Delete collected counts'),
            description: t('chat_monitoring.delete_confirm', 'Delete all collected chat signal counts for this organisation? This cannot be undone.'),
            confirmLabel: t('chat_monitoring.delete_counts', 'Delete collected counts'),
            cancelLabel: t('chat_monitoring.cancel', 'Cancel'),
            destructive: true,
        });
        if (ok) remove.mutate();
    };
    return (
        <div className="flex flex-col gap-3" data-testid="cm-off">
            <ChatMonitoringIntro />
            <div className="flex flex-wrap items-center gap-2">
                <ActionButton variant="primary" onClick={onSetUp} data-testid="cm-set-up">{t('chat_monitoring.set_up', 'Set up')}</ActionButton>
                {hadCounts && (
                    <ActionButton size="sm" variant="error" onClick={() => { void deleteCounts(); }} disabled={remove.isPending} data-testid="cm-delete-counts">
                        {t('chat_monitoring.delete_counts', 'Delete collected counts')}
                    </ActionButton>
                )}
            </div>
            {remove.isSuccess && <p role="status" className="m-0 text-[11px] text-[var(--text-secondary)]" data-testid="cm-deleted">{t('chat_monitoring.deleted', 'Collected counts deleted.')}</p>}
            {remove.isError && <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]">{t('chat_monitoring.err_generic', 'Could not save. Try again.')}</p>}
            {confirmDialog}
        </div>
    );
}

function CardBody({ orgName = null, onOpenChecks = null }: ChatMonitoringCardProps) {
    const { t } = useTranslation();
    const query = useChatMonitoringConfig();
    const [editing, setEditing] = useState(false);
    if (query.isError && refusalOf(query.error).status === 404) return null;
    const config = query.data;

    let body: React.ReactNode;
    if (query.isPending) {
        body = <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="cm-loading">{t('chat_monitoring.loading', 'Reading the chat-signals settings…')}</p>;
    } else if (!config) {
        body = (
            <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]" data-testid="cm-read-failed">
                <span>{t('chat_monitoring.read_failed', 'The chat-signals settings could not be read.')}</span>
                <ActionButton size="sm" onClick={() => { void query.refetch(); }}>{t('chat_monitoring.retry', 'Try again')}</ActionButton>
            </div>
        );
    } else if (editing) {
        body = <ChatMonitoringSetup config={config} orgName={orgName} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />;
    } else if (config.settings.enabled) {
        body = <ChatMonitoringStatus config={config} onChange={() => setEditing(true)} onOpenChecks={onOpenChecks} />;
    } else {
        body = <OffView config={config} onSetUp={() => setEditing(true)} />;
    }

    return (
        <section className="shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] px-3.5 py-3 flex flex-col gap-3" data-testid="chat-monitoring-card">
            <header className="flex flex-wrap items-center gap-2">
                <MessagesSquare size={15} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                <h3 className="m-0 flex-1 text-sm font-bold text-[var(--text-primary)]">{t('chat_monitoring.title', 'Chat signals (optional)')}</h3>
                {config && <HeaderPill config={config} />}
            </header>
            {body}
        </section>
    );
}

export default function ChatMonitoringCard(props: ChatMonitoringCardProps) {
    const client = useContext(QueryClientContext);
    if (!client) return null;
    return <CardBody {...props} />;
}
