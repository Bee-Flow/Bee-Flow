/**
 * The member picker's options: port of memberOptions in
 * agent-hub/src/components/admin/compliance/pages/risks/riskDraft.ts. The
 * name labels a member; the e-mail is added only when two members share that
 * name (and labels a member without one), and a stored id that is no longer a
 * member keeps a '—' option so the field never silently reads "nobody".
 */

export interface MemberLike {
    readonly id: string;
    readonly displayName?: string | null;
    readonly email?: string | null;
}

export interface MemberOption {
    readonly value: string;
    readonly label: string;
}

const nameOf = (u: MemberLike) => String(u?.displayName || '').trim();

export function memberOptions(members: readonly MemberLike[] | null | undefined, current: string | readonly string[] = ''): MemberOption[] {
    const list = Array.isArray(members) ? members : [];
    const seen = new Map<string, number>();
    for (const u of list) {
        const key = nameOf(u).toLowerCase();
        if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const labelOf = (u: MemberLike) => {
        const name = nameOf(u);
        if (!name) return u.email || String(u.id);
        const shared = (seen.get(name.toLowerCase()) ?? 0) > 1;
        return shared && u.email ? `${name} (${u.email})` : name;
    };
    const options = list.map((u) => ({ value: String(u.id), label: labelOf(u) }));
    const ids = typeof current === 'string' ? [current] : current;
    for (const id of ids) {
        if (id && !list.some((u) => String(u.id) === String(id))) options.push({ value: String(id), label: '—' });
    }
    return options;
}
