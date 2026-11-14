import React, { createContext, useContext } from 'react';
import type { AuthedUser } from '../AuthedApp.types';

/**
 * The signed-in person, for every component under the app shell. The shell
 * still owns the value (useAuthSession writes it); this context saves the
 * components in between from carrying `user` down as a prop. A component used
 * outside the shell too keeps its `user` prop and falls back to this
 * (useOptionalSession).
 */
export interface Session {
    user: AuthedUser | null;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ user, children }: Session & { children: React.ReactNode }) {
    // `user` is state in the shell: the same object until it changes, so it is the value.
    return <SessionContext.Provider value={{ user }}>{children}</SessionContext.Provider>;
}

/** The session of the shell, or null outside it. */
export function useOptionalSession(): Session | null {
    return useContext(SessionContext);
}
