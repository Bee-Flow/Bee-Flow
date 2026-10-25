import { Loader2, Sparkles } from 'lucide-react';
import React from 'react';
import type { RuleIdea, ComposerProps } from './RulesPanel.types';

export const ERROR_BANNER = {
    background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))',
    borderColor: 'var(--error)',
    color: 'var(--text-primary)',
};

export const WARN_BANNER = {
    background: 'color-mix(in srgb, var(--warning) 8%, var(--bg-secondary))',
    borderColor: 'var(--warning)',
    color: 'var(--text-primary)',
};

export const smallButton = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border disabled:opacity-50 flex-shrink-0';

export function Composer({ text, onText, ideas, onRun, onUseIdea, creating, t }: ComposerProps) {
    return (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-lg border flex flex-col gap-1.5 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <label className="text-[11px] text-[var(--text-tertiary)]" htmlFor="meeting-rules-composer">
                {t('meetings.rules_ai_hint', 'Say what should happen after a meeting; the ideas stay inside meeting notes.')}
            </label>
            <input
                id="meeting-rules-composer"
                type="text"
                value={text}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onText(e.target.value)}
                placeholder={t('meetings.rules_ai_placeholder', 'put the decisions in the sales knowledge base')}
                className="w-full px-2 py-1 rounded-md border text-[12px] [border-color:var(--border-default)] [background:var(--bg-card)] [color:var(--text-primary)]!"
            />
            <button
                type="button" onClick={onRun} disabled={ideas.busy}
                className={`${smallButton} self-start [border-color:var(--accent-primary)] [color:var(--accent-primary)]`}
                data-testid="rules-composer-run"
            >
                {ideas.busy
                    ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    : <Sparkles className="w-3 h-3" aria-hidden="true" />}
                {ideas.busy ? t('meetings.rules_ai_busy_label', 'Looking…') : t('meetings.rules_ai_go', 'Get ideas')}
            </button>

            {ideas.error && (
                <div className="px-2 py-1.5 rounded-md border text-[11px]" style={ERROR_BANNER} role="status" data-testid="rules-ai-error">
                    {ideas.error}
                </div>
            )}
            {!ideas.busy && ideas.ran && !ideas.error && ideas.items.length === 0 && (
                <div className="px-2 py-1.5 rounded-md border text-[11px]" style={WARN_BANNER} data-testid="rules-ai-reason">
                    {ideas.reason === 'no_integrations'
                        ? t('meetings.rules_ai_no_apps', 'No connected apps to look at yet, so there is nothing to base an idea on.')
                        : ideas.reason === 'no_patterns'
                            ? t('meetings.rules_ai_no_patterns', 'The scan ran and found nothing worth turning into a rule yet.')
                            : t('meetings.rules_ai_empty', 'The scan ran and came back with nothing.')}
                </div>
            )}
            {ideas.items.map((idea: RuleIdea, i: number) => (
                <div key={idea?.id ?? `idea-${i}`} className="px-2 py-1.5 rounded-md border flex flex-col gap-1 border-[var(--border-subtle)] bg-[var(--bg-card)]" data-testid="rules-idea">
                    <span className="text-[12px] font-medium text-[var(--text-primary)]">{idea?.title}</span>
                    {idea?.description && (
                        <span className="text-[11px] leading-snug text-[var(--text-tertiary)]">{idea.description}</span>
                    )}
                    <button
                        type="button" onClick={() => onUseIdea(idea)} disabled={creating}
                        className={`${smallButton} self-start [border-color:var(--border-default)] [color:var(--text-secondary)]`}
                    >
                        {t('meetings.rules_idea_build', 'Start this rule')}
                    </button>
                </div>
            ))}
        </div>
    );
}
