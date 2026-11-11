import type { NodeProps } from './appNode.types';
import type { BindingInput } from '../resolveBinding.types';
import { ROLE_COLORS } from '../styleResolver.constants';
import { Skeleton, useStickyBinding } from '../uiBits';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import useTranslation from '@/hooks/useTranslation';

/**
 * App Studio runtime - 'gauge' (schema 3). Spec: server/appStudio/componentSpecs/types/gauge.js.
 *
 * One value on a half circle from min to max, as a `meter` (the ARIA role for a value inside a
 * known range). The arc takes the tone of the highest threshold the value reaches. It is drawn
 * once, without a transition, so a screenshot and a first paint show the final state.
 */

interface Threshold {
    from?: number;
    tone?: string;
    label?: string;
}

interface GaugeProps {
    value?: BindingInput;
    label?: string | null;
    min?: number;
    max?: number;
    unit?: string | null;
    thresholds?: Threshold[];
    showRange?: boolean;
}

const SIZES: Record<string, { width: number; stroke: number; text: string }> = {
    sm: { width: 120, stroke: 10, text: 'text-lg' },
    md: { width: 160, stroke: 14, text: 'text-2xl' },
    lg: { width: 220, stroke: 18, text: 'text-3xl' },
};

/** The threshold the value falls in: the highest `from` it reaches, or null. */
export function gaugeThreshold(value: number, thresholds: readonly Threshold[] | undefined): Threshold | null {
    let hit: Threshold | null = null;
    for (const entry of Array.isArray(thresholds) ? thresholds : []) {
        if (!entry || !Number.isFinite(Number(entry.from)) || value < Number(entry.from)) continue;
        if (!hit || Number(entry.from) >= Number(hit.from)) hit = entry;
    }
    return hit;
}

/** Where `value` sits between min and max, 0..1 (a range that is empty or upside down gives 0). */
export function gaugeFraction(value: number, min: number, max: number): number {
    if (!(max > min) || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** The arc of a half circle from the left end over the top, for the fraction `f`. */
function arcPath(f: number, r: number, cx: number, cy: number): string {
    const angle = Math.PI * (1 - f);
    const x = cx + r * Math.cos(angle);
    const y = cy - r * Math.sin(angle);
    return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

/** A number prop, or `fallback` when it is not one. */
function numberOr(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Everything the gauge draws, from its props and the resolved value. */
function gaugeModel(props: GaugeProps, raw: unknown, size: unknown) {
    const min = numberOr(props.min, 0);
    const max = numberOr(props.max, 100);
    const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    const known = Number.isFinite(value);
    const hit = known ? gaugeThreshold(value, props.thresholds) : null;
    const unit = props.unit ? ` ${props.unit}` : '';
    const written = known ? `${value.toLocaleString()}${unit}` : '\u2014';
    return {
        min, max, known, hit,
        fraction: known ? gaugeFraction(value, min, max) : 0,
        now: known ? Math.max(min, Math.min(max, value)) : min,
        tone: hit?.tone || 'primary',
        written,
        valueText: hit?.label ? `${written}, ${hit.label}` : written,
        dims: SIZES[String(size || 'md')] || SIZES.md,
    };
}

export default function AppGauge({ node }: NodeProps<GaugeProps>) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
    const { value: raw, isLoading } = useStickyBinding(resolveBinding(props.value, { actionState, dataState, scope }));
    if (isLoading) return <Skeleton className="h-20 w-40" />;

    const m = gaugeModel(props, raw, node.style?.size);
    const color = ROLE_COLORS[m.tone] || ROLE_COLORS.primary;
    const { width, stroke, text } = m.dims;
    const r = (width - stroke) / 2;
    const height = r + stroke;
    const rangeStyle = { width };

    return (
        <div className="inline-flex min-w-0 flex-col items-center gap-1 bfa-gauge__root" data-app-gauge={m.tone}>
            <div
                className="relative bfa-gauge__meter"
                role="meter"
                aria-label={props.label || t('studio_apps_lk20.gauge.label', 'Gauge')}
                aria-valuemin={m.min}
                aria-valuemax={m.max}
                aria-valuenow={m.now}
                aria-valuetext={m.valueText}
            >
                <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
                    <path className="bfa-gauge__track" d={arcPath(1, r, width / 2, r + stroke / 2)} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} strokeLinecap="round" />
                    {m.fraction > 0 ? <path className="bfa-gauge__fill" d={arcPath(m.fraction, r, width / 2, r + stroke / 2)} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" /> : null}
                </svg>
                <span className={`absolute inset-x-0 bottom-0 text-center font-semibold tabular-nums text-[var(--text-primary)] ${text} bfa-gauge__value`}>{m.written}</span>
            </div>
            {props.showRange !== false ? (
                <div className="flex justify-between text-xs tabular-nums text-[var(--text-muted)] bfa-gauge__range" style={rangeStyle} aria-hidden="true">
                    <span>{m.min.toLocaleString()}</span>
                    <span>{m.max.toLocaleString()}</span>
                </div>
            ) : null}
            {props.label ? <div className="text-sm text-[var(--text-secondary)] bfa-gauge__label">{props.label}</div> : null}
        </div>
    );
}
