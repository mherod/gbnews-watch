import { memo } from "react";

/**
 * An exact, geometrically authentic Flag of the United Kingdom (Union Flag / Union Jack)
 * rendered using official Flag Institute Pantone specifications:
 * - Royal Navy Blue: Pantone 280 C (#012169)
 * - St George / St Patrick Red: Pantone 186 C (#C8102E)
 * - Pure White: (#FFFFFF)
 */
export const UnionJack = memo(function UnionJack({
  width = 24,
  height = 12,
  className = "union-jack",
}: {
  width?: number;
  height?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 60 30"
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Flag of the United Kingdom"
      style={{ borderRadius: "2px", flexShrink: 0 }}
    >
      <clipPath id="uj-bounds">
        <path d="M0,0 v30 h60 v-30 z" />
      </clipPath>
      {/* Pinwheel clipping path for St Patrick's counterchanged saltire */}
      <clipPath id="uj-saltire-clip">
        <path d="M0,0 L30,15 H0 Z M30,0 V15 L60,0 Z M30,15 L60,30 H30 Z M0,30 L30,15 V30 Z" />
      </clipPath>
      <g clipPath="url(#uj-bounds)">
        {/* 1. Deep Royal Navy Blue field (St Andrew Scottish field) */}
        <path d="M0,0 v30 h60 v-30 z" fill="#012169" />

        {/* 2. St Andrew broad white saltire */}
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" strokeWidth="6" />

        {/* 3. St Patrick counterchanged red saltire */}
        <path
          d="M0,0 L60,30 M60,0 L0,30"
          clipPath="url(#uj-saltire-clip)"
          stroke="#C8102E"
          strokeWidth="4"
        />

        {/* 4. St George broad white fimbriation cross */}
        <path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" strokeWidth="10" />

        {/* 5. St George English red cross */}
        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  );
});
