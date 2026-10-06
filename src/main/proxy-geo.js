const http = require('http');
const { Server } = require('proxy-chain');
const { normalizeProxyUrl } = require('./launcher');

// proxy-chain's 59x status codes for upstream failures.
const RELAY_ERRORS = {
  593: 'proxy host not found',
  594: 'proxy refused the connection',
  595: 'proxy reset the connection',
  597: 'proxy rejected the username/password',
  599: 'proxy error',
};

/**
 * Looks up where a proxy exits to the internet: public IP, country, city and
 * IANA timezone - as seen by websites. The request goes through the proxy
 * itself (via a short-lived local proxy-chain relay, which handles HTTP and
 * SOCKS upstreams with or without credentials), so it also verifies that the
 * proxy works.
 *
 * Uses ip-api.com (free tier: HTTP only, 45 requests/minute).
 */
async function lookupProxyGeo(proxy, { timeoutMs = 15000 } = {}) {
  const upstreamProxyUrl = normalizeProxyUrl(proxy);
  if (!upstreamProxyUrl) throw new Error('No proxy set');

  const relay = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: () => ({ upstreamProxyUrl }),
  });
  await relay.listen();
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: relay.port,
          path: 'http://ip-api.com/json/?fields=status,message,query,country,countryCode,city,timezone,lat,lon',
          headers: { Host: 'ip-api.com' },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () =>
            res.statusCode === 200
              ? resolve(data)
              : reject(new Error(RELAY_ERRORS[res.statusCode] || `proxy answered HTTP ${res.statusCode}`))
          );
        }
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
    });

    const geo = JSON.parse(body);
    if (geo.status !== 'success') throw new Error(`location lookup failed: ${geo.message || 'unknown error'}`);
    return {
      proxy,
      ip: geo.query,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      timezone: geo.timezone,
      lat: geo.lat,
      lon: geo.lon,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    throw new Error(`Proxy check failed: ${err.message}`);
  } finally {
    await relay.close(true);
  }
}

module.exports = { lookupProxyGeo };
