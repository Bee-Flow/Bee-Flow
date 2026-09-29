import { Globe } from 'lucide-react';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import WebpageDeleteDialog from './webpages/WebpageDeleteDialog';
import WebpageEditorPage from './webpages/WebpageEditorPage';
import { api, fetchWebpageBundle } from './webpages/webpagesApi';
import WebpagesList from './webpages/WebpagesList';
import { useCan } from '../components/licensing/Gate';
import { RequireTier } from '../components/licensing/LicenseContext';
import useTranslation from '../hooks/useTranslation';
import { API_BASE, authFetch } from '../utils/helpers';

/**
 * The URL segment Studio's "New → Webpage" launcher navigates to
 * (studioApps.jsx `create.onCreate`). Reserved: no webpage can have this id,
 * and the deep-link effect below reads it as "open the list ready to create".
 */
export const NEW_WEBPAGE_ID = 'new';

/**
 * WebpagesPage — the Studio "Webpages" section shell (Track W0 split).
 *
 * Owns what outlives one open page: the list rows, the create/clone/delete/
 * rename requests, the chat model tier and the org groups. Loading a page
 * fetches its whole bundle first (`fetchWebpageBundle`) and only then swaps
 * the list for `<WebpageEditorPage key={id}>`, so the editor always mounts
 * on complete, already-saved content and the card keeps its spinner until
 * the page is really there.
 *
 * Save discipline across the boundary: before a different page is loaded
 * and before the editor is closed, the shell flushes the OUTGOING page via
 * `flushRef` (the editor's `flushNow`); the editor's unmount then cancels
 * its timer and aborts its page-scoped mutations.
 */
function WebpagesPageInner({ user, onBack, initialWebpageId, onWebpageChange, embedded = false }) {
    // Drive UI gating from the SAME unified entitlements snapshot the server's
    // requireCapability('webpages') enforces (EntitlementsContext) — so this
    // inner gate, the outer RequireTier, and the /api/webpages API never diverge.
    const canUseWebpages = useCan('webpages');
    const { t } = useTranslation();
    const [orgGroups, setOrgGroups] = useState([]);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/groups`);
                if (res.ok) setOrgGroups(await res.json());
            } catch { /* ignore */ }
        })();
    }, []);

    /* ── Model tiers (shell-owned so the choice survives opening another page) ── */
    const [modelTiers, setModelTiers] = useState({});
    const [selectedTier, setSelectedTier] = useState('fast');
    useEffect(() => {
        authFetch(`${API_BASE}/ai/config/chat-models`)
            .then(r => r.ok ? r.json() : {})
            .then(data => setModelTiers(data))
            .catch(e => console.warn('[WebpagesPage] load model tiers failed', e));
    }, []);

    const [webpages, setWebpages] = useState([]);
    const [loading, setLoading] = useState(true);
    // Which list-card's fetch is in flight — the list view doesn't switch to
    // the editor until the bundle resolves, so without this a click on a slow
    // network looked like nothing happened.
    const [loadingWebpageId, setLoadingWebpageId] = useState(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [error, setError] = useState(null);

    // The open page: its loaded bundle + whether it opened in the IDE.
    const [loaded, setLoaded] = useState(null);
    const [editMode, setEditMode] = useState(false);
    // Latest flushNow() of the mounted editor, so the shell can flush the
    // OUTGOING page before its editor unmounts.
    const flushRef = useRef(null);

    /* ── Fetch webpages list ─────────────────────────────────── */
    const fetchWebpages = useCallback(async () => {
        try {
            setLoading(true);
            const data = await api('/');
            setWebpages(data.webpages || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { if (canUseWebpages) fetchWebpages(); }, [fetchWebpages, canUseWebpages]);

    /* ── Load a webpage (deep-link or click) ─────────────────── */
    const loadWebpage = useCallback(async (id, { edit = false } = {}) => {
        setLoadingWebpageId(id);
        // Flush the OUTGOING page's pending edits before we replace it, so
        // manual edits made within the save debounce window aren't lost on a
        // fast page switch. flushNow() captures its snapshot synchronously and
        // no-ops when nothing is dirty. Never let a flush failure block the load.
        try { await flushRef.current?.(); } catch { /* best-effort flush */ }
        try {
            const bundle = await fetchWebpageBundle(id);
            setEditMode(edit);
            setLoaded(bundle);
            setLoadingWebpageId(null);
            onWebpageChange?.(id);
        } catch (err) {
            setError(err.message);
            setLoadingWebpageId(null);
        }
    }, [onWebpageChange]);

    // Deep-link: load the webpage in the URL directly by id. Do NOT gate on it
    // being present in the fetched (capped) accessible list — pages outside that
    // list never opened even though the server can serve them by id, so opening
    // another user's correctly-shared page failed (BFSF-187). loadWebpage()
    // surfaces a visible error if the id isn't accessible.
    //
    // `NEW_WEBPAGE_ID` is the exception: Studio's "New → Webpage" launcher
    // navigates to studio/webpages/new because this section asks for a name
    // first (studioApps.jsx). It is a cue to STAY on the list, not an id —
    // loading it hit GET /api/webpages/new and painted a 404 banner over the
    // create form the user was sent here to use.
    const didAutoSelect = useRef(false);
    useEffect(() => {
        if (!initialWebpageId || initialWebpageId === NEW_WEBPAGE_ID || didAutoSelect.current) return;
        didAutoSelect.current = true;
        loadWebpage(initialWebpageId);
    }, [initialWebpageId, loadWebpage]);

    const handleClose = useCallback(() => {
        // Fire-and-forget: the editor captured its snapshot synchronously and
        // the PUT outlives the unmount; onSaved bumps the row by id.
        try {
            const p = flushRef.current?.();
            if (p && typeof p.catch === 'function') p.catch(e => console.warn('[WebpagesPage] close-flush persist failed', e));
        } catch (e) { console.warn('[WebpagesPage] close-flush persist failed', e); }
        setLoaded(null);
        onWebpageChange?.(null);
    }, [onWebpageChange]);

    /* ── Row bookkeeping the editor reports back ─────────────── */
    const handleSaved = useCallback((id) => {
        setWebpages(prev => prev.map(w => w.id === id ? { ...w, updatedAt: new Date().toISOString() } : w));
    }, []);
    const handleMetaChange = useCallback((id, patch) => {
        setWebpages(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w));
    }, []);

    /* ── CRUD handlers ───────────────────────────────────────── */
    const handleCreate = async (e) => {
        e?.preventDefault?.();
        const trimmed = newName.trim();
        if (!trimmed) return;
        setCreating(true);
        try {
            const { webpage } = await api('/', {
                method: 'POST',
                body: JSON.stringify({ name: trimmed }),
            });
            setNewName('');
            setWebpages(prev => [webpage, ...prev]);
            await loadWebpage(webpage.id);
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    };

    const handleClone = async (id) => {
        const source = webpages.find(w => w.id === id);
        // Localized prefix client-side so the new name matches the user's
        // language without the server having to know the locale. Falls back
        // to the server's "Copy of …" default when source isn't found.
        //
        // Dit stond hier hardgecodeerd in het NEDERLANDS in een Engelstalige
        // UI — en het is geen label maar DATA: de naam gaat via POST /:id/clone
        // de rij in, dus een latere vertaalronde repareert de bestaande pagina's
        // niet meer. Vandaar t() met een Engelse fallback.
        const cloneName = source
            ? t('webpages.copy_of', 'Copy of {name}', { name: source.name || '' })
            : undefined;
        try {
            const { webpage } = await api(`/${id}/clone`, {
                method: 'POST',
                body: JSON.stringify({ name: cloneName }),
            });
            setWebpages(prev => [webpage, ...prev]);
        } catch (err) {
            setError(err.message);
        }
    };

    /**
     * Delete goes through WebpageDeleteDialog, not `confirm()` (W5 deel C).
     *
     * The browser prompt asked "are you sure?" about a page that a Solution
     * may have taken into a screen and an agent may be allowed to open —
     * a question the person had no way to answer. The dialog answers it
     * first, with the same list the Used-by tab shows, and the server keeps
     * its own 409 guard behind it either way.
     *
     * The shell only holds WHICH page is pending; the dialog owns the usage
     * fetch, the confirmation and the request.
     */
    const [pendingDelete, setPendingDelete] = useState(null);
    const handleDelete = (id) => {
        const row = webpages.find(w => w.id === id);
        // No row means the list and the click disagree — nothing to name in
        // the dialog, so leave the page alone rather than delete blind.
        if (!row) return;
        setPendingDelete(row);
    };
    const handleDeleted = useCallback((id) => {
        setPendingDelete(null);
        setWebpages(prev => prev.filter(w => w.id !== id));
        // Deleting the page that is open would leave the editor on a row the
        // server no longer has.
        setLoaded(prev => (prev?.webpage?.id === id ? null : prev));
    }, []);

    const handleRename = async (id, name) => {
        try {
            await api(`/${id}`, { method: 'PUT', body: JSON.stringify({ name }) });
            setWebpages(prev => prev.map(w => w.id === id ? { ...w, name } : w));
        } catch (err) {
            setError(err.message);
        }
    };

    if (!canUseWebpages) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md p-6 rounded-2xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}>
                    <Globe className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-tertiary)' }} />
                    <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Webpages disabled</h3>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Webpages isn't enabled for your account. Ask an admin to enable Webpages for your organization, and verify your plan includes it.
                    </p>
                </div>
            </div>
        );
    }

    const deleteDialog = pendingDelete ? (
        <WebpageDeleteDialog
            webpage={pendingDelete}
            currentUserId={user?.id || null}
            onClose={() => setPendingDelete(null)}
            onDeleted={handleDeleted}
        />
    ) : null;

    if (!loaded) {
        return (
            <>
            {deleteDialog}
            <WebpagesList
                webpages={webpages}
                loading={loading}
                loadingWebpageId={loadingWebpageId}
                error={error}
                onDismissError={() => setError(null)}
                newName={newName}
                onNewNameChange={setNewName}
                creating={creating}
                onCreate={handleCreate}
                onOpen={(id) => loadWebpage(id, { edit: false })}
                onEdit={(id) => loadWebpage(id, { edit: true })}
                onClone={handleClone}
                onDelete={handleDelete}
                onRename={handleRename}
                embedded={embedded}
                onBack={onBack}
            />
            </>
        );
    }

    return (
        <>
        {deleteDialog}
        <WebpageEditorPage
            key={loaded.webpage.id}
            loaded={loaded}
            user={user}
            orgGroups={orgGroups}
            modelTiers={modelTiers}
            selectedTier={selectedTier}
            onTierChange={setSelectedTier}
            initialEditMode={editMode}
            onClose={handleClose}
            onSaved={handleSaved}
            onMetaChange={handleMetaChange}
            flushRef={flushRef}
        />
        </>
    );
}

// Licence-gated wrapper. A session without `webpages` sees the upgrade panel
// instead of a WebpagesPage that would 403 on every /api/webpages request.
// Personal webpages are Community since the enterprise split (2026-10), so on
// a Community install this passes; SHARING a page (`webpage_sharing`) is
// locked inside the editor, on the controls that add an audience
// (webpages/webpageSharingLock.ts).
export default function WebpagesPage(props) {
    return (
        <RequireTier feature="webpages">
            <WebpagesPageInner {...props} />
        </RequireTier>
    );
}
