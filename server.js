// server.js
const express = require('express');
const fetch = require('node-fetch'); // node-fetch@2
const { AbortController } = require('abort-controller');
const { HttpsProxyAgent } = require('https-proxy-agent');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 配置区域 ==========
const CONFIG = {
  // 缓存时间
  CACHE_TTL_BINANCE: 6000,
  CACHE_TTL_OKX: 8000,
  CACHE_TTL_GENERAL: 10000,
  
  // 请求超时
  TIMEOUT_DIRECT: 7000,
  TIMEOUT_PROXY: 10000,
  TIMEOUT_SHORT: 5000,
  
  // 并发限制
  CONCURRENCY_LIMIT: 6,
  OKX_BATCH_SIZE: 80, // 减少OKX请求数量
  
  // 重试策略
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  
  // 速率限制
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: 600,
  RATE_LIMIT_PER_IP: 100,
  
  // 数据源
  SOURCE_PRIORITY: {
    binance: ['direct', 'proxy1', 'proxy2', 'proxy3'],
    okx: ['direct', 'proxy1', 'proxy2']
  },
  
  // 监控
  HEALTH_CHECK_INTERVAL: 30000, // 30秒
  METRICS_RETENTION: 60000, // 1分钟
  CLEANUP_INTERVAL: 300000 // 5分钟清理
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

// 代理源（动态可用性检查）
const PROXY_SOURCES = {
  direct: { 
    url: url => url, 
    priority: 0,
    lastSuccess: Date.now(),
    failures: 0 
  },
  proxy1: { 
    url: url => `https://corsproxy.io/?${encodeURIComponent(url)}`, 
    priority: 1,
    lastSuccess: Date.now(),
    failures: 0 
  },
  proxy2: { 
    url: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, 
    priority: 2,
    lastSuccess: Date.now(),
    failures: 0 
  },
  proxy3: { 
    url: url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`, 
    priority: 3,
    lastSuccess: Date.now(),
    failures: 0 
  },
  proxy4: { 
    url: url => `https://thingproxy.freeboard.io/fetch/${url}`, 
    priority: 4,
    lastSuccess: Date.now(),
    failures: 0 
  }
};

// 获取可用代理源（按成功率和优先级排序）
function getAvailableSources(type = 'binance') {
  const baseOrder = CONFIG.SOURCE_PRIORITY[type] || ['direct', 'proxy1', 'proxy2'];
  
  return [...baseOrder]
    .filter(source => PROXY_SOURCES[source])
    .sort((a, b) => {
      const sourceA = PROXY_SOURCES[a];
      const sourceB = PROXY_SOURCES[b];
      
      // 优先选择最近成功的
      const successDiff = (Date.now() - sourceA.lastSuccess) - (Date.now() - sourceB.lastSuccess);
      // 失败次数少的优先
      const failureDiff = sourceA.failures - sourceB.failures;
      
      return failureDiff || successDiff;
    });
}

// ========== 智能缓存系统 ==========
class SmartCache {
  constructor() {
    this.store = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }
  
  set(key, data, ttl = CONFIG.CACHE_TTL_GENERAL, metadata = {}) {
    this.store.set(key, {
      data,
      expiry: Date.now() + ttl,
      timestamp: Date.now(),
      metadata: {
        source: metadata.source || 'unknown',
        size: JSON.stringify(data).length,
        ...metadata
      }
    });
    
    // 自动清理旧缓存（如果缓存太多）
    if (this.store.size > 100) {
      this.cleanup();
    }
  }
  
  get(key) {
    const item = this.store.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }
    
    if (Date.now() > item.expiry) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    return {
      data: item.data,
      metadata: item.metadata,
      age: Date.now() - item.timestamp,
      expiresIn: item.expiry - Date.now()
    };
  }
  
  peek(key) {
    const item = this.store.get(key);
    return item ? item.data : null;
  }
  
  cleanup() {
    const now = Date.now();
    let evicted = 0;
    
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiry) {
        this.store.delete(key);
        evicted++;
      }
    }
    
    this.stats.evictions += evicted;
    return evicted;
  }
  
  getStats() {
    return {
      ...this.stats,
      size: this.store.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses || 1)
    };
  }
  
  get size() {
    return this.store.size;
  }
}

const cache = new SmartCache();

// ========== 智能限流器 ==========
class SmartRateLimiter {
  constructor() {
    this.store = new Map();
    this.global = { count: 0, startTime: Date.now() };
  }
  
  check(ip) {
    const now = Date.now();
    
    // 全局限流
    if (now - this.global.startTime > CONFIG.RATE_LIMIT_WINDOW_MS) {
      this.global.count = 1;
      this.global.startTime = now;
    } else {
      this.global.count++;
    }
    
    if (this.global.count > CONFIG.RATE_LIMIT_MAX) {
      return false;
    }
    
    // IP限流
    if (ip && ip !== 'unknown') {
      const record = this.store.get(ip) || { count: 0, startTime: now, blocked: false };
      
      if (record.blocked) {
        if (now - record.startTime > 60000) { // 封禁1分钟
          record.count = 1;
          record.startTime = now;
          record.blocked = false;
        } else {
          return false;
        }
      }
      
      if (now - record.startTime > CONFIG.RATE_LIMIT_WINDOW_MS) {
        record.count = 1;
        record.startTime = now;
      } else {
        record.count++;
      }
      
      if (record.count > CONFIG.RATE_LIMIT_PER_IP) {
        record.blocked = true;
        record.startTime = now;
      }
      
      this.store.set(ip, record);
    }
    
    return true;
  }
  
  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.store.entries()) {
      if (now - record.startTime > CONFIG.RATE_LIMIT_WINDOW_MS * 10) {
        this.store.delete(ip);
      }
    }
  }
  
  getStats() {
    return {
      globalCount: this.global.count,
      activeIPs: this.store.size,
      blockedIPs: Array.from(this.store.values()).filter(r => r.blocked).length
    };
  }
}

const rateLimiter = new SmartRateLimiter();

// ========== 监控系统 ==========
const metrics = {
  requests: { total: 0, success: 0, failed: 0 },
  responseTimes: [],
  sources: {},
  errors: []
};

function recordMetric(type, value) {
  if (!metrics[type]) metrics[type] = { count: 0, sum: 0 };
  metrics[type].count++;
  metrics[type].sum += value;
  
  // 保留最近100个响应时间
  if (type === 'responseTimes') {
    metrics.responseTimes.push({ timestamp: Date.now(), value });
    if (metrics.responseTimes.length > 100) {
      metrics.responseTimes.shift();
    }
  }
}

function recordSourceUsage(source, success) {
  if (!metrics.sources[source]) {
    metrics.sources[source] = { requests: 0, successes: 0, failures: 0 };
  }
  
  metrics.sources[source].requests++;
  if (success) {
    metrics.sources[source].successes++;
  } else {
    metrics.sources[source].failures++;
  }
}

// ========== 智能重试Fetch ==========
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
      const fetchOptions = {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          ...options.headers
        }
      };
      
      if (proxyAgent && !isProxy) {
        fetchOptions.agent = proxyAgent;
      }
      
      const startTime = Date.now();
      const response = await fetch(url, fetchOptions);
      const responseTime = Date.now() - startTime;
      
      clearTimeout(timeoutId);
      
      recordMetric('responseTimes', responseTime);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // 记录成功
      recordSourceUsage(source, true);
      PROXY_SOURCES[source].lastSuccess = Date.now();
      PROXY_SOURCES[source].failures = Math.max(0, PROXY_SOURCES[source].failures - 1);
      
      return response;
      
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      
      // 记录失败
      if (attempt === maxRetries) {
        recordSourceUsage(source, false);
        if (PROXY_SOURCES[source]) {
          PROXY_SOURCES[source].failures++;
        }
      }
      
      if (attempt < maxRetries) {
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt); // 指数退避
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }
  
  throw lastError || new Error('Fetch failed after retries');
}

// ========== 数据获取函数 ==========
async function getBinanceData() {
  const cacheKey = 'binance_premiumIndex';
  const cached = cache.get(cacheKey);
  
  if (cached) {
    console.log(`📦 Binance缓存命中 (${cached.expiresIn}ms后过期)`);
    return cached.data;
  }
  
  const url = 'https://fapi.binance.com/fapi/v1/premiumIndex';
  const sources = getAvailableSources('binance');
  
  for (const source of sources) {
    try {
      console.log(`🔗 尝试 [${source}] 获取Binance数据...`);
      
      const targetUrl = PROXY_SOURCES[source].url(url);
      const isProxy = source !== 'direct';
      
      const response = await smartFetch(targetUrl, {
        timeout: isProxy ? CONFIG.TIMEOUT_PROXY : CONFIG.TIMEOUT_DIRECT,
        isProxy
      }, { source });
      
      const data = await response.json();
      
      // 数据验证
      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`⚠️ [${source}]: 数据格式无效`);
        continue;
      }
      
      const sample = data[0];
      if (!sample?.symbol || typeof sample.lastFundingRate === 'undefined') {
        console.warn(`⚠️ [${source}]: 数据字段缺失`);
        continue;
      }
      
      // 过滤无效数据
      const validData = data.filter(item => 
        item.symbol && 
        typeof item.lastFundingRate === 'string' &&
        !isNaN(parseFloat(item.lastFundingRate))
      );
      
      if (validData.length === 0) {
        console.warn(`⚠️ [${source}]: 无有效数据`);
        continue;
      }
      
      console.log(`✅ [${source}]: 成功获取 ${validData.length} 个交易对`);
      
      cache.set(cacheKey, validData, CONFIG.CACHE_TTL_BINANCE, {
        source,
        count: validData.length,
        timestamp: new Date().toISOString()
      });
      
      return validData;
      
    } catch (error) {
      console.warn(`❌ [${source}] 失败:`, error.message);
    }
  }
  
  // 所有源都失败，尝试紧急备用
  try {
    console.log('🚨 尝试紧急备用源...');
    const backupUrl = 'https://api.binance.com/api/v3/ticker/24hr';
    const response = await smartFetch(backupUrl, { timeout: CONFIG.TIMEOUT_SHORT });
    const backupData = await response.json();
    
    console.log('⚠️ 使用24小时价格数据作为备用');
    
    // 转换格式以保持兼容性
    const formattedData = Array.isArray(backupData) ? backupData.slice(0, 50).map(item => ({
      symbol: item.symbol,
      lastFundingRate: '0.0001', // 默认值
      markPrice: item.lastPrice,
      indexPrice: item.weightedAvgPrice
    })) : [];
    
    if (formattedData.length > 0) {
      cache.set(cacheKey, formattedData, CONFIG.CACHE_TTL_BINANCE, {
        source: 'emergency',
        warning: '使用备用数据源'
      });
      
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
  
  if (cached) {
    console.log(`📦 OKX缓存命中 (${cached.expiresIn}ms后过期)`);
    return cached.data;
  }
  
  try {
    console.log('🔗 获取OKX合约列表...');
    const instUrl = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
    
    let instData;
    for (const source of getAvailableSources('okx')) {
      try {
        const targetUrl = PROXY_SOURCES[source].url(instUrl);
        const isProxy = source !== 'direct';
        
        const response = await smartFetch(targetUrl, {
          timeout: isProxy ? CONFIG.TIMEOUT_PROXY : CONFIG.TIMEOUT_DIRECT,
          isProxy
        }, { source });
        
        instData = await response.json();
        console.log(`✅ [${source}]: OKX合约列表成功`);
        break;
      } catch (error) {
        console.warn(`❌ [${source}]: OKX合约列表失败`);
      }
    }
    
    if (!instData) {
      throw new Error('无法获取OKX合约列表');
    }
    
    const instList = Array.isArray(instData) ? instData : (instData?.data || []);
    
    if (instList.length === 0) {
      throw new Error('OKX合约列表为空');
    }
    
    // 智能选择交易对：优先永续合约，限制数量
    const instIds = [...new Set(instList
      .filter(it => it.instId && it.instId.includes('-SWAP'))
      .map(it => it.instId)
      .slice(0, CONFIG.OKX_BATCH_SIZE)
    )];
    
    console.log(`📊 选取 ${instIds.length} 个OKX交易对`);
    
    // 分批获取资金费率
    const fundingResults = [];
    const batchSize = Math.min(CONFIG.CONCURRENCY_LIMIT, 5);
    
    for (let i = 0; i < instIds.length; i += batchSize) {
      const batch = instIds.slice(i, i + batchSize);
      const batchPromises = batch.map(async (instId, index) => {
        await new Promise(resolve => setTimeout(resolve, index * 50)); // 错开请求
        
        for (const source of getAvailableSources('okx')) {
          try {
            const fundingUrl = `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`;
            const targetUrl = PROXY_SOURCES[source].url(fundingUrl);
            const isProxy = source !== 'direct';
            
            const response = await smartFetch(targetUrl, {
              timeout: CONFIG.TIMEOUT_SHORT,
              isProxy
            }, { source, instId });
            
            const data = await response.json();
            if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
              return data.data[0]; // 只取最新的
            }
          } catch (error) {
            // 继续尝试下一个源
            continue;
          }
        }
        
        return null;
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          fundingResults.push(result.value);
        }
      }
      
      // 批量间延迟，避免触发限流
      if (i + batchSize < instIds.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    const validResults = fundingResults.filter(item => item && item.instId);
    
    if (validResults.length === 0) {
      throw new Error('未获取到有效的资金费率数据');
    }
    
    console.log(`✅ 成功获取 ${validResults.length} 个OKX资金费率`);
    
    cache.set(cacheKey, validResults, CONFIG.CACHE_TTL_OKX, {
      source: 'multiple',
      count: validResults.length,
      timestamp: new Date().toISOString()
    });
    
    return validResults;
    
  } catch (error) {
    console.error('❌ OKX数据获取失败:', error.message);
    
    // 尝试返回部分缓存数据
    const staleCache = cache.peek(cacheKey);
    if (staleCache && staleCache.length > 0) {
      console.log('⚠️ 返回过期的OKX缓存数据');
      return staleCache;
    }
    
    throw error;
  }
}

// ========== 中间件 ==========
app.use(helmet({
  contentSecurityPolicy: false, // 允许外部资源
  crossOriginEmbedderPolicy: false
}));
app.use(compression()); // 启用压缩
app.use(express.json());

// CORS中间件
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('http'))) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24小时
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // 请求ID
  req.requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  req.startTime = Date.now();
  
  next();
});

// 日志中间件
app.use((req, res, next) => {
  const { requestId, startTime, method, path, ip, headers } = req;
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userAgent = headers['user-agent'] || 'unknown';
    const referer = headers['referer'] || 'direct';
    
    console.log(`${method} ${path} - ${res.statusCode} - ${duration}ms - IP: ${ip} - UA: ${userAgent.substring(0, 50)}`);
    
    metrics.requests.total++;
    if (res.statusCode < 400) {
      metrics.requests.success++;
    } else {
      metrics.requests.failed++;
    }
  });
  
  next();
});

// 限流中间件
app.use('/proxy/*', (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  
  if (!rateLimiter.check(ip)) {
    console.warn(`🚫 限流拦截: ${ip} - ${req.path}`);
    return res.status(429).json({
      success: false,
      error: '请求过于频繁',
      retryAfter: 60,
      requestId: req.requestId
    });
  }
  
  req.clientIp = ip;
  next();
});

// 静态文件服务（用于测试页面）
app.use(express.static('public', {
  maxAge: '1h',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ========== 路由 ==========
app.get('/', (req, res) => {
  res.json({
    service: 'Crypto Data Proxy',
    version: '2.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    endpoints: {
      binance: '/proxy/binance',
      okx: '/proxy/okx',
      status: '/status',
      metrics: '/metrics',
      health: '/health'
    },
    documentation: '访问 /docs 查看API文档',
    requestId: req.requestId
  });
});

// 健康检查
app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    system: {
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        external: Math.round(memory.external / 1024 / 1024) + 'MB'
      },
      load: process.cpuUsage()
    },
    service: {
      cacheSize: cache.size,
      rateLimit: rateLimiter.getStats(),
      requests: metrics.requests
    }
  });
});

// 监控指标
app.get('/metrics', (req, res) => {
  const avgResponseTime = metrics.responseTimes.length > 0
    ? metrics.responseTimes.reduce((sum, rt) => sum + rt.value, 0) / metrics.responseTimes.length
    : 0;
  
  res.json({
    timestamp: new Date().toISOString(),
    requests: metrics.requests,
    cache: cache.getStats(),
    rateLimiter: rateLimiter.getStats(),
    sources: metrics.sources,
    performance: {
      avgResponseTime: Math.round(avgResponseTime),
      recentResponseTimes: metrics.responseTimes.slice(-10),
      hitRate: Math.round(cache.getStats().hitRate * 100) + '%'
    },
    uptime: process.uptime()
  });
});

// Binance路由
app.get('/proxy/binance', async (req, res) => {
  try {
    console.log(`🌐 [${req.requestId}] 请求Binance数据 (IP: ${req.clientIp})`);
    
    const data = await getBinanceData();
    
    res.json({
      success: true,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      count: data.length,
      data: data,
      cache: 'fresh',
      processingTime: Date.now() - req.startTime
    });
    
  } catch (error) {
    console.error(`❌ [${req.requestId}] Binance错误:`, error.message);
    
    // 尝试返回任何可用的缓存数据
    const cacheKey = 'binance_premiumIndex';
    const staleData = cache.peek(cacheKey);
    
    if (staleData && staleData.length > 0) {
      console.log(`⚠️ [${req.requestId}] 返回缓存数据 (${staleData.length} 条)`);
      
      return res.json({
        success: false,
        warning: '使用缓存数据（可能已过期）',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        count: staleData.length,
        data: staleData,
        cache: 'stale',
        error: error.message
      });
    }
    
    res.status(502).json({
      success: false,
      error: '无法获取Binance数据',
      message: error.message,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      suggestion: '请稍后重试或检查网络连接'
    });
  }
});

// OKX路由
app.get('/proxy/okx', async (req, res) => {
  try {
    console.log(`🌐 [${req.requestId}] 请求OKX数据 (IP: ${req.clientIp})`);
    
    const data = await getOKXData();
    
    res.json({
      success: true,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      count: data.length,
      data: data,
      cache: 'fresh',
      processingTime: Date.now() - req.startTime
    });
    
  } catch (error) {
    console.error(`❌ [${req.requestId}] OKX错误:`, error.message);
    
    // 尝试返回任何可用的缓存数据
    const cacheKey = 'okx_funding_all';
    const staleData = cache.peek(cacheKey);
    
    if (staleData && staleData.length > 0) {
      console.log(`⚠️ [${req.requestId}] 返回缓存数据 (${staleData.length} 条)`);
      
      return res.json({
        success: false,
        warning: '使用缓存数据（可能已过期）',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        count: staleData.length,
        data: staleData,
        cache: 'stale',
        error: error.message
      });
    }
    
    res.status(502).json({
      success: false,
      error: '无法获取OKX数据',
      message: error.message,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      suggestion: '请稍后重试或检查网络连接'
    });
  }
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '端点不存在',
    requestId: req.requestId,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /metrics',
      'GET /proxy/binance',
      'GET /proxy/okx'
    ]
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(`🚨 [${req.requestId}] 未处理错误:`, err.stack || err.message);
  
  res.status(500).json({
    success: false,
    error: '服务器内部错误',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// ========== 系统维护任务 ==========
function performMaintenance() {
  const now = Date.now();
  
  // 清理缓存
  const cacheEvicted = cache.cleanup();
  if (cacheEvicted > 0) {
    console.log(`🧹 清理了 ${cacheEvicted} 个过期缓存项`);
  }
  
  // 清理限流器
  rateLimiter.cleanup();
  
  // 清理旧错误日志
  if (metrics.errors.length > 100) {
    metrics.errors = metrics.errors.slice(-50);
  }
  
  // 代理源健康检查
  for (const [name, source] of Object.entries(PROXY_SOURCES)) {
    if (now - source.lastSuccess > 3600000) { // 1小时无成功
      source.failures = Math.min(source.failures, 5); // 限制失败次数
    }
  }
}

// ========== 防休眠机制 ==========
let isSelfPinging = false;
async function selfPing() {
  if (isSelfPinging) return;
  
  isSelfPinging = true;
  try {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                   process.env.WEBSITE_URL || 
                   `http://localhost:${PORT}`;
    
    // 只ping健康检查端点，避免触发业务逻辑
    const pingUrl = `${baseUrl.replace(/\/$/, '')}/health`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch(pingUrl, { 
        signal: controller.signal,
        headers: { 'User-Agent': 'Self-Ping/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        console.log(`❤️ 自ping成功 (${data.status || 'unknown'})`);
      } else {
        console.log('⚠️ 自ping响应异常:', response.status);
      }
    } catch (error) {
      // 忽略自ping错误，可能是服务还在启动
      console.log('⚠️ 自ping失败（可能正常）');
    }
  } catch (error) {
    // 忽略所有自ping错误
  } finally {
    isSelfPinging = false;
  }
}

// ========== 启动服务器 ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`✅ 加密货币代理服务器 v2.0 已启动`);
  console.log(`📍 地址: http://localhost:${PORT}`);
  console.log(`🌐 外部访问: ${process.env.RENDER_EXTERNAL_URL || 'N/A'}`);
  console.log(`⚡ 环境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 配置: ${CONFIG.CONCURRENCY_LIMIT}并发/${CONFIG.RATE_LIMIT_MAX}次/分钟`);
  console.log(`🔧 代理源: ${Object.keys(PROXY_SOURCES).join(', ')}`);
  console.log('='.repeat(60));
});

// ========== 定时任务 ==========
// 维护任务（每5分钟）
setInterval(performMaintenance, CONFIG.CLEANUP_INTERVAL);

// 健康自检（每30秒）
setInterval(() => {
  performMaintenance();
  // 记录一些统计信息
  if (Math.random() < 0.3) { // 30%概率记录日志
    console.log(`📈 系统状态: ${cache.size}缓存/${rateLimiter.getStats().activeIPs}活跃IP`);
  }
}, CONFIG.HEALTH_CHECK_INTERVAL);

// 防休眠自ping（每8分钟）
if (process.env.NODE_ENV === 'production') {
  // 启动后等30秒开始第一次ping
  setTimeout(() => {
    selfPing();
    // 每8分钟ping一次（比Render的15分钟休眠短）
    setInterval(selfPing, 8 * 60 * 1000);
  }, 30000);
}

// ========== 优雅关闭 ==========
const shutdownSignals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

shutdownSignals.forEach(signal => {
  process.on(signal, () => {
    console.log(`\n${signal} 收到关闭信号...`);
    
    // 停止接受新请求
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
    
    // 强制关闭超时
    setTimeout(() => {
      console.error('强制关闭超时，立即退出');
      process.exit(1);
    }, 10000);
  });
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('🚨 未捕获的异常:', error);
  // 不要立即退出，让服务器继续运行
  metrics.errors.push({
    timestamp: new Date().toISOString(),
    message: error.message,
    stack: error.stack
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 未处理的Promise拒绝:', reason);
  metrics.errors.push({
    timestamp: new Date().toISOString(),
    type: 'unhandledRejection',
    reason: String(reason)
  });
});
