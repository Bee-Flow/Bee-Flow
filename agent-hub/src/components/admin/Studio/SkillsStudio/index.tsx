import { useCallback, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSkillsStudioData } from './useSkillsStudioData';
import useTranslation from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import SkillDetail from './SkillDetail';
import SkillsList from './SkillsList';
import SkillsOverview from './SkillsOverview';
import { filterSkills } from './skillModel';
import { skillsApi } from '@/api/skillsApi';
import type { Skill, UsageSummaryMap } from './skillModel.types';

/**
 * Studio → Skills (Bee Flow Builder redesign, Sep 2026; Skills.dc.html).
 *
 * This section used to be ONE file: five text boxes behind five tabs, no
 * tests, and no way to tell from the outside whether a skill did anything.
 * It is now a directory — list, detail, step editor, rules, output fields,
 * grants, examples, overview, test — with the same chrome every other
 * Studio kind opens with.
 *
 * ── THE LANDING IS A TABLE, NOT AN INVITATION ───────────────────────
 * With no skill selected the right side shows "All skills": what each one
 * is made of, who uses it, when it last fired, and its last test verdict
 * (artboard 1c, right). The old empty state offered to create a sixth skill
 * to someone who could not tell which of their five was doing anything.
 *
 * ── TWO REQUESTS, NOT n+1 ───────────────────────────────────────────
 * `GET /api/skills` (rows + `canEdit` + `lastTest`) and
 * `GET /api/skills/usage-summary` (agents/automations/lastUsedAt per skill).
 * The summary is a SEPARATE, non-fatal read: it is the one number that
 * needs a scan across agents and automations, and a slow or failing scan
 * must not keep the list off the screen. When it has not answered, the
 * subline is blank — never "not linked yet", which would be a claim.
 *
 * Props are the ones `studioApps.jsx` already hands every section
 * (`user`, `initialSkillId`, `onNavigate`, `hasPermission`); nothing in the
 * registry changes.
 */
interface SkillsUser {
    id?: string;
    isAdmin?: boolean;
    role?: string;
    orgRole?: string | null;
}

interface SkillsStudioProps {
    user: SkillsUser;
    initialSkillId?: string | null;
    onNavigate?: ((to: string) => void) | null;
    hasPermission?: (permission: string) => boolean;
}

/**
 * The open skill: the deep link's, re-adopted whenever the link changes, INCLUDING
 * to null (the Approvals / Datatables pattern): only adopting truthy ids leaves a
 * detail open after Back.
 */
function useDeepLinkedId(initialSkillId: string | null | undefined) {
    const [openId, setOpenId] = useState(initialSkillId || null);
    const [lastInitial, setLastInitial] = useState(initialSkillId);
    if (initialSkillId !== lastInitial) {
        setLastInitial(initialSkillId);
        setOpenId(initialSkillId || null);
    }
    return [openId, setOpenId] as const;
}

export default function SkillsStudio({ user, initialSkillId = null, onNavigate, hasPermission = () => true }: SkillsStudioProps) {
    const { t } = useTranslation();

    // `manage_skills` is not a discrete role permission; this is the same
    // broader check the sidebar uses, so org/agent admins can create and
    // delete. The server re-checks it on every write — this only decides
    // which controls are worth drawing.
    const canManage = (
        hasPermission('manage_skills')
        || hasPermission('manage_agents')
        || user?.isAdmin
        || user?.role === 'admin'
        || (['admin', 'org_admin', 'agent_admin', 'agent_editor'] as Array<string | null | undefined>).includes(user?.orgRole)
    );

    const [query, setQuery] = useState('');
    const [openId, setOpenId] = useDeepLinkedId(initialSkillId);

    // Resolved during render, not inside `load`: without a TranslationProvider
    // `useTranslation` hands back a fresh `t` every render (embeds, isolated
    // tests), so a `useCallback` that depends on it changes identity every
    // render — and this one is called from a mount effect, which would turn
    // that into a refetch loop. A string compares by value, so the callback
    // stays stable.
    const listErrorText = t('skills_studio.err_list', 'Could not load the skills.');

    const { skills, summary, loading, listError, load, loadSummary, patchSkill, dropSkill } = useSkillsStudioData(listErrorText);

    const open = useCallback((id: string | null) => {
        setOpenId(id || null);
        onNavigate?.(id ? `studio/skills/${id}` : 'studio/skills');
    }, [setOpenId, onNavigate]);

    const create = useMutation({
        mutationFn: () => skillsApi.create({
            name: t('skills_studio.untitled', 'Untitled skill'),
            description: '', instructions: '', workflow: '', rules: '', examples: '',
            icon: '⚡', isShared: false, dynamicActivation: false,
            sharedGroups: [], enabledIntegrations: [],
        }),
        onSuccess: async (created) => {
            await load();
            if (created?.id) open(created.id);
        },
        onError: (e) => {
            toast.error((e as Error).message || t('skills_studio.err_create', 'Could not create the skill.'));
        },
    });
    // The toast is the mutation's onError; the caller only awaits the outcome.
    const createEmpty = async () => { await create.mutateAsync().catch(() => undefined); };

    const shown = useMemo(() => filterSkills(skills, query), [skills, query]);
    const openSkill = useMemo(() => skills.find(s => s.id === openId) || null, [skills, openId]);

    // A saved edit is merged into the row in place: the list's name and
    // subline follow the editor without a refetch, and without remounting
    // the detail (which would throw away the caret and any pending save).
    const onSaved = useCallback((patch: { id: string; }) => {
        patchSkill(patch);
    }, [patchSkill]);

    const onDeleted = useCallback((id: string) => {
        dropSkill(id);
        open(null);
        loadSummary();
    }, [dropSkill, open, loadSummary]);

    return (
        <div className="flex h-full min-h-0 bg-[var(--bg-primary)]" data-testid="skills-studio">
            <SkillsList
                skills={shown}
                summary={summary}
                loading={loading}
                error={listError}
                selectedId={openId}
                query={query}
                onQuery={setQuery}
                onSelect={open}
                onCreate={createEmpty}
                canCreate={canManage}
            />
            <section className="flex-1 min-w-0 min-h-0 flex flex-col">
                {openSkill ? (
                    <SkillDetail
                        key={openSkill.id}
                        skill={openSkill}
                        currentUserId={user?.id || null}
                        canManage={canManage}
                        onBack={() => open(null)}
                        onSaved={onSaved}
                        onDeleted={onDeleted}
                        onNavigate={onNavigate}
                    />
                ) : (
                    <SkillsOverview
                        skills={shown}
                        summary={summary}
                        loading={loading}
                        // Same read, same restraint: with nothing selected
                        // the landing is the biggest surface on screen, and
                        // "Create your first skill" off a read that never
                        // answered is the loudest version of the lie.
                        error={listError}
                        // The filter that produced `shown`. Without it the
                        // landing cannot tell an empty org from a filter that
                        // matched nothing, and prints "Create your first skill"
                        // over skills that are one backspace away.
                        query={query}
                        onOpen={open}
                        // "Let AI fill it in" OPENS the skill rather than
                        // firing `POST /:id/ai/improve` from the table: the
                        // improve endpoint lands with S3, and the header's
                        // own button is one click away once the skill is
                        // open. A row that rewrites a skill from a table,
                        // with nothing on screen to compare against, is not
                        // the shape that action wants anyway.
                        onImprove={canManage ? open : null}
                    />
                )}
            </section>
        </div>
    );
}
