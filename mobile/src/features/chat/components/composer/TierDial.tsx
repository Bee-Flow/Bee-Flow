/**
 * The composer's tier control — a gauge that opens a slider, exactly as the
 * web app draws it (agent-hub/src/components/licensing/TierSlider.jsx).
 *
 * The web's argument for the shape holds unchanged: the depth tiers are one
 * model at increasing depth, and a slider states that ordering where a list of
 * chips hides it. Flow, Swarm, Write and custom tiers are kinds of work rather
 * than depths, so they render as pills under the track — never as stops on it.
 *
 * Ported faithfully, with three deliberate departures a phone forces:
 *
 *   - The panel opens in a transparent Modal anchored above the trigger,
 *     because Android clips absolutely-positioned children at the card edge.
 *   - The track's fill is a flat ink-mix rather than the web's gradient (no
 *     gradients without another dependency); it still DARKENS with travel.
 *   - The needle does not sweep: animating an SVG rotation is not worth a
 *     frame loop for a 17px glyph; the needle's position is the information.
 *
 * Geometry is model/tierGeometry.ts; the panel is TierPanel.
 */

import React, { memo, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { depthFraction, panelFrame, type Point } from '@/features/chat/model/tierGeometry';
import { splitTiers, tierLabel, type TierKey, type TierMap } from '@/features/chat/model/tiers';

import { TierGauge } from './TierGauge';
import { TierPanel } from './TierPanel';

export interface TierDialProps {
    tiers: TierMap;
    value: TierKey;
    onChange: (next: TierKey) => void;
    disabled?: boolean;
    /**
     * The memory switch, parked in the panel's top-right corner as it is on
     * the web. Absent on surfaces that do not write memory.
     */
    memory?: { enabled: boolean; onToggle: () => void };
}

const makeStyles = (theme: Theme) => ({
    trigger: {
        width: 34,
        height: 34,
        borderRadius: theme.radii.pill,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    panel: {
        position: 'absolute' as const,
        borderRadius: 16,
        padding: 16,
        backgroundColor: theme.colors.bgCard,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        ...theme.elevation.popover,
    },
});

export const TierDial = memo(function TierDial({ tiers, value, onChange, disabled, memory }: TierDialProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const screen = useWindowDimensions();
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<Point | null>(null);
    const [trackWidth, setTrackWidth] = useState(0);
    const triggerRef = useRef<View>(null);
    const { stops, others } = useMemo(() => splitTiers(tiers), [tiers]);

    if (!stops.length && !others.length) return null;

    const openPanel = () => {
        triggerRef.current?.measureInWindow((x, y) => {
            setAnchor({ x, y });
            setOpen(true);
        });
    };
    const frame = panelFrame(anchor, screen);

    return (
        <>
            <Pressable
                ref={triggerRef}
                onPress={openPanel}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.chat.tier_depth_value', 'Response depth: {tier}', { tier: tierLabel(value, tiers[value]) })}
                hitSlop={theme.hitSlop}
                style={[styles.trigger, { opacity: disabled ? 0.5 : 1 }]}
            >
                <TierGauge
                    fraction={depthFraction(stops, value)}
                    auto={value === 'auto'}
                    size={21}
                    accent={theme.colors.accentText}
                    muted={theme.colors.textSecondary}
                />
            </Pressable>

            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                {/* Press anywhere outside closes — the web's mousedown-outside. */}
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)}>
                    {/* Absorbs presses so the outside-close does not fire; the
                        panel itself is not a button. */}
                    <Pressable
                        onPress={() => undefined}
                        style={[styles.panel, { left: frame.left, width: frame.width, bottom: frame.bottom }]}
                    >
                        <TierPanel
                            tiers={tiers}
                            stops={stops}
                            others={others}
                            value={value}
                            onChange={onChange}
                            memory={memory}
                            trackWidth={trackWidth}
                            onTrackWidth={setTrackWidth}
                        />
                    </Pressable>
                </Pressable>
            </Modal>
        </>
    );
});
