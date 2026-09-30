/**
 * One row in a notebook's source list.
 *
 * Ingestion is asynchronous and can take a minute for a large PDF — the route
 * answers 200 the moment the bytes land and extracts, chunks and embeds on a
 * worker — so a source has a life cycle, and this row is where a person
 * watches it.
 *
 * A failed source keeps its bytes. That is why the recovery here is Retry
 * rather than "delete and add it again": routes/notebooks.js re-fetches the
 * file from storage, or re-ingests the stored text, without another upload.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow, Spinner } from '@/shared/ui';

import { SourceActions } from './SourceActions';
import { isWorking, sourceIcon, sourceSubtitle } from '../model/format';
import type { NotebookSource } from '../model/types';

const styles = StyleSheet.create({ spinner: { width: 20, alignItems: 'center' } });

export function SourceRow({
    source,
    onPress,
    onRetry,
    onCancel,
    onDelete,
    onLongPress,
}: {
    source: NotebookSource;
    onPress?: () => void;
    /** Rename. */
    onLongPress?: () => void;
    onRetry?: () => void;
    /**
     * Give up on a source that has been "processing" for too long. The server
     * flips it to a terminal state WITHOUT deleting the uploaded bytes, so a
     * retry is still on the table — which is why this is not Remove.
     */
    onCancel?: () => void;
    onDelete?: () => void;
}) {
    const theme = useTheme();
    const working = isWorking(source);
    const failed = source.status === 'error';

    return (
        <ListRow
            title={source.name}
            subtitle={sourceSubtitle(source) || undefined}
            wrapTitle
            // A processing source has nothing to preview yet, and a failed one
            // has an error instead of content — opening either is a dead end.
            onPress={source.status === 'ready' && source.hasContent ? onPress : undefined}
            onLongPress={onLongPress}
            chevron={false}
            leading={
                working ? (
                    <View style={styles.spinner}>
                        <Spinner />
                    </View>
                ) : (
                    <Icon
                        name={sourceIcon(source.type)}
                        size={20}
                        color={failed ? theme.colors.error : theme.colors.textMuted}
                    />
                )
            }
            trailing={
                <SourceActions
                    name={source.name}
                    onCancel={working ? onCancel : undefined}
                    onRetry={failed ? onRetry : undefined}
                    onDelete={onDelete}
                />
            }
        />
    );
}
