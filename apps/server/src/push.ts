import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab, maskTokens, type PushMessage, type PushSend, type PushTicket } from '@konjir/engine';
import { log } from '@konjir/log';
import { MAX_CHANNELS, MAX_PUSH_DEVICES, NOTIFICATION_LEVELS, PUSH_BATCH, PUSH_PLATFORMS, PUSH_PREVIEW_CHARS } from '@konjir/types';
import { args } from './args.js';
import { ListenStreams } from './listen-streams.js';
import { asAgent } from './results.js';
import { KOLAB, PUSH_OPTIONS, type PushOptions } from './tokens.js';

/** Expo's push API (https://docs.expo.dev/push-notifications/sending-notifications/). */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** How long one request to Expo's push service may take before it counts as unreachable, and is retried. */
const EXPO_TIMEOUT_MS = 15_000;

/**
 * Push's settings from the environment, for `kolab serve` (S4): KONJIR_EXPO_ACCESS_TOKEN, Expo's
 * access token, which production's start.sh reads from SSM; without it, or with `unset` (the
 * placeholder Terraform makes the parameter with), push is off. KONJIR_PUSH_PREVIEW=off (or false,
 * 0, no) sends no words of a message, only who sent it and where; on by default.
 */
export function pushOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PushOptions {
  const token = env.KONJIR_EXPO_ACCESS_TOKEN?.trim() ?? '';
  const preview = !/^(off|false|0|no)$/i.test(env.KONJIR_PUSH_PREVIEW?.trim() ?? '');
  return { accessToken: token && token !== 'unset' ? token : null, preview };
}

/**
 * A PushSend through Expo's push API: one POST of at most PUSH_BATCH messages, with the access
 * token. Each message's ticket comes back in order: `ok`, or an error, `unregistered` for
 * DeviceNotRegistered. It throws, so the outbox retries the job with backoff, when the service
 * can't be reached, times out, answers 429 or 5xx, or answers what isn't a ticket for each
 * message. Any other refusal (a 4xx: a bad token, a bad request) is the same next time: each
 * message gets an error ticket, which is logged, and nothing is retried.
 */
export function expoSender(opts: { accessToken: string; fetch?: typeof fetch; url?: string }): PushSend {
  const send = opts.fetch ?? fetch;
  const url = opts.url ?? EXPO_PUSH_URL;
  return async (messages: PushMessage[]): Promise<PushTicket[]> => {
    if (messages.length > PUSH_BATCH) throw new Error(`Expo takes at most ${PUSH_BATCH} pushes a request, not ${messages.length}`);
    let res: Response;
    try {
      res = await send(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${opts.accessToken}` },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Expo's push service could not be reached (${maskTokens(e)}); the push is tried again`);
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`Expo's push service answered ${res.status}; the push is tried again`);
    const body = await res.json().catch(() => undefined) as { data?: unknown; errors?: { code?: string; message?: string }[] } | undefined;
    if (!res.ok) {
      const why = body?.errors?.map((e) => e.code ?? e.message).filter(Boolean).join(', ') || `HTTP ${res.status}`;
      log.error(`Expo's push service refused ${messages.length} push(es): ${why}`, { event: 'push_refused', status: res.status });
      return messages.map(() => ({ ok: false, unregistered: false, error: why }));
    }
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== messages.length) throw new Error('Expo\'s push service answered without a ticket for each push; the push is tried again');
    return data.map((t: { status?: string; message?: string; details?: { error?: string } }): PushTicket => (t?.status === 'ok'
      ? { ok: true }
      : { ok: false, unregistered: t?.details?.error === 'DeviceNotRegistered', error: t?.details?.error ?? t?.message ?? 'refused' }));
  };
}

/**
 * Push notifications to konnect's phone app (S4). With an Expo access token, it gives the engine
 * an Expo sender, and for each message sent through this process, once it commits
 * (Kolab.onMessageSent), asks the engine to decide who is pushed it and to queue the job; the
 * outbox worker sends it. A person with a listen stream open in the team on this process is
 * skipped: Kolab runs one server process today, so that is every stream. With more than one, a
 * stream on another process isn't seen, and its person is pushed anyway. Without a token, push is
 * off: it says so once, at boot, to the logger it is given (`kolab serve`'s), and queues nothing.
 */
@Injectable()
export class PushNotifications implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;
  private sender?: PushSend;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(ListenStreams) private readonly streams: ListenStreams,
    @Inject(PUSH_OPTIONS) private readonly options: PushOptions,
  ) {}

  onModuleInit() {
    if (!this.options.accessToken) {
      this.options.log?.info('push notifications are off: no Expo access token is configured (KONJIR_EXPO_ACCESS_TOKEN)', { event: 'push_off' });
      return;
    }
    this.sender = expoSender({ accessToken: this.options.accessToken, fetch: this.options.fetch, url: this.options.url });
    this.kolab.push.send = this.sender;
    this.kolab.push.preview = this.options.preview;
    this.unsubscribe = this.kolab.onMessageSent((m) => {
      void this.kolab.queuePushes(m, { listening: this.streams.listeningSessions() })
        .catch((e) => log.error(`could not queue the pushes of message ${m.id} in kolab ${m.kolab}`, { event: 'push_not_queued', kolab: m.kolab, error: e }));
    });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    if (this.sender && this.kolab.push.send === this.sender) this.kolab.push.send = null;
  }
}

const registerPushDevice = args({
  token: z.string().describe('The app\'s Expo push token, ExponentPushToken[…], as expo-notifications\' getExpoPushTokenAsync gives it'),
  platform: z.enum(PUSH_PLATFORMS).describe('The device\'s platform'),
});
const unregisterPushDevice = args({ token: z.string().describe('The Expo push token the app registered') });
const setNotificationPrefs = args({
  level: z.enum(NOTIFICATION_LEVELS).describe('all: every direct message, and every message in a channel you follow or that mentions you. mentions_and_dms: direct messages and mentions only (the default). none: nothing'),
  muted_channels: z.array(z.string()).optional().describe(`The channels to mute, by name, at most ${MAX_CHANNELS}: nothing is pushed from them, mentions included. They replace those muted before; left out, those stay`),
  hide_preview: z.boolean().optional().describe('true: your pushes say who sent a message and where, never its words. Left out, it stays as it was (false at first)'),
});
const noArgs = args({});

/**
 * The tools konnect's app registers for push with, and sets what it is told of (S4). Each is for a
 * person's own session, never an agent's, and reaches only the caller's own devices and prefs, in
 * the session's kolab. None spends a budget.
 */
@Injectable()
export class PushTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({
    name: 'konjir_register_push_device',
    description: `For a person's own session in konnect's app only, never an agent's nor any other app's: register your phone's konnect app for push notifications, by its Expo push token and platform, from whichever of your kolabs this session is in. The device is yours, not this kolab's: it is pushed messages from every kolab you are a member of, each under your prefs there (konjir_set_notification_prefs). Idempotent: registering again renews it. A token someone else registered (the same phone, signed in as them) moves to you. One device for each sign-in: registering a token forgets any other registered from the same sign-in. A device gets nothing once its sign-in is revoked, lapses or has no open session, so register again after signing in. You keep at most ${MAX_PUSH_DEVICES} devices: one more forgets the one least recently seen. A push says who sent a message and, for a channel, which; its first ${PUSH_PREVIEW_CHARS} characters, unless this Kolab sends no previews or you hide them; what to open, data.team naming its kolab; and, as the badge, your unread across all your kolabs. Returns { device: { token, platform, created_at, last_seen_at } }.`,
    schema: registerPushDevice,
    annotations: { idempotentHint: true },
  })
  registerPushDevice({ token, platform }: z.infer<typeof registerPushDevice>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.registerPushDevice(s, token, platform));
  }

  @McpTool({
    name: 'konjir_unregister_push_device',
    description: 'For a person\'s own session in konnect\'s app only, never an agent\'s nor any other app\'s: stop push notifications to one of your devices, from every kolab, by its Expo push token, as the app does when it signs out. Returns { unregistered }: false when you had no such device.',
    schema: unregisterPushDevice,
    annotations: { idempotentHint: true },
  })
  unregisterPushDevice({ token }: z.infer<typeof unregisterPushDevice>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.unregisterPushDevice(s, token));
  }

  @McpTool({
    name: 'konjir_set_notification_prefs',
    description: 'For a person\'s own session in konnect\'s app only, never an agent\'s nor any other app\'s: choose what this kolab, the one this session is in, pushes to your devices; each of your kolabs has its own. level is all, mentions_and_dms (the default) or none; muted_channels, when given, replaces the channels you mute, by name, which push nothing, mentions included; hide_preview, when given, true keeps every word of a message out of your pushes, which then say only who sent it and where. Nothing from this kolab is pushed while a listen stream of yours is open in it. Returns { kolab, level, muted_channels, hide_preview }.',
    schema: setNotificationPrefs,
    annotations: { idempotentHint: true },
  })
  setNotificationPrefs({ level, muted_channels, hide_preview }: z.infer<typeof setNotificationPrefs>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.setNotificationPrefs(s, { level, muted_channels, hide_preview }));
  }

  @McpTool({
    name: 'konjir_get_notification_prefs',
    description: 'For a person\'s own session in konnect\'s app only, never an agent\'s nor any other app\'s: what your kolab pushes to your devices, as konjir_set_notification_prefs set it: { kolab, level, muted_channels, hide_preview }, mentions_and_dms, none muted and previews shown until you choose.',
    schema: noArgs,
    annotations: { readOnlyHint: true },
  })
  getNotificationPrefs(_: z.infer<typeof noArgs>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.notificationPrefs(s));
  }
}
