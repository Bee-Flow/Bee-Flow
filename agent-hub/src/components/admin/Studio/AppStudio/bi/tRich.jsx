import React from 'react';

/**
 * A translated sentence with React elements inside it (`<code>`, `<strong>`).
 * `t` only interpolates strings, so the element slots are passed to it as
 * their own `{name}` placeholder, which survives interpolation; the result is
 * then split on those placeholders and the elements are put in. The whole
 * sentence stays ONE key, so a translation can move the element around.
 *
 * `params` are ordinary string/number placeholders, `nodes` the elements.
 */
export function tRich(t, key, english, params, nodes) {
    const slots = {};
    for (const name of Object.keys(nodes || {})) slots[name] = `{${name}}`;
    const text = t(key, english, { ...(params || {}), ...slots });
    return String(text).split(/(\{\w+\})/).map((part, i) => {
        const m = /^\{(\w+)\}$/.exec(part);
        const hasNode = m && nodes && Object.hasOwn(nodes, m[1]);
        return <React.Fragment key={i}>{hasNode ? nodes[m[1]] : part}</React.Fragment>;
    });
}
