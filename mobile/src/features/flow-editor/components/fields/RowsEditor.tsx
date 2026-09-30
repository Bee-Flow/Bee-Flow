/**
 * Named values — a `{ [name]: binding }` map: a tool's extra inputs, Edit
 * data's fields, what a flowlet returns. The key/value half of the web's
 * ToolInputForm (agent-hub `Builder/mapping/ToolInputForm.jsx`); every edit is
 * one of schemaForm/rows.ts's pure functions, so the rules match the web's:
 * a name is committed when the field is left (never per keystroke), a pasted
 * path becomes the value, a reserved or taken name is refused with a reason.
 *
 * `keepEmpty` is for the author's OWN fields, which may be empty. A tool's
 * parameters may not: a new one is held as a pending row until it has both a
 * name and a value, or the autosave would strip it the moment it appeared.
 * A row already in the map keeps its place while its value is cleared to be
 * retyped — the save leaves an empty parameter out, the form need not.
 *
 * Each row has a key of its own (useRowKeys.ts), not its name and not its
 * place: a rename, or a pending row joining the map on its first letter, keeps
 * the row mounted, and a removed row takes its half-typed name and its text
 * with it instead of handing them to the row under it.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { BindingValue } from '@/features/flow-editor/bindings';
import {
    addInputField,
    adoptPathIntoRow,
    commitFieldName,
    commitPendingRow,
    nameCommitMessage,
    removeInput,
    renameInput,
    updateInput,
    type Inputs,
    type PendingRow,
} from '@/features/flow-editor/schemaForm';
import { Button, Icon, IconButton, TextField } from '@/shared/ui';

import { BindingInput } from './BindingInput';
import { FieldRow } from './FieldRow';
import { useCommitOnUnmount } from './useCommitOnUnmount';
import { arrivedName, pendingRowKey, useRowKeys } from './useRowKeys';

export interface RowsEditorProps {
    value: Inputs | null | undefined;
    onChange: (next: Inputs) => void;
    keepEmpty?: boolean;
    /** Only these rows (schema-mode extras); edits still apply to the whole map. */
    keys?: readonly string[];
    label?: string;
    hint?: string | null;
    disabled?: boolean;
    testID?: string;
}

type Styles = ReturnType<typeof makeStyles>;

function NameBox({
    name,
    onCommit,
    message,
    styles,
    testID,
}: {
    name: string;
    onCommit: (raw: string) => void;
    message: string | null;
    styles: Styles;
    testID?: string;
}) {
    const t = useTranslation();
    const [text, setText] = useState<string | null>(null);
    useCommitOnUnmount(text !== null && text !== name, () => {
        if (text !== null) onCommit(text);
    });
    return (
        <TextField
            value={text ?? name}
            onChangeText={setText}
            onBlur={() => {
                if (text !== null) onCommit(text);
                setText(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('mobile.flow.rows.name', 'Field name')}
            error={message}
            containerStyle={styles.name}
            testID={testID}
        />
    );
}

function RemoveButton({ label, onPress, styles }: { label: string; onPress: () => void; styles: Styles }) {
    const t = useTranslation();
    return (
        <IconButton
            icon={<Icon name="Trash2" size={16} color={styles.glyph.color} />}
            accessibilityLabel={t('routines.ndv.tables_row.remove_key', 'Remove {key}', { key: label })}
            onPress={onPress}
        />
    );
}

interface RowProps {
    name: string;
    onName: (raw: string) => void;
    message: string | null;
    onRemove?: () => void;
    value: unknown;
    onValue: (next: BindingValue) => void;
    disabled?: boolean;
}

function RowBox({ name, onName, message, onRemove, value, onValue, disabled, styles }: RowProps & { styles: Styles }) {
    return (
        <>
            <View style={styles.head}>
                <NameBox name={name} onCommit={onName} message={message} styles={styles} />
                {onRemove ? <RemoveButton label={name} onPress={onRemove} styles={styles} /> : null}
            </View>
            <BindingInput value={value} onChange={(b) => onValue(b as BindingValue)} disabled={disabled} />
        </>
    );
}

export function RowsEditor({ value, onChange, keepEmpty = false, keys, label, hint, disabled = false, testID }: RowsEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const inputs = value || {};
    const [pending, setPending] = useState<PendingRow[]>([]);
    const [messages, setMessages] = useState<Record<string, string | null>>({});
    const shown = keys ?? Object.keys(inputs);
    const rowKeys = useRowKeys(shown);
    // Pending ids are never reused: a new row never shares a key with one that joined.
    const lastId = useRef(0);
    // The rows as they are now. A name box commits as its row unmounts
    // (useCommitOnUnmount); for a removed row that must not bring it back.
    const latest = useRef({ inputs, pending });
    useLayoutEffect(() => {
        latest.current = { inputs, pending };
    });

    const commitName = (key: string, raw: string) => {
        if (!Object.prototype.hasOwnProperty.call(latest.current.inputs, key)) return;
        const siblings = Object.keys(inputs).filter((k) => k !== key);
        const result = commitFieldName(raw, { fieldKey: key, siblingKeys: siblings, canAdopt: true });
        setMessages((m) => ({ ...m, [key]: nameCommitMessage(result) }));
        let next: Inputs | null = null;
        if (result.action === 'rename') next = renameInput(inputs, key, result.name) ?? inputs;
        if (result.action === 'adopt') next = adoptPathIntoRow(inputs, key, result.path, result.suggested);
        if (!next) return;
        const to = arrivedName(inputs, next);
        if (to) rowKeys.rename(key, to);
        onChange(next);
    };
    const add = () => {
        const out = addInputField(inputs, { keepEmptyFields: keepEmpty, pending, nextId: ++lastId.current });
        if ('pending' in out) setPending((p) => [...p, out.pending]);
        else onChange(out.inputs);
    };
    const editPending = (row: PendingRow) => {
        if (!latest.current.pending.some((p) => p.id === row.id)) return;
        const joined = commitPendingRow(inputs, row);
        if (joined) {
            const to = arrivedName(inputs, joined);
            if (to) rowKeys.join(row.id, to);
            setPending((p) => p.filter((x) => x.id !== row.id));
            onChange(joined);
        } else {
            setPending((p) => p.map((x) => (x.id === row.id ? row : x)));
        }
    };

    const rows: (RowProps & { id: string })[] = [
        ...shown.map((key) => ({
            id: rowKeys.of(key),
            name: key,
            onName: (raw: string) => commitName(key, raw),
            message: messages[key] ?? null,
            onRemove: disabled ? undefined : () => onChange(removeInput(inputs, key)),
            value: inputs[key],
            onValue: (b: BindingValue) => onChange(updateInput(inputs, key, b, true)),
            disabled,
        })),
        ...pending.map((row) => ({
            id: pendingRowKey(row.id),
            name: row.key,
            onName: (raw: string) => editPending({ ...row, key: raw.trim() }),
            message: null,
            onRemove: () => setPending((p) => p.filter((x) => x.id !== row.id)),
            value: row.binding,
            onValue: (b: BindingValue) => editPending({ ...row, binding: b }),
        })),
    ];

    return (
        <FieldRow label={label} hint={hint} testID={testID}>
            {rows.map(({ id, ...row }) => (
                <View key={id} style={styles.row}>
                    <RowBox {...row} styles={styles} />
                </View>
            ))}
            {disabled ? null : (
                <View style={styles.add}>
                    <Button size="sm" variant="secondary" iconName="Plus" label={t('routines.ndv.extraction.add_field', 'Add field')} onPress={add} />
                </View>
            )}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs } satisfies ViewStyle,
    name: { flex: 1 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    add: { flexDirection: 'row', paddingTop: theme.spacing.xs } satisfies ViewStyle,
});
