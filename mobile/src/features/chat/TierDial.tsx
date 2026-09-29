/**
 * The composer's tier control — a gauge that opens a slider, exactly as the
 * web app draws it (agent-hub/src/components/licensing/TierSlider.jsx).
 *
 * This replaces a row of chips inside the "+" sheet, which was the phone
 * inventing its own control for the one setting whose look the owner compares
 * side by side every day. The web's argument for the shape holds unchanged:
 * the depth tiers are one model at increasing depth, and a slider states that
 * ordering where a list of chips hides it. Flow, Swarm, Write and custom
 * tiers are kinds of work rather than depths, so they render as pills under
 * the track — never as stops on it.
 *
 * Ported faithfully, with three deliberate departures a phone forces:
 *
 *   - The panel opens in a transparent Modal anchored above the trigger,
 *     because Android clips absolutely-positioned children at the card edge.
 *     Same card, same geometry — a different projection.
 *   - The track's fill is a flat ink-mix rather than the web's gradient
 *     (React Native has no gradients without another dependency). The web's
 *     visible signal — the fill DARKENS as the thumb travels deeper — is
 *     kept: the mix runs 20% → 44% ink with travel, the same numbers the web
 *     uses for its gradient's deep end.
 *   - The needle does not sweep. Animating an SVG rotation is not worth a
 *     frame loop for a 17px glyph; the needle's position is the information.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
    Modal,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    View,
    type GestureResponderEvent,
    type LayoutChangeEvent,
} from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import {
    splitTiers,
    tierDescription,
    tierLabel,
    type TierKey,
    type TierMap,
} from './tiers';
import { useTheme } from '../../theme/ThemeProvider';
import { Text } from '../../ui/Text';

// ── Gauge geometry — identical to the web's ─────────────────────────────────
const GAUGE_START_DEG = -135;
const GAUGE_SWEEP_DEG = 270;
const GAUGE_RADIUS = 8.5;
const GAUGE_ARC_LEN = (GAUGE_SWEEP_DEG / 360) * 2 * Math.PI * GAUGE_RADIUS;

function polarPoint(cx: number, cy: number, r: number, deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
    const start = polarPoint(cx, cy, r, fromDeg);
    const end = polarPoint(cx, cy, r, toDeg);
    const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * The speedometer. `fraction` is 0–1 along the depth scale; null means the
 * current tier is not on it (Flow/Swarm/Write) — needle at rest, arc
 * unfilled. Auto drops the needle entirely: the whole arc lights dimmed and
 * an "A" takes the pivot's place, because Auto means "pick for me" and a
 * needle position would invent a depth. All the web's own reasoning, kept.
 */
function TierGauge({
    fraction,
    auto,
    size,
    accent,
    muted,
}: {
    fraction: number | null;
    auto: boolean;
    size: number;
    accent: string;
    muted: string;
}) {
    const c = 12;
    const f = typeof fraction === 'number' ? Math.min(1, Math.max(0, fraction)) : null;
    const inactive = f === null && !auto;
    const needleDeg = GAUGE_START_DEG + GAUGE_SWEEP_DEG * (f ?? 0);
    const filled = auto ? 1 : (f ?? 0);
    const trackPath = arcPath(c, c, GAUGE_RADIUS, GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SWEEP_DEG);
    const tip = polarPoint(c, c, GAUGE_RADIUS - 2.4, needleDeg);

    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                d={trackPath}
                stroke={muted}
                strokeOpacity={0.28}
                strokeWidth={2.4}
                strokeLinecap="round"
                fill="none"
            />
            {!inactive ? (
                <Path
                    d={trackPath}
                    stroke={accent}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    fill="none"
                    strokeDasharray={`${GAUGE_ARC_LEN}`}
                    strokeDashoffset={GAUGE_ARC_LEN * (1 - filled)}
                    strokeOpacity={auto ? 0.45 : 1}
                />
            ) : null}
            {auto ? (
                <SvgText
                    x={c}
                    y={c}
                    textAnchor="middle"
                    alignmentBaseline="central"
                    fill={accent}
                    fontSize={11}
                    fontWeight="700"
                >
                    A
                </SvgText>
            ) : (
                <>
                    <Line
                        x1={c}
                        y1={c}
                        x2={tip.x}
                        y2={tip.y}
                        stroke={inactive ? muted : accent}
                        strokeOpacity={inactive ? 0.4 : 1}
                        strokeWidth={2}
                        strokeLinecap="round"
                    />
                    <Circle
                        cx={c}
                        cy={c}
                        r={1.7}
                        fill={inactive ? muted : accent}
                        fillOpacity={inactive ? 0.4 : 1}
                    />
                </>
            )}
        </Svg>
    );
}

// ── Track geometry — the web's numbers ──────────────────────────────────────
const THUMB_PAD = 20;
const THUMB_RADIUS = 14;
const TRACK_HEIGHT = 40;
const LABEL_WIDTH = 84;

// The fill darkens with travel: 20% ink at the shallow end of the range, 44%
// at Deep Thinking — the web's FILL_MIN_END_PCT / FILL_MAX_END_PCT. Mixed
// from the theme's own ink into its own track surface, never from the accent,
// for the web's stated reason: the accent defaults to a grey that looks
// foreign on the warm Paper/Sepia themes, while ink-over-surface belongs to
// any theme by construction.
const FILL_MIN_END_PCT = 20;
const FILL_MAX_END_PCT = 44;

function hexChannel(hex: string, i: number): number {
    return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** JS stand-in for CSS `color-mix(in srgb, ink pct%, surface)`. */
function inkMix(ink: string, surface: string, pct: number): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(ink) || !/^#[0-9a-fA-F]{6}$/.test(surface)) return surface;
    const t = pct / 100;
    const ch = (i: number) => Math.round(hexChannel(ink, i) * t + hexChannel(surface, i) * (1 - t));
    return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** Horizontal centre of stop `i` in px, given the measured track width. */
function stopCenter(i: number, count: number, width: number): number {
    if (count < 2) return width / 2;
    return THUMB_PAD + (width - THUMB_PAD * 2) * (i / (count - 1));
}

export interface TierDialProps {
    tiers: TierMap;
    value: TierKey;
    onChange: (next: TierKey) => void;
    disabled?: boolean;
    /**
     * The memory switch, parked in the panel's top-right corner as it is on
     * the web — both settings answer "how much does the assistant bring to
     * the next turn?". Absent on surfaces that do not write memory.
     */
    memory?: { enabled: boolean; onToggle: () => void };
}

export function TierDial({ tiers, value, onChange, disabled, memory }: TierDialProps) {
    const theme = useTheme();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
    const [trackWidth, setTrackWidth] = useState(0);
    const triggerRef = useRef<View>(null);

    const { stops, others } = useMemo(() => splitTiers(tiers), [tiers]);

    const activeIndex = stops.indexOf(value);
    const isAuto = value === 'auto';

    // The gauge maps the REAL depths only — Auto is a choice on the track but
    // not a depth. Excluding it puts Fast at the floor and Deep Thinking at
    // the ceiling, which is what the needle should say.
    const scaleStops = useMemo(() => stops.filter((k) => k !== 'auto'), [stops]);
    const scaleIndex = scaleStops.indexOf(value);
    const depthFraction =
        scaleIndex < 0 ? null : scaleStops.length > 1 ? scaleIndex / (scaleStops.length - 1) : 1;

    const openPanel = () => {
        triggerRef.current?.measureInWindow((x, y) => {
            setAnchor({ x, y });
            setOpen(true);
        });
    };

    const indexFromX = (locationX: number): number => {
        if (stops.length < 2 || trackWidth === 0) return 0;
        const usable = Math.max(1, trackWidth - THUMB_PAD * 2);
        const ratio = Math.min(1, Math.max(0, (locationX - THUMB_PAD) / usable));
        return Math.round(ratio * (stops.length - 1));
    };

    const selectFromEvent = (e: GestureResponderEvent) => {
        const i = indexFromX(e.nativeEvent.locationX);
        const next = stops[i];
        if (next && next !== value) onChange(next);
    };

    if (!stops.length && !others.length) return null;

    const currentLabel = tierLabel(value, tiers[value]);
    const currentDesc = tierDescription(value, tiers[value]);

    const panelWidth = Math.min(320, screenWidth - 16);
    // Centred over the gauge, nudged back inside the viewport — the web's
    // edgeNudge, computed up front since every width is already known. The
    // panel is anchored by its BOTTOM edge, 8px above the trigger, so its
    // height never needs measuring.
    const panelLeft = anchor
        ? Math.min(Math.max(8, anchor.x + 17 - panelWidth / 2), screenWidth - 8 - panelWidth)
        : 8;
    const panelBottom = anchor ? Math.max(8, screenHeight - anchor.y + 8) : 8;

    const travel = activeIndex > 0 && stops.length > 1 ? activeIndex / (stops.length - 1) : 0;
    const fillColor = inkMix(
        theme.colors.textPrimary,
        theme.colors.bgTertiary,
        FILL_MIN_END_PCT + (FILL_MAX_END_PCT - FILL_MIN_END_PCT) * travel,
    );
    const onScale = activeIndex >= 0;

    return (
        <>
            <Pressable
                ref={triggerRef}
                onPress={openPanel}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={`Response depth: ${currentLabel}`}
                hitSlop={theme.hitSlop}
                style={{
                    width: 34,
                    height: 34,
                    borderRadius: theme.radii.pill,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: disabled ? 0.5 : 1,
                }}
            >
                <TierGauge
                    fraction={depthFraction}
                    auto={isAuto}
                    size={21}
                    accent={theme.colors.accentText}
                    muted={theme.colors.textSecondary}
                />
            </Pressable>

            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                {/* Press anywhere outside closes — the web's mousedown-outside. */}
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)}>
                    <Pressable
                        // Absorbs presses so the outside-close does not fire;
                        // the panel itself is not a button.
                        onPress={() => undefined}
                        style={{
                            position: 'absolute',
                            left: panelLeft,
                            width: panelWidth,
                            bottom: panelBottom,
                            borderRadius: 16,
                            padding: 16,
                            backgroundColor: theme.colors.bgCard,
                            borderWidth: 1,
                            borderColor: theme.colors.borderDefault,
                            ...theme.elevation.popover,
                        }}
                    >
                        {memory ? (
                            <Pressable
                                onPress={memory.onToggle}
                                accessibilityRole="switch"
                                accessibilityState={{ checked: memory.enabled }}
                                accessibilityLabel={
                                    memory.enabled ? 'Memory saving enabled' : 'Memory saving paused'
                                }
                                hitSlop={theme.hitSlop}
                                style={{
                                    position: 'absolute',
                                    top: 10,
                                    right: 10,
                                    width: 28,
                                    height: 28,
                                    borderRadius: theme.radii.pill,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    zIndex: 1,
                                    backgroundColor: memory.enabled
                                        ? theme.colors.itemActiveBg
                                        : 'transparent',
                                    opacity: memory.enabled ? 1 : 0.55,
                                }}
                            >
                                <BrainGlyph
                                    color={
                                        memory.enabled
                                            ? theme.colors.accentText
                                            : theme.colors.textTertiary
                                    }
                                />
                            </Pressable>
                        ) : null}

                        {/* The current choice, stated above the track: the
                            label is the control's output, the track is just
                            how you move. */}
                        <View style={{ alignItems: 'center', marginBottom: 14, paddingHorizontal: 26 }}>
                            <Text variant="subheading" weight="semibold">
                                {currentLabel}
                            </Text>
                            {currentDesc ? (
                                <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                                    {currentDesc}
                                </Text>
                            ) : null}
                        </View>

                        {stops.length > 0 ? (
                            <>
                                <View
                                    accessibilityRole="adjustable"
                                    accessibilityLabel="Response depth"
                                    accessibilityValue={{
                                        text: onScale ? currentLabel : 'Not on the depth scale',
                                    }}
                                    onLayout={(e: LayoutChangeEvent) =>
                                        setTrackWidth(e.nativeEvent.layout.width)
                                    }
                                    onStartShouldSetResponder={() => true}
                                    onMoveShouldSetResponder={() => true}
                                    onResponderGrant={selectFromEvent}
                                    onResponderMove={selectFromEvent}
                                    style={{
                                        height: TRACK_HEIGHT,
                                        borderRadius: theme.radii.pill,
                                        borderWidth: StyleSheet.hairlineWidth,
                                        borderColor: theme.colors.borderSubtle,
                                        backgroundColor: theme.colors.bgTertiary,
                                        opacity: onScale ? 1 : 0.45,
                                    }}
                                >
                                    {onScale && trackWidth > 0 ? (
                                        <View
                                            pointerEvents="none"
                                            style={{
                                                position: 'absolute',
                                                left: 5,
                                                top: 5,
                                                bottom: 5,
                                                width: Math.max(
                                                    0,
                                                    stopCenter(activeIndex, stops.length, trackWidth) +
                                                        THUMB_RADIUS -
                                                        5,
                                                ),
                                                borderRadius: theme.radii.pill,
                                                backgroundColor: fillColor,
                                            }}
                                        />
                                    ) : null}
                                    {trackWidth > 0
                                        ? stops.map((key, i) => {
                                              const isActive = i === activeIndex;
                                              const isPassed = onScale && i < activeIndex;
                                              const dot = isActive ? 28 : 10;
                                              return (
                                                  <View
                                                      key={key}
                                                      pointerEvents="none"
                                                      style={{
                                                          position: 'absolute',
                                                          left:
                                                              stopCenter(i, stops.length, trackWidth) -
                                                              dot / 2,
                                                          top: TRACK_HEIGHT / 2 - dot / 2,
                                                          width: dot,
                                                          height: dot,
                                                          borderRadius: theme.radii.pill,
                                                          backgroundColor: isActive
                                                              ? '#ffffff'
                                                              : isPassed
                                                                ? 'rgba(255,255,255,0.6)'
                                                                : theme.colors.textTertiary,
                                                          opacity: isActive || isPassed ? 1 : 0.45,
                                                          ...(isActive ? theme.elevation.card : null),
                                                      }}
                                                  />
                                              );
                                          })
                                        : null}
                                </View>

                                {/* Labels off the SAME stop centres as the
                                    dots — the web's one-expression rule, kept
                                    so the two rows cannot disagree. Outer
                                    labels are nudged inward so "Deep Thinking"
                                    stays inside the panel. */}
                                <View style={{ height: 16, marginTop: 8 }}>
                                    {trackWidth > 0
                                        ? stops.map((key, i) => {
                                              const centre = stopCenter(i, stops.length, trackWidth);
                                              const shift =
                                                  i === 0 ? 0.3 : i === stops.length - 1 ? 0.7 : 0.5;
                                              return (
                                                  <Text
                                                      key={key}
                                                      numberOfLines={1}
                                                      weight={i === activeIndex ? 'semibold' : 'regular'}
                                                      style={{
                                                          position: 'absolute',
                                                          left: centre - LABEL_WIDTH * shift,
                                                          width: LABEL_WIDTH,
                                                          textAlign:
                                                              i === 0
                                                                  ? 'left'
                                                                  : i === stops.length - 1
                                                                    ? 'right'
                                                                    : 'center',
                                                          fontSize: 10,
                                                          lineHeight: 16,
                                                          color:
                                                              i === activeIndex
                                                                  ? theme.colors.textPrimary
                                                                  : theme.colors.textTertiary,
                                                      }}
                                                  >
                                                      {tierLabel(key, tiers[key])}
                                                  </Text>
                                              );
                                          })
                                        : null}
                                </View>
                            </>
                        ) : null}

                        {others.length > 0 ? (
                            <View
                                style={{
                                    marginTop: 14,
                                    paddingTop: 12,
                                    borderTopWidth: StyleSheet.hairlineWidth,
                                    borderTopColor: theme.colors.borderSubtle,
                                    flexDirection: 'row',
                                    flexWrap: 'wrap',
                                    gap: 6,
                                }}
                            >
                                {others.map((key) => {
                                    const selected = key === value;
                                    return (
                                        <Pressable
                                            key={key}
                                            onPress={() => onChange(key)}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                            style={{
                                                paddingHorizontal: 10,
                                                paddingVertical: 5,
                                                borderRadius: theme.radii.pill,
                                                borderWidth: StyleSheet.hairlineWidth,
                                                borderColor: theme.colors.borderSubtle,
                                                backgroundColor: selected
                                                    ? theme.colors.accentFill
                                                    : theme.colors.bgTertiary,
                                            }}
                                        >
                                            <Text
                                                variant="caption"
                                                weight="medium"
                                                style={{
                                                    color: selected
                                                        ? theme.colors.accentFillFg
                                                        : theme.colors.textPrimary,
                                                }}
                                            >
                                                {tierLabel(key, tiers[key])}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        ) : null}
                    </Pressable>
                </Pressable>
            </Modal>
        </>
    );
}

/**
 * A minimal brain, drawn inline. Feather has no brain glyph, and pulling in a
 * second icon set for one 16px mark would be the tail wagging the dog; this
 * is the lucide Brain outline's silhouette, simplified.
 */
function BrainGlyph({ color }: { color: string }) {
    return (
        <Svg width={16} height={16} viewBox="0 0 24 24">
            <Path
                d="M12 4.5a3 3 0 0 0-3-2.5 3 3 0 0 0-3 3c-1.7.3-3 1.8-3 3.5 0 .9.3 1.7.9 2.4A3.5 3.5 0 0 0 3 13.5 3.5 3.5 0 0 0 5 16.7 3 3 0 0 0 8 20a3 3 0 0 0 4-2.8V4.5Zm0 0a3 3 0 0 1 3-2.5 3 3 0 0 1 3 3c1.7.3 3 1.8 3 3.5 0 .9-.3 1.7-.9 2.4a3.5 3.5 0 0 1 .9 2.6 3.5 3.5 0 0 1-2 3.2A3 3 0 0 1 16 20a3 3 0 0 1-4-2.8"
                stroke={color}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
        </Svg>
    );
}
