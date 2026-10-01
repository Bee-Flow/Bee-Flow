/**
 * A value per placeholder — the web's "Values" band (FillDocumentFields).
 * The rows are not a fixed form: they are the holes the picked document
 * actually has, named as the document names them, so an author binds what
 * the invoice will print instead of discovering a typo on paper. A list
 * placeholder says what binding it takes (one whole list, nothing around
 * it); a parameter with instructions carries them under its row.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DocumentParameter } from '@/features/flow-editor/api';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';

import { exampleText, placeholderHint, placeholderPrompt, shownValue, typedPlaceholderValue } from './fillDocumentModel';
import { say } from '../declarative/runtime';
import { Band } from '../shared/Band';
import { recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

/** The instructions under a row whose hint already shows its summary, and the example the contract gives. */
function Instructions({ p }: { p: DocumentParameter }) {
    const t = useTranslation();
    const instructions = p.summary && p.instructions ? p.instructions : '';
    if (!instructions && p.example === undefined) return null;
    return (
        <>
            {instructions ? <Note>{`${t('mobile.flow.fill.instructions', 'Instructions')}: ${instructions}`}</Note> : null}
            {p.example !== undefined ? <Note>{t('mobile.flow.fill.example', 'Example: {value}', { value: exampleText(p.example) })}</Note> : null}
        </>
    );
}

export function PlaceholderValues({ editor, placeholders }: { editor: StepEditorProps; placeholders: readonly DocumentParameter[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { draft, set, ctx } = editor;
    const values = recordOf(draft.values);
    return (
        <Band editor={editor} sectionKey="values" title={t('routines.versions.setting.values', 'Values')} defaultOpen hasContent={Object.keys(values).length > 0}>
            {!draft.documentId ? <Note>{t('mobile.flow.fill.pick_first', 'Pick a document first — its placeholders appear here.')}</Note> : null}
            {placeholders.map((p) => (
                <View key={p.key} style={styles.row}>
                    <BindingInput
                        mode="template"
                        label={p.label || p.key}
                        required={p.required}
                        hint={say(t, placeholderHint(p)) || null}
                        value={shownValue(values[p.key])}
                        onChange={(next) => set('values', { ...values, [p.key]: typeof next === 'string' ? typedPlaceholderValue(p, next) : next })}
                        prompt={readableExample(placeholderPrompt(p))}
                        disabled={ctx.disabled}
                        testID={`fill-value-${p.key}`}
                    />
                    <Instructions p={p} />
                </View>
            ))}
        </Band>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { gap: theme.spacing.xs } satisfies ViewStyle,
});
