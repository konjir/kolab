import { afterEach, describe, expect, test } from '@jest/globals';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../app.config';
import { APP_LINK_HOST, APP_LINK_PATH } from '../src/auth/app-links';

// app.config.ts as `expo prebuild` evaluates it, once per variant.
const saved = process.env.APP_VARIANT;
afterEach(() => { if (saved === undefined) delete process.env.APP_VARIANT; else process.env.APP_VARIANT = saved; });
const configFor = (variant: string): ExpoConfig => {
  process.env.APP_VARIANT = variant;
  return appConfig({ config: {}, projectRoot: __dirname, staticConfig: null, packageJsonPath: null } as unknown as Parameters<typeof appConfig>[0]);
};

describe('the sign-in links each variant declares', () => {
  test('preview and production associate both applinks and webcredentials with www.konjir.com; development neither', () => {
    for (const variant of ['preview', 'production']) {
      expect(configFor(variant).ios?.associatedDomains).toEqual(['applinks:www.konjir.com', 'webcredentials:www.konjir.com']);
    }
    expect(configFor('development').ios?.associatedDomains).toBeUndefined();
  });

  test('each App Link filter names only its own variant\'s path, exactly', () => {
    const data = (variant: string) => configFor(variant).android?.intentFilters?.flatMap((f) => f.data ?? []);
    expect(data('production')).toEqual([{ scheme: 'https', host: 'www.konjir.com', path: '/konnect/app/oauth' }]);
    expect(data('preview')).toEqual([{ scheme: 'https', host: 'www.konjir.com', path: '/konnect/app/preview/oauth' }]);
    expect(configFor('development').android?.intentFilters).toBeUndefined();
    // The links the app signs in with are the ones declared.
    for (const variant of ['preview', 'production'] as const) {
      expect(data(variant)).toEqual([{ scheme: 'https', host: APP_LINK_HOST, path: APP_LINK_PATH[variant] }]);
    }
  });
});
