import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import AppIcon from '@/components/icons/AppIcon';
import type { NodeProps } from './appNode.types';
import { buildTree, parentOf, visibleNodes, type TreeNode, type TreeRow } from './treeModel';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';
import { isFill } from '../styleResolver.helpers';
import type { BindingInput } from '../resolveBinding.types';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';

/**
 * App Studio runtime - 'tree' (schema 3). Spec: server/appStudio/componentSpecs/types/tree.js.
 *
 * The rows of `source` (the ordinary data read, so the viewer's rules decide what arrives)
 * nested by `parentKey`, drawn as the WAI-ARIA tree view: one tab stop, Up and Down move,
 * Right opens or goes to the first child, Left closes or goes to the parent, Home and End,
 * Enter and Space run onRowClick (or open and close an item when nothing is wired). The top
 * level starts expanded, so a first paint and a screenshot show two levels.
 */

interface TreeProps {
    source?: BindingInput;
    idKey?: string;
    parentKey?: string;
    titleKey?: string;
    subtitleKey?: string | null;
    icon?: string | null;
    maxDepth?: number;
    maxNodes?: number;
    emptyText?: string;
}

type Activate = (item: TreeNode, toggle: (item: TreeNode) => void) => void;

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => (Number.isInteger(v) ? Math.max(lo, Math.min(hi, Number(v))) : fallback);

/** What a key does on the focused item: the item to focus next and whether it opens or closes. */
function treeKeyMove(key: string, focus: TreeNode, items: readonly TreeNode[], roots: readonly TreeNode[], expanded: ReadonlySet<string>): { to?: TreeNode; toggle?: boolean } | null {
    const at = items.indexOf(focus);
    const isOpen = expanded.has(focus.key);
    switch (key) {
        case 'ArrowDown': return { to: items[Math.min(at + 1, items.length - 1)] };
        case 'ArrowUp': return { to: items[Math.max(at - 1, 0)] };
        case 'Home': return { to: items[0] };
        case 'End': return { to: items[items.length - 1] };
        case 'ArrowRight':
            if (!focus.children.length) return {};
            return isOpen ? { to: focus.children[0] } : { toggle: true };
        case 'ArrowLeft': {
            if (focus.children.length && isOpen) return { toggle: true };
            const parent = parentOf(roots, focus.key);
            return parent ? { to: parent } : {};
        }
        default: return null;
    }
}

/** The rows of the source, read and nested. */
function useTreeData(p: TreeProps) {
    const { actionState, dataState, scope } = useRuntime();
    const read = useStickyBinding(resolveBinding(p.source, { actionState, dataState, scope }));
    const idKey = p.idKey || 'id';
    const parentKey = p.parentKey || 'parent';
    const maxDepth = clampInt(p.maxDepth, 1, 10, 6);
    const maxNodes = clampInt(p.maxNodes, 1, 1000, 500);
    const model = useMemo(() => {
        const rows = (Array.isArray(read.value) ? read.value : []).filter((row): row is TreeRow => !!row && typeof row === 'object');
        return buildTree(rows, { idKey, parentKey, maxDepth, maxNodes });
    }, [read.value, idKey, parentKey, maxDepth, maxNodes]);
    return { ...read, model };
}

/** Which items are open, which one holds the tab stop, and the keyboard of the tree view. */
function useTreeNav(roots: readonly TreeNode[], activate: Activate) {
    const [expanded, setExpanded] = useState<Set<string> | null>(null);
    const open = expanded ?? new Set(roots.map((root) => root.key));
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const refs = useRef(new Map<string, HTMLLIElement>());
    const items = visibleNodes(roots, open);
    const focused = items.find((n) => n.key === focusKey) ?? items[0];
    const toggle = (item: TreeNode) => {
        const next = new Set(open);
        if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
        setExpanded(next);
    };
    const moveTo = (item: TreeNode) => {
        setFocusKey(item.key);
        refs.current.get(item.key)?.focus();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, item: TreeNode) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate(item, toggle);
            return;
        }
        const move = treeKeyMove(e.key, item, items, roots, open);
        if (!move) return;
        e.preventDefault();
        if (move.toggle) toggle(item);
        if (move.to) moveTo(move.to);
    };
    const refFor = (id: string) => (el: HTMLLIElement | null) => {
        if (el) refs.current.set(id, el); else refs.current.delete(id);
    };
    return { open, focused, toggle, moveTo, onKeyDown, refFor, setFocusKey };
}

type TreeNav = ReturnType<typeof useTreeNav>;

interface TreeItemProps {
    item: TreeNode;
    index: number;
    setSize: number;
    p: TreeProps;
    nav: TreeNav;
    activate: Activate;
    t: TranslateFn;
    /** The prefix of the title ids: an item is named by its own title, not by its whole subtree. */
    idPrefix: string;
}

function TreeItem({ item, index, setSize, p, nav, activate, t, idPrefix }: TreeItemProps): ReactNode {
    const titleId = `${idPrefix}-${encodeURIComponent(item.key)}`;
    const isOpen = nav.open.has(item.key);
    const subtitle = p.subtitleKey ? walkPath(item.row, p.subtitleKey) : null;
    const indent = { paddingLeft: `${(item.level - 1) * 16 + 4}px` };
    return (
        <li
            ref={nav.refFor(item.key)}
            role="treeitem"
            aria-labelledby={titleId}
            aria-level={item.level}
            aria-setsize={setSize}
            aria-posinset={index + 1}
            aria-expanded={item.children.length ? isOpen : undefined}
            tabIndex={item === nav.focused ? 0 : -1}
            onKeyDown={(e) => nav.onKeyDown(e, item)}
            onFocus={(e) => { if (e.target === e.currentTarget) nav.setFocusKey(item.key); }}
            className="outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--app-primary)] [border-radius:var(--app-radius)] bfa-tree__item"
        >
            <div
                className="flex items-center gap-1.5 py-1 pr-2 cursor-pointer hover:[background:var(--bg-tertiary)] [border-radius:var(--app-radius)] bfa-tree__row"
                style={indent}
                onClick={() => { nav.moveTo(item); activate(item, nav.toggle); }}
            >
                <span
                    aria-hidden="true"
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)] bfa-tree__toggle${item.children.length ? '' : ' invisible'}`}
                    onClick={(e) => { e.stopPropagation(); nav.toggle(item); }}
                >
                    <ChevronRight className={`h-3.5 w-3.5${isOpen ? ' rotate-90' : ''}`} />
                </span>
                {p.icon ? <AppIcon name={p.icon} className="h-4 w-4 shrink-0 text-[var(--text-secondary)] bfa-tree__icon" aria-hidden="true" /> : null}
                <span id={titleId} className="min-w-0 truncate text-sm text-[var(--text-primary)] bfa-tree__title">{displayValue(walkPath(item.row, p.titleKey || 'title'))}</span>
                {subtitle != null && subtitle !== '' ? <span className="min-w-0 truncate text-xs text-[var(--text-muted)] bfa-tree__subtitle">{displayValue(subtitle)}</span> : null}
                {item.hiddenBelow ? <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)] bfa-tree__more">{t('studio_apps_lk20.tree.deeper', '+{count} deeper', { count: item.hiddenBelow })}</span> : null}
            </div>
            {item.children.length && isOpen ? (
                <ul role="group" className="bfa-tree__group">
                    {item.children.map((child, ci) => <TreeItem key={child.key} item={child} index={ci} setSize={item.children.length} p={p} nav={nav} activate={activate} t={t} idPrefix={idPrefix} />)}
                </ul>
            ) : null}
        </li>
    );
}

export default function AppTree({ node }: NodeProps<TreeProps>) {
    const { t } = useTranslation();
    const { mode, runAction } = useRuntime();
    const p = node.props || {};
    const { model, isLoading, error, errorCode } = useTreeData(p);
    const activate: Activate = (item, toggle) => {
        if (mode === 'run' && node.onRowClick) runAction(node.onRowClick as string, { formValues: item.row, item: item.row });
        else if (item.children.length) toggle(item);
    };
    const nav = useTreeNav(model.roots, activate);
    const idPrefix = useId();

    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) return <SkeletonLines lines={4} />;
    if (!model.roots.length) return <EmptyText text={p.emptyText || t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.')} />;

    return (
        <div className={`min-w-0${isFill(node) ? ' app-fill h-full min-h-0 overflow-y-auto' : ''}`}>
            <ul role="tree" aria-label={t('studio_apps_lk20.tree.label', 'Tree')} className="flex flex-col bfa-tree__root" data-app-tree="true">
                {model.roots.map((item, i) => <TreeItem key={item.key} item={item} index={i} setSize={model.roots.length} p={p} nav={nav} activate={activate} t={t} idPrefix={idPrefix} />)}
            </ul>
            {model.cut ? <p className="mt-1 text-xs text-[var(--text-muted)] bfa-tree__more">{t('studio_apps_lk20.tree.cut', '{count} more not shown', { count: model.cut })}</p> : null}
        </div>
    );
}
