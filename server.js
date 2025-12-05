// server.js
const express = require('express');
const fetch = require('node-fetch'); // node-fetch@2
const { AbortController } = require('abort-controller');
const { HttpsProxyAgent } = require('https-proxy-agent');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 可选外发代理（例如 Fixie/QuotaGuard），格式示例:
// http://username:password@proxy-host:3128  或  http://proxy-host:3128
const OUTBOUND_PROXY = process.env.OUTBOUND_PROXY || null;
let proxyAgent = null;
if (OUTBOUND_PROXY) {
  try {
    proxyAgent = new HttpsProxyAgent(OUTBOUND_PROXY);
    console.log('Using outbound proxy:', OUTBOUND_PROXY);
  } catch (e) {
    console.warn('Failed to create proxy agent from OUTBOUND_PROXY:', e && e.message);
    proxyAgent = null;
  }
}

// 简单内存缓存
const cache = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = 8 * 1000; // 缓存 8 秒（可按需调大）

// 简单速率限制（每 IP 每分钟）
const rateMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 300;

// 公共代理回退（仅作最后手段）
const PROXY_WRAPPERS = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://r.jina.ai/http://` + url.replace(/^https?:\/\//,''),
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`
];

// fetch with timeout and optional agent
async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const finalOpts = { ...opts, signal: controller.signal };
    if (proxyAgent) finalOpts.agent = proxyAgent;
    const res = await fetch(url, finalOpts);
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > RATE_LIMIT_WINDOW_MS) {
    rec.ts = now;
    rec.count = 1;
  } else {
    rec.count++;
  }
  rateMap.set(ip, rec);
  return rec.count <= RATE_LIMIT_MAX;
}

// 通用获取：缓存 -> 直接请求 -> 公共代理回退
async function getJsonWithFallback(url) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }

  // 1) 直接请求（若 OUTBOUND_PROXY 存在，会走代理）
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'crypto-proxy' } }, 8000);
    if (res && res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let data;
      if (ct.includes('application/json') || ct.includes('text/json')) {
        data = await res.json();
      } else {
        const txt = await res.text();
        try { data = JSON.parse(txt); } catch(e){ data = txt; }
      }
      cache.set(url, { ts: Date.now(), data });
      return data;
    }
  } catch (e) {
    console.warn('direct fetch failed', e && e.message);
  }

  // 2) 公共代理回退（最后手段）
  for (const wrap of PROXY_WRAPPERS) {
    const proxyUrl = wrap(url);
    try {
      const res = await fetchWithTimeout(proxyUrl, {}, 10000);
      if (!res || !res.ok) continue;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let data = null;
      if (ct.includes('application/json') || ct.includes('text/json')) {
        data = await res.json();
      } else {
        const txt = await res.text();
        try {
          const maybe = JSON.parse(txt);
          if (maybe && maybe.contents) {
            try { data = JSON.parse(maybe.contents); } catch(e){ data = maybe.contents; }
          } else {
            try { data = JSON.parse(txt); } catch(e){ data = txt; }
          }
        } catch(e){
          data = txt;
        }
      }
      cache.set(url, { ts: Date.now(), data });
      return data;
    } catch (e) {
      console.warn('proxy fetch failed', proxyUrl, e && e.message);
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
  }

  throw new Error('all fetch attempts failed');
}

// CORS & basic middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // 开发时方便，生产请限制域名
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// health
app.get('/', (req, res) => res.send('🚀 Crypto Proxy is Online'));

// Binance funding rates (unchanged)
app.get('/proxy/binance', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'rate limit exceeded' });
  const url = 'https://fapi.binance.com/fapi/v1/premiumIndex';
  try {
    const data = await getJsonWithFallback(url);
    if (!Array.isArray(data)) {
      return res.status(502).json({ error: 'unexpected response from binance', raw: data });
    }
    return res.json(data);
  } catch (e) {
    console.error('/proxy/binance error', e && e.message);
    return res.status(502).json({ error: 'proxy error', detail: e && e.message });
  }
});

// helper: 并发限制的批量执行器
async function mapWithConcurrency(items, worker, concurrency = 6) {
  const results = [];
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e && e.message ? e.message : String(e) };
      }
    }
  };
  const runners = [];
  for (let j = 0; j < Math.min(concurrency, items.length); j++) runners.push(run());
  await Promise.all(runners);
  return results;
}

// OKX funding rates: 先拿 instruments，再分批请求 funding-rate
app.get('/proxy/okx', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'rate limit exceeded' });

  try {
    // 1) instruments 列表
    const instUrl = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
    const instRaw = await getJsonWithFallback(instUrl);
    const instList = Array.isArray(instRaw) ? instRaw : (instRaw && Array.isArray(instRaw.data) ? instRaw.data : null);
    if (!instList || instList.length === 0) {
      return res.status(502).json({ error: 'failed to fetch okx instruments', raw: instRaw });
    }

    // 提取 instId（去重）
    const instIds = Array.from(new Set(instList.map(it => it.instId || it.inst_id || it.inst || '').filter(Boolean)));
    if (instIds.length === 0) {
      return res.status(502).json({ error: 'no instId found in okx instruments', raw: instList });
    }

    // 2) 分批并发请求每个 instId 的 funding-rate
    const fundingBase = 'https://www.okx.com/api/v5/public/funding-rate?instId=';
    const results = await mapWithConcurrency(instIds, async (instId) => {
      const url = fundingBase + encodeURIComponent(instId);
      try {
        const r = await getJsonWithFallback(url);
        if (Array.isArray(r)) return { instId, raw: r };
        if (r && Array.isArray(r.data)) return { instId, raw: r.data };
        if (r && r.contents) {
          try {
            const parsed = JSON.parse(r.contents);
            if (Array.isArray(parsed)) return { instId, raw: parsed };
            if (parsed && Array.isArray(parsed.data)) return { instId, raw: parsed.data };
          } catch(e){}
        }
        return { instId, raw: r };
      } catch (e) {
        return { instId, error: e && e.message ? e.message : String(e) };
      }
    }, 6); // 并发数可调

    // 3) 合并结果
    const merged = [];
    for (const item of results) {
      if (item && item.raw && Array.isArray(item.raw)) {
        item.raw.forEach(r => {
          if (!r.instId && !r.inst_id && item.instId) r.instId = item.instId;
          merged.push(r);
        });
      }
    }

    if (merged.length === 0) {
      return res.status(502).json({ error: 'no funding-rate data collected', details: results.slice(0, 20) });
    }

    // 缓存合并结果（可按需改 key）
    cache.set('okx_funding_all', { ts: Date.now(), data: merged });

    return res.json({ data: merged });
  } catch (e) {
    console.error('/proxy/okx error', e && e.message);
    return res.status(502).json({ error: 'proxy error', detail: e && e.message });
  }
});

// serve frontend from public/
app.use(express.static(path.join(__dirname, 'public')));

// start
app.listen(PORT, () => console.log(`✅ Crypto proxy running on port ${PORT}`));
