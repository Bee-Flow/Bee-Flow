/**
 * Which menu the drawer draws, by the tab it holds (model/tabs.tabPathOf) —
 * the web's rule: on /app/studio* the StudioRail REPLACES the workspace
 * sidebar (agent-hub Sidebar.jsx). On the Studio tab the drawer is Studio's
 * menu (a way back to Chat, Studio's destinations, Approvals); on Chat and
 * Meeting Notes it is the chat sidebar (New Chat, Search, Agents, the chats).
 * The header (logo and bell) and the profile footer are the same in both.
 */

import { TABS } from './tabs';

export type DrawerMenu = 'chat' | 'studio';

const STUDIO_PATH = TABS.find((tab) => tab.name === 'studio')?.path ?? '/studio';

export function drawerMenuFor(tabPath: string): DrawerMenu {
    return tabPath === STUDIO_PATH ? 'studio' : 'chat';
}
