import { useEffect, useState } from 'react';
import { authFetch } from '../../utils/helpers';

/**
 * One remote list, with the difference between "none" and "could not read"
 * kept.
 *
 * Every Solutions screen loads lists that can genuinely be empty — the tables
 * an installer may pick, the people to share with, the Blueprints kept on this
 * instance, the Solutions themselves. Each of those, read with a plain
 * `useState([])` and a `catch {}`, renders a failure exactly like an empty
 * answer, and a silent empty list teaches somebody their organisation has none.
 * So the status is part of the answer here rather than something each caller
 * remembers to keep.
 *
 * `enabled` defers the fetch until the screen that needs it is open — the
 * install wizard asks four different services and most installs never reach its
 * third step.
 *
 * Statuses: `idle` (not asked), `loading` (asked, no answer yet), `ok`
 * (`data` is the parsed body), `error` (asked and it did not work — `data`
 * stays null so a caller cannot accidentally render a half-answer).
 */
export async function readJson(res) {
    try { return await res.json(); } catch { return null; }
}

export default function useRemote(url, enabled) {
    const [state, setState] = useState({ key: null, status: 'idle', data: null });
    useEffect(() => {
        if (!enabled || !url) return undefined;
        let stopped = false;
        (async () => {
            try {
                const res = await authFetch(url);
                const body = await readJson(res);
                if (stopped) return;
                setState({ key: url, status: res.ok ? 'ok' : 'error', data: res.ok ? body : null });
            } catch {
                if (!stopped) setState({ key: url, status: 'error', data: null });
            }
        })();
        return () => { stopped = true; };
    }, [url, enabled]);
    // The answer belongs to a URL. Deriving "this one has not answered yet"
    // rather than writing it in the effect keeps the PREVIOUS url's data from
    // being shown for a frame under the new url's label — and a state write in
    // an effect body is a cascading render besides.
    if (!enabled || !url) return { status: 'idle', data: null };
    return state.key === url ? state : { status: 'loading', data: null };
}
