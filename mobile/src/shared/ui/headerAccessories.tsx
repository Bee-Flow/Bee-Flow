/**
 * The global actions at the trailing end of every ScreenHeader — search and
 * the notification bell — supplied by the app root instead of imported here.
 *
 * The bell needs the unread count, which is an API call and a feature's
 * knowledge; shared/ui may not reach up into either. So app/_layout.tsx
 * composes the accessories once and every header renders what it is given.
 * A header outside the provider (a test, say) renders none.
 */

import React, { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** One header action. Rendered with no props, once per mounted header. */
export type HeaderAccessory = ComponentType;

const NONE: readonly HeaderAccessory[] = [];

const HeaderAccessoryContext = createContext<readonly HeaderAccessory[]>(NONE);

export function HeaderAccessoryProvider({
    accessories,
    children,
}: {
    /** In display order. Keep the array module-level so it is stable. */
    accessories: readonly HeaderAccessory[];
    children: ReactNode;
}) {
    return <HeaderAccessoryContext.Provider value={accessories}>{children}</HeaderAccessoryContext.Provider>;
}

/** The accessories the nearest provider supplies; empty without one. */
export function useHeaderAccessories(): readonly HeaderAccessory[] {
    return useContext(HeaderAccessoryContext);
}
