import { Check, Minus } from 'lucide-react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { makeValueFormatter } from '../chartPalette';
import { hoverable } from '../hoverable';
import { ROLE_COLORS, roleTextColor } from '../styleResolver';
import CadThumb from './CadThumb';
import { EM_DASH, displayValue } from '../uiBits';

/**
 * One table cell, for BOTH `data_grid` and `table`.
 *
 * These two components used to carry a private copy of this switch each
 * (AppDataGrid's `CellValue` and AppTable's `Cell`), and the copies had already
 * drifted: the grid understood `boolean` and `relation` and the table did not,
 * and an empty cell rendered muted in one and unstyled in the other. Any format
 * added to one would have had to be remembered into the other. One module, two
 * importers.
 *
 * NO LITERAL COLOURS. Every colour here is a token or a ROLE_COLORS role, so a
 * cell follows the app's theme and the high-contrast appearance. cellValue.test
 * asserts this over the source text — the same guard AppDataGrid and AppTable
 * carry, moved here with the code it protects.
 */

const fmtNumber = makeValueFormatter('number');
const fmtPercent = makeValueFormatter('percent');
const fmtCurrency = makeValueFormatter('currency');

/** Formats whose natural home is the right edge of the column. */
const NUMERIC_FORMATS = new Set(['number', 'currency', 'percent', 'progress']);

/**
 * The resolved text alignment for a column.
 *
 * 'auto' (the default) right-aligns numerics and left-aligns everything else —
 * a column of figures that does not line up on its last digit is the clearest
 * single tell that a table was not designed. An explicit align always wins.
 */
export function alignFor(col) {
    const explicit = col && col.align;
    if (explicit === 'left' || explicit === 'right' || explicit === 'center') return explicit;
    return NUMERIC_FORMATS.has(col?.format) ? 'right' : 'left';
}

export const ALIGN_CLASS = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function isHttpUrl(value) {
    const v = String(value || '').trim().toLowerCase();
    return v.startsWith('https://') || v.startsWith('http://');
}

/**
 * The tone for one cell, from the column's own configuration.
 *
 * `toneMap` is the author naming tones value by value (the shape `list` and
 * `kanban` already use). `toneFrom` names a SIBLING column whose value IS the
 * tone — which is what finally uses the `color` every config table in a
 * template already stores next to its rows, and what stopped every status pill
 * on every screen from being the same grey.
 */
export function toneForCell({ col, row, value }) {
    if (!col) return null;
    const map = Array.isArray(col.toneMap) ? col.toneMap : null;
    if (col.toneFrom && row && typeof row === 'object') {
        const raw = row[col.toneFrom];
        if (raw != null && raw !== '') {
            // The sibling's value goes through the column's toneMap first, the
            // way subtextToneFor already did: a status column holds "open",
            // not "warning", and mapping it is the only way that status can
            // colour a cell in another column. A value the map does not name
            // is taken as a tone name itself - the config-table case.
            const hit = map ? map.find((m) => m && String(m.value) === String(raw)) : null;
            if (hit && hit.tone) return hit.tone;
            return String(raw);
        }
    }
    if (!map || value == null) return null;
    const hit = map.find((m) => m && String(m.value) === String(value));
    return hit ? (hit.tone || null) : null;
}

/** The label for one cell — a toneMap entry may relabel the stored value. */
export function labelForCell({ col, value }) {
    const map = col && Array.isArray(col.toneMap) ? col.toneMap : null;
    if (!map || value == null) return value;
    const hit = map.find((m) => m && String(m.value) === String(value));
    return hit && hit.label != null ? hit.label : value;
}

/** A soft wash in the role's hue, with text readable on it. Mirrors AppList. */
function pillStyle(tone) {
    if (!tone || tone === 'neutral' || !ROLE_COLORS[tone]) {
        return { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    }
    return {
        background: `color-mix(in srgb, ${ROLE_COLORS[tone]} 16%, transparent)`,
        color: roleTextColor(tone),
    };
}

function Pill({ children, tone, dot = false }) {
    return (
        <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium${dot ? ' gap-1' : ''}`}
            style={pillStyle(tone)}
            data-app-cell-tone={tone || 'neutral'}
        >
            {/* badgeStyle:'dot' — the pill keeps its wash, the dot carries the
                tone at full strength (a 16% wash alone is hard to tell apart
                across a column of pills). */}
            {dot ? (
                <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: (tone && tone !== 'neutral' && ROLE_COLORS[tone]) || 'var(--text-muted)' }}
                    data-app-cell-dot={tone || 'neutral'}
                />
            ) : null}
            {children}
        </span>
    );
}

/**
 * A small uppercase marker beside the main text (spec: columns[].flagFrom) —
 * the SPOED case: one word that must be seen before the description is read,
 * without spending a whole column on it.
 */
function CellFlag({ text, tone }) {
    const t = ROLE_COLORS[tone] ? tone : 'warning';
    return (
        <span
            className="inline-flex shrink-0 items-center rounded px-1 font-semibold uppercase tracking-wide"
            style={{
                fontSize: 10.5,
                background: `color-mix(in srgb, ${ROLE_COLORS[t]} 16%, transparent)`,
                color: roleTextColor(t),
            }}
            data-app-cell-flag={t}
        >
            {text}
        </span>
    );
}

/**
 * The tone for a cell's SUBTEXT line: `subtextToneFrom` names a sibling whose
 * value maps through the column's toneMap (value→tone), or is a tone name
 * itself. Null means the default muted subtext.
 */
function subtextToneFor(col, row) {
    const key = col?.subtextToneFrom;
    if (!key || !row || typeof row !== 'object') return null;
    const raw = row[key];
    if (raw == null || raw === '') return null;
    const map = Array.isArray(col.toneMap) ? col.toneMap : null;
    const hit = map ? map.find((m) => m && String(m.value) === String(raw)) : null;
    if (hit && hit.tone) return hit.tone;
    return ROLE_COLORS[raw] ? String(raw) : null;
}

/** Up to two initials — "Anna de Vries" → AV, "chidi" → C. */
export function initialsOf(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}

const MONOGRAM_TONES = ['primary', 'info', 'success', 'warning', 'danger'];

/**
 * A person's face without a photo.
 *
 * The tone is picked from the NAME, not at random, so the same colleague keeps
 * the same colour on every screen and across reloads — a monogram that changed
 * hue per render would be worse than no colour at all.
 */
export function Monogram({ name, size = 20 }) {
    const label = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) % 997;
    const tone = MONOGRAM_TONES[hash % MONOGRAM_TONES.length];
    return (
        <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center rounded-full font-medium"
            style={{ ...pillStyle(tone), width: size, height: size, fontSize: Math.round(size * 0.45) }}
            data-app-cell-monogram={tone}
        >
            {initialsOf(label)}
        </span>
    );
}

function relativeFrom(value, now, t) {
    const then = new Date(value).getTime();
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
function asTags(value) {
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
function renderMainValue({ value, format, col, row, now, t }) {
    // An empty cell is muted everywhere. AppTable used to render a bare em-dash
    // at full text colour, which read as content rather than as absence.
    if (value == null || value === '') {
        // A `check` column is the exception: false is a real answer, not a gap.
        if (format !== 'check') {
            // ...unless the column says a gap here is a DEFECT (spec:
            // columns[].emptyTone): the material a part cannot be cut without
            // shows its dash in the colour of a problem, not of an absence.
            const gapTone = col?.emptyTone && ROLE_COLORS[col.emptyTone] ? col.emptyTone : null;
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
            const d = new Date(value);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleDateString()}</>;
        }
        case 'datetime': {
            const d = new Date(value);
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
            const d = new Date(value);
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
            const max = Number.isFinite(col?.max) ? col.max : 100;
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
                            style={{ width: `${pct}%`, background: ROLE_COLORS[col?.tone] || 'var(--app-primary)' }}
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

/**
 * A text or number cell has no pill to carry a tone, so the tone colours the
 * text itself. Only a tone the column actually resolves - through toneFrom or
 * a toneMap hit - changes anything; a column without either renders exactly as
 * before, which is every text column that exists today.
 */
function textToneStyle(col, row, value) {
    if (!col || (!col.toneFrom && !Array.isArray(col.toneMap))) return undefined;
    const tone = toneForCell({ col, row, value });
    if (!tone || tone === 'neutral' || !ROLE_COLORS[tone]) return undefined;
    return { color: roleTextColor(tone) };
}

export default function CellValue({ value, format = 'text', col = null, row = null, now = null }) {
    const { t } = useTranslation();
    const main = renderMainValue({ value, format, col, row, now, t });

    // Decorations (spec: columns[].flagFrom / subtextFrom). A column without
    // them returns the main content verbatim — the identity path.
    const flagRaw = col?.flagFrom && row && typeof row === 'object' ? row[col.flagFrom] : null;
    const hasFlag = !!flagRaw;
    const subRaw = col?.subtextFrom && row && typeof row === 'object' ? row[col.subtextFrom] : null;
    const hasSub = subRaw != null && subRaw !== '';
    if (!hasFlag && !hasSub) return main;

    // The flag sits INLINE beside the main text; with the column's truncate on,
    // the text gives way and the flag stays whole — a marker that truncates to
    // "SPO…" has stopped being a marker.
    const mainLine = hasFlag ? (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <span className={col?.truncate ? 'min-w-0 truncate' : 'min-w-0'}>{main}</span>
            <CellFlag text={String(flagRaw)} tone={col?.flagTone || 'warning'} />
        </span>
    ) : main;
    if (!hasSub) return mainLine;

    const subTone = subtextToneFor(col, row);
    return (
        <span className="block min-w-0">
            <span className={`block min-w-0${col?.truncate ? ' truncate' : ''}`}>{mainLine}</span>
            {/* Always truncated: the subtext is a one-line annotation, and a
                td-level nowrap would otherwise hide its overflow with no
                ellipsis. roleTextColor keeps the tone readable in dark mode. */}
            <span
                className="block truncate text-xs"
                {...hoverable(String(subRaw))}
                style={{ color: subTone ? roleTextColor(subTone) : 'var(--text-muted)' }}
                data-app-cell-subtext={subTone || 'muted'}
            >
                {String(subRaw)}
            </span>
        </span>
    );
}
