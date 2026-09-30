/**
 * The per-device notification choices: on or off, sound, which of the
 * server's six categories, and how often to poll. Stored on this phone — the
 * server has no notification-preference table.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import {
    CATEGORY_LABELS,
    NOTIFICATION_CATEGORIES,
    POLL_INTERVALS,
    type NotificationCategory,
    type NotificationPrefs,
} from '@/features/notifications';
import { Group, Icon, OptionRow, ToggleRow } from '@/shared/ui';

export function NotificationPrefsGroups({
    prefs,
    onChange,
    onCategory,
}: {
    prefs: NotificationPrefs;
    onChange: (patch: Partial<NotificationPrefs>) => void;
    onCategory: (category: NotificationCategory, value: boolean) => void;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const off = !prefs.enabled;
    return (
        <>
            <Group
                title={t('mobile.notifications.notify_me', 'Notify me')}
                footer={t('mobile.notifications.per_device', 'Saved on this phone only. Your other devices keep their own choices.')}
            >
                <ToggleRow
                    label={t('mobile.notifications.show', 'Show notifications')}
                    description={t('mobile.notifications.show_hint', "Turn everything off without touching Android's settings")}
                    value={prefs.enabled}
                    onValueChange={(value) => onChange({ enabled: value })}
                    icon={<Icon name="Bell" size={16} color={theme.colors.textSecondary} />}
                />
                <ToggleRow
                    label={t('mobile.notifications.sound', 'Play a sound')}
                    description={t('mobile.notifications.sound_hint', 'Off still shows the notification, silently')}
                    value={prefs.sound}
                    disabled={off}
                    onValueChange={(value) => onChange({ sound: value })}
                    icon={<Icon name="Volume2" size={16} color={theme.colors.textSecondary} />}
                />
            </Group>

            <Group title={t('mobile.notifications.what', 'What to tell me about')}>
                {NOTIFICATION_CATEGORIES.map((category) => (
                    <ToggleRow
                        key={category}
                        label={CATEGORY_LABELS[category].label}
                        description={CATEGORY_LABELS[category].description}
                        value={prefs.categories[category]}
                        disabled={off}
                        onValueChange={(value) => onCategory(category, value)}
                    />
                ))}
            </Group>

            <Group
                title={t('mobile.notifications.how_often', 'How often to check')}
                footer={t('mobile.notifications.how_often_footer', 'Checking less often saves battery. Android may check less often than you choose while the app is closed.')}
            >
                {POLL_INTERVALS.map((interval) => (
                    <OptionRow
                        key={interval.seconds}
                        label={interval.label}
                        description={interval.hint}
                        selected={prefs.pollSeconds === interval.seconds}
                        disabled={off}
                        onPress={() => onChange({ pollSeconds: interval.seconds })}
                    />
                ))}
            </Group>
        </>
    );
}
