/**
 * Writing a step's output by hand — the web's OutputEditorPanel (BFSF-408):
 * so the steps after this one can be built and tested before it has ever
 * run. An explicit Save, never a save per keystroke; checked before it is
 * saved (outputEdit.ts), with the reason when it is refused.
 *
 * Nobody should have to type braces on a phone keyboard to do this, so the
 * face is the web's field list (OutputFieldsEditor): named fields with a
 * kind and a value each, a card per record for a list, one box for a single
 * value. The JSON is demoted, never deleted: one disclosure away, and open by
 * itself for a shape the list cannot honestly show (a list of words, a mixed
 * list, text that is not JSON yet). Both faces write the ONE text Save
 * parses, so the same checks and the same size cap apply whichever was used.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { outputShape } from '@/features/flow-editor/formState/outputDrafts';
import { Banner, Button, Icon, Text, TextField } from '@/shared/ui';

import { checkOutputText } from './outputEdit';
import { parseOutputText } from './outputFields';
import { OutputFieldsEditor } from './OutputFieldsEditor';

export interface OutputEditorProps {
    seed: string;
    canRemove: boolean;
    onSave: (value: unknown) => void;
    onRemove: () => void;
    onCancel: () => void;
}

function JsonDisclosure({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            style={({ pressed }) => [styles.disclosure, pressed ? styles.pressed : null]}
            testID="output-raw-toggle"
        >
            <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} color={styles.glyph.color} />
            <Text variant="caption" tone="secondary" weight="medium">
                {t('automations.builder.json_view_open', 'Edit as JSON')}
            </Text>
        </Pressable>
    );
}

export function OutputEditor({ seed, canRemove, onSave, onRemove, onCancel }: OutputEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useState(seed);
    const [error, setError] = useState<string | null>(null);
    const [rawOpen, setRawOpen] = useState(false);
    const shape = outputShape(parseOutputText(text));
    // Open by itself on a shape the list cannot show: there the JSON is the
    // only editor. And it stays open once it did — the author is typing in it,
    // and the box must not vanish under the caret the moment the text becomes
    // a shape the list can show.
    if (!shape && !rawOpen) setRawOpen(true);
    const rawShown = rawOpen || !shape;
    const change = (next: string) => {
        setText(next);
        setError(null);
    };
    const save = () => {
        const checked = checkOutputText(text);
        if (!checked.ok) {
            setError(checked.error);
            return;
        }
        onSave(checked.value);
    };
    return (
        <View style={styles.box} testID="output-editor">
            <Text variant="caption" tone="tertiary">
                {t(
                    'automations.ndv.output_editor_hint',
                    'What the steps after this one should see. Saved with the automation and replayed instead of running this step — so it is a stand-in for real data, not a note.',
                )}
            </Text>
            {shape ? <OutputFieldsEditor shape={shape} text={text} onChange={change} /> : null}
            {shape ? <JsonDisclosure open={rawOpen} onToggle={() => setRawOpen((o) => !o)} /> : null}
            {rawShown ? (
                <TextField
                    label={t('automations.ndv.output_json', 'Output JSON')}
                    value={text}
                    onChangeText={change}
                    multiline
                    maxLines={16}
                    autoCapitalize="none"
                    autoCorrect={false}
                    error={error}
                    testID="output-json"
                />
            ) : null}
            {/* With the JSON closed, a refusal (too big, the placeholder) still needs a place to be read. */}
            {error && !rawShown ? <Banner tone="error">{error}</Banner> : null}
            <View style={styles.actions}>
                {canRemove ? <Button size="sm" variant="danger" label={t('common.remove', 'Remove')} onPress={onRemove} /> : null}
                <Button size="sm" variant="ghost" label={t('common.cancel', 'Cancel')} onPress={onCancel} />
                <Button size="sm" label={t('automations.ndv.save_output', 'Save output')} onPress={save} testID="output-save" />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.md } satisfies ViewStyle,
    disclosure: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        minHeight: theme.minTouch,
        alignSelf: 'flex-start',
    } satisfies ViewStyle,
    pressed: { opacity: 0.6 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
});
