const SHARE = 'https://1drv.ms/x/c/c55dffc6b8cf503a/IQCcJqztGhfcSI54_fUf1J7xAdQQXuKZhgTsDajsiRHUh8c?e=QawT7R';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

function addCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const raw of list) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Walks redirects by hand, re-attaching the accumulated cookies and the
 * browser User-Agent on EVERY hop.
 *
 * Both are mandatory and for different reasons: without a browser UA the
 * endpoint answers 403; with a UA but no FedAuth cookie it answers 200 with the
 * HTML viewer page instead of the file. fetch() cannot be left to follow
 * redirects itself, because it drops Cookie when the redirect crosses origin
 * (1drv.ms → onedrive.live.com), which is exactly where the cookie is needed.
 */
async function walk(startUrl, jar, label) {
  let url = startUrl;
  let res;
  for (let i = 0; i < 10; i++) {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
    });
    addCookies(jar, res);
    const loc = res.headers.get('location');
    console.log(`  ${label} hop ${i + 1}: ${res.status}${loc ? ' →' : ''}`);
    if (!loc) return res;
    url = new URL(loc, url).toString();
  }
  return res;
}

const jar = new Map();
console.log('1. redeem the sharing link (mints FedAuth):');
await walk(SHARE, jar, 'redeem');
console.log('   cookies:', [...jar.keys()].join(', '));

console.log('2. download with cookies + UA on every hop:');
const dl = SHARE + (SHARE.includes('?') ? '&' : '?') + 'download=1';
const res = await walk(dl, jar, 'download');
const buf = new Uint8Array(await res.arrayBuffer());
const magic = [...buf.slice(0, 2)].map((b) => b.toString(16).padStart(2, '0')).join('');
console.log('\nresult:', JSON.stringify({ status: res.status, type: res.headers.get('content-type'), size: buf.length, magic }, null, 1));
console.log(magic === '504b' ? '\n✅ valid .xlsx — Worker algorithm works' : '\n❌ not an xlsx');
