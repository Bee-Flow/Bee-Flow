import { useEffect, useState } from 'react';
import { settingsShellApi } from '../../../api/settingsShellApi';
import type { MemoryStats } from '../../../components/knowledge/memory/memoryTypes';
import type { PreferencesAgent } from '../PreferencesSection.types';
import type { SettingsStatuses, SettingsUser } from './settingsShellTypes';

type StatsStatus = 'loading' | 'ok' | 'error';

/** The memory counters, the agent list, the integration statuses and whether the org has locked its sign-in method. */
export function useSettingsData(user: SettingsUser | null | undefined, canSeeOrg: boolean) {
    const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
    // loading | ok | error — MemorySection must never paint a zero for a
    // pending or failed fetch (see its header comment).
    const [memoryStatsStatus, setMemoryStatsStatus] = useState<StatsStatus>('loading');
    const [agents, setAgents] = useState<PreferencesAgent[]>([]);
    const [statuses, setStatuses] = useState<SettingsStatuses>({
        hasFirefliesKey: false, hasYouTrackConfig: false, hasGammaKey: false, hasAfasConfig: false,
        hasVplanConfig: false, hasScalewayBillingConfig: false,
        hasNmbrsConfig: false, nmbrsApiMode: 'soap', nmbrsSubdomain: '', nmbrsEmail: '', nmbrsEnv: 'production',
        hasSignRequestConfig: false,
        linkedInConnected: false, linkedInName: null, hasLinkedInConfig: false,
        hasNextcloudAppPassword: false, isNextcloudUser: false,
        githubConnected: false,
    });
    // Whether this org has already locked in its sign-in method. Once locked,
    // the "Sign-in Method" sidebar entry is hidden — the panel is a one-time
    // choice and adds no value after the fact.
    const [orgAuthLocked, setOrgAuthLocked] = useState(false);

    const fetchAgents = async () => {
        try { const res = await settingsShellApi.agents(); setAgents(await res.json()); }
        catch (err) { console.error('Failed to fetch agents:', err); }
    };
    const fetchMemoryStats = async () => {
        // A refetch with stats already on screen (after import, after the
        // panel closes) updates silently; only a first load or a retry after
        // an error shows the placeholder.
        setMemoryStatsStatus(prev => (prev === 'ok' ? 'ok' : 'loading'));
        try {
            const res = await settingsShellApi.memoryStats();
            if (!res.ok) { setMemoryStatsStatus('error'); return; }
            const data = await res.json();
            setMemoryStats(data);
            setMemoryStatsStatus('ok');
        } catch (err) {
            console.error('Failed to fetch memory stats:', err);
            setMemoryStatsStatus('error');
        }
    };
    const fetchOrgAuthLocked = async () => {
        if (!canSeeOrg) return;
        try {
            const res = await settingsShellApi.organizations();
            if (!res.ok) return;
            const orgs = await res.json();
            const myOrg = user?.organizationId
                ? orgs.find((o: { id?: string }) => o.id === user.organizationId)
                : orgs[0];
            setOrgAuthLocked(!!myOrg?.authMethod);
        } catch (e) { /* non-critical */ }
    };
    const fetchSettingsStatuses = async () => {
        // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed status fetch; nothing reaches another user or a response
        try {
            const res = await settingsShellApi.userSettings();
            if (res.ok) {
                const data = await res.json();
                // A merge: the LinkedIn, Nextcloud and GitHub fields below come
                // from their own calls and must survive this one.
                setStatuses(p => ({ ...p, hasFirefliesKey: !!data.hasFirefliesKey, hasYouTrackConfig: !!data.hasYouTrackConfig, hasSignRequestConfig: !!data.hasSignRequestConfig, hasGammaKey: !!data.hasGammaKey, hasAfasConfig: !!data.hasAfasConfig, hasVplanConfig: !!data.hasVplanConfig, hasScalewayBillingConfig: !!data.hasScalewayBillingConfig, hasNmbrsConfig: !!data.hasNmbrsConfig, nmbrsApiMode: data.nmbrsApiMode || 'soap', nmbrsSubdomain: data.nmbrsSubdomain || '', nmbrsEmail: data.nmbrsEmail || '', nmbrsEnv: data.nmbrsEnv || 'production', hasLinkedInConfig: !!data.hasLinkedInConfig }));
            }
        } catch (e) { console.error(e); }
        try {
            const liRes = await settingsShellApi.linkedinStatus();
            if (liRes.ok) { const d = await liRes.json(); setStatuses(p => ({ ...p, linkedInConnected: !!d.connected, linkedInName: d.name })); }
        } catch (e) { }
        try {
            const ncRes = await settingsShellApi.appPasswordStatus();
            if (ncRes.ok) { const d = await ncRes.json(); setStatuses(p => ({ ...p, hasNextcloudAppPassword: !!d.hasAppPassword, isNextcloudUser: !!d.isNextcloudUser, nextcloudUrl: d.nextcloudUrl || '' })); }
        } catch (e) { }
        // GitHub Sync menu item is hidden until the org-admin connects a
        // GitHub account in Settings → Connections. The org-sync panel
        // itself prompts for that step, but there's no point exposing the
        // sub-tab to admins who haven't reached integration setup yet.
        try {
            const ghRes = await settingsShellApi.githubStatus();
            if (ghRes.ok) { const d = await ghRes.json(); setStatuses(p => ({ ...p, githubConnected: !!d.connected })); }
        } catch (e) { }
    };

    useEffect(() => { fetchMemoryStats(); fetchAgents(); fetchSettingsStatuses(); fetchOrgAuthLocked(); }, []);

    return { memoryStats, memoryStatsStatus, agents, statuses, orgAuthLocked, fetchMemoryStats, fetchSettingsStatuses };
}
