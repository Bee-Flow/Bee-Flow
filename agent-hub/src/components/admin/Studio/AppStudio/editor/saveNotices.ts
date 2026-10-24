/**
 * What the server reports back on save, in one shape.
 *
 * This stood as a private function in EditorHeader.jsx and had one reader there: the save pill. The Logic tab
 * needs the same list: it attaches each notice to the ROW it is about, so that "this button does nothing" can
 * be read where the button stands, and not only behind a pill at the top. Two copies of this normalisation would
 * become two answers to the same question, so it lives here and both import it.
 */

// Sentinel role keys and other internal markers (e.g. the "hidden from
// everyone" key) are implementation detail — an entry whose text leaks one is
// dropped rather than shown, since it means nothing to the person reading it.
const INTERNAL_TOKEN_RE = /__[A-Za-z0-9_]+__/;

/** One server entry: { code, path, message, hint? }, or just the message. */
interface RawNotice {
    message?: unknown;
    hint?: unknown;
    path?: unknown;
    code?: unknown;
}

/** One reply: errors and warnings from a refused save, warnings and repairs from a kept one. */
export interface SavePayload {
    errors?: unknown;
    warnings?: unknown;
    repairs?: unknown;
}

export interface SaveNotice {
    kind: 'error' | 'warning' | 'repair';
    message: string;
    hint: string;
    path: string;
    code: string;
}

/**
 * Flatten one save reply — { warnings, repairs } or { errors, warnings } — into
 * the list the save pill shows. Server entries are { code, path, message, hint? };
 * repairs carry no hint. Entries without a message have nothing to say.
 */
export function toSaveNotices(payload: SavePayload | null | undefined): SaveNotice[] {
    const out: SaveNotice[] = [];
    const take = (list: unknown, kind: SaveNotice['kind']) => {
        for (const raw of Array.isArray(list) ? list : []) {
            const entry: RawNotice = typeof raw === 'string' ? { message: raw } : (raw || {});
            const message = typeof entry.message === 'string' ? entry.message.trim() : '';
            const hint = typeof entry.hint === 'string' ? entry.hint.trim() : '';
            if (!message) continue;
            if (INTERNAL_TOKEN_RE.test(message) || INTERNAL_TOKEN_RE.test(hint)) continue;
            out.push({
                kind,
                message,
                hint,
                path: typeof entry.path === 'string' ? entry.path : '',
                // The code was always there and was thrown away here. The Logic tab chooses BY it which notice belongs to
                // which row (component.control_inert on a button, form.no_submit_action on a form), so a text match
                // would be the only other way — and that breaks as soon as someone rewrites the sentence.
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
