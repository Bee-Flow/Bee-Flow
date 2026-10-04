import { useEffect, useState } from 'react';

/**
 * The automation's public form page, fetched ONLY once a run is actually parked
 * on a form (design 1d's "Open the form" action on the run banner).
 *
 * Lazy on purpose: `/automations/:id/forms` is a real request, and every
 * canvas that has never paused on a form has no use for the answer. It is also
 * fetched at most once per automation per pause — the URL of a provisioned form
 * page does not change while you watch a run.
 *
 * Never PROVISIONS one: an automation whose form page has not been created yet
 * has no address to open, and creating one as a side effect of watching a run
 * would mint a public URL nobody asked for. The banner simply omits the button.
 *
 * @param {object} api          useAutomationApi()
 * @param {string} automationId the saved automation's id (null before first save)
 * @param {boolean} waiting     a run is parked on a form right now
 * @returns {string|null} the form's URL, or null
 */
export default function useWaitingFormUrl(api, automationId, waiting) {
    const [url, setUrl] = useState(null);

    // The id the current `url` belongs to. A different automation must not
    // inherit the previous one's form link for a render.
    const [forId, setForId] = useState(null);

    useEffect(() => {
        if (!waiting || !automationId || !api?.listFormPages) return undefined;
        if (forId === automationId) return undefined;
        let alive = true;
        (async () => {
            try {
                const listed = await api.listFormPages(automationId);
                if (!alive) return;
                const first = (listed?.forms || []).find(f => f?.url);
                setUrl(first?.url || null);
                setForId(automationId);
            } catch {
                // A banner action is never worth an error surface: without a
                // URL the button is simply not offered.
                if (alive) { setUrl(null); setForId(automationId); }
            }
        })();
        return () => { alive = false; };
    }, [api, automationId, waiting, forId]);

    return forId === automationId ? url : null;
}
