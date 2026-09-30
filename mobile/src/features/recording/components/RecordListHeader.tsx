/**
 * Above the meeting list: the recorder's last error, the import button, the
 * outbox, and the library's filters (or, while picking notes for a report,
 * the selection bar).
 *
 * The outbox sits ABOVE the library: between "stop" and the server's 202 the
 * phone holds the ONLY copy of the audio, so a failed upload has to be the most
 * visible thing on the screen, not a footnote under thirty finished meetings.
 * It is a handful of rows at most, so it renders inline in the list header.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Icon, Section, Text } from '@/shared/ui';

import { LibraryFilters } from './LibraryFilters';
import { OutboxRow } from './OutboxRow';
import { RecordingNotice } from './RecordingNotice';
import { SelectionBar } from './SelectionBar';
import type { Library } from '../hooks/useLibrary';
import type { RecordingNotice as Notice } from '../hooks/useRecordingRescue';
import type { PendingRecording } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing.xl, paddingBottom: theme.spacing.lg },
        rows: { gap: theme.spacing.md },
    });

export interface RecordListHeaderProps {
    error: string | null;
    onDismissError: () => void;
    /** A recording that reached the outbox without Stop, and why. */
    notice: Notice | null;
    onDismissNotice: () => void;
    importing: boolean;
    onImport: () => void;
    outbox: PendingRecording[];
    onUpload: (id: string) => void;
    onCancel: (id: string) => void;
    onEdit: (id: string) => void;
    onDiscard: (id: string) => void;
    /** How many meetings the server returned, before any filter. */
    total: number;
    library: Library;
}

function LibraryControls({ library, total }: { library: Library; total: number }) {
    const t = useTranslation();
    if (total === 0) return null;
    return (
        <>
            {library.selecting ? (
                <SelectionBar
                    count={library.selected.length}
                    onAsk={() => library.setReportOpen(true)}
                    onCancel={library.stopSelecting}
                />
            ) : (
                <LibraryFilters
                    filter={library.filter}
                    onChange={library.update}
                    tags={library.tags}
                    signedIn={Boolean(library.userId)}
                />
            )}
            <Text variant="label" tone="tertiary">
                {`${t('meetings.library', 'Library')} · ${library.rows.length}`}
            </Text>
        </>
    );
}

export function RecordListHeader(props: RecordListHeaderProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.header}>
            {props.error ? (
                <Banner
                    tone="error"
                    action={<Button label={t('meetings.dismiss', 'Dismiss')} variant="ghost" onPress={props.onDismissError} />}
                >
                    <Text variant="caption" tone="secondary">
                        {props.error}
                    </Text>
                </Banner>
            ) : null}

            {props.notice ? <RecordingNotice notice={props.notice} onDismiss={props.onDismissNotice} /> : null}

            <Button
                label={t('mobile.recording.import_file', 'Import an audio file')}
                variant="secondary"
                fullWidth
                loading={props.importing}
                onPress={props.onImport}
                icon={<Icon name="Upload" size={16} color={theme.colors.textPrimary} />}
            />

            {props.outbox.length > 0 ? (
                <Section
                    title={t('mobile.recording.outbox_title', 'On this phone')}
                    subtitle={t('mobile.recording.outbox_hint', 'Not uploaded yet. These are the only copies.')}
                >
                    <View style={styles.rows}>
                        {props.outbox.map((item) => (
                            <OutboxRow
                                key={item.id}
                                item={item}
                                onUpload={() => props.onUpload(item.id)}
                                onCancel={() => props.onCancel(item.id)}
                                onEdit={() => props.onEdit(item.id)}
                                onDiscard={() => props.onDiscard(item.id)}
                            />
                        ))}
                    </View>
                </Section>
            ) : null}

            <LibraryControls library={props.library} total={props.total} />
        </View>
    );
}
