export default function MunitaAvatar({ className = '' }) {
  return (
    <span className={`munita-avatar ${className}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" role="img" focusable="false">
        <defs>
          <linearGradient id="munitaLeafGradient" x1="11" y1="7" x2="54" y2="58" gradientUnits="userSpaceOnUse">
            <stop stopColor="#CFF2D8" />
            <stop offset="0.56" stopColor="#8FE8D0" />
            <stop offset="1" stopColor="#146152" />
          </linearGradient>
          <linearGradient id="munitaFaceGradient" x1="18" y1="17" x2="47" y2="48" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFF9EC" />
            <stop offset="1" stopColor="#E9F7ED" />
          </linearGradient>
        </defs>
        <circle className="munita-avatar-halo" cx="32" cy="32" r="30" />
        <path className="munita-avatar-leaf-body" d="M12.5 34.2c0-14.8 10.6-25 25.7-25 8.1 0 13.3 2.1 13.3 2.1s.1 10.7-5.7 20.1C40.6 39.8 30.7 47 18.3 47c-3.3 0-5.8-4.7-5.8-12.8Z" />
        <path className="munita-avatar-sprout" d="M34.6 13.8C36.1 7.9 40.8 5.1 47 5c-.1 6.7-4.1 11.1-10.8 12.5" />
        <path className="munita-avatar-face" d="M19.8 31.1c0-8 5.2-13.5 12.2-13.5S44.2 23.1 44.2 31.1v7.1c0 5.1-3.7 8.5-8.8 8.5h-6.8c-5.1 0-8.8-3.4-8.8-8.5v-7.1Z" />
        <path className="munita-avatar-bang" d="M21.4 30.8c5.2-.3 9.3-2.4 12.1-6.6 2.5 3.7 5.3 5.7 9.1 6.4" />
        <circle className="munita-avatar-cheek" cx="25.2" cy="36" r="2.2" />
        <circle className="munita-avatar-cheek" cx="38.8" cy="36" r="2.2" />
        <circle className="munita-avatar-eye" cx="27.3" cy="32.4" r="1.7" />
        <circle className="munita-avatar-eye" cx="36.7" cy="32.4" r="1.7" />
        <path className="munita-avatar-smile" d="M27.5 39.2c2.6 2.3 6.4 2.3 9 0" />
        <path className="munita-avatar-pin" d="M47.3 53.6c4.6-4.6 6.9-8.9 6.9-12.7a6.9 6.9 0 0 0-13.8 0c0 3.8 2.3 8.1 6.9 12.7Z" />
        <circle className="munita-avatar-pin-dot" cx="47.3" cy="40.8" r="2.25" />
        <path className="munita-avatar-spark" d="M14.7 17.3h5.7M17.5 14.5v5.7" />
      </svg>
    </span>
  )
}
