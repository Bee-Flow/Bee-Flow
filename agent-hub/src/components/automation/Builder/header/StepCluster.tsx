import { FolderOpen, MessageSquare, Upload } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import PublishMenuJsx from '../../../agents/AgentWizard/pickers/PublishMenu';

// A .jsx component: its prop types are inferred from defaults (`[]` → never[]).
const PublishMenu = PublishMenuJsx as unknown as ComponentType<Record<string, unknown>>;

/** The reusable Step (kind='block') row fields the header reads. */
export interface StepRow {
    icon?: string | null;
    category?: string | null;
    publishedVersion?: number | null;
    isPublished?: boolean;
    exposeAsTool?: boolean;
    sharedGroups?: string[];
    [key: string]: unknown;
}

export interface StepSharing { isPublished: boolean; sharedGroups: string[] }

/**
 * Step category field. The value groups the Step under a heading in every
 * automation's add-step menu. Commits on blur / Enter, not per keystroke.
 */
export function CategoryField({ value, onCommit }: { value: string; onCommit?: ((v: string) => void) | null }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(value || '');
    useEffect(() => { setDraft(value || ''); }, [value]);
    const commit = () => { if ((draft || '') !== (value || '')) onCommit?.(draft.trim()); };
    return (
        <span className="inline-flex items-center gap-1 flex-shrink-0 text-[var(--text-tertiary)]">
            <FolderOpen size={13} />
            <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                placeholder={t('automations.header.step_category_placeholder', 'Add a category')}
                title={t('automations.header.step_category_title', 'Group this Step under a category in the add-step menu')}
                maxLength={60}
                className="w-32 px-1.5 py-0.5 text-xs rounded bg-transparent border border-transparent hover:border-[var(--border-default)] focus:border-[var(--accent-primary)] focus:bg-[var(--bg-secondary)] text-[var(--text-secondary)] focus:outline-none transition"
            />
        </span>
    );
}

interface StepActionClusterProps {
    busy?: boolean;
    step: StepRow | null;
    orgGroups?: unknown[];
    onPublishStep?: (() => void) | null;
    onSetStepSharing?: ((s: StepSharing) => void) | null;
    onSetStepExpose?: ((on: boolean) => void) | null;
}

/**
 * Step mode's right cluster: the shared PublishMenu (Personal / Entire Org /
 * groups, identical to Agents and Knowledge Bases), an "In chat" toggle and
 * Publish, which rolls the draft out to every automation and chat using it.
 */
export function StepActionCluster({ busy = false, step, orgGroups = [], onPublishStep, onSetStepSharing, onSetStepExpose }: StepActionClusterProps) {
    const { t } = useTranslation();
    const [menuOpen, setMenuOpen] = useState(false);
    const isShared = !!step?.isPublished;
    const exposed = !!step?.exposeAsTool;
    const sharedGroups = Array.isArray(step?.sharedGroups) ? step.sharedGroups : [];
    // Toggling a group while Personal flips the Step to published (groups only
    // make sense once shared), the KB / Agent menu semantics.
    const toggleGroup = (gid: string) => {
        const next = sharedGroups.includes(gid) ? sharedGroups.filter(g => g !== gid) : [...sharedGroups, gid];
        onSetStepSharing?.({ isPublished: true, sharedGroups: next });
    };
    return (
        <div className="relative flex items-center gap-2">
            <PublishMenu
                t={t}
                agent={step}
                open={menuOpen}
                onToggle={() => setMenuOpen(v => !v)}
                onClose={() => setMenuOpen(false)}
                isPublished={isShared}
                onSetPersonal={() => { onSetStepSharing?.({ isPublished: false, sharedGroups: [] }); setMenuOpen(false); }}
                onSetEntireOrg={() => { onSetStepSharing?.({ isPublished: true, sharedGroups: [] }); setMenuOpen(false); }}
                embedEnabled={false}
                orgGroups={orgGroups}
                sharedGroups={sharedGroups}
                onToggleGroup={toggleGroup}
            />
            <button
                type="button"
                onClick={() => onSetStepExpose?.(!exposed)}
                disabled={busy}
                title={t('automations.header.step_in_chat_title', 'Make this Step callable as a tool in direct and agent chat')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border transition disabled:opacity-50 ${
                    exposed
                        ? 'bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--text-primary)] border-[var(--accent-primary)]'
                        : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]'
                }`}
            >
                <MessageSquare size={13} /> {t('automations.header.step_in_chat', 'In chat')}
            </button>
            <button
                type="button"
                onClick={() => onPublishStep?.()}
                disabled={busy}
                title={t('automations.header.step_publish_title', 'Publish: automations and chats using this Step pick up the change')}
                className="flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:brightness-95 transition disabled:opacity-50"
            >
                <Upload size={13} /> {t('automations.header.step_publish', 'Publish')}
            </button>
        </div>
    );
}
