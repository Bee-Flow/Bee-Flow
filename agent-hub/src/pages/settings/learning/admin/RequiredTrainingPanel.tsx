import { GraduationCap, Info, Loader2, Lock, Save } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trainingRulesKey, useTrainingRulesQuery, type TrainingRulesRead } from '../../../../api/queries/learningReads';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { errorMessage } from '../../../../utils/caughtError';
import { mutate, ApiError } from '../../../../api/mutate';

interface TrainingArea {
    id: string;
    labelKey: string;
    labelFallback: string;
    defaultCourseId: string;
}

interface TrainingCourse {
    id: string;
    title: string;
    own?: boolean;
    lessons: number;
}

const NO_AREAS_LIST: TrainingArea[] = [];
const NO_COURSES: TrainingCourse[] = [];
const NO_AREAS: Record<string, string> = {};

interface TrainingState {
    loading: boolean;
    error: string | null | undefined;
    catalog: TrainingArea[];
    courses: TrainingCourse[];
    areas: Record<string, string>;
}

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
/** What the panel shows of the read: the lists (empty until known) and the error to say, if any. */
function trainingStateOf(rules: ReturnType<typeof useTrainingRulesQuery<TrainingArea, TrainingCourse>>, saveError: string | null): TrainingState {
    return {
        loading: rules.isPending,
        error: saveError ?? (rules.isError ? errorMessage(rules.error) : null),
        catalog: rules.data?.catalog ?? NO_AREAS_LIST,
        courses: rules.data?.courses ?? NO_COURSES,
        areas: rules.data?.areas ?? NO_AREAS,
    };
}

export default function RequiredTrainingPanel() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const rules = useTrainingRulesQuery<TrainingArea, TrainingCourse>();
    const [saveError, setSaveError] = useState<string | null>(null);
    const state = trainingStateOf(rules, saveError);
    // The rules as edited; null follows the server's.
    const [edited, setEdited] = useState<Record<string, string> | null>(null);
    const draft = edited ?? state.areas;
    const setDraft = (update: (d: Record<string, string>) => Record<string, string>) => setEdited(update(draft));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const dirty = useMemo(
        () => JSON.stringify(draft) !== JSON.stringify(state.areas),
        [draft, state.areas],
    );

    const save = async () => {
        setSaving(true); setSaved(false);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/ai/learning/training-rules`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ areas: draft }),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error(String(err.status));
            }
            const body = await res.json();
            queryClient.setQueryData<TrainingRulesRead<TrainingArea, TrainingCourse>>(trainingRulesKey, (prev) => (prev ? { ...prev, areas: body.areas || {} } : prev));
            setEdited(null);
            setSaveError(null);
            setSaved(true);
        } catch (_) {
            setSaveError(t('org.training.save_failed', 'Could not save. Try again.'));
        } finally {
            setSaving(false);
        }
    };

    const toggle = (areaId: string, on: boolean, defaultCourseId: string) => {
        setSaved(false);
        setDraft((d) => {
            const next = { ...d };
            if (on) next[areaId] = d[areaId] || defaultCourseId;
            else delete next[areaId];
            return next;
        });
    };

    if (state.loading) {
        return <div className="flex items-center gap-2 p-5 text-[13px] text-[var(--text-tertiary)]">
            <Loader2 className="animate-spin w-[14px] h-[14px]" />{t('common.loading', 'Loading…')}
        </div>;
    }

    const enabledCount = Object.keys(draft).length;

    return (
        <div className="flex flex-col gap-4" data-testid="required-training-panel">
            <div className="flex items-start gap-3 rounded-xl p-4 [background:var(--bg-card)] [border:1px_solid_var(--border-default)]">
                <div className="w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 bg-[var(--bg-tertiary)]">
                    <GraduationCap className="w-[18px] h-[18px] [color:var(--text-secondary)]" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex flex-col gap-1">
                    <div className="text-[14px] font-semibold">{t('org.training.title', 'Finish the course first')}</div>
                    <div className="text-[12px] leading-[18px] [color:var(--text-secondary)]! [text-wrap:pretty]!">
                        {t('org.training.intro', 'Pick the things people should be trained on before they build them. Reading and running are never blocked — someone who has not finished the agents course can still talk to agents and run what colleagues built; they just cannot create or change one yet. Unlike a permission, they can lift this themselves in an afternoon.')}
                    </div>
                </div>
            </div>

            <div className="rounded-xl overflow-hidden [background:var(--bg-card)] [border:1px_solid_var(--border-default)]">
                {state.catalog.map((area: TrainingArea) => (
                    <AreaRow key={area.id} t={t} area={area} courses={state.courses}
                        courseId={draft[area.id] || ''}
                        onToggle={(on: boolean) => toggle(area.id, on, area.defaultCourseId)}
                        onPick={(courseId: string) => { setSaved(false); setDraft((d) => ({ ...d, [area.id]: courseId })); }} />
                ))}
            </div>

            <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={!dirty || saving}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed [background:var(--accent-primary)] [color:#fff]!">
                    {saving ? <Loader2 className="animate-spin w-[13px] h-[13px]" /> : <Save className="w-[13px] h-[13px]" aria-hidden="true" />}
                    {t('common.save', 'Save')}
                </button>
                <span className="text-[12px] text-[var(--text-tertiary)]">
                    {enabledCount === 0
                        ? t('org.training.none_on', 'Nothing requires training yet.')
                        : t('org.training.n_on', '{n} area(s) require a course.').replace('{n}', String(enabledCount))}
                </span>
                {saved && !dirty && <span className="text-[12px] text-[var(--learn-complete-ink)]">{t('common.saved', 'Saved')}</span>}
                {state.error && <span className="text-[12px] text-[var(--error-ink)]">{state.error}</span>}
            </div>

            <div className="flex items-start gap-2 text-[11px] leading-[16px] text-[var(--text-tertiary)]">
                <Info className="w-[12px] h-[12px] [flex-shrink:0] [margin-top:2px]" aria-hidden="true" />
                <span>{t('org.training.exempt_note', 'Organisation admins are never blocked by these rules, and neither is anyone whose plan no longer includes the Learning Center — a rule nobody can satisfy would stop the workspace instead of teaching anyone.')}</span>
            </div>
        </div>
    );
}

function AreaRow({ t, area, courses, courseId, onToggle, onPick }: {
    t: TranslateFn;
    area: TrainingArea;
    courses: TrainingCourse[];
    courseId: string;
    onToggle: (on: boolean) => void;
    onPick: (courseId: string) => void;
}) {
    const on = !!courseId;
    return (
        <div className="flex items-center gap-3 [padding:12px_14px] [border-bottom:1px_solid_var(--border-default)]">
            <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)}
                    aria-label={t(area.labelKey, area.labelFallback)} />
                <span className="min-w-0 flex flex-col">
                    <span className="text-[13px] font-medium truncate">{t(area.labelKey, area.labelFallback)}</span>
                    {!on && <span className="text-[11px] text-[var(--text-tertiary)]">{t('org.training.open_to_all', 'Open to anyone whose role allows it')}</span>}
                </span>
            </label>
            {on ? (
                <span className="flex items-center gap-2 flex-shrink-0">
                    <Lock className="w-[12px] h-[12px] [color:var(--text-tertiary)]" aria-hidden="true" />
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t('org.training.after', 'after')}</span>
                    <select value={courseId} onChange={(e) => onPick(e.target.value)}
                        aria-label={t('org.training.pick_course', 'Course that unlocks {area}').replace('{area}', t(area.labelKey, area.labelFallback))}
                        className="text-[12px] rounded-lg px-2 h-8 [background:var(--bg-secondary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]! max-w-[280px]">
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
