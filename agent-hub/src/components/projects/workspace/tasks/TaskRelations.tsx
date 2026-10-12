// The connected work of a task, as sections of the dialog's document column:
// the items inside it, the tasks it relates to or depends on, and the
// documents, notebooks, meetings and chats it is about. Rows, not boxes; the
// "+" of each section opens a picker.

import { Plus, Search, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { linkKey, type ProjectTask, type TaskLink } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import { LINK_ICON, useTaskLinks, type LinkOption } from './taskLinks';
import { SelectField } from '../workspaceUi';
import { TypeIcon } from './TaskFields';
import { workItemType } from './taskPlanning';
import { statusLabel } from './taskText';
import { GHOST_ACTION, ICON_BUTTON, MENU_ITEM, MENU_LABEL, MENU_SEARCH, Popover, REVEAL, SectionHeader } from './taskDialogParts';

/** A task can hold at most this many links of all kinds together (the server's cap). */
const MAX_LINKS = 25;

const ROW = 'group flex items-center gap-2 h-9 px-2 -mx-2 rounded-lg hover:bg-[var(--item-hover-bg)] transition-colors';
const ROW_TITLE = 'flex-1 min-w-0 flex items-center gap-2 text-left text-[13px] text-[var(--text-primary)] disabled:cursor-default';

function TaskTitle({ item, onOpen }: { item: ProjectTask; onOpen?: (link: TaskLink) => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={() => onOpen?.({ kind: 'task', id: item.id })} disabled={!onOpen} className={ROW_TITLE}>
            <TypeIcon type={workItemType(item)} />
            <span className={`truncate ${item.status === 'done' ? 'line-through text-[var(--text-tertiary)]' : ''}`}>{item.title || t('project_tasks.untitled', 'Untitled task')}</span>
        </button>
    );
}

/** The items whose parent this one is. Shown only when there are any. */
export function SubItems({ task, tasks, onOpen }: { task: ProjectTask | null | undefined; tasks: ProjectTask[]; onOpen?: (link: TaskLink) => void }) {
    const { t } = useTranslation();
    const children = task ? tasks.filter(item => item.parentTaskId === task.id) : [];
    if (!children.length) return null;
    const done = children.filter(child => child.status === 'done').length;
    return (
        <section>
            <SectionHeader title={t('project_tasks.sub_items', 'Sub-items')} count={`${done}/${children.length}`} />
            <ul className="list-none m-0 p-0">
                {children.map(child => (
                    <li key={child.id} className={ROW}>
                        <TaskTitle item={child} onOpen={onOpen} />
                        <span className="flex-none text-[11.5px] text-[var(--text-tertiary)]">{statusLabel(t, child.status)}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** The "+ Link task" picker: a search over the project's work items. */
function LinkTaskPicker({ open, onClose, anchorRef, candidates, onPick }: {
    open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLButtonElement | null>; candidates: ProjectTask[]; onPick: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const query = search.trim().toLocaleLowerCase();
    const matches = (query ? candidates.filter(item => `${item.title} ${workItemType(item)}`.toLocaleLowerCase().includes(query)) : candidates).slice(0, 8);
    const pick = (id: string) => { setSearch(''); onPick(id); };
    const label = t('project_tasks.search_link_tasks', 'Search epics, stories and tasks');
    return (
        <Popover open={open} onClose={() => { setSearch(''); onClose(); }} anchorRef={anchorRef} align="right" width={300} label={t('project_tasks.link_task', 'Link task')}>
            <div className="relative">
                <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--text-tertiary)] pointer-events-none" aria-hidden="true" />
                <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={label} aria-label={label}
                    onKeyDown={event => { if (event.key === 'Enter' && matches[0]) { event.preventDefault(); pick(matches[0].id); } }}
                    className={`${MENU_SEARCH} pl-8`} />
            </div>
            {matches.map(item => (
                <button key={item.id} type="button" onClick={() => pick(item.id)} className={MENU_ITEM}>
                    <TypeIcon type={workItemType(item)} />
                    <span className="truncate">{item.title || t('project_tasks.untitled', 'Untitled task')}</span>
                </button>
            ))}
            {!matches.length && <p className="m-0 px-2.5 py-3 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.no_link_matches', 'No matching tasks to link.')}</p>}
        </Popover>
    );
}

/** The tasks this one is linked to (related, or depends on), and the ones that link here. */
export function RelatedTasks({ task, tasks, links, onChange, onOpen, disabled }: {
    task: ProjectTask | null | undefined; tasks: ProjectTask[]; links: TaskLink[]; onChange: (links: TaskLink[]) => void; onOpen?: (link: TaskLink) => void; disabled: boolean;
}) {
    const { t } = useTranslation();
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const byId = new Map(tasks.map(item => [item.id, item]));
    const relatedIds = new Set(links.filter(link => link.kind === 'task').map(link => link.id));
    const related = [...relatedIds].map(id => byId.get(id)).filter((item): item is ProjectTask => !!item);
    const incoming = task ? tasks.filter(item => item.id !== task.id && item.links.some(link => link.kind === 'task' && link.id === task.id) && !relatedIds.has(item.id)) : [];
    const full = links.length >= MAX_LINKS;
    const candidates = tasks.filter(item => item.id !== task?.id && !item.unreadable && !relatedIds.has(item.id));
    const dependsOn = (id: string) => links.some(link => link.kind === 'task' && link.id === id && link.relation === 'depends_on');
    const setRelation = (id: string, relation: string) => onChange(links.map(link => (link.kind === 'task' && link.id === id
        ? { kind: 'task' as const, id: link.id, ...(relation === 'depends_on' ? { relation: 'depends_on' as const } : {}) }
        : link)));
    const add = (id: string) => { onChange([...links, { kind: 'task', id }]); setOpen(false); anchor.current?.focus(); };
    if (disabled && !related.length && !incoming.length) return null;
    const relationLabel = (item: ProjectTask) => t('project_tasks.relationship_with', 'Relationship with {title}', { title: item.title });
    return (
        <section>
            <SectionHeader title={t('project_tasks.relationships', 'Relationships')} count={related.length + incoming.length || ''}
                action={!disabled && (
                    <button type="button" ref={anchor} className={GHOST_ACTION} onClick={() => setOpen(o => !o)} disabled={full} aria-haspopup="dialog" aria-expanded={open}
                        title={full ? t('project_tasks.max_links', 'Maximum 25 links') : undefined}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.link_task', 'Link task')}
                    </button>
                )} />
            {(related.length > 0 || incoming.length > 0) && (
                <ul className="list-none m-0 p-0">
                    {related.map(item => (
                        <li key={item.id} className={ROW}>
                            <TaskTitle item={item} onOpen={onOpen} />
                            {disabled
                                ? dependsOn(item.id) && <span className="flex-none text-[11.5px] text-[var(--info-ink)]">{t('project_tasks.relation_depends_on', 'Depends on')}</span>
                                : (
                                    <SelectField aria-label={relationLabel(item)} title={relationLabel(item)} value={dependsOn(item.id) ? 'depends_on' : 'related'}
                                        onChange={event => setRelation(item.id, event.target.value)}
                                        bare wrapperClassName="relative inline-block flex-none" className={`h-7 px-1.5 rounded-md border-0 bg-transparent text-[12px] cursor-pointer hover:bg-[var(--bg-tertiary)] [&>option]:bg-[var(--bg-card)] [&>option]:text-[var(--text-primary)] ${dependsOn(item.id) ? 'text-[var(--info-ink)]' : 'text-[var(--text-tertiary)]'}`}>
                                        <option value="related">{t('project_tasks.relation_related', 'Related')}</option>
                                        <option value="depends_on">{t('project_tasks.relation_depends_on', 'Depends on')}</option>
                                    </SelectField>
                                )}
                            {!disabled && (
                                <button type="button" aria-label={t('project_tasks.unlink_task', 'Unlink {title}', { title: item.title })} title={t('project_tasks.unlink_task', 'Unlink {title}', { title: item.title })}
                                    onClick={() => onChange(links.filter(link => !(link.kind === 'task' && link.id === item.id)))}
                                    className={`${ICON_BUTTON} !w-6 !h-6 hover:!text-[var(--error-ink)] ${REVEAL}`}>
                                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            )}
                        </li>
                    ))}
                    {incoming.map(item => (
                        <li key={item.id} className={ROW}>
                            <TaskTitle item={item} onOpen={onOpen} />
                            <span className="flex-none text-[11.5px] text-[var(--text-tertiary)]">{t('project_tasks.links_here', 'links here')}</span>
                        </li>
                    ))}
                </ul>
            )}
            <LinkTaskPicker open={open} onClose={() => setOpen(false)} anchorRef={anchor} candidates={candidates} onPick={add} />
        </section>
    );
}

/** The "+ Link" picker: the project's documents, notebooks, meetings and chats, grouped by kind. */
function ResourcePicker({ open, onClose, anchorRef, label, options, onPick }: {
    open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLButtonElement | null>; label: string; options: LinkOption[]; onPick: (link: TaskLink) => void;
}) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const query = search.trim().toLocaleLowerCase();
    const addable = query ? options.filter(o => o.label.toLocaleLowerCase().includes(query)) : options;
    const groups: [TaskLink['kind'], string][] = [
        ['document', t('project_tasks.link_documents', 'Documents')],
        ['notebook', t('project_tasks.link_notebooks', 'Notebooks')],
        ['meeting', t('project_tasks.link_meetings', 'Meetings')],
        ['chat', t('project_tasks.link_chats', 'Chats')],
    ];
    return (
        <Popover open={open} onClose={() => { setSearch(''); onClose(); }} anchorRef={anchorRef} align="right" width={300} label={label}>
            {options.length > 8 && (
                <div className="relative">
                    <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--text-tertiary)] pointer-events-none" aria-hidden="true" />
                    <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('project_tasks.search_links', 'Search…')}
                        aria-label={t('project_tasks.search_links', 'Search…')} className={`${MENU_SEARCH} pl-8`} />
                </div>
            )}
            {groups.map(([kind, name]) => {
                const of = addable.filter(o => o.link.kind === kind);
                if (!of.length) return null;
                const Icon = LINK_ICON[kind];
                return (
                    <div key={kind} role="group" aria-label={name}>
                        <div className={MENU_LABEL} aria-hidden="true">{name}</div>
                        {of.map(o => (
                            <button key={linkKey(o.link)} type="button" className={MENU_ITEM} onClick={() => { setSearch(''); onPick(o.link); }}>
                                <Icon className="w-3.5 h-3.5 flex-none text-[var(--text-tertiary)]" aria-hidden="true" />
                                <span className="truncate">{o.label}</span>
                            </button>
                        ))}
                    </div>
                );
            })}
            {!addable.length && <p className="m-0 px-2.5 py-3 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.nothing_to_link', 'Nothing left to link')}</p>}
        </Popover>
    );
}

/** The documents, notebooks, meetings and chats a task is about. */
export function LinkedResources({ projectId, links, onChange, onOpen, disabled }: {
    projectId: string; links: TaskLink[]; onChange: (links: TaskLink[]) => void; onOpen?: (l: TaskLink) => void; disabled: boolean;
}) {
    const { t } = useTranslation();
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const { options, labelOf } = useTaskLinks(projectId);
    const resourceLinks = links.filter(link => link.kind !== 'task');
    const held = new Set(resourceLinks.map(linkKey));
    const full = links.length >= MAX_LINKS;
    if (disabled && !resourceLinks.length) return null;
    const addLabel = t('project_tasks.add_link', 'Link a document, notebook or chat');
    return (
        <section>
            <SectionHeader title={t('project_tasks.linked_resources', 'Linked resources')} count={resourceLinks.length || ''}
                action={!disabled && (
                    <button type="button" ref={anchor} className={GHOST_ACTION} onClick={() => setOpen(o => !o)} disabled={full} aria-haspopup="dialog" aria-expanded={open} aria-label={addLabel}
                        title={full ? t('project_tasks.max_links', 'Maximum 25 links') : addLabel}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.link_resource', 'Link')}
                    </button>
                )} />
            {resourceLinks.length > 0 && (
                <ul className="list-none m-0 p-0">
                    {resourceLinks.map((l) => {
                        const Icon = LINK_ICON[l.kind];
                        return (
                            <li key={linkKey(l)} className={ROW}>
                                <button type="button" onClick={() => onOpen?.(l)} disabled={!onOpen} className={ROW_TITLE}>
                                    <Icon className="w-3.5 h-3.5 flex-none text-[var(--text-tertiary)]" aria-hidden="true" />
                                    <span className="truncate">{labelOf(l)}</span>
                                </button>
                                {!disabled && (
                                    <button type="button" onClick={() => onChange(links.filter(x => linkKey(x) !== linkKey(l)))}
                                        aria-label={t('project_tasks.remove_link', 'Remove link')} title={t('project_tasks.remove_link', 'Remove link')}
                                        className={`${ICON_BUTTON} !w-6 !h-6 hover:!text-[var(--error-ink)] ${REVEAL}`}>
                                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <ResourcePicker open={open} onClose={() => setOpen(false)} anchorRef={anchor} label={addLabel} options={options.filter(o => !held.has(linkKey(o.link)))}
                onPick={(link) => { onChange([...links, link]); setOpen(false); anchor.current?.focus(); }} />
        </section>
    );
}
