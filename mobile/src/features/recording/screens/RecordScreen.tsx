/**
 * The Meeting Notes tab — the one thing this app does that a browser tab cannot.
 *
 * The tab has three jobs, in this order of priority:
 *
 *   1. Start recording in one tap. Someone opening this screen is usually in a
 *      room where a meeting has already started, so the capture control is the
 *      first thing under the header and never behind a menu.
 *   2. Show what has not been uploaded yet — the only copies that exist.
 *   3. List past meetings and their state, with the web library's search,
 *      sort, owner and tag filters. Everything else Meeting Notes has
 *      (upcoming meetings, imports, rules, templates, the AI report) sits
 *      in the header's menu.
 *
 * While recording, the tab becomes the recorder — the list and the header are
 * gone. For the next hour nothing else on this screen is anything but a
 * mis-tap risk.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { BatteryHint } from '../components/BatteryHint';
import { CaptureDetailsSheet } from '../components/CaptureDetailsSheet';
import { LiveRecorder } from '../components/LiveRecorder';
import { MeetingLibraryList } from '../components/MeetingLibraryList';
import { RecordListHeader } from '../components/RecordListHeader';
import { RecordStartBar } from '../components/RecordStartBar';
import { RecordToolsMenu } from '../components/RecordToolsMenu';
import { ReportSheet } from '../components/ReportSheet';
import { useTranscriptions } from '../hooks/queries';
import { useLibrary } from '../hooks/useLibrary';
import { useRecordTab } from '../hooks/useRecordTab';
import { isReportable } from '../model/library';

export function RecordScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const tab = useRecordTab();
    const { recorder, outbox, onAccepted, editing } = tab;
    const query = useTranscriptions();
    const meetings = query.data ?? [];
    const library = useLibrary(meetings);
    const [menuOpen, setMenuOpen] = useState(false);

    if (recorder.active || recorder.phase === 'preparing') {
        return (
            <Screen edges={['top', 'bottom']}>
                <BatteryHint />
                <LiveRecorder
                    recorder={recorder}
                    onStop={() => void tab.stop()}
                    onDiscard={() => void recorder.discard()}
                    saving={tab.saving || recorder.phase === 'preparing'}
                />
            </Screen>
        );
    }

    const header = (
        <RecordListHeader
            error={recorder.error}
            onDismissError={recorder.clearError}
            notice={tab.notice}
            onDismissNotice={tab.dismissNotice}
            importing={tab.importing}
            onImport={() => void tab.importAudio()}
            outbox={outbox.items}
            onUpload={(id) => void outbox.upload(id, onAccepted)}
            onCancel={outbox.cancel}
            onEdit={(id) => tab.setEditing({ id, fresh: false })}
            onDiscard={(id) => void outbox.discard(id)}
            total={meetings.length}
            library={library}
        />
    );

    return (
        <Screen edges={['top']}>
            <ScreenHeader
                size="large"
                title={t('studio.tab.meeting_notes', 'Meeting Notes')}
                subtitle={t('studio.tab.meeting_notes_desc', 'Transcripts, speakers and actions')}
                actions={
                    <IconButton
                        icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.recording.tools', 'Meeting notes tools')}
                        onPress={() => setMenuOpen(true)}
                    />
                }
            />
            <RecordStartBar
                recorder={recorder}
                requesting={tab.requesting}
                onRequestPermission={() => void tab.requestPermission()}
            />
            {query.isLoading ? (
                <ListSkeleton />
            ) : (
                <MeetingLibraryList query={query} library={library} total={meetings.length} header={header} />
            )}
            <CaptureDetailsSheet
                draft={tab.draft}
                fresh={Boolean(editing?.fresh)}
                onChange={(patch) => tab.draft && outbox.updateSettings(tab.draft.id, patch)}
                onTranscribe={() => {
                    const id = tab.draft?.id;
                    tab.setEditing(null);
                    if (id) void outbox.upload(id, onAccepted);
                }}
                onClose={() => tab.setEditing(null)}
            />
            <RecordToolsMenu
                visible={menuOpen}
                onClose={() => setMenuOpen(false)}
                canReport={meetings.filter(isReportable).length > 1}
                onReport={library.startSelecting}
            />
            <ReportSheet
                visible={library.reportOpen}
                meetings={library.selectedMeetings}
                onClose={() => library.setReportOpen(false)}
            />
        </Screen>
    );
}
