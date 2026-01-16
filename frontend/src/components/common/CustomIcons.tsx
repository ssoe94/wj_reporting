import React from 'react';

export const InjectionIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
    >
        {/* Injector Unit (Left) */}
        <path d="M1 10h5v4H1z" />
        <path d="M2 11l-1 0.5v1l1 0.5" />

        {/* Main Mold Body */}
        <rect x="6" y="4" width="17" height="16" rx="1" />

        {/* Tie Bars / Plates (Symmetrical) */}
        <line x1="11" y1="4" x2="11" y2="20" />
        <line x1="18" y1="4" x2="18" y2="20" />

        {/* Mold Cavity Arcs (Symmetrical) */}
        <path d="M11 9c2 0 3 1 3 3s-1 3-3 3" />
        <path d="M18 9c-2 0-3 1-3 3s1 3 3 3" />
    </svg>
);

export const MachiningIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
    >
        {/* Conveyor Belt Base */}
        <rect x="2" y="17" width="20" height="4" rx="2" />
        <path d="M5 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" />
        <path d="M10 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" />
        <path d="M15 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" />
        <path d="M20 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" />

        {/* Worker 1 (Centered in left half) */}
        <path d="M4 17v-3a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3" />
        <circle cx="7.5" cy="9" r="2" />
        <path d="M5.5 7.5c0-1 1-1.5 2-1.5s2 0.5 2 1.5" /> {/* Hard hat */}

        {/* Worker 2 (Centered in right half) */}
        <path d="M13 17v-3a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3" />
        <circle cx="16.5" cy="9" r="2" />
        <path d="M14.5 7.5c0-1 1-1.5 2-1.5s2 0.5 2 1.5" /> {/* Hard hat */}
    </svg>
);
