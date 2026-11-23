/**
 * Every icon the plan's information architecture names (docs/plans/konnect-mobile.md), once: an SF
 * Symbol on iOS and a Material Symbol on Android, both through expo-symbols. The names are typed
 * against each platform's catalogue (sf-symbols-typescript, expo-symbols' symbols.json), so
 * `typecheck` fails on a name either platform lacks.
 */
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ComponentProps } from 'react';

type Names = Extract<SymbolViewProps['name'], { ios?: unknown }>;
type Pair = { ios: NonNullable<Names['ios']>; android: NonNullable<Names['android']> };

export const ICONS = {
  // Tabs
  home: { ios: 'house', android: 'home' },
  homeSelected: { ios: 'house.fill', android: 'home' },
  dms: { ios: 'bubble.left.and.bubble.right', android: 'forum' },
  dmsSelected: { ios: 'bubble.left.and.bubble.right.fill', android: 'forum' },
  activity: { ios: 'bell', android: 'notifications' },
  activitySelected: { ios: 'bell.fill', android: 'notifications' },
  you: { ios: 'person.crop.circle', android: 'account_circle' },
  youSelected: { ios: 'person.crop.circle.fill', android: 'account_circle' },
  // Home's sections and rows
  channel: { ios: 'number', android: 'tag' },
  person: { ios: 'person', android: 'person' },
  agent: { ios: 'cpu', android: 'smart_toy' },
  team: { ios: 'person.3', android: 'groups' },
  teamSwitcher: { ios: 'chevron.down', android: 'expand_more' },
  browseChannels: { ios: 'magnifyingglass', android: 'search' },
  newMessage: { ios: 'square.and.pencil', android: 'edit_square' },
  // An agent's state dot: working, running, idle, not running
  stateWorking: { ios: 'bolt.circle.fill', android: 'bolt' },
  stateRunning: { ios: 'circle.fill', android: 'circle' },
  stateIdle: { ios: 'moon.zzz', android: 'bedtime' },
  stateStopped: { ios: 'circle', android: 'radio_button_unchecked' },
  // Activity
  mention: { ios: 'at', android: 'alternate_email' },
  reply: { ios: 'arrowshape.turn.up.left', android: 'reply' },
  capped: { ios: 'bell.slash', android: 'notifications_off' },
  // The conversation and the composer
  quote: { ios: 'text.quote', android: 'format_quote' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  send: { ios: 'arrow.up.circle.fill', android: 'send' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  failed: { ios: 'exclamationmark.circle', android: 'error' },
  // Channel details, profiles and team settings
  follow: { ios: 'plus.circle', android: 'add_circle' },
  following: { ios: 'checkmark.circle.fill', android: 'check_circle' },
  message: { ios: 'message', android: 'chat' },
  settings: { ios: 'gearshape', android: 'settings' },
  invite: { ios: 'person.badge.plus', android: 'person_add' },
  remove: { ios: 'person.badge.minus', android: 'person_remove' },
  replyCap: { ios: 'gauge.with.dots.needle.50percent', android: 'speed' },
  archive: { ios: 'archivebox', android: 'archive' },
  delete: { ios: 'trash', android: 'delete' },
  leave: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout' },
  // You
  notifications: { ios: 'bell.badge', android: 'notifications_active' },
  signIn: { ios: 'person.badge.key', android: 'login' },
  update: { ios: 'arrow.down.circle', android: 'system_update' },
  // Lists and settings
  chevron: { ios: 'chevron.right', android: 'chevron_right' },
  back: { ios: 'chevron.left', android: 'arrow_back' },
  check: { ios: 'checkmark', android: 'check' },
  info: { ios: 'info.circle', android: 'info' },
  unreads: { ios: 'tray', android: 'inbox' },
  offline: { ios: 'wifi.slash', android: 'wifi_off' },
} as const satisfies Record<string, Pair>;

export type IconName = keyof typeof ICONS;

/** An icon of the app's set, in the brand's colours where `tintColor` gives one. */
export function Icon({ name, ...rest }: { name: IconName } & Omit<ComponentProps<typeof SymbolView>, 'name'>) {
  return <SymbolView name={ICONS[name]} {...rest} />;
}
