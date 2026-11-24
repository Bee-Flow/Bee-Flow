/**
 * The menu in the Cowork page's header: Settings, Teamwork, Templates, and Organisation for an administrator of their
 * organisation. Each opens its panel in the sheet (./coworkSheetPanels.ts). The menu closes on Escape (the focus goes
 * back to its button), on a click outside it, and once a panel is chosen.
 */
import { UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COWORK_SHEET_PANELS, MENU_KINDS, type CoworkSheetKind } from './coworkSheetPanels';
import { administersOrg } from './coworkViewer';
import { useTranslation } from '@/hooks/useTranslation';
import { FOCUS_RING } from '../shared/buttonClasses';
import type { CoworkViewer } from '@/api/cowork.types';

interface CoworkUserMenuProps {
    user: CoworkViewer | null;
    onOpen: (kind: Exclude<CoworkSheetKind, 'task' | 'shared'>) => void;
}

export default function CoworkUserMenu({ user, onOpen }: CoworkUserMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            button.current?.focus();
        };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);
    const admin = administersOrg(user);
    const kinds = MENU_KINDS.filter((kind) => !COWORK_SHEET_PANELS[kind].adminOnly || admin);
    return (
        <div ref={root} className="relative">
            <button
                ref={button}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('cowork_home.menu.label', 'Your menu')}
                data-testid="cowork-user-menu"
                onClick={() => setOpen((v) => !v)}
                className={`grid place-items-center w-11 h-11 rounded-full border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] ${FOCUS_RING}`}
            >
                <UserRound aria-hidden="true" className="w-5 h-5" />
            </button>
            {open && (
                <div role="menu" aria-label={t('cowork_home.menu.label', 'Your menu')} className="absolute right-0 top-[52px] z-20 w-[min(280px,calc(100vw-32px))] rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-[var(--shadow-popover)] p-1.5 flex flex-col">
                    {kinds.map((kind) => {
                        const [key, en] = COWORK_SHEET_PANELS[kind].label;
                        return (
                            <button
                                key={kind}
                                type="button"
                                role="menuitem"
                                className={`min-h-11 px-3 rounded-[10px] flex items-center justify-between gap-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] ${FOCUS_RING}`}
                                onClick={() => { setOpen(false); onOpen(kind); }}
                            >
                                <span>{t(key, en)}</span>
                                {COWORK_SHEET_PANELS[kind].adminOnly && <span className="rounded-full px-2 py-0.5 text-[12px] font-semibold bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t('cowork_home.menu.admin', 'Admin')}</span>}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
