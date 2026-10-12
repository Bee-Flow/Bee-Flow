import useTranslation from '../../../../../../hooks/useTranslation';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver';
import { Skeleton, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'progress'. Spec: server/appStudio/componentSpecs.js.
 * A bound value rendered as a bar against `max`, with an optional label and a
 * percent/fraction caption. Values clamp into [0, max]; a non-numeric value
 * renders an empty (0%) bar rather than crashing.
 *
 * Look pass — `props.look` (spec: componentSpecs.js): 'bar' (default) is the
 * untouched original path; 'slim' is a 2px quiet bar; 'ring' is a small
 * dependency-free SVG gauge with the caption in the center — the shape a
 * completion KPI actually wants. The ring's sweep transition reads the
 * --app-motion tokens, so design 'none' and prefers-reduced-motion zero it.
 */

// Ring geometry per the `size` style knob (outer box px / stroke width px).
const RING_SIZES = { sm: { dim: 48, stroke: 5 }, md: { dim: 64, stroke: 6 }, lg: { dim: 88, stroke: 8 } };

function ProgressRing({ dimSpec, pct, clamped, ceiling, color, caption, label }) {
    const { t } = useTranslation();
    const { dim, stroke } = dimSpec;
    const r = (dim - stroke) / 2;
    const c = 2 * Math.PI * r;
    return (
        <div className="min-w-0 inline-flex flex-col items-center gap-1" data-app-progress="true" data-app-progress-look="ring">
            <div
                className="relative inline-flex"
                role="progressbar"
                aria-valuenow={Math.round(clamped)}
                aria-valuemin={0}
                aria-valuemax={Math.round(ceiling)}
                aria-label={label || t('studio_apps_runtime.progress.label', 'Progress')}
            >
                <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} aria-hidden="true">
                    <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} />
                    <circle
                        cx={dim / 2}
                        cy={dim / 2}
                        r={r}
                        fill="none"
                        stroke={color}
                        strokeWidth={stroke}
                        strokeLinecap="round"
                        strokeDasharray={c}
                        strokeDashoffset={c * (1 - pct / 100)}
                        // Start the sweep at 12 o'clock, not 3 o'clock.
                        transform={`rotate(-90 ${dim / 2} ${dim / 2})`}
                        style={{ transition: 'stroke-dashoffset var(--app-motion-slow, 0ms) var(--app-ease, ease-out)' }}
                    />
                </svg>
                {caption ? (
                    <span
                        className="absolute inset-0 flex items-center justify-center text-xs font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                        data-app-progress-caption="true"
                    >
                        {caption}
                    </span>
                ) : null}
            </div>
            {label ? (
                <span className="text-xs font-medium truncate max-w-full" style={{ color: 'var(--text-secondary)' }}>{label}</span>
            ) : null}
        </div>
    );
}

export default function AppProgress({ node }) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const { format = 'percent', label = null, tone = 'primary' } = node.props || {};
    // Sticky, like every other bound component (AppList, AppChart, AppStat…).
    // Without it this was the one that BLANKED: a bar whose binding filters on
    // a selection re-keys the moment the selection changes, and for that frame
    // the whole component became a full-width grey skeleton — a grey bar
    // flashing across the page on every click. Sticky keeps the last bar drawn
    // until the new numbers land; only a first-ever load still shows a
    // skeleton, which is the one time there is genuinely nothing to keep.
    const { value: raw, isLoading } = useStickyBinding(
        resolveBinding(node.props?.value, { actionState, dataState, scope }),
    );
    // `max` is a binding now, so a bar can measure against a ceiling that lives
    // in the data: a sprint's capacity, a budget, a quota. A BARE NUMBER is still
    // honoured — canonicalize wraps one on save, but the runtime also renders
    // definitions that never went through it, and resolveBinding answers
    // `undefined` for a non-object rather than passing it through.
    const maxProp = node.props?.max;
    const plainMax = typeof maxProp === 'number' ? maxProp : null;
    const { value: boundMax, isLoading: maxLoading } = useStickyBinding(
        resolveBinding(plainMax === null ? maxProp : null, { actionState, dataState, scope }),
    );
    const rawMax = plainMax === null ? boundMax : plainMax;

    if (isLoading || maxLoading) return <Skeleton className="h-2.5 w-full" />;

    const value = Number(raw);
    // A ceiling that has not loaded, or is zero, falls back to 100 — the bar
    // stays drawable rather than dividing by nothing.
    const ceiling = Number.isFinite(Number(rawMax)) && Number(rawMax) > 0 ? Number(rawMax) : 100;
    const clamped = Number.isFinite(value) ? Math.max(0, Math.min(ceiling, value)) : 0;
    const pct = (clamped / ceiling) * 100;

    const caption = format === 'percent'
        ? `${Math.round(pct)}%`
        : format === 'fraction'
            ? `${Number.isFinite(value) ? clamped.toLocaleString() : 0} / ${ceiling.toLocaleString()}`
            : null;

    const size = node.style?.size || 'md';
    const barH = size === 'sm' ? 'h-1.5' : size === 'lg' ? 'h-3' : 'h-2';
    const color = ROLE_COLORS[tone] || ROLE_COLORS.primary;
    const look = node.props?.look;

    if (look === 'ring') {
        return (
            <ProgressRing
                dimSpec={RING_SIZES[size] || RING_SIZES.md}
                pct={pct}
                clamped={clamped}
                ceiling={ceiling}
                color={color}
                caption={caption}
                label={label}
            />
        );
    }

    // 'slim': a 2px quiet bar — the size knob's height classes step aside for a
    // fixed hairline height; label/caption keep the exact bar layout.
    const slim = look === 'slim';

    // Segments (spec: progress.segments) — a stacked distribution bar for the
    // bar/slim looks. Widths normalize on the sum (sum 0 = an empty track);
    // the single value/max bar below stays byte-identical when the list is
    // empty. No sticky per segment: hooks cannot run in a data-sized loop, and
    // formula/static segment values resolve synchronously anyway.
    const segments = Array.isArray(node.props?.segments) ? node.props.segments : [];
    if (segments.length > 0) {
        const bag = { actionState, dataState, scope };
        const parts = segments.map((s) => {
            const n = Number(resolveBinding(s?.value, bag).value);
            return {
                value: Number.isFinite(n) && n > 0 ? n : 0,
                tone: s && ROLE_COLORS[s.tone] ? s.tone : 'primary',
                label: s && typeof s.label === 'string' ? s.label : null,
            };
        });
        const sum = parts.reduce((acc, p) => acc + p.value, 0);
        return (
            <div
                className="w-full min-w-0 flex flex-col gap-1"
                data-app-progress="true"
                data-app-progress-look={slim ? 'slim' : undefined}
                data-app-progress-segments={parts.length}
            >
                {label ? (
                    <div className="flex items-baseline justify-between gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                    </div>
                ) : null}
                <div
                    className={`w-full ${slim ? '' : `${barH} `}rounded-full overflow-hidden`}
                    style={slim ? { background: 'var(--bg-tertiary)', height: '2px' } : { background: 'var(--bg-tertiary)' }}
                    role="progressbar"
                    aria-valuenow={Math.round(sum)}
                    aria-valuemin={0}
                    aria-valuemax={Math.round(sum)}
                    aria-label={label || t('studio_apps_runtime.progress.label', 'Progress')}
                >
                    {sum > 0 ? (
                        <div className="flex h-full w-full">
                            {parts.map((p, i) => (p.value > 0 ? (
                                <div
                                    key={i}
                                    className="h-full"
                                    title={`${p.label || p.tone}: ${p.value.toLocaleString()}`}
                                    data-app-progress-segment={p.tone}
                                    style={{ width: `${(p.value / sum) * 100}%`, background: ROLE_COLORS[p.tone] }}
                                />
                            ) : null))}
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <div
            className="w-full min-w-0 flex flex-col gap-1"
            data-app-progress="true"
            data-app-progress-look={slim ? 'slim' : undefined}
        >
            {(label || caption) ? (
                <div className="flex items-baseline justify-between gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                    {caption ? <span data-app-progress-caption="true">{caption}</span> : null}
                </div>
            ) : null}
            <div
                className={`w-full ${slim ? '' : `${barH} `}rounded-full overflow-hidden`}
                style={slim ? { background: 'var(--bg-tertiary)', height: '2px' } : { background: 'var(--bg-tertiary)' }}
                role="progressbar"
                aria-valuenow={Math.round(clamped)}
                aria-valuemin={0}
                aria-valuemax={Math.round(ceiling)}
                aria-label={label || t('studio_apps_runtime.progress.label', 'Progress')}
            >
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
        </div>
    );
}
