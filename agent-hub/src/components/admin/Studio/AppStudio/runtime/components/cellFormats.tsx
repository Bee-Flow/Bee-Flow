import { Check, Minus } from 'lucide-react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { makeValueFormatter } from '../chartPalette';
import { hoverable } from '../hoverable';
import { ROLE_COLORS, roleTextColor } from '../styleResolver';
import CadThumb from './CadThumb';
import { EM_DASH, displayValue } from '../uiBits';
import { Monogram, Pill } from './cellPills';
import { ROLE_HEX, isHttpUrl, labelForCell, textToneStyle, toneForCell } from './cellTone';
import type { CellColumn, CellRow } from './cellValue.types';

const fmtNumber = makeValueFormatter('number');
const fmtPercent = makeValueFormatter('percent');
const fmtCurrency = makeValueFormatter('currency');
function relativeFrom(value: unknown, now: number, t: TranslateFn): string | null {
    const then = new Date(value as string).getTime();
    if (Number.isNaN(then)) return null;
    const mins = Math.round((now - then) / 60000);
    const abs = Math.abs(mins);
    if (abs < 1) return t('studio_apps_runtime.cell.just_now', 'just now');
    if (abs < 60) {
        return mins > 0
            ? t('studio_apps_runtime.cell.minutes_ago', '{n}m ago', { n: abs })
            : t('studio_apps_runtime.cell.in_minutes', 'in {n}m', { n: abs });
    }
    if (abs < 1440) {
        const h = Math.round(abs / 60);
        return mins > 0
            ? t('studio_apps_runtime.cell.hours_ago', '{n}h ago', { n: h })
            : t('studio_apps_runtime.cell.in_hours', 'in {n}h', { n: h });
    }
    const d = Math.round(abs / 1440);
    return mins > 0
        ? t('studio_apps_runtime.cell.days_ago', '{n}d ago', { n: d })
        : t('studio_apps_runtime.cell.in_days', 'in {n}d', { n: d });
}

/**
 * A comma string, a JSON array string or a real array — either way a list of
 * chips.
 *
 * The JSON case is not hypothetical: dataModel stores a `multiselect` column as
 * TEXT holding JSON (deliberately, so both SQL dialects treat it as opaque
 * text), so every multiselect read back from the API arrives here as
 * `'["laadpaal","zonnepanelen"]'`. Splitting that on commas produced chips
 * reading `["laadpaal"` and `"zonnepanelen"]` — the punctuation rendered as
 * content. Parse it first, and fall through to the comma split when it is not
 * JSON after all.
 */
function asTags(value: unknown): unknown[] {
    if (Array.isArray(value)) return value.filter((v) => v != null && v !== '');
    const str = String(value).trim();
    if (str.startsWith('[')) {
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed)) {
                return parsed.filter((v) => v != null && v !== '').map((v) => String(v));
            }
        } catch {
            // Not JSON after all — fall through to the comma split below.
        }
    }
    return str.split(',').map((s) => s.trim()).filter(Boolean);
}
/** The format switch — one cell's MAIN content, before any decorations. */
interface RenderMainValueArgs {
    value: unknown;
    format: string;
    col: CellColumn | null;
    row: CellRow | null;
    now: number | null;
    t: TranslateFn;
}
export function renderMainValue({ value, format, col, row, now, t }: RenderMainValueArgs) {
    // An empty cell is muted everywhere. AppTable used to render a bare em-dash
    // at full text colour, which read as content rather than as absence.
    if (value == null || value === '') {
        // A `check` column is the exception: false is a real answer, not a gap.
        if (format !== 'check') {
            // ...unless the column says a gap here is a DEFECT (spec:
            // columns[].emptyTone): the material a part cannot be cut without
            // shows its dash in the colour of a problem, not of an absence.
            const gapTone = col?.emptyTone && ROLE_HEX[col.emptyTone] ? col.emptyTone : null;
            return (
                <span
                    style={{ color: gapTone ? roleTextColor(gapTone) : 'var(--text-muted)' }}
                    data-app-cell-empty={gapTone || undefined}
                >
                    {EM_DASH}
                </span>
            );
        }
    }

    switch (format) {
        // tabular-nums on every numeric render: a column of proportional
        // figures never lines up on its digits, however right-aligned.
        case 'number': {
            const n = Number(value);
            return <span className="tabular-nums" style={textToneStyle(col, row, value)}>{Number.isFinite(n) ? fmtNumber(n) : displayValue(value)}</span>;
        }
        case 'currency': {
            const n = Number(value);
            return <span className="tabular-nums">{Number.isFinite(n) ? fmtCurrency(n) : displayValue(value)}</span>;
        }
        case 'percent': {
            const n = Number(value);
            return <span className="tabular-nums">{Number.isFinite(n) ? fmtPercent(n) : displayValue(value)}</span>;
        }
        case 'date': {
            const d = new Date(value as string);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleDateString()}</>;
        }
        case 'datetime': {
            const d = new Date(value as string);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleString()}</>;
        }
        case 'relative': {
            // `now` comes from the runtime scope so every row on a screen is
            // measured against ONE clock. Reading the wall clock here instead
            // would be both impure in render and wrong: two rows written in the
            // same second could disagree about how long ago that was. With no
            // clock to measure against, "3h ago" is unanswerable — so fall back
            // to the timestamp itself rather than invent one.
            const rel = now == null ? null : relativeFrom(value, now, t);
            if (rel != null) return <>{rel}</>;
            const d = new Date(value as string);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleString()}</>;
        }
        case 'boolean':
            return <>{value ? t('studio_apps_runtime.cell.yes', 'Yes') : t('studio_apps_runtime.cell.no', 'No')}</>;
        case 'check':
            // Truthy gets a tick, falsy gets a dash — a column of Yes/No words
            // is much harder to scan than a column of marks.
            return value
                ? <Check className="w-3.5 h-3.5 inline" style={{ color: ROLE_COLORS.success }} aria-label={t('studio_apps_runtime.cell.yes', 'Yes')} />
                : <Minus className="w-3.5 h-3.5 inline" style={{ color: 'var(--text-muted)' }} aria-label={t('studio_apps_runtime.cell.no', 'No')} />;
        case 'badge':
        case 'relation':
            return (
                <Pill tone={toneForCell({ col, row, value })} dot={col?.badgeStyle === 'dot'}>
                    {displayValue(labelForCell({ col, value }))}
                </Pill>
            );
        case 'tags': {
            const tags = asTags(value);
            if (!tags.length) return <span style={{ color: 'var(--text-muted)' }}>{EM_DASH}</span>;
            return (
                <span className="inline-flex flex-wrap items-center gap-1">
                    {/* Relabel each chip the way a `badge` column does: the
                        stored value of a multiselect is a key ("laadpaal"),
                        and the toneMap is where its readable label lives. */}
                    {tags.map((t, i) => (
                        <Pill key={i} tone={toneForCell({ col, row, value: t })}>
                            {displayValue(labelForCell({ col, value: t }))}
                        </Pill>
                    ))}
                </span>
            );
        }
        // A quantity breakdown — "2x M5 + 4x M8 + 3x M6". As plain text this is
        // the worst cell in a wide table: it wraps to six lines, drags the whole
        // row's height with it, and reads as a sentence you have to parse rather
        // than a list you can count. Split on the separator the value already
        // uses and let each part be its own chip, with the count set apart from
        // what is being counted.
        case 'breakdown': {
            const parts = String(value).split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
            if (!parts.length) return <span style={{ color: 'var(--text-muted)' }}>{EM_DASH}</span>;
            return (
                <span className="inline-flex flex-wrap items-center gap-1" data-app-cell-breakdown={parts.length}>
                    {parts.map((part, i) => {
                        // "4x M8" → count "4×", label "M8". Anything that is not
                        // count-then-label stays whole rather than being forced
                        // into a shape it does not have.
                        const m = /^(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(.+)$/.exec(part);
                        return (
                            <span
                                key={i}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs whitespace-nowrap"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                            >
                                {m ? (
                                    <>
                                        <span className="font-semibold tabular-nums">{m[1]}×</span>
                                        <span style={{ color: 'var(--text-secondary)' }}>{m[2]}</span>
                                    </>
                                ) : part}
                            </span>
                        );
                    })}
                </span>
            );
        }
        // A row's 3D model, drawn small. The heavy lifting (fetch, blob,
        // enlarge) lives in CadThumb because it needs hooks and the app id —
        // this switch stays a pure mapping from format to element.
        case 'cad':
        case 'document':
            return <CadThumb value={value} />;
        case 'progress': {
            const n = Number(value);
            if (!Number.isFinite(n)) return <>{displayValue(value)}</>;
            const max = Number.isFinite(col?.max) ? col?.max as number : 100;
            const pct = max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
            return (
                <span className="inline-flex items-center gap-1.5 w-full">
                    <span
                        className="relative inline-block h-1.5 flex-1 rounded-full overflow-hidden"
                        style={{ background: 'var(--bg-tertiary)' }}
                        role="img"
                        aria-label={`${Math.round(pct)}%`}
                    >
                        <span
                            className="absolute inset-y-0 left-0"
                            style={{ width: `${pct}%`, background: ROLE_HEX[col?.tone as string] || 'var(--app-primary)' }}
                        />
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtNumber(n)}</span>
                </span>
            );
        }
        case 'user': {
            // The stored value may be an id; `labelFrom` names the column that
            // holds the readable name beside it. Without one, whatever is stored
            // is what we show — an id is ugly, but it is honest and it is
            // still the person.
            const label = col?.labelFrom && row && typeof row === 'object' && row[col.labelFrom]
                ? row[col.labelFrom]
                : value;
            return (
                <span className="inline-flex items-center gap-1.5 min-w-0">
                    <Monogram name={label} />
                    <span className="truncate" {...hoverable(displayValue(label))}>{displayValue(label)}</span>
                </span>
            );
        }
        case 'link':
            if (!isHttpUrl(value)) return <>{displayValue(value)}</>;
            return (
                <a
                    href={String(value)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                    style={{ color: 'var(--app-primary)' }}
                >
                    {displayValue(value)}
                </a>
            );
        default: {
            const style = textToneStyle(col, row, value);
            return style ? <span style={style}>{displayValue(value)}</span> : <>{displayValue(value)}</>;
        }
    }
}
