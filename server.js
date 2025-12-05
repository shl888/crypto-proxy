app.get('/proxy/binance', async (req, res) => {
  // 尝试的公共代理列表（将币安API地址包装起来）
  const proxyAttempts = [
    `https://api.allorigins.win/get?url=${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`,
    `https://corsproxy.io/?${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent('https://fapi.binance.com/fapi/v1/premiumIndex')}`
  ];

  let lastError = null;

  for (const proxyUrl of proxyAttempts) {
    try {
      console.log(`尝试通过代理访问: ${proxyUrl}`);
      const response = await fetch(proxyUrl, { timeout: 10000 });

      if (!response.ok) continue;

      let data = await response.json();

      // 处理不同代理的返回格式
      // 1. allorigins.win 返回 { contents: JSON字符串 }
      if (proxyUrl.includes('allorigins.win')) {
        try {
          data = JSON.parse(data.contents);
        } catch (e) {
          continue; // 解析失败，尝试下一个代理
        }
      }
      // 2. 其他代理通常直接返回币安的原始数据

      // 验证是否拿到正确的币安数据
      if (Array.isArray(data) && data.length > 0 && data[0].symbol && data[0].lastFundingRate !== undefined) {
        console.log(`✅ 成功通过代理获取币安原始数据`);
        return res.json(data); // 将币安的原始数据直接传回给你的网页
      }

    } catch (error) {
      console.warn(`当前代理失败:`, error.message);
      lastError = error;
      await new Promise(r => setTimeout(r, 500)); // 稍作延迟再试下一个
      continue;
    }
  }

  // 所有代理都失败
  res.status(500).json({
    error: '无法通过任何公共代理获取币安数据',
    detail: lastError?.message,
    message: '所有中转渠道均暂时不可用。'
  });
});
