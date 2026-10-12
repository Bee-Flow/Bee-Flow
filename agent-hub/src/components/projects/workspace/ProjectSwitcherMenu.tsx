// The name in the rail head is a button: it opens the five most recently
// updated projects and "All projects", so switching project is one click
// instead of a trip through the list.
import { Bell, BellOff, ChevronDown, FolderOpen } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { useSetProjectMute } from '../../../api/queries/notificationPrefs';
import type { Project } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import toast from '../../shared/Toast';
import { AnchoredMenu } from './tasks/sprintUi';
import { projectIcon, projectTileStyle } from './projectVisuals';

const RECENT = 5;

export default function ProjectSwitcherMenu({ current, projects, onOpenProject, onBack, folded }: {
    current: Project; projects: Project[]; onOpenProject: (id: string) => void; onBack: () => void; folded: boolean;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const recent = useMemo(() => projects.filter((p) => p.id !== current.id && !p.archivedAt)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, RECENT), [projects, current.id]);
    const setMute = useSetProjectMute(current.id);
    const muted = current.muted === true;
    const toggleMute = () => setMute.mutate(!muted, {
        onSuccess: (now) => toast.success(now
            ? t('project_collab.mute.done_muted', 'Project muted. You get no bell or e-mail for it.')
            : t('project_collab.mute.done_unmuted', 'Project unmuted.')),
        onError: () => toast.error(t('project_collab.mute.failed', 'Could not change the mute setting.')),
    });
    const pick = (fn: () => void) => { setOpen(false); fn(); };
    return (
        <>
            <button type="button" ref={anchorRef} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
                aria-label={t('project_home.rail.switch_named', 'Switch project, current: {name}', { name: current.name })} title={current.name}
                className={`${folded ? '' : 'flex-1 min-w-0'} flex items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-[var(--item-hover-bg)]`} data-testid="project-rail-switch">
                <span style={projectTileStyle(current.color, 28)} aria-hidden="true">{projectIcon(current.icon)}</span>
                {!folded && <span className="flex-1 min-w-0 truncate text-sm font-semibold text-[var(--text-primary)]" data-testid="project-rail-name">{current.name}</span>}
                {!folded && <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="left" width={240} role="menu" aria-label={t('project_home.rail.switch', 'Switch project')}>
                <div className="p-1.5">
                    {recent.length > 0 && <p className="px-2 py-1 m-0 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('project_home.rail.recent', 'Recent projects')}</p>}
                    {recent.map((p) => (
                        <button key={p.id} type="button" role="menuitem" onClick={() => pick(() => onOpenProject(p.id))}
                            className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-left text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]">
                            <span aria-hidden="true">{projectIcon(p.icon)}</span><span className="truncate">{p.name}</span>
                        </button>
                    ))}
                    <button type="button" role="menuitem" onClick={() => pick(toggleMute)} data-testid="project-rail-mute"
                        className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-left text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] border-t border-[var(--border-subtle)] mt-1">
                        {muted ? <Bell className="w-4 h-4" aria-hidden="true" /> : <BellOff className="w-4 h-4" aria-hidden="true" />}
                        {muted ? t('project_collab.mute.menu_unmute', 'Unmute this project') : t('project_collab.mute.menu_mute', 'Mute this project')}
                    </button>
                    <button type="button" role="menuitem" onClick={() => pick(onBack)}
                        className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-left text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] border-t border-[var(--border-subtle)] mt-1">
                        <FolderOpen className="w-4 h-4" aria-hidden="true" />{t('project_home.all_projects', 'All projects')}
                    </button>
                </div>
            </AnchoredMenu>
        </>
    );
}
