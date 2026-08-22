/**
 * Icons.
 *
 * The old shell used emoji (🗺 ⚔ 📜 📋 🎲 🎯) for its navigation and its actions. Emoji are
 * the wrong tool here for three reasons that all show up on a phone: they render in the
 * platform's own colours, so they fight a dark UI and cannot take an accent or a disabled
 * state; every platform draws a different picture for the same codepoint; and several of the
 * ones in use (⚔ 📜) fall back to a monochrome glyph at tab-bar size and read as noise.
 *
 * These are 24x24 stroke icons on a single grid, drawn in `currentColor` so they inherit the
 * state of whatever they sit in. They are decorative by default (`aria-hidden`) because the
 * control around them carries the label; pass `title` for the rare standalone case.
 */
import type { JSX } from 'preact';

export interface IconProps {
  /** Rendered size in px. 20 for inline, 24 for controls, 28 for the tab bar. */
  size?: number;
  /** Accessible name. Omitted (the norm), the icon is hidden from assistive tech. */
  title?: string;
  class?: string;
  style?: JSX.CSSProperties | string;
}

function Svg({ size = 24, title, class: cls, style, children }: IconProps & { children: preact.ComponentChildren }) {
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      style={style}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

/* --- navigation ----------------------------------------------------------- */

export const IconMap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4Z" />
    <path d="M9 4v13M15 7v13" />
  </Svg>
);

export const IconRoster = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4h6v2.5H9zM8.5 11h7M8.5 15h4.5" />
  </Svg>
);

export const IconLog = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M15 3v4h4M9.5 12h6M9.5 16h4" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5 8 12l7 7" />
  </Svg>
);

export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

/* --- the game ------------------------------------------------------------- */

export const IconDice = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2.4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Svg>
);

export const IconMove = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18M3 12h18" />
    <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </Svg>
);

export const IconMelee = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20 20 4M15 4h5v5" />
    <path d="M4 15v5h5M9 15l-5 5" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6l-7-3Z" />
  </Svg>
);

/** Engage order: eye open — the operative can be seen and can be shot. */
export const IconEngage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.75" />
  </Svg>
);

/** Conceal order: eye struck through. */
export const IconConceal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5C5.6 6.6 8.5 5.5 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M15.6 15.9c-1.1.4-2.3.6-3.6.6-6 0-9.5-6.5-9.5-6.5" />
    <path d="M4 4l16 16" />
  </Svg>
);

/** An operative token, for lists and chips. */
export const IconOperative = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
  </Svg>
);

export const IconObjective = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </Svg>
);

/* --- controls ------------------------------------------------------------- */

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 5 5 9-11" />
  </Svg>
);

export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h10a5.5 5.5 0 0 1 0 11h-3" />
    <path d="M7.5 5.5 4 9l3.5 3.5" />
  </Svg>
);

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4.5 4.5M10.5 7.75v5.5M7.75 10.5h5.5" />
  </Svg>
);

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4.5 4.5M7.75 10.5h5.5" />
  </Svg>
);

/** Fit the whole killzone on screen. */
export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4.5 4.5" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5 7.5 20h9l1-13.5" />
  </Svg>
);

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h11l3 3v13H5z" />
    <path d="M8.5 4v5h7V4M8 20v-6h8v6" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5 21 20H3l9-15.5Z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.4" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

/** Pass-and-play hand-over. */
export const IconHandover = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 18.5h3" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 21V4M6 4h11l-2.5 4L17 12H6" />
  </Svg>
);
