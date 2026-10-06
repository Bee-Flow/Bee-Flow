import { appendKey, appendWildcard } from '@shared/expr/path.mjs';
import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import { joinKeyPath, keyPickable } from './keyPath';
import { mergeElements } from './upstream/fieldTree';
import { previewValue } from '../../../../utils/bindingHelpers';

/**
 * JsonTreePicker — a recursive, arbitrary-depth JSON tree whose rows emit
 * RELATIVE extraction paths (the parse_json field-path dialect resolved by
 * walkRelativePath on both client and server). Not built on the upstream
 * field tree: its paths are RELATIVE to the value, and each list carries its
 * own "first item / each item" choice.
 *
 * Paths are written by the runtime grammar's own writer (keyPath.js →
 * shared/expr/path.mjs):
 *   - identifier-safe object key      → `.key`
 *   - anything else                   → `["key"]`, JSON-escaped
 *   - array element                   → `[0]` or, when the array's toggle is
 *                                       set to "each item", `[*]` (flatten)
 * Root arrays are supported: paths then START with `[0]`/`[*]`.
 *
 * Props: { value, onPick(path), maxDepth = 20, maxChildren = 200 }
 */
// The quoting rule and the "can this key be expressed at all" probe now live
// in ./keyPath, shared with the mismatch box: both build a path out of a key
// they did not write, and a second copy of the rule is how one of them ends
// up emitting `body.content-type` — a path this picker previews and the
// server resolves to undefined.

export default function JsonTreePicker({ value, onPick, maxDepth = 20, maxChildren = 200 }) {
    if (value === null || typeof value !== 'object') {
        return (
            <div className="text-[11px] italic text-[var(--text-tertiary)]">
                No object or list to pick from.
            </div>
        );
    }
    return (
        <div className="text-xs max-h-64 overflow-auto rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 p-1.5">
            <Children value={value} path="" depth={0} onPick={onPick} maxDepth={maxDepth} maxChildren={maxChildren} />
        </div>
    );
}

/** Rows for the members of one object/array value. */
function Children({ value, path, depth, onPick, maxDepth, maxChildren, pickable = true }) {
    // One toggle per ARRAY node: pick from the first item ([0]) or from each
    // item ([*], flattens). "Each item" shows the UNION of the elements' keys
    // (upstream/fieldTree mergeElements), so a key only a later element has,
    // or a list that starts with null, is still there to pick; "first item"
    // shows exactly element 0, the only thing `[0]` reads.
    const [each, setEach] = useState(false);

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return <div className="pl-5 text-[11px] italic text-[var(--text-tertiary)]">empty list</div>;
        }
        const idx = each ? '*' : '0';
        const chip = (label, isEach) => (
            <button
                type="button"
                onClick={() => setEach(isEach)}
                className={`px-1.5 py-0.5 rounded-full border text-[10px] transition ${each === isEach
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30'
                    : 'text-[var(--text-tertiary)] border-[var(--border-default)] hover:text-[var(--text-primary)]'}`}
            >
                {label}
            </button>
        );
        return (
            <>
                <div className="flex items-center gap-1 py-0.5 pl-5">
                    {chip('first item', false)}
                    {chip('each item', true)}
                </div>
                <TreeNode
                    nodeKey={`[${idx}]`}
                    value={each ? mergeElements(value) : value[0]}
                    path={each ? appendWildcard(path) : appendKey(path, 0)}
                    pickable={pickable}
                    depth={depth}
                    onPick={onPick}
                    maxDepth={maxDepth}
                    maxChildren={maxChildren}
                />
            </>
        );
    }

    const entries = Object.entries(value);
    const shown = entries.slice(0, maxChildren);
    return (
        <>
            {shown.map(([k, v]) => (
                <TreeNode
                    key={k}
                    nodeKey={k}
                    value={v}
                    path={joinKeyPath(path, k)}
                    pickable={pickable && keyPickable(k)}
                    depth={depth}
                    onPick={onPick}
                    maxDepth={maxDepth}
                    maxChildren={maxChildren}
                />
            ))}
            {entries.length > maxChildren && (
                <div className="pl-5 text-[11px] italic text-[var(--text-tertiary)]">
                    … {entries.length - maxChildren} more
                </div>
            )}
        </>
    );
}

function TreeNode({ nodeKey, value, path, depth, onPick, maxDepth, maxChildren, pickable = true }) {
    const isObj = value !== null && typeof value === 'object';
    const hasChildren = isObj
        && depth < maxDepth
        && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
    // Collapsed by default beyond depth 2 so huge payloads open readable.
    const [open, setOpen] = useState(depth < 2);

    return (
        <div>
            <div className="flex items-center gap-0.5">
                {hasChildren ? (
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-label={`Toggle ${nodeKey}`}
                        className="shrink-0 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                ) : (
                    <span className="shrink-0 w-[17px]" />
                )}
                {pickable ? (
                    <button
                        type="button"
                        onClick={() => onPick(path)}
                        title={path}
                        className="flex-1 min-w-0 flex items-baseline gap-2 px-1 py-0.5 rounded text-left hover:bg-[var(--bg-secondary)] transition"
                    >
                        <span className="font-mono text-[var(--text-primary)] truncate">{nodeKey}</span>
                        <span className="text-[10px] text-[var(--text-tertiary)] truncate">{previewValue(value, 40)}</span>
                    </button>
                ) : (
                    <span
                        title="This key contains characters a field path cannot express — copy the value manually instead."
                        className="flex-1 min-w-0 flex items-baseline gap-2 px-1 py-0.5 rounded text-left opacity-60 cursor-not-allowed"
                    >
                        <span className="font-mono text-[var(--text-primary)] truncate">{nodeKey}</span>
                        <span className="text-[10px] text-[var(--text-tertiary)] truncate">{previewValue(value, 40)}</span>
                    </span>
                )}
            </div>
            {hasChildren && open && (
                <div className="pl-3 ml-1.5 border-l border-[var(--border-default)]">
                    <Children
                        value={value}
                        path={path}
                        pickable={pickable}
                        depth={depth + 1}
                        onPick={onPick}
                        maxDepth={maxDepth}
                        maxChildren={maxChildren}
                    />
                </div>
            )}
        </div>
    );
}
