import { AlertTriangle, Check, Globe, LayoutGrid, Loader2, Lock, Search, Send, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessSummary, applyAccessPlan } from './accessApply';
import { playbooksApi } from '../playbooksApi';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';
import useAppRoles, { useOrgDirectory } from '../../AppStudio/rbac/useAppRoles';
import StageShell from './StageShell';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import {
    ASK_EXAMPLES, currentAccess, peopleToShow, plannedChanges, roleOptions as roleOptionsOf, roleWords, whyDisabled,
} from './accessView';

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
const AUDIENCES = ['private', 'organisation', 'groups'];
const EMPTY_PLAN = { audience: null, roles: [], tableRules: [], defaultRole: null, byGroup: {}, byGroupNames: {}, members: [], unresolved: [], note: '', nextcloudMenu: false, empty: true };

/**
 * What the server said about the Nextcloud push, in one line. The endpoint
 * waits for the org's connector, so this can be exact instead of hopeful —
 * the same three readings the Publish dialog gives (`ncConnected`, `ncSync`).
 */
export function ncMenuWords(nc, t) {
    if (!nc) return null;
    if (nc.ncConnected === false) return t('playbooks.access.nc_not_connected', 'No Nextcloud is connected yet — the icon appears once it is.');
    if (nc.ncSync === 'synced') return t('playbooks.access.nc_synced', 'It is in the Nextcloud app menu — reload Nextcloud to see it.');
    return t('playbooks.access.nc_pending', 'The icon appears in Nextcloud within a few minutes.');
}

/** A 422 from the publish endpoint carries the real reasons — show those. */
export function blockersOf(error) {
    const body = error && error.body;
    const list = body && Array.isArray(body.errors) ? body.errors : [];
    return list.map((e) => (typeof e === 'string' ? e : (e && (e.message || e.error)) || '')).filter(Boolean).slice(0, 6);
}

export default function AccessStage({ playbook, phase, dispatch, t, presenter = false }) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const appId = art.appId || null;
    const startedRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    const { roles, roleMapping, tables, members, saveRoles, assignMember, isLoading } = useAppRoles(appId);
    const { groups, users, available } = useOrgDirectory(!!appId);
    const [app, setApp] = useState(null);
    useEffect(() => {
        if (!appId) return undefined;
        let alive = true;
        studioAppsApi.getApp(appId).then((r) => { if (alive && r && r.app) setApp(r.app); }).catch(() => { /* the form still works */ });
        return () => { alive = false; };
    }, [appId]);

    // What is on the table, by hand or proposed — one shape either way, so
    // Approve applies exactly what is on screen.
    const [plan, setPlan] = useState({ ...EMPTY_PLAN });
    const [said, setSaid] = useState('');
    const [asking, setAsking] = useState(false);
    const [askError, setAskError] = useState(null);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState(null);
    const [blockers, setBlockers] = useState(null);
    const [ncResult, setNcResult] = useState(null);
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
            setAskError(e?.message || t('playbooks.access.ask_failed', 'The assistant could not read that — say it in other words.'));
        } finally {
            setAsking(false);
        }
    }, [said, asking, playbook.id, phase.key, t]);

    const setAudience = (kind, groupIds = []) => setPlan((p) => ({
        ...p,
        empty: false,
        audience: kind === 'groups'
            ? { kind, groupIds, groupNames: groupIds.map((id) => (groups.find((g) => g.id === id) || {}).name || id) }
            : { kind },
    }));
    const toggleGroup = (id) => {
        const cur = plan.audience && plan.audience.kind === 'groups' ? plan.audience.groupIds : [];
        setAudience('groups', cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    };
    const setGroupRole = (groupId, roleKey) => setPlan((p) => {
        const byGroup = { ...p.byGroup };
        if (!roleKey) delete byGroup[groupId]; else byGroup[groupId] = roleKey;
        return { ...p, byGroup, empty: false };
    });
    const setMemberRole = (userId, roleKey) => setPlan((p) => {
        const list = p.members.filter((m) => m.userId !== userId);
        if (!roleKey) return { ...p, members: list, empty: false };
        const u = users.find((x) => x.id === userId);
        return { ...p, members: [...list, { userId, roleKey, name: (u && (u.name || u.email)) || userId }], empty: false };
    });

    const roleOptions = useMemo(() => roleOptionsOf({ roles, planRoles: plan.roles }, t), [roles, plan.roles, t]);
    /** What a role lets someone see — the row rule included, if it has one. */
    const meansOf = useCallback(
        (roleKey) => roleWords(roleKey, { roles, planRoles: plan.roles, tables, planRules: plan.tableRules || [] }, t),
        [roles, plan.roles, plan.tableRules, tables, t],
    );

    const approve = useCallback(async () => {
        if (applying) return;
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
        setNcResult(nc || null);
        if (failed.length) {
            // A publish refused by the validator says WHY (422 → body.errors).
            // "Could not apply: audience" is not something anyone can act on.
            const audience = failed.find((f) => f.what === 'audience');
            setBlockers(audience ? blockersOf(audience.error) : null);
            setApplyError(failed.map((f) => f.what).join(', '));
            return;
        }
        dispatch({ type: 'finished', key: phase.key, summary: accessSummary(plan, t), artifacts: { appId, accessApplied: true, nextcloudMenu: !!plan.nextcloudMenu } });
    }, [applying, plan, roles, roleMapping, tables, saveRoles, assignMember, appId, app, dispatch, phase.key, t]);

    if (!appId) {
        return (
            <div className="h-full flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--warning)' }} data-testid="playbook-stage-access-missing">
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
                {/* Where it stands, before anything on this screen happens. */}
                <section
                    className="rounded-2xl"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-md)', padding: presenter ? 24 : 18 }}
                    data-testid="playbook-access-now"
                    data-tone={now.tone}
                >
                    <div className="flex items-start gap-3">
                        <span
                            className="inline-flex items-center justify-center shrink-0 rounded-xl"
                            style={{
                                width: presenter ? 44 : 36, height: presenter ? 44 : 36,
                                background: `color-mix(in srgb, ${now.tone === 'open' ? 'var(--warning)' : 'var(--kind-playbook)'} 12%, transparent)`,
                                color: now.tone === 'open' ? TONES.warning.ink : 'var(--kind-playbook)',
                            }}
                        >
                            {now.tone === 'private' ? <Lock className="w-5 h-5" aria-hidden="true" /> : <Users className="w-5 h-5" aria-hidden="true" />}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="font-semibold" style={{ fontSize: presenter ? 18 : 15, color: 'var(--text-primary)' }} data-testid="playbook-access-now-who">
                                {now.who}
                            </p>
                            <p style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }}>{now.namedLine}</p>
                            <p className="mt-0.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-tertiary)' }} data-testid="playbook-access-publish-state">
                                {app && app.isPublished
                                    ? t('playbooks.access.published_now', 'Published now{v}. Approving publishes a fresh copy of the app as it stands.', { v: app.publishedVersion ? ` · v${app.publishedVersion}` : '' })
                                    : t('playbooks.access.private_now', 'A private draft for now. Approving with an audience publishes a copy of the app as it stands.')}
                            </p>
                        </div>
                    </div>
                </section>

                {/* Say it — the way in, not a note field. */}
                <section className="rounded-xl p-3" style={{ border: '1px solid var(--type-ai)', background: 'color-mix(in srgb, var(--type-ai) 4%, transparent)' }}>
                    <p className="flex items-center gap-1.5 font-semibold mb-1.5" style={{ fontSize: presenter ? 15 : 13, color: 'var(--text-primary)' }}>
                        <Sparkles className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                        {t('playbooks.access.ask_title', 'Say who should use it')}
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <textarea
                            value={said}
                            onChange={(e) => setSaid(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }}
                            rows={2}
                            maxLength={2000}
                            disabled={asking}
                            className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-xs resize-y"
                            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                            placeholder={t('playbooks.access.ask_placeholder', 'e.g. Finance may look at it, Ann approves, nobody else.')}
                            aria-label={t('playbooks.access.ask_label', 'Say who should use this app')}
                            data-testid="playbook-access-ask"
                        />
                        <button
                            type="button"
                            onClick={ask}
                            disabled={asking || !said.trim()}
                            className="shrink-0 self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50"
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                            data-testid="playbook-access-ask-send"
                        >
                            {asking ? <><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.access.asking', 'Reading…')}</> : <><Send className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.access.ask_send', 'Propose')}</>}
                        </button>
                    </div>
                    {/* What it can take, so nobody has to guess at a blank box. */}
                    {!said && !plan.roles.length && (
                        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="playbook-access-examples">
                            {ASK_EXAMPLES.map((eg) => (
                                <button
                                    key={eg.key}
                                    type="button"
                                    onClick={() => setSaid(t(eg.key, eg.en))}
                                    className="text-[11px] px-2 py-[3px] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                    style={{ border: '1px dashed var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--type-ai)' }}
                                >
                                    {t(eg.key, eg.en)}
                                </button>
                            ))}
                        </div>
                    )}
                    {plan.note && <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="playbook-access-note">{plan.note}</p>}
                    {askError && <p role="alert" className="mt-1 text-[11px]" style={{ color: 'var(--error-ink, var(--error))' }}>{askError}</p>}
                    {plan.roles.length > 0 && (
                        <ul className="mt-2 space-y-1" data-testid="playbook-access-roles">
                            {plan.roles.map((r) => (
                                <li key={r.key} className="flex items-start gap-1.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }}>
                                    <Check className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                                    <span>
                                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                                        {r.scope
                                            ? ` — ${t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', { column: r.scope.column, value: r.scope.value })}`
                                            : ` — ${t('playbooks.access.role_all', 'sees every row')}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {plan.unresolved && plan.unresolved.length > 0 && (
                        <ul className="mt-2 space-y-0.5" data-testid="playbook-access-unresolved">
                            {plan.unresolved.map((u, i) => (
                                <li key={i} className="flex items-center gap-1.5 text-[11px]" style={{ color: TONES.warning.ink }}>
                                    <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                    {t('playbooks.access.unresolved', 'Could not find {kind} "{name}"', { kind: u.kind, name: u.name })}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {/* Or set it */}
                <section className="rounded-xl p-3 space-y-3" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                    <div>
                        <span className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.audience', 'Who can open the app')}</span>
                        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('playbooks.access.audience', 'Who can open the app')}>
                            {AUDIENCES.map((kind) => (
                                <button
                                    key={kind}
                                    type="button"
                                    role="radio"
                                    aria-checked={audienceKind === kind}
                                    onClick={() => setAudience(kind, kind === 'groups' ? chosenGroups : [])}
                                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium"
                                    style={{ border: `1px solid ${audienceKind === kind ? 'var(--type-ai)' : 'var(--border-default)'}`, color: audienceKind === kind ? 'var(--type-ai)' : 'var(--text-secondary)', background: audienceKind === kind ? 'color-mix(in srgb, var(--type-ai) 10%, transparent)' : 'transparent' }}
                                    data-testid={`playbook-access-audience-${kind}`}
                                >
                                    {kind === 'private' ? <Lock className="w-3 h-3" aria-hidden="true" /> : <Users className="w-3 h-3" aria-hidden="true" />}
                                    {kind === 'private'
                                        ? t('playbooks.access.private', 'Only me')
                                        : kind === 'organisation'
                                            ? t('playbooks.access.organisation', 'The whole organisation')
                                            : t('playbooks.access.groups', 'Chosen groups')}
                                </button>
                            ))}
                        </div>
                        {audienceKind === 'groups' && (
                            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="playbook-access-groups">
                                {available && groups.length ? groups.map((g) => (
                                    <button
                                        key={g.id}
                                        type="button"
                                        onClick={() => toggleGroup(g.id)}
                                        aria-pressed={chosenGroups.includes(g.id)}
                                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px]"
                                        style={{ border: `1px solid ${chosenGroups.includes(g.id) ? 'var(--kind-playbook)' : 'var(--border-default)'}`, color: 'var(--text-primary)' }}
                                    >
                                        {chosenGroups.includes(g.id) && <Check className="w-3 h-3" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />}
                                        {g.name}
                                    </button>
                                )) : <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.no_groups', 'No groups you can see here — ask in a sentence above instead.')}</span>}
                            </div>
                        )}
                    </div>

                    {/* The Nextcloud app menu. Only for a published app — the
                        endpoint answers 409 not_published otherwise — and off
                        unless the person ticks it (owner, 2026-09-16). The
                        ICON is instance-wide; the audience above still decides
                        who may open it. */}
                    {audienceKind && audienceKind !== 'private' && (
                        <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-primary)' }}>
                            <input
                                type="checkbox"
                                checked={!!plan.nextcloudMenu}
                                onChange={(e) => setPlan((p) => ({ ...p, nextcloudMenu: e.target.checked, empty: false }))}
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--kind-playbook)]"
                                data-testid="playbook-access-nc-menu"
                            />
                            <span className="min-w-0">
                                <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                                    <LayoutGrid className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                    {t('playbooks.access.nc_menu', 'Show in the Nextcloud app menu')}
                                </span>
                                <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('playbooks.access.nc_menu_desc', 'Puts the app in the top bar of your organisation\u2019s Nextcloud, on its own page. Everyone there sees the icon; only the audience above can open it.')}
                                </span>
                            </span>
                        </label>
                    )}

                    {/* A role only means something for a group that can open
                        the app at all, so the list follows the audience above
                        instead of showing every group in the organisation. */}
                    {(roles.length > 0 || plan.roles.length > 0) && available && groups.length > 0 && (() => {
                        const relevant = audienceKind === 'groups'
                            ? groups.filter((g) => chosenGroups.includes(g.id))
                            : audienceKind === 'organisation' ? groups : [];
                        if (!relevant.length) return null;
                        return (
                            <div>
                                <span className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.group_roles', 'What a group may do')}</span>
                                <ul className="space-y-1" data-testid="playbook-access-group-roles">
                                    {relevant.map((g) => (
                                        <li key={g.id} className="flex items-center gap-2 text-xs">
                                            <span className="flex-1 min-w-0">
                                                <span className="block truncate" style={{ color: 'var(--text-primary)' }}>{g.name}</span>
                                                {plan.byGroup[g.id] && (
                                                    <span className="block truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{meansOf(plan.byGroup[g.id])}</span>
                                                )}
                                            </span>
                                            <select
                                                value={plan.byGroup[g.id] || ''}
                                                onChange={(e) => setGroupRole(g.id, e.target.value)}
                                                className="h-7 rounded-lg px-2 text-[11px] shrink-0"
                                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                                                aria-label={t('playbooks.access.role_for', 'Role for {name}', { name: g.name })}
                                            >
                                                <option value="">{t('playbooks.access.role_none_words', 'No access')}</option>
                                                {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                                            </select>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })()}

                    {available && users.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.people', 'A role for one person')}</span>
                                {/* Every person in the organisation, each with
                                    an empty dropdown, is a wall — not a choice.
                                    Who already holds a role shows; the rest are
                                    searched for. */}
                                <span className="ml-auto relative">
                                    <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                    <input
                                        value={peopleQuery}
                                        onChange={(e) => setPeopleQuery(e.target.value)}
                                        className="h-7 w-[160px] rounded-lg pl-7 pr-2 text-[11px]"
                                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                                        placeholder={t('playbooks.access.people_search', 'Find someone…')}
                                        aria-label={t('playbooks.access.people_search', 'Find someone…')}
                                        data-testid="playbook-access-people-search"
                                    />
                                </span>
                            </div>
                            <ul className="space-y-1 max-h-[200px] overflow-y-auto" data-testid="playbook-access-people">
                                {shownPeople.map((u) => {
                                    const mine = plan.members.find((m) => m.userId === u.id);
                                    const already = members.find((m) => m.userId === u.id);
                                    const roleKey = mine ? mine.roleKey : '';
                                    return (
                                        <li key={u.id} className="flex items-center gap-2 text-xs">
                                            <span className="flex-1 min-w-0">
                                                <span className="block truncate" style={{ color: 'var(--text-primary)' }}>{u.name || u.email}</span>
                                                <span className="block truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                                    {roleKey
                                                        ? meansOf(roleKey)
                                                        : already
                                                            ? t('playbooks.access.already', 'has "{role}" today', { role: meansOf(already.roleKey) })
                                                            : u.email || ''}
                                                </span>
                                            </span>
                                            <select
                                                value={roleKey}
                                                onChange={(e) => setMemberRole(u.id, e.target.value)}
                                                className="h-7 rounded-lg px-2 text-[11px] shrink-0"
                                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                                                aria-label={t('playbooks.access.role_for', 'Role for {name}', { name: u.name || u.email })}
                                            >
                                                <option value="">{t('playbooks.access.role_none_words', 'No access')}</option>
                                                {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                                            </select>
                                        </li>
                                    );
                                })}
                                {!shownPeople.length && (
                                    <li className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('playbooks.access.people_none', 'Nobody by that name.')}</li>
                                )}
                            </ul>
                        </div>
                    )}
                    {isLoading && <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.loading', 'Reading the app\'s roles…')}</p>}
                </section>

                {/* The gate */}
                <section
                    className="rounded-2xl"
                    style={{ border: '1px solid var(--kind-playbook)', background: 'color-mix(in srgb, var(--kind-playbook) 6%, transparent)', padding: presenter ? 22 : 16 }}
                    data-testid="playbook-access-approve-box"
                >
                    {/* What Approve will do, one line each. It used to be a
                        single run-on sentence under a button that publishes an
                        app and hands out access. */}
                    <p className="font-semibold mb-1" style={{ fontSize: presenter ? 15 : 13, color: 'var(--text-primary)' }}>
                        {changes.length
                            ? t('playbooks.access.will_do', 'Approving will:')
                            : t('playbooks.access.will_nothing', 'Nothing chosen yet')}
                    </p>
                    {changes.length > 0 && (
                        <ul className="mb-2 space-y-0.5" data-testid="playbook-access-changes">
                            {changes.map((c, i) => (
                                <li
                                    key={i}
                                    className="flex items-start gap-1.5"
                                    style={{ fontSize: presenter ? 13 : 11, color: c.kind === 'note' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
                                    data-kind={c.kind}
                                >
                                    {c.kind === 'note'
                                        ? <span className="mt-0.5 shrink-0" aria-hidden="true">·</span>
                                        : <Check className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />}
                                    {c.words}
                                </li>
                            ))}
                        </ul>
                    )}
                    {blocked && (
                        <p className="mb-2" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }} data-testid="playbook-access-why-disabled">
                            {blocked}
                        </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={approve}
                            disabled={applying || !!blocked}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                            data-testid="playbook-access-approve"
                        >
                            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                            {t('playbooks.access.approve', 'Approve and apply')}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setPlan({ ...EMPTY_PLAN }); setBlockers(null); setNcResult(null); }}
                            disabled={applying || plan.empty}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-medium disabled:opacity-50"
                            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                            data-testid="playbook-access-discard"
                        >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.access.discard', 'Discard')}
                        </button>
                        <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.gate', 'Nothing is written before you press Approve.')}</span>
                    </div>
                    {ncResult && !applyError && (
                        <p className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="playbook-access-nc-result">
                            <Globe className="w-3 h-3 shrink-0" aria-hidden="true" />{ncMenuWords(ncResult, t)}
                        </p>
                    )}
                    {applyError && <p role="alert" className="mt-1 text-[11px]" style={{ color: 'var(--error-ink, var(--error))' }}>{t('playbooks.access.apply_failed', 'Could not apply: {what}', { what: applyError })}</p>}
                    {blockers && blockers.length > 0 && (
                        <ul className="mt-1 space-y-0.5" data-testid="playbook-access-blockers">
                            <li className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.access.blockers', 'The app itself is what stops the publish:')}</li>
                            {blockers.map((b, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--warning)' }}>
                                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{b}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
        </StageShell>
    );
}
