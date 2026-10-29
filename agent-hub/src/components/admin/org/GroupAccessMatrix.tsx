import { Loader2, Check, AlertTriangle, Lock, Users, ShieldCheck, Sparkles, Settings, Layers, Search } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { getIntegrationIcon } from '@/config/integrationIcons';
import { useTranslation } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { messageOf } from '@/utils/caughtError';
import type { AccessCapability, AccessData, AccessKindSection, AccessMessage } from './access/accessTypes';
import { mutate, ApiError, request, RefusedError } from '@/api/mutate';

/**
 * GroupAccessMatrix — the org "Access & Permissions" surface.
 *
 * Scope-based (NOT a wide grid) so it stays usable for orgs with many groups
 * (20+): pick a scope on the left ("All members" or a group — searchable), then
 * toggle that scope's capabilities on the right. Grant-only: a checked toggle
 * GRANTS; there is no per-group "disable". Effective access = All-members grants
 * ∪ the user's groups' grants, capped by the plan/license ceiling (locked rows
 * are outside the ceiling). A group inherits anything granted to All members.
 *
 * `orgId` prop (optional): super-admin Beheerdashboard view → org-scoped
 * endpoints; without it → the caller's own org via the /me endpoints.
 *
 * Emerald + blue only.
 */

// MCP servers are integrations now (kind 'integration', category 'MCP servers')
// — they appear under Integrations, no separate section.
const KIND_SECTIONS: AccessKindSection[] = [
    { kind: 'core', labelKey: 'admin_org.access_matrix_features', label: 'Features', icon: Layers },
    { kind: 'beta', labelKey: 'admin_org.access_matrix_beta_features', label: 'Beta features', icon: Sparkles },
    { kind: 'integration', labelKey: 'admin_org.access_matrix_integrations', label: 'Integrations', icon: Settings },
];

const SAVE_DEBOUNCE_MS = 450;
const EMERALD = '#10b981';
const BLUE = '#3b82f6';
const EVERYONE = '__everyone__';

interface GroupAccessMatrixProps {
    orgId?: string | null;
    kinds?: string[] | null;
    hideLocked?: boolean;
    heading?: string;
    subtitle?: React.ReactNode;
    hideHeading?: boolean;
}

// `hideHeading`: for a caller whose page already titles the matrix (Settings →
// Organisation → Integrations, whose h2 and selected tab name it). The intro
// line and the save status stay.
export default function GroupAccessMatrix({ orgId: orgIdProp = null, kinds = null, hideLocked = false, heading, subtitle, hideHeading = false }: GroupAccessMatrixProps) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<AccessData | null>(null);
    const [message, setMessage] = useState<AccessMessage | null>(null);

    const [everyone, setEveryone] = useState<Set<string>>(() => new Set());
    const [groupGrants, setGroupGrants] = useState<Record<string, Set<string>>>({});
    const [scope, setScope] = useState(EVERYONE);
    const [groupQuery, setGroupQuery] = useState('');

    const everyoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const groupTimers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});

    const readPath = orgIdProp
        ? `${API_BASE}/auth/organizations/${encodeURIComponent(orgIdProp)}/group-access`
        : `${API_BASE}/auth/me/group-access`;
    const orgWritePath = orgIdProp
        ? `${API_BASE}/auth/organizations/${encodeURIComponent(orgIdProp)}/org-access`
        : `${API_BASE}/auth/me/org-access`;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            let res: Response;
            try {
                res = await request(readPath);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                setMessage({ type: 'error', text: t('admin_org.access_matrix_failed_load_status', 'Failed to load ({status})', { status: err.status }) });
                setLoading(false);
                return;
            }
            const j = await res.json();
            setData(j);
            setEveryone(new Set(j.everyone || []));
            const gg: Record<string, Set<string>> = {};
            for (const g of (j.groups || [])) gg[g.id] = new Set(g.granted || []);
            setGroupGrants(gg);
        } catch (e) {
            setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_failed_load', 'Failed to load')) });
        } finally { setLoading(false); }
    }, [readPath, t]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), 3500); return () => clearTimeout(timer); }, [message]);
    useEffect(() => () => {
        if (everyoneTimer.current) clearTimeout(everyoneTimer.current);
        Object.values(groupTimers.current).forEach(timer => timer && clearTimeout(timer));
    }, []);

    const ceiling = useMemo(() => new Set(data?.ceiling || []), [data]);
    const groups = useMemo(() => data?.groups || [], [data?.groups]);

    const saveEveryone = (nextSet: Set<string>) => {
        if (everyoneTimer.current) clearTimeout(everyoneTimer.current);
        everyoneTimer.current = setTimeout(async () => {
            try {
                try {
                    await mutate(orgWritePath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted: [...nextSet] }) });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error(t('admin_org.access_matrix_save_failed', 'Save failed'));
                }
                setMessage({ type: 'ok', text: t('admin_org.access_matrix_saved', 'Saved') });
            } catch (e) { setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_save_failed', 'Save failed')) }); load(); }
        }, SAVE_DEBOUNCE_MS);
    };

    const saveGroup = (groupId: string, nextSet: Set<string>) => {
        if (groupTimers.current[groupId]) clearTimeout(groupTimers.current[groupId]);
        groupTimers.current[groupId] = setTimeout(async () => {
            try {
                try {
                    await mutate(`${API_BASE}/auth/groups/${encodeURIComponent(groupId)}/access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted: [...nextSet] }) });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error(t('admin_org.access_matrix_save_failed', 'Save failed'));
                }
                setMessage({ type: 'ok', text: t('admin_org.access_matrix_saved', 'Saved') });
            } catch (e) { setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_save_failed', 'Save failed')) }); load(); }
        }, SAVE_DEBOUNCE_MS);
    };

    // On cloud the subscription decides which betas reach all members, so the
    // beta rows are read-only there. A group-scoped beta (e.g. Meeting Notes)
    // is the exception in both modes: "All members" is a real choice for it,
    // and a group can hold it while All members does not.
    const betaReadOnly = (cap: AccessCapability) => cap.kind === 'beta' && data?.betaGoverned && !cap.groupScoped;
    const isEveryoneScope = scope === EVERYONE;

    const toggle = (cap: AccessCapability) => {
        if (!ceiling.has(cap.id) || betaReadOnly(cap)) return;
        if (isEveryoneScope) {
            setEveryone(prev => { const n = new Set(prev); n.has(cap.id) ? n.delete(cap.id) : n.add(cap.id); saveEveryone(n); return n; });
        } else {
            setGroupGrants(prev => {
                const cur = new Set(prev[scope] || []);
                cur.has(cap.id) ? cur.delete(cap.id) : cur.add(cap.id);
                const next = { ...prev, [scope]: cur };
                saveGroup(scope, cur);
                return next;
            });
        }
    };

    // Count of capabilities granted for a scope (for the sidebar badges).
    const grantCount = useCallback((scopeId: string) => {
        if (scopeId === EVERYONE) return everyone.size;
        const own = (groupGrants[scopeId] || new Set()).size;
        return own; // own grants; inherited-from-everyone shown separately
    }, [everyone, groupGrants]);

    const filteredGroups = useMemo(() => {
        const q = groupQuery.trim().toLowerCase();
        return q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
    }, [groups, groupQuery]);

    const capabilitiesByKind = useMemo(() => {
        const map: Record<string, AccessCapability[]> = { core: [], beta: [], integration: [] };
        for (const c of (data?.capabilities || [])) (map[c.kind] || (map[c.kind] = [])).push(c);
        for (const k of Object.keys(map)) map[k].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
        return map;
    }, [data]);

    if (loading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
    if (!data || !data.orgId) {
        return (
            <div className="rounded-2xl p-5 text-sm [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)] [color:var(--text-muted)]!">
                {t('admin_org.access_matrix_no_org', 'Your account is not bound to an organisation, so there is nothing to manage here.')}
            </div>
        );
    }

    const activeGroup = isEveryoneScope ? null : groups.find(g => g.id === scope);
    const scopeAccent = isEveryoneScope ? BLUE : EMERALD;

    const Toggle = ({ checked, readOnly, accent, onToggle }: { checked: boolean; readOnly?: boolean; accent: string; onToggle: () => void }) => (
        <label className={`relative inline-flex items-center flex-shrink-0 ${readOnly ? '[cursor:default]' : '[cursor:pointer]'}`} onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={checked} disabled={readOnly} onChange={onToggle} className="sr-only peer" />
            <div className="w-9 h-5 rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:shadow-sm after:transition-transform peer-checked:after:translate-x-4"
                style={{ background: checked ? accent : 'var(--border-default, #d1d5db)', opacity: readOnly ? 0.55 : 1 }} />
        </label>
    );

    const ScopeButton = ({ id, label, icon, accent, count }: { id: string; label: string; icon: React.ReactNode; accent: string; count: number }) => {
        const active = scope === id;
        return (
            <button onClick={() => setScope(id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors"
                style={{ background: active ? 'var(--bg-primary)' : 'transparent', border: `1px solid ${active ? accent : 'transparent'}` }}>
                <span className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: active ? `${accent}1a` : 'var(--bg-primary)', color: accent }}>{icon}</span>
                <span className="flex-1 min-w-0 truncate text-sm" style={{ color: 'var(--text-primary)', fontWeight: active ? 600 : 400 }}>{label}</span>
                {count > 0 ? <span className="text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0 bg-[var(--bg-secondary)] text-[var(--text-muted)]">{count}</span> : null}
            </button>
        );
    };

    const CapabilityCard = ({ cap }: { cap: AccessCapability }) => {
        const locked = !ceiling.has(cap.id);
        const ro = betaReadOnly(cap);
        let checked: boolean, readOnly: boolean | undefined, inherited: boolean | undefined = false;
        if (isEveryoneScope) {
            checked = ro ? true : everyone.has(cap.id);
            readOnly = ro;
        } else {
            inherited = everyone.has(cap.id) || ro;
            checked = inherited || (groupGrants[scope] || new Set()).has(cap.id);
            readOnly = inherited; // granted to all → group inherits, can't un-inherit here
        }
        const icon = cap.kind === 'integration' ? getIntegrationIcon(cap.id) : <Sparkles className="w-4 h-4" style={{ color: scopeAccent }} />;
        return (
            <div className="flex items-center gap-3 p-3 rounded-xl transition-all"
                style={{ border: `1px solid ${checked && !locked ? scopeAccent : 'var(--border-subtle)'}`, background: checked && !locked ? `${scopeAccent}0a` : 'var(--bg-primary)', opacity: locked ? 0.55 : 1, cursor: locked || readOnly ? 'default' : 'pointer' }}
                onClick={() => !locked && !readOnly && toggle(cap)}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--bg-secondary)]">{icon}</div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate text-[var(--text-primary)]" title={cap.name}>{cap.name}</p>
                        {locked ? <Lock className="w-3 h-3 flex-shrink-0 text-[var(--text-muted)]" /> : null}
                    </div>
                    {inherited && !isEveryoneScope ? (
                        <p className="text-[11px]" style={{ color: BLUE }}>{t('admin_org.access_matrix_granted_all', 'Granted to all members')}</p>
                    ) : cap.description ? (
                        <p className="text-[11px] truncate text-[var(--text-muted)]" title={cap.description}>{cap.description}</p>
                    ) : null}
                </div>
                {locked
                    ? <Lock className="w-4 h-4 flex-shrink-0 [color:var(--text-muted)] [opacity:0.5]" />
                    : <Toggle checked={checked} readOnly={readOnly} accent={scopeAccent} onToggle={() => toggle(cap)} />}
            </div>
        );
    };

    // The save status sits next to the heading, or next to the intro line
    // when the heading is hidden.
    const status = message ? (
        <span className="inline-flex items-center gap-1.5 text-xs shrink-0" style={{ color: message.type === 'ok' ? EMERALD : '#dc2626' }}>
            {message.type === 'ok' ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{message.text}
        </span>
    ) : null;
    const intro = subtitle || (
        <>
            {t('admin_org.access_matrix_pick', 'Pick')} <strong>{t('admin_org.access_matrix_all_members', 'All members')}</strong> {t('admin_org.access_matrix_or_a', 'or a')} <strong>{t('admin_org.access_matrix_group', 'group')}</strong>{t('admin_org.access_matrix_intro_a', ", then grant the features and integrations it should have. A user gets a capability if it's granted to All members")}{' '}
            <em>{t('admin_org.access_matrix_or', 'or')}</em> {t('admin_org.access_matrix_intro_b', 'any group they belong to. Locked items (')}<Lock className="w-3 h-3 inline -mt-0.5" />{t('admin_org.access_matrix_intro_c', ") are outside your organisation's access.")}
        </>
    );

    return (
        <section className="rounded-2xl p-5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
            {hideHeading ? (
                <div className="flex items-start justify-between gap-3 mb-4">
                    <p className="text-sm text-[var(--text-muted)] max-w-[760px]">{intro}</p>
                    {status}
                </div>
            ) : (
                <>
                    <header className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="w-5 h-5" style={{ color: EMERALD }} />
                            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{heading || t('admin_org.access_matrix_heading', 'Access & Permissions')}</h2>
                        </div>
                        {status}
                    </header>
                    <p className="text-sm mb-4 text-[var(--text-muted)] max-w-[760px]">{intro}</p>
                </>
            )}

            <div className="flex flex-col md:flex-row gap-5">
                {/* ── Scope sidebar ───────────────────────────────────── */}
                <div className="md:w-60 flex-shrink-0">
                    <ScopeButton id={EVERYONE} label={t('admin_org.access_matrix_all_members', 'All members')} accent={BLUE} count={grantCount(EVERYONE)} icon={<Users className="w-3.5 h-3.5" />} />
                    <div className="my-2 flex items-center gap-2 px-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t('admin_org.access_matrix_groups', 'Groups')}</span>
                        <span className="text-[11px] text-[var(--text-muted)]">({groups.length})</span>
                    </div>
                    {groups.length > 6 ? (
                        <div className="relative mb-2">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                            <input value={groupQuery} onChange={e => setGroupQuery(e.target.value)} placeholder={t('admin_org.access_matrix_search_groups', 'Search groups…')}
                                className="w-full text-sm rounded-lg pl-8 pr-2 py-1.5 outline-none [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)] [color:var(--text-primary)]!" />
                        </div>
                    ) : null}
                    {groups.length === 0 ? (
                        <p className="text-[12px] px-1 py-2 text-[var(--text-muted)]">
                            {t('admin_org.access_matrix_no_groups_a', 'No groups yet. Create groups under')} <strong>{t('admin_org.access_matrix_users_groups', 'Users & Groups')}</strong> {t('admin_org.access_matrix_no_groups_b', 'to grant capabilities per team.')}
                        </p>
                    ) : (
                        <div className="space-y-0.5 md:max-h-[460px] md:overflow-y-auto pr-1">
                            {filteredGroups.map(g => (
                                <ScopeButton key={g.id} id={g.id} label={g.name} accent={EMERALD} count={grantCount(g.id)} icon={<Users className="w-3.5 h-3.5" />} />
                            ))}
                            {filteredGroups.length === 0 ? <p className="text-[12px] px-2 py-2 text-[var(--text-muted)]">{t('admin_org.access_matrix_no_groups_match', 'No groups match “{query}”.', { query: groupQuery })}</p> : null}
                        </div>
                    )}
                </div>

                {/* ── Capabilities for the selected scope ─────────────── */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: `${scopeAccent}1a`, color: scopeAccent }}><Users className="w-3.5 h-3.5" /></span>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{isEveryoneScope ? t('admin_org.access_matrix_all_members', 'All members') : activeGroup?.name}</h3>
                        {!isEveryoneScope ? <span className="text-[11px] text-[var(--text-muted)]">{t('admin_org.access_matrix_stack', 'grants stack on top of All members')}</span> : null}
                        {data.betaGoverned ? <span className="text-[11px] ml-auto text-[var(--text-muted)]">{t('admin_org.access_matrix_beta_follow', 'Beta features follow your subscription')}</span> : null}
                    </div>
                    {(() => {
                        const sections = KIND_SECTIONS
                            .filter(s => !kinds || kinds.includes(s.kind))
                            .map(section => ({
                                section,
                                caps: (capabilitiesByKind[section.kind] || []).filter(c => !hideLocked || ceiling.has(c.id)),
                            }))
                            .filter(x => x.caps.length > 0);
                        if (sections.length === 0) {
                            return (
                                <p className="text-sm rounded-xl px-4 py-3 [color:var(--text-muted)]! [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                                    {kinds && kinds.length === 1 && kinds[0] === 'integration'
                                        ? t('admin_org.access_matrix_no_integrations', "Your subscription doesn't include any integrations yet.")
                                        : t('admin_org.access_matrix_nothing', 'Nothing to grant here yet.')}
                                </p>
                            );
                        }
                        return sections.map(({ section, caps }) => {
                            const SectionIcon = section.icon;
                            return (
                                <div key={section.kind} className="mb-5">
                                    <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                                        <SectionIcon className="w-3.5 h-3.5" /> {t(section.labelKey, section.label)}
                                    </div>
                                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                                        {caps.map(cap => <CapabilityCard key={cap.id} cap={cap} />)}
                                    </div>
                                </div>
                            );
                        });
                    })()}
                </div>
            </div>
        </section>
    );
}
