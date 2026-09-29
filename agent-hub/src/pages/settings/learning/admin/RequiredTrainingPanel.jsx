import { GraduationCap, Info, Loader2, Lock, Save } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * Required training — the org-admin side of "finish the course first".
 *
 * The rule this configures is a third axis beside permissions and plan
 * capabilities, and the one thing that makes it different is worth saying on
 * the screen rather than only in the code: the person it blocks can lift it
 * themselves, today, without asking anybody. That is why the copy talks about
 * what someone must FINISH rather than what they are denied.
 *
 * Reads and writes GET/PUT /ai/learning/training-rules. The whole map is sent
 * on save, so clearing a row removes the rule.
 */
export default function RequiredTrainingPanel() {
    const { t } = useTranslation();
    const [state, setState] = useState({ loading: true, error: null, catalog: [], courses: [], areas: {} });
    const [draft, setDraft] = useState({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(`${API_BASE}/ai/learning/training-rules`);
            if (!res.ok) throw new Error(String(res.status));
            const body = await res.json();
            setState({ loading: false, error: null, catalog: body.catalog || [], courses: body.courses || [], areas: body.areas || {} });
            setDraft(body.areas || {});
        } catch (e) {
            setState((s) => ({ ...s, loading: false, error: e.message }));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const dirty = useMemo(
        () => JSON.stringify(draft) !== JSON.stringify(state.areas),
        [draft, state.areas],
    );

    const save = async () => {
        setSaving(true); setSaved(false);
        try {
            const res = await authFetch(`${API_BASE}/ai/learning/training-rules`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ areas: draft }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const body = await res.json();
            setState((s) => ({ ...s, areas: body.areas || {} }));
            setDraft(body.areas || {});
            setSaved(true);
        } catch (_) {
            setState((s) => ({ ...s, error: t('org.training.save_failed', 'Could not save. Try again.') }));
        } finally {
            setSaving(false);
        }
    };

    const toggle = (areaId, on, defaultCourseId) => {
        setSaved(false);
        setDraft((d) => {
            const next = { ...d };
            if (on) next[areaId] = d[areaId] || defaultCourseId;
            else delete next[areaId];
            return next;
        });
    };

    if (state.loading) {
        return <div className="flex items-center gap-2 p-5 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />{t('common.loading', 'Loading…')}
        </div>;
    }

    const enabledCount = Object.keys(draft).length;

    return (
        <div className="flex flex-col gap-4" data-testid="required-training-panel">
            <div className="flex items-start gap-3 rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)' }}>
                <div className="w-9 h-9 rounded-lg grid place-items-center flex-shrink-0" style={{ background: 'var(--bg-tertiary)' }}>
                    <GraduationCap style={{ width: 18, height: 18, color: 'var(--text-secondary)' }} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex flex-col gap-1">
                    <div className="text-[14px] font-semibold">{t('org.training.title', 'Finish the course first')}</div>
                    <div className="text-[12px] leading-[18px]" style={{ color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                        {t('org.training.intro', 'Pick the things people should be trained on before they build them. Reading and running are never blocked — someone who has not finished the agents course can still talk to agents and run what colleagues built; they just cannot create or change one yet. Unlike a permission, they can lift this themselves in an afternoon.')}
                    </div>
                </div>
            </div>

            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)' }}>
                {state.catalog.map((area) => (
                    <AreaRow key={area.id} t={t} area={area} courses={state.courses}
                        courseId={draft[area.id] || ''}
                        onToggle={(on) => toggle(area.id, on, area.defaultCourseId)}
                        onPick={(courseId) => { setSaved(false); setDraft((d) => ({ ...d, [area.id]: courseId })); }} />
                ))}
            </div>

            <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={!dirty || saving}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                    {saving ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Save style={{ width: 13, height: 13 }} aria-hidden="true" />}
                    {t('common.save', 'Save')}
                </button>
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    {enabledCount === 0
                        ? t('org.training.none_on', 'Nothing requires training yet.')
                        : t('org.training.n_on', '{n} area(s) require a course.').replace('{n}', String(enabledCount))}
                </span>
                {saved && !dirty && <span className="text-[12px]" style={{ color: 'var(--learn-complete-ink)' }}>{t('common.saved', 'Saved')}</span>}
                {state.error && <span className="text-[12px]" style={{ color: 'var(--error-ink)' }}>{state.error}</span>}
            </div>

            <div className="flex items-start gap-2 text-[11px] leading-[16px]" style={{ color: 'var(--text-tertiary)' }}>
                <Info style={{ width: 12, height: 12, flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
                <span>{t('org.training.exempt_note', 'Organisation admins are never blocked by these rules, and neither is anyone whose plan no longer includes the Learning Center — a rule nobody can satisfy would stop the workspace instead of teaching anyone.')}</span>
            </div>
        </div>
    );
}

function AreaRow({ t, area, courses, courseId, onToggle, onPick }) {
    const on = !!courseId;
    return (
        <div className="flex items-center gap-3" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}>
            <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)}
                    aria-label={t(area.labelKey, area.labelFallback)} />
                <span className="min-w-0 flex flex-col">
                    <span className="text-[13px] font-medium truncate">{t(area.labelKey, area.labelFallback)}</span>
                    {!on && <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('org.training.open_to_all', 'Open to anyone whose role allows it')}</span>}
                </span>
            </label>
            {on ? (
                <span className="flex items-center gap-2 flex-shrink-0">
                    <Lock style={{ width: 12, height: 12, color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('org.training.after', 'after')}</span>
                    <select value={courseId} onChange={(e) => onPick(e.target.value)}
                        aria-label={t('org.training.pick_course', 'Course that unlocks {area}').replace('{area}', t(area.labelKey, area.labelFallback))}
                        className="text-[12px] rounded-lg px-2 h-8"
                        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', maxWidth: 280 }}>
                        {courses.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.title}{c.own ? ` · ${t('org.training.own_course', 'your course')}` : ''} ({t('learn.course.lesson_count', '{n} lessons').replace('{n}', String(c.lessons))})
                            </option>
                        ))}
                    </select>
                </span>
            ) : null}
        </div>
    );
}
