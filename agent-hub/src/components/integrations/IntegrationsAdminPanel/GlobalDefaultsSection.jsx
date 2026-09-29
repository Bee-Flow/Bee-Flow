// "Integrations" section of the IntegrationsAdminPanel (Global Defaults for
// new organisations). Subtree moved verbatim from IntegrationsAdminPanel.jsx;
// all bindings are threaded in as props from the panel.
import { Settings, ToggleLeft, ToggleRight } from 'lucide-react';
import React from 'react';

export default function GlobalDefaultsSection({
    enableAllDefaults, disableAllDefaults, categories, allIntegrations,
    isDefaultEnabled, toggleDefault,
}) {
    return (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-8">

                {/* Global Defaults */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div>
                            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Global Defaults</h3>
                            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                Default integrations for new organizations. Changes here don't affect existing orgs.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={enableAllDefaults} className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80" style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981' }}>
                                Enable All
                            </button>
                            <button onClick={disableAllDefaults} className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-80" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }}>
                                Disable All
                            </button>
                        </div>
                    </div>
                    <div className="p-4">
                        {categories.map(cat => (
                            <div key={cat} className="mb-4 last:mb-0">
                                <div className="text-xs font-semibold uppercase tracking-wider mb-2 px-2" style={{ color: 'var(--text-muted)' }}>{cat}</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                    {allIntegrations.filter(i => i.category === cat).map(integ => {
                                        const enabled = isDefaultEnabled(integ.id);
                                        return (
                                            <button key={integ.id} onClick={() => toggleDefault(integ.id)}
                                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all hover:scale-[1.01]"
                                                style={{ background: enabled ? 'rgba(16, 185, 129, 0.06)' : 'var(--bg-primary)', border: `1px solid ${enabled ? 'rgba(16, 185, 129, 0.2)' : 'var(--border-subtle)'}` }}>
                                                {enabled
                                                    ? <ToggleRight className="w-5 h-5 shrink-0" style={{ color: '#10b981' }} />
                                                    : <ToggleLeft className="w-5 h-5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                                                }
                                                {integ.icon && <span className="text-base shrink-0">{integ.icon}</span>}
                                                <div className="min-w-0">
                                                    <div className="text-sm font-medium truncate" style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>{integ.label}</div>
                                                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{integ.description}</div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Per-organisation & per-group integration access moved to the
                    unified Access & Permissions hub (Admin → Access). */}
                <div className="rounded-2xl border p-4 flex items-start gap-3" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <Settings className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#3b82f6' }} />
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        Who may use each integration — per organisation, per group, or for all members — is now managed in
                        <strong> Admin → Access &amp; Permissions</strong>. The defaults above only seed integrations for newly created organisations.
                    </p>
                </div>

            </div>
            </div>
    );
}
