import { Pin } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ITEM_TYPES, useProjectPins, useProjectSearch, useSetProjectPin } from '../../../api/queries/projectDiscovery';
import useTranslation from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';
import { itemTab } from './ProjectDiscovery';
import { projectErrorText } from './projectErrorText';
import { canEditProject, type OpenThreadTarget, type WorkspaceTabProps } from './types';
import { ErrorText, INPUT_CLASS, LoadingRow, SecondaryButton, SelectField } from './workspaceUi';

export interface ProjectSearchPanelProps extends Pick<WorkspaceTabProps, 'projectId' | 'role' | 'onOpenTab'> {
    open: boolean;
    onClose: () => void;
    onOpenThread?: (thread: OpenThreadTarget) => void;
}

/** Search across the project's items, in a dialog the rail's search pill opens. */
export default function ProjectSearchPanel({ projectId, role, open, onClose, onOpenTab, onOpenThread }: ProjectSearchPanelProps) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    const [type, setType] = useState('');
    useEffect(() => { const timer = setTimeout(() => setQ(search), 250); return () => clearTimeout(timer); }, [search]);
    const results = useProjectSearch(projectId, q, type, open);
    const pins = useProjectPins(projectId);
    const pin = useSetProjectPin(projectId);
    const title = t('project_home.search_project', 'Search this project');
    return <Modal open={open} onClose={onClose} title={title} size="lg" placement="top">
        <section className="space-y-2" aria-label={title}>
            <div className="flex gap-2"><input autoFocus type="search" className={INPUT_CLASS} value={search} onChange={e => setSearch(e.target.value)} placeholder={title} aria-label={title} /><SelectField value={type} onChange={e => setType(e.target.value)} aria-label={t('project_content.type', 'Type')}><option value="">{t('project_home.all_types', 'All types')}</option>{ITEM_TYPES.map(itemType => <option key={itemType} value={itemType}>{t(`project_home.item.${itemType}`, itemType)}</option>)}</SelectField></div>
            <p className="text-xs text-[var(--text-secondary)]">{t('project_home.search_scope', 'Search titles, file names and task descriptions. Message contents are not searched.')}</p>
            {results.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
            {(results.error || pin.error) && <ErrorText>{projectErrorText(t, results.error || pin.error)}</ErrorText>}
            <div className="max-h-[40vh] overflow-auto">
                {!results.isError && results.data?.pages.flatMap(p => p?.items || []).map(item => {
                    const pinned = pins.data?.items.some(p => p.type === item.type && p.id === item.id) || false;
                    return <div key={`${item.type}:${item.id}`} className="flex items-center gap-2 py-2 border-b border-[var(--border-subtle)]">
                        <button className="text-left flex-1 min-w-0 text-sm hover:underline" onClick={() => { if (item.threadType) onOpenThread?.({ id: item.id, type: item.threadType, agentId: item.agentId || null }); else onOpenTab?.(itemTab(item), item.id); onClose(); }}>{item.title || t('project_home.untitled', 'Untitled')}<span className="block text-xs text-[var(--text-secondary)]">{t(`project_home.item.${item.type}`, item.type)}</span></button>
                        {canEditProject(role) && <SecondaryButton disabled={pin.isPending || !pins.data} aria-pressed={pinned} onClick={() => pin.mutate({ item, pinned: !pinned })} aria-label={pinned ? t('project_home.unpin', 'Unpin') : t('project_home.pin', 'Pin for everyone')}><Pin className={`w-4 h-4 ${pinned ? 'fill-current' : ''}`} /></SecondaryButton>}
                    </div>;
                })}
                {results.data?.pages[0]?.items.length === 0 && <p className="text-sm">{t('project_content.no_matches', 'Nothing matches your search.')}</p>}
                {results.hasNextPage && <SecondaryButton busy={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>{t('project_home.activity.load_more', 'Load more')}</SecondaryButton>}
            </div>
        </section>
    </Modal>;
}
