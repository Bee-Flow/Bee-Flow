/**
 * "Suggest outputs" — describe the outputs in words, read them back as
 * sentences, and only then accept them (the web's RouteAssist.jsx). A
 * Condition's rules are a restricted grammar, and "split these files by pdf,
 * word and powerpoint" is five `ends with` comparisons over three outputs; an
 * author who picks "equals" and types `.pdf` gets an output that matches
 * nothing, silently. This box answers the common cases offline
 * (formState/routeIntents), counts each rule against the sample rows the
 * editor already has with the server's own engine, and changes nothing until
 * the author accepts — which pre-fills the outputs chooser above through the
 * same route model as a hand-made edit.
 *
 * When the items hold a list of files and the sentence is about files, the
 * box says the outputs look at the files inside each item and offers to work
 * through the files themselves instead (S4).
 *
 * The web's model fallback ("Ask the AI instead") and its upstream-step
 * handoff are not on the phone yet; a sentence the catalogue cannot read is
 * answered with what it does understand.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { matchCounts, suggestOutputs, type Suggestion } from '@/features/flow-editor/formState';
import { humanizeFieldKey, type RouteRule } from '@/features/flow-editor/model';
import { appendKey, appendWildcard, pathKeys, singularKey } from '@/shared/expr';
import { Button, Icon, Text, TextField } from '@/shared/ui';

import { losingWires } from './assistModel';
import type { FieldOption } from './fieldOptions';
import { SuggestionPreview } from './SuggestionPreview';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

/** What the web's suggestOutputs adds for files inside each item (S4) and a coded problem (S5). */
type FileSuggestion = Suggestion & {
    filesInside?: { listPath: string; listKey: string } | null;
    problemCode?: string | null;
};

export interface RouteAssistProps {
    /** The fields the rule rows offer: a suggestion only uses one the author could pick by hand. */
    fields: readonly FieldOption[];
    sampleRows: unknown[] | null;
    sampleRoot: unknown;
    /** 'items' for a list-mode node, 'records' for one deciding about the run. */
    unit: 'items' | 'records';
    /** The list the node works through now (`steps.<id>.output.messages`); '' in whole-run mode. */
    sourceRef?: string;
    /** One item's sample: is it a file, or does it hold files? */
    itemSample?: unknown;
    /** Make the node work through another list (S4's "Check each attachment instead"). */
    onWorkThroughList?: ((listPath: string) => void) | null;
    existing: number;
    /** Whether the node fans out after an accept (fansOutAfterAccept): one item can go down several outputs. */
    fanOut?: boolean;
    /** One list output whose rest goes to “Otherwise” (BFSF-485 F2): what does not match is not dropped. */
    keepRest?: boolean;
    wiredNames: readonly string[];
    onApply: (rules: RouteRule[]) => void;
    disabled: boolean;
}

/** A key as a word in a sentence, lower case: `attachments` → "attachments". */
const asWord = (key: string): string => (humanizeFieldKey(key) || key).toLowerCase();

/** The last named key of a list path: `steps.a.output.messages` → `messages`. */
function listKeyOf(path: string): string {
    const keys = (pathKeys(path) || []).filter((k): k is string => typeof k === 'string' && k !== '*');
    return keys.at(-1) ?? '';
}

/** P3: the sample unit is the list's own word ("messages"); "items"/"records" when it has none. */
function unitWord(sourceRef: string, unit: RouteAssistProps['unit'], t: ReturnType<typeof useTranslation>): string {
    const key = listKeyOf(sourceRef);
    if (key && key !== 'output' && key !== 'items') return asWord(key);
    return unit === 'items' ? t('mobile.flow.route.assist.items', 'items') : t('mobile.flow.route.assist.records', 'records');
}

interface FilesInsideProps {
    suggestion: FileSuggestion;
    sourceRef: string;
    fanOut: boolean;
    onWorkThroughList?: ((p: string) => void) | null;
    disabled: boolean;
}

/**
 * S4: the outputs look at the files INSIDE each item, so a mail with a PDF
 * and a Word file goes down both outputs when the node fans out, and down the
 * first that matches when it does not. The way out: work through the files.
 */
function FilesInside({ suggestion, sourceRef, fanOut, onWorkThroughList, disabled }: FilesInsideProps) {
    const t = useTranslation();
    const inside = suggestion.filesInside;
    if (!inside?.listKey || !sourceRef) return null;
    const list = asWord(inside.listKey);
    const name = asWord(singularKey(listKeyOf(sourceRef)) || 'item');
    const item = asWord(singularKey(inside.listKey));
    const several = suggestion.rules.length > 1;
    return (
        <>
            {several && fanOut ? (
                <Note>{t('condition_node.suggest.files_inside', 'These outputs look at the {list} of each {name}: a {name} with a PDF and a Word file goes down both.', { list, name })}</Note>
            ) : null}
            {several && !fanOut ? (
                <Note>
                    {t('condition_node.suggest.files_inside_first', 'These outputs look at the {list} of each {name}: a {name} with a PDF and a Word file goes down the first matching output only.', { list, name })}
                </Note>
            ) : null}
            {onWorkThroughList ? (
                <>
                    <Button
                        size="sm"
                        variant="secondary"
                        label={t('condition_node.suggest.check_each', 'Check each {item} instead', { item })}
                        onPress={() => onWorkThroughList(appendKey(appendWildcard(sourceRef), inside.listKey))}
                        disabled={disabled}
                        testID="route-assist-check-each"
                    />
                    <Note>{t('condition_node.suggest.check_each_note', 'Splits the {list} themselves, one by one.', { list })}</Note>
                </>
            ) : null}
        </>
    );
}

export function RouteAssist(props: RouteAssistProps) {
    const { fields, sampleRows, sampleRoot, unit, sourceRef = '', itemSample, existing, fanOut = true, keepRest = false, wiredNames, onApply, disabled } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useState('');
    const suggestion: FileSuggestion = suggestOutputs(text, { fields: fields.map((f): Record<string, unknown> => ({ ...f })), element: itemSample });
    const rules = suggestion.rules;
    const counts = matchCounts(rules, sampleRows, { root: sampleRoot, itemVar: 'item' });
    const problem = suggestion.problemCode === 'name_types' ? t('condition_node.suggest.name_types', 'Name the file types to split by, for example “pdf, word and powerpoint”.') : suggestion.problem;
    return (
        <View style={styles.card} testID="route-assist">
            <View style={styles.title}>
                <Icon name="Lightbulb" size={14} color={styles.glyph.color} />
                <Text variant="caption" weight="medium">
                    {t('mobile.flow.route.assist.title', 'Suggest outputs')}
                </Text>
            </View>
            <Note>{t('mobile.flow.route.assist.intro', 'Describe the outputs in your own words and check them below. Nothing changes until you accept.')}</Note>
            <TextField
                value={text}
                onChangeText={setText}
                placeholder={t('mobile.flow.route.assist.placeholder', 'split these files by pdf, word and powerpoint')}
                accessibilityLabel={t('mobile.flow.route.assist.describe', 'Describe the outputs you want')}
                editable={!disabled}
                autoCapitalize="none"
                testID="route-assist-input"
            />
            {!rules.length && problem ? <Warn>{problem}</Warn> : null}
            {rules.length ? (
                <SuggestionPreview
                    suggestion={suggestion}
                    counts={counts}
                    unit={unitWord(sourceRef, unit, t)}
                    existing={existing}
                    keepRest={keepRest}
                    losing={losingWires(wiredNames, rules)}
                    onApply={() => {
                        onApply(rules.map((r) => ({ name: r.name, expr: r.expr, value: '' })));
                        setText('');
                    }}
                    onReset={() => setText('')}
                    disabled={disabled}
                />
            ) : null}
            <FilesInside suggestion={suggestion} sourceRef={sourceRef} fanOut={fanOut} onWorkThroughList={props.onWorkThroughList} disabled={disabled} />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radii.md,
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});
