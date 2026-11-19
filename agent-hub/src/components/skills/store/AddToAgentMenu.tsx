import { useQuery } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import { toast } from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { attachSkillToAgent, listOwnAgents } from '@/api/skillStoreApi';

/**
 * "Add to agent": pick one of YOUR agents and the skill is attached to its
 * draft through the agent editor's own save (api/skillStoreApi.ts). The list
 * is read when the menu opens; an agent this account may not edit answers
 * `can_edit: false` and is left as it is.
 */
export default function AddToAgentMenu({ skillId, skillName, userId }: { skillId: string; skillName: string; userId: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const agents = useQuery({
        queryKey: ['agents', 'own', userId],
        queryFn: () => listOwnAgents(userId),
        enabled: open,
        staleTime: 30_000,
    });

    const attach = async (agentId: string, agentName: string) => {
        setBusy(agentId);
        try {
            const { result, published } = await attachSkillToAgent(agentId, skillId);
            if (result === 'already') toast.info(t('skillStore.attach_already', '{agent} already uses {skill}.', { agent: agentName, skill: skillName }));
            else if (result === 'not_editable') toast.error(t('skillStore.attach_not_editable', 'You cannot change {agent}.', { agent: agentName }));
            else if (published) toast.success(t('skillStore.attach_done_published', 'Added to {agent}. Publish the agent again so its users get the skill too.', { agent: agentName }));
            else toast.success(t('skillStore.attach_done', 'Added to {agent}.', { agent: agentName }));
            setOpen(false);
        } catch (e) {
            toast.error((e as Error)?.message || t('skillStore.attach_failed', 'Could not add the skill to {agent}.', { agent: agentName }));
        } finally {
            setBusy(null);
        }
    };

    const rows = agents.data || [];
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid={`skill-store-attach-${skillId}`}
                className="h-7 px-2.5 rounded-lg text-[12px] font-medium inline-flex items-center gap-1 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                <Plus size={12} aria-hidden="true" /> {t('skillStore.attach', 'Add to agent')}
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={240} role="menu" className="p-1">
                {agents.isLoading && <p className="m-0 px-2.5 py-2 text-xs text-[var(--text-tertiary)]">{t('skillStore.agents_loading', 'Loading your agents…')}</p>}
                {agents.isError && <p className="m-0 px-2.5 py-2 text-xs text-[var(--warning)]">{t('skillStore.agents_failed', 'Your agents could not be read.')}</p>}
                {agents.isSuccess && rows.length === 0 && (
                    <p className="m-0 px-2.5 py-2 text-xs text-[var(--text-tertiary)]">{t('skillStore.agents_none', 'You have no agents of your own yet.')}</p>
                )}
                {rows.map((a) => (
                    <button
                        key={a.id}
                        type="button"
                        role="menuitem"
                        disabled={busy !== null}
                        onClick={() => { void attach(a.id, a.name || a.id); }}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        <Bot size={13} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                        <span className="truncate">{a.name || a.id}</span>
                    </button>
                ))}
            </AnchoredMenu>
        </>
    );
}
