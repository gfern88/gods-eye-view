import { isIP } from 'node:net';

/**
 * Operator-declared reverse proxies (GEV_TRUSTED_PROXIES: comma-separated
 * exact IPs, e.g. a Cloudflare tunnel connector on a private Docker network).
 * Forwarding headers are client-controlled unless the socket peer is one of
 * these, so every helper here falls back to the socket when it is not.
 * Loopback-only gates (Provider Settings, /mcp, ChatGPT OAuth) never consult
 * this module: a proxied request is still not a local one.
 *
 * Read per call so a restarted server's loadEnv() value applies.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function fromTrustedProxy(req) {
  const normalize = (ip) =>
    String(ip || '')
      .trim()
      .toLowerCase()
      .replace(/^::ffff:/, '');
  const peer = normalize(req.socket?.remoteAddress);
  if (!peer) return false;
  return String(process.env.GEV_TRUSTED_PROXIES || '')
    .split(',')
    .map(normalize)
    .includes(peer);
}

/**
 * The client address a trusted proxy reports: CF-Connecting-IP (one value the
 * edge sets itself), else the last X-Forwarded-For entry (the one the proxy
 * appended). Null when the peer is not trusted or reports nothing usable.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function forwardedClient(req) {
  if (!fromTrustedProxy(req)) return null;
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean)
    .pop();
  const candidates = [
    String(req.headers?.['cf-connecting-ip'] || '').trim(),
    forwarded,
  ];
  return candidates.find((ip) => ip && isIP(ip)) || null;
}

/**
 * The scheme the browser used: X-Forwarded-Proto from a trusted proxy (TLS
 * ends at the edge), else the socket's own.
 * @param {import('node:http').IncomingMessage} req
 * @returns {'http:'|'https:'}
 */
export function requestProtocol(req) {
  if (fromTrustedProxy(req)) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (proto === 'https' || proto === 'http') return `${proto}:`;
  }
  return req.socket?.encrypted ? 'https:' : 'http:';
}
