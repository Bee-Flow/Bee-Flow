/**
 * One event of the notification policy as a collapsible card — the web's
 * NotificationEventEditor: via which channels, to whom, how urgent, what
 * happens on repeat, and an example of the message it sends. Collapsed, it
 * says all of that in one line.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ApprovalDirectory } from '@/features/flow-editor/api';
import { directoryOptions } from '@/features/flow-editor/components/editors/approval/approvalModel';
import { SelectField } from '@/features/flow-editor/components/fields';
import { Chip, Icon, Text, type IconName } from '@/shared/ui';

import {
    addRecipient, CHANNELS, channelLabel, eventSummary, eventTitle, exampleMessage, MAX_RECIPIENTS, recipientKey, recipientLabel,
    removeRecipient, THROTTLE_OPTIONS, throttleLabel, toggleChannel, URGENCIES, urgencyLabel,
    type EventSettings, type NotificationEvent, type Urgency,
} from './notificationsModel';

const makeStyles = (theme: Theme) => ({
    card: { borderTopWidth: 1, borderTopColor: theme.colors.borderDefault } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, padding: theme.spacing.lg, minHeight: theme.minTouch } satisfies ViewStyle,
    headWords: { flex: 1, gap: 2 } satisfies ViewStyle,
    body: { gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg } satisfies ViewStyle,
    section: { gap: theme.spacing.xs } satisfies ViewStyle,
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs } satisfies ViewStyle,
    example: { flexDirection: 'row', gap: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgSecondary } satisfies ViewStyle,
    exampleWords: { flex: 1, gap: 2 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    tones: { onError: theme.colors.errorInk, onApproval: theme.stepType.pause, onSuccess: theme.colors.successInk },
});

const EVENT_ICON: Record<NotificationEvent, IconName> = { onError: 'CircleX', onApproval: 'ShieldCheck', onSuccess: 'CircleCheck' };

/** The event's glyph in its tone (error red, approval amber, success green). */
export function EventIcon({ event }: { event: NotificationEvent }) {
    const styles = useThemedStyles(makeStyles);
    return <Icon name={EVENT_ICON[event]} size={14} color={styles.tones[event]} />;
}

interface FieldProps {
    value: EventSettings;
    onChange: (next: EventSettings) => void;
    disabled: boolean;
}

function ViaChips({ value, onChange, disabled }: FieldProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.chips} accessibilityLabel={t('routines.notify.via', 'Via')}>
            {CHANNELS.map((c) => (
                <Chip key={c} label={channelLabel(c, t, true)} selected={value.enabled && value.channels.includes(c)} disabled={disabled} onPress={() => onChange(toggleChannel(value, c))} />
            ))}
        </View>
    );
}

function Recipients({ value, onChange, disabled, ownerName, names, directory }: FieldProps & {
    ownerName: string; names: ReadonlyMap<string, string>; directory: ApprovalDirectory | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const chosen = new Set(value.recipients.map((r) => (r.type === 'user' ? `u:${r.id}` : r.type === 'group' ? `g:${r.id}` : r.type)));
    const options = directoryOptions(directory, t('mobile.flow.approval.groups', 'Groups')).filter((o) => !chosen.has(o.value));
    return (
        <View style={styles.section}>
            <Text variant="label" tone="secondary">{t('routines.notify.to', 'To')}</Text>
            <View style={styles.chips}>
                {value.recipients.map((r) => {
                    const label = recipientLabel(r, t, ownerName, names);
                    return (
                        <Chip
                            key={recipientKey(r)}
                            label={label}
                            icon={<Icon name="X" size={12} color={styles.glyph.color} />}
                            onPress={() => onChange(removeRecipient(value, r))}
                            disabled={disabled}
                            accessibilityHint={t('routines.notify.remove_recipient', 'Remove {name}', { name: label })}
                        />
                    );
                })}
            </View>
            {value.recipients.length < MAX_RECIPIENTS && options.length ? (
                <SelectField
                    value=""
                    options={options}
                    onChange={(picked) => onChange(addRecipient(value, picked))}
                    prompt={t('routines.notify.add_recipient', '+ add')}
                    disabled={disabled}
                />
            ) : null}
        </View>
    );
}

function Example({ event, title }: { event: NotificationEvent; title: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const words = exampleMessage(event, title, t);
    return (
        <View style={styles.example} testID="notify-example">
            <Icon name="Bell" size={14} color={styles.tones[event]} />
            <View style={styles.exampleWords}>
                <Text variant="label" tone="tertiary">{t('routines.notify.example', 'Example')}</Text>
                <Text variant="body">{words.heading}</Text>
                <Text variant="caption" tone="secondary">{`${words.body} ${words.link}`}</Text>
            </View>
        </View>
    );
}

export interface NotificationEventDetailsProps extends FieldProps {
    event: NotificationEvent;
    open: boolean;
    onToggle: () => void;
    automationTitle: string;
    ownerName: string;
    names: ReadonlyMap<string, string>;
    directory: ApprovalDirectory | null;
}

export function NotificationEventDetails({ event, value, onChange, disabled, open, onToggle, automationTitle, ownerName, names, directory }: NotificationEventDetailsProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const throttle = value.throttle.maxPerHour;
    return (
        <View style={styles.card} testID={`notify-event-${event}`}>
            <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.head}>
                <EventIcon event={event} />
                <View style={styles.headWords}>
                    <Text variant="body">{eventTitle(event, t)}</Text>
                    {open ? null : <Text variant="caption" tone="tertiary" numberOfLines={1}>{eventSummary(value, t, ownerName, names)}</Text>}
                </View>
                <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={16} color={styles.glyph.color} />
            </Pressable>
            {open ? (
                <View style={styles.body}>
                    <View style={styles.section}>
                        <Text variant="label" tone="secondary">{t('routines.notify.via', 'Via')}</Text>
                        <ViaChips value={value} onChange={onChange} disabled={disabled} />
                    </View>
                    <Recipients value={value} onChange={onChange} disabled={disabled} ownerName={ownerName} names={names} directory={directory} />
                    <SelectField
                        label={t('routines.notify.urgency', 'How urgent')}
                        value={value.urgency}
                        options={URGENCIES.map((u) => ({ value: u, label: urgencyLabel(u, t) }))}
                        onChange={(urgency) => onChange({ ...value, urgency: urgency as Urgency })}
                        disabled={disabled}
                    />
                    <SelectField
                        label={t('routines.notify.repeat', 'On repeat')}
                        hint={throttle != null ? `${t('routines.notify.repeat_prefix', 'No more than')} ${throttleLabel(throttle, t)} ${t('routines.notify.repeat_suffix', 'then bundled')}` : null}
                        value={throttle == null ? '' : String(throttle)}
                        options={THROTTLE_OPTIONS.map((n) => ({ value: n == null ? '' : String(n), label: throttleLabel(n, t) }))}
                        onChange={(next) => onChange({ ...value, throttle: { maxPerHour: next ? Number(next) : null } })}
                        disabled={disabled}
                    />
                    <Example event={event} title={automationTitle} />
                </View>
            ) : null}
        </View>
    );
}
