import { useEffect, useState } from 'react';
import { introPlan } from './coworkIntroPlan';
import { coworkIntroStory } from './coworkIntroStory';
import type { OrbStep } from '@/api/coworkPlan.types';
import { useTranslation } from '@/hooks/useTranslation';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import CoworkIntroDesk from './CoworkIntroDesk';
import CoworkOrb from './CoworkOrb';
import CoworkStepRail from './task/CoworkStepRail';
import type { CoworkMode } from './coworkDisplayMode';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK_INLINE } from './coworkUi';


type Beat = ReturnType<typeof coworkIntroStory>[number];
const focusedStep: Record<string, string> = {
    integrations: 'pick', fetch_note: 'fetch', store_note: 'store', plan: 'period', glyphs: 'read', signal: 'clean', try: 'check', fix: 'check',
    digest: 'write', edit: 'write', approve: 'result', status_done: 'result',
};

function orbWork(beat: Beat | undefined, flow: OrbStep[]) {
    const active = beat && focusedStep[beat.id];
    const focus = flow.findIndex(step => step.id === active);
    return {apps: beat?.id === 'integrations' ? ['meeting-notes'] : undefined,
        flow: active ? flow : undefined, focus, action: beat?.action ?? 'rest' as const};
}

function orbTone(beat?: Beat) {
    switch (beat?.id) {
        case 'orb': case 'signal': case 'digest': return 'thinking';
        case 'fix': case 'repair_tone': return 'repair';
        case 'try': case 'glyphs': case 'handoff': return 'executing';
        default: return 'rest';
    }
}

export default function CoworkIntroduction({ choose }: {choose: (mode: CoworkMode) => void}) {
    const { t, locale } = useTranslation();
    const [scene, setScene] = useState(0);
    const [leaving, setLeaving] = useState(false);
    const [listen, setListen] = useState(false);
    const [visible, setVisible] = useState(!document.hidden);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const story = coworkIntroStory(t);
    const beat = story[scene];
    const finished = !beat;
    const message = beat?.line ?? t('cowork_home.intro.choose', 'How would you like to use Cowork?');
    const readingTime = 1500 + message.split(/\s+/).length * 258 + (beat?.sample.length ?? 0) * 29;
    useEffect(() => {
        if (!visible || finished) return;
        let disposed = false;
        const next = () => {
            if (disposed) return;
            setLeaving(true);
            timer = window.setTimeout(() => { setLeaving(false); setScene(scene + 1); }, 550);
        };
        const speak = listen && window.speechSynthesis;
        let timer = window.setTimeout(next, speak ? Math.max(16000, readingTime * 3) : readingTime);
        if (speak) {
            const speech = new SpeechSynthesisUtterance(message);
            speech.lang = locale;
            speech.onend = () => {
                if (disposed) return;
                window.clearTimeout(timer);
                timer = window.setTimeout(next, 1400 + (beat?.sample.length ?? 0) * 29);
            };
            speak.speak(speech);
        }
        return () => { disposed = true; window.clearTimeout(timer); if (speak) speak.cancel(); };
    }, [scene, visible, finished, listen, message, locale, readingTime, beat?.sample]);
    const {flow, steps} = introPlan(t, ['integrations', 'fetch_note', 'store_note'].includes(beat?.id ?? ''));
    const active = beat && focusedStep[beat.id];
    const work = orbWork(beat, flow);
    return <main className="cowork-intro cowork-intro-guided">
        <small>{t('cowork_home.intro.example', 'Cowork 2.0 · Interactive example')}</small>
        <div className={'cowork-orb-workspace cowork-intro-workspace' + (active ? ' has-steps' : '')}>
          <div className="cowork-intro-orb" data-event={beat?.id}><CoworkOrb work={work} tone={orbTone(beat)} /></div>
          {active && <div className="cowork-workspace-steps"><CoworkStepRail steps={steps} active={active} t={t}/></div>}
        </div>
        <StoryStage {...{beat, scene, message, leaving, choose}} />
        {!finished && 'speechSynthesis' in window && <button className={LINK_INLINE} aria-pressed={listen} onClick={() => setListen(!listen)}>{t('cowork_home.intro.listen', 'Read aloud')}</button>}
    </main>;
}

function StoryStage({beat, scene, message, leaving, choose}: {
    beat?: Beat; scene: number; message: string; leaving: boolean; choose: (mode: CoworkMode) => void;
}) {
    const {t} = useTranslation();
    const sceneId = beat?.id;
    const desk = sceneId === 'teamwork' || sceneId === 'desk' || sceneId === 'invite' || sceneId === 'handoff' || sceneId === 'cover';
    return <div className="cowork-intro-stage" data-leaving={leaving} aria-live="polite">
          <div key={scene} className="cowork-story-caption">
            <h1 className="cowork-intro-line">{message.split(/(?<=[.!?])\s+/).map((phrase, index) =>
                <span key={index} style={{animationDelay: index * 850 + 'ms'}}>{phrase}{' '}</span>)}</h1>
          </div>
          <div className="cowork-story-evidence">
            {desk && <CoworkIntroDesk scene={sceneId === 'teamwork' ? 'desk' : sceneId}/>}
            {beat?.sample && <div key={beat.id} className="cowork-intro-sample cowork-story-paper"><MarkdownRenderer content={beat.sample} /></div>}
            {!beat && <div className="cowork-intro-controls">
            <button className={BUTTON_PRIMARY} onClick={() => choose('orb')}>{t('cowork_home.intro.orb', 'Chat with the orb')}</button>
            <button className={BUTTON_SECONDARY} onClick={() => choose('chat')}>{t('cowork_home.intro.chat', 'Chat only')}</button>
            <button className={BUTTON_SECONDARY} onClick={() => choose('advanced')}>{t('cowork_overview.advanced', 'Advanced')}</button>
            </div>}
          </div>
        </div>;
}
