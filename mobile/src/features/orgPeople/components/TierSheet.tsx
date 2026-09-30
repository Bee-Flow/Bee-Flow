/**
 * Add or edit one organisation tier, or delete it. The web edits the list in
 * place and saves it with one button; here each sheet saves on its own, with
 * the same POST of the whole list (the only write the server has). The model
 * pickers open inside the sheet rather than as a second sheet over it.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Banner, Button, Sheet, useToast } from '@/shared/ui';

import { ModelPicker } from './ModelPicker';
import { TierFields } from './TierFields';
import { useSaveOrgTiers } from '../hooks/policyMutations';
import {
    applyDraft,
    collides,
    draftOf,
    parseMaxTokens,
    removeTier,
    upsertTier,
    type TierDraft,
} from '../model/tiers';
import type { CustomTier, ModelOption } from '../model/types';

type Picking = null | 'modelId' | 'euModelId';

function useTierErrors(draft: TierDraft, tiers: readonly CustomTier[], previousId: string | null, nextId: string) {
    const t = useTranslation();
    const errors: { label?: string; maxTokens?: string } = {};
    if (!draft.label.trim()) errors.label = t('mobile.orgPeople.tier_name_required', 'Give the tier a name.');
    else if (collides(tiers, previousId, nextId))
        errors.label = t('mobile.orgPeople.tier_name_taken', 'Another tier already has this name.');
    if (parseMaxTokens(draft.maxTokens) === null)
        errors.maxTokens = t('mobile.orgPeople.max_tokens_range', 'A whole number from 256 to 131072.');
    return errors;
}

export function TierSheet({
    tier,
    isNew,
    tiers,
    models,
    onClose,
}: {
    tier: CustomTier;
    isNew: boolean;
    tiers: readonly CustomTier[];
    models: readonly ModelOption[];
    onClose: () => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const saveTiers = useSaveOrgTiers();
    const [draft, setDraft] = useState<TierDraft>(() => draftOf(tier));
    const [picking, setPicking] = useState<Picking>(null);
    const [touched, setTouched] = useState(false);
    const previousId = isNew ? null : tier.id;
    const next = applyDraft(tier, draft);
    const errors = useTierErrors(draft, tiers, previousId, next.id);
    const valid = Object.keys(errors).length === 0;

    const post = (list: CustomTier[]) =>
        saveTiers.mutate(list, {
            onSuccess: ({ warnings }) => {
                toast(
                    warnings.length > 0
                        ? t('mobile.orgPeople.tiers_saved_warn', 'Saved, with warnings: {warnings}', { warnings: warnings.join('; ') })
                        : t('mobile.orgPeople.tiers_saved', 'Organisation tiers saved'),
                    warnings.length > 0 ? 'neutral' : 'success',
                );
                onClose();
            },
        });
    const onSave = () => {
        setTouched(true);
        if (valid) post(upsertTier(tiers, previousId, next));
    };
    const onDelete = async () => {
        const ok = await confirm({
            title: t('mobile.orgPeople.delete_tier_title', 'Delete this custom tier?'),
            message: t('mobile.orgPeople.delete_tier_message', 'This cannot be undone.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) post(removeTier(tiers, tier.id));
    };

    const title = picking
        ? picking === 'modelId'
            ? t('mobile.orgPeople.tier_model', 'Model')
            : t('mobile.orgPeople.tier_eu_model', 'EU override (optional)')
        : isNew
          ? t('mobile.orgPeople.add_tier', 'Add tier')
          : draft.label || tier.label;

    const footer = picking ? (
        <Button variant="ghost" label={t('mobile.orgPeople.back', 'Back')} onPress={() => setPicking(null)} fullWidth />
    ) : (
        <>
            <Button
                testID="tier-save"
                label={t('common.save', 'Save')}
                size="lg"
                fullWidth
                loading={saveTiers.isPending}
                disabled={touched && !valid}
                onPress={onSave}
            />
            {isNew ? null : (
                <Button
                    testID="tier-delete"
                    variant="danger"
                    label={t('common.delete', 'Delete')}
                    fullWidth
                    disabled={saveTiers.isPending}
                    onPress={() => void onDelete()}
                />
            )}
        </>
    );

    return (
        <Sheet visible onClose={onClose} title={title} footer={footer} scroll={!picking} tall={Boolean(picking)}>
            {saveTiers.error ? <Banner tone="error">{describeError(saveTiers.error).message}</Banner> : null}
            {picking ? (
                <ModelPicker
                    models={models}
                    value={draft[picking]}
                    noneLabel={
                        picking === 'modelId'
                            ? t('mobile.orgPeople.not_configured', 'Not configured')
                            : t('mobile.orgPeople.same_as_main', 'Same as main model')
                    }
                    searchPlaceholder={t('mobile.orgPeople.search_models', 'Search models')}
                    emptyTitle={t('mobile.orgPeople.no_models', 'No models match')}
                    onPick={(id) => {
                        setDraft({ ...draft, [picking]: id });
                        setPicking(null);
                    }}
                />
            ) : (
                <TierFields
                    draft={draft}
                    id={next.id}
                    models={models}
                    errors={touched ? errors : {}}
                    onChange={setDraft}
                    onPickModel={setPicking}
                />
            )}
        </Sheet>
    );
}
