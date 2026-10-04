import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * Thin JSON client for `/api/webpages`. Shared by the list shell
 * (pages/WebpagesPage.jsx), the editor (WebpageEditorPage.jsx) and the save
 * hook (hooks/useWebpageSave.js). Module-level so hooks can list it as a
 * stable dependency.
 *
 *   api('/')                → GET  /api/webpages
 *   api('/<id>')            → GET  /api/webpages/<id>
 *   api('/<id>', { method: 'PUT', body: JSON.stringify(x) })
 *
 * A string body gets `Content-Type: application/json`; FormData bodies are
 * passed through untouched. Non-2xx responses throw `Error(data.error || 'API <status>')`.
 *
 * ── THE FAILURE CARRIES ITS BODY ────────────────────────────────────
 * The thrown error keeps `.status`, `.code` and `.body`, the convention
 * `datatablesApi` and `transcriptionsApi` already follow. It is not
 * bookkeeping: a 409 from the delete guard carries the LIST of what still
 * uses the page and the kinds it could not check, and
 * `shared/DangerZone.jsx` reads exactly that off `err.body` to re-show the
 * list instead of a bare red line. A `new Error(message)` that drops the
 * payload is why the meeting delete could not talk to the shared danger zone
 * at all. `.message` is unchanged, so every existing caller reads the same
 * sentence it did before.
 */
export async function api(path, opts = {}) {
    const url = `${API_BASE}/api/webpages${path === '/' ? '' : path}`;
    const res = await authFetch(url, {
        headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
        ...opts,
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data?.error || `API ${res.status}`);
        err.status = res.status;
        err.code = data?.code || null;
        err.body = data;
        throw err;
    }
    return res.json();
}

/**
 * Delete a webpage.
 *
 * The server refuses the first time with `409 {code:'in_use', usage,
 * unchecked}` whenever something still holds this page — and just as firmly
 * when it could not CHECK one of the kinds, which is a different answer and
 * is not treated as "nothing". `confirmedBreaking` is the second press, after
 * the person has been shown that: it becomes `?confirm=1`, the only thing
 * that gets past the guard, and the server then skips the scan rather than
 * running it again.
 */
export async function deleteWebpage(id, { confirmedBreaking = false } = {}) {
    return api(`/${id}${confirmedBreaking ? '?confirm=1' : ''}`, { method: 'DELETE' });
}

/**
 * Fetch one extra file's content in the shape the editor keeps in
 * `extraContents[path]`: `{ mimeType, isText, content }` for text files,
 * `{ mimeType, isText: false, dataUrl }` for binaries.
 */
export async function fetchExtraContent(webpageId, meta) {
    const r = await api(`/${webpageId}/files?path=${encodeURIComponent(meta.path)}`);
    if (r?.contentBase64) {
        return { mimeType: meta.mimeType, isText: false, dataUrl: `data:${meta.mimeType};base64,${r.contentBase64}` };
    }
    return { mimeType: meta.mimeType, isText: true, content: r?.content || '' };
}

/**
 * Load everything the editor needs for one page in a single bundle:
 *
 *   { webpage, sources, files: { html, css, js }, chatMessages, extraFiles, extraContents }
 *
 * `extraContents` is hydrated best-effort — a single failing file is skipped
 * (the preview works without it, it just won't inline that asset). The
 * editor mounts once per bundle (keyed on `webpage.id`) so its save
 * discipline starts from a clean, "already saved" snapshot.
 */
export async function fetchWebpageBundle(id) {
    const { webpage: row, sources, files, chatMessages, extraFiles, managed } = await api(`/${id}`);
    // The GET carries `managed` beside the row; every holder of the row (the
    // header, the IDE) reads it from the row.
    const webpage = managed !== undefined && row ? { ...row, managed } : row;
    const extrasList = Array.isArray(extraFiles) ? extraFiles : [];
    const extraContents = {};
    await Promise.all(extrasList.map(async (meta) => {
        try {
            extraContents[meta.path] = await fetchExtraContent(id, meta);
        } catch { /* ignore single-file failures */ }
    }));
    return {
        webpage,
        sources: Array.isArray(sources) ? sources : [],
        files: { html: files?.html || '', css: files?.css || '', js: files?.js || '' },
        chatMessages: Array.isArray(chatMessages) ? chatMessages : [],
        extraFiles: extrasList,
        extraContents,
    };
}

export default api;
