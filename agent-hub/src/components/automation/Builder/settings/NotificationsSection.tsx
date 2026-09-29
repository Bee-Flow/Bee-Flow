import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Newspaper } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAutomationShares } from '../../../../api/queries/automation/people';
import NotificationEventEditor, {
    EventIcon, channelLabel, eventQualifier, eventTitle, recipientLabel, useRecipientNames,
} from './NotificationEventEditor';
import {
    CHANNELS, EVENTS, normalizeNotificationSettings, toggleChannel,
    type EventSettings, type NotificationEvent, type NotificationSettings,
} from './notificationSettings';
import { SectionHeading, withDefinition, type SaveFn, type SettingsAutomation } from './settingsUi';

/*
 * The overview folds by its OWN width (@container/notify). Wide: the matrix of
 * the artboard, one column per channel. Narrow: each event is two calm lines,
 * the event and who gets it, then the channels as labelled boxes, instead of
 * five squeezed columns.
 */
const TRACKS = 'grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-center px-3.5 @[680px]/notify:grid-cols-[minmax(0,1.4fr)_110px_90px_90px_minmax(150px,1fr)] @[680px]/notify:gap-x-0';

/**
 * Settings › Notifications (artboards 5b + 5e-4): one overview of when, how
 * and to whom, and under it the per-event details (how urgent, recipients,
 * bundling) plus the daily summary. Every change saves by itself.
 */
export default function NotificationsSection({ automation, onSave }: { automation: SettingsAutomation | null; onSave: SaveFn }) {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<NotificationSettings>(() => normalizeNotificationSettings(automation?.definition?.notificationSettings));
    const [details, setDetails] = useState(false);
    const [openEvent, setOpenEvent] = useState<NotificationEvent | null>('onError');
    const [error, setError] = useState<string | null>(null);
    const shares = useAutomationShares(automation?.id);

    // A different routine, or a change from elsewhere (the AI builder), resets
    // the page to what is stored.
    const stored = automation?.definition?.notificationSettings;
    useEffect(() => {
        setSettings(normalizeNotificationSettings(stored));
    }, [automation?.id, stored]);

    const ownerName = shares.data?.owner?.name || t('routines.notify.owner_fallback', 'Owner');
    const title = automation?.title?.trim() || t('routines.notify.this_routine', 'This automation');

    const commit = async (next: NotificationSettings) => {
        setSettings(next);
        setError(null);
        try {
            await onSave(withDefinition(automation, 'notificationSettings', next));
        } catch (e) {
            setError((e as Error)?.message || t('routines.settings.save_failed', 'Could not save this change.'));
        }
    };
    const setEvent = (event: NotificationEvent, value: EventSettings) => commit({ ...settings, [event]: value });

    return (
        <div className="flex flex-col gap-3 text-xs" data-testid="notifications-section">
            <SectionHeading aside={t('routines.notify.default_note', 'default: only on errors and approvals, so your bell stays quiet')}>
                {t('routines.notify.title', 'Notifications')}
            </SectionHeading>

            <OverviewTable settings={settings} ownerName={ownerName} automationId={automation?.id} onEvent={setEvent} />

            <button
                type="button"
                onClick={() => setDetails(d => !d)}
                aria-expanded={details}
                className="self-start flex items-center gap-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
                {details ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
                {t('routines.notify.details_toggle', 'How urgent (silent · normal · urgent) and a daily summary instead of separate notifications')}
            </button>

            {details && (
                <div className="flex flex-col gap-3">
                    {EVENTS.map(event => (
                        <NotificationEventEditor
                            key={event}
                            event={event}
                            value={settings[event]}
                            onChange={(v) => setEvent(event, v)}
                            open={openEvent === event}
                            onToggle={() => setOpenEvent(o => (o === event ? null : event))}
                            automationId={automation?.id}
                            automationTitle={title}
                            ownerName={ownerName}
                        />
                    ))}
                    <DigestCard
                        enabled={settings.digest.enabled}
                        time={settings.digest.time}
                        onToggle={() => commit({ ...settings, digest: { ...settings.digest, enabled: !settings.digest.enabled } })}
                    />
                </div>
            )}

            {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
        </div>
    );
}

function OverviewTable({ settings, ownerName, automationId, onEvent }: {
    settings: NotificationSettings;
    ownerName: string;
    automationId: string | null | undefined;
    onEvent: (event: NotificationEvent, value: EventSettings) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="@container/notify rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
            <div role="table" aria-label={t('routines.notify.title', 'Notifications')}>
                <div role="row" className={`hidden @[680px]/notify:grid ${TRACKS} py-2 bg-[var(--bg-secondary)] font-semibold text-[var(--text-secondary)]`}>
                    <span role="columnheader">{t('routines.notify.when', 'When')}</span>
                    {CHANNELS.map(c => <span key={c} role="columnheader" className="text-center">{channelLabel(c, t)}</span>)}
                    <span role="columnheader">{t('routines.notify.who', 'Who')}</span>
                </div>
                {EVENTS.map((event, i) => (
                    <OverviewRow
                        first={i === 0}
                        key={event}
                        event={event}
                        value={settings[event]}
                        ownerName={ownerName}
                        automationId={automationId}
                        digestOn={settings.digest.enabled}
                        onChange={(v) => onEvent(event, v)}
                    />
                ))}
            </div>
        </div>
    );
}

function OverviewRow({ first, event, value, ownerName, automationId, digestOn, onChange }: {
    first: boolean;
    event: NotificationEvent;
    value: EventSettings;
    ownerName: string;
    automationId: string | null | undefined;
    digestOn: boolean;
    onChange: (next: EventSettings) => void;
}) {
    const { t } = useTranslation();
    const names = useRecipientNames(value.recipients, automationId);
    const title = eventTitle(event, t);
    const qualifier = eventQualifier(event, t, value, digestOn);
    const who = value.enabled && value.channels.length
        ? value.recipients.map(r => recipientLabel(r, t, ownerName, names)).join(', ')
        : '';
    return (
        // Narrow: the event and who on the first line, the channels under it
        // (the wrapper is a flex row). Wide: the wrapper dissolves (contents),
        // so each channel is a column of the matrix again.
        <div role="row" className={`grid ${TRACKS} py-3 @[680px]/notify:py-2.5 ${first ? 'border-t-0 @[680px]/notify:border-t' : 'border-t'} border-[var(--border-default)]`}>
            <span role="cell" className="flex items-center gap-2 min-w-0">
                <EventIcon event={event} />
                <span className="truncate">
                    <b className="font-semibold text-[var(--text-primary)]">{title}</b>
                    {qualifier && <span className="text-[var(--text-tertiary)]"> · {qualifier}</span>}
                </span>
            </span>
            <div className="col-span-2 row-start-2 flex flex-wrap gap-x-5 gap-y-1.5 pl-[22px] @[680px]/notify:contents">
                {CHANNELS.map(c => (
                    <span key={c} role="cell" className="@[680px]/notify:text-center">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={value.enabled && value.channels.includes(c)}
                                onChange={() => onChange(toggleChannel(value, c))}
                                aria-label={t('routines.notify.cell_label', '{event} via {channel}', { event: title, channel: channelLabel(c, t) })}
                                className="w-4 h-4 accent-[var(--accent-primary)] cursor-pointer"
                            />
                            <span aria-hidden className="text-[var(--text-secondary)] @[680px]/notify:hidden">{channelLabel(c, t, true)}</span>
                        </label>
                    </span>
                ))}
            </div>
            <span role="cell" title={who || undefined} className={`col-start-2 row-start-1 max-w-[45cqw] text-right truncate @[680px]/notify:col-start-auto @[680px]/notify:row-start-auto @[680px]/notify:max-w-none @[680px]/notify:text-left ${who ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'}`}>
                {who || '·'}
            </span>
        </div>
    );
}

function DigestCard({ enabled, time, onToggle }: { enabled: boolean; time: string; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 flex items-center gap-2.5">
            <Newspaper className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
            <div className="min-w-0">
                <div className="font-semibold text-[var(--text-primary)]">{t('routines.notify.digest', 'Daily summary')}</div>
                <div className="text-[var(--text-tertiary)]">
                    {t('routines.notify.digest_hint', 'At {time} one message: how many runs, what failed, what is still waiting', { time })}
                </div>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t('routines.notify.digest', 'Daily summary')}
                onClick={onToggle}
                className={`ml-auto relative w-[30px] h-[18px] rounded-full shrink-0 transition-colors ${enabled ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}
            >
                <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-3' : ''}`} />
            </button>
        </div>
    );
}
