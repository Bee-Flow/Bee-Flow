/**
 * Who the user is, from their account: name, e-mail, organisation, role.
 *
 * Without this block the model only learned the user's name by luck, from a
 * memory worded "My name is tom" and only when the PII detector caught the
 * name in that sentence. It now always gets the account data, in fixed
 * English labels, whatever language the chat is in.
 *
 * The values are handed back as `knownEntities`: the memory tokeniser
 * (scrubMemoryContext) replaces them without asking the detector, so a name
 * the detector misses is still tokenised, and because the block comes first,
 * a later "tom" in a memory folds onto the token of "Tom Kooy".
 */
'use strict';

const { fallback } = require('../../utils/bestEffort');
const TAG_OPEN = '<about_the_user>';
const TAG_CLOSE = '</about_the_user>';

function clean(v) {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {object|null} user  a users row (displayName, firstName, lastName, email, orgRole)
 * @param {object|null} org   an organizations row (name)
 * @returns {{ text: string, knownEntities: Array<{ text: string, category: string, role: string }> }}
 */
function buildUserIdentity(user, org = null) {
    if (!user) return { text: '', knownEntities: [] };
    const name = clean(user.displayName) || clean([user.firstName, user.lastName].filter(Boolean).join(' '));
    const email = clean(user.email);
    const orgName = clean(org?.name);
    const role = clean(user.orgRole);

    const lines = [];
    const knownEntities = [];
    if (name) {
        lines.push(`Name: ${name}`);
        knownEntities.push({ text: name, category: 'Person', role: 'name' });
    }
    if (email) {
        lines.push(`E-mail: ${email}`);
        knownEntities.push({ text: email, category: 'Email', role: 'e-mail address' });
    }
    if (orgName) {
        lines.push(`Organisation: ${orgName}`);
        knownEntities.push({ text: orgName, category: 'Organization', role: 'organisation' });
    }
    if (role) lines.push(`Role in this workspace: ${role}`);
    if (!lines.length) return { text: '', knownEntities: [] };

    const text = `${TAG_OPEN}\nThe person you are talking to, from their account:\n${lines.join('\n')}\n${TAG_CLOSE}\n`;
    return { text, knownEntities };
}

/**
 * Load the user and their organisation and build the block. Never throws.
 * The caller hands in its userStore: requiring it here closes an import cycle.
 */
async function loadUserIdentity(userId, { userStore }) {
    try {
        const user = await userStore.getUser(userId);
        if (!user) return { text: '', knownEntities: [] };
        const org = user.organizationId ? await userStore.getOrganization(user.organizationId).catch((e) => fallback('core/memory/userIdentityContext:loadUserIdentity', e, null)) : null;
        return buildUserIdentity(user, org);
    } catch (_) {
        return { text: '', knownEntities: [] };
    }
}

module.exports = { buildUserIdentity, loadUserIdentity };
