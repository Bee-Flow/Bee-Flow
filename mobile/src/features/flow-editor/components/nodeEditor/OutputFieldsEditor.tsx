/**
 * The friendly face of the hand-written output — the web's
 * OutputFieldsEditor (agent-hub `Builder/OutputFieldsEditor.tsx`): named
 * fields with a value and a kind each, one card per record when the output is
 * a list of them, and one box when it is a single value.
 *
 * The draft lives here and the JSON text lives in OutputEditor, which both
 * faces write: a field edit writes the text, and the text is read back into a
 * draft only when something else wrote it (outputFields.syncDraft). So Save
 * sees one text whichever face was used, parses it once and weighs it
 * against the same cap.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { draftRecords, draftValue, safeJsonText, type OutputRecord, type OutputRow, type OutputShape } from '@/features/flow-editor/formState/outputDrafts';

import { OutputFieldRow } from './OutputFieldRow';
import { blankField, blankRecord, patchRow, syncDraft, type DraftSync } from './outputFields';
import { AddButton } from '../editors/shared/AddButton';
import { RowCard } from '../editors/shared/RowCard';

export interface OutputFieldsEditorProps {
    shape: OutputShape;
    /** The editor's JSON text: the draft is read out of it and written back to it. */
    text: string;
    onChange: (text: string) => void;
}

interface RecordProps {
    rec: OutputRecord;
    /** Null for a single object: there is no record there, only its fields. */
    index: number | null;
    /** One value has no name and no second field, so the row is the whole face. */
    canAddFields: boolean;
    onRows: (rows: OutputRow[]) => void;
    onRemove: () => void;
}

function RecordRows({ rec, canAddFields, onRows, testID }: Omit<RecordProps, 'index' | 'onRemove'> & { testID: string }) {
    const t = useTranslation();
    return (
        <>
            {rec.rows.map((row, i) => (
                <OutputFieldRow
                    key={row.id}
                    row={row}
                    onPatch={(patch) => onRows(patchRow(rec.rows, row.id, patch))}
                    onRemove={canAddFields ? () => onRows(rec.rows.filter((r) => r.id !== row.id)) : null}
                    testID={`${testID}-field-${i + 1}`}
                />
            ))}
            {canAddFields ? (
                <AddButton label={t('automations.ndv.extraction.add_field', 'Add field')} onPress={() => onRows([...rec.rows, blankField()])} testID={`${testID}-add-field`} />
            ) : null}
        </>
    );
}

function OutputRecordBlock({ rec, index, canAddFields, onRows, onRemove }: RecordProps) {
    const styles = useThemedStyles(makeStyles);
    if (index === null) {
        return (
            <View style={styles.fields}>
                <RecordRows rec={rec} canAddFields={canAddFields} onRows={onRows} testID="output-fields" />
            </View>
        );
    }
    // A numeral, not a word, as on the web: it says WHICH record of the list
    // this is, in every language.
    const title = `#${index + 1}`;
    return (
        <RowCard title={title} name={title} onRemove={onRemove} testID={`output-record-${index + 1}`}>
            <View style={styles.fields}>
                <RecordRows rec={rec} canAddFields={canAddFields} onRows={onRows} testID={`output-record-${index + 1}`} />
            </View>
        </RowCard>
    );
}

export function OutputFieldsEditor({ shape, text, onChange }: OutputFieldsEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [sync, setSync] = useState<DraftSync>(() => ({ seed: text, records: draftRecords(text) }));
    // Adjusted during the render that brings a new text in, so the list never
    // shows a frame that disagrees with the JSON.
    const current = syncDraft(sync, text);
    if (current !== sync) setSync(current);
    const records = current.records;
    const emit = (next: OutputRecord[]) => {
        const json = safeJsonText(draftValue(shape, next));
        setSync({ seed: json, records: next });
        onChange(json);
    };
    return (
        <View style={styles.box} testID="output-fields-editor">
            {records.map((rec, i) => (
                <OutputRecordBlock
                    key={rec.id}
                    rec={rec}
                    index={shape === 'records' ? i : null}
                    canAddFields={shape !== 'value'}
                    onRows={(rows) => emit(records.map((r, j) => (j === i ? { ...r, rows } : r)))}
                    onRemove={() => emit(records.filter((_, j) => j !== i))}
                />
            ))}
            {shape === 'records' ? <AddButton label={t('common.add', 'Add')} onPress={() => emit([...records, blankRecord(records)])} testID="output-add-record" /> : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.md } satisfies ViewStyle,
    fields: { gap: theme.spacing.md } satisfies ViewStyle,
});
