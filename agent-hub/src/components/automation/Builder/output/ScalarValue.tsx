import { useState, type ComponentType, type ReactNode } from 'react';
import { AlertTriangle, ListTree } from 'lucide-react';
import JsonTreeJs from '../debug/JsonTree';
import { mapAttrs, type MapCtx } from './mapAttrs';
import { scalarText } from './valueHelpers';

interface JsonTreeProps {
    value: unknown;
    basePath?: string;
    onCopyPath?: ((path: string) => void) | null;
    emptyMessage?: string;
}
export const JsonTree = JsonTreeJs as unknown as ComponentType<JsonTreeProps>;

/**
 * A scalar, usually text. Long text used to be cut off at 600 characters with
 * no way to see the rest, which made the panel useless for exactly the case
 * that needs it most (an AI answer, an email body, a fetched page).
 */
const SCALAR_CLAMP = 600;

/**
 * Only SNIFF strings up to this size for JSON. A "Call a web service" step can
 * hand over a megabyte of `body`; the sniff looks at the two ends only, under a
 * ceiling, and the actual JSON.parse waits for the click.
 */
const JSON_SNIFF_MAX = 512 * 1024;

function looksLikeJson(s: string): boolean {
    if (s.length > JSON_SNIFF_MAX || s.length < 2) return false;
    const head = s.slice(0, 64).trimStart();
    const first = head[0];
    if (first !== '{' && first !== '[') return false;
    const tail = s.slice(-64).trimEnd();
    const last = tail[tail.length - 1];
    return first === '{' ? last === '}' : last === ']';
}

export function Empty({ children }: { children: ReactNode }) {
    return <span className="text-[var(--text-tertiary)] italic">{children}</span>;
}

/** A web-service response the runtime had to cut short. */
export function ClipWarning() {
    return (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>This response was cut short. What is below is only the part that came back.</span>
        </div>
    );
}

interface ScalarProps { value: unknown; emptyMessage?: string; map?: MapCtx | null }

export function Scalar({ value, emptyMessage = '—', map = null }: ScalarProps) {
    const [expanded, setExpanded] = useState(false);
    // `undefined` = never parsed; `null` = parsed, and it was not JSON after all.
    const [parsed, setParsed] = useState<unknown>(undefined);
    const [asTree, setAsTree] = useState(false);
    if (value === null || value === undefined) return <Empty>{emptyMessage}</Empty>;
    const s = scalarText(value);
    const long = s.length > SCALAR_CLAMP;
    const shown = long && !expanded ? `${s.slice(0, SCALAR_CLAMP - 1)}…` : s;
    const jsonish = looksLikeJson(s);

    const openTree = () => {
        let next = parsed;
        if (next === undefined) {
            try { next = JSON.parse(s); } catch { next = null; }
            setParsed(next);
        }
        setAsTree(next !== null && typeof next === 'object');
    };

    // A 372 000-character JSON body used to offer exactly one affordance:
    // "Show all 372014 characters". The structure is right there; hand it over.
    if (asTree && parsed != null) return <ScalarTree value={parsed} onBack={() => setAsTree(false)} />;

    // Spread first, merged className: the spread used to clobber styling.
    const attrs = mapAttrs(map, '');
    return (
        <span className="inline-block max-w-full">
            <span {...attrs} className={`break-words whitespace-pre-wrap text-[var(--text-primary)] ${attrs.className || ''}`.trim()}>{shown}</span>
            {long && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
                    className="ml-1.5 text-[10px] text-[var(--accent)] hover:underline align-baseline"
                >
                    {expanded ? 'Show less' : `Show all ${s.length} characters`}
                </button>
            )}
            {jsonish && parsed !== null && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openTree(); }}
                    className="ml-1.5 text-[10px] text-[var(--accent)] hover:underline align-baseline inline-flex items-center gap-0.5"
                >
                    <ListTree size={10} /> Show as tree
                </button>
            )}
            {parsed === null && (
                <span className="ml-1.5 text-[10px] text-[var(--text-tertiary)]">Not valid JSON</span>
            )}
        </span>
    );
}

/** A string that parsed, shown as the collapsible tree it really is. */
function ScalarTree({ value, onBack }: { value: unknown; onBack: () => void }) {
    return (
        <div className="min-w-0">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onBack(); }}
                className="mb-1 text-[10px] text-[var(--accent)] hover:underline"
            >
                Show as text
            </button>
            {/* A definite height: JsonTree brings its own scroller, and its
                `h-full` needs something to resolve against. */}
            <div className="h-64 rounded border border-[var(--border-default)] overflow-hidden">
                <JsonTree value={value} emptyMessage="Nothing in there." />
            </div>
        </div>
    );
}
