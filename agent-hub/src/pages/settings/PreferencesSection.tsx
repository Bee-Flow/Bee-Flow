import React, { useState, useEffect, useRef } from 'react';
import AiParticipationSection from './AiParticipationSection';
import AvatarPicker from './AvatarPicker';
import { roleLabel as roleLabelFor } from './roleLabel';
import useProjectsAvailable from '../../hooks/useProjectsAvailable';
import { useTranslation } from '../../hooks/useTranslation';
import { useViewport } from '../../hooks/useViewport';
import { Check, ChevronDown } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { mutate } from '../../api/mutate';
import scopedStorage from '../../utils/scopedStorage';
import MeetingNotesSection from './MeetingNotesSection';
import GoogleMeetNotesSection from './GoogleMeetNotesSection';
import TeamsMeetingNotesSection from './TeamsMeetingNotesSection';
import SummaryTemplatesSection from './SummaryTemplatesSection';
import VoiceprintSection from './VoiceprintSection';
import EditorPreferencesSection from './EditorPreferencesSection';
import type { PreferencesUser, PreferencesAgent, PreferencesSectionProps, RowProps, DropdownOption, DropdownProps, ToggleProps, UiLocale } from './PreferencesSection.types';

// ── Generic list row used in the General container ───────────────────────────
const Row = ({ label, description, right, first }: RowProps) => (
    <div
        className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5"
        style={{
            borderTop: first ? 'none' : '1px solid var(--border-subtle)',
        }}
    >
        <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{label}</p>
            {description && (
                <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">{description}</p>
            )}
        </div>
        <div className="flex-shrink-0 w-full sm:w-auto">{right}</div>
    </div>
);

// ── Shared dropdown used for Language and Chat History ──────────────────────
// `ariaLabel` names the trigger (pass the row label): its visible text is the
// current value only.
const Dropdown = ({ value, options, onChange, ariaLabel }: DropdownProps) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
        document.addEventListener('mousedown', handler);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const current = options.find((o: DropdownOption) => o.value === value) || options[0];

    return (
        <div className="relative" ref={ref}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel ? `${ariaLabel}: ${current?.label ?? ''}` : undefined}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[13px] transition-colors bg-[var(--bg-primary)] text-[var(--text-primary)] ${open ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'}`}
            >
                <span>{current?.label}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform text-[var(--text-muted)] ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div
                    role="listbox"
                    aria-label={ariaLabel}
                    className="absolute left-0 sm:left-auto sm:right-0 top-full mt-1 min-w-44 max-w-[calc(100vw-2.5rem)] rounded-lg border shadow-xl py-1 z-50 bg-[var(--bg-secondary)] border-[var(--border-default)]"
                >
                    {options.map((o: DropdownOption) => (
                        <button
                            key={o.value}
                            type="button"
                            role="option"
                            aria-selected={value === o.value}
                            onClick={() => { onChange(o.value); setOpen(false); }}
                            className={`w-full px-3 py-2 text-left text-[13px] flex items-center justify-between transition-colors hover:bg-[var(--bg-tertiary)] ${value === o.value ? 'text-[var(--accent-primary)]' : 'text-[var(--text-primary)]'}`}
                        >
                            <span>{o.label}</span>
                            {value === o.value && <Check className="w-4 h-4" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── iOS-style toggle ─────────────────────────────────────────────────────────
const Toggle = ({ on, onClick, disabled, ariaLabel }: ToggleProps) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={on}
        aria-label={ariaLabel}
        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
        style={{
            background: on ? 'var(--accent-primary)' : 'var(--border-default)',
            opacity: disabled ? 0.6 : 1,
        }}
    >
        <div
            className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
            style={{ transform: on ? 'translateX(20px)' : 'translateX(0)' }}
        />
    </button>
);

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <p
        className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]"
    >
        {children}
    </p>
);

const PreferencesSection = ({
    defaultAgentMode,
    setDefaultAgentMode,
    defaultAgentId,
    setDefaultAgentId,
    agents,
    onLogout,
    user,
    onUpdateUser,
}: PreferencesSectionProps) => {
    const { t, locale, setLocale } = useTranslation();
    const [localUser, setLocalUser] = useState(user);
    useEffect(() => { if (user) setLocalUser(user); }, [user]);

    const isSimpleMode = !!localUser?.simpleMode;
    // "AI in team chats" acts only in projects: shown where they can be used.
    const projectsOn = useProjectsAvailable(localUser);
    // Phone-sized screens force Simple Mode on (see AgentHub's `simpleMode`
    // derivation). The stored preference is still what we read/write here, but
    // the toggle is shown on + locked so it matches the simplified surface the
    // user actually sees and doesn't look like a no-op.
    const { isMobile } = useViewport();
    const showAgentSelect = defaultAgentMode === 'specific';

    // Chat history — user-scoped, broadcast for live sidebar updates.
    const [chatHistoryMode, setChatHistoryModeRaw] = useState(
        () => scopedStorage.getItem('chatHistoryMode') || 'per-agent'
    );
    const setChatHistoryMode = (v: string) => {
        setChatHistoryModeRaw(v);
        scopedStorage.setItem('chatHistoryMode', v);
        window.dispatchEvent(new CustomEvent('chatHistoryModeChanged', { detail: v }));
    };

    // Available UI locales (only render the row if more than one).
    const [locales, setLocales] = useState<UiLocale[]>([]);
    useEffect(() => {
        authFetch(`${API_BASE}/api/languages/user/locales`)
            .then((r: Response) => r.json())
            .then((data: unknown) => { if (Array.isArray(data)) setLocales(data); })
            .catch(e => console.warn('[Preferences] load locales failed', e));
    }, []);

    // Simple Mode toggle (lifted from SimpleModeSection).
    const [simpleSaving, setSimpleSaving] = useState(false);
    const handleSimpleModeToggle = async () => {
        const newVal = !isSimpleMode;
        setLocalUser(prev => ({ ...prev, simpleMode: newVal }));
        if (onUpdateUser) onUpdateUser({ simpleMode: newVal });
        setSimpleSaving(true);
        try {
            await mutate(`${API_BASE}/ai/user-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ simpleMode: newVal }),
            });
        } catch {
            setLocalUser(prev => ({ ...prev, simpleMode: !newVal }));
            if (onUpdateUser) onUpdateUser({ simpleMode: !newVal });
        }
        setSimpleSaving(false);
    };

    const handleAvatarSaved = (avatar: string | null, avatarType: string | null) => {
        setLocalUser(prev => ({ ...prev, avatar, avatarType }));
        // Lift the change to the app-level `user` so the sidebar footer avatar
        // updates too — without this only the Settings panel reflected the new
        // image until a hard reload (BFSF-182). Mirrors handleSimpleModeToggle.
        if (onUpdateUser) onUpdateUser({ avatar, avatarType });
    };

    const effectiveRole = localUser?.orgRole || localUser?.role;
    const roleLabel = roleLabelFor(effectiveRole, t);
    const isAdminRole = (['admin', 'org_admin'] as readonly (string | undefined)[]).includes(effectiveRole);

    const hasLanguageRow = locales.length > 1;
    const showStartup = !isSimpleMode;
    const showChatHistory = !isSimpleMode;

    const localeOptions = locales.map((l: UiLocale) => ({ value: l.code, label: l.name }));
    const chatHistoryOptions = [
        { value: 'per-agent', label: t('settings.chat_history_per_agent', 'Per agent') },
        { value: 'all-chats', label: t('settings.chat_history_all_chats', 'All chats') },
    ];
    const startupOptions = [
        { value: 'last-used', label: t('settings.continue_where_left', 'Continue where you left off') },
        { value: 'specific', label: t('settings.always_open_specific', 'Always open a specific agent') },
        { value: 'direct-chat', label: t('settings.start_direct_chat', 'Start with Direct Chat') },
    ];

    return (
        <div className="space-y-7">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('settings.preferences', 'Preferences')}</h2>

            {/* ── Profile strip ── */}
            {localUser && (
                <div
                    className="flex items-center gap-4 px-5 py-4 rounded-xl"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                    <AvatarPicker user={localUser} onSaved={handleAvatarSaved} />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-[15px] font-semibold truncate text-[var(--text-primary)]">
                                {localUser.displayName || localUser.username || 'User'}
                            </p>
                            {roleLabel && (
                                <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isAdminRole
                                        ? 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-ink)]'
                                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}
                                >
                                    {roleLabel}
                                </span>
                            )}
                        </div>
                        {localUser.email && (
                            <p className="text-[12px] truncate mt-0.5 text-[var(--text-muted)]">
                                {localUser.email}
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* ── General ── */}
            <div>
                <SectionLabel>{t('settings.general_section', 'General')}</SectionLabel>
                <div
                    className="rounded-xl"
                    style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}
                >
                    {hasLanguageRow && (
                        <Row
                            first
                            label={t('settings.interface_language')}
                            right={<Dropdown value={locale} options={localeOptions} onChange={setLocale} ariaLabel={t('settings.interface_language')} />}
                        />
                    )}
                    {showChatHistory && (
                        <Row
                            first={!hasLanguageRow}
                            label={t('settings.chat_history')}
                            description={t('settings.chat_history_desc')}
                            right={
                                <Dropdown
                                    value={chatHistoryMode}
                                    options={chatHistoryOptions}
                                    onChange={setChatHistoryMode}
                                    ariaLabel={t('settings.chat_history')}
                                />
                            }
                        />
                    )}
                    {showStartup && (
                        <Row
                            first={!hasLanguageRow && !showChatHistory}
                            label={t('settings.startup_behavior', 'Startup')}
                            description={t('settings.startup_behavior_desc', 'Choose what opens when you launch Bee Flow')}
                            right={
                                <Dropdown
                                    value={defaultAgentMode}
                                    options={startupOptions}
                                    onChange={setDefaultAgentMode}
                                    ariaLabel={t('settings.startup_behavior', 'Startup')}
                                />
                            }
                        />
                    )}
                    {showStartup && showAgentSelect && (
                        <div
                            className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5"
                            style={{ borderTop: '1px solid var(--border-subtle)' }}
                        >
                            <p className="text-[13px] font-medium flex-1 min-w-0 text-[var(--text-primary)]">
                                {t('settings.select_agent_label')}
                            </p>
                            <select
                                value={defaultAgentId}
                                onChange={e => setDefaultAgentId(e.target.value)}
                                aria-label={t('settings.select_agent_label')}
                                className="w-full sm:w-auto sm:min-w-[180px] px-3 py-1.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] transition-colors text-[13px]"
                                style={{
                                    borderColor: 'var(--border-default)',
                                    color: 'var(--text-primary)',
                                    background: 'var(--bg-primary)',
                                }}
                            >
                                <option value="">{t('settings.select_agent')}</option>
                                {agents.map((agent: PreferencesAgent) => (
                                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <Row
                        first={!hasLanguageRow && !showChatHistory && !showStartup}
                        label={t('settings.simple_mode_toggle', 'Enable Simple Mode')}
                        description={`${t('settings.simple_mode_desc', 'Show only New Chat, Search, Agents and your chat history. Hides Studio, Meeting Notes, Notebooks, Webpages and other settings.')}${isMobile ? ` ${t('settings.simple_mode_mobile_note', 'Always on for small screens.')}` : ''}`}
                        right={<Toggle on={isSimpleMode || isMobile} onClick={handleSimpleModeToggle} disabled={simpleSaving || isMobile} ariaLabel={t('settings.simple_mode_toggle', 'Enable Simple Mode')} />}
                    />
                </div>
            </div>

            {/* ── Editor preferences (the automation editor; hidden in Simple Mode) ── */}
            {!isSimpleMode && <EditorPreferencesSection />}

            {/* ── AI in team chats: one's own opt-out from the AI joining by itself
                   (self-hides on a server without the feature) ── */}
            <AiParticipationSection enabled={projectsOn} />

            {/* ── Nextcloud Talk Meeting Notes (self-hides when not licensed) ── */}
            <MeetingNotesSection />

            {/* ── Google Meet Meeting Notes (self-hides when not licensed/connected) ── */}
            <GoogleMeetNotesSection />

            {/* ── Microsoft Teams Meeting Notes (self-hides when not licensed/connected) ── */}
            <TeamsMeetingNotesSection />

            {/* ── My summary templates (self-hides when Meeting Notes not licensed) ── */}
            <SummaryTemplatesSection />

            {/* ── My voice profile (self-hides unless pyannoteAI is the active engine) ── */}
            <VoiceprintSection />

            {/* ── Sign out ── */}
            {onLogout && (
                <div className="flex justify-end pt-2">
                    <button
                        onClick={onLogout}
                        className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors"
                        style={{ color: '#dc2626', background: 'transparent' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(220,38,38,0.08)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                        <svg width="14" height="14" fill="none" stroke="#dc2626" viewBox="0 0 24 24" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                        </svg>
                        {/* Same key as the profile menu's Sign Out, so both read alike. */}
                        <span>{t('sidebar.sign_out', 'Sign Out')}</span>
                    </button>
                </div>
            )}
        </div>
    );
};

export default PreferencesSection;
