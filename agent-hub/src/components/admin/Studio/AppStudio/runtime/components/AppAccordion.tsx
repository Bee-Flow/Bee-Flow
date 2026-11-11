import { ChevronDown } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { useRuntime } from '../RuntimeContext';
import type { NodeProps } from './appNode.types';
import { selectedChildIndex, type SlotChildDef } from './slotNodes';

/**
 * App Studio runtime - 'accordion' (schema 3). Spec: server/appStudio/componentSpecs/types/accordion.js.
 *
 * Collapsible sections. Child number i is the body of `items[i]`; the headers are native buttons
 * with aria-expanded and aria-controls, so Space and Enter toggle them and Tab walks them. Which
 * item is open at first: the ones marked `open`, or the first when none says. With `multiple`
 * off, opening one closes the others.
 *
 * Every body stays mounted and the closed ones are `hidden`, the way tabs keep their panels: a
 * required field in a closed section still belongs to its form.
 */
interface AccordionItem {
    title?: string;
    open?: boolean;
}

interface AccordionProps {
    items?: AccordionItem[];
    multiple?: boolean;
}

/** The items open before anyone clicks: those marked open, or the first one when none is marked. */
export function initiallyOpen(items: AccordionItem[]): number[] {
    const marked = items.flatMap((item, i) => (item?.open === true ? [i] : []));
    const decided = items.some((item) => typeof item?.open === 'boolean');
    return decided ? marked : items.length > 0 ? [0] : [];
}

export default function AppAccordion({ node, children }: NodeProps<AccordionProps>) {
    const { t } = useTranslation();
    const { selectedNodeId } = useRuntime();
    const items = Array.isArray(node.props?.items) ? node.props.items : [];
    const multiple = node.props?.multiple === true;
    const defs = (Array.isArray(node.children) ? node.children : []) as SlotChildDef[];
    const bodies = React.Children.toArray(children);
    const [open, setOpen] = useState<number[]>(() => initiallyOpen(items));
    const count = Math.max(items.length, bodies.length);

    if (count === 0) {
        return <div className="text-sm py-2 text-[var(--text-muted)]">{t('studio_apps_lk21a.accordion.empty', 'Add items to this accordion.')}</div>;
    }
    // In the editor the section holding the selected node opens, so the inspector edits what was clicked.
    const selectedIdx = selectedChildIndex(defs, selectedNodeId);
    const isOpen = (i: number) => open.includes(i) || i === selectedIdx;
    const toggle = (i: number) => setOpen((now) => {
        if (now.includes(i)) return now.filter((k) => k !== i);
        return multiple ? [...now, i] : [i];
    });

    return (
        <div className="w-full min-w-0 border rounded-[var(--app-radius)] [border-color:var(--border-default)] divide-y divide-[var(--border-default)] bfa-accordion__root" data-app-accordion="true">
            {Array.from({ length: count }, (_, i) => {
                const title = items[i]?.title || t('studio_apps_lk21a.accordion.section', 'Section {n}', { n: i + 1 });
                const expanded = isOpen(i);
                const headerId = `${node.id}-h${i}`;
                const panelId = `${node.id}-p${i}`;
                return (
                    <div key={defs[i]?.id ?? i} className="bfa-accordion__item" data-app-accordion-item={expanded ? 'open' : 'closed'}>
                        <div role="heading" aria-level={3}>
                            <button
                                id={headerId}
                                type="button"
                                aria-expanded={expanded}
                                aria-controls={panelId}
                                onClick={() => toggle(i)}
                                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--text-secondary)] bfa-accordion__header"
                            >
                                <span className="bfa-accordion__title">{title}</span>
                                <ChevronDown className={`w-4 h-4 shrink-0 text-[var(--text-secondary)] transition-transform ${expanded ? 'rotate-180' : ''} bfa-accordion__icon`} aria-hidden="true" />
                            </button>
                        </div>
                        <div
                            id={panelId}
                            role="region"
                            aria-labelledby={headerId}
                            hidden={!expanded}
                            className="px-3 pb-3 bfa-accordion__panel"
                        >
                            {bodies[i] ?? null}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
