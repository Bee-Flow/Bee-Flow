/**
 * The Meeting Notes tab's overflow menu: every library tool that is not recording
 * itself. On the web these are the rail's Upcoming segment, the capture
 * modal's import panels, the rules panel, the templates settings and the AI
 * report; on a phone they sit one tap behind the header so the tab keeps its
 * one job in front — start recording.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ActionMenu, type ActionMenuItem } from '@/shared/ui';

export function RecordToolsMenu({
    visible,
    onClose,
    canReport,
    onReport,
}: {
    visible: boolean;
    onClose: () => void;
    /** At least two finished notes: a report over one is just the note. */
    canReport: boolean;
    onReport: () => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const items: ActionMenuItem[] = [
        {
            id: 'upcoming',
            label: t('mobile.recording.tools_upcoming', 'Upcoming meetings'),
            icon: 'CalendarClock',
            onPress: () => router.push('/upcoming-meetings'),
        },
        {
            id: 'import',
            label: t('mobile.recording.tools_import', 'Import from Nextcloud or Google Meet'),
            icon: 'Import',
            onPress: () => router.push('/meeting-imports'),
        },
        {
            id: 'report',
            label: t('meetings.ai_report', 'AI report'),
            icon: 'Sparkles',
            disabled: !canReport,
            onPress: onReport,
        },
        {
            id: 'rules',
            label: t('mobile.recording.tools_rules', 'Rules'),
            icon: 'Workflow',
            onPress: () => router.push('/meeting-rules'),
        },
        {
            id: 'templates',
            label: t('meeting_notes.template_personal_title', 'My summary templates'),
            icon: 'LayoutTemplate',
            onPress: () => router.push('/meeting-templates'),
        },
    ];
    return <ActionMenu visible={visible} onClose={onClose} title={t('meetings.title', 'Meeting notes')} items={items} />;
}
