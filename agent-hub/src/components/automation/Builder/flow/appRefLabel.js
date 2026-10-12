import { useEffect, useEffectEvent, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { appRefParam, parseAppRefParam } from '../../../admin/Studio/studioRoutes';

/**
 * "Which button, in which screen, of which app" — resolved for the person
 * looking at the builder.
 *
 * An automation made from a button in App Studio carries a back-pointer on its
 * trigger (`trigger.appRef = { appId, screenId, nodeId }`), and a link into
 * the builder can carry the same three ids as `?from=app:…`. Two places show
 * them: the breadcrumb strip above the canvas and the trigger card on it.
 *
 * ── Why this is a REQUEST and not three strings in the URL ────────────────
 * The names are not the client's to invent. Two questions are answered
 * server-side, per viewer, and neither one can be guessed here:
 *
 *   may this person be told the name?  — an app the viewer does not own
 *                                        yields ids only, and no link: a link
 *                                        that lands on 403 is worse than no
 *                                        link, and a name they were not
 *                                        allowed to read is a leak.
 *   do the ids still point anywhere?   — the app or the screen may be gone,
 *                                        and that is something the card has to
 *                                        SAY, not something it may silently
 *                                        render as a nameless trigger.
 *
 * See server/appStudio/appRefLookup.js for the five outcomes.
 *
 * ── Why a module cache instead of the layout's nameMaps threading ─────────
 * flow/layout.js threads datatable/KB names down through node `data` because a
 * canvas can hold twenty datatable cards and twenty self-fetching cards is
 * twenty requests. An app_trigger is PRIMARY-ONLY (validate.js rejects it in
 * `triggers[]`), so an automation has at most one such card, and the breadcrumb
 * asks for exactly the same reference. One 60s module-scope cache serves both
 * with a single request, and saves four hops of prop-drilling that every
 * future reader would have to trace.
 *
 * A failed lookup resolves to null, never to a rejection: the strip and the
 * card both render something true without it, and a label is never worth an
 * error dialog.
 */

/**
 * The back-pointer an automation carries on its own trigger, VALIDATED — or null.
 *
 * Routed through the same token round-trip the URL uses, so a definition and
 * an address bar cannot disagree about what a well-formed reference is. A
 * stored ref that fails the check reads as absent: the card then says
 * "Studio App trigger" and claims nothing, which is what a definition someone
 * hand-edited deserves.
 */
export function triggerAppRef(definition) {
    return parseAppRefParam(appRefParam(definition?.trigger?.appRef));
}

const TTL_MS = 60_000;

/** key → { at, record }. `record` may be null (the lookup failed). */
const cache = new Map();
/** key → in-flight promise, so two callers for one reference make ONE request. */
const inflight = new Map();

/** Cache key for a reference. Null for anything that is not a whole one. */
export function appRefKey(ref) {
    if (!ref?.appId || !ref?.screenId) return null;
    // Scheidingsteken: een ESCAPE (`\u0001`), geen letterlijke byte. Een echte
    // 0x00 in de bron maakt het bestand voor git BINAIR — dan is er in een PR
    // geen diff te zien, slaat `grep`/ripgrep de regels over en gaat het
    // bestand langs de secret-scan heen die vóór elke commit hoort te draaien.
    // Een teken dat in geen enkel id kan voorkomen is genoeg; het hoeft niet
    // ononderdrukbaar te zijn.
    return `${ref.appId}\u0001${ref.screenId}\u0001${ref.nodeId || ''}`;
}

/** The cached record when it is still fresh, else undefined (never null). */
function fresh(key) {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.record : undefined;
}

/**
 * Resolve one reference. Never rejects; resolves to the record, or to null
 * when the lookup could not be made (offline, 500, a body that is not JSON).
 */
export function loadAppRef(ref) {
    const key = appRefKey(ref);
    if (!key) return Promise.resolve(null);
    const hit = fresh(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);

    const qs = new URLSearchParams({ screenId: ref.screenId, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}) });
    const p = authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(ref.appId)}/ref?${qs}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((record) => {
            // A body without a status is not an answer — treating it as one
            // would let a proxy's HTML error page render as a breadcrumb.
            const ok = record && typeof record.status === 'string' ? record : null;
            cache.set(key, { at: Date.now(), record: ok });
            return ok;
        })
        .catch(() => {
            cache.set(key, { at: Date.now(), record: null });
            return null;
        })
        .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
}

/**
 * Drop everything cached.
 *
 * DIT IS GEEN TEST-ONLY FUNCTIE MEER. De sleutel is `appId + screenId +
 * nodeId` en noemt de KIJKER niet, terwijl het antwoord wél per kijker
 * verschilt: een app die je niet bezit levert `restricted` zonder namen en
 * zonder link. Uitloggen herlaadt de pagina niet — `setUser(null)` rendert het
 * loginscherm in dezelfde JS-context — dus zonder deze aanroep leest de
 * VOLGENDE gebruiker op hetzelfde werkstation binnen het TTL-venster de
 * appnaam, de schermnaam, het knoplabel én `canOpen:true` van de vorige. Dat
 * zijn precies de twee dingen die appRefLookup.js zelf verbiedt: een naam die
 * deze kijker niet mocht lezen, en een link die op een 403 landt.
 *
 * Aangeroepen door hooks/sessionCaches.clearSessionCaches() — de lijst die
 * bestaat voor deze hele klasse ("een cache die op niets gekeyd is, is op de
 * sessie gekeyd, dus hij sterft met de sessie").
 */
export function clearAppRefCache() {
    cache.clear();
    inflight.clear();
}

/** Historische naam, nog in gebruik in tests. */
export const __clearAppRefCacheForTests = clearAppRefCache;

/**
 * The resolved record for a reference.
 *
 * THREE return values, and they must stay apart:
 *   undefined — no reference, or the answer has not arrived. Render nothing.
 *   null      — the lookup failed. Render the ids, claim nothing.
 *   record    — the server's answer.
 *
 * A caller that collapses undefined into null tells everyone their app is
 * unreachable for the whole load window; that is the mistake flow/layout.js
 * writes down beside its own name maps, and it is the same one here.
 */
export function useAppRefLabel(ref) {
    const key = appRefKey(ref);
    const [record, setRecord] = useState(() => (key ? fresh(key) : undefined));

    // `ref` is a fresh object every render; the key is its identity.
    const load = useEffectEvent(() => loadAppRef(ref));
    useEffect(() => {
        if (!key) { setRecord(undefined); return undefined; }
        const hit = fresh(key);
        if (hit !== undefined) { setRecord(hit); return undefined; }
        let alive = true;
        setRecord(undefined);
        load().then((r) => { if (alive) setRecord(r); });
        return () => { alive = false; };
    }, [key]);

    return record;
}

/**
 * What to PUT ON SCREEN for a reference — names where they are known, ids
 * where they are not, and which level (if any) no longer exists.
 *
 * Pure, so both readers of a reference (the breadcrumb strip and the trigger
 * card) can be tested without a network. It returns DATA, never sentences:
 * the words belong to the components, which have the translator.
 *
 *   appText/screenText/nodeText  the name when the viewer was told one, else
 *                                the raw id. An id is honest; a guessed name
 *                                is not.
 *   gone                         null | 'app' | 'screen' | 'node' — the level
 *                                the pointer stops at. This is NOT "no
 *                                trigger": the automation still fires.
 *   restricted                   the viewer may not be told anything about it.
 *   unknown                      the answer has not arrived, or could not be
 *                                got. Distinct from `restricted`: one is a
 *                                refusal, the other is silence.
 *   canOpen                      the app can actually be opened by this
 *                                viewer. False unless the server said true —
 *                                a link that 403s is worse than no link.
 */
const GONE_LEVEL = { app_missing: 'app', screen_missing: 'screen', node_missing: 'node' };

export function appRefDisplay(record, ref = null) {
    const got = record || {};
    const asked = ref || {};
    const appId = got.appId || asked.appId || null;
    const screenId = got.screenId || asked.screenId || null;
    const nodeId = got.nodeId || asked.nodeId || null;
    return {
        appId,
        screenId,
        nodeId,
        appText: got.appName || appId,
        screenText: got.screenName || screenId,
        nodeText: got.nodeLabel || nodeId,
        gone: GONE_LEVEL[got.status] || null,
        restricted: got.status === 'restricted',
        unknown: record == null,
        canOpen: got.canOpen === true,
    };
}
