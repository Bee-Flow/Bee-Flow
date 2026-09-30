/**
 * What a drawer row does when tapped: close the drawer, then go. Provided by
 * DrawerContent (which holds the drawer's navigation) to every row below it,
 * so a row says WHERE and never has to know how the drawer closes.
 *
 *   go    switch to a tab (openRoute) — never a second copy of the drawer on
 *         the stack — or open a screen over the drawer
 *   push  open a screen over the drawer (a chat, an agent, a project)
 *   open  a Studio destination (every one is a native screen)
 */

import { useRouter, type Href } from 'expo-router';
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import { useOpenTarget, type OpenTarget } from '@/features/studio';
import { openRoute } from '@/shared/navigation';

export interface DrawerActions {
    go: (href: string) => void;
    push: (href: string) => void;
    open: (target: OpenTarget) => void;
    close: () => void;
}

const DrawerActionsContext = createContext<DrawerActions | null>(null);

export function DrawerActionsProvider({ close, children }: { close: () => void; children: ReactNode }) {
    const router = useRouter();
    const openTarget = useOpenTarget();
    // Every row reads these, chat rows included, so the value never changes:
    // the handlers read the latest close/router/openTarget when they run.
    const latest = useRef({ close, router, openTarget });
    useLayoutEffect(() => {
        latest.current = { close, router, openTarget };
    });
    const actions = useMemo<DrawerActions>(
        () => ({
            go: (href) => {
                latest.current.close();
                openRoute(latest.current.router, href);
            },
            push: (href) => {
                latest.current.close();
                latest.current.router.push(href as Href);
            },
            open: (target) => {
                latest.current.close();
                latest.current.openTarget(target);
            },
            close: () => latest.current.close(),
        }),
        [],
    );
    return <DrawerActionsContext.Provider value={actions}>{children}</DrawerActionsContext.Provider>;
}

export function useDrawerActions(): DrawerActions {
    const actions = useContext(DrawerActionsContext);
    if (!actions) throw new Error('useDrawerActions must be used inside <DrawerActionsProvider>');
    return actions;
}
