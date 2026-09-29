import {
    Activity, Bell, BookUser, Calendar, CircleUser, ClipboardList, Folder, ListTodo, Mail, MessagesSquare, SquareKanban,
    StickyNote, Table2, Users,
} from 'lucide-react';
import { INTEGRATION_META } from './integrationIcons';

/**
 * A glyph of its own for an app whose vendor draws every app with the one
 * brand mark. Every Nextcloud app shares the rings (integrationLogos), so a
 * list of them — the ribbon's NEXTCLOUD cluster, the browse tree, a row of
 * canvas nodes — was the same blue mark repeated with nothing to tell Files
 * from Talk from Calendar. Here each gets a lucide in the brand colour: the
 * colour still says Nextcloud, the shape says which app.
 *
 * Resolved by <IntegrationLogo> (the builder) and appCatalog's renderAppLogo
 * (the chat composer) right after a white-label icon-pack override and before
 * the brand SVG, so every surface shows the same mark for the same app. Apps
 * with a logo each (Google, Microsoft, the rest) are not listed and keep it.
 */

// Keyed by the underscore spelling; `getIntegrationGlyph` normalises the
// dashed catalog ids ('nextcloud-talk') onto it.
const GLYPHS = {
    nextcloud: Folder,
    nextcloud_talk: MessagesSquare,
    nextcloud_calendar: Calendar,
    nextcloud_deck: SquareKanban,
    nextcloud_tables: Table2,
    nextcloud_forms: ClipboardList,
    nextcloud_mail: Mail,
    nextcloud_tasks: ListTodo,
    nextcloud_notes: StickyNote,
    nextcloud_contacts: BookUser,
    nextcloud_teams: Users,
    nextcloud_notifications: Bell,
    nextcloud_activity: Activity,
    nextcloud_status: CircleUser,
};

const NEXTCLOUD_TINT = INTEGRATION_META.nextcloud.color;

/** `{ Icon, color }` for an app drawn with its own glyph, else null. */
export function getIntegrationGlyph(integrationId) {
    const Icon = GLYPHS[String(integrationId || '').replace(/-/g, '_')];
    return Icon ? { Icon, color: NEXTCLOUD_TINT } : null;
}

/** The glyph as an element, sized like the brand SVG it stands in for. */
export function renderIntegrationGlyph(glyph, size, props = null) {
    const { Icon, color } = glyph;
    return <Icon size={size} style={{ color, flexShrink: 0 }} aria-hidden="true" {...(props || null)} />;
}
