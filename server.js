const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// 允许所有网页跨域访问（安全考虑，上线后可限制域名）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 币安资金费率备用地址列表（国内用户友好）
const BINANCE_URLS = [
  'https://fapi.binance.com/fapi/v1/premiumIndex',
  'https://fapi.binancezh.com/fapi/v1/premiumIndex',
  'https://fapi.binancezh.top/fapi/v1/premiumIndex',
  'https://fapi.binancezh.info/fapi/v1/premiumIndex'
];

// 代理币安资金费率（带自动重试）
app.get('/proxy/binance', async (req, res) => {
  let lastError;
  for (const url of BINANCE_URLS) {
    try {
      console.log(`正在尝试: ${url}`);
      const response = await fetch(url, { timeout: 8000 });
      if (!response.ok) continue;
      const data = await response.json();
      // 验证数据格式是否正确
      if (Array.isArray(data) && data[0] && data[0].lastFundingRate != null) {
        console.log(`成功从备用地址获取数据`);
        return res.json(data);
      }
    } catch (err) {
      lastError = err;
      console.warn(`尝试失败: ${err.message}`);
      // 短暂延迟后尝试下一个地址
      await new Promise(r => setTimeout(r, 300));
    }
  }
  res.status(500).json({ 
    error: '所有备用地址均无法访问', 
    detail: lastError?.message 
  });
});

// 代理OKX资金费率（保留，供未来测试）
app.get('/proxy/okx', async (req, res) => {
  try {
    const response = await fetch('https://www.okx.com/api/v5/public/funding-rate?instType=SWAP');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 健康检查端点，防止免费服务休眠
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => console.log(`🚀 代理服务已启动，端口: ${PORT}`));
