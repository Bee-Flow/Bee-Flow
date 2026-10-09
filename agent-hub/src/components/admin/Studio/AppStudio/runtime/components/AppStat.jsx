import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Line, LineChart } from 'recharts';
import useTranslation from '../../../../../../hooks/useTranslation';
import AppIcon from '../../../../../icons/AppIcon';
import { chartColorAt } from '../chartPalette';
import { hoverable } from '../hoverable';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS, roleTextColor, spaceSteps } from '../styleResolver';
import { ErrorText, Skeleton, displayValue, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'stat'. Spec: server/appStudio/componentSpecs.js.
 *
 * v1 tiles (label + value + caption + icon) render EXACTLY as before. v2 adds
 * an optional delta chip (up/down, coloured via ROLE_COLORS honouring
 * positiveIsGood) and a tiny recharts sparkline drawn from chartPalette — both
 * appear only when their bindings resolve to data, so v1 stats are untouched.
 *
 * Look pass — `props.look` (spec: componentSpecs.js): 'plain' (default) stamps
 * no class and no style, so stored stats render byte-identically; the other
 * looks give the tile its own surface, all derived from the theme tokens
 * (--app-primary family, --app-shadow-*, --app-radius) — no literal colors.
 */

const VALUE_SIZES = { sm: 'text-xl', md: 'text-2xl', lg: 'text-4xl' };

// Root surface per look. 'plain' is deliberately absent: the default path must
// emit no new class and no style attribute at all (identity discipline).
const STAT_LOOKS = {
    tile: {
        background: 'var(--bg-card)',
        border: '1px solid var(--app-hairline, var(--border-default))',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
        boxShadow: 'var(--app-shadow-1)',
    },
    tinted: {
        background: 'var(--app-primary-soft)',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
    },
    accent: {
        background: 'var(--bg-card)',
        border: '1px solid var(--app-hairline, var(--border-default))',
        // After the shorthand on purpose: the left edge becomes the primary bar.
        borderLeft: '3px solid var(--app-primary)',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
        boxShadow: 'var(--app-shadow-1)',
    },
    gradient: {
        background: 'linear-gradient(135deg, color-mix(in srgb, var(--app-primary) 16%, transparent), color-mix(in srgb, var(--app-primary) 3%, transparent))',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
    },
};

/** Normalize a trend binding value to an array of finite {i, v} points. */
function toSparkData(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry, i) => {
            const v = entry && typeof entry === 'object' ? Number(entry.value ?? entry.y ?? entry.count) : Number(entry);
            return { i, v };
        })
        .filter((d) => Number.isFinite(d.v));
}

function DeltaChip({ delta, deltaFormat, positiveIsGood }) {
    const n = Number(delta);
    const numeric = Number.isFinite(n);
    const dir = numeric ? Math.sign(n) : 0;
    const good = (dir > 0 && positiveIsGood) || (dir < 0 && !positiveIsGood);
    const color = dir === 0 ? 'var(--text-muted)' : (good ? ROLE_COLORS.success : ROLE_COLORS.danger);
    const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
    const magnitude = numeric ? Math.abs(n).toLocaleString() : displayValue(delta);
    const text = deltaFormat === 'percent' && numeric ? `${magnitude}%` : magnitude;
    return (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium" style={{ color }} data-app-stat-delta="true">
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            {text}
        </span>
    );
}

export default function AppStat({ node }) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const {
        label = t('studio_apps_runtime.stat.metric', 'Metric'), caption = null, icon = null,
        deltaFormat = 'number', positiveIsGood = true,
    } = node.props || {};
    const bag = { actionState, dataState, scope };
    // Non-empty replaces `caption`; entries without usable text are skipped so
    // a half-filled inspector row cannot blank the whole line.
    const captionSegments = (Array.isArray(node.props?.captionSegments) ? node.props.captionSegments : [])
        .filter((s) => s && typeof s.text === 'string' && s.text !== '');
    const { value, isLoading, error, errorCode } = useStickyBinding(resolveBinding(node.props?.value, bag));
    const { value: deltaVal } = resolveBinding(node.props?.delta, bag);
    const { value: trendVal } = resolveBinding(node.props?.trend, bag);
    const size = node.style?.size || 'md';
    const look = node.props?.look;
    const lookStyle = STAT_LOOKS[look] || null; // 'plain' / unknown → identity

    const hasDelta = deltaVal != null && deltaVal !== '';
    const sparkData = toSparkData(trendVal);
    const deltaN = Number(deltaVal);
    const deltaGood = (Math.sign(deltaN) > 0 && positiveIsGood) || (Math.sign(deltaN) < 0 && !positiveIsGood);
    const sparkColor = hasDelta && Number.isFinite(deltaN) && deltaN !== 0
        ? (deltaGood ? ROLE_COLORS.success : ROLE_COLORS.danger)
        : chartColorAt(0);

    return (
        <div
            className={`app-stat flex items-start gap-2.5${lookStyle ? ` app-stat--${look}` : ''}`}
            style={lookStyle || undefined}
        >
            {icon ? (
                <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md shrink-0 mt-0.5"
                    style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                >
                    <AppIcon name={icon} className="w-4 h-4" />
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div>
                {error
                    ? <ErrorText error={error} errorCode={errorCode} />
                    : isLoading
                    ? <Skeleton className="h-7 mt-1" style={{ width: '4rem' }} />
                    : (
                        <div className="flex items-baseline gap-2 min-w-0">
                            <div
                                className={`${VALUE_SIZES[size] || VALUE_SIZES.md} font-semibold leading-tight truncate`}
                                {...hoverable(displayValue(value))}
                                // gradient: the value carries the primary — over a
                                // soft (≤16%) wash it stays readable in both themes.
                                style={look === 'gradient' ? { color: 'var(--app-primary)' } : undefined}
                            >{displayValue(value)}</div>
                            {hasDelta ? (
                                <DeltaChip delta={deltaVal} deltaFormat={deltaFormat} positiveIsGood={positiveIsGood} />
                            ) : null}
                        </div>
                    )}
                {captionSegments.length ? (
                    // Replaces `caption` (spec: captionSegments). The texts are
                    // rendered VERBATIM, back to back — the author owns spaces
                    // and separators — each span in its own tone color.
                    <div className="text-xs" data-app-stat-caption-segments="true">
                        {captionSegments.map((s, i) => (
                            <span
                                key={i}
                                data-app-stat-caption-tone={s.tone && s.tone !== 'muted' && ROLE_COLORS[s.tone] ? s.tone : 'muted'}
                                style={{
                                    color: s.tone && s.tone !== 'muted' && ROLE_COLORS[s.tone]
                                        ? roleTextColor(s.tone)
                                        : 'var(--text-muted)',
                                }}
                            >
                                {s.text}
                            </span>
                        ))}
                    </div>
                ) : caption ? <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{caption}</div> : null}
                {sparkData.length >= 2 ? (
                    <div className="mt-1.5" data-app-stat-trend="true">
                        <LineChart width={96} height={28} data={sparkData}>
                            <Line
                                type="monotone"
                                dataKey="v"
                                stroke={sparkColor}
                                strokeWidth={1.75}
                                dot={false}
                                isAnimationActive={false}
                            />
                        </LineChart>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
