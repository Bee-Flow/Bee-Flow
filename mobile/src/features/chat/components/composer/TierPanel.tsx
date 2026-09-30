/**
 * The tier panel: the memory switch in its top-right corner (as on the web —
 * both settings answer "how much does the assistant bring to the next
 * turn?"), the current choice stated above the track, the depth track, and
 * the kinds-of-work pills.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { tierDescription, tierLabel, type TierKey, type TierMap } from '@/features/chat/model/tiers';
import { Icon, Text } from '@/shared/ui';

import { TierPills } from './TierPills';
import { TierTrack } from './TierTrack';

const makeStyles = (theme: Theme) => ({
    memory: {
        position: 'absolute' as const,
        top: 10,
        right: 10,
        width: 28,
        height: 28,
        borderRadius: theme.radii.pill,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        zIndex: 1,
    },
    heading: { alignItems: 'center' as const, marginBottom: 14, paddingHorizontal: 26 },
    description: { marginTop: 2 },
});

export interface TierPanelProps {
    tiers: TierMap;
    stops: TierKey[];
    others: TierKey[];
    value: TierKey;
    onChange: (next: TierKey) => void;
    memory?: { enabled: boolean; onToggle: () => void };
    trackWidth: number;
    onTrackWidth: (width: number) => void;
}

export function TierPanel({ tiers, stops, others, value, onChange, memory, trackWidth, onTrackWidth }: TierPanelProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const currentLabel = tierLabel(value, tiers[value]);
    const currentDesc = tierDescription(value, tiers[value]);

    return (
        <>
            {memory ? (
                <Pressable
                    onPress={memory.onToggle}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: memory.enabled }}
                    accessibilityLabel={
                        memory.enabled
                            ? t('mobile.chat.memory_on', 'Memory saving enabled')
                            : t('mobile.chat.memory_paused', 'Memory saving paused')
                    }
                    hitSlop={theme.hitSlop}
                    style={[
                        styles.memory,
                        {
                            backgroundColor: memory.enabled ? theme.colors.itemActiveBg : 'transparent',
                            opacity: memory.enabled ? 1 : 0.55,
                        },
                    ]}
                >
                    <Icon name="Brain" size={16} color={memory.enabled ? theme.colors.accentText : theme.colors.textTertiary} />
                </Pressable>
            ) : null}

            {/* The label is the control's output; the track is just how you move. */}
            <View style={styles.heading}>
                <Text variant="subheading" weight="semibold">
                    {currentLabel}
                </Text>
                {currentDesc ? (
                    <Text variant="caption" tone="tertiary" style={styles.description}>
                        {currentDesc}
                    </Text>
                ) : null}
            </View>

            {stops.length > 0 ? (
                <TierTrack
                    stops={stops}
                    tiers={tiers}
                    value={value}
                    currentLabel={currentLabel}
                    onChange={onChange}
                    width={trackWidth}
                    onWidth={onTrackWidth}
                />
            ) : null}

            {others.length > 0 ? <TierPills others={others} tiers={tiers} value={value} onChange={onChange} /> : null}
        </>
    );
}
