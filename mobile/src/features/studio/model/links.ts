/**
 * Where a Studio address opens on the phone: the native screen of its
 * section. One function for every entrance — a section row, an attention
 * row's "Show me", a search hit, a New-menu item, the Describe-it card — so
 * they cannot disagree about where a thing lives.
 *
 * A `web` target (a section only a later web release has) opens the Studio
 * hub, as its deep link does (notifications/model/routeStudio.ts): the web's
 * Studio turns a phone away (agent-hub MobileRouteGuard), and a browser tab
 * does not share this app's session, so the web page is no door from here.
 */

import { sectionForSegment, STUDIO_SECTIONS } from './registry';
import type { StudioSection, StudioTarget } from './types';

/** A resolved destination: a screen of this app. */
export type OpenTarget = { kind: 'route'; href: string };

const HUB: OpenTarget = { kind: 'route', href: '/studio' };

/** A section itself, or one of its objects when the id is known. */
export function sectionTarget(section: Pick<StudioSection, 'target'>, id?: string | null): OpenTarget {
    return targetFor(section.target, id ?? null);
}

/** A registry target as it stands (a list, a create flow): no object id to add. */
export function plainTarget(target: StudioTarget): OpenTarget {
    return target.kind === 'web' ? HUB : { kind: 'route', href: target.href };
}

function targetFor(target: StudioTarget, id: string | null): OpenTarget {
    if (target.kind === 'web') return HUB;
    if (id && target.detail) return { kind: 'route', href: target.detail(encodeURIComponent(id)) };
    return { kind: 'route', href: target.href };
}

/** The first section that manages a kind — the one that IS the thing (studioNav.studioAppForKind). */
export function sectionForKind(kind: string | null): StudioSection | null {
    if (!kind) return null;
    return STUDIO_SECTIONS.find((s) => s.kind === kind) ?? null;
}

/**
 * `/app/studio/<segment>[/<id>]` → where it opens, or null when the path is
 * not a Studio section this registry knows. `/app/studio` and
 * `/app/studio/start` are the hub; `…/new` is the section's create flow.
 */
export function studioLinkTarget(path: string | null): OpenTarget | null {
    if (!path) return null;
    const clean = path.split(/[?#]/)[0] ?? '';
    const match = /^\/app\/studio(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(clean);
    if (!match) return null;
    const [, segment, id] = match;
    if (!segment || segment === 'start') return HUB;
    const section = sectionForSegment(segment);
    if (!section) return null;
    // A section without a create flow opens its list: `new` is never an object id.
    if (id === 'new') return section.create ? plainTarget(section.create.target) : targetFor(section.target, null);
    return targetFor(section.target, id ? safeDecode(id) : null);
}

function safeDecode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** Where an attention finding opens: the server's own deep link first, the registry (kind + id) only when it sent none. */
export function attentionTarget(row: { deepLink: string | null; kind: string | null; targetId: string | null }): OpenTarget | null {
    const linked = studioLinkTarget(row.deepLink);
    if (linked) return linked;
    const section = sectionForKind(row.kind);
    return section && row.targetId ? sectionTarget(section, row.targetId) : null;
}
