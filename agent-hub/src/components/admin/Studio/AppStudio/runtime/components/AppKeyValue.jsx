import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';

/** App Studio runtime — 'keyValue'. Spec: server/appStudio/componentSpecs.js. */

/**
 * One labelled value, readable.
 *
 * A `multiselect` column is stored as TEXT holding JSON (dataModel does this on
 * purpose so both SQL dialects treat it as opaque text), so it arrives here as
 * `'["laadpaal","zonnepanelen"]'` and displayValue — correctly, for a string —
 * painted the brackets and quotes at the user. A labelled field is exactly
 * where a person expects to READ the list, so expand it to a comma list.
 * Anything that is not a JSON array falls through untouched.
 */
function readableLeaf(value) {
    if (typeof value === 'string') {
        const str = value.trim();
        if (str.startsWith('[')) {
            try {
                const parsed = JSON.parse(str);
                if (Array.isArray(parsed)) {
                    const items = parsed.filter((v) => v != null && v !== '').map((v) => String(v));
                    return items.length ? items.join(', ') : displayValue(null);
                }
            } catch {
                // Not JSON after all — show the string as authored.
            }
        }
    }
    return displayValue(value);
}

export default function AppKeyValue({ node }) {
    const { actionState, dataState, scope } = useRuntime();
    const { fields = [], layout = 'rows', columns = 2, emptyText = 'No data yet.' } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={3} />;

    // An array is what a `records` binding hands back, and record_detail
    // already tolerates it by taking the first row. Rejecting it here meant
    // the same binding worked in one component and showed an empty state in
    // the other.
    const first = Array.isArray(source) ? source.find((r) => r && typeof r === 'object') : null;
    const record = Array.isArray(source)
        ? (first || null)
        : (source && typeof source === 'object' ? source : null);
    // No configured fields → show the record's own keys (bounded like the spec).
    const rows = fields.length
        ? fields
        : Object.keys(record || {}).slice(0, 20).map((key) => ({ key, label: key }));

    if (!record || rows.length === 0) return <EmptyText text={emptyText} />;

    const size = node.style?.size || 'md';

    // 'grid' stacks the label over the value across N columns, with a vertical
    // divider between columns — a compact fact strip (Client · Company · Order).
    if (layout === 'grid') {
        const cols = Math.min(4, Math.max(1, Number.isInteger(columns) ? columns : 2));
        return (
            <dl
                className={`grid gap-y-2 ${size === 'sm' ? 'text-xs' : 'text-sm'}`}
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                data-app-keyvalue-layout="grid"
            >
                {rows.map((field, i) => {
                    // Divider between columns: every cell but the first in its row.
                    const bordered = i % cols !== 0;
                    return (
                        <div
                            key={field.key}
                            className={`flex flex-col gap-0.5 min-w-0 ${bordered ? 'pl-3' : ''}`}
                            style={bordered ? { borderLeftWidth: '1px', borderLeftStyle: 'solid', borderLeftColor: 'var(--border-default)' } : undefined}
                        >
                            <dt className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                {field.label || field.key}
                            </dt>
                            <dd className="break-words min-w-0">{readableLeaf(walkPath(record, field.key))}</dd>
                        </div>
                    );
                })}
            </dl>
        );
    }

    return (
        <dl className={`flex flex-col ${size === 'sm' ? 'text-xs gap-1' : 'text-sm gap-1.5'}`}>
            {rows.map((field) => (
                <div key={field.key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {field.label || field.key}
                    </dt>
                    <dd className="text-right break-words min-w-0">{readableLeaf(walkPath(record, field.key))}</dd>
                </div>
            ))}
        </dl>
    );
}
