import { memo } from "react";

/**
 * An unapologetically British London Skyline & Souvenir landmark backdrop.
 * Features Big Ben, Westminster Palace, Tower Bridge, London Eye,
 * iconic Routemaster double-decker bus, black cab, and classic red telephone boxes.
 */
export const LondonSkyline = memo(function LondonSkyline() {
  return (
    <div className="london-backdrop" aria-hidden="true">
      <div className="london-skyline-wrap">
        <svg
          className="london-skyline"
          viewBox="0 0 1600 320"
          preserveAspectRatio="xMidYMax meet"
          fill="currentColor"
        >
          {/* Distant City Skyline Silhouettes */}
          <path
            opacity="0.25"
            d="M0,320 L0,220 L40,220 L40,190 L70,190 L70,220 L120,220 L120,160 L140,160 L140,140 L160,140 L160,220 L240,220 L240,180 L280,180 L280,220 L350,220 L350,150 L380,120 L410,150 L410,220 L500,220 L500,170 L540,170 L540,220 L620,220 L620,130 L650,90 L680,130 L680,220 L780,220 L780,160 L820,160 L820,220 L920,220 L920,140 L960,140 L960,220 L1050,220 L1050,180 L1100,180 L1100,220 L1200,220 L1200,120 L1240,120 L1240,220 L1340,220 L1340,170 L1380,170 L1380,220 L1480,220 L1480,190 L1520,190 L1520,220 L1600,220 L1600,320 Z"
          />

          {/* Big Ben & Westminster Palace */}
          <g opacity="0.45">
            {/* Westminster Palace Body */}
            <rect x="220" y="160" width="220" height="160" />
            <polygon points="220,160 230,130 240,160" />
            <polygon points="260,160 270,130 280,160" />
            <polygon points="300,160 310,130 320,160" />
            <polygon points="340,160 350,130 360,160" />
            <polygon points="380,160 390,130 400,160" />
            <polygon points="420,160 430,130 440,160" />

            {/* Elizabeth Tower (Big Ben) */}
            <rect x="440" y="70" width="55" height="250" />
            {/* Clock Stage */}
            <rect x="435" y="60" width="65" height="40" />
            <circle cx="467.5" cy="80" r="14" fill="#fbbf24" opacity="0.9" />
            <circle cx="467.5" cy="80" r="11" fill="#111622" />
            {/* Tower Spire */}
            <polygon points="435,60 467.5,10 500,60" fill="currentColor" />
            <line x1="467.5" y1="10" x2="467.5" y2="0" stroke="currentColor" strokeWidth="3" />
          </g>

          {/* London Eye */}
          <g opacity="0.4">
            <circle cx="720" cy="140" r="85" fill="none" stroke="currentColor" strokeWidth="4" />
            <circle cx="720" cy="140" r="6" fill="currentColor" />
            {/* Spokes */}
            <line x1="720" y1="55" x2="720" y2="225" stroke="currentColor" strokeWidth="1.5" />
            <line x1="635" y1="140" x2="805" y2="140" stroke="currentColor" strokeWidth="1.5" />
            <line x1="660" y1="80" x2="780" y2="200" stroke="currentColor" strokeWidth="1.5" />
            <line x1="660" y1="200" x2="780" y2="80" stroke="currentColor" strokeWidth="1.5" />
            {/* Base legs */}
            <line x1="720" y1="140" x2="680" y2="320" stroke="currentColor" strokeWidth="6" />
            <line x1="720" y1="140" x2="760" y2="320" stroke="currentColor" strokeWidth="6" />
          </g>

          {/* St Paul's Cathedral */}
          <g opacity="0.45">
            <rect x="940" y="180" width="160" height="140" />
            {/* Great Dome */}
            <path d="M 980,180 A 40,40 0 0,1 1060,180 Z" />
            <rect x="1010" y="130" width="20" height="15" />
            <polygon points="1010,130 1020,110 1030,130" />
            {/* Western Towers */}
            <rect x="945" y="140" width="22" height="40" />
            <polygon points="945,140 956,120 967,140" />
            <rect x="1073" y="140" width="22" height="40" />
            <polygon points="1073,140 1084,120 1095,140" />
          </g>

          {/* Tower Bridge */}
          <g opacity="0.45">
            {/* North Tower */}
            <rect x="1260" y="110" width="40" height="210" />
            <polygon points="1260,110 1280,75 1300,110" />
            {/* South Tower */}
            <rect x="1380" y="110" width="40" height="210" />
            <polygon points="1380,110 1400,75 1420,110" />
            {/* High level walkways */}
            <rect x="1300" y="130" width="80" height="8" />
            <rect x="1300" y="145" width="80" height="8" />
            {/* Lower deck */}
            <rect x="1220" y="240" width="240" height="10" />
            {/* Suspension cables */}
            <path d="M 1220,240 Q 1240,180 1260,150" fill="none" stroke="currentColor" strokeWidth="3" />
            <path d="M 1420,150 Q 1440,180 1460,240" fill="none" stroke="currentColor" strokeWidth="3" />
          </g>

          {/* Foreground Street Vehicles: Routemaster Bus & Black Cab */}
          {/* Classic Routemaster Red Double Decker Bus */}
          <g transform="translate(100, 240)">
            <rect x="0" y="10" width="115" height="60" rx="6" fill="#dc2626" />
            {/* Cream relief band */}
            <rect x="0" y="38" width="115" height="6" fill="#fef08a" />
            {/* Upper deck windows */}
            <rect x="10" y="16" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            <rect x="34" y="16" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            <rect x="58" y="16" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            <rect x="82" y="16" width="24" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            {/* Lower deck windows */}
            <rect x="10" y="48" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            <rect x="34" y="48" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            <rect x="58" y="48" width="18" height="16" rx="2" fill="#e0f2fe" opacity="0.85" />
            {/* Destination blind */}
            <rect x="84" y="4" width="26" height="7" rx="1" fill="#1e293b" />
            <text x="86" y="9.5" fontSize="5" fill="#fbbf24" fontWeight="bold">73 LONDON</text>
            {/* Wheels */}
            <circle cx="26" cy="70" r="9" fill="#18181b" />
            <circle cx="26" cy="70" r="4" fill="#94a3b8" />
            <circle cx="92" cy="70" r="9" fill="#18181b" />
            <circle cx="92" cy="70" r="4" fill="#94a3b8" />
          </g>

          {/* Classic London Black Cab (Hackney Carriage) */}
          <g transform="translate(860, 260)">
            <path
              d="M 0,40 L 8,24 L 20,24 L 30,12 L 55,12 L 62,24 L 75,26 L 75,40 Z"
              fill="#18181b"
              stroke="#334155"
              strokeWidth="1"
            />
            {/* Taxi sign */}
            <rect x="36" y="8" width="12" height="4" rx="1" fill="#f59e0b" />
            {/* Windows */}
            <polygon points="22,23 31,14 42,14 42,23" fill="#e0f2fe" opacity="0.85" />
            <polygon points="46,14 54,14 60,23 46,23" fill="#e0f2fe" opacity="0.85" />
            {/* Wheels */}
            <circle cx="16" cy="42" r="7" fill="#0f172a" />
            <circle cx="16" cy="42" r="3" fill="#cbd5e1" />
            <circle cx="62" cy="42" r="7" fill="#0f172a" />
            <circle cx="62" cy="42" r="3" fill="#cbd5e1" />
          </g>

          {/* Red K6 Telephone Kiosk */}
          <g transform="translate(1140, 235)">
            <rect x="0" y="6" width="24" height="66" rx="4" fill="#dc2626" />
            <path d="M 0,6 Q 12,0 24,6 Z" fill="#dc2626" />
            {/* Glass panes */}
            <rect x="4" y="16" width="16" height="48" fill="#e0f2fe" opacity="0.8" />
            <line x1="4" y1="28" x2="20" y2="28" stroke="#dc2626" strokeWidth="1.5" />
            <line x1="4" y1="40" x2="20" y2="40" stroke="#dc2626" strokeWidth="1.5" />
            <line x1="4" y1="52" x2="20" y2="52" stroke="#dc2626" strokeWidth="1.5" />
            <line x1="12" y1="16" x2="12" y2="64" stroke="#dc2626" strokeWidth="1.5" />
            {/* TELEPHONE header */}
            <rect x="3" y="9" width="18" height="5" fill="#ffffff" />
            <text x="4" y="13" fontSize="3.5" fill="#000000" fontWeight="bold">TELEPHONE</text>
          </g>

          {/* Ground Baseline */}
          <line x1="0" y1="312" x2="1600" y2="312" stroke="currentColor" strokeWidth="2" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
});
