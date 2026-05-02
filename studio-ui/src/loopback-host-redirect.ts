/**
 * @simplewebauthn/browser maps some WebAuthn SecurityErrors using `isValidDomain()`, which only
 * accepts `localhost` or DNS-style names — not numeric loopback literals. That surfaces as
 * "127.0.0.1 is an invalid domain" even when the real issue is unrelated.
 *
 * WebAuthn rpID must match the page hostname, so we redirect IPv4/IPv6 loopback literals to
 * `localhost` (still hits a daemon bound to 127.0.0.1 on typical OS resolver setup).
 */
(function redirectIpLoopbackToLocalhost(): void {
  const { hostname } = window.location;
  if (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== '::1') return;
  try {
    const next = new URL(window.location.href);
    next.hostname = 'localhost';
    window.location.replace(next.toString());
  } catch {
    /* ignore */
  }
})();
