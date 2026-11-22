/**
 * In a dev bundle only: opens the route EXPO_PUBLIC_DEV_ROUTE names (`/dev/mcp`, say) once the app
 * has started, so a spike can run on a simulator with nobody to tap through iOS's "Open in" prompt
 * for a deep link. Metro inlines the variable when it bundles, so it is unset in every export.
 *
 *   EXPO_PUBLIC_DEV_ROUTE=/dev/mcp npx nx run @konjir/konnect-mobile:start
 */
import { router, type Href } from 'expo-router';
import { useEffect } from 'react';

export function DevStart() {
  const route = __DEV__ ? process.env.EXPO_PUBLIC_DEV_ROUTE : undefined;
  useEffect(() => {
    if (route) setTimeout(() => router.push(route as Href), 0);
  }, [route]);
  return null;
}
