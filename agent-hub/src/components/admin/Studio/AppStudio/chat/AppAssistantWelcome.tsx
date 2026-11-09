import { ListChecks, Sparkles } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition } from '../inspector/appDefinition';
import { findNode } from '../state/definitionOps';
import { countComponents } from './builderPaneModel';

/** Where a pick came from: an idea is a small targeted ask, a brief is a whole app in words. */
export type WelcomePickKind = 'idea' | 'brief';

interface AppAssistantWelcomeProps {
    definition?: AppDefinition | null;
    /** The component the person has selected on the canvas. */
    selectedNodeId?: string | null;
    /** Tables of the app; null while unknown. */
    tableCount?: number | null;
    /** Sends the text as the person's own message. */
    onPick?: (text: string, kind: WelcomePickKind) => void;
    /** The current work mode ('describe' | 'discuss' | 'plan' | 'build'). */
    workMode?: string;
    /** Switches the work mode; absent = the welcome cannot offer it. */
    onWorkModeChange?: ((mode: string) => void) | null;
}

const CHIP_CLASS = 'flex items-center gap-2.5 text-left text-xs p-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--type-ai)] transition';

/** An app with nothing built in it: no component on any screen and no table. */
export function isEmptyApp(definition: AppDefinition | null | undefined, tableCount: number | null | undefined): boolean {
    return countComponents(definition) === 0 && !tableCount;
}

/** Three briefs a person could have written themselves; a click sends one. */
function appExampleBriefs(t: TranslateFn): string[] {
    return [
        t('app_studio.builder.welcome.brief.intake', 'An intake app: people fill in a request form, I see all requests in a table, and an overview screen shows what is open'),
        t('app_studio.builder.welcome.brief.planner', 'A team planner: who works on what this week, with a table of tasks and a screen to add and reassign them'),
        t('app_studio.builder.welcome.brief.crm', 'A simple CRM: a table of contacts with notes, a screen to add a contact, and an overview of the latest conversations'),
    ];
}

/** What the selected component is called to the person. */
function selectedLabelOf(definition: AppDefinition | null | undefined, nodeId: string | null | undefined): string {
    if (!definition || !nodeId) return '';
    const node = findNode(definition, nodeId)?.node;
    if (!node) return '';
    const props = (node.props || {}) as Record<string, unknown>;
    for (const field of ['label', 'title', 'name', 'text']) {
        const v = props[field];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return node.type || '';
}

function plural(t: TranslateFn, noun: 'screens' | 'tables', n: number): string {
    if (n === 0) return t(`app_studio.builder.welcome.${noun}_none`, noun === 'screens' ? 'no screens yet' : 'no tables yet');
    if (n === 1) return t(`app_studio.builder.welcome.${noun}_one`, noun === 'screens' ? '1 screen' : '1 table');
    return t(`app_studio.builder.welcome.${noun}_many`, noun === 'screens' ? '{n} screens' : '{n} tables', { n });
}

/** "I can see 4 screens and 2 tables." What the assistant has in front of it. */
function seenSentence(definition: AppDefinition | null | undefined, tableCount: number | null | undefined, t: TranslateFn): string {
    const screens = plural(t, 'screens', (definition?.screens || []).length);
    if (typeof tableCount !== 'number') return t('app_studio.builder.welcome.sees_screens_only', 'I can see {screens}.', { screens });
    return t('app_studio.builder.welcome.sees', 'I can see {screens} and {tables}.', { screens, tables: plural(t, 'tables', tableCount) });
}

/** At most three things worth asking next, read off the app itself. Each is a whole message. */
export function welcomeIdeas(definition: AppDefinition | null | undefined, hasSelection: boolean, tableCount: number | null | undefined, t: TranslateFn): string[] {
    const ideas: string[] = [];
    const add = (key: string, fallback: string) => ideas.push(t(`app_studio.builder.welcome.suggest.${key}`, fallback));
    if (hasSelection) {
        add('connect', 'Connect the selected component to data from a table');
        add('layout', 'Improve the layout of the selected component');
    }
    if (tableCount === 0) add('store', 'Store what people enter in a table');
    if ((definition?.screens || []).length) add('explain', 'Explain what this app does, screen by screen');
    add('new_screen', 'Add a new screen that fits what this app does');
    return [...new Set(ideas)].slice(0, 3);
}

function IdeaList({ ideas, onPick, kind, testId }: { ideas: string[]; onPick?: (text: string, kind: WelcomePickKind) => void; kind: WelcomePickKind; testId: string }) {
    if (!ideas.length) return null;
    return (
        <div className="flex flex-col gap-2">
            {ideas.map((text) => (
                <button key={text} type="button" data-testid={testId} disabled={!onPick} onClick={() => onPick?.(text, kind)} className={CHIP_CLASS}>
                    <Sparkles size={14} className="shrink-0 text-[var(--text-tertiary)]" /><span>{text}</span>
                </button>
            ))}
        </div>
    );
}

/** The empty app: what should it do, the offer of "Describe it", and three example briefs. */
function EmptyAppWelcome({ onPick, workMode, onWorkModeChange }: Pick<AppAssistantWelcomeProps, 'onPick' | 'workMode' | 'onWorkModeChange'>) {
    const { t } = useTranslation();
    // Both modes ask a few questions before they plan; only 'describe' is offered.
    const planning = workMode === 'describe' || workMode === 'plan';
    return (
        <div className="flex flex-col gap-5 py-5 text-left">
            <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('app_studio.builder.welcome.empty', 'What should the app do? Tell me in your own words.')}</h2>
                <p className="text-xs leading-5 mt-1 text-[var(--text-secondary)]">{t('app_studio.builder.welcome.empty_hint', 'I build it with you. Pick an example, or describe your own below.')}</p>
            </div>
            {planning && (
                <p role="status" data-testid="app-assistant-ask-first-on" className="flex items-start gap-2 text-xs leading-5 text-[var(--text-secondary)]">
                    <ListChecks size={14} className="shrink-0 mt-0.5 text-[var(--type-ai)]" />
                    {t('app_studio.builder.welcome.ask_first_on', 'I will ask a few questions first, then make a plan. Tell me roughly what the app should do.')}
                </p>
            )}
            {!planning && onWorkModeChange && (
                <button type="button" data-testid="app-assistant-ask-first" onClick={() => onWorkModeChange('describe')}
                    className="flex items-start gap-2.5 text-left p-3 rounded-lg border border-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_6%,var(--bg-card))] hover:bg-[color-mix(in_srgb,var(--type-ai)_12%,var(--bg-card))] transition">
                    <ListChecks size={15} className="shrink-0 mt-0.5 text-[var(--type-ai)]" />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                            {t('app_studio.builder.welcome.ask_first', 'Describe it')}
                            <span className="rounded px-1.5 py-px text-[10px] font-medium text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)]">{t('app_studio.builder.welcome.recommended', 'Recommended')}</span>
                        </span>
                        <span className="block mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{t('app_studio.builder.welcome.ask_first_hint', 'I ask a few questions first, then write a plan in plain words and build it after your OK.')}</span>
                    </span>
                </button>
            )}
            <div>
                <div className="text-[11px] font-medium text-[var(--text-tertiary)] mb-2">{t('app_studio.builder.welcome.examples', 'For example')}</div>
                <IdeaList ideas={appExampleBriefs(t)} onPick={onPick} kind="brief" testId="app-assistant-example-brief" />
            </div>
        </div>
    );
}

/** The pane's invitation: an empty app asks what it should do, an existing one what to change. */
export default function AppAssistantWelcome({ definition = null, selectedNodeId = null, tableCount = null, onPick, workMode, onWorkModeChange = null }: AppAssistantWelcomeProps) {
    const { t } = useTranslation();
    const selectedLabel = selectedLabelOf(definition, selectedNodeId);
    if (isEmptyApp(definition, tableCount) && !selectedLabel) {
        return <EmptyAppWelcome onPick={onPick} workMode={workMode} onWorkModeChange={onWorkModeChange} />;
    }
    return (
        <div className="flex flex-col gap-5 py-5 text-left">
            <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('app_studio.builder.welcome.existing', 'What would you like to change?')}</h2>
                <p data-testid="app-assistant-seen" className="text-xs leading-5 mt-1 text-[var(--text-secondary)]">
                    {seenSentence(definition, tableCount, t)}
                    {selectedLabel && <> {t('app_studio.builder.welcome.selected', 'You have \'{label}\' selected.', { label: selectedLabel })}</>}
                </p>
            </div>
            <IdeaList ideas={welcomeIdeas(definition, !!selectedLabel, tableCount, t)} onPick={onPick} kind="idea" testId="app-assistant-idea" />
        </div>
    );
}
