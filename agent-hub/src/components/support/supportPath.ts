// The support inbox's address: admin/support/<view>/<item>.
//   inbox     the tickets; <item> is the open ticket (bare admin/support too);
//   settings  the agent, SLA, templates, tags and connections; <item> is the section;
//   insights  the report.
// The server writes ticket links as admin/support/<threadId> (utils/appPaths
// adminSupportTicketPath), and the views used to be panel state named
// 'ai-config' and 'connections': every one of those still opens the right place.

const SUPPORT_VIEWS = ['inbox', 'settings', 'insights'] as const;
export type SupportView = typeof SUPPORT_VIEWS[number];

/** The settings sections, in their order; `agent` opens first. */
const SUPPORT_SETTINGS_SECTIONS = ['agent', 'behaviour', 'sla', 'canned', 'tags', 'connections'] as const;
export type SupportSettingsSection = typeof SUPPORT_SETTINGS_SECTIONS[number];

/** Old view names (panel state before the views had addresses) to where they live now. */
const LEGACY_VIEWS: Readonly<Record<string, { view: SupportView; section?: SupportSettingsSection }>> = {
    'ai-config': { view: 'settings' },
    connections: { view: 'settings', section: 'connections' },
};

export interface SupportLocation {
    view: SupportView;
    /** The open ticket (inbox only). */
    threadId: string | null;
    /** The open settings section (settings only). */
    section: SupportSettingsSection;
}

const isView = (v: string): v is SupportView => (SUPPORT_VIEWS as readonly string[]).includes(v);
const isSection = (v: string): v is SupportSettingsSection => (SUPPORT_SETTINGS_SECTIONS as readonly string[]).includes(v);

/** Where admin/support/<seg2>/<seg3> points. An unknown seg2 is a ticket id (the server's ticket links). */
export function resolveSupportPath(seg2?: string | null, seg3?: string | null): SupportLocation {
    const first = (seg2 || '').trim();
    const second = (seg3 || '').trim();
    if (!first) return { view: 'inbox', threadId: null, section: 'agent' };
    if (Object.hasOwn(LEGACY_VIEWS, first)) {
        const legacy = LEGACY_VIEWS[first];
        return { view: legacy.view, threadId: null, section: legacy.section ?? (isSection(second) ? second : 'agent') };
    }
    if (!isView(first)) return { view: 'inbox', threadId: first, section: 'agent' };
    if (first === 'inbox') return { view: 'inbox', threadId: second || null, section: 'agent' };
    if (first === 'settings') return { view: 'settings', threadId: null, section: isSection(second) ? second : 'agent' };
    return { view: first, threadId: null, section: 'agent' };
}

/** The address of a view, a ticket or a settings section (for onNavigate). */
export function supportPath(view: SupportView, item?: string | null): string {
    return item ? `admin/support/${view}/${encodeURIComponent(item)}` : `admin/support/${view}`;
}
