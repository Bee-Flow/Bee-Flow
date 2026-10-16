import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { TOKEN_BUSY, fetchFormToken, sendForm } from './formBlockApi';
import type { FormToken, SendOutcome } from './formBlockApi';
import { buildPayload, checkAnswers, emptyAnswers, pageLocale } from './formBlockModel';
import { LOCALE_PREFIXES } from '../../utils/cmsPublicRouting';
import { newFormNonce } from './formNonce';
import type { FormAnswers, FormErrors, FormField } from './formBlockModel';

export type FormPhase = 'idle' | 'sending' | 'done' | 'unavailable';

const MESSAGES = { required: 'This field is required.', email: 'Enter a valid email address.' };


interface Options {
    blockId: string | null;
    active: boolean;
    preview: boolean;
    fields: FormField[];
    consentText: string;
    errorText: string;
}

const BUSY_RETRY_MS = 3000;
const BUSY_RETRIES = 2;
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * The state of one website form: answers, the signed token, and what a
 * submission did. The token is fetched when the form appears, so the server's
 * minimum-age check measures how long the visitor really had it open.
 */
export function useFormSubmission({ blockId, active, preview, fields, consentText, errorText }: Options) {
    const [answers, setAnswers] = useState<FormAnswers>(() => emptyAnswers(fields));
    const [consent, setConsent] = useState(false);
    const [honeypot, setHoneypot] = useState('');
    const [errors, setErrors] = useState<FormErrors>({});
    const [formError, setFormError] = useState('');
    const [phase, setPhase] = useState<FormPhase>('idle');
    const token = useRef<FormToken | null>(null);
    const nonce = useRef(newFormNonce());

    const loadToken = useCallback(async (): Promise<boolean> => {
        token.current = null;
        if (!blockId) return false;
        // A busy answer is the server limiting page views, not the form being gone.
        for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
            const result = await fetchFormToken(blockId);
            if (result !== TOKEN_BUSY) {
                token.current = result;
                return result !== null;
            }
            await pause(BUSY_RETRY_MS);
        }
        return false;
    }, [blockId]);

    useEffect(() => {
        if (preview || !blockId || !active) return undefined;
        let alive = true;
        loadToken().then(ok => { if (alive && !ok) setPhase('unavailable'); });
        return () => { alive = false; };
    }, [preview, blockId, active, loadToken]);

    const react = useCallback(async (outcome: SendOutcome) => {
        if (outcome.kind === 'done') { setPhase('done'); return; }
        // Only a submission that went through uses its nonce up: whatever else
        // happened, the next attempt is a new one.
        nonce.current = newFormNonce();
        setPhase(outcome.kind === 'gone' ? 'unavailable' : 'idle');
        if (outcome.kind === 'invalid') setErrors(outcome.errors);
        if (outcome.kind === 'expired') {
            // The token aged out: take a fresh one, and let the visitor send again.
            await loadToken();
        }
        if (outcome.kind !== 'gone') setFormError(errorText);
    }, [errorText, loadToken]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (preview || phase === 'sending' || !blockId) return;
        const found = checkAnswers(fields, answers, MESSAGES);
        if (consentText && !consent) found.consent = MESSAGES.required;
        setErrors(found);
        setFormError('');
        if (Object.keys(found).length) return;
        if (!token.current && !(await loadToken())) { setPhase('unavailable'); return; }
        const tok = token.current;
        if (!tok) return;
        setPhase('sending');
        // The server drops (silently) a submission younger than the minimum
        // form age: wait it out rather than show a thank-you for nothing.
        await pause(tok.readyAt - Date.now());
        const payload = buildPayload(fields, answers, tok, {
            nonce: nonce.current,
            honeypot,
            consent: consentText ? consent : undefined,
            locale: pageLocale(window.location.pathname, document.documentElement.lang || '', LOCALE_PREFIXES),
        });
        await react(await sendForm(blockId, payload));
    };

    return {
        answers,
        setAnswer: (id: string, value: string | boolean) => setAnswers(prev => ({ ...prev, [id]: value })),
        consent, setConsent, honeypot, setHoneypot, errors, formError, phase, submit,
    };
}
