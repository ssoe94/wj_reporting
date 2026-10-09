import type { CSSProperties } from "react";

/**
 * Side view of an injection moulding machine (clamp, guarded mould area, control
 * panel, injection unit, hopper). Colours come from CSS variables so the board can
 * tint the safety guard by running state: --glyph-guard, --glyph-screen,
 * --glyph-lamp-run, --glyph-lamp-stop, --glyph-body, --glyph-base, --glyph-line.
 */
export function MachineGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg aria-hidden="true" className={className} style={style} viewBox="0 0 178 82">
      <g stroke="var(--glyph-line, #23282d)" strokeLinejoin="round" strokeWidth="2">
        {/* machine bed, cabinet doors and feet */}
        <rect fill="var(--glyph-base, #4b525a)" height="21" rx="1.5" width="157" x="11" y="49" />
        <path d="M86 57 H162 V70 H86 Z M118 57 V70 M139 57 V70" fill="none" strokeWidth="1.4" />
        <rect fill="var(--glyph-base, #4b525a)" height="5" rx="1" width="10" x="13" y="72" />
        <rect fill="var(--glyph-base, #4b525a)" height="5" rx="1" width="10" x="156" y="72" />

        {/* clamp cylinder housing */}
        <rect fill="var(--glyph-body, #e3e6e8)" height="33" rx="1.5" width="22" x="6" y="18" />

        {/* safety guard with the mould area behind its window */}
        <rect fill="var(--glyph-guard, #f5c518)" height="36" rx="1.5" width="48" x="28" y="16" />
        <rect fill="#fff" height="25" rx="2" width="34" x="35" y="21" />
        <rect fill="#5f666d" height="21" rx="1.5" width="5" x="37" y="23" />
        <rect fill="#9aa1a7" height="17" rx="1" width="7" x="43" y="25" />
        <rect fill="#9aa1a7" height="17" rx="1" width="6" x="61" y="25" />
        <path d="M50 28 H61 M50 39 H61" fill="none" strokeWidth="1.6" />
        <rect fill="#6c737a" height="7" width="3" x="50" y="30" />
        <rect fill="#6c737a" height="7" width="3" x="58" y="30" />
        <rect fill="#5f666d" height="14" rx="1" width="2.4" x="71.5" y="27" />

        {/* control panel */}
        <rect fill="#f1f2f3" height="33" rx="1.5" width="15" x="77" y="18" />
        <rect fill="#454c53" height="29" rx="1" width="11" x="79" y="20" />
        <rect fill="var(--glyph-screen, #8fb4e3)" height="6" rx="0.6" width="8" x="80.5" y="21.5" strokeWidth="1" />
        <path d="M81 31 h1.6 M84 31 h1.6 M87 31 h1.6 M81 34 h1.6 M84 34 h1.6 M87 34 h1.6 M81 37 h1.6 M84 37 h1.6 M87 37 h1.6" stroke="#c9ced3" strokeWidth="1.6" />
        <circle cx="81.6" cy="42.5" fill="var(--glyph-lamp-run, #2fae60)" r="1.5" strokeWidth="0.8" />
        <circle cx="84.6" cy="42.5" fill="#9aa1a7" r="1.5" strokeWidth="0.8" />
        <circle cx="87.6" cy="42.5" fill="var(--glyph-lamp-stop, #e0453a)" r="1.5" strokeWidth="0.8" />

        {/* injection unit: nozzle, barrel with heater bands and screw, drive and motor */}
        <path d="M92 37 H95 L100 32 H103 V45 H100 L95 41 H92 Z" fill="#7d848b" />
        <rect fill="#5f666d" height="3" rx="0.8" width="6" x="104" y="29" strokeWidth="1.2" />
        <rect fill="#5f666d" height="3" rx="0.8" width="6" x="112" y="29" strokeWidth="1.2" />
        <rect fill="#5f666d" height="3" rx="0.8" width="6" x="120" y="29" strokeWidth="1.2" />
        <rect fill="#8a9196" height="13" rx="1.5" width="31" x="102" y="32" />
        <path d="M106 42 L109 35 M112 42 L115 35 M118 42 L121 35 M124 42 L127 35" fill="none" stroke="#e7eaec" strokeWidth="1.6" />
        <rect fill="var(--glyph-base, #4b525a)" height="5" width="11" x="128" y="44" />
        <rect fill="#5f666d" height="17" rx="1.5" width="6" x="133" y="30" />
        <rect fill="var(--glyph-body, #e3e6e8)" height="19" rx="1.5" width="27" x="138" y="28" />
        <rect fill="#5f666d" height="13" rx="2" width="5" x="165" y="31" />

        {/* hopper */}
        <rect fill="var(--glyph-body, #e3e6e8)" height="6" rx="1" width="24" x="118" y="8" />
        <path d="M118.5 14 H141.5 L133 25 H127 Z" fill="#c4c9cd" />
        <rect fill="#d9dde0" height="4" width="6" x="127" y="25" strokeWidth="1.4" />
      </g>
    </svg>
  );
}
