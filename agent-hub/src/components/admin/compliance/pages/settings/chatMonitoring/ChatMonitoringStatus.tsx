import React, { useState } from 'react';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import useConfirm from '../../../../../shared/useConfirm';
import {
    useDeleteChatMonitoringCounts, useSaveChatMonitoring, type ChatMonitoringConfig, type PausedSurface,
} from '../../../data/useChatMonitoring';
import { useDateFormat } from '../../../shared/formatDates';
import { ActionButton, Toggle } from './formAtoms';
import { buildPutBody, formFromSettings } from './chatMonitoringForm';
import { missingLabel, signalLabel, surfaceLabel } from './chatMonitoringLabels';
import ChatMonitoringSummary from './ChatMonitoringSummary';

/**
 * Chat signals while they are on or scheduled: since when (or from when)
 * and who switched them on, what is counted, which chat types are paused
 * and why, the figures on request, and the way out: "Change", or "Switch
 * off" with the option to delete the collected counts at once.
 */

const CHIP = 'inline-flex items-center rounded-full border border-[var(--border-default)] px-2 py-[2px] text-[11px] font-medium text-[var(--text-secondary)]';

function StateLine({ config }: { config: ChatMonitoringConfig }) {
    const { t } = useTranslation();
    const { formatDay } = useDateFormat();
    const { effective, settings } = config;
    let text = t('chat_monitoring.state_off', 'Off');
    if (effective.state === 'scheduled') {
        text = t('chat_monitoring.starts_on', 'Starts on {date}', { date: formatDay(effective.from) });
    } else if (effective.state === 'on') {
        const date = formatDay(effective.from || settings.enabled_at);
        text = settings.enabled_by_name
            ? t('chat_monitoring.on_since_by', 'On since {date}, switched on by {name}', { date, name: settings.enabled_by_name })
            : t('chat_monitoring.on_since', 'On since {date}', { date });
    }
    return <p className="m-0 text-xs font-semibold text-[var(--text-primary)]" data-testid="cm-status-line" data-state={effective.state}>{text}</p>;
}

function Paused({ t, paused }: { t: TranslateFn; paused: PausedSurface }) {
    return (
        <div role="note" className="rounded-[10px] border border-[var(--warning)] px-3 py-2 text-[11px] text-[var(--text-secondary)]" data-testid={`cm-paused-${paused.surface}`}>
            <p className="m-0 font-semibold text-[var(--warning-ink)]">{t('chat_monitoring.paused', 'Paused: {surface}', { surface: surfaceLabel(t, paused.surface) })}</p>
            <p className="m-0">{t('chat_monitoring.paused_hint', 'Counting and the notice in the chat stopped together until this is fixed:')}</p>
            <ul className="m-0 pl-4 list-disc">
                {paused.missing.map((code) => <li key={code}>{missingLabel(t, code)}</li>)}
            </ul>
        </div>
    );
}

function useSwitchOff(config: ChatMonitoringConfig) {
    const { t } = useTranslation();
    const save = useSaveChatMonitoring();
    const remove = useDeleteChatMonitoringCounts();
    const { confirm, confirmDialog } = useConfirm();
    const [failed, setFailed] = useState(false);
    const switchOff = async (alsoDelete: boolean) => {
        if (alsoDelete) {
            const ok = await confirm({
                title: t('chat_monitoring.delete_counts', 'Delete collected counts'),
                description: t('chat_monitoring.delete_confirm', 'Delete all collected chat signal counts for this organisation? This cannot be undone.'),
                confirmLabel: t('chat_monitoring.delete_counts', 'Delete collected counts'),
                cancelLabel: t('chat_monitoring.cancel', 'Cancel'),
                destructive: true,
            });
            if (!ok) return;
        }
        setFailed(false);
        try {
            const now = new Date();
            await save.mutateAsync(buildPutBody(formFromSettings(config.settings, now), { enabled: false, now }));
            if (alsoDelete) await remove.mutateAsync();
        } catch {
            setFailed(true);
        }
    };
    return { switchOff, busy: save.isPending || remove.isPending, failed, confirmDialog };
}

export interface ChatMonitoringStatusProps {
    config: ChatMonitoringConfig;
    onChange: () => void;
    onOpenChecks?: (() => void) | null;
}

export default function ChatMonitoringStatus({ config, onChange, onOpenChecks = null }: ChatMonitoringStatusProps) {
    const { t } = useTranslation();
    const [alsoDelete, setAlsoDelete] = useState(false);
    const { switchOff, busy, failed, confirmDialog } = useSwitchOff(config);
    const { settings, effective } = config;
    return (
        <div className="flex flex-col gap-3" data-testid="cm-status">
            <StateLine config={config} />
            <div className="flex flex-wrap gap-1.5" data-testid="cm-status-chips">
                {settings.surfaces.map((s) => <span key={s} className={CHIP}>{surfaceLabel(t, s)}</span>)}
                {settings.signals.map((s) => <span key={s} className={CHIP}>{signalLabel(t, s)}</span>)}
            </div>
            {effective.paused.map((p) => <Paused key={p.surface} t={t} paused={p} />)}
            <ChatMonitoringSummary onOpenChecks={onOpenChecks} />
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] pt-3">
                <ActionButton size="sm" onClick={onChange} disabled={busy} data-testid="cm-change">{t('chat_monitoring.change', 'Change')}</ActionButton>
                <ActionButton size="sm" variant="error" onClick={() => { void switchOff(alsoDelete); }} disabled={busy} data-testid="cm-switch-off">
                    {t('chat_monitoring.switch_off', 'Switch off')}
                </ActionButton>
                <Toggle testId="cm-also-delete" checked={alsoDelete} onChange={setAlsoDelete} label={t('chat_monitoring.also_delete', 'Also delete the collected counts')} />
            </div>
            {failed && <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]" data-testid="cm-status-error">{t('chat_monitoring.err_generic', 'Could not save. Try again.')}</p>}
            {confirmDialog}
        </div>
    );
}
