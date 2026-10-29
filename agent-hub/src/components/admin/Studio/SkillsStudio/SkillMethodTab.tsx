import CanUseCard from './CanUseCard';
import FillInCard from './FillInCard';
import OutputFieldsCard from './OutputFieldsCard';
import RulesEditor from './RulesEditor';
import SkillStepEditor from './SkillStepEditor';
import { nOf } from '../KnowledgeStudio/plural';
import type { MethodTabProps, UsedByNoteProps, TextCardProps } from './SkillDetail.types';

/**
 * The "Method" tab of the skill editor, the standing Used-by note in its
 * right rail and the text card it is built from. Moved out of
 * SkillDetail.tsx verbatim.
 */

const INSTRUCTION_LIMIT = 4000;

export function MethodTab({ draft, patch, readOnly, refOptions, onOpenRef, picker, legacyAutomationId, usage, unchecked, onFillIn, drafting, t }: MethodTabProps) {
    const near = draft.instructions.length / INSTRUCTION_LIMIT > 0.9;
    const empty = draft.steps.length === 0 && draft.rulesV2.length === 0 && !draft.instructions.trim();
    return (
        <div className="flex flex-col gap-[18px] min-w-0">
            {empty && !readOnly && <FillInCard onFillIn={onFillIn} drafting={drafting} t={t} />}
            <div className="grid gap-3.5 [grid-template-columns:1fr_1fr]">
                <TextCard
                    label={t('skills_studio.what', 'What this skill does')}
                    value={draft.description}
                    readOnly={readOnly}
                    onChange={(description) => patch({ description })}
                    placeholder={t('skills_studio.field.description_placeholder', 'Short summary of what this skill does')}
                />
                <TextCard
                    label={t('skills_studio.when', 'When to use it')}
                    value={draft.instructions}
                    readOnly={readOnly}
                    muted
                    maxLength={INSTRUCTION_LIMIT}
                    onChange={(instructions) => patch({ instructions: instructions.slice(0, INSTRUCTION_LIMIT) })}
                    placeholder={t('skills_studio.field.instructions_placeholder', 'When and how the agent should use this skill (max 4000 chars)')}
                    hint={near
                        ? t('skills_studio.near_limit', '{count} characters left', { count: INSTRUCTION_LIMIT - draft.instructions.length })
                        : null}
                />
            </div>

            <div className="grid gap-3.5 min-w-0 [grid-template-columns:minmax(0,1fr)_380px]">
                <SkillStepEditor
                    steps={draft.steps}
                    readOnly={readOnly}
                    refOptions={refOptions}
                    // `refOptions` is three arrays, and three arrays cannot say
                    // "that list 500'd". A step reference is a GRANT, so the
                    // menu needs the same three-way answer the card below uses.
                    listStatus={picker}
                    onOpenRef={onOpenRef}
                    onChange={(steps) => patch({ steps })}
                />
                <div className="flex flex-col gap-4 min-w-0">
                    <RulesEditor
                        rules={draft.rulesV2}
                        readOnly={readOnly}
                        onChange={(rulesV2) => patch({ rulesV2 })}
                    />
                    <OutputFieldsCard
                        outputSchema={draft.outputSchema}
                        readOnly={readOnly}
                        onChange={(outputSchema) => patch({ outputSchema })}
                    />
                    <CanUseCard
                        enabledIntegrations={draft.enabledIntegrations}
                        allowedAutomationIds={draft.allowedAutomationIds}
                        knowledgeBaseIds={draft.knowledgeBaseIds}
                        dynamicActivation={draft.dynamicActivation}
                        legacyAutomationId={legacyAutomationId}
                        automations={picker.automations}
                        knowledgeBases={picker.knowledgeBases}
                        // The same reading of "did those lists arrive" the
                        // pickers above use, so the card can tell an empty
                        // org from a list it never managed to read.
                        listStatus={picker}
                        readOnly={readOnly}
                        onChange={(next) => patch(next, true)}
                    />
                    <UsedByNote usage={usage} unchecked={unchecked} t={t} />
                </div>
            </div>
        </div>
    );
}

function UsedByNote({ usage, unchecked = [], t }: UsedByNoteProps) {
    if (!Array.isArray(usage)) return null;
    // A 200 can ALSO be a "not known": the server answers `{ usage, unchecked }`
    // and a kind named there is one nobody scanned. `knownUsage` folds only the
    // ERROR into null, so that 200 arrived here looking like a complete answer —
    // and this is the sentence that would then be wrong.
    const incomplete = Array.isArray(unchecked) && unchecked.length > 0;
    if (incomplete) {
        return (
            <p
                className="mt-auto px-3 py-2.5 rounded-[10px] text-[11px] leading-4 m-0 [background:var(--bg-secondary)] [color:var(--warning-ink,var(--warning))]!"
                data-testid="skill-usedby-note"
                data-incomplete="true"
            >
                {t('skills_studio.usage.partial', 'Not everything could be checked, so this list may be short. A change here applies everywhere at once.')}
            </p>
        );
    }
    return (
        <p
            className="mt-auto px-3 py-2.5 rounded-[10px] text-[11px] leading-4 m-0 bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            data-testid="skill-usedby-note"
        >
            {usage.length === 0
                ? t('skills_studio.usage.empty', 'No agent or automation uses this skill yet.')
                : nOf(
                    t, 'skills_studio.usage.note', usage.length,
                    'Used by {count} agent or automation. A change here applies everywhere at once.',
                    'Used by {count} agents and automations. A change here applies everywhere at once.',
                )}
        </p>
    );
}

function TextCard({ label, value, onChange, readOnly, placeholder, muted = false, hint = null, maxLength }: TextCardProps) {
    return (
        <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
            <textarea
                value={value}
                readOnly={readOnly}
                rows={3}
                maxLength={maxLength}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2.5 text-[13px] leading-[18px] outline-none placeholder:text-[var(--text-tertiary)]"
                style={{ color: muted ? 'var(--text-secondary)' : 'var(--text-primary)' }}
            />
            {hint && <span className="text-xs text-[var(--warning-ink)]">{hint}</span>}
        </label>
    );
}
