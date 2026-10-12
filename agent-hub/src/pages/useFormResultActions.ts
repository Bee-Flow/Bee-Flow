import { useCallback, type RefObject } from 'react';
import { resultFilename, saveBlob } from '../components/forms/resultFile';

type ResultAction = () => Promise<void>;

interface Options {
    /** The form's own API base: `${VITE_API_URL}/api/automation/form`. */
    api: string;
    token: string;
    /** The journey's session id, kept after the closing page drops it from the URL. */
    sessionRef: RefObject<string | null>;
    /** The closing page; its title names the downloaded file. */
    ending: { title?: string | null } | null | undefined;
    authenticated: boolean;
    webpagesEnabled: boolean;
}

/**
 * The closing page's server-side result actions (BFSF-419): Word/PDF,
 * Save to Notebook and Save as Webpage, all on the closing page's OWN TEXT
 * rather than a generated file. The server reads that text back from the run,
 * so nothing but the session rides along: the visitor keeps exactly what
 * their journey produced.
 *
 * Bare `fetch`, not authFetch, like the rest of PublicFormPage: the page is
 * built to work for an anonymous visitor too. That is also why each action is
 * `null` when the visitor may not use it — the export bar's "no handler ⇒ no
 * button" rule hides it instead of wiring one that can only 401.
 */
export default function useFormResultActions({ api, token, sessionRef, ending, authenticated, webpagesEnabled }: Options): {
    saveToNotebook: ResultAction | null;
    saveAsWebpage: ResultAction | null;
    downloadAs: ((format: 'docx' | 'pdf') => Promise<void>) | null;
} {
    const resultUrl = useCallback((path: string) => {
        const sid = sessionRef.current;
        if (!sid) throw new Error('This result is no longer available.');
        return `${api}/${encodeURIComponent(token)}/s/${encodeURIComponent(sid)}/${path}`;
    }, [api, token, sessionRef]);

    /** POST, then go to what was made. A hard navigation: this page has no router of its own. */
    const saveTo = useCallback(async (path: string, idKey: string, appPath: string, failure: string) => {
        const r = await fetch(resultUrl(path), { method: 'POST', headers: { Accept: 'application/json' } });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body?.[idKey]) throw new Error(body?.error || failure);
        window.location.href = `${appPath}/${body[idKey]}`;
    }, [resultUrl]);

    const saveToNotebook = useCallback(
        () => saveTo('notebook', 'notebookId', '/app/studio/documents/notebook', 'Could not save this to Notebooks.'),
        [saveTo],
    );
    const saveAsWebpage = useCallback(
        () => saveTo('webpage', 'webpageId', '/app/studio/webpages', 'Could not save this as a webpage.'),
        [saveTo],
    );

    /** Word or PDF, rendered by the server from the run's result, handed over as a Blob. */
    const downloadAs = useCallback(async (format: 'docx' | 'pdf') => {
        const r = await fetch(resultUrl(`export/${format}`));
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body?.error || 'Could not create this file.');
        }
        saveBlob(await r.blob(), resultFilename(ending?.title, format));
    }, [resultUrl, ending]);

    return {
        saveToNotebook: authenticated ? saveToNotebook : null,
        saveAsWebpage: authenticated && webpagesEnabled ? saveAsWebpage : null,
        downloadAs: authenticated ? downloadAs : null,
    };
}
