// Site/project CRUD (multi-site switcher), site export/import and version
// management of the ProductWebsitePanel container — moved verbatim from
// ProductWebsitePanel.jsx. State stays owned by the panel (threaded in;
// only the transient siteIoStatus lives here, still on the panel's fiber).
import { useCallback, useState } from 'react';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { cmsApi } from '../cmsApi';
import { ACTIVE_SITE_LS_KEY } from './helpers';

export default function useCmsSiteOps({
    activeSiteIdRef, setActiveSiteId, setSites, setLiveSiteId, liveSiteId, sites,
    confirm, builderRunningRef, saveTimerRef, inFlightSaveRef, flushSaves, reloadPayload,
}) {
    // ── site/project CRUD (multi-site switcher) ──────────────────────

    const handleSwitchSite = useCallback(async (newSiteId) => {
        if (!newSiteId || newSiteId === activeSiteIdRef.current) return;
        if (builderRunningRef.current) { toast.error('The AI assistant is editing — press Stop in the assistant to take over.'); return; }
        // Drain any pending debounced saves so the edits land on the
        // CURRENT site before we point future saves at the new one.
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            await flushSaves();
        }
        activeSiteIdRef.current = newSiteId;
        setActiveSiteId(newSiteId);
        try { localStorage.setItem(ACTIVE_SITE_LS_KEY, newSiteId); } catch { /* ignore */ }
    }, [flushSaves, activeSiteIdRef, builderRunningRef, saveTimerRef, setActiveSiteId]);

    const refreshSites = useCallback(async () => {
        const res = await authFetch(cmsApi.listSites());
        if (!res.ok) return [];
        const data = await res.json();
        const list = Array.isArray(data.sites) ? data.sites : [];
        setSites(list);
        // Server clears cms_live_site_id when the live project is deleted —
        // mirror that here so the toggle/indicator stay in sync without a
        // second round-trip.
        setLiveSiteId(data.liveSiteId || null);
        return list;
    }, [setLiveSiteId, setSites]);

    const handleCreateSite = useCallback(async (name) => {
        try {
            const res = await authFetch(cmsApi.createSite(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create site');
            await refreshSites();
            await handleSwitchSite(data.id);
            return data;
        } catch (err) {
            toast.error(`Failed to create site: ${err.message}`);
            return null;
        }
    }, [handleSwitchSite, refreshSites]);

    const handleRenameSite = useCallback(async (siteId, name) => {
        try {
            const res = await authFetch(cmsApi.site(siteId), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || `Rename failed (${res.status})`);
            }
            await refreshSites();
            // If we renamed the active site, refresh its payload so the
            // header/displays pick up the new name.
            if (siteId === activeSiteIdRef.current) await reloadPayload();
        } catch (err) { toast.error(`Rename failed: ${err.message}`); }
    }, [refreshSites, reloadPayload, activeSiteIdRef]);

    // ── Site export / import ────────────────────────────────────────
    // Export streams the server's JSON response into a Blob and uses
    // a temporary <a download> to trigger a file save dialog. We rely
    // on the Content-Disposition filename the server sets — falling
    // back to a generic name if the browser strips it.
    const [siteIoStatus, setSiteIoStatus] = useState(null);   // { kind: 'success'|'error'|'busy', text }

    const handleExportSite = useCallback(async (format = 'zip') => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        setSiteIoStatus({ kind: 'busy', text: 'Exporting…' });
        try {
            const res = await authFetch(cmsApi.siteExport(siteId, format));
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Export failed (${res.status})`);
            }
            const blob = await res.blob();
            // Prefer the server-provided filename from Content-Disposition.
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="?([^";]+)"?/i);
            const filename = match?.[1] || `site-export-${Date.now()}.${format === 'json' ? 'json' : 'zip'}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Revoke the blob URL after a tick — Chrome occasionally
            // discards the download if revoked synchronously.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setSiteIoStatus({ kind: 'success', text: 'Exported' });
            setTimeout(() => setSiteIoStatus(null), 2400);
        } catch (err) {
            setSiteIoStatus({ kind: 'error', text: err.message || 'Export failed' });
        }
    }, [activeSiteIdRef]);

    // Two wire formats share one picker:
    //   .zip   the complete backup — bundle + image bytes. Posted as
    //          multipart; the server unpacks and validates it (we can't
    //          usefully pre-check a zip in the browser, and doing so would
    //          just duplicate the server's guards).
    //   .json  the bundle alone. Kept because every export downloaded
    //          before the zip existed is one of these — and the cheap
    //          client-side marker check gives a far better error than a
    //          round-trip for the common "wrong file" mistake.
    const handleImportFileChosen = useCallback(async (file) => {
        if (!file) return;
        if (builderRunningRef.current) { toast.error('The AI assistant is editing — press Stop in the assistant to take over.'); return; }
        const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip';
        setSiteIoStatus({ kind: 'busy', text: 'Importing…' });

        let request;
        if (isZip) {
            const form = new FormData();
            form.append('file', file, file.name || 'site.zip');
            request = { method: 'POST', body: form };   // no Content-Type — the browser sets the boundary
        } else {
            let payload;
            try {
                payload = JSON.parse(await file.text());
            } catch {
                setSiteIoStatus({ kind: 'error', text: 'Selected file is not a .zip or valid JSON' });
                return;
            }
            if (!payload || payload._beeflow_export !== true) {
                setSiteIoStatus({ kind: 'error', text: 'Not a Bee Flow site export file' });
                return;
            }
            request = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            };
        }

        try {
            const res = await authFetch(cmsApi.importSite(), request);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
            // Refresh the sidebar list and switch to the newly-created site.
            await refreshSites();
            if (data.siteId) await handleSwitchSite(data.siteId);

            // Report what actually came across. A silent "Imported" hides the
            // two things an operator most needs to know: which languages
            // arrived, and whether any images did not.
            const parts = [];
            if (data.locales?.length) parts.push(`${data.locales.length + 1} language(s)`);
            if (data.assetsWritten) parts.push(`${data.assetsWritten} file(s)`);
            if (data.dropped > 0) parts.push(`${data.dropped} block(s) skipped (unrecognized type)`);
            const warnings = Array.isArray(data.warnings) ? data.warnings : [];
            const detail = parts.length ? ` — ${parts.join(', ')}` : '';
            const bad = data.dropped > 0 || warnings.length > 0;
            setSiteIoStatus({
                kind: bad ? 'error' : 'success',
                text: `Imported "${data.name || 'site'}"${detail}`,
            });
            for (const w of warnings.slice(0, 3)) toast.error(w);
            setTimeout(() => setSiteIoStatus(null), bad ? 6000 : 2400);
        } catch (err) {
            setSiteIoStatus({ kind: 'error', text: err.message || 'Import failed' });
        }
    }, [handleSwitchSite, refreshSites, builderRunningRef]);

    // Receives the full site object from SiteSwitcher (which no longer
    // confirms itself) — the shared ConfirmDialog names what's deleted.
    const handleDeleteSite = useCallback(async (siteOrId) => {
        const siteId = typeof siteOrId === 'string' ? siteOrId : siteOrId?.id;
        if (!siteId) return;
        const name = typeof siteOrId === 'object' ? siteOrId?.name : sites.find(s => s.id === siteId)?.name;
        const ok = await confirm({
            title: `Delete site "${name || 'this site'}"?`,
            description: 'This permanently removes all of its pages, blocks, and content.',
            confirmLabel: 'Delete site',
            destructive: true,
        });
        if (!ok) return;
        try {
            const res = await authFetch(cmsApi.site(siteId), { method: 'DELETE' });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || `Delete failed (${res.status})`);
            }
            const list = await refreshSites();
            if (siteId === activeSiteIdRef.current) {
                // Active site was just removed — switch to the first
                // remaining site, or clear if none are left.
                const next = list[0]?.id || null;
                if (next) {
                    await handleSwitchSite(next);
                } else {
                    activeSiteIdRef.current = null;
                    setActiveSiteId(null);
                    try { localStorage.removeItem(ACTIVE_SITE_LS_KEY); } catch { /* ignore */ }
                }
            }
        } catch (err) { toast.error(`Failed to delete site: ${err.message}`); }
    }, [handleSwitchSite, refreshSites, sites, confirm, activeSiteIdRef, setActiveSiteId]);

    // ── version management (multi-version per site) ──────────────────
    //
    // A "version" is a full site that shares a versionGroupId with its
    // siblings. Duplicating deep-copies the active site into a new
    // version of the same group; switching versions is just a site
    // switch under the hood.

    // Duplicate the active site into a new version. Pending edits are
    // flushed first so the copy captures the latest content, then the
    // editor switches to the freshly-created version.
    const handleDuplicateSite = useCallback(async () => {
        const siteId = activeSiteIdRef.current;
        if (!siteId) return;
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        if (inFlightSaveRef.current) {
            try { await inFlightSaveRef.current; } catch { /* surfaced already */ }
            inFlightSaveRef.current = null;
        }
        await flushSaves();
        try {
            const res = await authFetch(cmsApi.siteDuplicate(siteId), { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Duplicate failed (${res.status})`);
            await refreshSites();
            if (data.id) await handleSwitchSite(data.id);
        } catch (err) { toast.error(`Failed to duplicate version: ${err.message}`); }
    }, [flushSaves, refreshSites, handleSwitchSite, activeSiteIdRef, inFlightSaveRef, saveTimerRef]);

    // Make a specific version live. Only one site is live at a time
    // (cms_live_site_id), so this takes the previously-live one — sibling
    // or otherwise — offline. Optimistic with rollback on failure.
    const handleSetLiveVersion = useCallback(async (siteId) => {
        if (!siteId || siteId === liveSiteId) return;
        // Same consequence as the Live toggle: making a version live takes
        // the currently-live site/version offline — confirm when one exists.
        if (liveSiteId) {
            const current = sites.find(s => s.id === liveSiteId);
            const next = sites.find(s => s.id === siteId);
            const ok = await confirm({
                title: 'Switch the live version?',
                description: `"${current?.versionName || current?.name || 'The current version'}" is live right now. Visitors will see "${next?.versionName || next?.name || 'the selected version'}" instead.`,
                confirmLabel: 'Set live',
            });
            if (!ok) return;
        }
        const prevLive = liveSiteId;
        setLiveSiteId(siteId);
        try {
            const res = await authFetch(cmsApi.siteLive(siteId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ live: true }),
            });
            if (!res.ok) throw new Error(`Failed to set version live (${res.status})`);
        } catch (err) {
            toast.error(err.message);
            setLiveSiteId(prevLive);
        }
    }, [liveSiteId, sites, confirm, setLiveSiteId]);

    return {
        siteIoStatus, handleSwitchSite, handleCreateSite, handleRenameSite,
        handleExportSite, handleImportFileChosen, handleDeleteSite,
        handleDuplicateSite, handleSetLiveVersion,
    };
}
