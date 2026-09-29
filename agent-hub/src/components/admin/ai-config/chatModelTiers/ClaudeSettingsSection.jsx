// "Claude Settings" section of ChatModelTiersConfig (recommended defaults
// table + robustness toggles). Subtree moved verbatim from
// ChatModelTiersConfig.jsx; all bindings are threaded in as props.
import React from 'react';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, TIERS } from './constants';
import { getModelMeta } from './modelMeta';

export default function ClaudeSettingsSection({
    claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage,
    claudeRecAppliedTier, saveClaudeSettings,
    applyClaudeRecommendedForTier, applyAllClaudeRecommended,
}) {
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(217, 119, 6, 0.15)' }}>🧠</div>
                    <div className="flex-1">
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Claude Settings</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Bee Flow's recommended Claude defaults per tier, plus Claude-specific robustness knobs.
                        </p>
                    </div>
                    <button
                        onClick={applyAllClaudeRecommended}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90 transition-opacity"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        Apply all recommended
                    </button>
                </div>

                {claudeMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${claudeMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {claudeMessage.text}
                    </div>
                )}

                {/* Per-tier recommendations table */}
                <div className="rounded-xl border overflow-hidden mb-5" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">Tier</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">Model</th>
                                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">Max tokens</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">Effort</th>
                                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">Budget</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">Notes</th>
                                    <th className="px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {CLAUDE_REC_TIER_ORDER.map(tierKey => {
                                    const rec = CLAUDE_RECOMMENDED[tierKey];
                                    const tier = TIERS.find(t => t.key === tierKey);
                                    const flash = claudeRecAppliedTier === tierKey;
                                    const meta = getModelMeta(rec.modelId);
                                    const displayName = meta?.name || rec.modelId;
                                    return (
                                        <tr key={tierKey}
                                            style={{
                                                borderTop: '1px solid var(--border-default)',
                                                background: flash ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
                                                transition: 'background 300ms ease',
                                                color: 'var(--text-primary)',
                                            }}
                                        >
                                            <td className="px-3 py-2">
                                                <span className="font-medium">{tier?.label || tierKey}</span>
                                            </td>
                                            <td className="px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                                {displayName}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.maxTokens.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2">
                                                {rec.reasoningEffort || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.budgetTokens
                                                    ? rec.budgetTokens.toLocaleString()
                                                    : <span style={{ color: 'var(--text-muted)' }}>adaptive</span>}
                                            </td>
                                            <td className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                                                {rec.note}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <button
                                                    onClick={() => applyClaudeRecommendedForTier(tierKey)}
                                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium border hover:bg-white/5 transition-colors"
                                                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                                >
                                                    Apply
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
                <p className="text-[11px] mb-5 italic" style={{ color: 'var(--text-muted)' }}>
                    Apply patches the local tier configuration above — click "Save Tier Configuration" to persist.
                </p>

                {/* Robustness toggles */}
                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <div className="flex items-start gap-3">
                        <div
                            className="flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer shrink-0"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
                            onClick={() => { const next = !claudeAutoRetry; setClaudeAutoRetry(next); saveClaudeSettings(next); }}
                        >
                            <div className={`w-9 h-5 rounded-full relative transition-colors ${claudeAutoRetry ? 'bg-green-500' : 'bg-gray-600'}`}>
                                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${claudeAutoRetry ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </div>
                            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                                {claudeAutoRetry ? 'Enabled' : 'Disabled'}
                            </span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                Auto-retry on empty output
                            </div>
                            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                When a Claude turn finishes with thinking but no text (adaptive thinking consumed the whole budget), do one follow-up call without thinking so the model writes a real answer based on what it already deliberated. Strongly recommended.
                            </p>
                            {claudeSaving && (
                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>Saving…</p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
    );
}
