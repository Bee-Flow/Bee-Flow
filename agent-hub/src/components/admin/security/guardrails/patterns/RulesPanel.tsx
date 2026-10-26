import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EMPTY_NOTE, INPUT, PANEL, PANEL_TITLE, SECONDARY_BUTTON } from './patternTypes';
import type { PatternLibraryProps } from './patternTypes';
import { useTranslation } from '@/hooks/useTranslation';

/** The rules: add one (name + pattern), see them all, delete one. */
export default function RulesPanel({ rules, setRules, collections, setCollections }: PatternLibraryProps) {
    const { t } = useTranslation();
    const [newRuleName, setNewRuleName] = useState('');
    const [newRulePattern, setNewRulePattern] = useState('');

    const addRule = () => {
        if (!newRuleName.trim() || !newRulePattern.trim()) return;
        // Was `'r' + Date.now()`, which collides for two rules added inside the
        // same millisecond — and, more importantly, is not stable across an AI
        // regeneration that rewrites the whole library.
        setRules([...rules, { id: `r_${crypto.randomUUID()}`, name: newRuleName.trim(), pattern: newRulePattern.trim() }]);
        setNewRuleName('');
        setNewRulePattern('');
    };

    // A deleted rule leaves every collection that held it.
    const removeRule = (id: string) => {
        setRules(rules.filter(r => r.id !== id));
        setCollections(collections.map(c => ({ ...c, ruleIds: c.ruleIds.filter(rId => rId !== id) })));
    };

    return (
        <section className={PANEL}>
            <h3 className={PANEL_TITLE}>
                {t('admin.gr_patterns_rules', 'Rules')}
            </h3>
            <div className="flex gap-2 mb-4">
                <input
                    value={newRuleName}
                    onChange={e => setNewRuleName(e.target.value)}
                    placeholder={t('admin.gr_patterns_rule_name', 'Name')}
                    aria-label={t('admin.gr_patterns_rule_name', 'Name')}
                    className={`w-1/3 ${INPUT}`}
                />
                <input
                    value={newRulePattern}
                    onChange={e => setNewRulePattern(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addRule()}
                    placeholder={t('admin.gr_patterns_rule_pattern', 'Pattern…')}
                    aria-label={t('admin.gr_patterns_rule_pattern', 'Pattern…')}
                    className={`flex-1 ${INPUT} font-mono`}
                />
                <button onClick={addRule} className={SECONDARY_BUTTON}>
                    {t('admin.gr_add', 'Add')}
                </button>
            </div>

            <div className="space-y-2 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
                {rules.length === 0 && (
                    <p className={EMPTY_NOTE}>
                        {t('admin.gr_patterns_no_rules', 'No rules yet.')}
                    </p>
                )}
                {rules.map(rule => (
                    <div key={rule.id} className="flex items-center justify-between gap-3 p-3 rounded-lg group bg-[var(--bg-tertiary)] hover:bg-white/5 transition-colors">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                            <span className="font-medium text-sm text-[var(--text-primary)] whitespace-nowrap">{rule.name}</span>
                            <code className="text-xs px-2 py-1 rounded font-mono truncate bg-[var(--bg-primary)] text-[var(--text-tertiary)]">{rule.pattern}</code>
                        </div>
                        {/* Was opacity-0 group-hover only — invisible to keyboard and touch. */}
                        <button
                            onClick={() => removeRule(rule.id)}
                            aria-label={t('admin.gr_delete_rule', 'Delete rule')}
                            title={t('admin.gr_delete_rule', 'Delete rule')}
                            className="shrink-0 p-1.5 rounded-md text-[var(--text-tertiary)] hover:text-red-400 hover:bg-white/10 transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                ))}
            </div>
        </section>
    );
}
