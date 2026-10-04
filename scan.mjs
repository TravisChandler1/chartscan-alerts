// Chartscan background scanner. Runs on GitHub Actions every 15 minutes.
// Reads patterns.json, checks the latest closed Binance candles, sends alerts through ntfy.
import fs from 'node:fs';

const PATTERNS = process.env.PATTERNS_PATH || 'patterns.json';
const STATE = process.env.STATE_PATH || 'state.json';
const TOPIC = (process.env.NTFY_TOPIC || '').trim();
const EMAIL = (process.env.ALERT_EMAIL || '').trim();
// data-api.binance.vision works from most cloud servers; api.binance.com is blocked in some regions (HTTP 451).
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com'];

// Same matching maths as the Chartscan web page.
function norm(cs) {
  const mn = Math.min(...cs.map(k => k.l)), mx = Math.max(...cs.map(k => k.h)), R = (mx - mn) || 1;
  return cs.map(k => [(k.o - mn) / R, (k.h - mn) / R, (k.l - mn) / R, (k.c - mn) / R]);
}
function sim(a, b) {
  const A = norm(a), B = norm(b);
  let d = 0, mis = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < 4; j++) d += Math.abs(A[i][j] - B[i][j]) / 4;
    if ((A[i][3] >= A[i][0]) !== (B[i][3] >= B[i][0])) mis++;
  }
  d = d / A.length + (mis / A.length) * 0.15;
  return Math.max(0, 1 - d / 0.25);
}

async function klines(symbol, interval, limit) {
  let last;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!r.ok) { last = new Error(`${host} returned ${r.status}`); continue; }
      const a = await r.json();
      return a.filter(k => k[6] < Date.now()).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    } catch (e) { last = e; }
  }
  throw last;
}

async function notify(msg) {
  if (!TOPIC) throw new Error('A match was found but the NTFY_TOPIC secret is not set.');
  const headers = { Title: 'Chartscan alert', Tags: 'chart_with_upwards_trend', Priority: 'high' };
  if (EMAIL) headers.Email = EMAIL;
  const r = await fetch('https://ntfy.sh/' + encodeURIComponent(TOPIC), { method: 'POST', body: msg, headers });
  if (!r.ok) throw new Error('ntfy returned ' + r.status);
}

async function main() {
  if (!fs.existsSync(PATTERNS)) { console.log('No patterns.json found.'); return; }
  const { patterns = [] } = JSON.parse(fs.readFileSync(PATTERNS, 'utf8'));
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8') || '{}') : {};
  let failed = null;

  for (const p of patterns) {
    try {
      const n = p.candles.length, symbol = p.symbol || 'SOLUSDT';
      const ks = await klines(symbol, p.interval, n + 30);
      if (ks.length < n) { console.log(`${p.name}: not enough candles yet.`); continue; }
      const prev = state[p.name];
      const from = prev === undefined ? ks.length - 1 : ks.findIndex(k => k.t > prev);
      const hits = [];
      if (from >= 0) {
        for (let i = Math.max(from, n - 1); i < ks.length; i++) {
          const s = sim(p.candles, ks.slice(i - n + 1, i + 1));
          if (s * 100 >= p.threshold) hits.push([s, ks[i].t]);
        }
      }
      console.log(`${p.name}: checked up to ${new Date(ks[ks.length - 1].t).toISOString()}, ${hits.length} match(es).`);
      for (const [s, t] of hits) {
        await notify(`${symbol} ${p.interval} matches "${p.name}" (${Math.round(s * 100)}%). Candle opened ${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC.`);
      }
      state[p.name] = ks[ks.length - 1].t;
    } catch (e) {
      console.error(`${p.name}: ${e.message}`);
      failed = e;
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  if (failed) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
