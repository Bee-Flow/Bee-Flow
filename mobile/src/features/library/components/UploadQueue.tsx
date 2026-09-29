/**
 * The visible half of the upload queue.
 *
 * One row per file, and every row says which of the four things is true:
 * waiting, this-far-along, done, or failed-and-here-is-why. The failure row
 * keeps the file name and offers Retry, because the whole reason the queue
 * remembers the local uri is so a person never has to find the file twice.
 *
 * The progress bar is a live region: on a screen reader, "43 percent" spoken
 * occasionally is the difference between a working upload and a frozen app.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { formatBytes } from '../../../lib/bytes';
import { useTheme } from '../../../theme/ThemeProvider';
import { IconButton } from '../../../ui/Button';
import { Spinner } from '../../../ui/Feedback';
import { Text } from '../../../ui/Text';
import type { UploadItem } from '../useUploadQueue';

export function UploadQueue({
    items,
    onRetry,
    onRemove,
    onClearFinished,
}: {
    items: UploadItem[];
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
    onClearFinished: () => void;
}) {
    const theme = useTheme();
    if (items.length === 0) return null;

    const finished = items.filter((i) => i.status === 'done' || i.status === 'cancelled').length;

    return (
        <View
            style={{
                borderRadius: theme.radii.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.borderSubtle,
                backgroundColor: theme.colors.bgCard,
                overflow: 'hidden',
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: theme.spacing.lg,
                    paddingRight: theme.spacing.sm,
                    paddingVertical: theme.spacing.sm,
                    gap: theme.spacing.sm,
                }}
            >
                <Text variant="label" tone="tertiary" style={{ flex: 1 }}>
                    UPLOADS
                </Text>
                {finished > 0 ? (
                    <IconButton
                        icon={<Feather name="check" size={16} color={theme.colors.textMuted} />}
                        accessibilityLabel="Clear finished uploads"
                        onPress={onClearFinished}
                    />
                ) : null}
            </View>

            {items.map((item) => (
                <UploadRow key={item.id} item={item} onRetry={onRetry} onRemove={onRemove} />
            ))}
        </View>
    );
}

function UploadRow({
    item,
    onRetry,
    onRemove,
}: {
    item: UploadItem;
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
}) {
    const theme = useTheme();
    const percent = Math.round(item.progress * 100);

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.colors.borderSubtle,
            }}
        >
            <StatusGlyph status={item.status} />

            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                <Text variant="caption" numberOfLines={1}>
                    {item.name}
                </Text>

                {item.status === 'uploading' ? (
                    <View
                        accessibilityLiveRegion="polite"
                        accessibilityLabel={`Uploading ${item.name}, ${percent} percent`}
                        style={{ gap: 4 }}
                    >
                        <View
                            style={{
                                height: 4,
                                borderRadius: 2,
                                backgroundColor: theme.colors.bgTertiary,
                                overflow: 'hidden',
                            }}
                        >
                            <View
                                style={{
                                    width: `${Math.max(2, percent)}%`,
                                    height: '100%',
                                    backgroundColor: theme.colors.accentPrimary,
                                }}
                            />
                        </View>
                        <Text variant="label" tone="tertiary">
                            {percent}%{item.size ? ` of ${formatBytes(item.size)}` : ''}
                        </Text>
                    </View>
                ) : item.status === 'error' ? (
                    <Text variant="label" tone="error" accessibilityLiveRegion="polite">
                        {item.error}
                    </Text>
                ) : (
                    <Text variant="label" tone="tertiary">
                        {LABELS[item.status]}
                        {item.size ? ` · ${formatBytes(item.size)}` : ''}
                    </Text>
                )}
            </View>

            {item.status === 'error' ? (
                <IconButton
                    icon={<Feather name="rotate-cw" size={16} color={theme.colors.accentPrimary} />}
                    accessibilityLabel={`Retry uploading ${item.name}`}
                    onPress={() => onRetry(item.id)}
                />
            ) : null}
            {item.status !== 'done' ? (
                <IconButton
                    icon={<Feather name="x" size={16} color={theme.colors.textMuted} />}
                    accessibilityLabel={
                        item.status === 'uploading'
                            ? `Cancel uploading ${item.name}`
                            : `Remove ${item.name} from the queue`
                    }
                    onPress={() => onRemove(item.id)}
                />
            ) : null}
        </View>
    );
}

const LABELS: Record<UploadItem['status'], string> = {
    queued: 'Waiting',
    uploading: 'Uploading',
    done: 'Uploaded',
    error: 'Failed',
    cancelled: 'Cancelled',
};

function StatusGlyph({ status }: { status: UploadItem['status'] }) {
    const theme = useTheme();
    if (status === 'uploading') return <Spinner />;
    const glyph = {
        queued: { name: 'clock', color: theme.colors.textMuted },
        done: { name: 'check-circle', color: theme.colors.success },
        error: { name: 'alert-circle', color: theme.colors.error },
        cancelled: { name: 'slash', color: theme.colors.textMuted },
    }[status];
    return (
        <Feather
            name={glyph.name as keyof typeof Feather.glyphMap}
            size={18}
            color={glyph.color}
        />
    );
}
