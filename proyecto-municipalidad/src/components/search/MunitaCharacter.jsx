export default function MunitaCharacter({ className = '' }) {
  return (
    <span className={`munita-character ${className}`} aria-hidden="true">
      <svg viewBox="0 0 180 220" role="img" focusable="false">
        <defs>
          <linearGradient id="munitaCharacterLeaf" x1="42" y1="16" x2="142" y2="154" gradientUnits="userSpaceOnUse">
            <stop stopColor="#CFF2D8" />
            <stop offset="0.56" stopColor="#8FE8D0" />
            <stop offset="1" stopColor="#146152" />
          </linearGradient>
          <linearGradient id="munitaCharacterFace" x1="59" y1="46" x2="122" y2="113" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFF9EC" />
            <stop offset="1" stopColor="#E9F7ED" />
          </linearGradient>
          <linearGradient id="munitaCharacterBody" x1="61" y1="112" x2="128" y2="198" gradientUnits="userSpaceOnUse">
            <stop stopColor="#F4FFF5" />
            <stop offset="1" stopColor="#BFE9C9" />
          </linearGradient>
          <filter id="munitaCharacterShadow" x="-20%" y="-10%" width="140%" height="130%">
            <feDropShadow dx="0" dy="14" stdDeviation="10" floodColor="#0F261F" floodOpacity="0.18" />
          </filter>
        </defs>

        <ellipse className="munita-character-shadow" cx="92" cy="203" rx="51" ry="10" />

        <g className="munita-character-body" filter="url(#munitaCharacterShadow)">
          <path className="munita-character-leaf" d="M34 82.5c0-42.2 30-70.5 72.6-70.5 23 0 37.8 6 37.8 6s.4 30.6-16.2 57.3c-14.9 24-43.1 44.6-78.2 44.6-9.3 0-16-13.3-16-37.4Z" />
          <path className="munita-character-sprout" d="M96.8 25.4C101 8.8 114.2 1.2 132 1c-.3 18.9-11.6 31.4-30.4 35.4" />
          <path className="munita-character-torso" d="M59.2 126.5c4.4-16.6 16.3-26.2 32.8-26.2 16.6 0 28.6 9.6 33 26.2l8.4 38.7c2.7 12.2-6.7 23.8-19.2 23.8H69.8c-12.5 0-21.9-11.6-19.2-23.8l8.6-38.7Z" />
          <path className="munita-character-face" d="M56 75.2c0-23 14.7-38.7 35.5-38.7 20.7 0 35.5 15.7 35.5 38.7v19.4c0 14.7-10.9 24.8-25.5 24.8h-20c-14.6 0-25.5-10.1-25.5-24.8V75.2Z" />
          <path className="munita-character-bang" d="M60.2 74.5c15.2-.9 27-7 35.2-19.2 7.3 10.8 15.4 16.6 26.5 18.6" />

          <g className="munita-character-arm munita-character-arm-left">
            <path d="M60.4 135.8c-14.5 5.7-25.3 15.6-31.8 29.2" />
            <circle cx="26.9" cy="168.8" r="6.8" />
          </g>
          <g className="munita-character-arm munita-character-arm-right">
            <path d="M124.7 134.8c9.5-4.9 18.1-11.7 24.9-20.4" />
            <circle cx="153.5" cy="110.1" r="6.8" />
          </g>

          <circle className="munita-character-cheek" cx="72.7" cy="89.6" r="5.1" />
          <circle className="munita-character-cheek" cx="110.3" cy="89.6" r="5.1" />
          <circle className="munita-character-eye munita-character-eye-left" cx="78.5" cy="80.8" r="4.1" />
          <circle className="munita-character-eye munita-character-eye-right" cx="104.5" cy="80.8" r="4.1" />
          <path className="munita-character-smile" d="M79.4 98.7c7.1 6.2 17.1 6.2 24.2 0" />
          <path className="munita-character-badge" d="M115.3 148.4c10.7-10.6 16-20.5 16-29.5a16 16 0 0 0-32 0c0 9 5.4 18.9 16 29.5Z" />
          <circle className="munita-character-badge-dot" cx="115.3" cy="118.9" r="5.2" />
          <path className="munita-character-foot munita-character-foot-left" d="M75.1 185.5v17.8" />
          <path className="munita-character-foot munita-character-foot-right" d="M108.9 185.5v17.8" />
        </g>

        <g className="munita-character-sparkles">
          <path className="munita-character-sparkle sparkle-a" d="M32 41h12M38 35v12" />
          <path className="munita-character-sparkle sparkle-b" d="M146 62h10M151 57v10" />
          <path className="munita-character-sparkle sparkle-c" d="M139 169h9M143.5 164.5v9" />
        </g>
      </svg>
    </span>
  )
}
