import type React from 'react';

interface IconProps {
  className?: string;
}

export const RiftIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Rift Coach Logo"
  >
    <title>Rift Coach</title>
    <path
      d="M12 2L3 7v10l9 5 9-5V7l-9-5z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <path
      d="M12 22V12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M3 7l9 5 9-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AnalyticsIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Analytics"
  >
    <title>Analytics</title>
    <path
      d="M3 3v18h18"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 16l4-4 4 4 6-6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="7" cy="16" r="2" fill="currentColor" />
    <circle cx="11" cy="12" r="2" fill="currentColor" />
    <circle cx="15" cy="16" r="2" fill="currentColor" />
    <circle cx="21" cy="10" r="2" fill="currentColor" />
  </svg>
);

export const MasteryIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Champion Mastery"
  >
    <title>Champion Mastery</title>
    <path
      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      fill="none"
    />
    <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.3" />
  </svg>
);

export const HeatmapIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Heatmap Analysis"
  >
    <title>Heatmap Analysis</title>
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" fill="none" />
    <rect x="6" y="6" width="3" height="3" fill="currentColor" opacity="0.8" />
    <rect x="10.5" y="6" width="3" height="3" fill="currentColor" opacity="0.4" />
    <rect x="15" y="6" width="3" height="3" fill="currentColor" opacity="0.6" />
    <rect x="6" y="10.5" width="3" height="3" fill="currentColor" opacity="0.3" />
    <rect x="10.5" y="10.5" width="3" height="3" fill="currentColor" opacity="0.9" />
    <rect x="15" y="10.5" width="3" height="3" fill="currentColor" opacity="0.2" />
    <rect x="6" y="15" width="3" height="3" fill="currentColor" opacity="0.5" />
    <rect x="10.5" y="15" width="3" height="3" fill="currentColor" opacity="0.7" />
    <rect x="15" y="15" width="3" height="3" fill="currentColor" opacity="0.4" />
  </svg>
);

export const PerformanceIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Performance Metrics"
  >
    <title>Performance Metrics</title>
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
    <path
      d="M12 6v6l4 2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
  </svg>
);

export const MatchHistoryIcon: React.FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Match History"
  >
    <title>Match History</title>
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" fill="none" />
    <path d="M7 8h10M7 12h10M7 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="17" cy="16" r="2" fill="currentColor" opacity="0.6" />
  </svg>
);