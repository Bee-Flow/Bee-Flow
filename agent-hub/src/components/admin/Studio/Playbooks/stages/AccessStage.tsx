import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccessAskCard from './access/AccessAskCard';
import AccessControlsCard from './access/AccessControlsCard';
import AccessGateCard from './access/AccessGateCard';
import AccessNowCard from './access/AccessNowCard';
import { accessSummary, applyAccessPlan } from './accessApply';
import {
    currentAccess, peopleToShow, plannedChanges, roleOptions as roleOptionsOf, roleWords, whyDisabled,
} from './accessView';
import StageShell from './StageShell';
import useAppRoles, { useOrgDirectory } from '../../AppStudio/rbac/useAppRoles';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';
import { playbooksApi } from '../playbooksApi';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { Phase, PlaybookEvent } from '../phaseMachine';
import type { Playbook } from '../usePlaybook';
import type { AudienceKind, DirectoryUser, ScreenPlan } from './access/accessScreenTypes';

/** The app the phase gives access to, as far as this screen reads it. */
interface AccessApp {
    name?: string;
    isPublished?: boolean;
    sharedGroups?: unknown[];
    nextcloudMenu?: boolean;
}

/** What the publish endpoint says about the Nextcloud push. */
interface NcResult {
    success: boolean;
    nextcloudMenu?: boolean;
    ncConnected: boolean;
    ncSync: string;
}

/**
 * The last phase of a playbook that built an app: WHO may use it, and with
 * which role.
 *
 * Two ways in, one gate out. The controls below set the audience by hand; the
 * box at the top takes a sentence ("Finance may look, Ann approves") and the
 * server turns it into a PROPOSAL — names resolved against the real directory,
 * nothing written. Every change, typed or proposed, waits behind Approve: the
 * writes only happen when the person presses it (owner, 2026-09-16).
 *
 * Approving with an audience is also the PUBLISH — it takes a copy of the app
 * as it stands — and can put the app in the Nextcloud app menu. That checkbox
 * is off unless the person ticks it, and the assistant cannot set it: an icon
 * in someone's Nextcloud is not something a sentence should be able to do.
 *
 * Redrawn 2026-09-17 for the same reason the compliance phase was: it was
 * three flat cards of controls that never said where the app stood, never said
 * what a role would let someone SEE, listed every person in the organisation
 * with a bare "—" beside them, and greyed out Approve without saying why.
 * Now: where it stands, a sentence box that shows what it can take, the
 * controls, and a gate that lists every change before it makes one.
 */
const EMPTY_PLAN = { audience: null, roles: [], tableRules: [], defaultRole: null, byGroup: {}, byGroupNames: {}, members: [], unresolved: [], note: '', nextcloudMenu: false, empty: true };

/**
 * What the server said about the Nextcloud push, in one line. The endpoint
 * waits for the org's connector, so this can be exact instead of hopeful —
 * the same three readings the Publish dialog gives (`ncConnected`, `ncSync`).
 */
function ncMenuWords(nc: NcResult | null, t: TranslateFn) {
    if (!nc) return null;
    if (nc.ncConnected === false) return t('playbooks.access.nc_not_connected', 'No Nextcloud is connected yet — the icon appears once it is.');
    if (nc.ncSync === 'synced') return t('playbooks.access.nc_synced', 'It is in the Nextcloud app menu — reload Nextcloud to see it.');
    return t('playbooks.access.nc_pending', 'The icon appears in Nextcloud within a few minutes.');
}

/** A 422 from the publish endpoint carries the real reasons — show those. */
/** A refusal from the publish endpoint: the validator's reasons ride on `body.errors`. */
interface PublishRefusal {
    body?: { errors?: Array<string | { message?: string; error?: string }> } | null;
}

function blockersOf(error: PublishRefusal | null | undefined) {
    const body = error && error.body;
    const list = body && Array.isArray(body.errors) ? body.errors : [];
    return list.map((e) => (typeof e === 'string' ? e : (e && (e.message || e.error)) || '')).filter(Boolean).slice(0, 6);
}

interface AccessStageProps {
    playbook: Playbook & { title?: string };
    phase: Phase;
    dispatch: (event: PlaybookEvent) => Promise<unknown>;
    t: TranslateFn;
    presenter?: boolean;
}

export default function AccessStage({ playbook, phase, dispatch, t, presenter = false }: AccessStageProps) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const appId = art.appId || null;
    const startedRef = useRef<string>(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    const { roles, roleMapping, tables, members, saveRoles, assignMember, isLoading } = useAppRoles(appId);
    const { groups, users, available } = useOrgDirectory(!!appId);
    const [app, setApp] = useState<AccessApp | null>(null);
    useEffect(() => {
        if (!appId) return undefined;
        let alive = true;
        studioAppsApi.getApp(appId).then((r) => { if (alive && r && r.app) setApp(r.app); }).catch(() => { /* the form still works */ });
        return () => { alive = false; };
    }, [appId]);

    // What is on the table, by hand or proposed — one shape either way, so
    // Approve applies exactly what is on screen.
    const [plan, setPlan] = useState<ScreenPlan>({ ...EMPTY_PLAN });
    const [said, setSaid] = useState('');
    const [asking, setAsking] = useState(false);
    const [askError, setAskError] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);
    const [blockers, setBlockers] = useState<string[] | null>(null);
    const [ncResult, setNcResult] = useState<NcResult | null>(null);
    // A directory of any size is unusable as a flat list of selects; people
    // who already hold a role show by default, everyone else is searched for.
    const [peopleQuery, setPeopleQuery] = useState('');

    const ask = useCallback(async () => {
        const message = said.trim();
        if (!message || asking) return;
        setAsking(true);
        setAskError(null);
        try {
            const body = await playbooksApi.accessPlan(playbook.id, phase.key, message);
            if (body && body.plan) { setPlan(body.plan); setSaid(''); }
        } catch (e) {
            setAskError((e as Error)?.message || t('playbooks.access.ask_failed', 'The assistant could not read that — say it in other words.'));
        } finally {
            setAsking(false);
        }
    }, [said, asking, playbook.id, phase.key, t]);

    const setAudience = (kind: AudienceKind, groupIds: string[] = []) => setPlan((p) => ({
        ...p,
        empty: false,
        audience: kind === 'groups'
            ? { kind, groupIds, groupNames: groupIds.map((id) => (groups.find((g) => g.id === id) || {}).name || id) }
            : { kind },
    }));
    const toggleGroup = (id: string) => {
        const cur = plan.audience && plan.audience.kind === 'groups' ? plan.audience.groupIds : [];
        setAudience('groups', cur.includes(id) ? cur.filter((x: string) => x !== id) : [...cur, id]);
    };
    const setGroupRole = (groupId: string, roleKey: string) => setPlan((p) => {
        const byGroup = { ...p.byGroup };
        if (!roleKey) delete byGroup[groupId]; else byGroup[groupId] = roleKey;
        return { ...p, byGroup, empty: false };
    });
    const setMemberRole = (userId: string, roleKey: string) => setPlan((p) => {
        const list = p.members.filter((m) => m.userId !== userId);
        if (!roleKey) return { ...p, members: list, empty: false };
        const u = users.find((x) => x.id === userId) as DirectoryUser | undefined;
        return { ...p, members: [...list, { userId, roleKey, name: (u && (u.name || u.email)) || userId }], empty: false };
    });

    const roleOptions = useMemo(() => roleOptionsOf({ roles, planRoles: plan.roles }, t), [roles, plan.roles, t]);
    /** What a role lets someone see — the row rule included, if it has one. */
    const meansOf = useCallback(
        (roleKey: string | undefined) => roleWords(roleKey, { roles, planRoles: plan.roles, tables, planRules: plan.tableRules || [] }, t),
        [roles, plan.roles, plan.tableRules, tables, t],
    );

    const approve = useCallback(async () => {
        if (applying) return;
        if (!appId) return;
        setApplying(true);
        setApplyError(null);
        setBlockers(null);
        const { failed, nc } = await applyAccessPlan(plan, { roles, roleMapping, tables, nextcloudMenu: !!(app && app.nextcloudMenu) }, {
            saveRoles,
            assignMember,
            publish: (body) => studioAppsApi.publish(appId, body),
            setNextcloudMenu: (enabled) => studioAppsApi.setNextcloudMenu(appId, enabled),
        });
        setApplying(false);
        setNcResult((nc as NcResult | undefined) || null);
        if (failed.length) {
            // A publish refused by the validator says WHY (422 → body.errors).
            // "Could not apply: audience" is not something anyone can act on.
            const audience = failed.find((f) => f.what === 'audience');
            setBlockers(audience ? blockersOf(audience.error as PublishRefusal | null) : null);
            setApplyError(failed.map((f) => f.what).join(', '));
            return;
        }
        dispatch({ type: 'finished', key: phase.key, summary: accessSummary(plan, t), artifacts: { appId, accessApplied: true, nextcloudMenu: !!plan.nextcloudMenu } });
    }, [applying, plan, roles, roleMapping, tables, saveRoles, assignMember, appId, app, dispatch, phase.key, t]);

    if (!appId) {
        return (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-[var(--warning)]" data-testid="playbook-stage-access-missing">
                <AlertTriangle className="w-4 h-4" aria-hidden="true" />{t('playbooks.access.no_app', 'There is no app to give access to.')}
            </div>
        );
    }

    const audienceKind = plan.audience ? plan.audience.kind : null;
    const chosenGroups = plan.audience && plan.audience.kind === 'groups' ? plan.audience.groupIds : [];
    const now = currentAccess(app, members, t);
    const changes = plannedChanges(plan, { groups, users, app, roles }, t);
    const blocked = whyDisabled(plan, t);
    const shownPeople = peopleToShow(users, { members, plan, query: peopleQuery });

    return (
        <StageShell
            kind="app"
            icon={ShieldCheck}
            width="default"
            presenter={presenter}
            testId="playbook-stage-access"
            phaseKey={phase?.key}
            title={t('playbooks.access.title', 'Who uses "{name}"?', { name: (app && app.name) || playbook.title })}
            subtitle={t('playbooks.access.intro', 'Say it in a sentence or set it yourself. Nothing is applied until you approve it.')}
            tone={status === 'failed' ? 'error' : 'busy'}
            status={status === 'failed' ? (phase?.error || t('playbooks.access.failed', 'This phase did not land — try it again.')) : null}
        >
            <AccessNowCard now={now} app={app} presenter={presenter} t={t} />
            <AccessAskCard said={said} setSaid={setSaid} asking={asking} askError={askError} ask={ask} plan={plan} presenter={presenter} t={t} />
            <AccessControlsCard
                plan={plan}
                setPlan={setPlan}
                audienceKind={audienceKind}
                chosenGroups={chosenGroups}
                setAudience={setAudience}
                toggleGroup={toggleGroup}
                setGroupRole={setGroupRole}
                setMemberRole={setMemberRole}
                meansOf={meansOf}
                roleOptions={roleOptions}
                roles={roles}
                groups={groups}
                users={users}
                available={available}
                members={members}
                shownPeople={shownPeople}
                peopleQuery={peopleQuery}
                setPeopleQuery={setPeopleQuery}
                isLoading={isLoading}
                t={t}
            />
            <AccessGateCard
                changes={changes}
                blocked={blocked}
                applying={applying}
                approve={approve}
                discard={() => { setPlan({ ...EMPTY_PLAN }); setBlockers(null); setNcResult(null); }}
                planEmpty={plan.empty}
                ncResult={ncResult}
                ncWords={ncMenuWords(ncResult, t)}
                applyError={applyError}
                blockers={blockers}
                presenter={presenter}
                t={t}
            />
        </StageShell>
    );
}
