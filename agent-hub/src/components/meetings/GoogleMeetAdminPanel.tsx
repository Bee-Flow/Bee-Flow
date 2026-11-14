import { useState } from 'react';
import { Video, Loader2 } from 'lucide-react';
import { useOrgNotesSettingsQuery } from '../../api/queries/meetingNotesSettings';
import { languageOptions, Row } from '@/components/settings/shared/settingsPrimitives';
import { InheritHint, InheritSelect, InheritSwitch, OrgSettingsLoadError, orgFormFromAnswer } from '@/components/settings/shared/orgSettingFields';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { errorBody, RefusedError } from '../../api/mutate';
import { panelOrgId } from '@/utils/adminAccess';
import { apiRequest } from '@/api/typedRequest';

const MEET_GREEN = '#00832D';

interface GoogleMeetAdminPanelProps {
    user?: { organizationId?: string | null } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** `null` = each member decides (see orgSettingFields). */
interface GoogleMeetConfig {
    autoImport: boolean | null;
    autoRecordConfig: boolean | null;
    importScope: string | null;
    language: string | null;
    /** Not on the panel; kept as loaded so a save does not pin it. */
    lookbackHours?: number | null;
}

interface SaveMessage {
    type: 'success' | 'error';
    text: string | undefined;
}

const INHERITABLE = ['autoImport', 'autoRecordConfig', 'importScope', 'language', 'lookbackHours'] as const;
const DEFAULT_CFG: GoogleMeetConfig = { autoImport: null, autoRecordConfig: null, importScope: null, language: null, lookbackHours: null };

/**
 * Org-level Google Meet → Meeting Notes settings. Mirrors the Talk meeting
 * notes admin pattern. A concrete org value takes precedence over each
 * member's own setting; a field on "Each member decides" is sent as null.
 */
export default function GoogleMeetAdminPanel({ user, orgId: orgIdProp }: GoogleMeetAdminPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user);
    const settingsQuery = useOrgNotesSettingsQuery<GoogleMeetConfig>('gmeet', orgId);
    const [draft, setDraft] = useState<GoogleMeetConfig | null>(null);
    // Edits replace the whole config (defaults, then the server answer, then the person's changes).
    // The save sends it whole, so a field the org has no opinion on must stay null here.
    const cfg: GoogleMeetConfig = draft ?? { ...DEFAULT_CFG, ...orgFormFromAnswer(settingsQuery.data, INHERITABLE) };
    const setCfg = (update: (c: GoogleMeetConfig) => GoogleMeetConfig) => setDraft(update(cfg));
    const loading = !!orgId && settingsQuery.isPending;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<SaveMessage | null>(null);

    const save = async () => {
        setSaving(true); setMessage(null);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('PUT /api/gmeet-notes-settings/{orgId}', { params: { orgId: String(orgId) }, init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                setMessage({ type: 'error', text: e.error || `HTTP ${err.status}` });
            }
            if (res) setMessage({ type: 'success', text: t('common.saved', 'Saved') });
        } catch (e) { setMessage({ type: 'error', text: errorMessage(e) }); }
        finally { setSaving(false); }
    };

    if (!orgId) return null;

    return (
        <div className="mt-6">
            <div className="flex items-center gap-2 mb-2">
                <Video className="w-4 h-4" style={{ color: MEET_GREEN }} />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('meetings.admin_meet.title', 'Google Meet Meeting Notes')}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('meetings.admin_meet.intro', 'Turn recorded Google Meet meetings into Meeting Notes — transcript, summary and action items, transcribed by your organisation\'s configured transcription engine. These org settings override each member\'s personal settings.')}
            </p>
            <InheritHint />

            {loading ? (
                <div className="flex items-center gap-2 px-5 py-4 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading_ellipsis', 'Loading…')}</span>
                </div>
            ) : settingsQuery.isError ? <OrgSettingsLoadError /> : (
                <>
                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        <Row title={t('meetings.admin_meet.auto_import', 'Auto-import recorded Meet meetings')} desc={t('meetings.admin_meet.auto_import_desc', 'When a recording of a member\'s Google Meet call appears in Drive, create a Meeting Note automatically. Recording must be started in Meet — requires Google Workspace Business Standard or higher.')}>
                            <InheritSwitch ariaLabel={t('meetings.admin_meet.auto_import', 'Auto-import recorded Meet meetings')} value={cfg.autoImport} onChange={(v) => setCfg((c: GoogleMeetConfig) => ({ ...c, autoImport: v }))} disabled={saving} />
                        </Row>
                        <Row title={t('meetings.admin_meet.auto_record', 'Pre-enable auto-recording for meetings members organize')} desc={t('meetings.admin_meet.auto_record_desc', 'Configure Meet to start recording automatically for meetings members organize, so nothing is missed.')}>
                            <InheritSwitch ariaLabel={t('meetings.admin_meet.auto_record', 'Pre-enable auto-recording for meetings members organize')} value={cfg.autoRecordConfig} onChange={(v) => setCfg((c: GoogleMeetConfig) => ({ ...c, autoRecordConfig: v }))} disabled={saving} />
                        </Row>
                        <Row title={t('meetings.admin_meet.which', 'Which meetings')} desc={t('meetings.admin_meet.which_desc', 'Import only meetings members organize, or every Meet meeting on their calendars.')}>
                            <InheritSelect ariaLabel={t('meetings.admin_meet.which', 'Which meetings')} value={cfg.importScope} disabled={saving} onChange={(v) => setCfg((c: GoogleMeetConfig) => ({ ...c, importScope: v }))}
                                options={[{ value: 'organizer', label: t('meetings.admin_meet.scope_organizer', 'Meetings they organize') }, { value: 'calendar', label: t('meetings.admin_meet.scope_calendar', 'All calendar meetings') }]} />
                        </Row>
                        <Row title={t('meetings.admin_meet.language', 'Default language')} desc={t('meetings.admin_meet.language_desc', 'Language used when transcribing Meet recordings.')}>
                            <InheritSelect
                                ariaLabel={t('meetings.admin_meet.language', 'Default language')}
                                value={cfg.language} onChange={(v) => setCfg((c: GoogleMeetConfig) => ({ ...c, language: v }))} disabled={saving}
                                options={languageOptions(cfg.language).map((l) => ({ value: l.code, label: l.label }))}
                            />
                        </Row>
                    </div>

                    <div className="flex items-center gap-3 mt-3">
                        <button
                            onClick={save} disabled={saving}
                            className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                        </button>
                        {message && (
                            <span className={`text-[12px] font-medium ${message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>
                                {message.type === 'success' ? '✓' : '⚠'} {message.text}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
