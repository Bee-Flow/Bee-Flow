/**
 * The second sheet of a guarded delete: the server's answer, then the button.
 *
 * Opens on a `409 in_use` (read by src/core/api/deleteGuard.ts) and says two
 * different things the refusal carries — what was FOUND, and which kinds could
 * not be checked at all. An empty list is never presented as "nothing uses
 * this" while a kind is unanswered; that sentence is exactly the one somebody
 * presses through.
 *
 * Typing the name is the price of breaking something, as in the web's
 * DangerZone (agent-hub/src/components/shared/DangerZone.jsx): asked when
 * something was found, when the answer was unreadable, or always when the
 * caller says so — recordings do, because on the web a meeting's title is typed
 * against the unchecked warning before `?confirm=1` goes out.
 *
 * Borrows the web's `usage.*` keys, so a translation an administrator made for
 * the browser appears here for free.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import type { DeleteGuard, DeleteGuardRow } from '@/core/api/deleteGuard';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { TextField } from './TextField';

/** Beyond this the list stops being read and starts being scrolled past. */
const MAX_ROWS = 8;

const NO_GUARD: DeleteGuard = { blocked: false, usage: [], unchecked: [], readable: true };

/**
 * Must the name be typed before the destructive button wakes up? Never for an
 * empty name — there is nothing to type, and a button that can never enable is
 * a dead end, not a safeguard.
 */
export function needsTypedName(guard: DeleteGuard, name: string, requireName = false): boolean {
    if (!name.trim()) return false;
    return requireName || guard.usage.length > 0 || !guard.readable;
}

/**
 * Trimmed, case kept. Android keyboards append a space after an autocompleted
 * word, and a match that fails on it reads as "the app will not let me".
 */
export function typedNameMatches(typed: string, name: string): boolean {
    return typed.trim() === name.trim();
}

type Noun = (t: TranslateFn, many: boolean) => string;

// One literal t() per noun, so the i18n guard can check every borrowed key.
const KIND_NOUNS = new Map<string, Noun>([
    ['agent', (t, many) => (many ? t('usage.kind_agent_plural', 'agents') : t('usage.kind_agent', 'agent'))],
    [
        'automation',
        (t, many) =>
            many
                ? t('mobile.delete_guard.kind_routines', 'routines')
                : t('mobile.delete_guard.kind_routine', 'routine'),
    ],
    [
        'kb',
        (t, many) => (many ? t('usage.kind_kb_plural', 'knowledge bases') : t('usage.kind_kb', 'knowledge base')),
    ],
    [
        'datatable',
        (t, many) => (many ? t('usage.kind_datatable_plural', 'tables') : t('usage.kind_datatable', 'table')),
    ],
    [
        'notebook',
        (t, many) => (many ? t('usage.kind_notebook_plural', 'notebooks') : t('usage.kind_notebook', 'notebook')),
    ],
    [
        'solution',
        (t, many) => (many ? t('usage.kind_solution_plural', 'solutions') : t('usage.kind_solution', 'solution')),
    ],
    ['chat', (t, many) => (many ? t('usage.kind_chat_plural', 'chats') : t('usage.kind_chat', 'chat'))],
    ['app', (t, many) => (many ? t('usage.kind_app_plural', 'apps') : t('usage.kind_app', 'app'))],
    [
        'webpage',
        (t, many) => (many ? t('usage.kind_webpage_plural', 'webpages') : t('usage.kind_webpage', 'webpage')),
    ],
    [
        'project',
        (t, many) => (many ? t('usage.kind_project_plural', 'projects') : t('usage.kind_project', 'project')),
    ],
    ['skill', (t, many) => (many ? t('usage.kind_skill_plural', 'skills') : t('usage.kind_skill', 'skill'))],
    [
        'template',
        (t, many) =>
            many
                ? t('mobile.delete_guard.kind_templates', 'templates')
                : t('mobile.delete_guard.kind_template', 'template'),
    ],
    [
        'support',
        (t, many) =>
            many
                ? t('mobile.delete_guard.kind_support_threads', 'support threads')
                : t('mobile.delete_guard.kind_support_thread', 'support thread'),
    ],
    // No kind at all.
    ['', (t, many) => (many ? t('usage.kind_other_plural', 'items') : t('usage.kind_other', 'item'))],
]);

/**
 * A kind as a noun. The server's list is open, so an unknown kind keeps its own
 * name rather than becoming "items". `automation` is a routine here, as
 * everywhere else on the phone.
 */
export function kindLabel(t: TranslateFn, kind: string | undefined, n = 1): string {
    const noun = KIND_NOUNS.get(kind ?? '');
    return noun ? noun(t, n !== 1) : (kind as string);
}

/** The line above the list: found, nothing found but incomplete, or no answer. */
function summary(t: TranslateFn, guard: DeleteGuard): string {
    const n = guard.usage.length;
    if (n === 1) return t('usage.delete_dependents_one', 'One thing uses this and will start failing:');
    if (n > 1) return t('usage.delete_dependents', '{n} things use this and will start failing:', { n });
    if (!guard.readable) {
        return t('mobile.delete_guard.unreadable', 'The check did not answer at all, so nothing here is a complete list.');
    }
    if (guard.unchecked.length > 0) {
        return t('usage.delete_nothing_found_incomplete', 'Nothing was found — but not everything could be checked, so this is not the same as “nothing uses this”.');
    }
    return t('usage.delete_nothing_depends', 'Nothing uses this. It can be deleted without breaking anything else.');
}

export function GuardedDeleteSheet({
    guard,
    name,
    requireName = false,
    busy = false,
    onConfirm,
    onCancel,
}: {
    /** The guard's answer; the sheet is open while this is non-null. */
    guard: DeleteGuard | null;
    /** The item's name — in the title, and what has to be typed. */
    name: string;
    /** Ask for the name even when nothing was found (recordings). */
    requireName?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const theme = useTheme();
    const t = useTranslation();

    // What was typed belongs to ONE answer: a fresh 409 starts empty again, so
    // a second refusal is read before it is confirmed. Derived during render
    // rather than reset in an effect.
    const [typed, setTyped] = useState<{ for: DeleteGuard | null; text: string }>({ for: null, text: '' });
    const text = typed.for === guard ? typed.text : '';

    const askName = needsTypedName(guard ?? NO_GUARD, name, requireName);
    const ready = !askName || typedNameMatches(text, name);

    return (
        <Sheet
            visible={guard !== null}
            onClose={onCancel}
            title={t('usage.delete_question', 'Delete “{name}” for good?', {
                name: name.trim() || t('mobile.delete_guard.unnamed', 'this item'),
            })}
            footer={
                <View style={{ gap: theme.spacing.xs, paddingBottom: theme.spacing.sm }}>
                    <Button
                        variant="danger"
                        fullWidth
                        label={t('usage.delete_confirm', 'Delete for good')}
                        disabled={!ready}
                        loading={busy}
                        onPress={onConfirm}
                        testID="guarded-delete-confirm"
                    />
                    <Button variant="ghost" fullWidth label={t('common.cancel', 'Cancel')} onPress={onCancel} />
                </View>
            }
        >
            {/* Nothing while the sheet slides away: an emptied answer would read as "nothing uses this". */}
            {guard ? <Answer guard={guard} t={t} /> : null}

            {askName ? (
                <TextField
                    label={t('usage.delete_type_name', 'Type the name to confirm.')}
                    value={text}
                    onChangeText={(value) => setTyped({ for: guard, text: value })}
                    placeholder={name}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    testID="guarded-delete-name"
                />
            ) : null}
        </Sheet>
    );
}

/** What was found, what could not be checked, and that it cannot be undone. */
function Answer({ guard, t }: { guard: DeleteGuard; t: TranslateFn }) {
    const theme = useTheme();
    const shown = guard.usage.slice(0, MAX_ROWS);
    const hidden = guard.usage.length - shown.length;
    return (
        <View style={{ gap: theme.spacing.sm }}>
            <Text variant="body" tone="secondary">
                {summary(t, guard)}
            </Text>
            {shown.map((row, i) => (
                // One row per SITE: a routine with two steps using a skill
                // arrives twice under the same id. The list never reorders.
                <UsageRow key={`${i}:${row.kind ?? ''}:${row.id ?? ''}`} row={row} t={t} />
            ))}
            {hidden > 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.delete_guard.more', 'and {n} more', { n: hidden })}
                </Text>
            ) : null}
            {guard.usage.length > 0 && guard.unchecked.length > 0 ? (
                <Text variant="caption" tone="warning">
                    {t('usage.delete_dependents_incomplete', 'And this list is not the whole story — not everything could be checked.')}
                </Text>
            ) : null}
            {guard.unchecked.length > 0 ? (
                <Text variant="caption" tone="warning">
                    {t('mobile.delete_guard.unchecked', 'Could not be checked: {kinds}.', {
                        kinds: guard.unchecked.map((k) => kindLabel(t, k, 2)).join(', '),
                    })}
                </Text>
            ) : null}
            <Text variant="caption" tone="tertiary">
                {t('mobile.delete_guard.not_undone', 'Deleting is not announced and cannot be undone.')}
            </Text>
        </View>
    );
}

/**
 * One thing that breaks. A row owned by someone else arrives without a title.
 * The site ("step 3") is the server's own words, shown as the web's Used-by
 * tab shows them: it is what separates two rows for the same routine.
 */
function UsageRow({ row, t }: { row: DeleteGuardRow; t: TranslateFn }) {
    const theme = useTheme();
    const noun = kindLabel(t, row.kind, 1);
    const site = typeof row.siteLabel === 'string' && row.siteLabel.trim() ? row.siteLabel.trim() : null;
    const detail = [row.title ? noun : null, site].filter(Boolean).join(' · ');
    return (
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'baseline' }}>
            <Text variant="body" style={{ flexShrink: 1 }} numberOfLines={2}>
                {row.title || noun}
            </Text>
            {detail ? (
                <Text variant="caption" tone="tertiary" style={{ flexShrink: 1 }} numberOfLines={1}>
                    {detail}
                </Text>
            ) : null}
        </View>
    );
}
