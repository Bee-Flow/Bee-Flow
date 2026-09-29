import CadThumb from './CadThumb';
import renderInlineMarkdown from '../markdownInline';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver';
import { EM_DASH, EmptyText, ErrorText, SkeletonLines, displayValue , useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'record_detail'. Spec: server/appStudio/componentSpecs.js.
 * Labeled fields of ONE record (typically a {kind:'record'} binding whose
 * filter reads screen.params — the read half of master→detail). An empty
 * `fields` list derives label/value rows from the record's own keys.
 */

const SYSTEM_KEYS = new Set(['id', 'created_at', 'updated_at', 'created_by']);

function isHttpUrl(value) {
    const v = String(value || '').trim().toLowerCase();
    return v.startsWith('https://') || v.startsWith('http://');
}

/** Format one field value — mirrors the data_grid cell formats + datetime/markdown. */
export function FieldValue({ value, format }) {
    if (value == null || value === '') return <span style={{ color: 'var(--text-muted)' }}>{EM_DASH}</span>;
    switch (format) {
        // The file itself, not its descriptor. Shared with the data_grid's
        // columns so a drawing opens the same way wherever it is shown.
        case 'document':
        case 'cad':
            return <CadThumb value={value} />;
        case 'number': {
            const n = Number(value);
            return <>{Number.isFinite(n) ? n.toLocaleString() : displayValue(value)}</>;
        }
        case 'date': {
            const d = new Date(value);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleDateString()}</>;
        }
        case 'datetime': {
            const d = new Date(value);
            return <>{Number.isNaN(d.getTime()) ? displayValue(value) : d.toLocaleString()}</>;
        }
        case 'badge':
            return (
                <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                    {displayValue(value)}
                </span>
            );
        case 'link':
            if (!isHttpUrl(value)) return <>{displayValue(value)}</>;
            return (
                <a
                    href={String(value)} target="_blank" rel="noopener noreferrer"
                    className="underline underline-offset-2" style={{ color: 'var(--app-primary)' }}
                >
                    {displayValue(value)}
                </a>
            );
        case 'markdown':
            return <>{renderInlineMarkdown(String(value))}</>;
        default:
            return <>{displayValue(value)}</>;
    }
}

export default function AppRecordDetail({ node }) {
    const { actionState, dataState, scope } = useRuntime();
    const { fields = [], columns = 2, emptyText = 'No record selected.', layout = 'stacked' } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={4} />;

    // A record binding resolves to one row; tolerate a rows array by taking the first.
    const record = Array.isArray(source) ? source[0] : source;
    if (!record || typeof record !== 'object') return <EmptyText text={emptyText} />;

    const effFields = (Array.isArray(fields) && fields.length)
        ? fields.filter((f) => f && typeof f.key === 'string' && f.key)
        : Object.keys(record)
            .filter((k) => !SYSTEM_KEYS.has(k))
            .slice(0, 30)
            .map((key) => ({ key, label: key, format: 'text' }));

    if (effFields.length === 0) return <EmptyText text={emptyText} />;

    const cols = Number.isInteger(columns) ? Math.max(1, Math.min(3, columns)) : 2;

    // height:'fill' — offered by the inspector, ignored until now, so a card
    // set to fill spilled out of its cell on a short window and the panel
    // around it grew a second scrollbar. Filled, the card IS its own scroll
    // region, the way list and timeline are. `content-start` because a grid
    // given a full height otherwise stretches its auto rows to fill it, and a
    // six-field card would space its fields out down the whole column.
    const fillCls = isFill(node) ? ' app-fill h-full min-h-0 overflow-y-auto content-start' : '';

    // Groups (spec: fields[].group), in order of first appearance. Fields
    // without a group come first, under no heading — so a list that never
    // set one renders exactly as it did.
    const groups = [];
    for (const field of effFields) {
        const name = typeof field.group === 'string' ? field.group.trim() : '';
        let g = groups.find((x) => x.name === name);
        if (!g) { g = { name, fields: [] }; groups.push(g); }
        g.fields.push(field);
    }
    groups.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : 0));

    const heading = (name) => (
        <div
            key={`grp-${name}`}
            className="text-[11px] font-semibold uppercase tracking-wide pt-2 first:pt-0"
            style={{ color: 'var(--text-muted)', gridColumn: '1 / -1' }}
            data-app-recorddetail-group={name}
        >
            {name}
        </div>
    );

    // 'rows': label and value on one line, value right-aligned, a hairline
    // under each. Long values truncate with the whole value on hover rather
    // than breaking mid-word — a filename split across two lines is unreadable
    // either way, and here it also broke the column beside it.
    if (layout === 'rows') {
        return (
            <dl
                className={`grid gap-x-5 gap-y-0${fillCls}`}
                data-app-recorddetail="true"
                data-app-recorddetail-layout="rows"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
                {groups.map((g) => [
                    g.name ? heading(g.name) : null,
                    ...g.fields.map((field, i) => {
                        const value = walkPath(record, field.key);
                        const isFile = field.format === 'document' || field.format === 'cad';
                        const plain = !isFile && value != null && typeof value !== 'object' ? String(value) : undefined;
                        return (
                            <div
                                key={`${g.name}-${field.key}-${i}`}
                                className={`flex ${isFile ? 'items-center' : 'items-baseline'} justify-between gap-3 py-1.5 min-w-0`}
                                style={{ borderBottom: '1px solid var(--app-hairline, var(--border-default))' }}
                            >
                                <dt className="shrink-0 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {field.label || field.key}
                                </dt>
                                <dd
                                    className={`text-sm text-right min-w-0${isFile ? '' : ' truncate'}`}
                                    style={{ color: 'var(--text-primary)' }}
                                    title={plain}
                                >
                                    <FieldValue value={value} format={field.format || 'text'} />
                                </dd>
                            </div>
                        );
                    }),
                ])}
            </dl>
        );
    }

    return (
        <dl
            className={`grid gap-x-6 gap-y-3${fillCls}`}
            data-app-recorddetail="true"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
            {groups.map((g) => [
                g.name ? heading(g.name) : null,
                ...g.fields.map((field, i) => (
                    <div key={`${g.name}-${field.key}-${i}`} className="min-w-0">
                        <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                            {field.label || field.key}
                        </dt>
                        <dd className="text-sm mt-0.5 break-words" style={{ color: 'var(--text-primary)' }}>
                            <FieldValue value={walkPath(record, field.key)} format={field.format || 'text'} />
                        </dd>
                    </div>
                )),
            ])}
        </dl>
    );
}
