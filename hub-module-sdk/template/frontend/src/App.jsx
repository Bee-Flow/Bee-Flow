/**
 * Example module Studio component.
 *
 * Built by vite in library mode (see ../vite.config.js) into
 * `frontend/index.js` (ESM). react / react-dom / jsx-runtime are EXTERNALISED —
 * the host provides the single React instance via its import map, so this
 * bundle must never ship its own React. Bundle your own icons; theme via the
 * host's CSS variables (do not import a design-system runtime).
 *
 * The host mounts the default export inside a per-module error boundary +
 * Suspense. A thrown error shows an error card; it must never crash the SPA.
 */

import { useEffect, useState } from 'react';
import './index.css';

const API_BASE = '/api/mod/example_module';

export default function App() {
    const [pings, setPings] = useState([]);
    const [note, setNote] = useState('');
    const [error, setError] = useState(null);

    async function load() {
        try {
            const res = await fetch(`${API_BASE}/pings`, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            setPings(body.pings || []);
            setError(null);
        } catch (e) {
            setError(e.message);
        }
    }

    useEffect(() => { load(); }, []);

    async function submit(e) {
        e.preventDefault();
        await fetch(`${API_BASE}/pings`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note }),
        });
        setNote('');
        load();
    }

    return (
        <div className="bf-example">
            <h2>Example module</h2>
            {error && <p className="bf-example__error">Could not load pings: {error}</p>}
            <form className="bf-example__form" onSubmit={submit}>
                <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Leave a note…"
                    maxLength={500}
                />
                <button type="submit">Add ping</button>
            </form>
            <ul className="bf-example__list">
                {pings.map((p) => (
                    <li key={p.id}>
                        <span>{p.note || '(heartbeat)'}</span>
                        <time>{new Date(Number(p.created_at)).toLocaleString()}</time>
                    </li>
                ))}
            </ul>
        </div>
    );
}
