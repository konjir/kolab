/**
 * Notification taps, each handled once. The app sees a tap twice over (the listener, and
 * getLastNotificationResponse on launch, which keeps returning the last one), so a tap is known by
 * its notification's identifier and the date of the response, and opened only the first time.
 */
export interface Tap { notification: { request: { identifier: string; content: { data?: unknown } }; date?: number }; actionIdentifier?: string }

export function tapHandler(open: (data: unknown) => void, seen: Set<string> = new Set()) {
  return (tap: Tap | null | undefined) => {
    if (!tap) return false;
    const key = `${tap.notification.request.identifier}@${tap.notification.date ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    open(tap.notification.request.content.data);
    return true;
  };
}
