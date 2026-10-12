import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import {
    ackKey, acksOf, isNoop, needsNameConfirm, settingsLinkFor, summarizeParts,
} from './pipelineModel';
import { findingText } from './StageStatus';
import { useStageLabel } from './StageSwitcher';
import type { Plan, PlanAck, StageKey } from './stagesApi';

/** The body of the deploy dialog: every section of a plan, in reading order. */

export const ROW = 'px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]';

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-1.5" data-testid={`deploy-section-${id}`}>
            <h4 className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{title}</h4>
            {children}
        </section>
    );
}

// ── The sections of a plan ───────────────────────────────────────────────────

export interface PlanViewProps {
    plan: Plan;
    stage: StageKey;
    solutionName: string;
    typed: string;
    onTyped: (v: string) => void;
    ackBox: (a: PlanAck) => React.ReactNode;
    onOpenSettings?: (stage: StageKey) => void;
}

function PartsSection({ plan }: { plan: Plan }) {
    const { t } = useTranslation();
    const parts = summarizeParts(plan);
    const words: Record<string, string> = {
        create: t('solution_stages.part_create', 'New'), replace: t('solution_stages.part_replace', 'Changed'),
        retire: t('solution_stages.part_retire', 'Retired'), revive: t('solution_stages.part_revive', 'Back again'),
        remove: t('solution_stages.part_remove', 'Removed'),
    };
    const changed = plan.parts.filter(p => p.action !== 'unchanged');
    return (
        <Section id="changes" title={t('solution_stages.sec_changes', 'What changes')}>
            {isNoop(plan) ? <p className={ROW}>{t('solution_stages.nothing_changes', 'Nothing changes: this stage already runs exactly this release.')}</p> : (
                <ul className="space-y-1">
                    {changed.map(p => (
                        <li key={p.ref} className={`flex items-baseline gap-2 flex-wrap ${ROW}`} data-testid="deploy-part" data-action={p.action}>
                            <span className="text-[11px] uppercase text-[var(--text-tertiary)]">{words[p.action] || p.action}</span>
                            <span>{p.name || p.ref}</span>
                            {p.summary && <span className="text-xs text-[var(--text-secondary)]">{p.summary}</span>}
                            {p.goesLive === false && p.action !== 'retire' && <span className="text-xs text-[var(--text-tertiary)]">{t('solution_stages.arrives_off', 'arrives switched off')}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {parts.unchanged > 0 && <p className="text-xs text-[var(--text-tertiary)]">{t('solution_stages.unchanged_n', '{count} parts stay as they are.', { count: parts.unchanged })}</p>}
        </Section>
    );
}

function DataSection({ plan, ackBox, nameOf }: { plan: Plan; ackBox: PlanViewProps['ackBox']; nameOf: (ref: string) => string }) {
    const { t } = useTranslation();
    const acks = acksOf(plan);
    return (
        <Section id="data" title={t('solution_stages.sec_data', 'Data')}>
            {plan.data.map(d => (
                <div key={d.ref} className={`space-y-1 ${ROW}`} data-testid="deploy-data">
                    <p className="font-medium">{d.name || d.ref}</p>
                    {d.add.length > 0 && <p className="text-xs text-[var(--text-secondary)]">{t('solution_stages.data_add', 'Adds columns: {list}', { list: d.add.join(', ') })}</p>}
                    {d.rename.length > 0 && <p className="text-xs text-[var(--text-secondary)]">{t('solution_stages.data_rename', 'Renames: {list}', { list: d.rename.map(r => `${r.from} → ${r.to}`).join(', ') })}</p>}
                    {d.unretire.length > 0 && <p className="text-xs text-[var(--text-secondary)]">{t('solution_stages.data_unretire', 'Brings back: {list}', { list: d.unretire.join(', ') })}</p>}
                    {d.retire.map(r => (
                        <p key={r.key} className="text-xs text-[var(--text-secondary)]" data-testid="deploy-retire">
                            {t('solution_stages.data_retire', 'Retires column {key}. Its data is kept.', { key: r.key })}
                            {(r.relaxes?.notNull || r.relaxes?.unique || r.relaxes?.fk) && ` ${t('solution_stages.data_relaxes', 'Its required, unique and link rules are relaxed so new rows can still be saved.')}`}
                        </p>
                    ))}
                    {d.blocked.map(b => <p key={`${b.code}:${b.key}`} className="text-xs text-[var(--error)]">{t('solution_stages.data_blocked', 'Cannot be applied: {code} {key}', { code: b.code, key: b.key || '' })}</p>)}
                    {acks.filter(a => isDataAck(plan, a) && a.ref === d.ref).map(ackBox)}
                </div>
            ))}
            {plan.referenceRows.filter(r => r.insert || r.update || r.delete).map(r => (
                <p key={r.ref} className={ROW}>{t('solution_stages.reference_rows', 'Reference rows of {name}: {insert} added, {update} changed, {delete} removed.', { name: nameOf(r.ref), insert: r.insert, update: r.update, delete: r.delete })}</p>
            ))}
        </Section>
    );
}

const isDataAck = (plan: Plan, a: PlanAck) => ['privacy.no_lawful_basis', 'schema.retire_column'].includes(a.code) && plan.data.some(d => d.ref === a.ref);
const isKbAck = (plan: Plan, a: PlanAck) => a.code === 'kb.personal_data' && plan.knowledge.some(k => k.ref === a.ref);

function KnowledgeSection({ plan, ackBox, nameOf }: { plan: Plan; ackBox: PlanViewProps['ackBox']; nameOf: (ref: string) => string }) {
    const { t } = useTranslation();
    return (
        <Section id="knowledge" title={t('solution_stages.sec_knowledge', 'Knowledge')}>
            {plan.knowledge.map(k => (
                <div key={k.ref} className={`space-y-1.5 ${ROW}`} data-testid="deploy-knowledge">
                    <p>{t('solution_stages.knowledge_line', '{name}: {copy} documents copied, {remove} removed, {unchanged} unchanged.', { name: nameOf(k.ref), copy: k.copy, remove: k.remove, unchanged: k.unchanged })}</p>
                    {acksOf(plan).filter(a => isKbAck(plan, a) && a.ref === k.ref).map(ackBox)}
                </div>
            ))}
        </Section>
    );
}

function SettingsSection({ plan, stage, onOpenSettings }: { plan: Plan; stage: StageKey; onOpenSettings?: (s: StageKey) => void }) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    return (
        <Section id="settings" title={t('solution_stages.sec_settings', 'Settings still missing')}>
            <ul className="space-y-1">
                {plan.bindings.missing.map(b => <li key={b.slot} className={ROW} data-testid="deploy-missing">{b.label || b.slot}</li>)}
                {plan.variables.missing.map(n => <li key={`m:${n}`} className={ROW} data-testid="deploy-missing">{t('solution_stages.var_missing', 'Variable {name} has no value', { name: n })}</li>)}
                {plan.variables.invalid.map(n => <li key={`i:${n}`} className={ROW} data-testid="deploy-missing">{t('solution_stages.var_invalid', 'Variable {name} has a value that does not fit', { name: n })}</li>)}
            </ul>
            <a
                href={settingsLinkFor(stage)} data-testid="deploy-open-settings"
                onClick={(e) => { if (onOpenSettings) { e.preventDefault(); onOpenSettings(stage); } }}
                className="inline-block text-sm underline text-[var(--text-primary)]"
            >
                {t('solution_stages.open_stage_settings', 'Open the settings of {stage}', { stage: stageName(stage) })}
            </a>
        </Section>
    );
}

export function PlanView({ plan, stage, solutionName, typed, onTyped, ackBox, onOpenSettings }: PlanViewProps) {
    const { t } = useTranslation();
    const nameOf = (ref: string): string => plan.parts.find(p => p.ref === ref)?.name || plan.data.find(d => d.ref === ref)?.name || ref;
    const rest = acksOf(plan).filter(a => !isDataAck(plan, a) && !isKbAck(plan, a));
    const settingsOpen = plan.bindings.missing.length + plan.variables.missing.length + plan.variables.invalid.length > 0;
    return (
        <>
            {plan.blocking.length > 0 && (
                <Section id="blocking" title={t('solution_stages.sec_blocking', 'Has to be solved first')}>
                    <ul className="space-y-1.5">
                        {plan.blocking.map((f, i) => (
                            <li key={`${f.code}:${f.ref ?? i}`} className={`flex items-start gap-2 ${ROW}`}>
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--error)]" aria-hidden="true" />
                                <span>{findingText(t, f)}</span>
                            </li>
                        ))}
                    </ul>
                </Section>
            )}
            <PartsSection plan={plan} />
            {(plan.data.length > 0 || plan.referenceRows.length > 0) && <DataSection plan={plan} ackBox={ackBox} nameOf={nameOf} />}
            {plan.knowledge.length > 0 && <KnowledgeSection plan={plan} ackBox={ackBox} nameOf={nameOf} />}
            {settingsOpen && <SettingsSection plan={plan} stage={stage} onOpenSettings={onOpenSettings} />}
            {plan.variables.steeringPending.length > 0 && (
                <Section id="steering" title={t('solution_stages.sec_steering', 'Values that apply with this deployment')}>
                    <p className="text-xs text-[var(--text-secondary)]">{t('solution_stages.steering_hint', 'These values decide where data goes or who is told. They only take effect when this is deployed.')}</p>
                    <ul className="space-y-1">{plan.variables.steeringPending.map(n => <li key={n} className={ROW} data-testid="deploy-steering">{n}</li>)}</ul>
                </Section>
            )}
            {plan.differsFromUat.length > 0 && (
                <Section id="differs" title={t('solution_stages.sec_differs', 'Different from UAT')}>
                    <ul className="space-y-1">{plan.differsFromUat.map(d => <li key={`${d.kind}:${d.label}`} className={ROW} data-testid="deploy-differs">{d.label}</li>)}</ul>
                </Section>
            )}
            {plan.gates.approval !== 'not_required' && (
                <Section id="approval" title={t('solution_stages.sec_approval', 'Approval')}>
                    <p className={ROW} data-testid="deploy-approval">
                        {plan.gates.approval === 'approved'
                            ? t('solution_stages.approval_approved', 'This has been approved.')
                            : t('solution_stages.approval_required', 'Production needs approval first. Pressing the button asks the approvers; nothing changes until they agree.')}
                    </p>
                </Section>
            )}
            {rest.length > 0 && <Section id="agree" title={t('solution_stages.sec_agree', 'Needs your agreement')}>{rest.map(ackBox)}</Section>}
            {needsNameConfirm(stage) && (
                <Section id="confirm" title={t('solution_stages.sec_confirm', 'Confirm')}>
                    <label className="block text-sm text-[var(--text-primary)]">
                        {t('solution_stages.type_name', 'Type {name} to confirm', { name: solutionName })}
                        <input
                            value={typed} onChange={(e) => onTyped(e.target.value)} data-testid="deploy-confirm-name" autoComplete="off"
                            className="mt-1 w-full px-3 py-2 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                        />
                    </label>
                </Section>
            )}
        </>
    );
}
