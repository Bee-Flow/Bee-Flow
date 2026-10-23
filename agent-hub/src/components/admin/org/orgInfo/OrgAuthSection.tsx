import { Lock, AlertTriangle } from 'lucide-react';
import { useRef } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import type { OrgFormData } from './useOrgInfoForm';
import { AUTH_METHODS, AllowedDomainsEditor } from './orgInfoShared';
import type { TranslateFn } from '../../../../hooks/useTranslation';

interface AuthMethodGroupProps {
    t: TranslateFn;
    label: string;
    value: string | null;
    isAuthLocked: boolean;
    isSaving?: boolean;
    onChoose: (id: string) => void;
}

// The method cards are one radio group (ARIA APG pattern, as in
// shared/ChoiceCards): one tab stop, arrows move the choice, aria-checked
// carries what the ring and colour show.
const AuthMethodGroup = ({ t, label, value, isAuthLocked, isSaving = false, onChoose }: AuthMethodGroupProps) => {
    const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    // While the first save is in flight the choice is frozen: the server keeps
    // the method it receives first and ignores a later one.
    const frozen = isAuthLocked || isSaving;
    const choose = (id: string) => { if (!frozen) onChoose(id); };
    // Nothing chosen yet: the first card takes the tab stop.
    const tabStopIdx = Math.max(0, AUTH_METHODS.findIndex(m => m.id === value));
    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
        if (frozen) return;
        const n = AUTH_METHODS.length;
        let next;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % n;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + n) % n;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = n - 1;
        else return;
        e.preventDefault();
        choose(AUTH_METHODS[next].id);
        cardRefs.current[AUTH_METHODS[next].id]?.focus();
    };
    return (
        <div className="grid gap-3" role="radiogroup" aria-label={label} aria-busy={isSaving || undefined}>
            {AUTH_METHODS.map((method, idx) => {
                const isSelected = value === method.id;
                const isDisabledChoice = isAuthLocked && !isSelected;
                return (
                    <button
                        key={method.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        ref={(el) => { cardRefs.current[method.id] = el; }}
                        tabIndex={idx === tabStopIdx ? 0 : -1}
                        onKeyDown={(e) => onKeyDown(e, idx)}
                        onClick={() => choose(method.id)}
                        disabled={isDisabledChoice}
                        className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border-2 text-left transition-all ${isSelected ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5'
                            : isDisabledChoice ? 'border-[var(--border-subtle)] opacity-40 cursor-not-allowed'
                                : 'border-[var(--border-subtle)] hover:border-[var(--accent-primary)]/40 hover:bg-[var(--bg-secondary)] cursor-pointer'
                            }`}
                    >
                        <div aria-hidden="true" className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: isSelected ? `${method.color}15` : 'var(--bg-tertiary)' }}>
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
                        <div className="shrink-0" aria-hidden="true">
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'}`}>
                                {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-[var(--accent-primary)]" />}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
};

interface OrgAuthSectionProps {
    t: TranslateFn;
    isAuthLocked: boolean;
    isSaving?: boolean;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData | null>>;
    isSelfHosted: boolean;
}

// ── Sign-in Method section — extracted verbatim from OrgInfoPanel. ──
const OrgAuthSection = ({ t, isAuthLocked, isSaving = false, orgData, setOrgData, isSelfHosted }: OrgAuthSectionProps) => (
                    <div className="max-w-3xl space-y-5 animate-fadeIn">
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('org.signin_title')}</h2>
                            <p className="mt-1 text-sm text-[var(--text-muted)]">{t('org.signin_subtitle')}</p>
                        </div>

                        {isAuthLocked && (
                            <div className="flex gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                                <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('org.signin_locked')}</p>
                                    <p className="text-xs mt-0.5 text-[var(--text-secondary)]">
                                        {t('org.signin_locked_desc')}
                                    </p>
                                </div>
                            </div>
                        )}

                        <AuthMethodGroup
                            t={t}
                            label={t('org.signin_title')}
                            value={orgData.authMethod}
                            isAuthLocked={isAuthLocked}
                            isSaving={isSaving}
                            onChoose={(id) => setOrgData(p => ({ ...p, authMethod: id }) as OrgFormData)}
                        />

                        {!isAuthLocked && (
                            <div className="flex gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.12)' }}>
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--text-muted)]" />
                                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                                    <strong className="text-[var(--text-primary)]">{t('org.choose_carefully')}</strong> {t('org.choose_carefully_desc')}
                                </p>
                            </div>
                        )}

                        {/* Allowed Domains (self-hosted org-management feature) */}
                        {isSelfHosted && (
                            <AllowedDomainsEditor
                                domains={orgData.allowedDomains || []}
                                onChange={(domains) => setOrgData(p => ({ ...p, allowedDomains: domains }) as OrgFormData)}
                                t={t}
                            />
                        )}
                    </div>
);

export default OrgAuthSection;
