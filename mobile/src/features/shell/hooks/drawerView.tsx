/**
 * What the drawer's rows are drawn against: the access snapshot and Studio
 * resolution, the tab the drawer holds, and whether it is open. Provided once
 * by DrawerContent, read by the rows that need it — so the chat list's header
 * is a stable component rather than a new element per render, and a route
 * change elsewhere does not rebuild it (or, through it, every chat row).
 */

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { AccessSnapshot } from '@/core/access';
import type { StudioNav } from '@/features/studio';

export interface DrawerView {
    access: AccessSnapshot;
    studio: StudioNav;
    /** The tab the drawer holds (model/tabs.tabPathOf). */
    path: string;
    /** Whether the drawer is open: a closed drawer polls nothing. */
    open: boolean;
}

const DrawerViewContext = createContext<DrawerView | null>(null);

export function DrawerViewProvider({ studio, path, open, children }: Omit<DrawerView, 'access'> & { children: ReactNode }) {
    // One object while nothing it holds changed: every consumer re-renders on a new one.
    const value = useMemo(() => ({ access: studio.access, studio, path, open }), [studio, path, open]);
    return <DrawerViewContext.Provider value={value}>{children}</DrawerViewContext.Provider>;
}

export function useDrawerView(): DrawerView {
    const view = useContext(DrawerViewContext);
    if (!view) throw new Error('useDrawerView must be used inside <DrawerViewProvider>');
    return view;
}
