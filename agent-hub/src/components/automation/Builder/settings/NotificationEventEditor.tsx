import React, { useMemo, useState } from 'react';
import { Bell, ChevronDown, ChevronUp, CircleCheck, CircleX, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { usePeopleDirectory, type Principal } from '../../../../api/queries/automation/people';
import PrincipalPicker from './PrincipalPicker';
import { Choice, SELECT } from './settingsUi';
import {
    CHANNELS, URGENCIES, recipientKey, toggleChannel,
    type Channel, type EventSettings, type NotificationEvent, type Recipient, type Urgency,
} from './notificationSettings';

type T = ReturnType<typeof useTranslation>['t'];

const EVENT_ICON: Record<NotificationEvent, { Icon: typeof CircleX; tone: string }> = {
    onError: { Icon: CircleX, tone: 'text-[var(--error)]' },
    onApproval: { Icon: ShieldCheck, tone: 'text-[var(--type-pause)]' },
    onSuccess: { Icon: CircleCheck, tone: 'text-[var(--success)]' },
};

export function EventIcon({ event }: { event: NotificationEvent }) {
    const { Icon, tone } = EVENT_ICON[event];
    return <Icon className={`w-3.5 h-3.5 shrink-0 ${tone}`} aria-hidden />;
}

export function eventTitle(event: NotificationEvent, t: T): string {
    if (event === 'onError') return t('automations.notify.event_error', 'Something goes wrong');
    if (event === 'onApproval') return t('automations.notify.event_approval', 'Someone must approve');
    return t('automations.notify.event_success', 'It worked');
}

/**
 * The grey half after the title: "· summary" when the event only goes into the
 * daily summary (delivery 'digest' with the summary on), "· right away" for
 * errors otherwise.
 */
export function eventQualifier(event: NotificationEvent, t: T, value?: EventSettings, digestOn = false): string {
    if (value?.delivery === 'digest' && digestOn) return t('automations.notify.event_success_when', 'summary');
    if (event === 'onError') return t('automations.notify.event_error_when', 'right away');
    return '';
}

export function channelLabel(c: Channel, t: T, short = false): string {
    if (c === 'bell') return short ? t('automations.notify.channel_bell_short', 'Bell') : t('automations.notify.channel_bell', 'Bell in Nextcloud');
    if (c === 'email') return t('automations.notify.channel_email', 'Email');
    return t('automations.notify.channel_talk', 'Talk');
}

function urgencyLabel(u: Urgency, t: T): string {
    if (u === 'silent') return t('automations.notify.urgency_silent', 'Silent');
    if (u === 'urgent') return t('automations.notify.urgency_urgent', 'Urgent');
    return t('automations.notify.urgency_normal', 'Normal');
}

/** A recipient in words. `names` resolves people and groups picked by id. */
export function recipientLabel(r: Recipient, t: T, ownerName: string, names: Map<string, string>): string {
    if (r.type === 'owner') return t('automations.notify.to_owner', '{name} (owner)', { name: ownerName });
    if (r.type === 'approver') return t('automations.notify.to_approver', 'The approver');
    const name = names.get(recipientKey(r));
    if (r.type === 'group') return name ? t('automations.notify.to_group', 'Group {name}', { name }) : t('automations.notify.to_group_unknown', 'A group');
    return name || t('automations.notify.to_person_unknown', 'A person');
}

/** Resolve people and groups picked by id to names (only fetches when needed). */
export function useRecipientNames(recipients: Recipient[], automationId: string | null | undefined): Map<string, string> {
    const needed = recipients.some(r => r.type === 'user' || r.type === 'group');
    const directory = usePeopleDirectory(automationId, { enabled: needed });
    return useMemo(() => new Map((directory.data || []).map(p => [`${p.type}:${p.id}`, p.name])), [directory.data]);
}

function summary(value: EventSettings, t: T, ownerName: string, names: Map<string, string>): string {
    if (!value.enabled || !value.channels.length) return t('automations.notify.off', 'off');
    const via = value.channels.map(c => channelLabel(c, t, true)).join(' + ');
    const to = value.recipients.map(r => recipientLabel(r, t, ownerName, names)).join(', ');
    return [via, to && t('automations.notify.summary_to', 'to {who}', { who: to }), urgencyLabel(value.urgency, t).toLowerCase()]
        .filter(Boolean).join(' · ');
}

const THROTTLE_OPTIONS: Array<number | null> = [1, 4, null];

/**
 * One event of the notification policy, as a collapsible card (5e-4):
 * Via · To · How urgent · On repeat, and an example of the message it sends.
 */
export default function NotificationEventEditor({ event, value, onChange, open, onToggle, automationId, automationTitle, ownerName }: {
    event: NotificationEvent;
    automationId: string | null | undefined;
    value: EventSettings;
    onChange: (next: EventSettings) => void;
    open: boolean;
    onToggle: () => void;
    automationTitle: string;
    ownerName: string;
}) {
    const { t } = useTranslation();
    const names = useRecipientNames(value.recipients, automationId);
    const Chevron = open ? ChevronUp : ChevronDown;
    return (
        <section className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden" data-testid={`notify-event-${event}`}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className={`w-full px-3.5 py-3 flex items-center gap-2 text-left text-xs ${open ? 'border-b border-[var(--border-default)]' : ''}`}
            >
                <EventIcon event={event} />
                <span className="font-semibold text-[var(--text-primary)]">{eventTitle(event, t)}</span>
                {!open && <span className="truncate text-[var(--text-tertiary)]">{summary(value, t, ownerName, names)}</span>}
                <Chevron className="w-3.5 h-3.5 ml-auto shrink-0 text-[var(--text-tertiary)]" aria-hidden />
            </button>
            {open && (
                <>
                    <div className="px-3.5 py-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 items-center text-xs">
                        <span className="font-medium">{t('automations.notify.via', 'Via')}</span>
                        <ViaPills value={value} onChange={onChange} />
                        <span className="font-medium">{t('automations.notify.to', 'To')}</span>
                        <RecipientPills value={value} onChange={onChange} ownerName={ownerName} names={names} automationId={automationId} />
                        <span className="font-medium">{t('automations.notify.urgency', 'How urgent')}</span>
                        <div className="justify-self-start">
                            <Choice
                                label={t('automations.notify.urgency', 'How urgent')}
                                value={value.urgency}
                                options={URGENCIES.map(u => ({ value: u, label: urgencyLabel(u, t) }))}
                                onChange={(urgency) => onChange({ ...value, urgency })}
                            />
                        </div>
                        <span className="font-medium">{t('automations.notify.repeat', 'On repeat')}</span>
                        <RepeatSelect value={value} onChange={onChange} />
                    </div>
                    <ExampleMessage event={event} title={automationTitle} />
                </>
            )}
        </section>
    );
}

interface FieldProps { value: EventSettings; onChange: (next: EventSettings) => void }
const PILL = 'px-2.5 py-1 rounded-full text-xs';

function ViaPills({ value, onChange }: FieldProps) {
    const { t } = useTranslation();
    return (
        <div className="flex gap-1.5 flex-wrap" role="group" aria-label={t('automations.notify.via', 'Via')}>
            {CHANNELS.map(c => {
                const on = value.enabled && value.channels.includes(c);
                return (
                    <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(toggleChannel(value, c))}
                        className={`${PILL} ${on
                            ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold border border-transparent'
                            : 'border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        {channelLabel(c, t, true)}
                    </button>
                );
            })}
        </div>
    );
}

function RecipientPills({ value, onChange, ownerName, names, automationId }: FieldProps & {
    ownerName: string; names: Map<string, string>; automationId: string | null | undefined;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const chosen = useMemo(() => new Set(value.recipients.map(recipientKey)), [value.recipients]);
    const add = (p: Principal) => {
        setAdding(false);
        onChange({ ...value, recipients: [...value.recipients, { type: p.type, id: p.id }] });
    };
    const remove = (r: Recipient) => onChange({ ...value, recipients: value.recipients.filter(x => recipientKey(x) !== recipientKey(r)) });
    return (
        <div className="flex gap-1.5 flex-wrap items-center">
            {value.recipients.map(r => {
                const label = recipientLabel(r, t, ownerName, names);
                return (
                    <span key={recipientKey(r)} className={`${PILL} inline-flex items-center gap-1 border border-[var(--border-default)] bg-[var(--bg-secondary)]`}>
                        {label}
                        <button
                            type="button"
                            onClick={() => remove(r)}
                            aria-label={t('automations.notify.remove_recipient', 'Remove {name}', { name: label })}
                            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        >
                            <X className="w-3 h-3" aria-hidden />
                        </button>
                    </span>
                );
            })}
            {/* The server keeps at most 20 recipients per event. */}
            {value.recipients.length >= 20 ? null : adding ? (
                <div className="w-64"><PrincipalPicker automationId={automationId} onPick={add} exclude={chosen} autoFocus /></div>
            ) : (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className={`${PILL} border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]`}
                >
                    {t('automations.notify.add_recipient', '+ add')}
                </button>
            )}
        </div>
    );
}

function throttleLabel(n: number | null, t: T): string {
    if (n == null) return t('automations.notify.repeat_every', 'Every time');
    if (n === 1) return t('automations.notify.repeat_once_hour', 'once per hour');
    return t('automations.notify.repeat_n_hour', '{n} times per hour', { n });
}

function RepeatSelect({ value, onChange }: FieldProps) {
    const { t } = useTranslation();
    const limited = value.throttle.maxPerHour != null;
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {limited && <span>{t('automations.notify.repeat_prefix', 'No more than')}</span>}
            <select
                aria-label={t('automations.notify.repeat', 'On repeat')}
                value={limited ? String(value.throttle.maxPerHour) : ''}
                onChange={(e) => onChange({ ...value, throttle: { maxPerHour: e.target.value ? Number(e.target.value) : null } })}
                className={`${SELECT} px-2.5`}
            >
                {THROTTLE_OPTIONS.map(n => (
                    <option key={String(n)} value={n == null ? '' : String(n)}>{throttleLabel(n, t)}</option>
                ))}
            </select>
            {limited && <span className="text-[var(--text-tertiary)]">{t('automations.notify.repeat_suffix', 'then bundled')}</span>}
        </div>
    );
}

function ExampleMessage({ event, title }: { event: NotificationEvent; title: string }) {
    const { t } = useTranslation();
    const { tone } = EVENT_ICON[event];
    const heading = event === 'onError' ? t('automations.notify.example_error_title', '{title} has stopped', { title })
        : event === 'onApproval' ? t('automations.notify.example_approval_title', '{title} needs your approval', { title })
            : t('automations.notify.example_success_title', '{title} is done', { title });
    const body = event === 'onError' ? t('automations.notify.example_error_body', 'A step could not finish.')
        : event === 'onApproval' ? t('automations.notify.example_approval_body', 'A step is waiting for your decision.')
            : t('automations.notify.example_success_body', 'All steps went well.');
    const link = event === 'onError' ? t('automations.notify.example_error_link', 'View and fix')
        : event === 'onApproval' ? t('automations.notify.example_approval_link', 'Open and decide')
            : t('automations.notify.example_success_link', 'View the run');
    return (
        <div className="mx-3.5 mb-3.5 px-3 py-2.5 rounded-[10px] bg-[var(--bg-secondary)] flex gap-2.5 text-xs" data-testid="notify-example">
            <div className={`w-[30px] h-[30px] rounded-lg bg-[var(--bg-card)] grid place-items-center shrink-0 ${tone}`}>
                <Bell className="w-3.5 h-3.5" aria-hidden />
            </div>
            <div className="min-w-0">
                <div className="text-[10px] tracking-[.06em] uppercase font-semibold text-[var(--text-tertiary)]">{t('automations.notify.example', 'Example')}</div>
                <div className="font-semibold text-[var(--text-primary)]">{heading}</div>
                <div className="text-[var(--text-secondary)]">{body} <span className="underline">{link}</span></div>
            </div>
        </div>
    );
}
