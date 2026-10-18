import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * The built web interface (apps/web's dist/), as the server finds it: @konjir/web's package, a
 * workspace of this repository. Null when it can't be found.
 */
export function defaultWebRoot(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@konjir/web/package.json')), 'dist');
  } catch {
    return null;
  }
}

/** Kolab's own routes, which the page never shadows. */
const OWN = /^\/(api|mcp|healthz)(\/|$)/;

/**
 * The page's security headers. Scripts, styles and connections are Kolab's own; the fonts come
 * from Google Fonts, as the design system loads them.
 */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');

function secure(res: Response) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
}

/**
 * Serves the web interface (API8) at the root: its files, and index.html for any other page the
 * single-page app routes (GET, asking for HTML, with no file extension), but never /api, /mcp or /healthz. Vite names each
 * asset by its content hash, so assets are cached for a year and index.html not at all. With no
 * build, the root says how to make one.
 */
export function webApp(root: string | null) {
  const index = root ? join(root, 'index.html') : null;
  const files = root ? express.static(root, {
    index: false, fallthrough: true, redirect: false,
    setHeaders: (res, path) => {
      secure(res as unknown as Response);
      res.setHeader('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || OWN.test(req.path)) return next();
    const root = req.path === '/' || req.path === '/index.html';
    const page = () => {
      // A missing file (a name with an extension) is a 404, never the page.
      if ((!root && /\.[A-Za-z0-9]+$/.test(req.path)) || !req.accepts('html')) return next();
      secure(res);
      res.setHeader('cache-control', 'no-cache');
      if (index && existsSync(index)) return res.sendFile(index);
      res.status(503).type('text/plain').send('The Kolab web interface is not built. Run `npx nx run @konjir/web:build` in the Kolab checkout, then reload.\n');
    };
    if (!files || root) return page();
    files(req, res, (err?: unknown) => (err ? next(err) : page()));
  };
}
