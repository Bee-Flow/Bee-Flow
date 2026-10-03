/**
 * What a Solution can hold — a port of SECTIONS in the web's
 * components/projects/ProjectResourcesTab.jsx and BANDS in
 * SolutionContentTable.jsx, pinned by sections.lockstep.test.ts.
 *
 * The list mirrors server/projects/membership.js section for section: the
 * server decides what a project can hold, this file decides how the phone
 * shows it. Two facts ride along per kind:
 *
 *   `movable`      a resource can be filed in and out; an approval is a
 *                  record, stamped with its project when raised and never
 *                  re-filed.
 *   `ownerFields`  WHOSE item it is, as an allow-list per kind rather than a
 *                  chain of fallbacks that would quietly start matching a new
 *                  field. `null` = the link lives on the project row
 *                  (knowledge bases), so taking it out is an editor's act.
 */

import type { TranslateFn } from '@/core/i18n';
import type { KindKey } from '@/shared/ui';

import type { FiledItem, ProjectResources, SectionKey } from './types';

type OwnerField = 'userId' | 'ownerId' | 'ownerUserId';

export interface SectionDef {
    key: SectionKey;
    /** The membership registry's `kind` — what PUT /:id/resources takes. */
    kind: string;
    /** The Studio kind whose tile it wears; approvals have none. */
    tile: KindKey | null;
    movable: boolean;
    ownerFields: readonly OwnerField[] | null;
    /** The web address of one item; openLink translates it to a native screen. */
    webPath: (id: string) => string;
}

const enc = encodeURIComponent;

export const SECTIONS: readonly SectionDef[] = [
    { key: 'notebooks', kind: 'notebook', tile: 'meeting', movable: true, ownerFields: ['userId', 'ownerId'], webPath: (id) => `/app/studio/documents/notebook/${enc(id)}` },
    { key: 'apps', kind: 'app', tile: 'app', movable: true, ownerFields: ['userId', 'ownerId'], webPath: (id) => `/app/apps/${enc(id)}` },
    { key: 'automations', kind: 'automation', tile: 'automation', movable: true, ownerFields: ['userId', 'ownerId'], webPath: (id) => `/app/studio/automations/${enc(id)}` },
    { key: 'webpages', kind: 'webpage', tile: 'webpage', movable: true, ownerFields: ['userId', 'ownerId'], webPath: (id) => `/app/studio/webpages/${enc(id)}` },
    { key: 'datatables', kind: 'datatable', tile: 'datatable', movable: true, ownerFields: ['ownerUserId'], webPath: (id) => `/app/studio/datatables/${enc(id)}` },
    { key: 'agents', kind: 'agent', tile: 'agent', movable: true, ownerFields: ['ownerId'], webPath: (id) => `/app/studio/agents/${enc(id)}` },
    { key: 'knowledgeBases', kind: 'knowledge_base', tile: 'kb', movable: true, ownerFields: null, webPath: (id) => `/app/studio/knowledge/${enc(id)}` },
    { key: 'approvals', kind: 'approval', tile: null, movable: false, ownerFields: null, webPath: (id) => `/app/studio/approvals/${enc(id)}` },
];

/** The kinds a picker may offer: everything movable. */
export const MOVABLE_SECTIONS: readonly SectionDef[] = SECTIONS.filter((s) => s.movable);

/** The section heading, borrowing each subject's own key as the web does. */
export function sectionLabel(key: SectionKey, t: TranslateFn): string {
    switch (key) {
        case 'notebooks':
            return t('projects.notebooks', 'Notebooks');
        case 'apps':
            return t('projects.apps', 'Apps');
        case 'automations':
            return t('projects.routines', 'Routines');
        case 'webpages':
            return t('projects.webpages', 'Webpages');
        case 'datatables':
            return t('datatables.heading', 'Tables');
        case 'agents':
            return t('agent_studio.title', 'Agents');
        case 'knowledgeBases':
            return t('knowledge.title', 'Knowledge bases');
        default:
            return t('projects.approvals', 'Approvals');
    }
}

export type BandKey = 'people' | 'work' | 'knowledge';

/** The three bands of the Content tab: who touches what. */
export const BANDS: readonly { key: BandKey; sections: readonly SectionKey[] }[] = [
    { key: 'people', sections: ['apps', 'webpages'] },
    { key: 'work', sections: ['automations', 'approvals'] },
    { key: 'knowledge', sections: ['datatables', 'agents', 'knowledgeBases', 'notebooks'] },
];

export function bandLabel(key: BandKey, t: TranslateFn): string {
    if (key === 'people') return t('solutions.band_people', 'People use');
    if (key === 'work') return t('solutions.band_work', 'Work happens');
    return t('solutions.band_knowledge', 'Knowledge & data');
}

/** A kind with no band still gets a row — in the last one. */
export function bandOf(key: SectionKey): BandKey {
    return BANDS.find((band) => band.sections.includes(key))?.key ?? 'knowledge';
}

/** The item's own words; null when it has none (the row says "Untitled"). */
export function itemLabel(item: FiledItem): string | null {
    return item.name || item.title || item.prompt || null;
}

/**
 * May this person take this item back out of the project?
 *
 * Unknown ownership is never the wider answer: an item whose owner field is
 * missing, or a viewer with no id of their own, gets no button. Offering one
 * would promise something the server answers 404 to.
 */
export function mayRemove(section: SectionDef, item: FiledItem, meId: string | undefined, canEdit: boolean): boolean {
    if (!canEdit || !section.movable) return false;
    if (!section.ownerFields) return true;
    if (!meId) return false;
    return section.ownerFields.some((f) => item[f] != null && item[f] === meId);
}

/** `kind:id` of everything already filed, so a picker does not offer it twice. */
export function filedKeys(resources: ProjectResources | null | undefined): Set<string> {
    const out = new Set<string>();
    for (const section of SECTIONS) {
        for (const item of resources?.[section.key] ?? []) out.add(`${section.kind}:${item.id}`);
    }
    return out;
}
