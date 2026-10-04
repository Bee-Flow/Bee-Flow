import {
    Clock, Zap, Webhook, MousePointer2, Mail, Calendar,
    Tag, BellRing, FileUp, FilePlus, FilePen, Share2, Activity, Bell,
    Stethoscope, LogIn, Bot, AppWindow, ClipboardList,
} from 'lucide-react';
import React from 'react';
import IntegrationLogo from './IntegrationLogo';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import useTranslation from '../../../../../hooks/useTranslation';
import { appRefDisplay, triggerAppRef, useAppRefLabel } from '../appRefLabel';
import { humanizeFieldKey } from '../displayHelpers';
import { nodeTypeLabel } from '../nodeDefs';
import { describeCron } from '../scheduleBuilderUtils';
import { APP_EVENT_TYPE_LABEL, triggerTypeLabel } from '../triggerLabels';

/**
 * Trigger provider id → integration id used by INTEGRATION_META.
 * Map only providers whose event surface is a brand the user recognises;
 * `manual` / `schedule` / `webhook` triggers stay on lucide glyphs.
 */
const PROVIDER_TO_INTEGRATION = {
    'gmail':            'gmail',
    'google-calendar':  'google_calendar',
    'google-drive':     'google_drive',
    'msgraph':          'outlook',
    'github':           'github',
    'nextcloud':        'nextcloud',
};

// Icons only — the label strings live in ../triggerLabels so the palette,
// the settings form and the node all name a trigger the same way (BFSF-339).
const KIND_ICON = {
    schedule:    Clock,
    manual:      MousePointer2,
    webhook:     Webhook,
    app_event:   Zap,
    agent_call:  Bot,
    layer_input: LogIn,
    app_trigger: AppWindow,
    form:        ClipboardList,
};

/**
 * Sub-icon per (provider, event) so a Gmail-new-email trigger gets a Mail
 * glyph instead of the generic app-event lightning bolt.
 */
const APP_EVENT_ICON = {
    'gmail.mail.new':                  Mail,
    'gmail.label.added':               Tag,
    'google-calendar.event.changed':   Calendar,
    'google-calendar.event.upcoming':  BellRing,
    'google-drive.file.new':           FileUp,
    'nextcloud.file.new':              FilePlus,
    'nextcloud.file.changed':          FilePen,
    'nextcloud.share.received':        Share2,
    'nextcloud.activity.new':          Activity,
    'nextcloud.notification.new':      Bell,
};

export default function TriggerNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, onDiagnose } = data;
    const { t } = useTranslation();
    const kind = step.kind || 'manual';

    // The button this automation was made from, if it says so. Resolved through
    // the shared loader (flow/appRefLabel.js) rather than threaded down
    // through the layout: an app_trigger is primary-only, so there is at most
    // ONE such card per canvas, and it asks for the same reference the
    // breadcrumb strip already has cached.
    const appRef = triggerAppRef({ trigger: step });
    const appRefRecord = useAppRefLabel(kind === 'app_trigger' ? appRef : null);

    const kindLabel = triggerTypeLabel(step);
    let Icon = KIND_ICON[kind] || KIND_ICON.manual;
    if (kind === 'app_event' && step.appEvent) {
        const key = `${step.appEvent.provider}.${step.appEvent.event}`;
        if (APP_EVENT_ICON[key]) Icon = APP_EVENT_ICON[key];
    }
    const providerIntegration = (kind === 'app_event' && step.appEvent?.provider)
        ? PROVIDER_TO_INTEGRATION[step.appEvent.provider] || null
        : null;

    const cron = step.schedule?.cron;
    const tz = step.schedule?.tz;
    const filter = step.appEvent?.filter || null;

    // The one summary line under the name, per kind. Chips where the values
    // are discrete (a cadence and its timezone, a tool's parameters), plain
    // words otherwise.
    let sub = null;
    if (kind === 'schedule') {
        // "Every day at 09:00", not `0 9 * * *`. A schedule the author can't
        // read at a glance is a schedule they can't check.
        sub = cron ? (
            <span className="inline-flex items-center gap-1">
                <NodeChip title={cron}>{describeCron(cron)}</NodeChip>
                {tz && <NodeChip>{tz}</NodeChip>}
            </span>
        ) : { muted: 'no schedule yet' };
    } else if (kind === 'app_event') {
        const chips = filter && Object.keys(filter).length > 0 ? summariseFilter(filter, step.appEvent).slice(0, 2) : [];
        const eventId = step.appEvent ? `${step.appEvent.provider}.${step.appEvent.event}` : '';
        sub = step.appEvent ? (
            <span className="inline-flex items-center gap-1">
                {/* "New email (Gmail)", not `gmail.mail.new`. The trigger card is
                    the FIRST card anyone ever sees on a canvas, and it was
                    opening with a dotted id in monospace — which reads as
                    configuration the author is supposed to already understand,
                    on the one card that should be telling them in plain words
                    what starts this automation. Same move the schedule branch
                    above makes with its cron pattern.
                    The id is demoted, never deleted: it stays on the tooltip,
                    because it is the string you need when a subscription
                    misbehaves and the one you search the logs for. */}
                <span title={eventId}>{appEventText(step.appEvent)}</span>
                {chips.map(({ key, label }) => <NodeChip key={key} title={key}>{label}</NodeChip>)}
            </span>
        ) : { muted: 'no event chosen yet' };
    } else if (kind === 'agent_call') {
        const toolName = step.toolName || `automation_${step.id}`;
        const props = step.parametersSchema?.properties || {};
        const names = Object.keys(props);
        const required = Array.isArray(step.parametersSchema?.required) ? step.parametersSchema.required : [];
        sub = (
            <span className="inline-flex items-center gap-1">
                <NodeChip title="Tool name"><span className="font-mono">{truncate(toolName, 22)}</span></NodeChip>
                {names.slice(0, 3).map((n) => (
                    <NodeChip key={n} title={required.includes(n) ? `${n} (required)` : n}>
                        {n}{required.includes(n) ? '*' : ''}
                    </NodeChip>
                ))}
                {names.length > 3 && <NodeChip>+{names.length - 3}</NodeChip>}
            </span>
        );
    } else if (kind === 'layer_input' || kind === 'app_trigger') {
        // Room for four declared inputs on a layer_input; three on an
        // app_trigger, where the line also carries where the button is and the
        // viewer chip. The line truncates, so what gets cut has to be the
        // least load-bearing thing on it.
        const max = kind === 'app_trigger' ? 3 : 4;
        const params = Array.isArray(step.params) ? step.params : [];
        const paramChips = params.slice(0, max).map((p) => (
            <NodeChip key={p.name} title={`${p.name}${p.required ? ' (required)' : ''}${p.type === 'file' ? ' (file)' : ''}`}>
                {p.name}{p.required ? '*' : ''}
            </NodeChip>
        ));
        const overflow = params.length > max ? <NodeChip>+{params.length - max}</NodeChip> : null;
        if (kind === 'app_trigger') {
            // Every app_trigger run carries the viewer's ID whether or not any
            // input is declared (the bridge's `_viewerUserId`), so the chip is
            // unconditional — a card that showed "no inputs" would be wrong
            // about the one value that is ALWAYS sent. The title says what
            // travels: the id, not a name or an address.
            const viewerChip = (
                <NodeChip
                    key="__viewer"
                    title={t('automations.trigger.viewer_chip_title', 'Their ID only — no name or e-mail address')}
                >
                    {t('automations.trigger.viewer_chip', 'Signed-in user')}
                </NodeChip>
            );
            sub = (
                <span className="inline-flex items-center gap-1">
                    <AppRefPlace record={appRefRecord} appRef={appRef} t={t} />
                    {paramChips}
                    {overflow}
                    {viewerChip}
                </span>
            );
        } else {
            sub = params.length > 0
                ? <span className="inline-flex items-center gap-1">{paramChips}{overflow}</span>
                : { muted: 'no inputs' };
        }
    } else if (kind === 'form') {
        const n = Array.isArray(step.form?.fields) ? step.form.fields.length : 0;
        sub = n ? `${step.form?.title ? `${step.form.title} · ` : ''}${n} question${n === 1 ? '' : 's'}` : { muted: 'no questions yet' };
    } else if (kind === 'webhook') {
        sub = 'Runs when a system calls its URL';
    } else if (kind === 'manual') {
        sub = 'Runs on the Run button';
    }

    const badges = (kind === 'app_event' && typeof onDiagnose === 'function') ? (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDiagnose(); }}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Diagnose"
            title="Probe the trigger pipeline (subscription, credentials, filter match)"
            className="h-5 w-5 rounded-md flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        >
            <Stethoscope size={11} />
        </button>
    ) : null;

    const iconEl = providerIntegration
        ? <IntegrationLogo integrationId={providerIntegration} size={16} fallback={<Icon size={14} />} />
        : <Icon size={14} />;

    return (
        <StepNodeBase
            icon={iconEl}
            // The kicker reads "BUTTON IN AN APP · 1" for an app trigger. The
            // generic "TRIGGER" is true of every one of the eight kinds and so
            // tells the reader nothing; this card is the one place where what
            // starts the automation is a thing in another product surface.
            typeLabel={kind === 'app_trigger' ? t('automations.trigger.app_button', 'Button in an app') : nodeTypeLabel('trigger')}
            help={kindLabel}
            // An unnamed trigger is called by its kind: triggerTypeLabel already
            // reads "Manual trigger", so appending the word gave "Manual trigger
            // trigger".
            name={step.label || kindLabel}
            sub={sub}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}

/**
 * WHERE the button is — "<app> · <screen>", or what is left of it.
 *
 * Renders nothing at all when there is no back-pointer (a hand-written
 * app_trigger is not broken, it just has nothing to say) and nothing while the
 * answer is still in flight, so ids never flash and are then replaced by
 * names. Everything it does show came from the server: a name only when the
 * viewer was told one, the raw id otherwise, and the word "gone" only when the
 * server said which level is gone.
 *
 * A pointer that resolves to nothing is NOT "no trigger" — the automation still
 * fires from an app action — so this says so on the card instead of falling
 * silently back to a nameless trigger.
 */
function AppRefPlace({ record, appRef, t }) {
    if (!appRef || record === undefined) return null;
    const d = appRefDisplay(record, appRef);

    if (d.gone === 'app') {
        return <span className="italic text-[var(--text-tertiary)]" title={d.appId || undefined}>{t('automations.trigger.app_gone', 'App is gone')} · </span>;
    }
    if (d.restricted) {
        return <span className="italic text-[var(--text-tertiary)]" title={d.appId || undefined}>{t('automations.trigger.app_hidden', 'An app you cannot open')} · </span>;
    }
    if (d.unknown) {
        // The lookup failed. The ids are still true, so show them and claim
        // nothing about whether they resolve.
        return <span className="text-[var(--text-tertiary)]" title={`${d.appId || ''} · ${d.screenId || ''}`}>{d.appText} · </span>;
    }
    const screen = d.gone === 'screen'
        ? <span className="italic text-[var(--text-tertiary)]">{t('automations.trigger.screen_gone', 'screen is gone')}</span>
        : d.screenText;
    return (
        <span title={`${d.appId || ''} · ${d.screenId || ''}`}>
            {d.appText} · {screen}{' · '}
        </span>
    );
}

/**
 * What this app event is CALLED, for the one summary line under the name.
 *
 * The curated names live in ../triggerLabels next to every other trigger
 * string (BFSF-339) — the very table the node-config header already reads —
 * so an event can never end up with two different names in two places.
 *
 * An event that table has never heard of (a provider added after it was last
 * touched) falls back to a humanised form of its OWN id rather than an
 * invented name: "Mail new (Gmail)" is clumsy, but it is true, and a
 * made-up label on a trigger is worse than a clumsy one — nobody can check it.
 */
function appEventText(appEvent) {
    const provider = appEvent?.provider || '';
    const event = appEvent?.event || '';
    const curated = APP_EVENT_TYPE_LABEL[`${provider}.${event}`];
    if (curated) return curated;
    const eventWords = humanizeFieldKey(event);
    const providerWords = humanizeFieldKey(provider);
    if (eventWords && providerWords) return `${eventWords} (${providerWords})`;
    return eventWords || providerWords || `${provider}.${event}`;
}

/**
 * Render the trigger filter as readable chips. Per-provider branches
 * keep the language idiomatic — "labels: Label_3" reads naturally for a
 * Gmail user but would be confusing in a Drive trigger.
 */
function summariseFilter(filter, appEvent) {
    const provider = appEvent?.provider;
    const event = appEvent?.event;
    const key = `${provider}.${event}`;

    const out = [];
    const push = (k, label) => out.push({ key: k, label });

    // Gmail (mail.new + label.added share most fields)
    if (provider === 'gmail') {
        if (filter.labelId)          push('labelId',         `label: ${truncate(filter.labelId, 18)}`);
        if (filter.from)              push('from',            `from: ${truncate(filter.from, 22)}`);
        if (filter.to)                push('to',              `to: ${truncate(filter.to, 22)}`);
        if (filter.cc)                push('cc',              `cc: ${truncate(filter.cc, 22)}`);
        if (filter.subjectContains)   push('subjectContains', `subject ~ "${truncate(filter.subjectContains, 18)}"`);
        if (filter.subjectRegex)      push('subjectRegex',    `subject /${truncate(filter.subjectRegex, 16)}/`);
        if (Array.isArray(filter.labelIds) && filter.labelIds.length)
            push('labelIds', `labels: ${filter.labelIds.slice(0, 2).join(',')}${filter.labelIds.length > 2 ? '+' + (filter.labelIds.length - 2) : ''}`);
        if (Array.isArray(filter.excludeLabelIds) && filter.excludeLabelIds.length)
            push('excludeLabelIds', `not: ${filter.excludeLabelIds.slice(0, 2).join(',')}`);
        if (filter.hasAttachment === true)   push('hasAttachment',   'has attachment');
        if (filter.excludeFromSelf === true) push('excludeFromSelf', 'not sent by me');
        if (typeof filter.maxAgeMinutes === 'number') push('maxAgeMinutes', `≤ ${filter.maxAgeMinutes}m old`);
        return out;
    }

    if (provider === 'google-calendar') {
        if (typeof filter.leadMinutes === 'number') push('leadMinutes', `≤ ${filter.leadMinutes}m before`);
        if (filter.calendarId && filter.calendarId !== 'primary')
            push('calendarId', `cal: ${truncate(filter.calendarId, 14)}`);
        if (filter.statusEquals)             push('statusEquals',          `status: ${filter.statusEquals}`);
        if (filter.attendeeEmailContains)    push('attendeeEmailContains', `attendee ~ ${truncate(filter.attendeeEmailContains, 16)}`);
        if (filter.includeAllDay === true)   push('includeAllDay',         'incl. all-day');
        return out;
    }

    if (provider === 'google-drive') {
        if (filter.folderId)        push('folderId',        `folder: ${truncate(filter.folderId, 16)}`);
        if (filter.mimeType)        push('mimeType',        truncate(filter.mimeType.split('/').pop() || filter.mimeType, 14));
        if (filter.nameContains)    push('nameContains',    `name ~ "${truncate(filter.nameContains, 14)}"`);
        if (filter.excludeOwnUploads === true) push('excludeOwnUploads', 'not uploaded by me');
        return out;
    }

    if (provider === 'nextcloud') {
        if (key === 'nextcloud.file.new' || key === 'nextcloud.file.changed') {
            if (filter.inFolder)     push('inFolder',     `in ${truncate(filter.inFolder, 18)}`);
            if (filter.extension)    push('extension',    `.${String(filter.extension).replace(/^\./, '')}`);
            if (filter.nameContains) push('nameContains', `name ~ "${truncate(filter.nameContains, 14)}"`);
            if (filter.excludeOwnUploads === true) push('excludeOwnUploads', 'not by me');
            return out;
        }
        if (key === 'nextcloud.share.received') {
            if (filter.actorEquals)  push('actorEquals',  `from: ${truncate(filter.actorEquals, 16)}`);
            if (filter.kindEquals)   push('kindEquals',   filter.kindEquals);
            if (filter.nameContains) push('nameContains', `name ~ "${truncate(filter.nameContains, 14)}"`);
            return out;
        }
        if (key === 'nextcloud.activity.new') {
            if (filter.type)              push('type',              `type: ${truncate(filter.type, 16)}`);
            if (filter.objectNameContains) push('objectNameContains', `obj ~ ${truncate(filter.objectNameContains, 14)}`);
            if (filter.actorEquals)       push('actorEquals',       `actor: ${truncate(filter.actorEquals, 16)}`);
            return out;
        }
        if (key === 'nextcloud.notification.new') {
            if (filter.app)             push('app',             `app: ${truncate(filter.app, 16)}`);
            if (filter.subjectContains) push('subjectContains', `subject ~ "${truncate(filter.subjectContains, 14)}"`);
            return out;
        }
    }

    // Unknown provider — fall back to dumping each key.
    for (const k of Object.keys(filter)) {
        const v = filter[k];
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        out.push({ key: k, label: `${k}: ${truncate(String(v), 18)}` });
    }
    return out;
}

function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
