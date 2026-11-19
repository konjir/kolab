/**
 * `kolab login` and `kolab logout` (W3.4, D55). The OAuth client and its lock-file credentials
 * store live in @konjir/login, which the channel bridge shares (W3.5): both sign in alike, and one
 * sign-in, kept per MCP URL, serves both. The published kolab bundles it.
 */
export * from '@konjir/login';
