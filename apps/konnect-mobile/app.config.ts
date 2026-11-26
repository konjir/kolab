/**
 * konnect's native configuration, all of it: `ios/` and `android/` are generated from this by
 * `expo prebuild` (Continuous Native Generation) and never committed.
 *
 * APP_VARIANT picks one of three apps that install side by side, each with its own name, bundle
 * ID, package and URL scheme: `development` (the default, a dev client), `preview` (internal
 * testers) and `production` (the stores). eas.json sets it for each build profile.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The EAS project, @icedlee337/konnect, owned by Lee's personal Expo account (Lee, 2026-11-21).
 * Both are public identifiers, not secrets. The project ID also gives builds their over-the-air
 * update URL.
 */
const EAS_PROJECT_ID: string | undefined = 'fba59fe9-7c12-4d31-ac0b-d270dffb258b';
const EAS_OWNER: string | undefined = 'icedlee337';

export const VARIANTS = ['development', 'preview', 'production'] as const;
export type Variant = (typeof VARIANTS)[number];

/** The bundle ID (iOS), package (Android) and URL scheme of each variant: one reverse-DNS name. */
export function identity(variant: Variant): { id: string; name: string } {
  switch (variant) {
    case 'development': return { id: 'com.konjir.konnect.dev', name: 'konnect dev' };
    case 'preview': return { id: 'com.konjir.konnect.preview', name: 'konnect preview' };
    case 'production': return { id: 'com.konjir.konnect', name: 'konnect' };
  }
}

/** The variant APP_VARIANT names, `development` when it is unset; anything else is refused. */
export function variantOf(env: Record<string, string | undefined>): Variant {
  const v = env.APP_VARIANT ?? 'development';
  if (!(VARIANTS as readonly string[]).includes(v)) {
    throw new Error(`APP_VARIANT is ${JSON.stringify(v)}; it must be one of ${VARIANTS.join(', ')}`);
  }
  return v as Variant;
}

/**
 * Preview's and production's sign-in links, each its own path: src/auth/app-links.ts's, which the
 * app signs in with (this file can import nothing of the app's; test/config.test.ts checks they agree).
 */
const APP_LINK_HOST = 'www.konjir.com';
const APP_LINK_PATH = { preview: '/konnect/app/preview/oauth', production: '/konnect/app/oauth' } as const;

/** Predawn's surface (libs/brand), the splash screen's and the launch background in dark mode. */
const PREDAWN_SURFACE = '#16140f';
/** Daybreak's surface (libs/brand), in light mode. */
const DAYBREAK_SURFACE = '#f8f2d6';


export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantOf(process.env);
  const { id, name } = identity(variant);
  return {
    ...config,
    name,
    slug: 'konnect',
    version: '1.0.0',
    // Not web: Kolab's /mcp sends no CORS headers, and the web interface is apps/web.
    platforms: ['ios', 'android'],
    scheme: id,
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: '../../brand/konjir-avatar.png',
    backgroundColor: PREDAWN_SURFACE,
    ...(EAS_OWNER ? { owner: EAS_OWNER } : {}),
    // An update reaches only the builds whose native code it was made for.
    runtimeVersion: { policy: 'fingerprint' },
    // Updates aren't signed: expo-updates code signing needs a paid EAS plan, and Lee chose the free
    // one (2026-11-22). Whoever can publish to the EAS project can run code in every installed app on
    // that channel (README, Release setup, step 7).
    ...(EAS_PROJECT_ID ? { updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` } } : {}),
    ios: {
      bundleIdentifier: id,
      supportsTablet: false,
      // Preview and production sign in through a verified https link on www.konjir.com (a Universal
      // Link): the site's apple-app-site-association gives each bundle ID its own path. The auth
      // session's https callback also needs the webcredentials association for that domain.
      ...(variant !== 'development' ? { associatedDomains: [`applinks:${APP_LINK_HOST}`, `webcredentials:${APP_LINK_HOST}`] } : {}),
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
      // What the App Store's privacy details and Apple's required-reason APIs ask: no tracking; the
      // data konnect keeps is the person's own messages and identifiers, for the app's function;
      // and the reasons React Native and Expo's modules use the APIs Apple lists.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [
          { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
          { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeOtherUserContent', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
          { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeUserID', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
          { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        ],
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
        ],
      },
    },
    android: {
      package: id,
      // Preview's or production's own sign-in link, and only that one, verified (autoVerify) against
      // www.konjir.com's assetlinks.json.
      ...(variant !== 'development' ? {
        intentFilters: [{
          action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'],
          data: [{ scheme: 'https', host: APP_LINK_HOST, path: APP_LINK_PATH[variant] }],
        }],
      } : {}),
      adaptiveIcon: { foregroundImage: '../../brand/konjir-avatar.png', backgroundColor: PREDAWN_SURFACE },
    },
    plugins: [
      // iOS 17.4 is the first that completes an auth session on an https callback (a Universal
      // Link), which preview and production sign in with.
      ['expo-build-properties', { ios: { deploymentTarget: '17.4' } }],
      'expo-router',
      'expo-dev-client',
      'expo-web-browser',
      // Refresh tokens and client registrations; no Face ID prompt.
      ['expo-secure-store', { faceIDPermission: false }],
      'expo-sqlite',
      'expo-image',
      'expo-localization',
      // Push (phase 4): the notification's icon and colour on Android; iOS asks no usage string for it.
      ['expo-notifications', { color: PREDAWN_SURFACE }],
      ['expo-splash-screen', {
        image: '../../brand/konjir-avatar.png',
        imageWidth: 120,
        backgroundColor: DAYBREAK_SURFACE,
        dark: { image: '../../brand/konjir-avatar.png', backgroundColor: PREDAWN_SURFACE },
      }],
    ],
    experiments: { typedRoutes: true },
    extra: {
      variant,
      // The Kolab the app talks to until the person chooses another on the sign-in screen
      // (src/server.ts): Konjir's own. Only a development build's default can be pointed elsewhere
      // (KONNECT_URL), at a Kolab on this machine or the LAN.
      konnectUrl: (variant === 'development' ? process.env.KONNECT_URL : undefined) ?? 'https://kolab.konjir.com/mcp',
      ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
    },
  };
};
