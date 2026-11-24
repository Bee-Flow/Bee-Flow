/**
 * The organisation's Cowork policy, for its administrators (server/routes/coworkPolicyRoutes.js): the most independent
 * level a cowork may run at, one switch that makes every cowork read-only, the apps a plan may use while nobody
 * watches, the monthly AI budget of all its coworks, and the trail of every change as a download. Saved at once, field by field, like the shield toggle above it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ToggleCard from './ToggleCard';
import { apiJson, apiUrl } from '@/api/typedRequest';
import type { TranslateFn } from '../tabs/checks/checksTypes';

type Level = 'asks_everything' | 'asks_before_sending' | 'on_its_own';
interface Policy { ceiling: Level; readOnly: boolean; unattendedApps: string[] | null; monthlyBudget?: number | null; habitsAllowed?: boolean }

const keyOf = (orgId: string) => ['cowork-policy', orgId] as const;
const LEVELS: Array<[Level, string, string]> = [
    ['on_its_own', 'cowork_policy.ceiling.on_its_own', 'No ceiling: a cowork may run on its own'],
    ['asks_before_sending', 'cowork_policy.ceiling.asks_before_sending', 'At most: ask before anything leaves Bee Flow'],
    ['asks_everything', 'cowork_policy.ceiling.asks_everything', 'At most: ask about everything'],
];

/** "outlook, datatables" as a list; empty is every app. */
const appsOf = (text: string): string[] | null => {
    const list = text.split(',').map((a) => a.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
};

/** "50" or "12,50" as euros; empty is no limit, and anything else is not a budget (undefined). */
const budgetOf = (text: string): number | null | undefined => {
    const clean = text.trim().replace(',', '.');
    if (clean === '') return null;
    const n = Number(clean);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
};

/** The monthly AI budget of all the organisation's coworks, in euros; saved with its own button. */
function BudgetField({ current, disabled, onSave, t }: { current: number | null; disabled: boolean; onSave: (budget: number | null, done: () => void) => void; t: TranslateFn }) {
    const [text, setText] = useState<string | null>(null);
    const shown = text ?? (current === null ? '' : String(current));
    const parsed = budgetOf(shown);
    return (
        <div className="px-4 py-3 flex flex-col gap-1.5 border-t [border-color:var(--border-subtle)]">
            <label htmlFor="cowork-policy-budget" className="text-[13px] font-medium text-[var(--text-primary)]">{t('cowork_policy.budget', 'Monthly AI budget for all coworks')}</label>
            <span className="text-[12px] text-[var(--text-secondary)]">{t('cowork_policy.budget_hint', 'In euros, counted from the 1st of the month over every cowork of the organisation. At the budget, coworks stop running until the next month; you are told once. Empty: no limit.')}</span>
            <div className="flex gap-2">
                <input id="cowork-policy-budget" inputMode="decimal" className="w-32 rounded-lg border px-2 py-1.5 text-[13px] bg-[var(--bg-primary)] [border-color:var(--border-default)]" value={shown} disabled={disabled} onChange={(e) => setText(e.target.value)} />
                <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={disabled || text === null || parsed === undefined} onClick={() => { if (parsed !== undefined) onSave(parsed, () => setText(null)); }}>
                    {t('cowork_policy.save_budget', 'Save budget')}
                </button>
            </div>
            {parsed === undefined && <span role="alert" className="text-[12px] text-[var(--error-ink)]">{t('cowork_policy.budget_invalid', 'Fill in an amount above 0, or leave it empty.')}</span>}
        </div>
    );
}

export default function CoworkPolicyPanel({ orgId, readOnly = false, t }: { orgId: string; readOnly?: boolean; t: TranslateFn }) {
    const client = useQueryClient();
    const policy = useQuery<Policy, Error>({
        queryKey: keyOf(orgId),
        enabled: !!orgId,
        queryFn: () => apiJson<'GET /api/cowork/policy/{orgId}', Policy>('GET /api/cowork/policy/{orgId}', { params: { orgId } }),
        retry: false,
    });
    const save = useMutation<Policy, Error, Partial<Policy>>({
        mutationFn: (patch) => apiJson<'PUT /api/cowork/policy/{orgId}', Policy>('PUT /api/cowork/policy/{orgId}', { params: { orgId }, body: patch }),
        onSuccess: (next) => { client.setQueryData(keyOf(orgId), next); },
    });
    const [apps, setApps] = useState<string | null>(null);
    if (!orgId || policy.isError || !policy.data) return null;
    const current = policy.data;
    const appsText = apps ?? (current.unattendedApps ?? []).join(', ');
    const disabled = readOnly || save.isPending;
    return (
        <section className="rounded-[10px] border [border-color:var(--border-subtle)] flex flex-col" data-testid="cowork-policy">
            <ToggleCard
                title={t('cowork_policy.read_only', 'Make every cowork read-only')}
                description={t('cowork_policy.read_only_desc', 'Nothing runs, and nothing is created or changed, until you switch this off. Saved at once.')}
                checked={current.readOnly}
                onChange={(next) => save.mutate({ readOnly: next })}
                disabled={disabled}
            />
            <div className="px-4 py-3 flex flex-col gap-1.5 border-t [border-color:var(--border-subtle)]">
                <label htmlFor="cowork-policy-ceiling" className="text-[13px] font-medium text-[var(--text-primary)]">{t('cowork_policy.ceiling', 'How independent a cowork may be')}</label>
                <select id="cowork-policy-ceiling" className="w-full max-w-md rounded-lg border px-2 py-1.5 text-[13px] bg-[var(--bg-primary)] [border-color:var(--border-default)]" value={current.ceiling} disabled={disabled} onChange={(e) => save.mutate({ ceiling: e.target.value as Level })}>
                    {LEVELS.map(([level, key, en]) => <option key={level} value={level}>{t(key, en)}</option>)}
                </select>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1.5 border-t [border-color:var(--border-subtle)]">
                <label htmlFor="cowork-policy-apps" className="text-[13px] font-medium text-[var(--text-primary)]">{t('cowork_policy.apps', 'Apps a plan may use while nobody watches')}</label>
                <span className="text-[12px] text-[var(--text-secondary)]">{t('cowork_policy.apps_hint', 'App ids, separated by commas, such as outlook, datatables. Empty: every app.')}</span>
                <div className="flex gap-2">
                    <input id="cowork-policy-apps" className="flex-1 max-w-md rounded-lg border px-2 py-1.5 text-[13px] bg-[var(--bg-primary)] [border-color:var(--border-default)]" value={appsText} disabled={disabled} onChange={(e) => setApps(e.target.value)} />
                    <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={disabled || apps === null} onClick={() => save.mutate({ unattendedApps: appsOf(appsText) }, { onSuccess: () => setApps(null) })}>
                        {t('cowork_policy.save_apps', 'Save')}
                    </button>
                </div>
            </div>
            <div className="border-t [border-color:var(--border-subtle)]">
                <ToggleCard
                    title={t('cowork_policy.habits', 'Let people switch on "notice what I repeat"')}
                    description={t('cowork_policy.habits_desc', 'Each person decides for themselves, and it is off until they switch it on. It keeps which apps a chat used and on which weekday, never what was asked. Switching this off stops it for everyone.')}
                    checked={current.habitsAllowed !== false}
                    onChange={(next) => save.mutate({ habitsAllowed: next })}
                    disabled={disabled}
                />
            </div>
            <BudgetField current={current.monthlyBudget ?? null} disabled={disabled} t={t} onSave={(budget, done) => save.mutate({ monthlyBudget: budget }, { onSuccess: done })} />
            <div className="px-4 py-3 border-t [border-color:var(--border-subtle)] flex items-center justify-between gap-3">
                <span className="text-[12px] text-[var(--text-secondary)]">{t('cowork_policy.audit_hint', 'Every change to a cowork in this organisation: who, what and when; never what the work says.')}</span>
                <a className="text-[12px] font-medium text-[var(--accent)]" href={apiUrl('GET /api/cowork/policy/{orgId}/audit', { params: { orgId } })} download>{t('cowork_policy.audit', 'Download the trail (CSV)')}</a>
            </div>
            {save.error && <p role="alert" className="px-4 pb-3 text-[12px] text-[var(--error-ink)]">{t('cowork_policy.failed', 'That did not save. Try again.')}</p>}
        </section>
    );
}
