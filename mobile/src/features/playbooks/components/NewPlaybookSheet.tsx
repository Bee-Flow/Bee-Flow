/**
 * Start a playbook — the web's NewPlaybookDialog. Describe what should be
 * read, stored and built; the AI writes the phases (a recipe document), the
 * sheet previews them, and only Start creates anything. The playbook is built
 * in the language on screen (model/newPlaybook buildLocale), with no second
 * dial for it, as on the web.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useLocale, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { Button, Text, TextField } from '@/shared/ui';

import { PlaybookOptions } from './PlaybookOptions';
import { RecipePreview } from './RecipePreview';
import { useComposeRecipe, useCreatePlaybook } from '../hooks/mutations';
import { usePlaybookTiers } from '../hooks/queries';
import { MAX_DESCRIPTION, buildLocale, canStart, createBody, initialForm, type NewPlaybookForm } from '../model/newPlaybook';
import type { ComposeResult, Playbook } from '../model/types';

/** The compose refusal in words: a truncated answer has its own advice. */
function composeProblem(error: unknown, t: ReturnType<typeof useTranslation>): string | null {
    if (!error) return null;
    const described = describeError(error);
    const code = (error as { code?: string }).code;
    if (code === 'compose_truncated') {
        return t('playbooks.new.err_compose_truncated', 'The playbook came out longer than the model can write in one answer — describe fewer screens and steps, or split it into two playbooks.');
    }
    return described.message || t('playbooks.new.err_compose', 'The AI could not write a runnable playbook — try a more concrete description.');
}

export function NewPlaybookSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (pb: Playbook) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { locale, strings } = useLocale();
    const tiers = usePlaybookTiers();
    const [description, setDescription] = useState('');
    const [composed, setComposed] = useState<ComposeResult | null>(null);
    const [form, setForm] = useState<NewPlaybookForm>(initialForm(null));
    const compose = useComposeRecipe();
    const create = useCreatePlaybook();
    const buildIn = buildLocale(locale, strings);
    const recipe = composed?.recipe ?? null;

    const write = async () => {
        const text = description.trim();
        if (!text || compose.isPending) return;
        const out = await compose.mutateAsync({ description: text, locale: buildIn }).catch(() => null);
        if (!out) return;
        setComposed(out);
        setForm(initialForm(out.recipe));
    };
    const start = async () => {
        if (!recipe || !canStart(recipe, form)) return;
        const tier = tiers.includes(form.tier) ? form.tier : (tiers[0] ?? 'fast');
        const pb = await create.mutateAsync(createBody(recipe, { ...form, tier }, { description, locale: buildIn })).catch(() => null);
        if (pb) onCreated(pb);
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('playbooks.new.title', 'New playbook')}
            subtitle={t('playbooks.new.subtitle', 'The AI builds in phases and stops after each one for your go-ahead.')}
            submitLabel={t('playbooks.new.start', 'Start')}
            onSubmit={() => void start()}
            submitting={create.isPending}
            canSubmit={!!recipe && canStart(recipe, form)}
            error={create.error}
        >
            <View style={styles.body}>
                <TextField
                    label={t('playbooks.new.describe_label', 'What should this playbook build?')}
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    maxLines={10}
                    maxLength={MAX_DESCRIPTION}
                    placeholder={t('playbooks.new.describe_placeholder', 'e.g. Read the supplier contracts in /Contracten into a table with supplier, start date, end date and amount, then build an app that shows which contracts end within 90 days.')}
                    testID="playbook-describe"
                />
                <Button
                    variant="secondary"
                    iconName="Wand2"
                    label={recipe ? t('playbooks.new.compose_again', 'Write it again') : t('playbooks.new.compose', 'Let the AI write the phases')}
                    onPress={() => void write()}
                    loading={compose.isPending}
                    disabled={!description.trim()}
                    testID="playbook-compose"
                />
                {compose.isPending ? (
                    <Text variant="caption" tone="secondary">
                        {t('playbooks.new.composing', 'Writing the playbook…')}
                    </Text>
                ) : null}
                {compose.error ? (
                    <Text variant="caption" tone="error" accessibilityRole="alert">
                        {composeProblem(compose.error, t)}
                    </Text>
                ) : null}
                {recipe && composed ? <RecipePreview recipe={recipe} warnings={composed.warnings} /> : null}
                {recipe ? <PlaybookOptions recipe={recipe} form={form} onChange={setForm} /> : null}
            </View>
        </FormSheet>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing[3] },
});
