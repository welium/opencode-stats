/**
 * Hand-built inline SVG icons.
 *
 * Plan references: §3 "No new runtime dependencies for charts, icons, routing,
 * or state management" and §1 "Bundle all browser assets locally, including any
 * fonts and icons." Each icon is a small stroked path drawn on a 24×24 grid and
 * inherits `currentColor`, so it needs no sprite sheet, font, or remote request.
 */

import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered size in pixels; defaults to 16. */
  size?: number;
}

/** Shared frame; `children` are the stroked paths of one icon. */
function Icon(props: IconProps & { children: ReactNode }): React.ReactElement {
  const { size = 16, children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </Icon>
  );
}

export function ModelsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8" y="8" width="8" height="8" rx="2" />
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 4.5 8 7M18 4.5 16 7M6 19.5 8 17M18 19.5 16 17" />
    </Icon>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
    </Icon>
  );
}

export function ToolsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 5.5a4 4 0 0 0 5.2 5.2L21 9.4V15a3 3 0 0 1-3 3h-4.6l-1.3 1.3a4 4 0 0 1-5.6-5.6L9.4 11z" />
      <circle cx="6.5" cy="6.5" r="2.5" />
    </Icon>
  );
}

export function SessionsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h11M4 12h11M4 18h7" />
      <circle cx="19" cy="6" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4h-4" />
    </Icon>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

/** Sort indicator: both arrows are visible, the inactive one is faded, so the
 * current direction does not depend on color. */
export function SortIcon(props: Omit<IconProps, 'direction'> & { direction: 'asc' | 'desc' | null }) {
  const { direction, ...rest } = props;
  return (
    <Icon {...rest} size={rest.size ?? 12}>
      <path d="M8 10l4-4 4 4" opacity={direction === 'asc' || direction === null ? 1 : 0.3} />
      <path d="M8 14l4 4 4-4" opacity={direction === 'desc' || direction === null ? 1 : 0.3} />
    </Icon>
  );
}

export function DatabaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </Icon>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 13.5 6 5h12l3 8.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13.5h5l1.5 2.5h5L16 13.5h5" />
    </Icon>
  );
}
