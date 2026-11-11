import React from 'react';
import type { LogoProps } from './integrationLogos.types';

// Neutral database cylinder (no brand mark) for the Firebird database integration.
export const FirebirdLogo = ({ size = 18, className }: LogoProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className ? `block ${className}` : 'block'}>
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#475569" />
        <ellipse cx="12" cy="7.5" rx="5.5" ry="2.2" fill="#fff" fillOpacity="0.95" />
        <path d="M6.5 7.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9c0 1.2-2.5 2.2-5.5 2.2s-5.5-1-5.5-2.2z" fill="#fff" fillOpacity="0.8" />
        <path d="M6.5 12c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke="#475569" strokeWidth="1" fill="none" />
    </svg>
);

// Neutral contact-card tile (no brand mark) for the Frappe CRM integration.
export const FrappeCrmLogo = ({ size = 18, className }: LogoProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className ? `block ${className}` : 'block'}>
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#0F766E" />
        <circle cx="9" cy="10" r="2.4" fill="#fff" />
        <path d="M5.2 17c.4-2.3 1.9-3.6 3.8-3.6s3.4 1.3 3.8 3.6z" fill="#fff" fillOpacity="0.9" />
        <rect x="14" y="8.4" width="5" height="1.6" rx="0.8" fill="#fff" fillOpacity="0.9" />
        <rect x="14" y="11.6" width="4" height="1.6" rx="0.8" fill="#fff" fillOpacity="0.7" />
        <rect x="14" y="14.8" width="3" height="1.6" rx="0.8" fill="#fff" fillOpacity="0.5" />
    </svg>
);
