/**
 * "Who does the thinking" — the web's AgentStepFields (agentStepFields.jsx):
 * which agent (or this step, on its own prompt), what that agent may do here
 * (three switches, all off by default), what it would actually bring, and the
 * step's skills. An agent that cannot be picked is still listed, with the
 * reason; a step naming an agent that is no longer listed keeps it, selected;
 * a list that could not be read says so rather than looking empty.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { CatalogAgent } from '@/features/flow-editor/api';
import { FieldRow, ToggleField } from '@/features/flow-editor/components/fields';
import { AI_STEP_AGENT_PERMISSION_KEYS } from '@/features/flow-editor/formState';
import { OptionRow } from '@/shared/ui';

import { say } from '../declarative/runtime';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';
import { AgentCapsule } from './AgentCapsule';
import { agentReason, agentRowsOf, chooseAgent, permissionWords, setPermission, toolApps } from './aiModel';
import { SkillChooser } from './SkillChooser';

function AgentChooser({ rows, agentId, onPick, disabled }: { rows: CatalogAgent[] | null; agentId: string | null; onPick: (id: string | null) => void; disabled: boolean }) {
    const t = useTranslation();
    const listed = (rows || []).some((a) => a.id === agentId);
    return (
        <>
            <OptionRow
                label={t('routine_editor.agent_none_label', 'This step, on its own prompt')}
                description={t('routine_editor.agent_none_hint', 'No agent — the prompt below is the whole instruction.')}
                selected={!agentId}
                onPress={() => onPick(null)}
                disabled={disabled}
            />
            {agentId && !listed ? (
                <OptionRow
                    label={agentId}
                    description={t(
                        'routine_editor.agent_unlisted_hint',
                        'This step runs on this agent, and it is not in the list above. Pick another one, or leave it and the step will say so when it runs.',
                    )}
                    selected
                    onPress={() => undefined}
                />
            ) : null}
            {(rows || []).map((a) => (
                <OptionRow
                    key={a.id}
                    label={a.scope === 'personal' ? `${a.name} · ${t('routine_editor.agent_scope_personal', 'Personal')}` : a.name}
                    description={!a.canUse ? say(t, agentReason(a.reason)) : a.description || undefined}
                    selected={agentId === a.id}
                    onPress={() => onPick(a.id)}
                    disabled={disabled || !a.canUse}
                    testID={`agent-${a.id}`}
                />
            ))}
            {rows === null ? (
                <Warn>
                    {t(
                        'routine_editor.agent_list_unreadable',
                        'The list of agents could not be read, so it is not shown. That is not the same as having none — try again in a moment. A step that already names an agent keeps it.',
                    )}
                </Warn>
            ) : null}
            {rows !== null && rows.length === 0 ? <Note>{t('routine_editor.agent_list_empty', 'No agents yet — build one under Agents first.')}</Note> : null}
        </>
    );
}

export function AgentFields(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, setMany, ctx } = editor;
    const agentId = typeof draft.agentId === 'string' && draft.agentId ? draft.agentId : null;
    const permissions = (draft.agentPermissions as Record<string, boolean> | undefined) ?? {};
    return (
        <>
            <FieldRow
                label={t('routine_editor.agent_field_label', 'Which agent')}
                hint={t(
                    'routine_editor.agent_field_hint',
                    "An agent brings its published role, its knowledge and its tools to this step. Leave it on 'This step' and the step answers on its own prompt, exactly as before.",
                )}
            >
                <AgentChooser rows={agentRowsOf(ctx.catalog)} agentId={agentId} onPick={(id) => setMany(chooseAgent(id))} disabled={ctx.disabled} />
            </FieldRow>
            {agentId ? (
                <FieldRow
                    label={t('routine_editor.agent_permissions_label', 'What the agent may do here')}
                    hint={t(
                        'routine_editor.agent_permissions_hint',
                        'Off by default, all three. A routine runs without anyone watching, so the agent gets its role and its skills and nothing that reaches outside this step until you say so.',
                    )}
                >
                    {AI_STEP_AGENT_PERMISSION_KEYS.map((key) => {
                        const words = permissionWords(key);
                        return (
                            <ToggleField
                                key={key}
                                value={permissions[key] === true}
                                onChange={(on) => setMany(setPermission(draft, key, on))}
                                label={say(t, words.label)}
                                description={say(t, words.hint)}
                                disabled={ctx.disabled}
                            />
                        );
                    })}
                </FieldRow>
            ) : null}
            {agentId ? (
                <AgentCapsule agentId={agentId} permissions={permissions} allowList={Array.isArray(draft.tools) ? (draft.tools as string[]) : null} apps={toolApps(ctx.catalog)} />
            ) : null}
            <SkillChooser {...editor} />
        </>
    );
}
