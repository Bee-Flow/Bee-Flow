import { appendKey } from '@shared/expr/path.mjs';
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { summariseData } from '../flow/dataSummary';

/**
 * Collapsible, searchable JSON tree with hover-revealed "copy path"
 * buttons. Designed for the step inspector's Inputs / Output sub-tabs:
 * each leaf's path is generated relative to `basePath` so it can be
 * copied straight into a downstream binding (e.g.
 * `steps.s_abc.output.results[0].subject`).
 *
 * Search filters the tree to nodes whose key or stringified value
 * matches; ancestors of any match are kept so context isn't lost.
 *
 * Props:
 *   value             — the JSON to render (any type, including null)
 *   basePath          — dotted path prefix for leaf-path generation
 *   searchable        — show the top search box (default true)
 *   onCopyPath(path)  — called when the user clicks a copy-path button
 *   maxInitialDepth   — how many container levels start expanded (default 2)
 *   emptyMessage      — what to show when value is null/undefined
 */

/**
 * How many children of ONE container are rendered before the "+N more" line.
 * Same idiom (and the same number) as the friendly table's row cap: a 5 000
 * element array is not readable, it is just a way to freeze the panel.
 */
const MAX_ROWS = 50;

/**
 * Separator for the internal node keys the search pre-pass builds. It is not a
 * binding path — it only has to be collision-free, and NUL cannot occur in a
 * JSON key that came off the wire.
 */
const KEY_SEP = '\u0000';

export default function JsonTree({
    value,
    basePath = '',
    searchable = true,
    onCopyPath,
    maxInitialDepth = 2,
    emptyMessage = 'No data yet.',
}) {
    const [query, setQuery] = useState('');
    const [copied, setCopied] = useState(false);
    // Expand-all / collapse-all remount the tree with a different initial
    // depth. Every node owns its open state locally, and a remount is the one
    // way to reset all of them at once without lifting that state up.
    const [override, setOverride] = useState(null); // { depth, seq }
    const copiedTimer = useRef(null);
    useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

    const filterFn = useMemo(() => makeFilter(query), [query]);
    // ONE pre-pass building the set of matching node keys, instead of the old
    // per-node `nodeMatches` that re-walked the whole subtree for every node
    // it rendered — O(n²), and a guaranteed hang on the first keystroke
    // against a real API payload.
    const matches = useMemo(
        () => (filterFn ? collectMatches(value, filterFn) : null),
        [value, filterFn],
    );

    const isEmpty = value === null || value === undefined;
    const initialDepth = override ? override.depth : maxInitialDepth;

    const copyJson = useCallback(() => {
        try {
            navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
            setCopied(true);
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1400);
        } catch {
            // Clipboard is blocked in non-secure contexts (and unserialisable
            // values throw) — silent is better than a red banner here.
        }
    }, [value]);

    return (
        <div className="flex flex-col h-full min-h-0 text-xs">
            {!isEmpty && (
                <TreeToolbar
                    searchable={searchable}
                    query={query}
                    onQuery={setQuery}
                    onExpandAll={() => setOverride((o) => ({ depth: Infinity, seq: (o?.seq || 0) + 1 }))}
                    onCollapseAll={() => setOverride((o) => ({ depth: 0, seq: (o?.seq || 0) + 1 }))}
                    onCopy={copyJson}
                    copied={copied}
                />
            )}
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar font-mono py-1">
                {isEmpty ? (
                    <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)] italic">
                        {emptyMessage}
                    </div>
                ) : matches && !matches.has('') ? (
                    <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)] italic">
                        Nothing matches “{query.trim()}”.
                    </div>
                ) : (
                    <TreeNode
                        // Remount on expand-all / collapse-all: see `override`.
                        key={override ? `d${override.seq}` : 'd0'}
                        name={null}
                        value={value}
                        path={basePath}
                        nodeKey=""
                        depth={0}
                        maxInitialDepth={initialDepth}
                        onCopyPath={onCopyPath}
                        matches={matches}
                    />
                )}
            </div>
        </div>
    );
}

/**
 * Search box plus the three things a tree this size needs: open everything,
 * fold everything, and take the raw JSON with you. The footer under this panel
 * has promised "the raw data" for a while and delivered a tree.
 */
function TreeToolbar({ searchable, query, onQuery, onExpandAll, onCollapseAll, onCopy, copied }) {
    return (
        <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]/30 shrink-0">
            {searchable && (
                <>
                    <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => onQuery(e.target.value)}
                        placeholder="Search keys or values…"
                        aria-label="Search keys or values"
                        className="flex-1 min-w-0 bg-transparent text-[11px] text-[var(--text-primary)] focus:outline-none"
                    />
                </>
            )}
            <div className={`flex items-center gap-0.5 ${searchable ? '' : 'ml-auto'}`}>
                <TreeAction Icon={ChevronsUpDown} label="Expand all" onClick={onExpandAll} />
                <TreeAction Icon={ChevronsDownUp} label="Collapse all" onClick={onCollapseAll} />
                <TreeAction
                    Icon={copied ? Check : Copy}
                    label="Copy JSON"
                    title={copied ? 'Copied' : 'Copy the whole value as JSON'}
                    onClick={onCopy}
                />
            </div>
        </div>
    );
}

function TreeAction({ Icon, label, title, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={title || label}
            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        >
            <Icon size={12} />
        </button>
    );
}

function TreeNode({ name, value, path, nodeKey, depth, maxInitialDepth, onCopyPath, matches }) {
    const isObj = value && typeof value === 'object' && !Array.isArray(value);
    const isArr = Array.isArray(value);
    const isContainer = isObj || isArr;
    const [open, setOpen] = useState(depth < maxInitialDepth);
    const [showAllRows, setShowAllRows] = useState(false);

    if (matches && !matches.has(nodeKey)) return null;

    const indent = depth * 12;
    const labelText = name == null ? '' : String(name);

    const copyPath = (e) => {
        e.stopPropagation();
        if (path) onCopyPath?.(path);
    };

    if (!isContainer) {
        return (
            <div
                className="group flex items-center gap-1.5 py-0.5 hover:bg-[var(--bg-secondary)]"
                style={{ paddingLeft: indent + 16, paddingRight: 8 }}
            >
                {labelText && (
                    <span className="text-[var(--text-secondary)] truncate shrink-0">
                        {labelText}:
                    </span>
                )}
                <span className={`truncate min-w-0 ${leafValueClass(value)}`} title={String(value)}>
                    {formatLeafValue(value)}
                </span>
                {path && onCopyPath && (
                    <button
                        type="button"
                        onClick={copyPath}
                        title={`Copy path: ${path}`}
                        className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--accent)]"
                        aria-label="Copy path"
                    >
                        <Copy size={10} />
                    </button>
                )}
            </div>
        );
    }

    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    // Filter FIRST, then cap — otherwise "+N more" would count children the
    // search has already hidden.
    const visible = matches
        ? entries.filter(([k]) => matches.has(`${nodeKey}${KEY_SEP}${k}`))
        : entries;
    const shown = showAllRows ? visible : visible.slice(0, MAX_ROWS);
    const hidden = visible.length - shown.length;
    // A list says "3 records" everywhere else in the product; saying
    // "Array(3)" here made the same fact read as a different one. Objects keep
    // "{ N keys }" on purpose: summariseData unwraps an envelope and would
    // report the INNER list's count — a different node than this one.
    const summary = isArr
        ? (summariseData(value)?.label ?? `${entries.length} items`)
        : `{ ${entries.length === 0 ? 'empty' : `${entries.length} key${entries.length === 1 ? '' : 's'}`} }`;

    return (
        <div>
            <div
                className="group flex items-center gap-1 py-0.5 cursor-pointer select-none hover:bg-[var(--bg-secondary)]"
                style={{ paddingLeft: indent + 2, paddingRight: 8 }}
                onClick={() => setOpen(o => !o)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpen(o => !o);
                    }
                }}
            >
                {open
                    ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
                    : <ChevronRight size={10} className="text-[var(--text-tertiary)] shrink-0" />}
                {labelText && (
                    <span className="text-[var(--text-secondary)] truncate">{labelText}:</span>
                )}
                <span className="text-[var(--text-tertiary)] truncate">{summary}</span>
                {path && onCopyPath && (
                    <button
                        type="button"
                        onClick={copyPath}
                        title={`Copy path: ${path}`}
                        className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--accent)]"
                        aria-label="Copy path"
                    >
                        <Copy size={10} />
                    </button>
                )}
            </div>
            {open && shown.map(([k, v]) => {
                // Written by the runtime grammar's writer: `headers["content-type"]`
                // is a path the run reads; `headers.content-type` was not.
                const childPath = appendKey(path, isArr ? Number(k) : k);
                return (
                    <TreeNode
                        key={k}
                        name={k}
                        value={v}
                        path={childPath}
                        nodeKey={`${nodeKey}${KEY_SEP}${k}`}
                        depth={depth + 1}
                        maxInitialDepth={maxInitialDepth}
                        onCopyPath={onCopyPath}
                        matches={matches}
                    />
                );
            })}
            {open && hidden > 0 && (
                <button
                    type="button"
                    onClick={() => setShowAllRows(true)}
                    style={{ paddingLeft: (depth + 1) * 12 + 16 }}
                    className="block w-full text-left py-0.5 pr-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                >
                    +{hidden} more
                </button>
            )}
        </div>
    );
}

function formatLeafValue(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
}

function leafValueClass(v) {
    if (v === null || v === undefined) return 'text-[var(--text-tertiary)]';
    if (typeof v === 'string') return 'text-emerald-700 dark:text-emerald-400';
    if (typeof v === 'number') return 'text-amber-700 dark:text-amber-400';
    if (typeof v === 'boolean') return 'text-blue-700 dark:text-blue-400';
    return 'text-[var(--text-primary)]';
}

function makeFilter(query) {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return (text) => text.toLowerCase().includes(q);
}

/**
 * Every node key that must stay visible for `filterFn`, in ONE walk.
 *
 * A node is kept when its own key matches, when its (leaf) value matches, or
 * when any descendant is kept — the same rule the old recursive `nodeMatches`
 * applied, except that this computes it bottom-up and remembers the answer
 * instead of recomputing the whole subtree once per rendered node.
 */
export function collectMatches(value, filterFn) {
    const keep = new Set();
    if (!filterFn) return keep;
    const walk = (nodeKey, name, val) => {
        let matched = name != null && filterFn(String(name));
        if (val !== null && val !== undefined && typeof val === 'object') {
            const entries = Array.isArray(val) ? val.map((v, i) => [i, v]) : Object.entries(val);
            for (const [k, v] of entries) {
                // No short-circuit: descendants must be marked even once this
                // node is known to be kept, or they would vanish from it.
                if (walk(`${nodeKey}${KEY_SEP}${k}`, k, v)) matched = true;
            }
        } else if (val !== null && val !== undefined && filterFn(String(val))) {
            matched = true;
        }
        if (matched) keep.add(nodeKey);
        return matched;
    };
    walk('', null, value);
    return keep;
}
