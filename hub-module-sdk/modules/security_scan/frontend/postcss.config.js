// Tailwind v4 via PostCSS — mirrors agent-hub's pipeline so utility classes in
// the ported components compile identically. Content is auto-detected from
// src/ (also declared explicitly via `@source` in src/index.css).
export default {
    plugins: {
        '@tailwindcss/postcss': {},
    },
};
