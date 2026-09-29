import { CircleSlash } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RunSurface } from './AppRunPage';
import { appDesignProps } from '../../components/admin/Studio/AppStudio/runtime/appDesign';
import AppFontLoader from '../../components/admin/Studio/AppStudio/runtime/AppFontLoader';
import { createPublicAppTransport } from '../../components/admin/Studio/AppStudio/runtime/publicAppTransport';
import { CANVAS_GROUND, themeVars } from '../../components/admin/Studio/AppStudio/runtime/themeVars';
import EmptyState from '../../components/shared/EmptyState';
import { API_BASE, setPublicAppTransport } from '../../utils/helpers';

/**
 * PublicAppPage — the anonymous surface of a Studio app. Route: /p/:token
 * (App.jsx, mounted before any auth handling).
 *
 * The app's owner names ONE entry screen in the definition's `publicAccess`
 * block; the server serves only those screens, only the actions they wire, and
 * only with server step bodies redacted (server/appStudio/publicAccess.js).
 * Everything else about the app — its back-office screens, its nav, its other
 * actions — never reaches this page.
 *
 * ── WHY THE TRANSPORT IS INSTALLED IN A useState INITIALISER ────────
 * The runtime components are the product's real ones and fetch on mount. React
 * runs a useState initialiser during the first render — before any child can
 * mount, let alone fetch — while a useEffect runs after children have already
 * fired theirs. DemoHost installs its transport the same way and for the same
 * reason: a call that escapes before the transport lands is an anonymous
 * request against the authenticated API.
 *
 * The page itself uses BARE fetch, never authFetch: authFetch is exactly what
 * the transport intercepts, and this one call is the one that must reach
 * /api/public-app/:token to get a visitor token in the first place.
 */

/** The visitor identity, kept for the tab's lifetime so a reload mid-form does
 *  not orphan the rows already written under it. sessionStorage, not local:
 *  it dies with the tab, and a shared computer must not hand the next person
 *  the previous visitor's identity. */
function storageKey(token) {
    return `bf.publicApp.visitor.${token}`;
}

function readStoredVisitor(token) {
    try { return window.sessionStorage.getItem(storageKey(token)) || null; } catch { return null; }
}

function storeVisitor(token, visitorToken) {
    try { window.sessionStorage.setItem(storageKey(token), visitorToken); } catch { /* private mode — in-memory is fine */ }
}

function LoadingSkeleton() {
    return (
        <div className="min-h-screen animate-pulse p-6" role="status" aria-label="Laden">
            <div className="mx-auto max-w-[720px] space-y-4">
                <div className="h-7 w-1/2 rounded bg-black/10" />
                <div className="h-28 w-full rounded-lg bg-black/10" />
                <div className="h-44 w-full rounded-lg bg-black/10" />
            </div>
            <span className="sr-only">Laden…</span>
        </div>
    );
}

/**
 * Every not-available reason answers 404 on purpose — revoked, never public,
 * unpublished, unknown token — so there is exactly one thing that can honestly
 * be said here, and a retry button would be a lie.
 */
function NotAvailable({ error, onRetry }) {
    const notFound = error?.status === 404 || error?.message === 'not_found';
    return (
        <div className="min-h-screen flex items-center justify-center p-6">
            <EmptyState
                icon={<CircleSlash className="w-12 h-12" />}
                title={notFound ? 'Deze pagina bestaat niet (meer)' : 'De pagina kon niet worden geladen'}
                description={notFound
                    ? 'De link klopt niet, of hij is ingetrokken. Vraag de afzender om een nieuwe link.'
                    : 'Probeer het over een paar minuten opnieuw.'}
                action={notFound ? undefined : { label: 'Opnieuw proberen', onClick: onRetry, variant: 'secondary' }}
            />
        </div>
    );
}

export default function PublicAppPage({ token }) {
    const [state, setState] = useState({ status: 'loading', payload: null, error: null });
    const [screenId, setScreenId] = useState(null);

    // The live visitor token, read through a ref so the transport installed
    // once below always sees the CURRENT one.
    const visitorRef = useRef(readStoredVisitor(token));

    // Installed during the first render — see the docblock.
    useState(() => {
        setPublicAppTransport(createPublicAppTransport({
            token,
            getVisitorToken: () => visitorRef.current,
        }));
        return null;
    });

    useEffect(() => () => { setPublicAppTransport(null); }, []);

    const load = useCallback(async () => {
        setState({ status: 'loading', payload: null, error: null });
        try {
            // authFetch is exactly what the transport intercepts, so this one call
            // has to reach the network on its own: it is where the visitor token
            // comes from, and every later call is signed with what it returns.
            // eslint-disable-next-line no-restricted-syntax
            const res = await fetch(`${API_BASE}/api/public-app/${encodeURIComponent(token)}`, {
                credentials: 'omit',
                cache: 'no-store',
            });
            if (!res.ok) {
                const err = new Error(res.status === 404 ? 'not_found' : `Request failed (${res.status})`);
                err.status = res.status;
                throw err;
            }
            const payload = await res.json();
            if (payload?.visitorToken) {
                visitorRef.current = payload.visitorToken;
                storeVisitor(token, payload.visitorToken);
            }
            setScreenId(payload?.entryScreenId || payload?.definition?.homeScreenId || null);
            setState({ status: 'ready', payload, error: null });
        } catch (err) {
            setState({ status: 'error', payload: null, error: err });
        }
    }, [token]);

    useEffect(() => { load(); }, [load]);

    const appName = state.payload?.app?.name || null;
    useEffect(() => {
        if (!appName) return undefined;
        const previous = document.title;
        document.title = appName;
        return () => { document.title = previous; };
    }, [appName]);

    // applyThemeToDocument never runs on this page (it is outside the authed
    // shell), so the light/dark ground is stamped here — same as the public
    // form page does.
    useEffect(() => {
        const root = document.documentElement;
        const previous = root.getAttribute('data-theme');
        root.setAttribute('data-theme', 'light');
        return () => {
            if (previous) root.setAttribute('data-theme', previous);
            else root.removeAttribute('data-theme');
        };
    }, []);

    const definition = state.payload?.definition || null;

    if (state.status === 'loading') return <LoadingSkeleton />;
    if (state.status === 'error') return <NotAvailable error={state.error} onRetry={load} />;

    const design = appDesignProps(definition);
    return (
        <div
            className={`min-h-screen${design.className ? ` ${design.className}` : ''}`}
            style={{ ...themeVars(definition?.theme), ...design.style, background: CANVAS_GROUND }}
        >
            <AppFontLoader definition={definition} />
            <RunSurface
                appId={state.payload?.app?.id || null}
                draft={false}
                definition={definition}
                screenId={screenId}
                // No account, no name, no role to preview as. `currentUser`
                // resolves to null in every formula, which is the truth.
                viewer={null}
                onNavigate={setScreenId}
                chrome="bare"
            />
        </div>
    );
}
