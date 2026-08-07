/*
 * Navigation and control icons.
 *
 * Deliberately outside the organic design system: the rest of the panel is
 * blobs, seeds and botanical glyphs, but navigation has to be read at a
 * glance, and a flower does not say "settings" to anyone. These are plain
 * geometric line icons - one weight, one grid, no decoration.
 *
 * All of them inherit `currentColor` and size from `1em`, so they take their
 * colour and scale from whatever they sit in.
 */

function Icon({ children, label }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      {children}
    </svg>
  );
}

/** Connection - a link, for the WhatsApp account this panel is linked to. */
export function LinkIcon(props) {
  return (
    <Icon {...props}>
      <path d="M9.5 14.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1 1" />
      <path d="M14.5 9.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1-1" />
    </Icon>
  );
}

/** Members - the people allowed through the door. */
export function UsersIcon(props) {
  return (
    <Icon {...props}>
      <path d="M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H6a3.5 3.5 0 0 0-3.5 3.5V20" />
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M21.5 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8" />
    </Icon>
  );
}

/** Contacts - an address book. */
export function ContactsIcon(props) {
  return (
    <Icon {...props}>
      <rect x="5" y="3" width="15" height="18" rx="2" />
      <path d="M5 8H2.5M5 12H2.5M5 16H2.5" />
      <circle cx="12.5" cy="10" r="2.25" />
      <path d="M8.75 16.5a3.75 3.75 0 0 1 7.5 0" />
    </Icon>
  );
}

/** Messages - a conversation. */
export function ChatIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20.5 12.5a7.5 7.5 0 0 1-10.8 6.7L4 20.5l1.3-5.4A7.5 7.5 0 1 1 20.5 12.5Z" />
    </Icon>
  );
}

/** Activity - the door log, as a pulse. */
export function ActivityIcon(props) {
  return (
    <Icon {...props}>
      <path d="M2.5 12h4l2.5-7 5 14 2.5-7h5" />
    </Icon>
  );
}

/** Settings - sliders. A gear would do, but sliders read as "adjust". */
export function SlidersIcon(props) {
  return (
    <Icon {...props}>
      <path d="M5 21v-7M5 10V3M12 21v-10M12 7V3M19 21v-4M19 13V3" />
      <path d="M2.5 14h5M9.5 7h5M16.5 17h5" />
    </Icon>
  );
}

/** Dark mode on. */
export function MoonIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </Icon>
  );
}

/** Light mode on. */
export function SunIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </Icon>
  );
}

/** Attach a file. */
export function PaperclipIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20 11.5 12.2 19.3a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.2-2.2l7.2-7.2" />
    </Icon>
  );
}

/** Record a voice note. */
export function MicIcon(props) {
  return (
    <Icon {...props}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
    </Icon>
  );
}

/** Send. */
export function SendIcon(props) {
  return (
    <Icon {...props}>
      <path d="M21 3 10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3Z" />
    </Icon>
  );
}

/** Back to the chat list. */
export function ArrowLeftIcon(props) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </Icon>
  );
}

/** Refresh a list. */
export function RefreshIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20.5 11a8.5 8.5 0 1 0-.7 4.5" />
      <path d="M20.5 4.5V11h-6" />
    </Icon>
  );
}

/** Sign out. */
export function SignOutIcon(props) {
  return (
    <Icon {...props}>
      <path d="M15 4.5h2.5A2.5 2.5 0 0 1 20 7v10a2.5 2.5 0 0 1-2.5 2.5H15" />
      <path d="M10.5 16.5 15 12l-4.5-4.5M15 12H3.5" />
    </Icon>
  );
}
