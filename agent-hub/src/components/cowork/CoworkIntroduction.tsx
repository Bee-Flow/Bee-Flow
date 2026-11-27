import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { introPlan } from './coworkIntroPlan';
import { coworkIntroStory, type IntroBeat } from './coworkIntroStory';
import type { OrbStep } from '@/api/coworkPlan.types';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useTranslation } from '@/hooks/useTranslation';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import CoworkIntroDesk from './CoworkIntroDesk';
import CoworkOrb from './CoworkOrb';
import CoworkStepRail from './task/CoworkStepRail';
import type { CoworkMode } from './coworkDisplayMode';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK_INLINE } from './coworkUi';

/** How long a scene takes to fade out before the next one arrives (the transition in coworkViewport.css). */
const LEAVE_MS = 260;

/** Long enough to read the line and what is shown under it, never long enough to wait for. */
function readingTime(beat: IntroBeat) {
    const shown = (beat.said ?? beat.sample ?? '').length + (beat.desk === 'invited' ? 80 : beat.desk ? 40 : 0);
    return Math.min(7000, 900 + beat.line.split(/\s+/).length * 210 + shown * 18);
}

function orbWork(beat: IntroBeat | undefined, flow: OrbStep[]) {
    return {apps: beat?.id === 'find' ? ['meeting-notes'] : undefined, flow: beat?.step ? flow : undefined,
        focus: flow.findIndex(step => step.id === beat?.step), action: beat?.action ?? 'rest' as const};
}

/** What is shown under the line. Two scenes with the same answer keep it in place while the line changes. */
function evidenceOf(beat?: IntroBeat) {
    if (!beat) return 'choice';
    if (beat.desk) return 'desk';
    return beat.said || beat.sample ? beat.id : 'none';
}

/** The tour's clock. Bee moves on by herself; Back and Next only choose where to, and the scene on screen leaves first. */
function useTour(story: IntroBeat[], atChoice: boolean) {
    const reduced = useReducedMotion();
    const [scene, setScene] = useState(atChoice ? story.length : 0);
    const [next, setNext] = useState<number | null>(null);
    const [visible, setVisible] = useState(!document.hidden);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const beat = story[scene];
    const pause = beat ? readingTime(beat) : 0;
    useEffect(() => {
        if (next !== null) {
            const timer = window.setTimeout(() => { setScene(next); setNext(null); }, reduced ? 0 : LEAVE_MS);
            return () => window.clearTimeout(timer);
        }
        if (!visible || !pause) return;
        const timer = window.setTimeout(() => setNext(scene + 1), pause);
        return () => window.clearTimeout(timer);
    }, [scene, next, visible, pause, reduced]);
    const go = (to: number) => setNext(Math.max(0, Math.min(to, story.length)));
    // Skip is an answer, not a scene change: the choice is there at once.
    const skip = () => { setNext(null); setScene(story.length); };
    return {scene, beat, leaving: next !== null, upcoming: next === null ? beat : story[next], go, skip};
}

/** `atChoice` opens on the choice itself: for someone who saw the tour and only wants another view. */
export default function CoworkIntroduction({ choose, atChoice = false }: {choose: (mode: CoworkMode) => void; atChoice?: boolean}) {
    const { t } = useTranslation();
    const story = coworkIntroStory(t);
    const {scene, beat, leaving, upcoming, go, skip} = useTour(story, atChoice);
    const stage = useRef<HTMLDivElement>(null);
    const asked = useRef(false);
    const finished = !beat;
    // Whoever pressed Next or Skip to get here goes on with the keyboard on the first choice.
    useEffect(() => {
        if (finished && asked.current) stage.current?.querySelector('button')?.focus();
        asked.current = false;
    }, [scene, finished]);
    const {flow, steps} = introPlan(t);
    // The rail keeps its last step while it fades out, so nothing jumps on its way out.
    const railStep = story.slice(0, scene + 1).reduce((last, item) => item.step ?? last, steps[0].id);
    return <main className="cowork-intro">
        <small>{t('cowork_home.intro.title', 'Introducing Cowork 2.0')}</small>
        <div className="cowork-intro-workspace">
          <div className="cowork-intro-orb"><CoworkOrb work={orbWork(beat, flow)} tone={beat?.tone ?? 'rest'} /></div>
          <div className="cowork-intro-rail" data-shown={!!beat?.step} aria-hidden={!beat?.step}><CoworkStepRail steps={steps} active={railStep} t={t}/></div>
        </div>
        <div ref={stage} className="cowork-intro-stage" aria-live="polite">
          <div key={scene} className="cowork-story-caption" data-leaving={leaving}>
            <h1 className="cowork-intro-line">{(beat?.line ?? t('cowork_home.tour.choose', 'How would you like to work with me?'))
                .split(/(?<=[.!?])\s+/).map((phrase, index) => <span key={index}>{phrase}{' '}</span>)}</h1>
          </div>
          <div key={evidenceOf(beat)} className="cowork-story-evidence" data-leaving={leaving && evidenceOf(upcoming) !== evidenceOf(beat)}>
            <IntroEvidence beat={beat} choose={choose} />
          </div>
        </div>
        <IntroFooter scene={scene} story={story} go={to => { asked.current = true; go(to); }} skip={() => { asked.current = true; skip(); }} />
    </main>;
}

function IntroEvidence({beat, choose}: {beat?: IntroBeat; choose: (mode: CoworkMode) => void}) {
    if (!beat) return <IntroChoices choose={choose} />;
    if (beat.desk) return <CoworkIntroDesk connected={beat.desk === 'connected'}/>;
    if (beat.said) return <p className="cowork-intro-sample cowork-story-said">{beat.said}</p>;
    return beat.sample ? <div className="cowork-intro-sample cowork-story-paper"><MarkdownRenderer content={beat.sample} /></div> : null;
}

/** Where you are in the tour, a step back or ahead, and the way out. After the tour: the way back in. */
function IntroFooter({scene, story, go, skip}: {scene: number; story: IntroBeat[]; go: (to: number) => void; skip: () => void}) {
    const {t} = useTranslation();
    const back = t('cowork_home.tour.back', 'Back');
    const onward = t('cowork_home.tour.next', 'Next');
    if (scene >= story.length) return <div className="cowork-intro-footer">
        <span>{t('cowork_home.tour.change_later', 'You can change this later.')}</span>
        <button type="button" className={LINK_INLINE} onClick={() => go(0)}>{t('cowork_home.tour.replay', 'Watch the intro again')}</button>
    </div>;
    return <div className="cowork-intro-footer" data-tour>
        <button type="button" className={LINK_INLINE} aria-label={back} title={back} disabled={scene === 0} onClick={() => go(scene - 1)}><ChevronLeft aria-hidden size={16}/></button>
        <ol className="cowork-intro-dots" aria-hidden="true">{story.map((item, index) =>
            <li key={item.id} data-state={index === scene ? 'now' : index < scene ? 'done' : 'ahead'}/>)}</ol>
        <button type="button" className={LINK_INLINE} aria-label={onward} title={onward} onClick={() => go(scene + 1)}><ChevronRight aria-hidden size={16}/></button>
        <button type="button" className={LINK_INLINE} onClick={skip}>{t('cowork_home.intro.skip_tour', 'Skip intro')}</button>
    </div>;
}

/** The three ways to work with Cowork, each with one line that says what you get. */
function IntroChoices({choose}: {choose: (mode: CoworkMode) => void}) {
    const {t} = useTranslation();
    const id = useId();
    const options: {mode: CoworkMode; name: string; hint: string}[] = [
        {mode: 'orb', name: t('cowork_home.intro.orb', 'Chat with the orb'), hint: t('cowork_home.tour.orb_hint', 'I show what I’m doing while we talk.')},
        {mode: 'chat', name: t('cowork_home.intro.chat', 'Chat only'), hint: t('cowork_home.tour.chat_hint', 'Just the conversation, without the orb.')},
        {mode: 'advanced', name: t('cowork_overview.advanced', 'Advanced'), hint: t('cowork_home.tour.advanced_hint', 'Your tasks and their settings in one overview.')},
    ];
    return <div className="cowork-intro-choices">{options.map(({mode, name, hint}, index) =>
        <button key={mode} type="button" className={index ? BUTTON_SECONDARY : BUTTON_PRIMARY} onClick={() => choose(mode)}
            aria-labelledby={`${id}-${mode}`} aria-describedby={`${id}-${mode}-hint`}>
            <strong id={`${id}-${mode}`}>{name}</strong><small id={`${id}-${mode}-hint`}>{hint}</small>
        </button>)}</div>;
}
