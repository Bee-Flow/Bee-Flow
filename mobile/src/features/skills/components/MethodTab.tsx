/**
 * "Method" — what the skill does, when to use it, its steps, its rules, the
 * fields it delivers and what it may use (the web's SkillDetail MethodTab).
 *
 * One BlockList cell per step and per rule, so a long method is drawn a part
 * at a time. Every edit goes through the editor's `patch`, so the same
 * autosave carries a keystroke, a reorder and an AI fill-in.
 */

import React from 'react';

import type { UsageAnswer } from '@/core/api/usage';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { BlockList, type Block } from '@/shared/patterns';
import { Banner, TextField } from '@/shared/ui';

import { CanUseCard } from './CanUseCard';
import { FacetHead } from './FacetHead';
import { FillInCard } from './FillInCard';
import { OutputFieldsCard } from './OutputFieldsCard';
import { RuleRow } from './RuleRow';
import { SkillActiveToggle } from './SkillActiveToggle';
import { StepCard } from './StepCard';
import { UsedByNote } from './UsedByNote';
import type { PickerData } from '../hooks/usePickerData';
import type { SkillEditor } from '../hooks/useSkillEditor';
import { isBlankDraft } from '../model/aiDraft';
import { moveItem, newLocalId } from '../model/skillModel';
import { SKILL_INSTRUCTIONS_MAX, type Skill } from '../model/types';

export interface MethodTabProps {
    skill: Skill;
    editor: SkillEditor;
    picker: PickerData;
    usage: UsageAnswer | undefined;
    drafting: boolean;
    onFillIn: (sentence: string) => void;
    refreshing: boolean;
    onRefresh: () => void;
}

function textBlocks(t: TranslateFn, { editor, drafting, onFillIn }: MethodTabProps): Block[] {
    const { draft, patch, locked } = editor;
    const left = SKILL_INSTRUCTIONS_MAX - draft.instructions.length;
    const blocks: Block[] = [];
    if (locked) {
        blocks.push({ key: 'locked', gap: 'section', render: () => (
            <Banner tone="info" icon="Lock">
                {t('skills_studio.readonly', 'You can see this skill but not change it. Ask its owner, or an admin of the organisation it belongs to.')}
            </Banner>
        ) });
    }
    if (!locked && isBlankDraft(draft)) {
        blocks.push({ key: 'fill', gap: 'section', render: () => <FillInCard drafting={drafting} onFillIn={onFillIn} /> });
    }
    blocks.push({ key: 'what', gap: 'section', render: () => (
        <TextField label={t('skills_studio.what', 'What this skill does')} value={draft.description} editable={!locked} multiline maxLines={4}
            placeholder={t('skills_studio.field.description_placeholder', 'Short summary of what this skill does')}
            onChangeText={(description) => patch({ description })} />
    ) });
    blocks.push({ key: 'when', gap: 'inner', render: () => (
        <TextField label={t('skills_studio.when', 'When to use it')} value={draft.instructions} editable={!locked} multiline maxLines={8}
            maxLength={SKILL_INSTRUCTIONS_MAX}
            placeholder={t('skills_studio.field.instructions_placeholder', 'When and how the agent should use this skill (max 4000 chars)')}
            hint={left < SKILL_INSTRUCTIONS_MAX * 0.1 ? t('skills_studio.near_limit', '{count} characters left', { count: left }) : undefined}
            onChangeText={(instructions) => patch({ instructions })} />
    ) });
    return blocks;
}

function stepBlocks(t: TranslateFn, { editor, picker }: MethodTabProps): Block[] {
    const { draft, patch, locked } = editor;
    const steps = draft.steps;
    const head: Block = { key: 'steps', gap: 'section', render: () => (
        <FacetHead title={t('skills_studio.steps.title', 'Steps')} hint={t('mobile.skills.steps_hint', 'in this order')}
            empty={steps.length === 0 ? t('skills_studio.steps.empty', 'No steps yet. Write down what the agent should do, one step at a time.') : null}
            addLabel={t('skills_studio.steps.add', 'Add step')} testID="skill-step-add"
            onAdd={locked ? undefined : () => patch({ steps: [...steps, { id: newLocalId('step'), text: '', refs: [] }] })} />
    ) };
    return [head, ...steps.map((step, i): Block => ({ key: `step:${step.id}`, gap: 'inner', render: () => (
        <StepCard step={step} index={i} count={steps.length} readOnly={locked} picker={picker}
            onChange={(next) => patch({ steps: steps.map((s) => (s.id === step.id ? next : s)) })}
            onMove={(to) => patch({ steps: moveItem(steps, i, to) })}
            onRemove={() => patch({ steps: steps.filter((s) => s.id !== step.id) })} />
    ) }))];
}

function ruleBlocks(t: TranslateFn, { editor }: MethodTabProps): Block[] {
    const { draft, patch, locked } = editor;
    const rules = draft.rulesV2;
    const head: Block = { key: 'rules', gap: 'section', render: () => (
        <FacetHead title={t('skills_studio.rules.title', 'Rules')} hint={t('skills_studio.rules.hint', 'always, whatever the question')}
            empty={rules.length === 0 ? t('skills_studio.rules.empty', 'No rules yet. A rule holds for every answer this skill gives.') : null}
            addLabel={t('skills_studio.rules.add', 'Add rule')} testID="skill-rule-add"
            onAdd={locked ? undefined : () => patch({ rulesV2: [...rules, { id: newLocalId('rule'), polarity: 'must', text: '' }] })} />
    ) };
    return [head, ...rules.map((rule): Block => ({ key: `rule:${rule.id}`, gap: 'inner', render: () => (
        <RuleRow rule={rule} readOnly={locked}
            onChange={(next) => patch({ rulesV2: rules.map((r) => (r.id === rule.id ? next : r)) })}
            onRemove={() => patch({ rulesV2: rules.filter((r) => r.id !== rule.id) })} />
    ) }))];
}

function tailBlocks(p: MethodTabProps): Block[] {
    const { draft, patch, locked } = p.editor;
    const dynamic = draft.dynamicActivation || Boolean(p.skill.automationId);
    return [
        { key: 'output', gap: 'section', render: () => (
            <OutputFieldsCard schema={draft.outputSchema} readOnly={locked} onChange={(outputSchema) => patch({ outputSchema }, true)} />
        ) },
        { key: 'canuse', gap: 'section', render: () => (
            <CanUseCard draft={draft} picker={p.picker} legacyAutomationId={p.skill.automationId} readOnly={locked} onChange={(next) => patch(next, true)} />
        ) },
        { key: 'active', gap: 'section', render: () => <SkillActiveToggle skillId={p.skill.id} dynamic={dynamic} /> },
        { key: 'note', gap: 'section', render: () => <UsedByNote usage={p.usage} /> },
    ];
}

export function MethodTab(p: MethodTabProps) {
    const t = useTranslation();
    const blocks = [...textBlocks(t, p), ...stepBlocks(t, p), ...ruleBlocks(t, p), ...tailBlocks(p)];
    return <BlockList blocks={blocks} refreshing={p.refreshing} onRefresh={p.onRefresh} testID="skill-method" />;
}
