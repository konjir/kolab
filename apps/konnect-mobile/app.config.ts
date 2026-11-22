/**
 * konnect's native configuration, all of it: `ios/` and `android/` are generated from this by
 * `expo prebuild` (Continuous Native Generation) and never committed.
 *
 * APP_VARIANT picks one of three apps that install side by side, each with its own name, bundle
 * ID, package and URL scheme: `development` (the default, a dev client), `preview` (internal
 * testers) and `production` (the stores). eas.json sets it for each build profile.
 */
import path from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The EAS project and the Expo account that owns it. Unset until Lee makes the Expo organization
 * `konjir` and links the project (`npx eas init` in this folder, which writes both here). Until
 * then the EAS targets say the project isn't linked and stop (scripts/eas.mjs), and builds have no
 * over-the-air update URL. Both are public identifiers, not secrets.
 */
const EAS_PROJECT_ID: string | undefined = undefined;
const EAS_OWNER: string | undefined = undefined;

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

/** Predawn's surface (libs/brand), the splash screen's and the launch background in dark mode. */
const PREDAWN_SURFACE = '#16140f';
/** Daybreak's surface (libs/brand), in light mode. */
const DAYBREAK_SURFACE = '#f8f2d6';

/**
 * A font file of an @expo-google-fonts package, wherever npm put it, relative to this folder: a
 * path that is the same on every machine, so the fingerprint is too.
 */
const font = (pkg: string, file: string) => {
  const dir = path.dirname(require.resolve(`@expo-google-fonts/${pkg}/package.json`));
  return path.relative(__dirname, path.join(dir, file.slice(file.indexOf('_') + 1, -'.ttf'.length), file));
};
/** The brand's three faces (libs/brand FONTS), in the weights the app uses, embedded at build time. */
const FACES = [
  { family: 'Fraunces', pkg: 'fraunces', weights: { 400: 'Fraunces_400Regular.ttf', 600: 'Fraunces_600SemiBold.ttf' } },
  { family: 'Instrument Sans', pkg: 'instrument-sans', weights: { 400: 'InstrumentSans_400Regular.ttf', 500: 'InstrumentSans_500Medium.ttf', 600: 'InstrumentSans_600SemiBold.ttf', 700: 'InstrumentSans_700Bold.ttf' } },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', weights: { 400: 'JetBrainsMono_400Regular.ttf', 500: 'JetBrainsMono_500Medium.ttf' } },
] as const;

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantOf(process.env);
  const { id, name } = identity(variant);
  return {
    ...config,
    name,
    slug: 'konnect',
    version: '0.1.0',
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
    ...(EAS_PROJECT_ID ? { updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` } } : {}),
    ios: {
      bundleIdentifier: id,
      supportsTablet: false,
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
      // What the App Store's privacy details and Apple's required-reason APIs ask: no tracking; the
      // data konnect keeps is the person's own messages and identifiers, for the app's function;
      // and the reasons React Native and Expo's modules use the APIs Apple lists.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [
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
      adaptiveIcon: { foregroundImage: '../../brand/konjir-avatar.png', backgroundColor: PREDAWN_SURFACE },
    },
    plugins: [
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
      ['expo-font', {
        ios: { fonts: FACES.flatMap((f) => Object.values(f.weights).map((file) => font(f.pkg, file))) },
        android: {
          fonts: FACES.map((f) => ({
            fontFamily: f.family,
            fontDefinitions: Object.entries(f.weights).map(([weight, file]) => ({ path: font(f.pkg, file), weight: Number(weight) })),
          })),
        },
      }],
    ],
    experiments: { typedRoutes: true },
    extra: {
      variant,
      // Kolab's MCP endpoint. A dev build can be pointed at a Kolab on this machine or the LAN.
      konnectUrl: process.env.KONNECT_URL ?? 'https://kolab.konjir.com/mcp',
      ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
    },
  };
};
