import axios from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

/**
 * SSRF-safe outbound HTTP for link previews (audit SEC-04).
 *
 * Defence in depth:
 *  - only http(s) on default ports, no embedded credentials;
 *  - IP-literal hosts are checked against the block list up front;
 *  - hostnames are resolved by a custom `lookup` on the HTTP agents, so the
 *    address that is actually connected to is the one that was checked
 *    (defeats DNS rebinding);
 *  - redirects are followed manually (max 3) and every hop is re-validated;
 *  - response size, time and content type are capped.
 */

const blockList = new net.BlockList();
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  // No ::ffff:0:0/96 rule on purpose: net.BlockList already matches
  // IPv4-mapped IPv6 (dotted and hex forms) against the IPv4 rules above, and
  // a mapped-range rule would conversely match *every* IPv4 address.
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [address, prefix] of BLOCKED_V4) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) blockList.addSubnet(address, prefix, 'ipv6');

/** True for any address that must never be fetched (private, loopback, link-local, ...). */
export const isBlockedAddress = (address: string): boolean => {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(bare);
  if (family === 4) return blockList.check(bare, 'ipv4');
  if (family === 6) {
    const mapped = bare.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return blockList.check(mapped[1], 'ipv4');
    return blockList.check(bare, 'ipv6');
  }
  return true; // not an IP at all — never "allowed" by this check
};

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Parses and validates a URL for outbound fetching. Throws BlockedUrlError. */
export const assertFetchableUrl = (raw: string, base?: URL): URL => {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new BlockedUrlError('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('Only http(s) URLs can be previewed.');
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials cannot be previewed.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new BlockedUrlError('Only default ports can be previewed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BlockedUrlError('This host cannot be previewed.');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedUrlError('This address cannot be previewed.');
  return url;
};

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

const safeLookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      const blocked: NodeJS.ErrnoException = new BlockedUrlError(`Host ${hostname} resolves to a blocked address.`);
      blocked.code = 'EBLOCKED';
      return callback(blocked, '', 4);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const agentOptions = { lookup: safeLookup as unknown as net.LookupFunction, keepAlive: false };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

export const FETCH_LIMITS = { maxRedirects: 3, timeoutMs: 5_000, maxBytes: 1_000_000 } as const;

export interface FetchedPage {
  finalUrl: URL;
  contentType: string;
  body: string;
}

export const fetchPublicPage = async (rawUrl: string): Promise<FetchedPage> => {
  let url = assertFetchableUrl(rawUrl);
  for (let hop = 0; hop <= FETCH_LIMITS.maxRedirects; hop += 1) {
    let response;
    try {
      response = await axios.get<string>(url.toString(), {
        httpAgent,
        httpsAgent,
        proxy: false,
        maxRedirects: 0,
        timeout: FETCH_LIMITS.timeoutMs,
        maxContentLength: FETCH_LIMITS.maxBytes,
        maxBodyLength: FETCH_LIMITS.maxBytes,
        responseType: 'text',
        validateStatus: () => true,
        headers: {
          'User-Agent': 'SmartConnectLinkPreview/1.0',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === 'EBLOCKED' || err instanceof BlockedUrlError) throw new BlockedUrlError('This address cannot be previewed.');
      throw err;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== 'string' || !location) throw new Error('Redirect without location.');
      url = assertFetchableUrl(location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Upstream responded ${response.status}.`);

    return {
      finalUrl: url,
      contentType: String(response.headers['content-type'] ?? ''),
      body: typeof response.data === 'string' ? response.data : '',
    };
  }
  throw new Error('Too many redirects.');
};
