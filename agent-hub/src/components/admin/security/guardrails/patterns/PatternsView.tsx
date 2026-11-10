import { useState } from 'react';
import CollectionsPanel from './CollectionsPanel';
import { AiGenerate, StarterSets } from './PatternSections';
import type { PatternLibraryProps } from './patternTypes';
import RulesPanel from './RulesPanel';
import { applyStarterSet } from './starterSets';
import { useTranslation } from '@/hooks/useTranslation';
import SectionHeader from '@/components/shared/SectionHeader';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import { toast } from '@/components/shared/Toast';
import { saveRegexGuardrails } from '../api/guardrailsApi';
import { messageOf } from '@/utils/caughtError';

interface PatternsViewProps extends PatternLibraryProps {
    onSaved?: () => void;
}

/**
 * Regular expressions and the collections that group them — the server-wide
 * pattern library every organisation draws from.
 *
 * Phase 1 keeps the existing markup and fixes what was outright broken. The
 * rules table, live tester and risk badges land in phase 2.
 */
const PatternsView = ({ rules, setRules, collections, setCollections, onSaved }: PatternsViewProps) => {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);

    // Applying a template only stages the change — the admin still has to Save.
    // These rules feed the REDACTION path for every organisation bound to the
    // collection, so writing them on a single click would change what tenants see
    // before anyone had read them.
    const applyTemplate = (set: Parameters<typeof applyStarterSet>[0]) => {
        const next = applyStarterSet(set, rules, collections);
        setRules(next.rules);
        setCollections(next.collections);
        toast.success(next.addedRules === 0 && !next.addedCollection
                ? t('admin.gr_starter_already', 'That set is already in your library.')
                : t('admin.gr_starter_added', 'Added {n} rule(s) — review and save.')
                    .replace('{n}', String(next.addedRules)),
        );
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveRegexGuardrails({ rules, collections });
            toast.success(t('admin.guard_saved'));
            onSaved?.();
        } catch (e) {
            toast.error(messageOf(e, 'Failed to save'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            <SectionHeader
                title={t('admin.guard_regex_title')}
                description={t('admin.guard_regex_desc')}
                status={(
                    <button type="button" onClick={handleSave} disabled={saving} className={PRIMARY_BTN}>
                        {saving ? t('admin.guard_saving') : t('admin.guard_save_all')}
                    </button>
                )}
            />

            {/* Shown while the library is small, then out of the way. */}
            {rules.length < 6 && <StarterSets onApply={applyTemplate} />}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <RulesPanel rules={rules} setRules={setRules} collections={collections} setCollections={setCollections} />
                <CollectionsPanel rules={rules} collections={collections} setCollections={setCollections} />
            </div>

            <AiGenerate setRules={setRules} setCollections={setCollections} onSaved={onSaved} />
        </div>
    );
};

export default PatternsView;
