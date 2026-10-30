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
