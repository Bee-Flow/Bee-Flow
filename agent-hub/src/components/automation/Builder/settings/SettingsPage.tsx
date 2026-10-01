import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { readinessStamp, useReadiness } from '../../../../api/queries/automation/readiness';
import AssistantCapabilities from '../chat/AssistantCapabilities';
import AdvancedSection from './AdvancedSection';
import AiActSection, { aiActOpen, aiActVisible } from './AiActSection';
import GeneralSection from './GeneralSection';
import NotificationsSection from './NotificationsSection';
import ReadinessRail from './ReadinessRail';
import SharingSection from './SharingSection';
import StartSection from './StartSection';
import { ReadOnlyFieldset, canEditRoutine, useQueuedSave } from './settingsUi';
import type { SaveFn, SettingsAutomation } from './settingsUi';

export type SettingsSectionId = 'general' | 'start' | 'notifications' | 'sharing' | 'ai-act' | 'advanced' | 'assistant';
export const SETTINGS_SECTIONS: SettingsSectionId[] = ['general', 'start', 'notifications', 'sharing', 'ai-act', 'assistant', 'advanced'];

export interface SettingsPageProps {
    automation: SettingsAutomation | null;
    onSave: SaveFn;
    workMode?: string;
    onWorkModeChange?: (mode: string) => void;
    /** Section to scroll to on open (a deep link, or a click in the header/rail). */
    initialSection?: SettingsSectionId | string | null;
    /** Switch the builder to another tab ('build', 'runs', 'versions'). */
    onOpenTab?: (tab: string) => void;
    /** The routine row changed outside `onSave` (trash, restore). */
    onAutomationChange?: (next: SettingsAutomation) => void;
}

const isSection = (v: unknown): v is SettingsSectionId => SETTINGS_SECTIONS.includes(v as SettingsSectionId);

/*
 * The page folds by its OWN width (@container/settings), in three stages:
 *
 *   narrow  < 900    one column: the contents as a row of links on top, the
 *                    sections, the checklist at the end
 *   middle  900+     260 · sections (max 860), centred: the checklist sits
 *                    under the contents, so the sections get the room
 *   wide    1400+    260 · sections (max 860) · rail 340, centred; 2200+
 *                    grows a little (280 · 960 · 380), never edge to edge
 *
 * The rail's extras (the AI Act card, which the AI Act section repeats, and
 * the "Map fields automatically" note) only show in the wide stage.
 */
const PAGE_GRID = [
    'min-h-full grid grid-cols-1',
    '@[900px]/settings:grid-cols-[260px_minmax(0,860px)] @[900px]/settings:justify-center',
    '@[1400px]/settings:grid-cols-[260px_minmax(0,860px)_340px]',
    '@[2200px]/settings:grid-cols-[280px_minmax(0,960px)_380px]',
].join(' ');
const SIDE = 'contents @[900px]/settings:block @[900px]/settings:col-start-1 @[900px]/settings:row-start-1 @[900px]/settings:border-r border-[var(--border-default)] @[1400px]/settings:contents';
const SIDE_STICKY = 'contents @[900px]/settings:block @[900px]/settings:sticky @[900px]/settings:top-0 @[1400px]/settings:contents';
const TOC_CELL = 'row-start-1 min-w-0 @[1400px]/settings:col-start-1 @[1400px]/settings:border-r border-[var(--border-default)]';
const TOC_NAV = 'sticky top-0 flex flex-wrap gap-1 px-4 pt-5 @[900px]/settings:flex-col @[900px]/settings:flex-nowrap @[900px]/settings:gap-0.5 @[900px]/settings:py-6';
const RAIL_CELL = 'row-start-3 min-w-0 border-t border-[var(--border-default)] @[900px]/settings:border-t-0 @[1400px]/settings:col-start-3 @[1400px]/settings:row-start-1 @[1400px]/settings:border-l';
const RAIL_ASIDE = 'sticky top-0 px-4 py-6 @[900px]/settings:pt-0 @[1400px]/settings:px-5 @[1400px]/settings:pt-6';
const RAIL_EXTRAS = 'hidden @[1400px]/settings:contents';
const CONTENT = 'min-w-0 row-start-2 px-4 py-6 @[900px]/settings:row-start-1 @[900px]/settings:col-start-2 @[900px]/settings:px-10';

/**
 * The routine's Settings page (Studio → Automations handoff 5, artboard 5b):
 * a table of contents (260), the sections split by 1px rules, and the
 * readiness rail (340). The page folds by its OWN width (PAGE_GRID above):
 * on a laptop the checklist moves under the contents, on a narrow page the
 * contents become a row of links.
 *
 * Everything saves by itself through `onSave` (the builder's one saving state
 * machine, which also drives "Automatically saved" in the header); only a
 * dialog with its own button waits for a click.
 */
export default function SettingsPage({ automation, onSave: saveRow, initialSection: link = null, onAutomationChange, workMode = 'approve', onWorkModeChange }: SettingsPageProps) {
    const { t } = useTranslation();
    const initialSection = link;
    const onSave = useQueuedSave(saveRow, automation?.definition);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const sectionRefs = useRef<Partial<Record<SettingsSectionId, HTMLElement | null>>>({});
    const [active, setActive] = useState<SettingsSectionId>(isSection(initialSection) ? initialSection : 'general');
    const readiness = useReadiness(automation?.id || null, readinessStamp(automation));
    const showAiAct = aiActVisible(readiness.data);
    const aiActLinkReady = initialSection === 'ai-act' && showAiAct;
    const readOnly = !!automation && !canEditRoutine(automation);

    const labels: Record<SettingsSectionId, string> = {
        general: t('routines.settings.general', 'General'),
        start: t('routines.settings.start_section', 'Start'),
        notifications: t('routines.settings.notifications', 'Notifications'),
        sharing: t('routines.settings.sharing', 'Who can do what'),
        'ai-act': t('routines.settings.ai_act', 'AI Act check'),
        assistant: t('routines.assistant.title', 'Assistant'),
        advanced: t('routines.settings.advanced', 'Advanced'),
    };
    const visible = SETTINGS_SECTIONS.filter((s) => (s !== 'ai-act' || showAiAct) && (s !== 'assistant' || !!onWorkModeChange));

    const scrollTo = (id: SettingsSectionId) => {
        setActive(id);
        const el = sectionRefs.current[id];
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Deep link: scroll once the section is mounted. The AI Act section only
    // mounts when the readiness answer says it applies, so wait for that too.
    useEffect(() => {
        if (!isSection(initialSection)) return;
        setActive(initialSection);
        const el = sectionRefs.current[initialSection];
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    }, [initialSection, aiActLinkReady]);

    // Scroll-spy: the topmost section in the upper part of the page is the
    // active TOC entry. The observer only reports sections whose visibility
    // CHANGED, so it keeps the state of all of them and picks in page order.
    useEffect(() => {
        const root = scrollRef.current;
        if (!root || typeof IntersectionObserver === 'undefined') return undefined;
        const inView = new Map<string, boolean>();
        const observer = new IntersectionObserver((entries) => {
            for (const e of entries) inView.set(e.target.getAttribute('data-section') || '', e.isIntersecting);
            const top = SETTINGS_SECTIONS.find((id) => inView.get(id));
            if (top) setActive(top);
        }, { root, rootMargin: '0px 0px -60% 0px' });
        for (const el of Object.values(sectionRefs.current)) if (el) observer.observe(el);
        // At the very bottom a short last section never reaches the upper
        // part of the page; it is the one being read then.
        const onScroll = () => {
            if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) setActive('advanced');
        };
        root.addEventListener('scroll', onScroll, { passive: true });
        return () => { observer.disconnect(); root.removeEventListener('scroll', onScroll); };
    }, [showAiAct]);

    const section = (id: SettingsSectionId, body: ReactNode) => (
        <section
            key={id}
            data-section={id}
            aria-label={labels[id]}
            ref={(el) => { sectionRefs.current[id] = el; }}
            className="scroll-mt-6 py-[22px] first:pt-0 border-t first:border-t-0 border-[var(--border-default)]"
        >
            {body}
        </section>
    );

    return (
        <div ref={scrollRef} className="@container/settings h-full overflow-y-auto bg-[var(--bg-primary)] text-[12px] text-[var(--text-primary)]">
            <div className={PAGE_GRID}>
                {/* The side column. Wide: it dissolves (contents) and the table
                    of contents and the rail each take their own column. Middle:
                    one sticky column, contents above the checklist. Narrow: it
                    dissolves again, contents on top and the rail at the end. */}
                <div className={SIDE}>
                    <div className={SIDE_STICKY}>
                        <div className={TOC_CELL}>
                            <nav aria-label={t('routines.settings.toc', 'Settings sections')} className={TOC_NAV}>
                                {visible.map((id) => {
                                    const current = active === id;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            aria-current={current ? 'true' : undefined}
                                            onClick={() => scrollTo(id)}
                                            className={`flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-left text-[12px] border transition ${current
                                                ? 'bg-[var(--bg-card)] border-[var(--border-default)] font-semibold text-[var(--text-primary)]'
                                                : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                                        >
                                            {labels[id]}
                                            {id === 'ai-act' && aiActOpen(readiness.data) && (
                                                <span
                                                    className="ml-auto w-[7px] h-[7px] rounded-full bg-[var(--warning)]"
                                                    role="img"
                                                    aria-label={t('routines.settings.ai_act_missing', 'Not done yet')}
                                                />
                                            )}
                                        </button>
                                    );
                                })}
                            </nav>
                        </div>
                        <div className={RAIL_CELL}>
                            <aside className={RAIL_ASIDE} aria-label={t('routines.settings.readiness', 'Ready to activate?')}>
                                <ReadinessRail
                                    automation={automation}
                                    onOpenSection={(id: string) => { if (isSection(id)) scrollTo(id); }}
                                    extrasClassName={RAIL_EXTRAS}
                                />
                            </aside>
                        </div>
                    </div>
                </div>
                <div className={CONTENT}>
                    {readOnly && (
                        <p role="note" className="mb-4 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                            {t('routines.settings.read_only', 'You can look at these settings. Only the owner and people who can edit may change them.')}
                        </p>
                    )}
                    {section('general', <GeneralSection automation={automation} onSave={onSave} onAutomationChange={onAutomationChange} readOnly={readOnly} />)}
                    {section('start', <ReadOnlyFieldset readOnly={readOnly}><StartSection automation={automation} onSave={onSave} /></ReadOnlyFieldset>)}
                    {section('notifications', <ReadOnlyFieldset readOnly={readOnly}><NotificationsSection automation={automation} onSave={onSave} /></ReadOnlyFieldset>)}
                    {section('sharing', <SharingSection automation={automation} onSave={onSave} onAutomationChange={onAutomationChange} />)}
                    {showAiAct && section('ai-act', <AiActSection automation={automation} onSave={onSave} />)}
                    {onWorkModeChange && section('assistant', <AssistantCapabilities workMode={workMode} onChange={onWorkModeChange} />)}
                    {section('advanced', <AdvancedSection automation={automation} onSave={onSave} defaultOpen={initialSection === 'advanced'} readOnly={readOnly} />)}
                </div>
            </div>
        </div>
    );
}
