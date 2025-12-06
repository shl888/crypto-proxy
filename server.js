// server.js
const express = require('express');
const fetch = require('node-fetch'); // node-fetch@2
const { AbortController } = require('abort-controller');
const { HttpsProxyAgent } = require('https-proxy-agent');
const compression = require('compression');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 配置区域 ==========
const CONFIG = {
  // 缓存时间 (ms)
  CACHE_TTL_BINANCE: 6000,
  CACHE_TTL_OKX: 60000,      // 60s，避免频繁全量抓取
  CACHE_TTL_GENERAL: 10000,

  // 请求超时
  TIMEOUT_DIRECT: 7000,
  TIMEOUT_PROXY: 10000,
  TIMEOUT_SHORT: 10000,       // 短请求超时 10s

  // 并发限制
  CONCURRENCY_LIMIT: 4,      // 全局并发上限（影响 OKX perBatch）
  OKX_BATCH_SIZE: 0,         // 0 表示不限制，尝试抓取全部合约

  // 重试策略
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,

  // 速率限制
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: 600,
  RATE_LIMIT_PER_IP: 100,

  // 数据源优先
  SOURCE_PRIORITY: {
    binance: ['direct', 'proxy1', 'proxy2', 'proxy3'],
    okx: ['direct', 'proxy1', 'proxy2']
  },

  // 监控
  HEALTH_CHECK_INTERVAL: 30000,
  CLEANUP_INTERVAL: 300000
};

// ========== 代理配置 ==========
const OUTBOUND_PROXY = process.env.OUTBOUND_PROXY || null;
let proxyAgent = null;
if (OUTBOUND_PROXY) {
  try {
    proxyAgent = new HttpsProxyAgent(OUTBOUND_PROXY);
    console.log('✅ 使用外发代理:', OUTBOUND_PROXY.replace(/:[^:]*@/, ':****@'));
  } catch (e) {
    console.warn('⚠️ 代理创建失败:', e?.message);
    proxyAgent = null;
  }
}

const PROXY_SOURCES = {
  direct: { url: url => url, priority: 0, lastSuccess: Date.now(), failures: 0 },
  proxy1: { url: url => `https://corsproxy.io/?${encodeURIComponent(url)}`, priority: 1, lastSuccess: Date.now(), failures: 0 },
  proxy2: { url: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, priority: 2, lastSuccess: Date.now(), failures: 0 },
  proxy3: { url: url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`, priority: 3, lastSuccess: Date.now(), failures: 0 },
  proxy4: { url: url => `https://thingproxy.freeboard.io/fetch/${url}`, priority: 4, lastSuccess: Date.now(), failures: 0 }
};

function getAvailableSources(type = 'binance') {
  const baseOrder = CONFIG.SOURCE_PRIORITY[type] || ['direct', 'proxy1', 'proxy2'];
  return [...baseOrder]
    .filter(s => PROXY_SOURCES[s])
    .sort((a, b) => {
      const A = PROXY_SOURCES[a], B = PROXY_SOURCES[b];
      const successDiff = (Date.now() - A.lastSuccess) - (Date.now() - B.lastSuccess);
      const failureDiff = A.failures - B.failures;
      return failureDiff || successDiff;
    });
}

// ========== 智能缓存 ==========
class SmartCache {
  constructor() {
    this.store = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }
  set(key, data, ttl = CONFIG.CACHE_TTL_GENERAL, metadata = {}) {
    this.store.set(key, { data, expiry: Date.now() + ttl, timestamp: Date.now(), metadata: { source: metadata.source || 'unknown', size: JSON.stringify(data).length, ...metadata } });
    if (this.store.size > 200) this.cleanup();
  }
  get(key) {
    const item = this.store.get(key);
    if (!item) { this.stats.misses++; return null; }
    if (Date.now() > item.expiry) { this.store.delete(key); this.stats.misses++; return null; }
    this.stats.hits++;
    return { data: item.data, metadata: item.metadata, age: Date.now() - item.timestamp, expiresIn: item.expiry - Date.now() };
  }
  peek(key) { const item = this.store.get(key); return item ? item.data : null; }
  cleanup() {
    const now = Date.now(); let evicted = 0;
    for (const [k, v] of this.store.entries()) { if (now > v.expiry) { this.store.delete(k); evicted++; } }
    this.stats.evictions += evicted; return evicted;
  }
  getStats() { return { ...this.stats, size: this.store.size, hitRate: this.stats.hits / (this.stats.hits + this.stats.misses || 1) }; }
  get size() { return this.store.size; }
}
const cache = new SmartCache();

// ========== 限流 ==========
class SmartRateLimiter {
  constructor() { this.store = new Map(); this.global = { count: 0, startTime: Date.now() }; }
  check(ip) {
    const now = Date.now();
    if (now - this.global.startTime > CONFIG.RATE_LIMIT_WINDOW_MS) { this.global.count = 1; this.global.startTime = now; } else this.global.count++;
    if (this.global.count > CONFIG.RATE_LIMIT_MAX) return false;
    if (ip && ip !== 'unknown') {
      const record = this.store.get(ip) || { count: 0, startTime: now, blocked: false };
      if (record.blocked) { if (now - record.startTime > 60000) { record.count = 1; record.startTime = now; record.blocked = false; } else return false; }
      if (now - record.startTime > CONFIG.RATE_LIMIT_WINDOW_MS) { record.count = 1; record.startTime = now; } else record.count++;
      if (record.count > CONFIG.RATE_LIMIT_PER_IP) { record.blocked = true; record.startTime = now; }
      this.store.set(ip, record);
    }
    return true;
  }
  cleanup() { const now = Date.now(); for (const [ip, r] of this.store.entries()) if (now - r.startTime > CONFIG.RATE_LIMIT_WINDOW_MS * 10) this.store.delete(ip); }
  getStats() { return { globalCount: this.global.count, activeIPs: this.store.size, blockedIPs: Array.from(this.store.values()).filter(r => r.blocked).length }; }
}
const rateLimiter = new SmartRateLimiter();

// ========== 监控 ==========
const metrics = { requests: { total: 0, success: 0, failed: 0 }, responseTimes: [], sources: {}, errors: [] };
function recordMetric(type, value) {
  if (!metrics[type]) metrics[type] = { count: 0, sum: 0 };
  metrics[type].count++; metrics[type].sum += value;
  if (type === 'responseTimes') { metrics.responseTimes.push({ timestamp: Date.now(), value }); if (metrics.responseTimes.length > 200) metrics.responseTimes.shift(); }
}
function recordSourceUsage(source, success) {
  if (!metrics.sources[source]) metrics.sources[source] = { requests: 0, successes: 0, failures: 0 };
  metrics.sources[source].requests++; if (success) metrics.sources[source].successes++; else metrics.sources[source].failures++;
}

// ========== 智能重试 fetch ==========
async function smartFetch(url, options = {}, context = {}) {
  const maxRetries = options.maxRetries || CONFIG.MAX_RETRIES;
  const timeout = options.timeout || CONFIG.TIMEOUT_DIRECT;
  const isProxy = options.isProxy || false;
  const source = context.source || 'direct';
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const fetchOptions = { ...options, signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...options.headers } };
      if (proxyAgent && !isProxy) fetchOptions.agent = proxyAgent;
      const start = Date.now();
      const response = await fetch(url, fetchOptions);
      const rt = Date.now() - start;
      clearTimeout(timeoutId);
      recordMetric('responseTimes', rt);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      recordSourceUsage(source, true);
      if (PROXY_SOURCES[source]) { PROXY_SOURCES[source].lastSuccess = Date.now(); PROXY_SOURCES[source].failures = Math.max(0, PROXY_SOURCES[source].failures - 1); }
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt === maxRetries) { recordSourceUsage(source, false); if (PROXY_SOURCES[source]) PROXY_SOURCES[source].failures++; }
      if (attempt < maxRetries) { const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt); await new Promise(r => setTimeout(r, delay)); continue; }
    }
  }
  throw lastError || new Error('Fetch failed after retries');
}

// ========== 归一化工具 ==========
function toMsTimestamp(val) {
  if (val == null) return null;
  const n = Number(val);
  if (Number.isFinite(n)) { if (n > 1e12) return n; if (n > 1e9) return n * 1000; }
  const d = new Date(String(val));
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function normalizeBinanceArray(data, sourceLabel = 'binance') {
  if (!Array.isArray(data)) return [];
  return data.map(item => {
    const symbol = String(item.symbol || item.s || '').trim();
    const lastFundingRateRaw = item.lastFundingRate ?? item.lastFundingRateStr ?? item.fundingRate ?? item.funding_rate ?? null;
    const lastFundingRate = lastFundingRateRaw != null ? parseFloat(lastFundingRateRaw) : null;
    const nextFundingTime = toMsTimestamp(item.nextFundingTime ?? item.nextFundingTimeMs ?? item.nextFundingTimeStamp ?? item.nextFundingTimeUtc ?? null);
    const lastFundingTime = toMsTimestamp(item.time ?? item.lastFundingTime ?? item.lastFundingTimeMs ?? null);
    return { symbol, source: sourceLabel, lastFundingRate: Number.isFinite(lastFundingRate) ? lastFundingRate : null, nextFundingTime, lastFundingTime, markPrice: item.markPrice ?? item.lastPrice ?? null, raw: item };
  }).filter(x => x.symbol && /USDT$/i.test(x.symbol));
}

function normalizeOkxArray(items, sourceLabel = 'okx') {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    const instId = item.instId || item.inst_id || item.inst || item.instrumentId || item.instrument_id || item.symbol;
    const symbolBase = instId ? String(instId).replace(/-USDT-?SWAP$/i,'').replace(/-SWAP$/i,'').replace(/USDT$/i,'').replace(/_USDT$/i,'').trim() : null;
    const symbol = symbolBase ? (symbolBase + 'USDT') : null;
    const lastFundingRateRaw = item.fundingRate ?? item.lastFundingRate ?? item.funding_rate ?? item.fundingRate24h ?? item.lastFundingRateStr ?? item.rate ?? null;
    const lastFundingRate = lastFundingRateRaw != null ? parseFloat(lastFundingRateRaw) : null;
    const nextFundingTime = toMsTimestamp(item.nextFundingTime ?? item.nextFundingTimeUTC ?? item.nextFundingTimeMs ?? item.nextFundingTimeStamp ?? item.nextFundingTimeUtc ?? item.nextFunding ?? null);
    const lastFundingTime = toMsTimestamp(item.fundingTime ?? item.fundingTimeUTC ?? item.fundingTimeMs ?? item.fundingTimeStamp ?? item.lastFundingTime ?? item.lastFunding ?? null);
    return { symbol, source: sourceLabel, lastFundingRate: Number.isFinite(lastFundingRate) ? lastFundingRate : null, nextFundingTime, lastFundingTime, raw: item };
  }).filter(x => x.symbol);
}

// 统一 symbol 规范：返回形如 "BTCUSDT"
function normalizeSymbolToUSDT(rawSymbol) {
  if (!rawSymbol) return null;
  let s = String(rawSymbol).toUpperCase().trim();
  s = s.replace(/[-_]?UM[-_]?SWAP$/i, '');
  s = s.replace(/[-_]?USD[-_]?SWAP$/i, '');
  s = s.replace(/[-_]?SWAP$/i, '');
  s = s.replace(/[-_]?USDT$/i, 'USDT');
  s = s.replace(/[-_]/g, '');
  if (/USDT$/.test(s)) return s;
  if (/USD$/.test(s)) return s.replace(/USD$/, 'USDT');
  return s + 'USDT';
}

// 去重：优先保留 okx > binance > binance_backup > proxy
function dedupeNormalizedArray(arr) {
  const priority = { okx: 3, binance: 2, binance_backup: 1, proxy: 0 };
  const map = new Map();
  for (const it of arr) {
    if (!it || !it.symbol) continue;
    const sym = normalizeSymbolToUSDT(it.symbol);
    if (!sym) continue;
    it.symbol = sym;
    const existing = map.get(sym);
    if (!existing) map.set(sym, it);
    else {
      const p1 = priority[existing.source] || 0;
      const p2 = priority[it.source] || 0;
      if (p2 > p1) map.set(sym, it);
    }
  }
  return Array.from(map.values());
}

// ====== 调试摘要（最近一次抓取统计） ======
const lastFetchSummary = { okx: null, binance: null };

// ========== 数据获取函数（归一化输出） ==========
async function getBinanceData() {
  const cacheKey = 'binance_premiumIndex';
  const cached = cache.get(cacheKey);
  if (cached) { console.log(`📦 Binance缓存命中 (${cached.expiresIn}ms后过期)`); return cached.data; }

  const url = 'https://fapi.binance.com/fapi/v1/premiumIndex';
  const sources = getAvailableSources('binance');

  for (const source of sources) {
    try {
      console.log(`🔗 尝试 [${source}] 获取Binance数据...`);
      const targetUrl = PROXY_SOURCES[source].url(url);
      const isProxy = source !== 'direct';
      const response = await smartFetch(targetUrl, { timeout: isProxy ? CONFIG.TIMEOUT_PROXY : CONFIG.TIMEOUT_DIRECT, isProxy }, { source });
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) { console.warn(`⚠️ [${source}]: 数据格式无效`); continue; }
      const normalized = normalizeBinanceArray(data, source);
      if (normalized.length === 0) { console.warn(`⚠️ [${source}]: 无有效归一化数据`); continue; }

      // 更新调试摘要
      lastFetchSummary.binance = {
        requested: data.length,
        fetched: data.length,
        normalized: normalized.length,
        timestamp: Date.now(),
        sample: normalized.slice(0, 6).map(x => ({ symbol: x.symbol, lastFundingRate: x.lastFundingRate, nextFundingTime: x.nextFundingTime }))
      };

      console.log(`✅ [${source}]: 成功获取 ${normalized.length} 个交易对（归一化）`);
      cache.set(cacheKey, normalized, CONFIG.CACHE_TTL_BINANCE, { source, count: normalized.length, timestamp: new Date().toISOString() });
      return normalized;
    } catch (error) {
      console.warn(`❌ [${source}] 失败:`, error.message);
    }
  }

  // 备用：24hr ticker（标注 backup）
  try {
    console.log('🚨 尝试紧急备用源...');
    const backupUrl = 'https://api.binance.com/api/v3/ticker/24hr';
    const response = await smartFetch(backupUrl, { timeout: CONFIG.TIMEOUT_SHORT });
    const backupData = await response.json();
    const formattedData = Array.isArray(backupData) ? backupData.slice(0, 200).map(item => ({
      symbol: String(item.symbol || '').trim(),
      source: 'binance_backup',
      lastFundingRate: null,
      nextFundingTime: null,
      lastFundingTime: null,
      markPrice: item.lastPrice ?? null,
      raw: item
    })).filter(x => x.symbol && /USDT$/i.test(x.symbol)) : [];

    // 更新调试摘要（backup）
    lastFetchSummary.binance = {
      requested: backupData.length || formattedData.length,
      fetched: backupData.length || formattedData.length,
      normalized: formattedData.length,
      timestamp: Date.now(),
      sample: formattedData.slice(0,6).map(x => ({ symbol: x.symbol, lastFundingRate: x.lastFundingRate }))
    };

    if (formattedData.length > 0) {
      cache.set(cacheKey, formattedData, CONFIG.CACHE_TTL_BINANCE, { source: 'backup', warning: '使用备用数据源' });
      return formattedData;
    }
  } catch (error) {
    console.error('🚨 紧急备用也失败:', error.message);
  }

  throw new Error('所有数据源均失败');
}

async function getOKXData() {
  const cacheKey = 'okx_funding_all';
  const cached = cache.get(cacheKey);
  if (cached) { console.log(`📦 OKX缓存命中 (${cached.expiresIn}ms后过期)`); return cached.data; }

  try {
    console.log('🔗 获取OKX合约列表...');
    const instUrl = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
    let instData;
    for (const source of getAvailableSources('okx')) {
      try {
        const targetUrl = PROXY_SOURCES[source].url(instUrl);
        const isProxy = source !== 'direct';
        const response = await smartFetch(targetUrl, { timeout: isProxy ? CONFIG.TIMEOUT_PROXY : CONFIG.TIMEOUT_DIRECT, isProxy }, { source });
        instData = await response.json();
        console.log(`✅ [${source}]: OKX合约列表成功`);
        break;
      } catch (error) {
        console.warn(`❌ [${source}]: OKX合约列表失败`);
      }
    }
    if (!instData) throw new Error('无法获取OKX合约列表');
    const instList = Array.isArray(instData) ? instData : (instData?.data || []);
    if (instList.length === 0) throw new Error('OKX合约列表为空');

    // 决定要抓取多少 instId：0 表示全部
    const maxToFetch = (CONFIG.OKX_BATCH_SIZE && CONFIG.OKX_BATCH_SIZE > 0) ? CONFIG.OKX_BATCH_SIZE : instList.length;
    const instIds = [...new Set(instList
      .filter(it => (it.instId || it.inst_id || it.inst || it.instrumentId || it.instrument_id))
      .map(it => it.instId || it.inst_id || it.inst || it.instrumentId || it.instrument_id)
    )].slice(0, maxToFetch);

    console.log(`📊 计划请求 ${instIds.length} 个OKX instId 的 funding-rate（分批处理）`);

    // 分批并发参数（可调）
    const perBatch = Math.min(CONFIG.CONCURRENCY_LIMIT || 4, 6); // 每批并发数
    const interBatchDelay = 500; // 毫秒，批与批之间的延迟
    const perRequestRetry = 2; // 单请求重试次数

    const fundingResults = [];

    for (let i = 0; i < instIds.length; i += perBatch) {
      const batch = instIds.slice(i, i + perBatch);
      const promises = batch.map(async (instId, idx) => {
        if (idx > 0) await new Promise(r => setTimeout(r, idx * 20));
        let lastErr = null;
        for (let attempt = 0; attempt <= perRequestRetry; attempt++) {
          try {
            for (const source of getAvailableSources('okx')) {
              try {
                const fundingUrl = `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`;
                const targetUrl = PROXY_SOURCES[source].url(fundingUrl);
                const isProxy = source !== 'direct';
                const response = await smartFetch(targetUrl, { timeout: isProxy ? CONFIG.TIMEOUT_PROXY : CONFIG.TIMEOUT_SHORT, isProxy }, { source, instId });
                const data = await response.json();
                const payload = Array.isArray(data) ? data : (data?.data || []);
                if (Array.isArray(payload) && payload.length > 0) return payload[0];
              } catch (e) { lastErr = e; continue; }
            }
          } catch (e) { lastErr = e; }
          const backoff = 200 * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, backoff));
        }
        console.warn(`⚠️ instId ${instId} 请求失败:`, lastErr && lastErr.message);
        return null;
      });

      const settled = await Promise.allSettled(promises);
      for (const s of settled) if (s.status === 'fulfilled' && s.value) fundingResults.push(s.value);

      if (i + perBatch < instIds.length) await new Promise(r => setTimeout(r, interBatchDelay));
    }

    const validResults = fundingResults.filter(item => item && (item.instId || item.inst_id || item.instrumentId || item.instrument_id));
    if (validResults.length === 0) throw new Error('未获取到有效的OKX资金费率数据');

    const normalized = normalizeOkxArray(validResults, 'okx');

    // 更新调试摘要
    lastFetchSummary.okx = {
      requested: instIds.length,
      fetched: validResults.length,
      normalized: normalized.length,
      timestamp: Date.now(),
      sample: normalized.slice(0, 6).map(x => ({ symbol: x.symbol, lastFundingRate: x.lastFundingRate, nextFundingTime: x.nextFundingTime }))
    };

    console.log(`✅ 成功获取并归一化 ${normalized.length} 个OKX资金费率 (目标 ${instIds.length}, 原始成功 ${validResults.length})`);

    cache.set(cacheKey, normalized, CONFIG.CACHE_TTL_OKX, { source: 'okx_multiple', count: normalized.length, timestamp: new Date().toISOString() });
    return normalized;
  } catch (error) {
    console.error('❌ OKX数据获取失败:', error.message);
    const staleCache = cache.peek('okx_funding_all');
    if (staleCache && staleCache.length > 0) {
      console.log('⚠️ 返回过期的OKX缓存数据');
      return staleCache;
    }
    throw error;
  }
}

// ========== 中间件 ==========
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('http'))) res.header('Access-Control-Allow-Origin', origin);
  else res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  req.requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  req.startTime = Date.now();
  next();
});

app.use((req, res, next) => {
  const { requestId, startTime, method, path, ip, headers } = req;
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userAgent = headers['user-agent'] || 'unknown';
    console.log(`${method} ${path} - ${res.statusCode} - ${duration}ms - IP: ${ip} - UA: ${userAgent.substring(0, 50)}`);
    metrics.requests.total++;
    if (res.statusCode < 400) metrics.requests.success++; else metrics.requests.failed++;
  });
  next();
});

app.use('/proxy/*', (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  if (!rateLimiter.check(ip)) {
    console.warn(`🚫 限流拦截: ${ip} - ${req.path}`);
    return res.status(429).json({ success: false, error: '请求过于频繁', retryAfter: 60, requestId: req.requestId });
  }
  req.clientIp = ip;
  next();
});

// 静态文件服务（public）
app.use(express.static('public', { maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));

// ========== 路由 ==========
app.get('/', (req, res) => {
  res.json({ service: 'Crypto Data Proxy', version: '2.0.0', status: 'online', timestamp: new Date().toISOString(), uptime: process.uptime(), endpoints: { binance: '/proxy/binance', okx: '/proxy/okx', debug: '/debug/fetch-summary', health: '/health' }, requestId: req.requestId });
});

app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), system: { uptime: process.uptime(), memory: { rss: Math.round(memory.rss / 1024 / 1024) + 'MB', heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB' } }, service: { cacheSize: cache.size, rateLimit: rateLimiter.getStats(), requests: metrics.requests } });
});

app.get('/metrics', (req, res) => {
  const avgResponseTime = metrics.responseTimes.length > 0 ? metrics.responseTimes.reduce((s, r) => s + r.value, 0) / metrics.responseTimes.length : 0;
  res.json({ timestamp: new Date().toISOString(), requests: metrics.requests, cache: cache.getStats(), rateLimiter: rateLimiter.getStats(), sources: metrics.sources, performance: { avgResponseTime: Math.round(avgResponseTime), recentResponseTimes: metrics.responseTimes.slice(-10), hitRate: Math.round(cache.getStats().hitRate * 100) + '%' }, uptime: process.uptime() });
});

// Binance 路由
app.get('/proxy/binance', async (req, res) => {
  try {
    console.log(`🌐 [${req.requestId}] 请求Binance数据 (IP: ${req.clientIp})`);
    const data = await getBinanceData();
    res.json({ success: true, requestId: req.requestId, timestamp: new Date().toISOString(), count: data.length, data: data, cache: 'fresh', processingTime: Date.now() - req.startTime });
  } catch (error) {
    console.error(`❌ [${req.requestId}] Binance错误:`, error.message);
    const staleData = cache.peek('binance_premiumIndex');
    if (staleData && staleData.length > 0) return res.json({ success: false, warning: '使用缓存数据（可能已过期）', requestId: req.requestId, timestamp: new Date().toISOString(), count: staleData.length, data: staleData, cache: 'stale', error: error.message });
    res.status(502).json({ success: false, error: '无法获取Binance数据', message: error.message, requestId: req.requestId, timestamp: new Date().toISOString() });
  }
});

// OKX 路由
app.get('/proxy/okx', async (req, res) => {
  try {
    console.log(`🌐 [${req.requestId}] 请求OKX数据 (IP: ${req.clientIp})`);
    const data = await getOKXData();
    res.json({ success: true, requestId: req.requestId, timestamp: new Date().toISOString(), count: data.length, data: data, cache: 'fresh', processingTime: Date.now() - req.startTime });
  } catch (error) {
    console.error(`❌ [${req.requestId}] OKX错误:`, error.message);
    const staleData = cache.peek('okx_funding_all');
    if (staleData && staleData.length > 0) return res.json({ success: false, warning: '使用缓存数据（可能已过期）', requestId: req.requestId, timestamp: new Date().toISOString(), count: staleData.length, data: staleData, cache: 'stale', error: error.message });
    res.status(502).json({ success: false, error: '无法获取OKX数据', message: error.message, requestId: req.requestId, timestamp: new Date().toISOString() });
  }
});

// 调试路由：返回最近一次抓取摘要（可在手机浏览器直接查看）
app.get('/debug/fetch-summary', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    okx: lastFetchSummary.okx,
    binance: lastFetchSummary.binance,
    cacheStats: cache.getStats(),
    rateLimiter: rateLimiter.getStats(),
    metricsSummary: { requests: metrics.requests, sources: metrics.sources }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: '端点不存在', requestId: req.requestId, availableEndpoints: ['GET /', 'GET /health', 'GET /metrics', 'GET /proxy/binance', 'GET /proxy/okx', 'GET /debug/fetch-summary'] });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(`🚨 [${req.requestId}] 未处理错误:`, err.stack || err.message);
  res.status(500).json({ success: false, error: '服务器内部错误', requestId: req.requestId, timestamp: new Date().toISOString(), message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' });
});

// ========== 维护任务 ==========
function performMaintenance() {
  const now = Date.now();
  const evicted = cache.cleanup();
  if (evicted > 0) console.log(`🧹 清理了 ${evicted} 个过期缓存项`);
  rateLimiter.cleanup();
  if (metrics.errors.length > 100) metrics.errors = metrics.errors.slice(-50);
  for (const [name, source] of Object.entries(PROXY_SOURCES)) {
    if (now - source.lastSuccess > 3600000) source.failures = Math.min(source.failures, 5);
  }
}
setInterval(performMaintenance, CONFIG.CLEANUP_INTERVAL);

// 自ping（生产环境）
let isSelfPinging = false;
async function selfPing() {
  if (isSelfPinging) return;
  isSelfPinging = true;
  try {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBSITE_URL || `http://localhost:${PORT}`;
    const pingUrl = `${baseUrl.replace(/\/$/, '')}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(pingUrl, { signal: controller.signal, headers: { 'User-Agent': 'Self-Ping/1.0' } });
      clearTimeout(timeoutId);
      if (response.ok) { const data = await response.json().catch(() => ({})); console.log(`❤️ 自ping成功 (${data.status || 'unknown'})`); } else console.log('⚠️ 自ping响应异常:', response.status);
    } catch (error) { console.log('⚠️ 自ping失败（可能正常）'); }
  } catch (error) {}
  finally { isSelfPinging = false; }
}
if (process.env.NODE_ENV === 'production') { setTimeout(() => { selfPing(); setInterval(selfPing, 8 * 60 * 1000); }, 30000); }

// 启动
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`✅ 加密货币代理服务器 已启动 (port ${PORT})`);
  console.log(`🔗 endpoints: /proxy/binance  /proxy/okx  /debug/fetch-summary`);
  console.log('='.repeat(60));
});

// 优雅关闭
['SIGTERM','SIGINT','SIGUSR2'].forEach(sig => process.on(sig, () => {
  console.log(`\n${sig} 收到关闭信号...`);
  server.close(() => { console.log('服务器已关闭'); process.exit(0); });
  setTimeout(() => { console.error('强制关闭超时，立即退出'); process.exit(1); }, 10000);
}));

process.on('uncaughtException', (error) => { console.error('🚨 未捕获的异常:', error); metrics.errors.push({ timestamp: new Date().toISOString(), message: error.message, stack: error.stack }); });
process.on('unhandledRejection', (reason) => { console.error('🚨 未处理的Promise拒绝:', reason); metrics.errors.push({ timestamp: new Date().toISOString(), type: 'unhandledRejection', reason: String(reason) }); });
