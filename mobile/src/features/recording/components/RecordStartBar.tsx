/**
 * The one thing the Meeting Notes tab exists to do, pinned above the list.
 *
 * It used to live inside `ListHeaderComponent`, below a banner, a permission
 * card and an import button — so on a phone with a few recordings the
 * flagship capability of the app scrolled off the top of its own tab.
 *
 * `start` answers false when the permission is missing. No toast then: the
 * permission card already explains the situation, and saying it twice is
 * worse than saying it once.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, Text } from '@/shared/ui';

import { MicPermissionCard } from './MicPermissionCard';
import type { Recorder } from '../hooks/useRecorder';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md, gap: theme.spacing.md },
    });

export function RecordStartBar({
    recorder,
    requesting,
    onRequestPermission,
}: {
    recorder: Recorder;
    requesting: boolean;
    onRequestPermission: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const askFirst = !recorder.permission.unknown && !recorder.permission.granted;
    return (
        <View style={styles.bar}>
            {askFirst ? (
                <MicPermissionCard permission={recorder.permission} onRequest={onRequestPermission} busy={requesting} />
            ) : (
                <>
                    <Button
                        label="Start recording"
                        size="lg"
                        fullWidth
                        onPress={() => void recorder.start()}
                        icon={<Icon name="Mic" size={20} color={theme.colors.accentPrimaryFg} />}
                        accessibilityHint="Records the room and transcribes it when you stop"
                    />
                    <Text variant="caption" tone="tertiary" center>
                        Records this room, keeps going when the screen locks, and transcribes with
                        speakers once you stop.
                    </Text>
                </>
            )}
        </View>
    );
}
