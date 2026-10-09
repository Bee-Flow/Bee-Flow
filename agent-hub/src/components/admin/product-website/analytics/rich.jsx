import React from 'react';

/**
 * Put React nodes into a translated sentence: `{name}` placeholders left in
 * `text` (call t() WITHOUT params for them) are replaced by `nodes[name]`, so a
 * bold number or a <code> chip stays inside ONE translatable string.
 */
export function rich(text, nodes) {
    return String(text).split(/(\{\w+\})/g).map((part, i) => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m && m[1] in nodes) return <React.Fragment key={i}>{nodes[m[1]]}</React.Fragment>;
        return part;
    });
}
