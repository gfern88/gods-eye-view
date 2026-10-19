import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey } from '../server/providers/common/rate-limit.js';
import { admitSameSite } from '../server/providers/common/same-site.js';

const TUNNEL = '10.1.1.35';
const saved = process.env.GEV_TRUSTED_PROXIES;
afterEach(() => {
  if (saved === undefined) delete process.env.GEV_TRUSTED_PROXIES;
  else process.env.GEV_TRUSTED_PROXIES = saved;
});

const req = (peer, headers = {}) => ({
  socket: { remoteAddress: peer },
  headers,
});

function gate(request) {
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  return { refused: admitSameSite(request, res), res };
}

const proxied = {
  host: 'god.gf88.dev',
  origin: 'https://god.gf88.dev',
  'sec-fetch-site': 'same-origin',
  'x-forwarded-for': '9.9.9.9, 1.2.3.4',
  'x-forwarded-proto': 'https',
  'cf-connecting-ip': '5.6.7.8',
};

test('clientKey ignores forwarding headers without a trusted proxy', () => {
  delete process.env.GEV_TRUSTED_PROXIES;
  assert.equal(clientKey(req(TUNNEL, proxied)), TUNNEL);
});

test('clientKey takes the trusted proxy client, CF-Connecting-IP first', () => {
  process.env.GEV_TRUSTED_PROXIES = TUNNEL;
  assert.equal(clientKey(req(TUNNEL, proxied)), '5.6.7.8');
  assert.equal(
    clientKey(req(TUNNEL, { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })),
    '1.2.3.4',
  );
  assert.equal(
    clientKey(req(`::ffff:${TUNNEL}`, { 'cf-connecting-ip': '2001:db8::1' })),
    '2001:db8::1',
  );
});

test('clientKey falls back to the peer for junk or untrusted peers', () => {
  process.env.GEV_TRUSTED_PROXIES = TUNNEL;
  assert.equal(
    clientKey(req(TUNNEL, { 'x-forwarded-for': 'garbage' })),
    TUNNEL,
  );
  assert.equal(clientKey(req(TUNNEL)), TUNNEL);
  assert.equal(clientKey(req('10.1.1.99', proxied)), '10.1.1.99');
});

test('same-site gate refuses proxied requests unless the peer is trusted', () => {
  delete process.env.GEV_TRUSTED_PROXIES;
  assert.equal(gate(req(TUNNEL, proxied)).refused, true);
  process.env.GEV_TRUSTED_PROXIES = TUNNEL;
  assert.equal(gate(req(TUNNEL, proxied)).refused, false);
  assert.equal(gate(req('10.1.1.99', proxied)).refused, true);
});

test('trusted proxy still enforces Origin and Sec-Fetch-Site', () => {
  process.env.GEV_TRUSTED_PROXIES = TUNNEL;
  const crossOrigin = { ...proxied, origin: 'https://evil.example' };
  assert.equal(gate(req(TUNNEL, crossOrigin)).refused, true);
  const crossSite = { ...proxied, 'sec-fetch-site': 'cross-site' };
  assert.equal(gate(req(TUNNEL, crossSite)).refused, true);
  // Without X-Forwarded-Proto the socket scheme (http) no longer matches.
  const noProto = { ...proxied };
  delete noProto['x-forwarded-proto'];
  assert.equal(gate(req(TUNNEL, noProto)).refused, true);
});

test('loopback-only gates still refuse a trusted proxy', async () => {
  const { isLocalMcpRequest } = await import('../server/mcp/plugin.js');
  process.env.GEV_TRUSTED_PROXIES = '127.0.0.1';
  assert.equal(
    isLocalMcpRequest({
      remoteAddress: '127.0.0.1',
      localPort: 4173,
      host: 'localhost:4173',
      headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4' },
    }),
    false,
  );
});

test('trusted list tolerates spacing, case and mapped IPv4', () => {
  process.env.GEV_TRUSTED_PROXIES = ' 10.1.1.9 , ::FFFF:10.1.1.35';
  assert.equal(clientKey(req(TUNNEL, proxied)), '5.6.7.8');
  assert.equal(
    clientKey(
      req(TUNNEL, { 'cf-connecting-ip': 'junk', 'x-forwarded-for': '1.2.3.4' }),
    ),
    '1.2.3.4',
  );
});
