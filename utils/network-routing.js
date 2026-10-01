/**
 * Network routing fix for search hosts that are unreachable on some networks.
 *
 * On some ISPs the DNS answer for duckduckgo.com points at a regional server that
 * never accepts connections, while DuckDuckGo's other servers work fine. Every search
 * then times out and every lead ends up "Uncertain".
 *
 * At startup we test the normal DNS answer first. Only if it cannot be reached do we
 * try DuckDuckGo's other published servers, and route the DuckDuckGo hostnames to the
 * first one that accepts a TLS connection. Nothing changes on networks where the
 * normal address already works.
 */

const dns = require('dns');
const net = require('net');
const { Agent, setGlobalDispatcher } = require('undici');

const DDG_HOSTS = ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'links.duckduckgo.com'];
const DDG_ALTERNATE_IPS = ['52.142.124.215', '40.114.177.156', '52.149.246.39', '20.43.161.105'];

const overrides = new Map(); // hostname -> ip
let readyPromise = null;

function canConnect(ip, port = 443, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function chooseDuckDuckGoRoute() {
  let systemIps = [];
  try {
    systemIps = (await dns.promises.lookup('html.duckduckgo.com', { all: true, family: 4 })).map(a => a.address);
  } catch (_) { /* fall through to alternates */ }

  for (const ip of systemIps) {
    if (await canConnect(ip)) return null; // normal route works, no override needed
  }
  for (const ip of DDG_ALTERNATE_IPS) {
    if (systemIps.includes(ip)) continue;
    if (await canConnect(ip)) return ip;
  }
  return null;
}

function routedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const ip = overrides.get(String(hostname).toLowerCase());
  if (!ip) return dns.lookup(hostname, options, callback);
  if (options && options.all) return callback(null, [{ address: ip, family: 4 }]);
  return callback(null, ip, 4);
}

/**
 * Probe once and install the routing. Safe to call many times.
 */
function ensureNetworkRouting() {
  if (!readyPromise) {
    readyPromise = (async () => {
      try {
        const ip = await chooseDuckDuckGoRoute();
        if (ip) {
          for (const h of DDG_HOSTS) overrides.set(h, ip);
          console.log(`[NetworkRouting] Default DuckDuckGo server unreachable on this network. Routing DuckDuckGo via ${ip}.`);
        }
      } catch (err) {
        console.warn('[NetworkRouting] Probe failed:', err.message);
      }
    })();
  }
  return readyPromise;
}

// All fetch() calls go through this dispatcher; hosts without an override resolve normally.
setGlobalDispatcher(new Agent({ connect: { lookup: routedLookup } }));

module.exports = { ensureNetworkRouting, getOverrides: () => Object.fromEntries(overrides) };
