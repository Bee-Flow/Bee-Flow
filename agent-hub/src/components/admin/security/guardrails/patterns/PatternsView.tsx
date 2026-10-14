import { useState } from 'react';
import CollectionsPanel from './CollectionsPanel';
import { AiGenerate, StarterSets } from './PatternSections';
import type { PatternLibraryProps } from './patternTypes';
import RulesPanel from './RulesPanel';
import { applyStarterSet } from './starterSets';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { toast } from '../../../../shared/Toast';
import { saveRegexGuardrails } from '../api/guardrailsApi';

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
            toast.error((e as Error).message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin.guard_regex_title')}</h2>
                    <p className="text-sm text-[var(--text-secondary)]">{t('admin.guard_regex_desc')}</p>
                </div>
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="shrink-0 px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)] hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {saving ? t('admin.guard_saving') : t('admin.guard_save_all')}
                </button>
            </div>

            {/* Shown while the library is small, then out of the way. */}
            {rules.length < 6 && <StarterSets onApply={applyTemplate} />}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <RulesPanel rules={rules} setRules={setRules} collections={collections} setCollections={setCollections} />
                <CollectionsPanel rules={rules} collections={collections} setCollections={setCollections} />
            </div>

            <AiGenerate setRules={setRules} setCollections={setCollections} onSaved={onSaved} />
        </div>
    );
};

export default PatternsView;
