/**
 * Push (phase 4, the server's S4). A phone asks for permission after its first sign-in, never at
 * launch; gets its Expo push token, which needs the EAS project; and registers it with each team it
 * is signed in to (konjir_register_push_device), taking it back on sign-out. What reaches the phone
 * is set per team (konjir_set_notification_prefs). A notification's data opens its conversation.
 *
 * Each step says plainly why it can't go on: no permission, no EAS project yet, or a Kolab without
 * push. The pure parts (the prefs' arguments, a notification's route) are tested apart.
 */
import type { Client } from '@modelcontextprotocol/client';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import type { AgentNotifyLevel, NotificationPrefs } from '@konjir/types';
import { call } from './kolab/api';

/** Where the phone keeps its push token, and what happened when it registered it (kv-store). */
export const PUSH_TOKEN_KEY = 'konnect.push.token';
export const PUSH_STATUS_KEY = 'konnect.push.status';

export type NotifyLevel = 'all' | 'mentions_and_dms' | 'none';
/** `agents`: what the person is pushed of each of their own agents, by its name; one left out is `stuck`. */
export interface NotifyPrefs { level: NotifyLevel; muted: string[]; hidePreview: boolean; agents: Record<string, AgentNotifyLevel> }
export const DEFAULT_PREFS: NotifyPrefs = { level: 'mentions_and_dms', muted: [], hidePreview: false, agents: {} };

/**
 * The arguments of konjir_set_notification_prefs for `prefs`: channels by name, each once, sorted.
 * Hiding the words is Kolab's to do (it sends the push), so it goes to Kolab too.
 */
export function prefsArgs(prefs: NotifyPrefs): { level: NotifyLevel; muted_channels: string[]; hide_preview: boolean; agents?: Record<string, AgentNotifyLevel> } {
  const muted = [...new Set(prefs.muted.map((c) => c.replace(/^#/, '').toLowerCase()).filter(Boolean))].sort();
  // Kolab merges `agents` per agent: those named are set, the rest keep theirs.
  const agents = Object.keys(prefs.agents ?? {}).length ? { agents: prefs.agents } : {};
  return { level: prefs.level, muted_channels: prefs.level === 'none' ? [] : muted, hide_preview: prefs.hidePreview, ...agents };
}

/**
 * What a push carries, as S4 sends it: the team, and the conversation the message is in; or, for
 * one of the person's own agents (`kind: 'agent'`), the agent, and its DM partner or channel.
 */
export interface PushData { team?: string; kind?: string; agent?: string; reason?: string; channel?: string; with?: string; message?: string }

/**
 * The screen a notification opens, and its team; nothing for one that names no team. One about
 * your agent opens its DM read-only (`with`), the channel on its messages (`channel`), or its screen.
 */
export function routeOf(data: unknown): { team: string; path: string } | undefined {
  const d = (data ?? {}) as PushData;
  if (!d.team) return undefined;
  if (d.kind === 'agent' && d.agent) {
    const agent = encodeURIComponent(d.agent);
    if (d.with) return { team: d.team, path: `/c/dm/${encodeURIComponent(d.with)}?as=${agent}` };
    if (d.channel) return { team: d.team, path: `/c/channel/${encodeURIComponent(d.channel)}?only=${agent}` };
    return { team: d.team, path: `/agent/${agent}` };
  }
  if (d.channel) return { team: d.team, path: `/c/channel/${encodeURIComponent(d.channel)}` };
  if (d.with) return { team: d.team, path: `/c/dm/${encodeURIComponent(d.with)}` };
  return { team: d.team, path: '/' };
}

export type PushToken = { ok: true; token: string } | { ok: false; why: string };

/** Asks for permission if it hasn't been answered, then gets this phone's Expo push token. */
export async function pushToken(): Promise<PushToken> {
  if (!Device.isDevice) return { ok: false, why: 'Push needs a real phone: simulators get no push token.' };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return { ok: false, why: 'Push needs the EAS project, which isn\'t linked yet.' };
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, why: 'Notifications are off for konnect in Settings.' };
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('messages', { name: 'Messages', importance: AndroidImportance.HIGH });
  return { ok: true, token: (await Notifications.getExpoPushTokenAsync({ projectId })).data };
}

/** Whether this Kolab has S4's tools: an older one says nothing about push. */
export async function kolabHasPush(client: Client): Promise<boolean> {
  const { tools } = await client.listTools();
  return tools.some((t) => t.name === 'konjir_register_push_device');
}

export async function registerDevice(client: Client, token: string) {
  await call(client, 'konjir_register_push_device', { token, platform: Platform.OS });
}

export async function unregisterDevice(client: Client, token: string) {
  await call(client, 'konjir_unregister_push_device', { token });
}

/** The team's prefs as Kolab keeps them (konjir_get_notification_prefs). */
export async function getPrefs(client: Client): Promise<NotifyPrefs> {
  const r = await call<NotificationPrefs>(client, 'konjir_get_notification_prefs');
  return { level: r.level, muted: r.muted_channels, hidePreview: r.hide_preview, agents: r.agents ?? {} };
}

/** Sets the team's prefs at Kolab, and gives what Kolab keeps now. */
export async function setPrefs(client: Client, prefs: NotifyPrefs): Promise<NotifyPrefs> {
  const r = await call<NotificationPrefs>(client, 'konjir_set_notification_prefs', prefsArgs(prefs));
  return { level: r.level, muted: r.muted_channels, hidePreview: r.hide_preview, agents: r.agents ?? {} };
}

/** The app's badge: everything unread in the team shown. */
export const setBadge = (n: number) => Notifications.setBadgeCountAsync(Math.max(0, n)).catch(() => false);
