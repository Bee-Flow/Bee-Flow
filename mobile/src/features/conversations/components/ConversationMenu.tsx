/**
 * The list's row menu: rename, pin and delete, the same actions the drawer
 * offers, so cleaning up old chats does not mean opening each one.
 *
 * A direct chat gets the drawer's own ChatActions (features/chat); an agent
 * chat gets its agent's AgentConversationActions (features/agents), because
 * it lives under a different endpoint. Rows ask for the menu through the
 * context, so the list's renderItem stays declared outside the screen; the
 * host keeps the chosen row's actions mounted while its menu, rename sheet or
 * confirmation is open.
 */

import React, { createContext, useCallback, useState, type ReactNode } from 'react';

import { AgentConversationActions } from '@/features/agents';
import { ChatActions } from '@/features/chat';

import type { ConversationRow } from '../model/grouping';

/** How a row asks for its menu; provided by ConversationMenuHost. */
export const ConversationMenuContext = createContext<(row: ConversationRow) => void>(() => undefined);

interface RowActionsProps {
    row: ConversationRow;
    menuOpen: boolean;
    onCloseMenu: () => void;
    onClose: () => void;
}

function RowActions({ row, ...menu }: RowActionsProps) {
    if ('agent_id' in row) return <AgentConversationActions agentId={row.agent_id} conversation={row} {...menu} />;
    return <ChatActions conversation={row} {...menu} />;
}

export function ConversationMenuHost({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<ConversationRow | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // Read by every row: one function for the list's lifetime.
    const openMenu = useCallback((row: ConversationRow) => {
        setTarget(row);
        setMenuOpen(true);
    }, []);

    return (
        <ConversationMenuContext.Provider value={openMenu}>
            {children}
            {target ? (
                <RowActions
                    key={target.id}
                    row={target}
                    menuOpen={menuOpen}
                    onCloseMenu={() => setMenuOpen(false)}
                    onClose={() => setTarget(null)}
                />
            ) : null}
        </ConversationMenuContext.Provider>
    );
}
