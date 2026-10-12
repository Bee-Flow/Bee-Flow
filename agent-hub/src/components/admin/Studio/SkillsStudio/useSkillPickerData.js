import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { isAgentCallable } from './skillModel';

/**
 * The four lists every picker in the skill editor needs, fetched ONCE per
 * open detail: the org's groups (for the visibility capsule), the automations
 * an agent can call, the knowledge bases and the datatables.
 *
 * ── THREE ANSWERS PER LIST, NOT TWO ─────────────────────────────────
 * Each read stays independent: a automations list that falls over must not take
 * the whole editor down while somebody is writing a step. But "it fell over"
 * is not the same answer as "there are none", and this used to return `[]`
 * for both — so a picker said "nothing else to link" about a list it had
 * never managed to read. A failed read now names itself in `unavailable`,
 * and `loaded` marks the moment before the first answer, when nothing at all
 * may be claimed.
 *
 * A 403 lands in `unavailable` with the rest. A refusal is a good reason to
 * offer nothing; it is not a reason to tell someone their org has nothing.
 *
 * A 200 whose body is not a list counts as unread for the same reason: an
 * answer nobody can parse is not an answer.
 *
 * A read can also be RETRIED: `reload()` re-asks all four. Without it a single
 * 500 on /api/automation left "could not be read" standing until the skill was
 * closed and reopened, which is a poor answer to a blip.
 *
 * The automations list is filtered to `agent_call` triggers on the way in
 * (`skillModel.isAgentCallable`): "may use" means "offered as a tool", and
 * the runtime dispatches nothing else. An automation with no trigger info is
 * NOT offered — failing closed here costs one entry in a picker; failing
 * open costs a promise the runtime cannot keep.
 */
const UNREAD = Object.freeze({ rows: [], ok: false });

async function readList(path, pick) {
    try {
        const res = await authFetch(`${API_BASE}${path}`);
        if (!res.ok) return UNREAD;
        const body = await res.json();
        const rows = pick(body);
        return Array.isArray(rows) ? { rows, ok: true } : UNREAD;
    } catch {
        return UNREAD;
    }
}

/** Before the first answer: four empty lists and no claim about any of them. */
export const EMPTY_PICKER_DATA = Object.freeze({
    orgGroups: [], automations: [], knowledgeBases: [], datatables: [],
    unavailable: [], loaded: false,
});

export default function useSkillPickerData(enabled = true) {
    const [data, setData] = useState(EMPTY_PICKER_DATA);
    const [attempt, setAttempt] = useState(0);

    /** Ask all four again. Safe to call while a read is in flight. */
    const reload = useCallback(() => setAttempt(n => n + 1), []);

    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        (async () => {
            const [groups, automations, kbs, tables] = await Promise.all([
                readList('/auth/groups', (b) => b),
                readList('/api/automation', (b) => b?.automations),
                readList('/api/kb?context=agent', (b) => (Array.isArray(b) ? b : b?.knowledgeBases)),
                readList('/api/datatables', (b) => b?.datatables),
            ]);
            if (!alive) return;
            setData({
                orgGroups: groups.rows,
                automations: automations.rows.filter(isAgentCallable),
                knowledgeBases: kbs.rows,
                datatables: tables.rows,
                // The ids a consumer names on screen. `loaded` stays false
                // while `enabled` is false — nothing was asked, so nothing is
                // known, and that is not the same as an empty org either.
                unavailable: [
                    ['groups', groups], ['automations', automations],
                    ['kbs', kbs], ['tables', tables],
                ].filter(([, read]) => !read.ok).map(([id]) => id),
                loaded: true,
                reload,
            });
        })();
        return () => { alive = false; };
    }, [enabled, attempt, reload]);

    // `reload` is on the object from the FIRST render too, so Retry is offered
    // over the very first failure as well. Memoised: consumers key `useMemo`
    // and prop identity on this object.
    return useMemo(() => (data.reload ? data : { ...data, reload }), [data, reload]);
}

/**
 * This hook's answer, read defensively, in ONE place.
 *
 * Both screens that show a picker need the same three-way reading, and two
 * copies of it is how one of them ends up saying "you have none" about a list
 * that 500'd. An absent `listStatus` means the caller passed literal arrays
 * and has its answer already — hence `loaded: true` with no gaps. An
 * `unavailable` that is not an array is treated as no gaps rather than
 * crashing the card: this note is an explanation, and an explanation must
 * never be the thing that takes the editor down.
 */
export function readListStatus(listStatus) {
    return {
        loaded: listStatus?.loaded !== false,
        unread: Array.isArray(listStatus?.unavailable) ? listStatus.unavailable : [],
        reload: typeof listStatus?.reload === 'function' ? listStatus.reload : null,
    };
}

/** The `refOptions` shape SkillStepEditor's picker reads. */
export function refOptionsOf({ automations, knowledgeBases, datatables }) {
    return {
        automation: (automations || []).map(a => ({ id: String(a.id), name: a.title || a.name || a.id })),
        kb: (knowledgeBases || []).map(k => ({ id: String(k.id), name: k.name || k.id })),
        table: (datatables || []).map(d => ({ id: String(d.id), name: d.name || d.key || d.id })),
    };
}
