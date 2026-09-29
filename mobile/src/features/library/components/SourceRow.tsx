/**
 * One row in a notebook's source list.
 *
 * Ingestion is asynchronous and can take a minute for a large PDF — the route
 * answers 200 the moment the bytes land and does the extraction, chunking and
 * embedding on a worker — so a source has a life cycle, and this row is where
 * a person watches it. `stage` is the worker's own progress word (queued,
 * extracting, chunking, embedding); showing it beats a spinner that says
 * nothing for forty seconds.
 *
 * A failed source keeps its bytes. That is why the recovery here is Retry
 * rather than "delete and add it again": routes/notebooks.js re-fetches the
 * file from storage, or re-ingests the stored text, without another upload.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

import { plural } from '../../../lib/format';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { Spinner } from '../../../ui/Feedback';
import { ListRow } from '../../../ui/List';
import { Text } from '../../../ui/Text';
import { sourceIcon } from '../format';
import type { NotebookSource } from '../types';

export function SourceRow({
    source,
    onPress,
    onRetry,
    onCancel,
    onDelete,
}: {
    source: NotebookSource;
    onPress?: () => void;
    onRetry?: () => void;
    /**
     * Give up on a source that has been "processing" for too long. The server
     * flips it to a terminal state WITHOUT deleting the uploaded bytes, so a
     * retry is still on the table — which is why this is not the same button
     * as Remove.
     */
    onCancel?: () => void;
    onDelete?: () => void;
}) {
    const theme = useTheme();
    const working = source.status === 'processing' || source.status === 'pending';
    const failed = source.status === 'error';

    const subtitle = failed
        ? source.error || 'Ingestion failed'
        : working
          ? source.stage
              ? `${capitalise(source.stage)}…`
              : 'Processing…'
          : source.wordCount > 0
            ? plural(source.wordCount, 'word')
            : (typeof source.metadata.url === 'string' ? source.metadata.url : undefined) ?? '';

    return (
        <ListRow
            title={source.name}
            subtitle={subtitle || undefined}
            wrapTitle
            // A processing source has nothing to preview yet, and a failed one
            // has an error instead of content — opening either is a dead end.
            onPress={source.status === 'ready' && source.hasContent ? onPress : undefined}
            chevron={false}
            leading={
                working ? (
                    <View style={{ width: 20, alignItems: 'center' }}>
                        <Spinner />
                    </View>
                ) : (
                    <Feather
                        name={sourceIcon(source.type)}
                        size={20}
                        color={failed ? theme.colors.error : theme.colors.textMuted}
                    />
                )
            }
            trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
                    {working && onCancel ? (
                        <IconButton
                            icon={<Feather name="slash" size={16} color={theme.colors.textMuted} />}
                            accessibilityLabel={`Stop waiting for ${source.name}`}
                            onPress={onCancel}
                        />
                    ) : null}
                    {failed && onRetry ? (
                        <IconButton
                            icon={<Feather name="rotate-cw" size={16} color={theme.colors.accentPrimary} />}
                            accessibilityLabel={`Retry ${source.name}`}
                            onPress={onRetry}
                        />
                    ) : null}
                    {onDelete ? (
                        <IconButton
                            icon={<Feather name="trash-2" size={16} color={theme.colors.textMuted} />}
                            accessibilityLabel={`Remove ${source.name}`}
                            onPress={onDelete}
                        />
                    ) : null}
                </View>
            }
        />
    );
}

/**
 * The one-line summary above the list: how many sources are usable right now,
 * and whether anything is still landing. A notebook whose sources are all
 * still processing will answer questions badly, and saying so up front is
 * kinder than letting the model do it.
 */
export function SourceSummary({ sources }: { sources: NotebookSource[] }) {
    const theme = useTheme();
    const ready = sources.filter((s) => s.status === 'ready').length;
    const working = sources.filter((s) => s.status === 'processing' || s.status === 'pending').length;
    const failed = sources.filter((s) => s.status === 'error').length;

    return (
        <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' }}
            accessibilityLiveRegion={working > 0 ? 'polite' : 'none'}
        >
            <Text variant="caption" tone="tertiary">
                {plural(ready, 'source')} ready
            </Text>
            {working > 0 ? <Badge label={`${working} processing`} tone="warning" /> : null}
            {failed > 0 ? <Badge label={`${failed} failed`} tone="error" /> : null}
        </View>
    );
}

function capitalise(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}
