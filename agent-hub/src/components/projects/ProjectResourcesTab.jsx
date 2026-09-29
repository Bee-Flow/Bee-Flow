import { BookOpen, AppWindow, Workflow, Globe, Table2, Bot, Library, ShieldCheck, AlertTriangle, Loader2, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Everything that lives in this project: notebooks, apps, routines, webpages,
 * tables, agents and knowledge bases, plus the approvals raised inside it.
 *
 * Each of these was previously reachable only by its owner (notebooks had no
 * sharing mechanism of any kind, and the routines↔projects link was dead code).
 * A NULL project_id still means standalone and owner-only — membership here is
 * additive, never a move that takes something away from whoever made it.
 *
 * This list MIRRORS server/projects/membership.js, section for section. The
 * server decides what a project can hold; this file decides how it looks. A
 * section here with no kind there renders an "unavailable" box for ever,
 * because the payload will never carry that key.
 *
 * `movable` is what separates a resource from a record. Everything but
 * approvals is a resource: filed in and out at will, and handed back untouched
 * when the project is deleted. Approvals are records — stamped with their
 * project when they are raised and never re-filed, because re-filing an
 * automation moves its FUTURE approvals, not decisions someone already took. So
 * they list here with no way to remove them.
 *
 * `ownerFields` is WHOSE ITEM IT IS, per kind, and it is an allow-list rather
 * than a chain of `||` fallbacks on purpose. The stores each spell ownership
 * differently (`userId`, `ownerUserId`, `ownerId`), and a chain that tries them
 * all is a chain that silently starts matching a NEW field somebody adds later.
 * `null` means the kind has no owner of its own: a knowledge base is linked from
 * the PROJECT row, so taking it out is an editor's act rather than an owner's —
 * which is exactly what the server allows.
 *
 * The labels borrow three keys from the namespaces that own those subjects
 * (`datatables.*`, `agent_studio.*`, `knowledge.*`) rather than inventing
 * `projects.*` ones this stage may not write. They render the right words
 * today; a follow-up may give them `projects.` keys beside the five below.
 */

export const SECTIONS = [
    { key: 'notebooks', icon: BookOpen, labelKey: 'projects.notebooks', kind: 'notebook', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'apps', icon: AppWindow, labelKey: 'projects.apps', kind: 'app', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'automations', icon: Workflow, labelKey: 'projects.routines', kind: 'automation', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'webpages', icon: Globe, labelKey: 'projects.webpages', kind: 'webpage', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'datatables', icon: Table2, labelKey: 'datatables.heading', kind: 'datatable', movable: true, ownerFields: ['ownerUserId'] },
    { key: 'agents', icon: Bot, labelKey: 'agent_studio.title', kind: 'agent', movable: true, ownerFields: ['ownerId'] },
    { key: 'knowledgeBases', icon: Library, labelKey: 'knowledge.title', kind: 'knowledge_base', movable: true, ownerFields: null },
    { key: 'approvals', icon: ShieldCheck, labelKey: 'projects.approvals', kind: 'approval', movable: false, ownerFields: null },
];

export function itemLabel(item) {
    // An approval's identity is the question it asks; it has no name or title.
    return item.name || item.title || item.prompt || 'Untitled';
}

/**
 * May this person take this item back out of the project?
 *
 * Unknown ownership is never the wider answer: an item whose owner field is
 * missing, or a viewer with no id of their own, gets no button. Offering one
 * would promise something the server answers 404 to.
 */
export function mayRemove(section, item, currentUserId, canEdit) {
    if (!canEdit || !section.movable) return false;
    if (!section.ownerFields) return true;      // the link is on the project, not the item
    if (!currentUserId) return false;
    return section.ownerFields.some(field => item[field] != null && item[field] === currentUserId);
}

export default function ProjectResourcesTab({
    resources,
    loading,
    role,
    currentUserId,
    onOpen,
    onRemove,
}) {
    const { t } = useTranslation();
    const canEdit = role === 'owner' || role === 'editor';

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {SECTIONS.map((section) => {
                const { key, icon: Icon, labelKey, kind } = section;
                const items = resources?.[key];

                return (
                    <div key={key}>
                        <div className="flex items-center gap-2 mb-2">
                            <Icon className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />
                            <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {t(labelKey)}
                            </h3>
                            {Array.isArray(items) && items.length > 0 && (
                                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{items.length}</span>
                            )}
                        </div>

                        {/* null and [] mean different things and must not look
                            the same: the server returns null when a store could
                            not be reached, and showing that as "none" would tell
                            the user their work had disappeared. */}
                        {items === null || items === undefined ? (
                            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs"
                                 style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                                <AlertTriangle className="w-3.5 h-3.5" />
                                {t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}
                            </div>
                        ) : items.length === 0 ? (
                            <p className="px-3 py-2.5 rounded-lg text-xs"
                               style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                                {t('projects.section_empty', 'Nothing here yet.')}
                            </p>
                        ) : (
                            <div className="space-y-1.5">
                                {items.map((item) => {
                                    const removable = mayRemove(section, item, currentUserId, canEdit);
                                    return (
                                        <div key={item.id}
                                             className="flex items-center gap-3 px-3 py-2 rounded-lg group"
                                             style={{ background: 'var(--bg-secondary)' }}>
                                            <button
                                                onClick={() => onOpen?.(kind, item)}
                                                className="flex-1 min-w-0 text-left text-sm truncate"
                                                style={{ color: 'var(--text-primary)' }}
                                            >
                                                {itemLabel(item)}
                                            </button>
                                            {/* Only the owner may pull something back
                                                out — the stores match on user_id, so
                                                offering it to anyone else would just
                                                produce a 404. */}
                                            {removable && (
                                                <button
                                                    onClick={() => onRemove?.(kind, item)}
                                                    className="opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity"
                                                    style={{ color: 'var(--text-tertiary)' }}
                                                    title={t('projects.remove_from_project')}
                                                >
                                                    <X className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}

            {!canEdit && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('projects.viewer_readonly')}
                </p>
            )}
        </div>
    );
}
