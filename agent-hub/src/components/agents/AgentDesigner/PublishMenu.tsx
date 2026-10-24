// Who can see this agent: the Personal / Published toggle and its dropdown
// (personal, the whole organisation, or chosen groups). Split out of
// AgentDesigner/index.jsx without a change in behaviour.
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';

export interface OrgGroup { id: string; name?: string; description?: string | null }

export interface PublishMenuProps {
    isReadonly: boolean;
    isPublished: boolean;
    sharedGroups: string[];
    setSharedGroups: Dispatch<SetStateAction<string[]>>;
    orgGroups: OrgGroup[];
    showPublishMenu: boolean;
    setShowPublishMenu: (open: boolean) => void;
    publishError: string;
    setPublishError: (msg: string) => void;
    setPublishState: (published: boolean, groups: string[]) => void;
    togglePublish: (groups: string[]) => void;
}

const CHECK = <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>;
const CHEVRON = <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>;
const LOCK_PATH = 'M12 11c1.657 0 3-1.343 3-3V6a3 3 0 10-6 0v2c0 1.657 1.343 3 3 3zM5 21v-2a4 4 0 014-4h6a4 4 0 014 4v2';

export default function PublishMenu(p: PublishMenuProps) {
    const { t } = useTranslation();
    return (
        <div className="relative">
            {!p.isReadonly && (
                <button
                    onClick={() => { p.setShowPublishMenu(!p.showPublishMenu); p.setPublishError(''); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border ${
                        p.isPublished ? 'bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600' : 'text-[var(--text-secondary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                    style={!p.isPublished ? { borderColor: 'var(--border-default)' } : {}}
                >
                    {p.isPublished ? (
                        <>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            {t('agent_studio.agent_designer_published', 'Published')} {p.sharedGroups.length > 0 ? ` (${p.sharedGroups.length})` : ''}
                            {CHEVRON}
                        </>
                    ) : (
                        <>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={LOCK_PATH} /></svg>
                            {t('agent_studio.agent_designer_personal', 'Personal')}
                            {CHEVRON}
                        </>
                    )}
                </button>
            )}
            {p.showPublishMenu && <PublishDropdown {...p} />}
        </div>
    );
}

function PublishDropdown(p: PublishMenuProps) {
    const { t } = useTranslation();
    const { sharedGroups } = p;
    return (
        <div
            className="absolute right-0 top-full mt-2 w-72 rounded-xl shadow-2xl z-50 overflow-hidden [background:var(--bg-secondary)] [border:1px_solid_var(--border-default)]"
        >
            <div className="p-3 border-b border-[var(--border-subtle)]">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('agent_studio.agent_designer_publish_to', 'Publish to...')}
                </p>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">
                    {t('agent_studio.agent_designer_choose_who_can_see_this_agent', 'Choose who can see this agent')}
                </p>
            </div>

            {/* Personal — only the owner can access. */}
            <button
                onClick={() => p.setPublishState(false, [])}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--bg-tertiary)] transition-colors text-left"
            >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center [background:rgba(107,114,128,0.15)]">
                    <svg className="w-4 h-4 text-[var(--text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={LOCK_PATH} />
                    </svg>
                </div>
                <div className="flex-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('agent_studio.agent_designer_personal', 'Personal')}</p>
                    <p className="text-xs text-[var(--text-muted)]">{t('agent_studio.agent_designer_only_you_can_access', 'Only you can access')}</p>
                </div>
                {!p.isPublished && CHECK}
            </button>

            {/* Publish to entire org */}
            <button
                onClick={() => p.setPublishState(true, [])}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--bg-tertiary)] transition-colors text-left border-t border-[var(--border-subtle)]"
            >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center [background:rgba(16,185,129,0.15)]">
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                </div>
                <div className="flex-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                        {t('agent_studio.agent_designer_entire_organization', 'Entire Organization')}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('agent_studio.agent_designer_all_members_can_access', 'All members can access')}
                    </p>
                </div>
                {p.isPublished && sharedGroups.length === 0 && CHECK}
            </button>

            <GroupChooser {...p} />

            {/* Inline publish error (BFSF-220) — replaces alert(), which
                sandboxed iframes suppress */}
            {p.publishError && (
                <div role="alert" className="px-3 py-2 border-t text-xs text-red-500 bg-red-500/10 border-[var(--border-subtle)]">
                    {p.publishError}
                </div>
            )}

            {/* Cancel */}
            <div className="p-2 border-t border-[var(--border-subtle)]">
                <button
                    onClick={() => p.setShowPublishMenu(false)}
                    className="w-full px-3 py-1.5 rounded-lg text-xs text-center text-[var(--text-muted)]"
                >
                    {t('agent_studio.agent_designer_cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
}

/** "Or specific groups": a checkbox per org group and the publish button. */
function GroupChooser({ orgGroups, sharedGroups, setSharedGroups, togglePublish }: PublishMenuProps) {
    const { t } = useTranslation();
    return (
        <>
            {orgGroups.length > 0 && (
                <div className="px-3 py-2 border-t border-[var(--border-subtle)]">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        {t('agent_studio.agent_designer_or_specific_groups', 'Or specific groups')}
                    </p>
                </div>
            )}

            <div className="max-h-48 overflow-auto">
                {orgGroups.map((group) => (
                    <label key={group.id} className="flex items-center gap-3 px-4 py-2 hover:bg-[var(--bg-tertiary)] cursor-pointer transition-colors">
                        <input
                            type="checkbox"
                            checked={sharedGroups.includes(group.id)}
                            onChange={(e) => {
                                if (e.target.checked) {
                                    setSharedGroups((prev) => [...prev, group.id]);
                                } else {
                                    setSharedGroups((prev) => prev.filter((g) => g !== group.id));
                                }
                            }}
                            className="accent-[var(--accent-primary)] w-4 h-4"
                        />
                        <div className="flex-1">
                            <p className="text-sm text-[var(--text-primary)]">{group.name}</p>
                            {group.description && (
                                <p className="text-xs text-[var(--text-muted)]">{group.description}</p>
                            )}
                        </div>
                    </label>
                ))}
            </div>

            {sharedGroups.length > 0 && (
                <div className="p-3 border-t border-[var(--border-subtle)]">
                    <button
                        onClick={() => togglePublish(sharedGroups)}
                        className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                    >
                        {t('agent_studio.agent_designer_publish_to_count_group', 'Publish to {count} group', { count: sharedGroups.length })}
                        {sharedGroups.length > 1 ? 's' : ''}
                    </button>
                </div>
            )}
        </>
    );
}
