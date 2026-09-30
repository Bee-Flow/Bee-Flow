/**
 * The code step — the web's CodeFields (actionEditors/codeFields.tsx, with
 * codeStep/CodeSourceBlock and codeStep/ReachPanel): the
 * sandbox's contract in words above the code, the code itself in a
 * monospace box (the web's "Plain text" editor — a phone has no Monaco), the
 * inputs the code is handed, and a panel that reads the code back and names
 * what this step will reach when it runs. Where the server says a code step
 * would be refused for this caller, that sentence leads the editor.
 */

import React, { useMemo } from 'react';
import { TextInput, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FieldRow, RowsEditor } from '@/features/flow-editor/components/fields';
import { Icon, Text, type IconName } from '@/shared/ui';

import { codeInputsRoundTrip, codeRefusal, readCodeContract, type CodeContract } from './codeModel';
import { say } from '../declarative/runtime';
import { FOR_EACH, repeatsOrRetries, RETRY } from '../declarative/specs/common';
import { Band } from '../shared/Band';
import { recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import { SpecFields } from '../shared/SpecFields';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';

function Line({ icon, warn = false, children }: { icon: IconName; warn?: boolean; children: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.line}>
            <Icon name={icon} size={12} color={warn ? styles.warn.color : styles.glyph.color} />
            <Text variant="caption" tone={warn ? 'warning' : 'tertiary'} style={styles.grow}>
                {children}
            </Text>
        </View>
    );
}

function inputsLine(t: ReturnType<typeof useTranslation>, c: CodeContract, editable: boolean): string {
    const more = c.computedInputs ? t('code_step.reach.and_more', ', and more, looked up by a name this panel cannot read.') : '.';
    const head = c.inputNames.length
        ? `${t('code_step.reach.reads_inputs', 'Reads these step inputs:')} ${c.inputNames.join(', ')}${more}`
        : c.computedInputs
          ? t('code_step.reach.reads_computed', 'Reads step inputs by a name this panel cannot read.')
          : t('code_step.reach.reads_none', 'Reads no step inputs.');
    const tail =
        !editable && (c.inputNames.length > 0 || c.computedInputs)
            ? ` ${t('code_step.reach.inputs_unsettable', "They come from the step's own inputs, which this editor cannot set yet. The AI that wrote this step does.")}`
            : '';
    return head + tail;
}

/** "What this step may reach": every claim mirrors codeSandbox.js and execCode. */
function ReachPanel({ contract, inputsEditable }: { contract: CodeContract; inputsEditable: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const reachesOut = contract.usesHttp || contract.toolNames.length > 0;
    return (
        <View style={styles.panel}>
            <Text variant="label" tone="tertiary">
                {t('code_step.reach.title', 'What this step may reach')}
            </Text>
            <Line icon="Lock">
                {t('code_step.reach.sandbox', 'A sandbox of its own: no files, no Node, no network of its own.') +
                    (reachesOut ? ` ${t('code_step.reach.ways_out', 'The lines below are the ways out this code does use.')}` : '')}
            </Line>
            <Line icon="KeyRound">{inputsLine(t, contract, inputsEditable)}</Line>
            {contract.usesHttp ? <Line icon="Globe">{t('code_step.reach.http', 'The web, over ctx.http(): HTTPS only, never a private or internal address, 5 calls per run and 10 seconds each.')}</Line> : null}
            {contract.toolNames.length ? (
                <Line icon="Plug">
                    {`${t('code_step.reach.tools', 'Connected apps:')} ${contract.toolNames.join(', ')}. ${t(
                        'code_step.reach.tools_refused',
                        'Each call is refused at run time unless this step is allowed to use that app and you still hold that permission.',
                    )}`}
                </Line>
            ) : null}
            {contract.usesLog ? <Line icon="ScrollText">{t('code_step.reach.log', 'Writes to the run log with ctx.log(), where anyone who can see this run can read it.')}</Line> : null}
            {contract.usesSecrets ? (
                <Line icon="TriangleAlert" warn>
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English copy, which names the ctx.secrets() API; not a secret */}
                    {t(
                        'code_step.reach.secrets',
                        'ctx.secrets() is not wired in this build: every call throws, and a step that declares secretKeys refuses to run at all. Pass the value in as a step input, or use a connected app that carries its own credentials.',
                    )}
                </Line>
            ) : null}
        </View>
    );
}

export function CodeEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { draft, set, ctx } = editor;
    const code = typeof draft.code === 'string' ? draft.code : '';
    const contract = useMemo(() => readCodeContract(code), [code]);
    const inputsEditable = useMemo(() => codeInputsRoundTrip(), []);
    const refusal = codeRefusal(ctx.catalog?.flags);
    return (
        <>
            <Band editor={editor} sectionKey="code" title={t('mobile.flow.code.code', 'Code')} defaultOpen>
                {refusal ? <Warn>{say(t, refusal)}</Warn> : null}
                <Note>
                    {t(
                        'code_step.contract',
                        'Runs in a sandbox: write async function main(inputs, ctx) and return the result. ctx.log(…) writes to the run, ctx.http(url, opts) fetches over HTTPS only, and ctx.integrations.<tool>(args) calls a connected app this step has been granted. Budget per run: ~1s of processing, 5s of wall clock, 64 MB and 5 HTTP calls.',
                    )}
                </Note>
                <FieldRow label={t('code_step.editor.label', 'JavaScript code')}>
                    <TextInput
                        value={code}
                        onChangeText={(v) => set('code', v)}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        editable={!ctx.disabled}
                        textAlignVertical="top"
                        accessibilityLabel={t('code_step.editor.label', 'JavaScript code')}
                        style={styles.code}
                        testID="code-source"
                    />
                </FieldRow>
                {inputsEditable ? (
                    <RowsEditor
                        label={t('mobile.flow.section.inputs', 'Inputs')}
                        hint={t('code_step.inputs.hint', 'Named values handed to your code as inputs. Bind them to earlier steps the same way every other step type does.')}
                        value={recordOf(draft.inputs)}
                        onChange={(next) => set('inputs', next)}
                        keepEmpty
                        disabled={ctx.disabled}
                        testID="code-inputs"
                    />
                ) : null}
                <ReachPanel contract={contract} inputsEditable={inputsEditable} />
            </Band>
            <Band
                editor={editor}
                sectionKey="advanced"
                title={t('mobile.flow.section.advanced', 'Advanced')}
                defaultOpen={repeatsOrRetries(draft, { ...ctx, step: editor.step })}
                hasContent={repeatsOrRetries(draft, { ...ctx, step: editor.step })}
            >
                <SpecFields editor={editor} fields={[FOR_EACH, RETRY]} />
            </Band>
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    code: {
        ...theme.type.code,
        minHeight: 14 * 20,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
        color: theme.colors.textPrimary,
    } satisfies TextStyle,
    panel: {
        gap: theme.spacing.xs,
        padding: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    line: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs } satisfies ViewStyle,
    grow: { flex: 1 },
    glyph: { color: theme.colors.textTertiary },
    warn: { color: theme.colors.warning },
});
