/**
 * The three tabs of an item (./CoworkDetail.tsx): Runs, Plan and Settings. One obvious place for each thing, and only
 * the chosen tab is rendered, so a panel reads its data when its tab is shown and not before.
 *
 * Accessible as the ARIA tabs pattern: role tablist/tab/tabpanel, one tab stop, and the arrow keys (plus Home and End)
 * move to and choose the next tab. The chosen tab is remembered per item for the browser tab's session
 * (sessionStorage), so coming back to an item, or closing its edit form, opens where its owner left it. Storage that
 * is blocked or full only costs that memory.
 */
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface CoworkTab {
    id: string;
    label: string;
    /** Called only while this tab is chosen. */
    render: () => ReactNode;
}

interface CoworkTabsProps {
    /** What the remembered choice belongs to: the item's id. */
    scope: string;
    tabs: readonly CoworkTab[];
    /** The accessible name of the tab list. */
    label: string;
}

/** Where the chosen tab of an item is kept; a link into a tab (./coworkView.ts) writes it before the tabs mount. */
export const TAB_STORAGE_PREFIX = 'bee-flow.cowork.tab.';
const STORAGE_PREFIX = TAB_STORAGE_PREFIX;

function readStored(scope: string): string | null {
    try {
        return window.sessionStorage.getItem(STORAGE_PREFIX + scope);
    } catch {
        return null;
    }
}

/** False when the storage is blocked or full: the choice then holds while this pane stays open, and is not kept. */
function writeStored(scope: string, id: string): boolean {
    try {
        window.sessionStorage.setItem(STORAGE_PREFIX + scope, id);
        return true;
    } catch {
        return false;
    }
}

/** The index a key press moves to, or null for a key the tab list does not handle. */
function nextIndex(key: string, current: number, count: number): number | null {
    switch (key) {
        case 'ArrowRight': return (current + 1) % count;
        case 'ArrowLeft': return (current - 1 + count) % count;
        case 'Home': return 0;
        case 'End': return count - 1;
        default: return null;
    }
}

export default function CoworkTabs({ scope, tabs, label }: CoworkTabsProps) {
    const baseId = useId();
    const buttons = useRef<Array<HTMLButtonElement | null>>([]);
    // The choice made on screen, per scope; a scope seen for the first time starts from storage.
    const [chosen, setChosen] = useState<Record<string, string>>({});
    const wanted = chosen[scope] ?? readStored(scope);
    const active = tabs.find((tab) => tab.id === wanted) ?? tabs[0];
    if (!active) return null;

    const choose = (id: string) => {
        setChosen((prev) => ({ ...prev, [scope]: id }));
        writeStored(scope, id);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const next = nextIndex(e.key, index, tabs.length);
        if (next === null) return;
        e.preventDefault();
        choose(tabs[next].id);
        buttons.current[next]?.focus();
    };

    return (
        <div className="flex flex-col gap-4 min-w-0" data-testid="cowork-tabs">
            <div
                role="tablist"
                aria-label={label}
                className="flex items-center gap-1 min-w-0 overflow-x-auto border-b border-[var(--border-subtle)] [scrollbar-width:none]"
            >
                {tabs.map((tab, index) => {
                    const selected = tab.id === active.id;
                    return (
                        <button
                            key={tab.id}
                            ref={(el) => { buttons.current[index] = el; }}
                            type="button"
                            role="tab"
                            id={`${baseId}-tab-${tab.id}`}
                            aria-selected={selected}
                            aria-controls={`${baseId}-panel-${tab.id}`}
                            tabIndex={selected ? 0 : -1}
                            data-testid={`cowork-tab-${tab.id}`}
                            onClick={() => choose(tab.id)}
                            onKeyDown={(e) => onKeyDown(e, index)}
                            className={`flex-1 sm:flex-none shrink-0 whitespace-nowrap px-3.5 py-2 text-[12.5px] font-medium rounded-t-md ${selected
                                ? 'text-[var(--text-primary)] shadow-[inset_0_-2px_0_var(--accent-primary)]'
                                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                        >
                            {tab.label}
                        </button>
                    );
                })}
            </div>
            <div
                role="tabpanel"
                id={`${baseId}-panel-${active.id}`}
                aria-labelledby={`${baseId}-tab-${active.id}`}
                data-testid={`cowork-tabpanel-${active.id}`}
                className="flex flex-col gap-[18px] min-w-0"
            >
                {active.render()}
            </div>
        </div>
    );
}
