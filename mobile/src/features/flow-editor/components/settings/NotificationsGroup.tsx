/**
 * Settings › Notifications — the web's NotificationsSection: one overview of
 * when a run alerts someone (something goes wrong, someone must approve, it
 * worked), through which channels and to whom; under "details" each event's
 * urgency, repeat limit, recipients and an example message, and the daily
 * summary. Errors and approvals notify by default; success stays out of the
 * bell. Each change is a draft edit (notificationSettings lives in the
 * definition): one undo step, saved by the autosave, refused while the AI builds.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useDraftState, usePrincipals } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { Chip, Group, Icon, Switch, Text } from '@/shared/ui';

import { EventIcon, NotificationEventDetails } from './NotificationEventDetails';
import {
    CHANNELS, channelLabel, directoryNames, eventQualifier, eventTitle, EVENTS, normalizeNotificationSettings, toggleChannel, whoLine,
    withNotificationSettings, type EventSettings, type NotificationEvent, type NotificationSettings,
} from './notificationsModel';

const makeStyles = (theme: Theme) => ({
    row: { gap: theme.spacing.sm, padding: theme.spacing.lg } satisfies ViewStyle,
    divided: { borderTopWidth: 1, borderTopColor: theme.colors.borderDefault } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    title: { flex: 1 } satisfies ViewStyle,
    who: { maxWidth: '45%' } satisfies ViewStyle,
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs, paddingLeft: theme.spacing.xl } satisfies ViewStyle,
    toggle: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, padding: theme.spacing.lg, minHeight: theme.minTouch } satisfies ViewStyle,
    toggleWords: { flex: 1 } satisfies ViewStyle,
    digest: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, padding: theme.spacing.lg } satisfies ViewStyle,
    digestWords: { flex: 1, gap: 2 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});

interface RowProps {
    event: NotificationEvent;
    value: EventSettings;
    digestOn: boolean;
    ownerName: string;
    names: ReadonlyMap<string, string>;
    disabled: boolean;
    onChange: (next: EventSettings) => void;
}

/** One event of the overview: its name, who gets it, and a box per channel. */
function OverviewRow({ event, value, digestOn, ownerName, names, disabled, onChange }: RowProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const title = eventTitle(event, t);
    const qualifier = eventQualifier(event, t, value, digestOn);
    const who = whoLine(value, t, ownerName, names);
    return (
        <View style={[styles.row, event === EVENTS[0] ? null : styles.divided]} testID={`notify-${event}`}>
            <View style={styles.head}>
                <EventIcon event={event} />
                <Text variant="body" numberOfLines={1} style={styles.title}>{qualifier ? `${title} · ${qualifier}` : title}</Text>
                <Text variant="caption" tone={who ? 'secondary' : 'tertiary'} numberOfLines={1} style={styles.who}>{who || '·'}</Text>
            </View>
            <View style={styles.chips}>
                {CHANNELS.map((c) => (
                    <Chip
                        key={c}
                        label={channelLabel(c, t, true)}
                        selected={value.enabled && value.channels.includes(c)}
                        onPress={() => onChange(toggleChannel(value, c))}
                        disabled={disabled}
                        accessibilityHint={t('automations.notify.cell_label', '{event} via {channel}', { event: title, channel: channelLabel(c, t) })}
                        testID={`notify-${event}-${c}`}
                    />
                ))}
            </View>
        </View>
    );
}

function DigestRow({ settings, disabled, onChange }: { settings: NotificationSettings; disabled: boolean; onChange: (next: NotificationSettings) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { enabled, time } = settings.digest;
    return (
        <View style={[styles.digest, styles.divided]}>
            <Icon name="Newspaper" size={14} color={styles.glyph.color} />
            <View style={styles.digestWords}>
                <Text variant="body">{t('automations.notify.digest', 'Daily summary')}</Text>
                <Text variant="caption" tone="tertiary">
                    {t('automations.notify.digest_hint', 'At {time} one message: how many runs, what failed, what is still waiting', { time })}
                </Text>
            </View>
            <Switch
                value={enabled}
                onValueChange={(next) => onChange({ ...settings, digest: { ...settings.digest, enabled: next } })}
                disabled={disabled}
                accessibilityLabel={t('automations.notify.digest', 'Daily summary')}
                testID="notify-digest"
            />
        </View>
    );
}

export function NotificationsGroup({ store, title, automationId, ownerId }: {
    store: DraftStore; title: string; automationId: string | null; ownerId?: string | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [details, setDetails] = useState(false);
    const [openEvent, setOpenEvent] = useState<NotificationEvent | null>('onError');
    const stored = useDraftState(store, (s) => s.definition?.notificationSettings);
    const locked = useDraftState(store, (s) => s.locked || !s.ready);
    const directory = usePrincipals(automationId).data ?? null;
    const settings = normalizeNotificationSettings(stored);
    const names = directoryNames(directory);
    const ownerName = directory?.members.find((m) => m.id === ownerId)?.name || t('automations.notify.owner_fallback', 'Owner');
    const automationTitle = title.trim() || t('automations.notify.this_automation', 'This automation');
    const commit = (next: NotificationSettings) => store.getState().applyOp((def) => withNotificationSettings(def, next));
    const setEvent = (event: NotificationEvent, value: EventSettings) => commit({ ...settings, [event]: value });
    return (
        <Group title={t('automations.notify.title', 'Notifications')} footer={t('automations.notify.default_note', 'default: only on errors and approvals, so your bell stays quiet')}>
            {EVENTS.map((event) => (
                <OverviewRow
                    key={event}
                    event={event}
                    value={settings[event]}
                    digestOn={settings.digest.enabled}
                    ownerName={ownerName}
                    names={names}
                    disabled={locked}
                    onChange={(v) => setEvent(event, v)}
                />
            ))}
            <Pressable onPress={() => setDetails((d) => !d)} accessibilityRole="button" accessibilityState={{ expanded: details }} style={[styles.toggle, styles.divided]} testID="notify-details">
                <Icon name={details ? 'ChevronDown' : 'ChevronRight'} size={14} color={styles.glyph.color} />
                <Text variant="caption" tone="tertiary" style={styles.toggleWords}>
                    {t('automations.notify.details_toggle', 'How urgent (silent · normal · urgent) and a daily summary instead of separate notifications')}
                </Text>
            </Pressable>
            {details ? EVENTS.map((event) => (
                <NotificationEventDetails
                    key={event}
                    event={event}
                    value={settings[event]}
                    onChange={(v) => setEvent(event, v)}
                    disabled={locked}
                    open={openEvent === event}
                    onToggle={() => setOpenEvent((o) => (o === event ? null : event))}
                    automationTitle={automationTitle}
                    ownerName={ownerName}
                    names={names}
                    directory={directory}
                />
            )) : null}
            {details ? <DigestRow settings={settings} disabled={locked} onChange={commit} /> : null}
        </Group>
    );
}
