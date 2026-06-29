// Fuse brand mark: two strands merging into one (the "fuse" idea), on a
// red→amber gradient tile. Used in the nav, the assistant avatar, and as the
// favicon (see app/icon.svg, which mirrors this shape).
export default function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Fuse">
      <defs>
        <linearGradient id="fuse-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#dc2626" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#fuse-grad)" />
      <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 5v3a3.5 3.5 0 0 0 3.5 3.5h3A3.5 3.5 0 0 1 17 15v4" />
        <path d="M17 5v3a3.5 3.5 0 0 1-3.5 3.5h-3A3.5 3.5 0 0 0 7 15v4" />
      </g>
    </svg>
  );
}
