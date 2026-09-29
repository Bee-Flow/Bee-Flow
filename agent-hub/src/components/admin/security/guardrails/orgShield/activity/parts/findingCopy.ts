/**
 * A finding (shieldFindings.ts) → its title and body, in the viewer's words.
 *
 * Kept apart from the card so the wording rules — which sentence appears
 * when, and that a missing figure drops its sentence rather than printing a
 * zero — can be tested without rendering.
 */

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { Finding } from '../shieldFindings';

export interface FindingCopy {
    title: string;
    body: string;
}

type Fmt = (n: number) => string;

const num = (v: number | string | undefined): number => Number(v) || 0;
const str = (v: number | string | undefined): string => (v === undefined ? '' : String(v));

/** A count sentence in its singular form for exactly one ("1 call went", not "1 calls went"). */
type Plural = { one: [string, string]; many: [string, string] };
function counted(t: TranslateFn, n: number, { one, many }: Plural, vars: Record<string, string | number>): string {
    const [key, en] = n === 1 ? one : many;
    return t(key, en, vars);
}

function toolPii(f: Finding, t: TranslateFn, fmt: Fmt): FindingCopy {
    const v = f.vars;
    const body: string[] = [];
    if (num(v.total) > 0) {
        body.push(t('shield_activity.f_tool_pii_held', 'Tools hold back {held} of {total} kinds.', { held: num(v.held), total: num(v.total) }));
    }
    if (num(v.outside) > 0) {
        body.push(t('shield_activity.f_tool_pii_outside', '{n} of these went to a server outside Europe.', { n: fmt(num(v.outside)) }));
    }
    if (str(v.hostA) && str(v.hostB)) {
        body.push(t('shield_activity.f_tool_pii_hosts_two', 'Most went to {a} and {b}.', { a: str(v.hostA), b: str(v.hostB) }));
    } else if (str(v.hostA)) {
        body.push(t('shield_activity.f_tool_pii_hosts_one', 'Most went to {a}.', { a: str(v.hostA) }));
    }
    return {
        title: counted(t, num(v.n), {
            one: ['shield_activity.f_tool_pii_title_one', '1 tool call carried personal data out unchanged'],
            many: ['shield_activity.f_tool_pii_title', '{n} tool calls carried personal data out unchanged'],
        }, { n: fmt(num(v.n)) }),
        body: body.join(' '),
    };
}

function viaNetwork(f: Finding, t: TranslateFn, fmt: Fmt): FindingCopy {
    const count = num(f.vars.n);
    const n = fmt(count);
    const network = str(f.vars.network);
    return {
        title: network
            ? counted(t, count, {
                one: ['shield_activity.f_via_title_one', '1 call went through {network}'],
                many: ['shield_activity.f_via_title', '{n} calls went through {network}'],
            }, { n, network })
            : counted(t, count, {
                one: ['shield_activity.f_via_title_unnamed_one', '1 call went through a global network'],
                many: ['shield_activity.f_via_title_unnamed', '{n} calls went through a global network'],
            }, { n }),
        body: t('shield_activity.f_via_body', 'Only the network\'s edge is visible, where your data entered it; where the service behind it runs is not. These calls count as neither inside nor outside Europe.'),
    };
}

function unknownPlace(f: Finding, t: TranslateFn, fmt: Fmt): FindingCopy {
    const v = f.vars;
    const body: string[] = [];
    if (str(v.hosts)) {
        body.push(num(v.more) > 0
            ? t('shield_activity.f_unknown_hosts_more', 'No known country for {hosts} and {more} more.', { hosts: str(v.hosts), more: num(v.more) })
            : t('shield_activity.f_unknown_hosts', 'No known country for {hosts}.', { hosts: str(v.hosts) }));
    }
    if (num(v.pii) > 0) {
        body.push(counted(t, num(v.pii), {
            one: ['shield_activity.f_unknown_pii_one', 'Calls to them carried personal data once.'],
            many: ['shield_activity.f_unknown_pii', 'Calls to them carried personal data {n} times.'],
        }, { n: fmt(num(v.pii)) }));
    }
    return {
        title: counted(t, num(v.n), {
            one: ['shield_activity.f_unknown_title_one', '1 call went to a server we couldn\'t place'],
            many: ['shield_activity.f_unknown_title', '{n} calls went to a server we couldn\'t place'],
        }, { n: fmt(num(v.n)) }),
        body: body.join(' '),
    };
}

export function findingCopy(f: Finding, t: TranslateFn, fmt: Fmt): FindingCopy {
    switch (f.id) {
        case 'tool_pii': return toolPii(f, t, fmt);
        case 'via_network': return viaNetwork(f, t, fmt);
        case 'unknown': return unknownPlace(f, t, fmt);
        case 'low_score': return {
            title: t('admin.shield_activity_alert_low_score', 'A lot of your data is leaving Europe'),
            body: t('admin.shield_activity_alert_low_score_msg', 'Only {score} of 100 calls stayed in Europe or on your own servers.', { score: num(f.vars.score) }),
        };
        case 'many_catches': return {
            title: t('admin.shield_activity_alert_many_catches', 'The shield is catching a lot of personal data'),
            body: t('admin.shield_activity_alert_many_catches_msg', '{n} messages contained personal data in this period.', { n: fmt(num(f.vars.n)) }),
        };
        default: return {
            title: t('shield_activity.f_protected_title', 'Nothing got past the shield unprotected'),
            body: t('shield_activity.f_protected_body', 'It replaced or stopped personal data {n} times and let none through.', { n: fmt(num(f.vars.n)) }),
        };
    }
}
