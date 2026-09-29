import { Lock, AlertTriangle } from 'lucide-react';
import { AUTH_METHODS, AllowedDomainsEditor } from './orgInfoShared';

// ── Sign-in Method section — extracted verbatim from OrgInfoPanel. ──
const OrgAuthSection = ({ t, isAuthLocked, orgData, setOrgData, isSelfHosted }) => (
                    <div className="max-w-xl mx-auto space-y-5 animate-fadeIn">
                        <div>
                            <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('org.signin_title')}</h2>
                            <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.signin_subtitle')}</p>
                        </div>

                        {isAuthLocked && (
                            <div className="flex gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                                <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('org.signin_locked')}</p>
                                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                        {t('org.signin_locked_desc')}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="grid gap-3">
                            {AUTH_METHODS.map(method => {
                                const isSelected = orgData.authMethod === method.id;
                                const isDisabledChoice = isAuthLocked && !isSelected;
                                return (
                                    <button
                                        key={method.id}
                                        onClick={() => { if (!isAuthLocked) setOrgData(p => ({ ...p, authMethod: method.id })); }}
                                        disabled={isDisabledChoice}
                                        className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border-2 text-left transition-all ${isSelected ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5'
                                            : isDisabledChoice ? 'border-[var(--border-subtle)] opacity-40 cursor-not-allowed'
                                                : 'border-[var(--border-subtle)] hover:border-[var(--accent-primary)]/40 hover:bg-[var(--bg-secondary)] cursor-pointer'
                                            }`}
                                    >
                                        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: isSelected ? `${method.color}15` : 'var(--bg-tertiary)' }}>
                                            <div style={{ color: isSelected ? method.color : 'var(--text-muted)' }}>{method.icon}</div>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold text-[var(--text-primary)]">{t(method.nameKey)}</span>
                                                {isSelected && isAuthLocked && (
                                                    <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-green-500/15 text-green-500">
                                                        <Lock className="w-2.5 h-2.5" />{t('org.active')}
                                                    </span>
                                                )}
                                                {isSelected && !isAuthLocked && (
                                                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-500/15 text-blue-500">{t('org.selected')}</span>
                                                )}
                                            </div>
                                            <p className="text-xs text-[var(--text-muted)] mt-0.5">{t(method.descKey)}</p>
                                        </div>
                                        <div className="shrink-0">
                                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'}`}>
                                                {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-[var(--accent-primary)]" />}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {!isAuthLocked && (
                            <div className="flex gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.12)' }}>
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
                                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                    <strong style={{ color: 'var(--text-primary)' }}>{t('org.choose_carefully')}</strong> {t('org.choose_carefully_desc')}
                                </p>
                            </div>
                        )}

                        {/* Allowed Domains (self-hosted org-management feature) */}
                        {isSelfHosted && (
                            <AllowedDomainsEditor
                                domains={orgData.allowedDomains || []}
                                onChange={(domains) => setOrgData(p => ({ ...p, allowedDomains: domains }))}
                                t={t}
                            />
                        )}
                    </div>
);

export default OrgAuthSection;
