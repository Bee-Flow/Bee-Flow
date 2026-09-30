/**
 * One named band of a step's settings — the web's AccordionSection over
 * CollapsibleSection (agent-hub `Builder/flow/`): a filled band that opens and
 * closes, with a rail down its body. A section holding a validation error
 * opens by itself (only on the moment the error appears, so it can still be
 * closed while the error stands) and carries its count; in Simple mode a
 * section the type does not need is left out unless it has an error or is
 * already configured, and then it says "set" so it is clear why it stayed.
 * The section a finding opened the editor at (ctx.focusSection) starts open
 * and is shown in Simple mode too.
 *
 * Every step editor builds from this, declarative or bespoke.
 */

import React, { useState, type ReactNode } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, tint } from '@/shared/ui';

import { hiddenInSimple, sectionShown } from './density';
import type { StepEditorContext } from '../editors/types';

export interface SectionProps {
    stepType: string;
    sectionKey: string;
    title: string;
    ctx: Pick<StepEditorContext, 'mode' | 'errorSections' | 'focusSection'>;
    defaultOpen?: boolean;
    /** Already configured: never hidden in Simple. */
    hasContent?: boolean;
    /** Errors in this section, for the chip on the band. */
    errorCount?: number;
    children: ReactNode;
}

function Band({ title, open, onToggle, badge, errors }: { title: string; open: boolean; onToggle: () => void; badge: string | null; errors: number }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={title}
            style={({ pressed }) => [styles.band, pressed ? styles.pressed : null]}
        >
            <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} color={styles.glyph.color} />
            <Text variant="caption" weight="semibold" style={styles.title} numberOfLines={1}>
                {title}
            </Text>
            {badge ? (
                <Text variant="label" tone="tertiary">
                    {badge}
                </Text>
            ) : null}
            {errors > 0 ? (
                <View style={styles.errors} accessibilityLabel={t('mobile.flow.section.problems', '{n} problems in this section', { n: errors })}>
                    <Text variant="label" tone="error">
                        {String(errors)}
                    </Text>
                </View>
            ) : null}
        </Pressable>
    );
}

export function Section({ stepType, sectionKey, title, ctx, defaultOpen = false, hasContent = false, errorCount, children }: SectionProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const hasError = ctx.errorSections.has(sectionKey);
    const focused = ctx.focusSection === sectionKey;
    const [open, setOpen] = useState(hasError || focused || defaultOpen);
    // Open on the false→true edge of an error, never forced shut again after.
    const [hadError, setHadError] = useState(hasError);
    if (hadError !== hasError) {
        setHadError(hasError);
        if (hasError) setOpen(true);
    }
    if (!sectionShown(stepType, sectionKey, { mode: ctx.mode, hasError: hasError || focused, hasContent })) return null;
    const badge = hasContent && ctx.mode === 'simple' && hiddenInSimple(stepType, sectionKey) ? t('mobile.flow.section.set', 'set') : null;
    return (
        <View style={styles.section} testID={`section-${sectionKey}`}>
            <Band title={title} open={open} onToggle={() => setOpen((v) => !v)} badge={badge} errors={errorCount ?? (hasError ? 1 : 0)} />
            {open ? <View style={styles.body}>{children}</View> : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    section: { gap: theme.spacing.sm } satisfies ViewStyle,
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        minHeight: 40,
        paddingHorizontal: theme.spacing.sm,
        borderRadius: theme.radii.sm,
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    title: { flex: 1, textTransform: 'uppercase', letterSpacing: 0.5 } satisfies TextStyle,
    glyph: { color: theme.colors.textTertiary },
    errors: {
        minWidth: 20,
        paddingHorizontal: theme.spacing[1.5],
        borderRadius: theme.radii.pill,
        alignItems: 'center',
        backgroundColor: tint(theme.colors.error, 15),
    } satisfies ViewStyle,
    body: {
        gap: theme.spacing.lg,
        marginLeft: theme.spacing.sm,
        paddingLeft: theme.spacing.md,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
});
