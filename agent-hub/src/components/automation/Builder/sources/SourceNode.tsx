import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useState, type ComponentType, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { parseLegacyPath } from '@shared/mapping/index.mjs';
import { isUnconfirmed, nodeChildren, nodeLabel, nodeTitle, nodeValue, type TreeNode } from './useSourceTree';
import { useTranslation } from '../../../../hooks/useTranslation';
import { previewValue } from '../../../../utils/bindingHelpers';
import { startPathDrag } from '../mapping/bindingDnd';
import { pathInUse } from '../mapping/boundPaths';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { describeField } from '../mapping/fieldKinds';
import { SOURCE_MIME, type PickOpts } from '../output/mapAttrs';

/**
 * One value an earlier step hands over, in the "Comes in" column and the
 * variable tree: a person's name for it, its kind, a grey preview, and a
 * chevron when there is something inside.
 *
 * Objects open like folders at any depth ("Klant › Adres › Postcode"); a
 * list of records opens to its columns, also before the first run; a JSON
 * string opens to what the text holds, marked "read from text" (those rows
 * can be looked at, not picked: the runtime does not read into a string
 * through a legacy path). A key the last real run did not produce is dimmed
 * and says so. The row's title is its label and value, never its path.
 *
 * Click inserts the value into the focused setting; drag carries it to one.
 * Both hand over the legacy path (what today's fields store) and the Source.
 */
const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;

type Describe = { kind: string; word: string; detail?: string | null };
const describe = describeField as unknown as (field: unknown, root: unknown, t: unknown) => Describe;
const inUse = pathInUse as unknown as (path: string, used: Set<string>) => boolean;

// The row indent per depth (12px + 14px a level), as literal classes so
// Tailwind sees them; deeper than the table reaches stays at its last step.
const INDENT = ['pl-[12px]', 'pl-[26px]', 'pl-[40px]', 'pl-[54px]', 'pl-[68px]', 'pl-[82px]', 'pl-[96px]', 'pl-[110px]', 'pl-[124px]'];

export interface SourceNodeProps {
    node: TreeNode;
    onInsert?: ((path: string, opts?: PickOpts) => void) | null;
    depth: number;
    previewSample: unknown;
    /** Paths the step already binds (mapping/boundPaths.js). */
    usedPaths?: Set<string> | null;
    /** The Comes-in look (round 4): a "used" pill and a tinted row. */
    human?: boolean;
}

function valueLabel(desc: Describe, value: unknown): string {
    switch (desc.kind) {
        case 'text': return `“${previewValue(value, 40)}”`;
        case 'list': {
            const scalars = Array.isArray(value) ? value.filter(v => v != null && typeof v !== 'object') : [];
            if (!scalars.length) return '';
            return scalars.slice(0, 3).map(v => previewValue(v, 16)).join(' · ') + (scalars.length > 3 ? ' · …' : '');
        }
        case 'table': case 'group': case 'file': return '';
        default: return previewValue(value, 40);
    }
}

export default function SourceNode({ node, onInsert = null, depth, previewSample, usedPaths = null, human = false }: SourceNodeProps) {
    const [open, setOpen] = useState(false);
    const { t } = useTranslation();
    const value = nodeValue(node, previewSample);
    const children = nodeChildren(node, value);
    const hasChildren = children.length > 0;
    const pickable = !!node.path;
    const desc = describe({ ...node, path: node.path || undefined }, previewSample, t);
    const used = !!(usedPaths && node.path && inUse(node.path, usedPaths));
    const unconfirmed = isUnconfirmed(node);
    const label = nodeLabel(node);
    const indent = INDENT[Math.min(depth, INDENT.length - 1)];

    // A group built without Sources (an older caller) still hands one over.
    const source = node.source !== undefined ? node.source : (node.path ? parseLegacyPath(node.path) : null);
    const insert = (raw: boolean) => {
        if (node.path) onInsert?.(node.path, { raw, source });
    };
    const onClick = (e: MouseEvent<HTMLDivElement>) => {
        // The chevron opens; the rest of the row inserts the value itself. Alt
        // held = insert the list as it is (skips the chooser downstream).
        if (hasChildren && (e.target as HTMLElement).closest('[data-expand-btn]')) {
            setOpen(o => !o);
            return;
        }
        if (pickable) insert(e.altKey);
        else if (hasChildren) setOpen(o => !o);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (pickable) insert(e.altKey);
        else if (hasChildren) setOpen(o => !o);
    };
    const onDragStart = (e: DragEvent<HTMLDivElement>) => {
        if (!node.path) return;
        startPathDrag(e, node.path);
        if (source) e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(source));
    };


    return (
        <div>
            <div
                draggable={pickable}
                onDragStart={onDragStart}
                onClick={onClick}
                role="button"
                tabIndex={0}
                onKeyDown={onKeyDown}
                className={`group flex items-center gap-2 py-[5px] pr-2 ${indent} text-[11px] select-none hover:bg-[var(--bg-secondary)] focus:bg-[var(--bg-secondary)] focus:outline-none ${pickable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}${unconfirmed || node.fromText ? ' opacity-60' : ''}${used && human ? ' bg-[color-mix(in_srgb,var(--type-trigger)_7%,transparent)]' : ''}`}
                title={rowTitle(node, value, t)}
                data-testid="source-node"
                data-unconfirmed={unconfirmed || undefined}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        data-expand-btn
                        aria-expanded={open}
                        aria-label={open
                            ? t('mapping.source.close', 'Hide what is inside {label}', { label })
                            : t('mapping.source.open', 'Show what is inside {label}', { label })}
                        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
                        className="shrink-0 p-0.5 -m-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                ) : (
                    <span className="shrink-0 w-3" />
                )}
                <FieldKindIcon kind={desc.kind} size={11} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="text-[var(--text-primary)] font-medium truncate min-w-[64px] max-w-[50%]">
                    {human ? label : (node.key || label)}
                </span>
                {desc.kind !== 'unknown' && (
                    <span className="min-w-0 text-[10px] text-[var(--text-tertiary)] truncate" data-testid="field-kind">
                        {desc.detail ? `${desc.word} ${desc.detail}` : desc.word}
                    </span>
                )}
                {desc.kind === 'text' && hasChildren && (
                    <span className="shrink-0 text-[10px] italic text-[var(--text-tertiary)]" data-testid="source-from-text">
                        {t('mapping.source.from_text', 'read from text')}
                    </span>
                )}
                {used && <UsedTag human={human} />}
                {pickable && hasChildren && desc.kind === 'group' && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); insert(false); }}
                        className="shrink-0 text-[10px] underline text-[var(--text-tertiary)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                        {t('routines.mapping.use_whole_group', 'use the whole group')}
                    </button>
                )}
                <RowValue desc={desc} value={value} />
                {pickable
                    ? <GripVertical size={11} className="shrink-0 text-[var(--text-tertiary)] opacity-40 group-hover:opacity-100" />
                    : <span className="shrink-0 w-[11px]" />}
            </div>
            {hasChildren && open && children.map((c, i) => (
                <SourceNode
                    key={c.path || `${node.path || node.key}/${c.key}/${i}`}
                    node={c}
                    onInsert={onInsert}
                    depth={depth + 1}
                    previewSample={previewSample}
                    usedPaths={usedPaths}
                    human={human}
                />
            ))}
        </div>
    );
}

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The row's tooltip: its whole label, its text value, and why it is dimmed. */
function rowTitle(node: TreeNode, value: unknown, t: Translate): string {
    return [
        nodeTitle(node),
        typeof value === 'string' && value ? value : null,
        isUnconfirmed(node) ? t('mapping.source.unconfirmed', 'Not in the last run') : null,
        node.fromText ? t('mapping.source.from_text_title', 'Read from the text this field holds. To use one of these values for now, use the whole field.') : null,
    ].filter(Boolean).join('\n');
}

/** "used" (the Comes-in pill) or "in use" (the tree's tag). */
function UsedTag({ human }: { human: boolean }) {
    const { t } = useTranslation();
    const title = t('routines.mapping.in_use_title', 'This step already uses this field');
    return human ? (
        <span className="shrink-0 px-1.5 rounded-full text-[10px] leading-4 font-semibold bg-[color-mix(in_srgb,var(--type-trigger)_16%,transparent)] text-[var(--type-trigger)]" title={title} data-testid="field-used-pill">
            {t('routines.mapping.used_pill', 'used')}
        </span>
    ) : (
        <span className="shrink-0 text-[9px] text-[var(--text-tertiary)]" title={title}>
            {t('routines.mapping.in_use_tag', 'in use')}
        </span>
    );
}

/** The grey value at the row's end, or "not seen yet" for a placeholder. */
function RowValue({ desc, value }: { desc: Describe; value: unknown }) {
    const { t } = useTranslation();
    return (
        <span className="ml-auto shrink-0 text-[10px] text-[var(--text-tertiary)] truncate max-w-[40%] text-right">
            {desc.kind === 'unknown'
                ? <span className="italic" title={t('routines.kind.unknown_hint', 'not seen yet — run the step above')}>{t('routines.kind.unknown_short', 'not seen yet')}</span>
                : valueLabel(desc, value)}
        </span>
    );
}
