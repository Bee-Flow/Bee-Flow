import { ChevronDown, FolderPlus, Package, Plus, Workflow } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';

// A .jsx module whose `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export interface CreateMenuButtonProps {
    /** The main part, and the menu's first (default) item. */
    onCreateAutomation: () => void;
    /** Without it there is nothing to choose, so the chevron is left out. */
    onCreateBlock?: (() => void) | null;
    /** "New folder" — the overview offers it beside the building block. */
    onCreateFolder?: (() => void) | null;
    /** 'icon' is the sidebar's small +, 'label' the overview's accent "New". */
    variant?: 'icon' | 'label';
    /** data-tour anchor on the main part (the Learning Center points at it). */
    tourAnchor?: string;
    testId?: string;
}

const SHAPES = {
    label: {
        shell: 'inline-flex items-stretch h-7 rounded-full overflow-hidden text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]',
        part: 'flex items-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:opacity-90',
    },
    icon: {
        shell: 'inline-flex items-stretch rounded-lg border border-[var(--border-default)] overflow-hidden text-[var(--text-tertiary)]',
        part: 'flex items-center transition hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:bg-[var(--bg-secondary)]',
    },
} as const;

/**
 * The + for Automations, as a split button (owner, 2026-09-28): the main part
 * makes a new automation, as it always did, and the chevron beside it opens a
 * small menu that also offers a new building block. Automations stay the
 * default everywhere; building blocks are one deliberate choice away.
 *
 * The menu is shared/AnchoredMenu with role="menu", so it brings the ARIA
 * menu keyboard pattern (arrows, Home/End, Tab and Escape close, focus back
 * on the chevron). ArrowDown on the chevron opens it, as on any menu button.
 */
export default function CreateMenuButton({
    onCreateAutomation,
    onCreateBlock = null,
    onCreateFolder = null,
    variant = 'icon',
    tourAnchor,
    testId = 'create-menu',
}: CreateMenuButtonProps) {
    const { t } = useTranslation();
    const chevronRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const pick = (run: () => void) => {
        setOpen(false);
        run();
    };
    // The menu's rows, built outside the component so the button's own logic
    // stays a flat split button (see buildMenuItems below).
    const items = buildMenuItems(t, pick, { onCreateAutomation, onCreateBlock, onCreateFolder });
    // Anything beyond the default earns the chevron and its menu.
    const hasMenu = items.length > 1;
    const onChevronKey = (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
        }
    };

    const label = variant === 'label';
    const { shell, part } = SHAPES[variant];
    const newAutomation = items[0].title;

    return (
        <>
            <div className={shell} data-testid={testId}>
                <button
                    type="button"
                    onClick={onCreateAutomation}
                    data-tour={tourAnchor}
                    title={newAutomation}
                    aria-label={label ? undefined : newAutomation}
                    className={`${part} ${label ? 'gap-1.5 pl-3 pr-2.5' : 'p-1'}`}
                    data-testid={`${testId}-main`}
                >
                    <Plus size={label ? 13 : 15} aria-hidden="true" />
                    {label && t('automations.library.new', 'New')}
                </button>
                {hasMenu && (
                    <>
                        <span
                            aria-hidden="true"
                            className={`w-px self-stretch ${label ? 'bg-[color-mix(in_srgb,var(--accent-primary-fg)_25%,transparent)]' : 'bg-[var(--border-default)]'}`}
                        />
                        <button
                            ref={chevronRef}
                            type="button"
                            onClick={() => setOpen(o => !o)}
                            onKeyDown={onChevronKey}
                            aria-haspopup="menu"
                            aria-expanded={open}
                            aria-label={t('automations.library.createMenu', 'Choose what to create')}
                            title={t('automations.library.createMenu', 'Choose what to create')}
                            className={`${part} ${label ? 'px-2' : 'px-0.5'}`}
                            data-testid={`${testId}-chevron`}
                        >
                            <ChevronDown size={label ? 13 : 12} aria-hidden="true" />
                        </button>
                    </>
                )}
            </div>
            {hasMenu && (
                <CreateMenu
                    open={open}
                    onClose={() => setOpen(false)}
                    anchorRef={chevronRef}
                    testId={`${testId}-list`}
                    items={items}
                />
            )}
        </>
    );
}

/** One row of the create menu: icon tile, title, hint, optional badge. */
interface CreateMenuItem {
    icon: ReactNode;
    tile: string;
    title: string;
    hint: string;
    badge?: string;
    onClick: () => void;
}

type TFn = (key: string, fallback: string) => string;

/**
 * What a + can make, the default first. A module-level builder so the button
 * component itself stays a flat split button: every "is this offered?" branch
 * lives here, and a new create-kind is one more block in this list.
 */
function buildMenuItems(t: TFn, pick: (run: () => void) => void, handlers: {
    onCreateAutomation: () => void;
    onCreateBlock: (() => void) | null;
    onCreateFolder: (() => void) | null;
}): CreateMenuItem[] {
    const items: CreateMenuItem[] = [{
        icon: <Workflow size={14} aria-hidden="true" />,
        tile: 'bg-[color-mix(in_srgb,var(--type-trigger)_14%,transparent)] text-[var(--type-trigger)]',
        title: t('automations.library.newAutomation', 'New automation'),
        hint: t('automations.library.newAutomationHint', 'Runs by itself when something happens, or when you start it'),
        badge: t('automations.library.default', 'Default'),
        onClick: () => pick(handlers.onCreateAutomation),
    }];
    if (handlers.onCreateBlock) {
        const run = handlers.onCreateBlock;
        items.push({
            icon: <Package size={14} aria-hidden="true" />,
            tile: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
            title: t('automations.library.newBlock', 'New building block'),
            hint: t('automations.library.newBlockHint', 'A reusable step you can drop into any automation'),
            onClick: () => pick(run),
        });
    }
    if (handlers.onCreateFolder) {
        const run = handlers.onCreateFolder;
        items.push({
            icon: <FolderPlus size={14} aria-hidden="true" />,
            tile: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
            title: t('automations.library.newFolder', 'New folder'),
            hint: t('automations.library.newFolderHint', 'Groups automations here in the overview and in the sidebar'),
            onClick: () => pick(run),
        });
    }
    return items;
}

/** The menu itself: whatever buildMenuItems decided to offer. */
function CreateMenu({ open, onClose, anchorRef, testId, items }: {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLButtonElement | null>;
    testId: string;
    items: CreateMenuItem[];
}) {
    const { t } = useTranslation();
    // Escape closes this menu and nothing else: stopped here, it never reaches
    // the dialog stack, so the in-editor list flyout around it stays open.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
    };
    return (
        <AnchoredMenu
            open={open}
            onClose={onClose}
            onKeyDown={onKeyDown}
            anchorRef={anchorRef}
            align="right"
            width={288}
            role="menu"
            aria-label={t('automations.library.createMenu', 'Choose what to create')}
            className="p-1.5"
            data-testid={testId}
        >
            {items.map(item => <MenuRow key={item.title} {...item} />)}
        </AnchoredMenu>
    );
}

/** Icon tile, title and one line of explanation (the 5e-1 action row). */
function MenuRow({ icon, tile, title, hint, badge, onClick }: {
    icon: ReactNode;
    tile: string;
    title: string;
    hint: string;
    badge?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-[var(--bg-tertiary)] focus-visible:bg-[var(--bg-tertiary)] focus:outline-none"
        >
            <span className={`w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 ${tile}`}>{icon}</span>
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{title}</span>
                    {badge && <span className="text-[10px] text-[var(--text-tertiary)]">{badge}</span>}
                </span>
                <span className="block text-[11px] leading-snug text-[var(--text-tertiary)]">{hint}</span>
            </span>
        </button>
    );
}
