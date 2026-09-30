import { Loader2, Plus } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { SECTIONS, itemLabel } from './solutionSections';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { projectErrorText } from '../../../projects/workspace/projectErrorText';

/**
 * "Add a component" — file something you already made into this Solution.
 *
 * `PUT /:id/resources` has existed since the membership registry landed and had
 * no caller: the route, the ownership rule and the audit entry were all there,
 * and there was no way to reach them from a screen. This is that way.
 *
 * ── What the server enforces, and what this must not pretend ────────────────
 *
 * Filing something in needs editor ON THE PROJECT *and* ownership OF THE ITEM —
 * the stores each match on `user_id`, so a member cannot pull a colleague's work
 * into a shared project and cannot push it out either. This picker therefore
 * lists what the CALLER's own list endpoints return and lets the server be the
 * authority; a refusal is shown in words rather than hidden by a filter that
 * guessed at the same rule and drifted.
 *
 * Approvals are absent, and not by omission: an approval is a decision stamped
 * with its project when it is raised, never re-filed. `membership.movableKinds()`
 * says so on the server, and `SECTIONS[].movable` is the same fact here.
 *
 * ── The listings are read defensively ───────────────────────────────────────
 *
 * Seven endpoints, and they do not agree on a shape: `{notebooks}`, `{apps}`,
 * `{tasks}`, `{webpages}`, `{datatables}`, a bare array for knowledge bases.
 * Rather than encode six spellings that a route rename would quietly break,
 * `rowsOf` takes the array it is given or the first array-valued property it
 * finds. A response it cannot read yields an empty list AND an error line — the
 * two are never the same thing here, because "you have no apps" and "the list
 * did not load" send someone to different places.
 */

/** Where each movable kind's own listing lives. */
const SOURCE = {
    notebook: `${API_BASE}/api/notebooks`,
    app: `${API_BASE}/api/studio-apps`,
    automation: `${API_BASE}/api/ai-tasks`,
    webpage: `${API_BASE}/api/webpages`,
    datatable: `${API_BASE}/api/datatables`,
    agent: `${API_BASE}/agents`,
    knowledge_base: `${API_BASE}/api/kb`,
};

/** The array inside a listing response, whatever the endpoint calls it. */
export function rowsOf(body) {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return null;
    for (const value of Object.values(body)) {
        if (Array.isArray(value)) return value;
    }
    return null;
}

const PICKABLE = SECTIONS.filter(s => s.movable && SOURCE[s.kind]);

export default function SolutionAddResource({ projectId, alreadyIn, onAdded }) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('');
    const [options, setOptions] = useState(null);   // null = not loaded / unreadable
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const pick = useCallback(async (nextKind) => {
        setKind(nextKind);
        setOptions(null);
        setError('');
        if (!nextKind) return;
        setBusy(true);
        try {
            const res = await authFetch(SOURCE[nextKind]);
            const body = res.ok ? await res.json().catch(() => null) : null;
            const rows = rowsOf(body);
            if (!res.ok || rows === null) {
                // Not "you have none" — that is a different sentence and it
                // would send someone off to create a second copy of what they
                // already have.
                setError(t('solutions.add_list_failed', 'That list could not be loaded. Try again shortly.'));
                return;
            }
            setOptions(rows.filter(r => r?.id && !alreadyIn?.has(`${nextKind}:${r.id}`)));
        } catch {
            setError(t('solutions.add_list_failed', 'That list could not be loaded. Try again shortly.'));
        } finally {
            setBusy(false);
        }
    }, [alreadyIn, t]);

    const attach = async (id) => {
        setBusy(true);
        setError('');
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/resources`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, id, attach: true }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                // The server's own words: "not yours to move" is the answer a
                // filter here could only have guessed at. A refusal with a known
                // code (a kind a Solution does not hold) is said in the reader's language.
                setError(projectErrorText(t, body, t('solutions.add_failed', 'That could not be added.')));
                return;
            }
            setKind('');
            setOptions(null);
            onAdded?.();
        } catch {
            setError(t('solutions.add_failed', 'That could not be added.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2" data-testid="solution-add-resource">
            <div className="flex flex-wrap items-center gap-2">
                <Plus className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                <label className="text-sm" style={{ color: 'var(--text-secondary)' }} htmlFor="solution-add-kind">
                    {t('projects.add_existing')}
                </label>
                <select
                    id="solution-add-kind"
                    value={kind}
                    onChange={(e) => pick(e.target.value)}
                    className="px-2 py-1.5 rounded-lg text-sm border"
                    style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                >
                    <option value="">{t('solutions.add_pick_kind', 'Choose a kind…')}</option>
                    {PICKABLE.map(s => (
                        <option key={s.kind} value={s.kind}>{t(s.labelKey)}</option>
                    ))}
                </select>
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-tertiary)' }} />}
            </div>

            {error && (
                <p className="px-3 py-2 rounded-lg text-xs" data-testid="solution-add-error"
                   style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                    {error}
                </p>
            )}

            {kind && !busy && !error && options !== null && (
                options.length === 0 ? (
                    <p className="px-3 py-2 rounded-lg text-xs"
                       style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                        {t('solutions.add_nothing_left', 'Nothing of yours left to add here.')}
                    </p>
                ) : (
                    <ul className="space-y-1 max-h-56 overflow-y-auto">
                        {options.map(option => (
                            <li key={option.id}>
                                <button
                                    onClick={() => attach(option.id)}
                                    className="w-full text-left px-3 py-1.5 rounded-lg text-sm truncate"
                                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                >
                                    {itemLabel(option)}
                                </button>
                            </li>
                        ))}
                    </ul>
                )
            )}
        </div>
    );
}
