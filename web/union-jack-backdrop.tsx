import { memo } from "react";

/**
 * An unapologetic, full-bleed Flag of the United Kingdom (Union Jack) backdrop.
 * Designed with authentic Flag Institute Pantone 280 C Royal Blue (#012169)
 * and Pantone 186 C Red (#C8102E), with counterchanged St Patrick saltires.
 */
export const UnionJackBackdrop = memo(function UnionJackBackdrop() {
  return (
    <div className="uj-backdrop-wrap" aria-hidden="true">
      <svg
        className="uj-backdrop-svg"
        viewBox="0 0 1200 600"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <clipPath id="uj-full-clip">
            <rect width="1200" height="600" />
          </clipPath>
          {/* St Patrick Pinwheel Clip Paths */}
          <clipPath id="uj-saltire-pinwheel">
            {/* Hoist top: lower half; Hoist bottom: left half; Fly top: upper half; Fly bottom: right half */}
            <path d="M0,0 L600,300 H0 Z M600,0 V300 L1200,0 Z M600,300 L1200,600 H600 Z M0,600 L600,300 V600 Z" />
          </clipPath>
        </defs>

        <g clipPath="url(#uj-full-clip)">
          {/* 1. Deep Royal Navy Field */}
          <rect width="1200" height="600" fill="#012169" />

          {/* 2. St Andrew Broad White Saltire */}
          <path d="M0,0 L1200,600 M1200,0 L0,600" stroke="#FFFFFF" strokeWidth="120" />

          {/* 3. St Patrick Counterchanged Red Saltire */}
          <path
            d="M0,0 L1200,600 M1200,0 L0,600"
            clipPath="url(#uj-saltire-pinwheel)"
            stroke="#C8102E"
            strokeWidth="80"
          />

          {/* 4. St George Broad White Cross Fimbriation */}
          <path d="M600,0 V600 M0,300 H1200" stroke="#FFFFFF" strokeWidth="200" />

          {/* 5. St George Red Cross */}
          <path d="M600,0 V600 M0,300 H1200" stroke="#C8102E" strokeWidth="120" />
        </g>
      </svg>
      {/* Broadcast newsroom vignette overlay for contrast and content readability */}
      <div className="uj-backdrop-overlay" />
    </div>
  );
});
