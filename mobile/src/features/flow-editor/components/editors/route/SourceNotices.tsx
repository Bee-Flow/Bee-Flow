/**
 * The Condition editor's notices about the list it works through — the web's
 * flow/settings/SourceNotices.tsx — each with its one-tap fix under the
 * sentence that explains it:
 *   - StaleNotice (W7): a next step still reads the list this Condition
 *     filters, so what it drops still reaches that step;
 *   - UnfitNotice (R11): after the list changed, some rules read fields the
 *     new item does not have;
 *   - WholeListNotice (BFSF-485 F3/F4): a whole-run Condition reads a list as
 *     a whole, so it does not filter it, and a loop after it sees every item.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import type { StaleStep, WholeRunReads } from './routeNotices';

const quotedList = (names: readonly string[]) => names.map((n) => `“${n}”`).join(', ');

function NoticeWithFix({ text, fix, onFix, disabled, testID }: { text: string; fix: string | null; onFix: () => void; disabled?: boolean; testID: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Banner tone="warning">
            <View style={styles.body} testID={testID}>
                <Text variant="caption">{text}</Text>
                {fix ? <Button size="sm" variant="ghost" label={fix} onPress={onFix} disabled={disabled} testID={`${testID}-fix`} /> : null}
            </View>
        </Banner>
    );
}

export function StaleNotice({ stale, onFollow, disabled }: { stale: readonly StaleStep[]; onFollow: (stepIds: string[]) => void; disabled?: boolean }) {
    const t = useTranslation();
    const first = stale[0];
    if (!first) return null;
    const text =
        stale.length === 1
            ? t('condition_node.stale.one', '“{step}” still reads {list}, so what this Condition drops still reaches it.', { step: first.stepLabel, list: first.readsLabel })
            : t('condition_node.stale.many', '{steps} still read {list}, so what this Condition drops still reaches them.', {
                  steps: quotedList(stale.map((s) => s.stepLabel)),
                  list: first.readsLabel,
              });
    const fix = t('condition_node.stale.follow', 'Use what this Condition keeps');
    return <NoticeWithFix text={text} fix={fix} onFix={() => onFollow(stale.map((s) => s.stepId))} disabled={disabled} testID="route-stale-notice" />;
}

export function UnfitNotice({ fields, itemName, onRemove, disabled }: { fields: readonly string[]; itemName: string; onRemove: () => void; disabled?: boolean }) {
    const t = useTranslation();
    if (!fields.length) return null;
    const text = t('condition_node.rules_dont_fit', 'These rules read {fields}, which each {name} doesn’t have.', { fields: fields.join(', '), name: itemName });
    return <NoticeWithFix text={text} fix={t('condition_node.rules_remove_unfit', 'Remove those rules')} onFix={onRemove} disabled={disabled} testID="route-unfit-notice" />;
}

/** The F4 tail: the loops after the Condition that still see every item. */
function loopSentence(loops: WholeRunReads['loops'], t: ReturnType<typeof useTranslation>): string {
    const [only] = loops;
    if (!only) return '';
    if (loops.length === 1) return t('condition_node.loop_after.one', '“{step}” still runs once for every item of that list.', { step: only.stepLabel });
    return t('condition_node.loop_after.many', '{steps} still run once for every item of that list.', { steps: quotedList(loops.map((l) => l.stepLabel)) });
}

/**
 * The fix is offered only for a list a rule reads the items of (`convertible`);
 * one read whole would become a rule that never reads the item.
 */
export function WholeListNotice({ reads, onConvert, disabled }: { reads: WholeRunReads | null; onConvert: (listPath: string) => void; disabled?: boolean }) {
    const t = useTranslation();
    const target = reads?.lists.find((l) => l.convertible) ?? null;
    const list = target ?? reads?.lists[0];
    if (!reads || !list) return null;
    const note = t('condition_node.whole_list.note', 'This checks the whole list {list} once: the run goes one way for all its items. It does not filter them.', { list: list.label });
    const text = [note, loopSentence(reads.loops, t)].filter(Boolean).join(' ');
    const fix = target ? t('condition_node.whole_list.use_filter', 'Check each item instead') : null;
    return <NoticeWithFix text={text} fix={fix} onFix={() => target && onConvert(target.path)} disabled={disabled} testID="route-whole-list-notice" />;
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.xs, alignItems: 'flex-start' } satisfies ViewStyle,
});
