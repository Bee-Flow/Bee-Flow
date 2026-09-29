import React from 'react';

/**
 * De kaartvorm van de tab "Rol" (Agents-artboard 1c): een gekleurd glyph, een
 * titel, een grijze bijzin, en daaronder wat de kaart te zeggen heeft.
 *
 * ── WAAROM NIET `canUse/CanUseCard` ─────────────────────────────────
 * Die schil tekent een KINDTEGEL uit `shared/kindColors` — de legenda voor
 * dingen die je in Studio MAAKT (een kennisbank, een skill, een tabel). De
 * vijf kaarten hier zijn geen gekoppelde objecten maar vijf stukken van één
 * beschrijving; ze zouden alle vijf dezelfde blauwe agenttegel krijgen, wat de
 * legenda juist betekenisloos maakt. De schil is daarom apart, en bewust
 * dunner: geen "+ Koppelen", geen ⋯-menu, geen rijen met scheidingslijnen.
 *
 * De kaart tekent GEEN gedrag. Hij weet niet wat een toonchip is, en dat is
 * precies waarom de vijf kaarten niet uit elkaar kunnen groeien in vorm.
 */
export default function RoleCard({ icon, iconColor = 'var(--type-ai)', title, hint, action, children, testId, wide = false }) {
    return (
        <section
            data-testid={testId}
            className={`rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] px-4 py-3.5 flex flex-col gap-2 ${wide ? 'sm:col-span-2' : ''}`}
        >
            <div className="flex items-center gap-2 min-w-0">
                {icon && <span className="flex-shrink-0" style={{ color: iconColor }} aria-hidden="true">{icon}</span>}
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</span>
                {hint && <span className="text-[12px] text-[var(--text-tertiary)] truncate">{hint}</span>}
                {action && <span className="ml-auto flex-shrink-0">{action}</span>}
            </div>
            {children}
        </section>
    );
}

/**
 * De regel onder een kaart die zegt wat er met de inhoud GEBEURT.
 *
 * Drie tonen, en het verschil is niet cosmetisch:
 *   'muted'   een uitleg;
 *   'warn'    iets klopt niet of kon niet gelezen worden — `role="status"`,
 *             want het gaat over de toestand van het scherm;
 *   'promise' de belofte-regel: wat hier staat is een INSTRUCTIE en geen
 *             blokkade. Zie de docblock bij `BulletsCard`.
 */
/**
 * `announce={false}` voor een notitie die AL in een `aria-live`-blok hangt.
 * Twee live regions genest laat een schermlezer dezelfde zin twee keer
 * voorlezen; dezelfde regel als in AgentStudio/AgentOverview.jsx en het
 * precedent Studio/Datatables/DatatablesStudio.jsx, waar de wisselende inhoud
 * in één kale wrapper staat met rolloze kinderen.
 */
export function RoleNote({ tone = 'muted', children, testId, announce = true }) {
    const style = tone === 'warn'
        ? { color: 'var(--warning)' }
        : { color: 'var(--text-tertiary)' };
    return (
        <p
            data-testid={testId}
            role={tone === 'warn' && announce ? 'status' : undefined}
            className="text-[11px] leading-[15px] m-0"
            style={style}
        >
            {children}
        </p>
    );
}

/** Het lege vak: gelezen, en er staat echt niets. Nooit bij een mislukte lezing. */
export function RoleEmpty({ children, testId }) {
    return (
        <p data-testid={testId} className="text-[12px] leading-[17px] m-0 text-[var(--text-tertiary)] italic">
            {children}
        </p>
    );
}

/**
 * Een teller "412 / 600". Staat er pas als het ergens over gaat: onder 80% van
 * de grens is hij ruis, en ruis leert mensen om tellers weg te kijken.
 */
export function RoleCounter({ value = '', max, testId, label }) {
    const used = typeof value === 'string' ? value.length : 0;
    if (used < max * 0.8) return null;
    return (
        <span
            data-testid={testId}
            className="text-[11px] tabular-nums"
            style={{ color: used >= max ? 'var(--warning)' : 'var(--text-tertiary)' }}
            aria-label={label}
        >
            {used} / {max}
        </span>
    );
}

/**
 * Het tekstvak van een rolkaart.
 *
 * Zelfde vorm als `builderSplit/InstructionsEditor`, en om dezelfde reden: de
 * editor eromheen is groot, dus de aanslagen blijven lokaal en de ouder ziet
 * alleen wat er staat. Hij ontdubbelt niet en knipt niet — dat doet
 * `personaFacts` bij het schrijven — maar `maxLength` staat wél, want de
 * server knipt zonder iets te zeggen en dan is de laatste zin weg zonder dat
 * hij ooit rood werd.
 */
export function RoleTextArea({ value, onChange, placeholder, maxLength, rows = 3, disabled = false, testId, ariaLabel }) {
    const [local, setLocal] = React.useState(value || '');
    const lastRef = React.useRef(value);
    React.useEffect(() => {
        if (value !== lastRef.current) { lastRef.current = value; setLocal(value || ''); }
    }, [value]);
    const handle = (e) => {
        const next = e.target.value;
        setLocal(next);
        lastRef.current = next;
        onChange?.(next);
    };
    return (
        <textarea
            data-testid={testId}
            aria-label={ariaLabel}
            value={local}
            onChange={handle}
            rows={rows}
            disabled={disabled}
            maxLength={maxLength}
            placeholder={placeholder}
            className="w-full bg-[var(--bg-secondary)]/50 border border-transparent focus:border-[var(--border-default)] rounded-lg px-3 py-2 text-[12px] leading-[18px] text-[var(--text-secondary)] outline-none resize-y disabled:opacity-70 disabled:resize-none"
        />
    );
}
