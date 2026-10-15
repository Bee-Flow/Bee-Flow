/**
 * The props object every Compliance Center page receives from the hub
 * (data/pages.tsx). One shape for all sections; `data` carries the hub's
 * hook objects by name (core, counts, attention, deadlines, …).
 */
import type { SetHeaderActions } from '../pages/audits/useHeaderPrimary';

/** A plain JSON object as the server sends it. */
export type Rec = Record<string, unknown>;

/** The section a page is rendered for: a registry entry, or just its id. */
export interface HubSectionRef {
    id?: string;
    [key: string]: unknown;
}

export interface HubPageProps {
    section?: HubSectionRef | string | null;
    tab?: string | null;
    onTab?: (tabId: string) => void;
    navigate?: (sectionId: string, subId?: string | null, tab?: string | null, opts?: { replace?: boolean }) => void;
    onNavigate?: (path: string, opts?: { replace?: boolean }) => void;
    focusId?: string | null;
    exportsEnabled?: boolean;
    dl?: (url: string) => string | null;
    isMobile?: boolean;
    setLeaveGuard?: (guard: (() => boolean | Promise<boolean>) | null | undefined) => void;
    setHeaderActions?: SetHeaderActions;
    onOpenLadder?: (kind: string, id: string, title?: string) => void;
    data?: Rec;
}
