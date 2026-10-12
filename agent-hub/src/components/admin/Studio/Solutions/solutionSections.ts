import { AppWindow, BookOpen, Bot, FileText, Globe, Library, ShieldCheck, Sparkles, Table2, Workflow } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

/**
 * What a Solution can hold, section by section: notebooks, apps, automations,
 * webpages, tables, agents, skills, document templates and knowledge bases,
 * plus the approvals raised inside it.
 *
 * This list MIRRORS server/projects/membership.js for a container of kind
 * `solution`. The server decides what a Solution can hold; this file decides
 * how it looks. A section here with no kind there renders an "unavailable" box
 * for ever, because the payload will never carry that key. Documents and
 * meeting notes are workspace-only kinds, so they are deliberately absent. A
 * document TEMPLATE is a different kind (`document_template`, filed through its
 * own column, so it is never project content) and is a section of its own.
 *
 * `movable` is what separates a resource from a record. Everything but
 * approvals is a resource: filed in and out at will, and handed back untouched
 * when the Solution is deleted. Approvals are records — stamped with their
 * Solution when they are raised and never re-filed, because re-filing an
 * automation moves its FUTURE approvals, not decisions someone already took. So
 * they list with no way to remove them.
 *
 * `ownerFields` is WHOSE ITEM IT IS, per kind, and it is an allow-list rather
 * than a chain of `||` fallbacks on purpose. The stores each spell ownership
 * differently (`userId`, `ownerUserId`, `ownerId`), and a chain that tries them
 * all is a chain that silently starts matching a NEW field somebody adds later.
 * `null` means the kind has no owner of its own: a knowledge base is linked from
 * the Solution row, so taking it out is an editor's act rather than an owner's —
 * which is exactly what the server allows.
 *
 * The labels borrow keys from the namespaces that own those subjects
 * (`datatables.*`, `agent_studio.*`, `knowledge.*`, `projects.*`, `skills.*`,
 * `documents.*`).
 */

export type SolutionItem = Record<string, unknown> & { id: string };

export interface SolutionSection {
    /** The key of this section in the GET /api/projects/:id/resources payload. */
    key: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    labelKey: string;
    /** The server's kind name, used for attach/detach. */
    kind: string;
    movable: boolean;
    ownerFields: string[] | null;
}

export const SECTIONS: SolutionSection[] = [
    { key: 'notebooks', icon: BookOpen, labelKey: 'projects.notebooks', kind: 'notebook', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'apps', icon: AppWindow, labelKey: 'projects.apps', kind: 'app', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'automations', icon: Workflow, labelKey: 'projects.automations', kind: 'automation', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'webpages', icon: Globe, labelKey: 'projects.webpages', kind: 'webpage', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'datatables', icon: Table2, labelKey: 'datatables.heading', kind: 'datatable', movable: true, ownerFields: ['ownerUserId'] },
    { key: 'agents', icon: Bot, labelKey: 'agent_studio.title', kind: 'agent', movable: true, ownerFields: ['ownerId'] },
    { key: 'skills', icon: Sparkles, labelKey: 'skills.title', kind: 'skill', movable: true, ownerFields: ['ownerId'] },
    { key: 'documentTemplates', icon: FileText, labelKey: 'documents.library.templates', kind: 'document_template', movable: true, ownerFields: ['userId'] },
    { key: 'knowledgeBases', icon: Library, labelKey: 'knowledge.title', kind: 'knowledge_base', movable: true, ownerFields: null },
    { key: 'approvals', icon: ShieldCheck, labelKey: 'projects.approvals', kind: 'approval', movable: false, ownerFields: null },
];

/** An item's display name. An approval's identity is the question it asks. */
export function itemLabel(item: Record<string, unknown>): string {
    for (const field of ['name', 'title', 'prompt']) {
        const value = item[field];
        if (typeof value === 'string' && value) return value;
    }
    return 'Untitled';
}

/**
 * May this person take this item back out of the Solution?
 *
 * Unknown ownership is never the wider answer: an item whose owner field is
 * missing, or a viewer with no id of their own, gets no button. Offering one
 * would promise something the server answers 404 to.
 */
export function mayRemove(
    section: Pick<SolutionSection, 'movable' | 'ownerFields'>,
    item: Record<string, unknown>,
    currentUserId: string | null | undefined,
    canEdit: boolean,
): boolean {
    if (!canEdit || !section.movable) return false;
    if (!section.ownerFields) return true;      // the link is on the Solution, not the item
    if (!currentUserId) return false;
    return section.ownerFields.some(field => item[field] != null && item[field] === currentUserId);
}
