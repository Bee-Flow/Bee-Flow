/**
 * Admin rules, a page of Cowork for the organisation's administrators (the home's "Admin rules" link opens it): the
 * rules for all tasks of the organisation. It reads and saves the organisation's Cowork policy by id (GET/PUT /api/cowork/policy/{orgId}, an
 * administrator's permission is checked by the server), the AI spend of this month for the budget meter, and the check
 * and export of every signed receipt (server/usecases/coworkOrgPanel.mts). Each switch saves at once. Someone who is no
 * administrator is told so and sees nothing else.
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { receiptsAuditDownloadUrl, useCoworkOrgOverview, useOrgCoworkPolicy, useReceiptsAudit, type OrgCoworkPolicy, type OrgPolicyPatch } from '@/api/coworkOrgPanel';
import useAppsCatalog from '@/hooks/useAppsCatalog';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { ALERT, BUTTON_SECONDARY } from '../coworkUi';
import { BODY, CARD, INPUT, LabeledField, META, PanelButton, PanelSection, PanelShell, Problem, SwitchRow } from './panelParts';

type Level = 'fine' | 'close' | 'over';
const CLOSE_AT = 80;
const BAR = 'h-2 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-tertiary)] [&::-webkit-progress-value]:rounded-full [&::-moz-progress-bar]:rounded-full';
const BAR_TONE: Record<Level, string> = {
    fine: '[&::-webkit-progress-value]:bg-[var(--text-primary)] [&::-moz-progress-bar]:bg-[var(--text-primary)]',
    close: '[&::-webkit-progress-value]:bg-[var(--warning)] [&::-moz-progress-bar]:bg-[var(--warning)]',
    over: '[&::-webkit-progress-value]:bg-[var(--error)] [&::-moz-progress-bar]:bg-[var(--error)]',
};

/** How much of the budget is used, in whole percent, and which of the three states that is. */
export function budgetState(spent: number, budget: number): { pct: number; level: Level } {
    const pct = Math.floor((spent / Math.max(0.01, budget)) * 100);
    return { pct, level: pct >= 100 ? 'over' : pct >= CLOSE_AT ? 'close' : 'fine' };
}

/** "50" or "12,50" as euros; empty is no limit (null), anything else that is no budget is undefined. */
function budgetOf(text: string): number | null | undefined {
    const clean = text.trim().replace(',', '.');
    if (clean === '') return null;
    const n = Number(clean);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

const euros = (n: number, locale: string): string => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

function levelText(level: Level, t: TranslateFn): string {
    if (level === 'over') return t('cowork_panels.org.limit_over', 'The limit is reached. New runs are refused and everyone sees a notice until you raise it or the month ends.');
    if (level === 'close') return t('cowork_panels.org.budget_close', 'Everyone sees a notice on their home page from 80%. At 100% new runs are refused.');
    return t('cowork_panels.org.budget_fine', 'Nobody sees a notice until 80% is used. At 100% new runs are refused.');
}

function BudgetMeter({ spent, budget }: { spent: number | null; budget: number }) {
    const { t, locale } = useTranslation();
    const used = spent !== null ? budgetState(spent, budget) : null;
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-org-budget" data-level={used?.level ?? 'unknown'}>
            <progress className={`${BAR} ${BAR_TONE[used?.level ?? 'fine']}`} max={100} value={Math.min(100, used?.pct ?? 0)} aria-label={t('cowork_panels.org.limit_meter', 'Used of the limit this month')} />
            <span className={META}>
                {used && spent !== null
                    ? t('cowork_panels.org.used', '{spent} of {budget} used this month ({pct}%).', { spent: euros(spent, locale), budget: euros(budget, locale), pct: used.pct })
                    : t('cowork_panels.org.spend_unknown', 'This month’s spend could not be read.')}
            </span>
            {used && <p className={`m-0 ${META}`}>{levelText(used.level, t)}</p>}
        </div>
    );
}

function BudgetSection({ policy, spent, saving, onSave }: { policy: OrgCoworkPolicy; spent: number | null; saving: boolean; onSave: (budget: number | null, done: () => void) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState<string | null>(null);
    const budget = policy.monthlyBudget ?? null;
    const shown = text ?? (budget === null ? '' : String(budget));
    const parsed = budgetOf(shown);
    return (
        <PanelSection title={t('cowork_panels.org.limit_heading', 'Monthly spending limit')}>
            <div className={CARD}>
                <LabeledField id="cowork-panels-budget" label={t('cowork_panels.org.limit_label', 'For all tasks together, in euros a month')}>
                    <div className="flex items-start gap-2">
                        <input id="cowork-panels-budget" className={INPUT} inputMode="decimal" value={shown} placeholder={t('cowork_panels.org.budget_none', 'No limit')} onChange={(e) => setText(e.target.value)} />
                        <PanelButton className="shrink-0 whitespace-nowrap" disabled={saving || text === null || parsed === undefined} onClick={() => { if (parsed !== undefined) onSave(parsed, () => setText(null)); }}>
                            {t('cowork_panels.org.limit_save', 'Save limit')}
                        </PanelButton>
                    </div>
                </LabeledField>
                {parsed === undefined && <p role="alert" className={ALERT}>{t('cowork_panels.org.budget_invalid', 'Fill in an amount above 0, or leave it empty for no limit.')}</p>}
                {budget !== null && <BudgetMeter spent={spent} budget={budget} />}
                {budget === null && <p className={`m-0 ${META}`}>{t('cowork_panels.org.limit_off', 'Without a limit, tasks keep running whatever they cost. Set one to be told at 80% and to stop new runs at 100%.')}</p>}
            </div>
        </PanelSection>
    );
}

function AppsSection({ policy, saving, onSave }: { policy: OrgCoworkPolicy; saving: boolean; onSave: (apps: string[]) => void }) {
    const { t } = useTranslation();
    const apps = useAppsCatalog().availableApps.filter((a) => !a.isStep);
    const allowed = policy.unattendedApps;
    const isOn = (id: string) => allowed === null || allowed.includes(id);
    const flip = (id: string) => {
        const base = allowed ?? apps.map((a) => a.id);
        onSave(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
    };
    return (
        <PanelSection title={t('cowork_panels.org.apps_ask_heading', 'Apps tasks may use without asking')}>
            <div className={CARD}>
                {apps.length === 0 && <p className={`m-0 ${META}`}>{t('cowork_panels.org.apps_none', 'No apps are connected yet.')}</p>}
                {apps.map((app) => (
                    <SwitchRow
                        key={app.id}
                        id={`cowork-panels-app-${app.id}`}
                        label={app.label}
                        sub={isOn(app.id) ? undefined : t('cowork_panels.org.app_off', 'Tasks may not use it while nobody is watching.')}
                        checked={isOn(app.id)}
                        disabled={saving}
                        onChange={() => flip(app.id)}
                    />
                ))}
            </div>
        </PanelSection>
    );
}

function RulesSection({ policy, saving, onSave }: { policy: OrgCoworkPolicy; saving: boolean; onSave: (patch: OrgPolicyPatch) => void }) {
    const { t } = useTranslation();
    return (
        <PanelSection title={t('cowork_panels.org.all_tasks_heading', 'For all tasks')}>
            <div className={CARD}>
                <SwitchRow id="cowork-panels-readonly" label={t('cowork_panels.org.read_only', 'Read-only mode')} sub={t('cowork_panels.org.read_only_sub', 'Tasks read and write drafts, but change and send nothing.')}
                    checked={policy.readOnly} disabled={saving} onChange={(readOnly) => onSave({ readOnly })} />
                <SwitchRow id="cowork-panels-autofix" label={t('cowork_panels.org.auto_fix', 'Automatic fixes')} sub={t('cowork_panels.org.auto_fix_sub', 'Cowork repairs a broken step by itself when the fix needs no new permission. The owner sees it and can undo it.')}
                    checked={policy.autoFix !== false} disabled={saving} onChange={(autoFix) => onSave({ autoFix })} />
                <SwitchRow id="cowork-panels-habits" label={t('cowork_panels.org.suggest', 'Allow “Suggest a task when I repeat a question”')} sub={t('cowork_panels.org.habits_sub', 'Each person still has to turn it on. You never see what it noticed.')}
                    checked={policy.habitsAllowed !== false} disabled={saving} onChange={(habitsAllowed) => onSave({ habitsAllowed })} />
            </div>
        </PanelSection>
    );
}

function AuditSection() {
    const { t, locale } = useTranslation();
    const audit = useReceiptsAudit();
    const result = audit.data;
    const count = (n: number) => n.toLocaleString(locale);
    return (
        <PanelSection title={t('cowork_panels.org.proof_heading', 'Proof of each run')}>
            <div className={CARD}>
                <div className={`flex items-start gap-2 ${BODY}`} role="status" data-testid="cowork-org-audit">
                    <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
                    <span>
                        {audit.isPending && t('cowork_panels.org.audit_busy', 'Checking every receipt…')}
                        {!audit.isPending && !result && t('cowork_panels.org.audit_idle', 'Check that no receipt of any task was changed or removed.')}
                        {result?.ok && t('cowork_panels.org.audit_ok', 'All {receipts} receipts of {items} tasks check out, checked just now.', { receipts: count(result.receipts), items: count(result.items) })}
                        {result && !result.ok && t('cowork_panels.org.audit_bad', '{problems} of {items} tasks have a receipt that does not check out, and {missing} runs have no receipt.', { problems: count(result.problems.length), items: count(result.items), missing: count(result.missing) })}
                    </span>
                </div>
                {result?.truncated && <p className={`m-0 ${META}`}>{t('cowork_panels.org.audit_truncated', 'There are more tasks than one check reads. Only the first ones were checked.')}</p>}
                <p className={`m-0 ${META}`}>{t('cowork_panels.org.audit_sub', 'Each run of each task leaves a signed receipt. The audit proves none was changed or removed afterwards.')}</p>
                <div className="flex flex-wrap gap-2">
                    <PanelButton look="secondary" disabled={audit.isPending} onClick={() => audit.mutate()}>{t('cowork_panels.org.audit_check', 'Check now')}</PanelButton>
                    <a className={`${BUTTON_SECONDARY} hover:bg-[var(--item-hover-bg)]`} href={receiptsAuditDownloadUrl()} download>
                        {t('cowork_panels.org.audit_export', 'Export the audit file')}
                    </a>
                </div>
                <Problem error={audit.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
            </div>
        </PanelSection>
    );
}

export default function CoworkOrgPanel() {
    const { t } = useTranslation();
    const overview = useCoworkOrgOverview();
    const { query, save } = useOrgCoworkPolicy(overview.data?.orgId);
    const policy = query.data;
    const tag = t('cowork_panels.org.admins_only', 'Admins only');
    const title = t('cowork_panels.org.rules_title', 'Admin rules');
    if (overview.isError) {
        return (
            <PanelShell testId="cowork-org-panel" tag={tag} title={title}>
                <p className={`m-0 ${META}`}>{t('cowork_panels.org.not_admin', 'Only administrators of your organisation can see and change these rules.')}</p>
            </PanelShell>
        );
    }
    return (
        <PanelShell testId="cowork-org-panel" tag={tag} title={title} meta={overview.data ? t('cowork_panels.org.meta', 'Rules for all tasks at {name}.', { name: overview.data.name }) : undefined}>
            {!policy && !query.isError && <p className={`m-0 ${META}`}>{t('cowork_panels.loading', 'Loading…')}</p>}
            <Problem error={query.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
            {policy && overview.data && (
                <>
                    <BudgetSection policy={policy} spent={overview.data.spent} saving={save.isPending} onSave={(monthlyBudget, done) => save.mutate({ monthlyBudget }, { onSuccess: done })} />
                    <AppsSection policy={policy} saving={save.isPending} onSave={(unattendedApps) => save.mutate({ unattendedApps })} />
                    <RulesSection policy={policy} saving={save.isPending} onSave={(patch) => save.mutate(patch)} />
                    <AuditSection />
                    <Problem error={save.error} fallback={t('cowork_panels.failed', 'That did not save. Try again.')} />
                </>
            )}
        </PanelShell>
    );
}
