// Links from the builder into Studio: the agent, skill or knowledge base an AI
// step uses. One helper so the step editor's "Open" and the canvas card's
// ports cannot point at two different URLs for the same thing.
import { segmentForSection } from '../../../admin/Studio/studioRoutes';

export type StudioLinkSection = 'agents' | 'skills' | 'knowledge';

/** The in-app route (`studio/agents/<id>`), the shape `onNavigate` takes. */
export function studioTarget(section: StudioLinkSection, id: string): string {
    return `studio/${segmentForSection(section)}/${encodeURIComponent(id)}`;
}

/** The full URL, for a real link that also opens in a new tab. */
export function studioHref(section: StudioLinkSection, id: string): string {
    return `/app/${studioTarget(section, id)}`;
}
