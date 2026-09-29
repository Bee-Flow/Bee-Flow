/**
 * maskEmail — an e-mail address as a LIST may show it (Compliance Center
 * redesign, Sep 2026; artboard 1c DSR register: "j.•••@gmail.com").
 *
 * BFSF-441: personal data leaves Bee Flow only by e-mail to the data subject,
 * and inside the product a full address belongs in the audited detail view,
 * not in a table twenty people scroll past. The server already returns
 * `subject_email_masked` for `GET /dsr/requests`; this is the SAME rule for
 * the client's own cases — a captured address before the server has echoed
 * it back, a demo fixture, a toast — so the two never disagree about what a
 * masked address looks like.
 *
 *   'john.doe@gmail.com' → 'j.•••@gmail.com'   first character, then •••
 *   'a@x.io'             → '•••@x.io'          a one-character local part would
 *                                              be the whole secret
 *   'not an email'       → '•••'               nothing recognisable survives
 *   null / ''            → '•••'
 *
 * The domain stays: it says which kind of address it is (a company, a
 * webmail) without identifying the person, and the register needs it to tell
 * two requests apart.
 */
export const MASK = '•••';

export function maskEmail(value) {
    if (typeof value !== 'string') return MASK;
    const s = value.trim();
    const at = s.indexOf('@');
    // Exactly one '@' with something on both sides, and no whitespace: the
    // minimum for "this is an address". Anything else is unrecognisable and
    // masked whole.
    if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1 || /\s/.test(s)) return MASK;
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const chars = [...local]; // code points, so a non-BMP first character is not cut in half
    if (chars.length < 2) return `${MASK}@${domain}`;
    return `${chars[0]}.${MASK}@${domain}`;
}

export default maskEmail;
