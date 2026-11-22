/**
 * The verified https links preview and production sign in through (a Universal Link on iOS, an App
 * Link on Android), on Konjir's own site. Each variant has its own path, so a sign-in answer meant
 * for one app is never handed to the other: the site's apple-app-site-association and
 * assetlinks.json give each app its own path, and app.config.ts declares only that one.
 *
 * app.config.ts declares the same links (it can import nothing of the app's); test/config.test.ts
 * checks they agree.
 */
export const APP_LINK_HOST = 'www.konjir.com';

/** The path of each variant's sign-in link; development signs in through its private scheme instead. */
export const APP_LINK_PATH = {
  preview: '/konnect/app/preview/oauth',
  production: '/konnect/app/oauth',
} as const;

export const PREVIEW_REDIRECT = `https://${APP_LINK_HOST}${APP_LINK_PATH.preview}`;
export const PRODUCTION_REDIRECT = `https://${APP_LINK_HOST}${APP_LINK_PATH.production}`;

/** Whether `path` (a path, or a whole https URL on the site) is one of the sign-in links. */
export function isAppLinkSignIn(path: string): boolean {
  const p = path.replace(new RegExp(`^https?://${APP_LINK_HOST.replace(/\./g, '\\.')}(?=/|$)`, 'i'), '');
  return /^\/konnect\/app\/(preview\/)?oauth(\/|\?|#|$)/.test(p);
}
