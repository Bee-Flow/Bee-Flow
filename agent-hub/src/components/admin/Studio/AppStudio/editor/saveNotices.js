/**
 * Wat de server bij het opslaan terugmeldt, in één vorm.
 *
 * Stond als privéfunctie in EditorHeader.jsx en had daar één lezer: de
 * save-pill. De Logica-tab heeft dezelfde lijst nodig — hij hangt elke melding
 * aan de RIJ waar hij over gaat, zodat "deze knop doet niets" te lezen is waar
 * de knop staat en niet alleen achter een pill bovenin. Twee kopieën van deze
 * normalisatie zouden twee antwoorden op dezelfde vraag worden, dus staat hij
 * hier en importeren beide hem.
 */

// Sentinel role keys and other internal markers (e.g. the "hidden from
// everyone" key) are implementation detail — an entry whose text leaks one is
// dropped rather than shown, since it means nothing to the person reading it.
const INTERNAL_TOKEN_RE = /__[A-Za-z0-9_]+__/;

/**
 * Flatten one save reply — { warnings, repairs } or { errors, warnings } — into
 * the list the save pill shows. Server entries are { code, path, message, hint? };
 * repairs carry no hint. Entries without a message have nothing to say.
 */
export function toSaveNotices(payload) {
    const out = [];
    const take = (list, kind) => {
        for (const raw of Array.isArray(list) ? list : []) {
            const entry = typeof raw === 'string' ? { message: raw } : (raw || {});
            const message = typeof entry.message === 'string' ? entry.message.trim() : '';
            const hint = typeof entry.hint === 'string' ? entry.hint.trim() : '';
            if (!message) continue;
            if (INTERNAL_TOKEN_RE.test(message) || INTERNAL_TOKEN_RE.test(hint)) continue;
            out.push({
                kind,
                message,
                hint,
                path: typeof entry.path === 'string' ? entry.path : '',
                // De code was er altijd al en werd hier weggegooid. De
                // Logica-tab kiest ERop welke melding bij welke rij hoort
                // (component.control_inert bij een knop, form.no_submit_action
                // bij een formulier), dus een tekstmatch zou de enige andere
                // manier zijn — en die breekt zodra iemand de zin herschrijft.
                code: typeof entry.code === 'string' ? entry.code : '',
            });
        }
    };
    take(payload?.errors, 'error');
    take(payload?.warnings, 'warning');
    take(payload?.repairs, 'repair');
    return out;
}

export default toSaveNotices;
