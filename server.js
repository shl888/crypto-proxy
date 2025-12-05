// ============ server.js 完整代码开始 ============
const express = require('express');
const fetch = require('node-fetch'); // 用于发送请求
const app = express(); // ！！！这是定义app变量的关键行！！！
const PORT = process.env.PORT || 3000;

// 1. 允许所有网页跨域访问（安全考虑，上线后可限制域名）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 2. 健康检查端点，防止免费服务休眠，也用于测试
app.get('/', (req, res) => res.send('🚀 Crypto Proxy is Online'));

// 3. 代理币安资金费率（使用公共代理中转）
app.get('/proxy/binance', async (req, res) => {
  // 公共代理地址列表，逐个尝试
  const proxyAttempts = [
    `https://corsproxy.io/?${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`
  ];

  let lastError = null;
  for (const proxyUrl of proxyAttempts) {
    try {
      console.log(`尝试代理: ${proxyUrl}`);
      const response = await fetch(proxyUrl, { timeout: 10000 });
      if (!response.ok) continue;
      
      let data = await response.json();
      
      // 处理 allorigins.win 的特殊包装格式
      if (proxyUrl.includes('allorigins.win')) {
        try {
          data = JSON.parse(data.contents);
        } catch (e) {
          continue;
        }
      }
      
      // 验证是否为正确的币安数据
      if (Array.isArray(data) && data.length > 0 && data[0].lastFundingRate !== undefined) {
        console.log(`✅ 成功获取数据`);
        return res.json(data);
      }
    } catch (error) {
      console.warn(`代理失败:`, error.message);
      lastError = error;
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
  }
  
  // 所有尝试都失败
  res.status(500).json({ 
    error: '所有公共代理均无法访问币安接口',
    detail: lastError?.message 
  });
});

// 4. 启动服务器（这行必须在最后）
app.listen(PORT, () => console.log(`✅ 代理服务已启动: http://localhost:${PORT}`));
// ============ server.js 完整代码结束 ============
