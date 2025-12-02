// 配置常量（可通过环境变量覆盖）
const DEFAULT_CACHE_TTL = 60 * 1000; // 健康状态缓存1分钟
const DEFAULT_HEALTH_CHECK_TIMEOUT = 2000; // 健康检查超时2秒
const TG_MESSAGE_MAX_LENGTH = 4096; // Telegram消息最大长度
const NOTIFICATION_COOLDOWN = 5 * 60 * 1000; // 通知冷却时间5分钟
const CONCURRENT_HEALTH_CHECKS = 5; // 并发健康检查数量
const FAST_CHECK_TIMEOUT = 800; // 快速检查超时800ms（减少超时）
const FAST_CHECK_CACHE_TTL = 2000; // 快速检查缓存2秒（缩短以提高新鲜度）
const IP_NOTIFICATION_COOLDOWN = 5 * 60 * 1000; // IP通知冷却时间5分钟

// 默认后端列表
const DEFAULT_BACKENDS = [];

// 全局缓存对象
let cache = {
  backends: null,
  lastUpdated: 0,
  healthStatus: null,
  healthLastUpdated: 0,
  lastAvailableBackend: null,
  backendVersions: new Map(),
  lastNotificationTime: 0,
  fastHealthChecks: new Map(),
  healthyBackendsList: [], // 新增：健康后端列表缓存
  healthyBackendsLastUpdated: 0,
  ipNotificationTimestamps: new Map(), // 新增：IP通知时间戳
  ipNotificationBackends: new Map(), // 新增：IP上次使用的后端
};

// 生成唯一请求ID用于日志追踪
function generateRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// 从环境变量获取配置值
function getConfig(env, key, defaultValue) {
  return env[key] ? env[key] : defaultValue;
}

// 获取环境变量中的后端列表
function getBackendsFromEnv(env) {
  try {
    if (env.BACKEND_URLS) {
      return JSON.parse(env.BACKEND_URLS);
    }
  } catch (error) {
    console.error('解析BACKEND_URLS失败:', error);
  }
  return DEFAULT_BACKENDS;
}

// 检查是否需要发送IP通知
function shouldSendIPNotification(clientIp, backendUrl) {
  const now = Date.now();
  const lastTime = cache.ipNotificationTimestamps.get(clientIp);
  const lastBackend = cache.ipNotificationBackends.get(clientIp);
  
  // 如果从未发送过通知，或者后端发生变化，需要发送
  if (!lastTime || lastBackend !== backendUrl) {
    return true;
  }
  
  // 检查冷却时间
  const ipCooldown = IP_NOTIFICATION_COOLDOWN;
  return now - lastTime > ipCooldown;
}

// 更新IP通知记录
function updateIPNotificationRecord(clientIp, backendUrl) {
  const now = Date.now();
  cache.ipNotificationTimestamps.set(clientIp, now);
  cache.ipNotificationBackends.set(clientIp, backendUrl);
  
  // 定期清理过期的IP记录（24小时）
  const maxAge = 24 * 60 * 60 * 1000; // 24小时
  for (const [ip, timestamp] of cache.ipNotificationTimestamps.entries()) {
    if (now - timestamp > maxAge) {
      cache.ipNotificationTimestamps.delete(ip);
      cache.ipNotificationBackends.delete(ip);
    }
  }
}

// 发送订阅转换请求通知（异步）
async function sendSubconverterRequestNotification(clientIp, backendUrl, responseTime, requestId, env, version = '未知版本') {
  const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
  const chatId = getConfig(env, 'TG_CHAT_ID', '');
  
  if (!botToken || !chatId) {
    return false;
  }
  
  try {
    // 获取北京时间
    const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const beijingTimeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
    
    // 创建通知消息
    let message = `🔔 订阅转换请求通知\n\n`;
    message += `⏰ 请求时间: ${beijingTimeStr} (北京时间)\n`;
    message += `🚀 使用后端: ${backendUrl}\n`;
    message += `📦 版本: ${version}\n`;
    message += `⚡ 响应时间: ${responseTime}ms\n`;
    message += `📝 请求ID: ${requestId}\n\n`;
    message += `⏳ IP通知冷却: 5分钟。`;
    
    // 发送到Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        disable_notification: false
      })
    });
    
    if (response.ok) {
      console.log(`[${requestId}] 订阅转换请求通知发送成功，IP: ${clientIp}`);
      return true;
    } else {
      console.error(`[${requestId}] 订阅转换请求通知发送失败，状态码: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`[${requestId}] 订阅转换请求通知发送异常:`, error);
    return false;
  }
}

// 极速健康检查（优化版本，只检查最基本功能）
async function ultraFastHealthCheck(url, requestId) {
  const cacheKey = `ultrafast_health_${url}`;
  const cached = cache.fastHealthChecks.get(cacheKey);
  const now = Date.now();
  
  // 极速缓存：2秒缓存
  if (cached && now - cached.timestamp < FAST_CHECK_CACHE_TTL) {
    return cached.result;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FAST_CHECK_TIMEOUT); // 800ms超时
    
    const startTime = Date.now();
    // 使用更小的请求，只获取必要的验证信息
    const response = await fetch(`${url}/version`, {
      signal: controller.signal,
      headers: { 
        'User-Agent': 'subconverter-failover-worker/1.0',
        'Accept': 'text/plain',
        'X-Request-ID': requestId
      },
      // 添加CF的更快连接选项
      cf: {
        cacheTtl: 0,
        scrapeShield: false,
        polish: 'off'
      }
    });
    const responseTime = Date.now() - startTime;
    
    clearTimeout(timeoutId);
    
    // 快速验证：只需要200状态码
    const result = {
      healthy: response.status === 200,
      responseTime,
      timestamp: now,
      status: response.status
    };
    
    // 如果健康，尝试读取版本（但不要阻塞）
    if (result.healthy) {
      try {
        // 使用非阻塞方式读取文本
        const text = await response.text().catch(() => '');
        result.version = text.substring(0, 30);
      } catch (e) {
        // 忽略版本读取错误
      }
    }
    
    // 缓存极速检查结果
    cache.fastHealthChecks.set(cacheKey, {
      result,
      timestamp: now
    });
    
    // 更新健康后端列表缓存
    if (result.healthy) {
      updateHealthyBackendsList(url, responseTime);
    }
    
    return result;
  } catch (error) {
    const result = {
      healthy: false,
      responseTime: null,
      timestamp: now,
      error: error.name
    };
    
    // 缓存失败结果
    cache.fastHealthChecks.set(cacheKey, {
      result,
      timestamp: now
    });
    
    return result;
  }
}

// 更新健康后端列表（按响应时间排序）
function updateHealthyBackendsList(url, responseTime) {
  if (!cache.healthyBackendsList) {
    cache.healthyBackendsList = [];
  }
  
  const existingIndex = cache.healthyBackendsList.findIndex(item => item.url === url);
  
  if (existingIndex >= 0) {
    // 更新现有记录
    cache.healthyBackendsList[existingIndex] = {
      url,
      responseTime,
      lastChecked: Date.now()
    };
  } else {
    // 添加新记录
    cache.healthyBackendsList.push({
      url,
      responseTime,
      lastChecked: Date.now()
    });
  }
  
  // 按响应时间排序（最快的排前面）
  cache.healthyBackendsList.sort((a, b) => a.responseTime - b.responseTime);
  cache.healthyBackendsLastUpdated = Date.now();
}

// 获取排序后的健康后端列表
function getSortedHealthyBackends(forceRefresh = false) {
  const now = Date.now();
  
  // 如果缓存过期（5秒）或强制刷新，返回空数组让外部重新检查
  if (forceRefresh || !cache.healthyBackendsList || 
      now - cache.healthyBackendsLastUpdated > 5000) {
    return [];
  }
  
  // 过滤掉检查时间过久的记录（超过10秒）
  const freshBackends = cache.healthyBackendsList.filter(
    item => now - item.lastChecked < 10000
  );
  
  // 按响应时间排序
  return freshBackends.sort((a, b) => a.responseTime - b.responseTime);
}

// 带缓存的详细健康检查
async function checkBackendHealth(url, requestId, env) {
  const cacheKey = `health_${url}`;
  const cached = cache.backendVersions.get(cacheKey);
  const now = Date.now();
  
  // 获取配置的超时时间
  const healthCheckTimeout = parseInt(getConfig(env, 'HEALTH_CHECK_TIMEOUT', DEFAULT_HEALTH_CHECK_TIMEOUT));
  const cacheTtl = parseInt(getConfig(env, 'CACHE_TTL', DEFAULT_CACHE_TTL));
  
  // 如果有缓存且未过期，直接返回缓存结果
  if (cached && now - cached.timestamp < cacheTtl) {
    return cached.result;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), healthCheckTimeout);
    
    const startTime = Date.now();
    const response = await fetch(`${url}/version`, {
      signal: controller.signal,
      headers: { 
        'User-Agent': 'subconverter-failover-worker/1.0',
        'Accept': 'text/plain',
        'X-Request-ID': requestId
      }
    });
    const responseTime = Date.now() - startTime;
    
    clearTimeout(timeoutId);
    
    let result;
    if (response.status === 200) {
      const text = await response.text();
      const healthy = text.includes('subconverter');
      result = {
        healthy,
        version: healthy ? text.trim().substring(0, 50) : null,
        timestamp: new Date().toISOString(),
        status: response.status,
        responseTime
      };
    } else {
      result = { 
        healthy: false, 
        status: response.status,
        timestamp: new Date().toISOString(),
        responseTime
      };
    }
    
    // 缓存结果
    cache.backendVersions.set(cacheKey, {
      result,
      timestamp: now
    });
    
    return result;
  } catch (error) {
    const result = { 
      healthy: false, 
      error: error.name === 'AbortError' ? 'Timeout' : error.message,
      timestamp: new Date().toISOString()
    };
    
    // 缓存失败结果
    cache.backendVersions.set(cacheKey, {
      result,
      timestamp: now
    });
    
    return result;
  }
}

// 获取后端列表（带缓存）
async function getBackends(env, requestId) {
  const now = Date.now();
  const cacheTtl = parseInt(getConfig(env, 'CACHE_TTL', DEFAULT_CACHE_TTL));
  
  // 如果缓存未过期，使用缓存
  if (cache.backends && now - cache.lastUpdated < cacheTtl) {
    return cache.backends;
  }
  
  try {
    const backends = getBackendsFromEnv(env);
    
    // 更新缓存
    cache.backends = backends;
    cache.lastUpdated = now;
    
    return backends;
  } catch (error) {
    console.error(`[${requestId}] 获取后端列表失败:`, error);
    return cache.backends || DEFAULT_BACKENDS;
  }
}

// 获取健康状态（带缓存）
async function getHealthStatus(kv, requestId, env) {
  const now = Date.now();
  const cacheTtl = parseInt(getConfig(env, 'CACHE_TTL', DEFAULT_CACHE_TTL));
  
  // 如果缓存未过期，使用缓存
  if (cache.healthStatus && now - cache.healthLastUpdated < cacheTtl) {
    return cache.healthStatus;
  }
  
  try {
    const status = await kv.get('health_status', 'json');
    const healthStatus = status || {};
    
    // 更新缓存
    cache.healthStatus = healthStatus;
    cache.healthLastUpdated = now;
    
    return healthStatus;
  } catch (error) {
    console.error(`[${requestId}] 获取健康状态失败:`, error);
    return cache.healthStatus || {};
  }
}

// 保存健康状态
async function saveHealthStatus(kv, status, requestId) {
  try {
    const dataToSave = {
      ...status,
      last_updated: new Date().toISOString()
    };
    await kv.put('health_status', JSON.stringify(dataToSave));
    // 更新缓存
    cache.healthStatus = dataToSave;
    cache.healthLastUpdated = Date.now();
    return true;
  } catch (error) {
    console.error(`[${requestId}] 保存健康状态失败:`, error);
    return false;
  }
}

// 获取上次可用后端
async function getLastAvailableBackend(kv, requestId) {
  // 首先检查内存缓存
  if (cache.lastAvailableBackend) {
    return cache.lastAvailableBackend;
  }
  
  try {
    const lastBackend = await kv.get('last_available_backend', 'text');
    if (lastBackend) {
      cache.lastAvailableBackend = lastBackend;
    }
    return lastBackend;
  } catch (error) {
    console.error(`[${requestId}] 获取上次可用后端失败:`, error);
    return null;
  }
}

// 保存上次可用后端
async function saveLastAvailableBackend(kv, backendUrl, requestId) {
  try {
    await kv.put('last_available_backend', backendUrl);
    cache.lastAvailableBackend = backendUrl;
    return true;
  } catch (error) {
    console.error(`[${requestId}] 保存上次可用后端失败:`, error);
    return false;
  }
}

// 并行极速健康检查（优化版本）
async function parallelUltraFastHealthChecks(urls, requestId) {
  const results = new Map();
  
  // 使用Promise.allSettled并行检查
  const promises = urls.map(async (url) => {
    try {
      const health = await ultraFastHealthCheck(url, `${requestId}-${url}`);
      return { url, health };
    } catch (error) {
      return { url, health: { healthy: false, error: error.name } };
    }
  });
  
  const checkResults = await Promise.allSettled(promises);
  
  // 处理结果
  checkResults.forEach(result => {
    if (result.status === 'fulfilled') {
      const { url, health } = result.value;
      results.set(url, health);
    }
  });
  
  return results;
}

// 智能查找可用后端（订阅转换请求专用）- 优化版本
async function findAvailableBackendForRequest(kv, requestId, env) {
  const backends = await getBackends(env, requestId);
  
  if (backends.length === 0) {
    return null;
  }
  
  // 策略0: 检查内存中已排序的健康后端（最快路径）
  const healthyBackends = getSortedHealthyBackends();
  if (healthyBackends.length > 0) {
    // 直接使用响应最快的前3个进行检查
    const candidates = healthyBackends.slice(0, Math.min(3, healthyBackends.length));
    
    for (const candidate of candidates) {
      const fastCheck = await ultraFastHealthCheck(candidate.url, `${requestId}-cached-${candidate.url}`);
      if (fastCheck.healthy) {
        console.log(`[${requestId}] 使用缓存健康后端: ${candidate.url}, 响应时间: ${fastCheck.responseTime}ms`);
        await saveLastAvailableBackend(kv, candidate.url, requestId);
        return candidate.url;
      }
    }
  }
  
  // 策略1: 检查上次可用的后端（快速路径）
  const lastBackend = await getLastAvailableBackend(kv, requestId);
  if (lastBackend && backends.includes(lastBackend)) {
    const fastCheck = await ultraFastHealthCheck(lastBackend, requestId);
    if (fastCheck.healthy) {
      console.log(`[${requestId}] 使用上次可用后端: ${lastBackend}, 响应时间: ${fastCheck.responseTime}ms`);
      return lastBackend;
    }
  }
  
  // 策略2: 并行极速检查所有后端
  console.log(`[${requestId}] 并行极速检查 ${backends.length} 个后端`);
  
  const checkResults = await parallelUltraFastHealthChecks(backends, requestId);
  
  // 找到响应最快的健康后端
  let fastestBackend = null;
  let fastestTime = Infinity;
  
  for (const [url, health] of checkResults.entries()) {
    if (health.healthy && health.responseTime < fastestTime) {
      fastestBackend = url;
      fastestTime = health.responseTime;
    }
  }
  
  if (fastestBackend) {
    console.log(`[${requestId}] 找到最快可用后端: ${fastestBackend}, 响应时间: ${fastestTime}ms`);
    await saveLastAvailableBackend(kv, fastestBackend, requestId);
    return fastestBackend;
  }
  
  // 策略3: 如果有部分后端返回了结果但标记为不健康，尝试其中一个作为最后手段
  console.log(`[${requestId}] 极速检查失败，尝试已返回的后端`);
  
  for (const [url, health] of checkResults.entries()) {
    // 即使健康检查失败，也可能后端实际可用（比如版本检查失败但转换服务正常）
    if (health.status === 200) { // 至少返回了200状态码
      console.log(`[${requestId}] 尝试状态码200的后端: ${url}`);
      await saveLastAvailableBackend(kv, url, requestId);
      return url;
    }
  }
  
  console.log(`[${requestId}] 所有后端均不可用`);
  return null;
}

// 处理订阅转换请求 - 优化版本
async function handleSubconverterRequest(request, backendUrl, requestId, env, ctx) {
  const url = new URL(request.url);
  const backendPath = url.pathname + url.search;
  
  console.log(`[${requestId}] 转发请求到后端: ${backendUrl}${backendPath}`);
  
  try {
    const startTime = Date.now();
    
    // 克隆请求，但优化一些头信息
    const backendRequest = new Request(`${backendUrl}${backendPath}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
      // 添加CF优化选项
      cf: {
        cacheEverything: false,
        cacheTtl: 0,
        polish: 'off',
        scrapeShield: false
      }
    });
    
    // 优化头信息
    backendRequest.headers.delete('host');
    backendRequest.headers.set('host', new URL(backendUrl).host);
    
    // 只添加必要的追踪头
    backendRequest.headers.set('X-Request-ID', requestId);
    backendRequest.headers.set('X-Forwarded-By', 'subconverter-failover-worker');
    
    const response = await fetch(backendRequest);
    const responseTime = Date.now() - startTime;
    
    console.log(`[${requestId}] 后端响应时间: ${responseTime}ms, 状态码: ${response.status}`);
    
    // 只复制必要的响应头
    const responseHeaders = new Headers();
    
    // 复制原响应头（过滤掉一些不必要的）
    for (const [key, value] of response.headers.entries()) {
      if (!key.startsWith('cf-') && key !== 'server') {
        responseHeaders.set(key, value);
      }
    }
    
    // 添加我们的追踪头
    responseHeaders.set('X-Backend-Server', backendUrl);
    responseHeaders.set('X-Response-Time', `${responseTime}ms`);
    responseHeaders.set('X-Request-ID', requestId);
    
    // 添加缓存控制头（避免客户端缓存问题）
    if (!responseHeaders.has('Cache-Control')) {
      responseHeaders.set('Cache-Control', 'no-store, max-age=0');
    }
    
    // 异步发送订阅转换请求通知（不阻塞主响应）
    if (response.ok) {
      // 获取客户端IP
      const clientIp = request.headers.get('cf-connecting-ip') || 
                       request.headers.get('x-forwarded-for') || 
                       'unknown';
      
      // 获取后端版本信息
      const cacheKey = `health_${backendUrl}`;
      const cachedHealth = cache.backendVersions.get(cacheKey);
      const version = cachedHealth?.result?.version || '未知版本';
      
      // 检查是否需要发送通知
      if (shouldSendIPNotification(clientIp, backendUrl)) {
        // 异步发送通知，不等待结果
        ctx.waitUntil(sendSubconverterRequestNotification(clientIp, backendUrl, responseTime, requestId, env, version));
        // 更新IP通知记录
        updateIPNotificationRecord(clientIp, backendUrl);
      }
    }
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    console.error(`[${requestId}] 转发请求失败:`, error);
    
    // 快速标记该后端为不健康
    const cacheKey = `ultrafast_health_${backendUrl}`;
    cache.fastHealthChecks.set(cacheKey, {
      result: {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      },
      timestamp: Date.now()
    });
    
    throw error;
  }
}

// 并发检查多个后端健康状态（优化版本）
async function concurrentHealthChecks(urls, requestId, env) {
  const results = {};
  
  // 使用并行检查
  const promises = urls.map(async (url) => {
    try {
      const health = await checkBackendHealth(url, `${requestId}-${url}`, env);
      return { url, health };
    } catch (error) {
      return { url, health: { healthy: false, error: error.message } };
    }
  });
  
  const checkResults = await Promise.allSettled(promises);
  
  // 处理结果
  checkResults.forEach(result => {
    if (result.status === 'fulfilled') {
      const { url, health } = result.value;
      results[url] = health;
    }
  });
  
  return results;
}

// 执行完整健康检查（检查所有后端）
async function performFullHealthCheck(kv, requestId, env) {
  const backends = await getBackends(env, requestId);
  
  if (backends.length === 0) {
    return {
      results: {},
      availableBackend: null,
      timestamp: new Date().toISOString()
    };
  }
  
  // 并发检查所有后端
  const results = await concurrentHealthChecks(backends, requestId, env);
  
  // 找到响应最快的健康后端
  let fastestBackend = null;
  let fastestTime = Infinity;
  
  for (const [url, health] of Object.entries(results)) {
    if (health.healthy && health.responseTime < fastestTime) {
      fastestBackend = url;
      fastestTime = health.responseTime;
    }
  }
  
  // 保存健康状态
  await saveHealthStatus(kv, results, requestId);
  
  // 保存最快可用的后端
  if (fastestBackend) {
    await saveLastAvailableBackend(kv, fastestBackend, requestId);
    console.log(`[${requestId}] 发现最快后端: ${fastestBackend}, 响应时间: ${fastestTime}ms`);
  } else {
    // 清除上次可用后端记录
    await saveLastAvailableBackend(kv, '', requestId);
  }
  
  return {
    results,
    availableBackend: fastestBackend,
    fastestResponseTime: fastestTime,
    timestamp: new Date().toISOString()
  };
}

// 发送Telegram通知（保持原逻辑）
async function sendTelegramNotification(checkResults, requestId, env) {
  const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
  const chatId = getConfig(env, 'TG_CHAT_ID', '');
  
  if (!botToken || !chatId) {
    return false;
  }
  
  // 检查通知冷却时间
  const now = Date.now();
  if (now - cache.lastNotificationTime < NOTIFICATION_COOLDOWN) {
    return false;
  }
  
  try {
    const { results, availableBackend, timestamp } = checkResults;
    const backends = Object.keys(results);
    const healthyCount = Object.values(results).filter(r => r.healthy).length;
    const totalCount = backends.length;
    
    if (totalCount === 0) {
      return false;
    }
    
    const status = availableBackend ? '✅ 正常运行' : '🔴 服务异常';
    
    // 获取北京时间
    const beijingTime = new Date(new Date(timestamp).getTime() + 8 * 60 * 60 * 1000);
    const beijingTimeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
    
    // 创建美观的消息
    let message = `🤖 *订阅转换服务状态报告*\n\n`;
    message += `📅 *报告时间:* ${beijingTimeStr} (北京时间)\n`;
    message += `📊 *服务状态:* ${status}\n`;
    message += `🔧 *健康后端:* ${healthyCount}/${totalCount}\n\n`;
    
    if (availableBackend) {
      message += `🚀 *当前使用后端:*\n\`${availableBackend}\`\n`;
      const version = results[availableBackend]?.version;
      if (version) {
        message += `📦 版本: ${version}\n`;
      }
      const responseTime = results[availableBackend]?.responseTime;
      if (responseTime) {
        message += `⚡ 响应时间: ${responseTime}ms\n`;
      }
      message += '\n';
    } else if (totalCount > 0) {
      message += `⚠️ *警告:* 没有可用的后端服务器！\n\n`;
    }
    
    if (totalCount > 0) {
      message += `📋 *后端详情:*\n`;
      message += `\`\`\`\n`;
      
      for (const url of backends) {
        const result = results[url];
        const statusEmoji = result.healthy ? '✅' : '❌';
        const statusText = result.healthy ? '正常' : '异常';
        const responseTime = result.responseTime ? `${result.responseTime}ms` : '超时';
        const errorInfo = result.error ? ` (${result.error})` : '';
        
        // 提取域名
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        
        message += `${statusEmoji} ${hostname.padEnd(30)} ${statusText.padEnd(4)} ${responseTime.padEnd(8)}${errorInfo}\n`;
      }
      
      message += `\`\`\`\n`;
      
      // 添加摘要
      if (healthyCount === totalCount) {
        message += `🎉 *所有后端服务器正常运行*`;
      } else if (healthyCount === 0) {
        message += `🚨 *所有后端服务器异常，服务不可用*`;
      } else {
        message += `⚠️ *部分后端异常，建议检查*`;
      }
    } else {
      message += `📝 *提示:* 尚未配置后端服务器，请通过Dashboard配置`;
    }
    
    // 如果消息太长，进行截断
    if (message.length > TG_MESSAGE_MAX_LENGTH) {
      const originalLength = message.length;
      message = message.substring(0, TG_MESSAGE_MAX_LENGTH - 100) + '\n\n...（消息过长，已截断）';
    }
    
    // 发送到Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        disable_notification: false
      })
    });
    
    if (response.ok) {
      cache.lastNotificationTime = now;
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error(`[${requestId}] Telegram通知发送异常:`, error);
    return false;
  }
}

// 发送服务状态变化通知
async function sendServiceStatusNotification(isAvailable, backendUrl, requestId, env) {
  const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
  const chatId = getConfig(env, 'TG_CHAT_ID', '');
  
  if (!botToken || !chatId) {
    return false;
  }
  
  // 检查通知冷却时间
  const now = Date.now();
  if (now - cache.lastNotificationTime < NOTIFICATION_COOLDOWN) {
    return false;
  }
  
  try {
    // 获取北京时间
    const beijingTime = new Date(now + 8 * 60 * 60 * 1000);
    const beijingTimeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
    
    let message;
    if (isAvailable) {
      message = `🟢 *服务恢复通知*\n\n`;
      message += `🎉 订阅转换服务已恢复可用\n`;
      message += `⏰ 时间: ${beijingTimeStr} (北京时间)\n`;
      message += `🚀 可用后端: \`${backendUrl}\`\n`;
      message += `✅ 服务已恢复正常，可以继续使用`;
    } else {
      message = `🔴 *服务中断通知*\n\n`;
      message += `⚠️ 订阅转换服务当前不可用\n`;
      message += `⏰ 时间: ${beijingTimeStr} (北京时间)\n`;
      message += `❌ 所有后端服务器均不可用\n`;
      message += `🚨 服务已中断，请及时检查`;
    }
    
    // 发送到Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        disable_notification: true
      })
    });
    
    if (response.ok) {
      cache.lastNotificationTime = now;
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error(`[${requestId}] 服务状态通知发送异常:`, error);
    return false;
  }
}

// API端点处理
async function handleApiRequest(request, env, requestId) {
  const url = new URL(request.url);
  const kv = env.SUB_BACKENDS;
  
  // 健康检查API
  if (url.pathname === '/api/health' && request.method === 'GET') {
    try {
      const backends = await getBackends(env, requestId);
      const health = await getHealthStatus(kv, requestId, env);
      const lastAvailable = await getLastAvailableBackend(kv, requestId);
      
      const healthyCount = Object.values(health).filter(h => h.healthy).length;
      const totalCount = backends.length;
      
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        backends_count: totalCount,
        healthy_backends: healthyCount,
        unhealthy_backends: totalCount - healthyCount,
        last_available_backend: lastAvailable,
        backends: backends.map(url => ({
          url,
          health: health[url] || { healthy: null }
        }))
      }), {
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error.message,
        request_id: requestId
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
  
  // 手动触发健康检查API
  if (url.pathname === '/api/health-check' && request.method === 'POST') {
    try {
      const checkResults = await performFullHealthCheck(kv, requestId, env);
      
      // 发送Telegram通知
      const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
      const chatId = getConfig(env, 'TG_CHAT_ID', '');
      if (botToken && chatId) {
        await sendTelegramNotification(checkResults, requestId, env);
      }
      
      return new Response(JSON.stringify({
        success: true,
        request_id: requestId,
        results: checkResults.results,
        available_backend: checkResults.availableBackend,
        fastest_response_time: checkResults.fastestResponseTime,
        timestamp: checkResults.timestamp
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error.message,
        request_id: requestId
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
  
  // 查看当前配置的后端列表
  if (url.pathname === '/api/config' && request.method === 'GET') {
    try {
      const backends = await getBackends(env, requestId);
      const cacheTtl = getConfig(env, 'CACHE_TTL', DEFAULT_CACHE_TTL);
      const healthCheckTimeout = getConfig(env, 'HEALTH_CHECK_TIMEOUT', DEFAULT_HEALTH_CHECK_TIMEOUT);
      
      return new Response(JSON.stringify({ 
        backends,
        config: {
          cache_ttl: cacheTtl,
          health_check_timeout: healthCheckTimeout,
          notification_cooldown: NOTIFICATION_COOLDOWN,
          ip_notification_cooldown: IP_NOTIFICATION_COOLDOWN,
          fast_check_timeout: FAST_CHECK_TIMEOUT,
          fast_check_cache_ttl: FAST_CHECK_CACHE_TTL
        },
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error.message,
        request_id: requestId
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
  
  // 清理缓存API
  if (url.pathname === '/api/clear-cache' && request.method === 'POST') {
    try {
      // 清理内存缓存
      cache = {
        backends: null,
        lastUpdated: 0,
        healthStatus: null,
        healthLastUpdated: 0,
        lastAvailableBackend: null,
        backendVersions: new Map(),
        lastNotificationTime: 0,
        fastHealthChecks: new Map(),
        healthyBackendsList: [],
        healthyBackendsLastUpdated: 0,
        ipNotificationTimestamps: new Map(),
        ipNotificationBackends: new Map()
      };
      
      // 清理KV中的健康状态
      await kv.put('health_status', JSON.stringify({}));
      await kv.put('last_available_backend', '');
      
      return new Response(JSON.stringify({
        success: true,
        message: '缓存已清理',
        request_id: requestId,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error.message,
        request_id: requestId
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
  
  // 性能测试API
  if (url.pathname === '/api/benchmark' && request.method === 'GET') {
    try {
      const backends = await getBackends(env, requestId);
      const results = {};
      
      // 测试每个后端的响应时间
      const testPromises = backends.map(async (url) => {
        const startTime = Date.now();
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          
          const response = await fetch(`${url}/version`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'subconverter-failover-benchmark/1.0' }
          });
          
          clearTimeout(timeoutId);
          const responseTime = Date.now() - startTime;
          
          results[url] = {
            status: response.status,
            responseTime,
            healthy: response.status === 200
          };
        } catch (error) {
          results[url] = {
            status: 0,
            responseTime: Date.now() - startTime,
            healthy: false,
            error: error.name
          };
        }
      });
      
      await Promise.allSettled(testPromises);
      
      return new Response(JSON.stringify({
        success: true,
        request_id: requestId,
        benchmark_time: new Date().toISOString(),
        results
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error.message,
        request_id: requestId
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
  
  return new Response(JSON.stringify({ error: '未找到API端点' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// 简单的状态页面
function createStatusPage(requestId, backends, health, availableBackend) {
  const healthyCount = Object.values(health).filter(h => h.healthy).length;
  const totalCount = backends.length;
  const status = availableBackend ? '🟢 正常运行' : totalCount > 0 ? '🔴 服务异常' : '⚪ 未配置';
  
  // 获取北京时间
  const beijingTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const beijingTimeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
  
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>订阅转换服务状态</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .status-container {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 800px;
        }
        h1 {
            color: #333;
            margin-bottom: 1.5rem;
            text-align: center;
            font-weight: 300;
        }
        .status-header {
            text-align: center;
            margin-bottom: 2rem;
        }
        .status-badge {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 500;
            font-size: 14px;
            margin-bottom: 10px;
        }
        .status-healthy { background: #d4edda; color: #155724; }
        .status-unhealthy { background: #f8d7da; color: #721c24; }
        .status-unconfigured { background: #e2e3e5; color: #383d41; }
        .stats {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 2rem;
        }
        .stat-card {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #2c3e50;
            margin-bottom: 5px;
        }
        .stat-label {
            font-size: 12px;
            color: #6c757d;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .current-backend {
            background: #e7f5ff;
            border: 1px solid #bbdefb;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 2rem;
        }
        .current-backend h3 {
            color: #1971c2;
            margin-bottom: 10px;
        }
        .backend-url {
            font-family: monospace;
            font-size: 14px;
            color: #495057;
            word-break: break-all;
        }
        .backends-list {
            margin-bottom: 2rem;
        }
        .backend-item {
            display: flex;
            align-items: center;
            padding: 12px;
            border: 1px solid #e9ecef;
            border-radius: 6px;
            margin-bottom: 8px;
        }
        .health-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 12px;
        }
        .health-up { background: #28a745; }
        .health-down { background: #dc3545; }
        .health-unknown { background: #ffc107; }
        .backend-info {
            flex: 1;
        }
        .backend-meta {
            font-size: 12px;
            color: #6c757d;
            margin-top: 2px;
        }
        .footer {
            text-align: center;
            color: #6c757d;
            font-size: 12px;
            margin-top: 2rem;
        }
        .request-id {
            font-family: monospace;
            font-size: 11px;
            color: #adb5bd;
        }
        .time-info {
            margin-bottom: 10px;
            text-align: center;
            color: #495057;
            font-size: 14px;
        }
        .config-info {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .config-info h3 {
            color: #495057;
            margin-bottom: 10px;
            font-weight: 400;
        }
        .config-info ul {
            margin-left: 20px;
            color: #6c757d;
            font-size: 14px;
        }
        .optimization-info {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .optimization-info h3 {
            color: #856404;
            margin-bottom: 10px;
            font-weight: 400;
        }
        .optimization-info ul {
            margin-left: 20px;
            color: #856404;
            font-size: 14px;
        }
        .notification-info {
            background: #d1ecf1;
            border: 1px solid #bee5eb;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .notification-info h3 {
            color: #0c5460;
            margin-bottom: 10px;
            font-weight: 400;
        }
        .notification-info ul {
            margin-left: 20px;
            color: #0c5460;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="status-container">
        <h1>🚀 订阅转换高可用服务 (优化版)</h1>
        
        <div class="time-info">
            北京时间: ${beijingTimeStr}
        </div>
        
        <div class="status-header">
            <div class="status-badge ${availableBackend ? 'status-healthy' : (totalCount > 0 ? 'status-unhealthy' : 'status-unconfigured')}">
                ${status}
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${totalCount}</div>
                <div class="stat-label">总后端数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${healthyCount}</div>
                <div class="stat-label">健康后端</div>
            </div>
        </div>
        
        ${availableBackend ? `
        <div class="current-backend">
            <h3>当前使用后端</h3>
            <div class="backend-url">${availableBackend}</div>
            ${health[availableBackend]?.version ? `
            <div class="backend-meta">版本: ${health[availableBackend].version}</div>
            ` : ''}
            ${health[availableBackend]?.responseTime ? `
            <div class="backend-meta">响应时间: ${health[availableBackend].responseTime}ms</div>
            ` : ''}
        </div>
        ` : totalCount > 0 ? `
        <div class="current-backend" style="background: #f8d7da; border-color: #f5c6cb;">
            <h3 style="color: #721c24;">⚠️ 服务异常</h3>
            <div>所有后端服务器均不可用，服务已中断</div>
        </div>
        ` : `
        <div class="current-backend" style="background: #e2e3e5; border-color: #d6d8db;">
            <h3 style="color: #383d41;">⚪ 未配置</h3>
            <div>尚未配置后端服务器，请在Cloudflare Dashboard中配置BACKEND_URLS</div>
        </div>
        `}
        
        ${totalCount > 0 ? `
        <div class="backends-list">
            <h3 style="margin-bottom: 10px; color: #495057; font-weight: 400;">后端状态</h3>
            ${backends.map(url => {
              const status = health[url] || { healthy: null };
              const statusClass = status.healthy === true ? 'health-up' : 
                                status.healthy === false ? 'health-down' : 'health-unknown';
              const statusText = status.healthy === true ? '正常' : 
                                status.healthy === false ? '异常' : '未知';
              const timestamp = status.timestamp ? 
                new Date(status.timestamp).toLocaleTimeString('zh-CN') : '从未检查';
              
              return `
              <div class="backend-item">
                  <div class="health-indicator ${statusClass}"></div>
                  <div class="backend-info">
                      <div class="backend-url">${url}</div>
                      <div class="backend-meta">
                          状态: ${statusText} | 最后检查: ${timestamp}
                          ${status.responseTime ? ` | 响应时间: ${status.responseTime}ms` : ''}
                          ${status.error ? ` | 错误: ${status.error}` : ''}
                      </div>
                  </div>
              </div>`;
            }).join('')}
        </div>
        ` : ''}
        
        <div class="notification-info">
            <h3>🔔 通知系统</h3>
            <ul>
                <li>定时健康检查: 每5分钟执行一次，发送状态报告</li>
                <li>订阅转换请求: 每次请求发送通知，同一IP5分钟内不重复</li>
                <li>服务状态变化: 服务中断/恢复时发送即时通知</li>
                <li>IP通知冷却: ${IP_NOTIFICATION_COOLDOWN / 60000}分钟</li>
            </ul>
        </div>
        
        <div class="optimization-info">
            <h3>⚡ 性能优化特性</h3>
            <ul>
                <li>极速健康检查: ${FAST_CHECK_TIMEOUT}ms超时</li>
                <li>智能缓存: 响应时间排序的健康后端列表</li>
                <li>并行检查: 同时检查多个后端，选择最快的</li>
                <li>优化转发: 精简HTTP头，减少延迟</li>
                <li>缓存策略: ${FAST_CHECK_CACHE_TTL}ms快速检查缓存</li>
            </ul>
        </div>
        
        <div class="config-info">
            <h3>📋 配置说明</h3>
            <ul>
                <li>后端列表通过环境变量 <code>BACKEND_URLS</code> 配置</li>
                <li>Telegram通知通过 <code>TG_BOT_TOKEN</code> 和 <code>TG_CHAT_ID</code> 配置</li>
                <li>健康检查每5分钟自动执行一次</li>
                <li>状态页面: <code>/status</code></li>
                <li>API端点: <code>/api/health</code>, <code>/api/health-check</code>, <code>/api/config</code>, <code>/api/benchmark</code></li>
            </ul>
        </div>
        
        <div class="footer">
            <div>请求ID: <span class="request-id">${requestId}</span></div>
            <div>最后更新: ${new Date().toLocaleString('zh-CN')}</div>
        </div>
    </div>
</body>
</html>`;
  
  return new Response(html, {
    headers: { 
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
}

// 主处理函数
export default {
  async fetch(request, env, ctx) {
    const requestId = generateRequestId();
    const url = new URL(request.url);
    
    console.log(`[${requestId}] 收到请求: ${request.method} ${url.pathname}`);
    
    // 根路径显示状态页面
    if (url.pathname === '/' || url.pathname === '/status') {
      try {
        const kv = env.SUB_BACKENDS;
        const backends = await getBackends(env, requestId);
        const health = await getHealthStatus(kv, requestId, env);
        const availableBackend = await getLastAvailableBackend(kv, requestId);
        
        return createStatusPage(requestId, backends, health, availableBackend);
      } catch (error) {
        console.error(`[${requestId}] 创建状态页面失败:`, error);
        return new Response('服务状态页面暂时不可用', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }
    
    // API路由
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, requestId);
    }
    
    // 订阅转换请求
    try {
      const kv = env.SUB_BACKENDS;
      
      // 检查是否有后端配置
      const backends = await getBackends(env, requestId);
      if (backends.length === 0) {
        return new Response('未配置后端服务器，请在Cloudflare Dashboard中配置BACKEND_URLS', {
          status: 503,
          headers: { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Request-ID': requestId
          }
        });
      }
      
      const previousAvailableBackend = await getLastAvailableBackend(kv, requestId);
      const backendUrl = await findAvailableBackendForRequest(kv, requestId, env);
      
      if (!backendUrl) {
        console.log(`[${requestId}] 无可用后端，返回503`);
        
        // 发送服务不可用通知（如果之前是可用的）
        if (previousAvailableBackend) {
          const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
          const chatId = getConfig(env, 'TG_CHAT_ID', '');
          if (botToken && chatId) {
            ctx.waitUntil(sendServiceStatusNotification(false, null, requestId, env));
          }
        }
        
        return new Response('所有后端服务均不可用，请稍后重试', {
          status: 503,
          headers: { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Retry-After': '30',
            'X-Request-ID': requestId
          }
        });
      }
      
      console.log(`[${requestId}] 使用后端: ${backendUrl}`);
      
      // 发送服务恢复通知（如果之前是不可用的）
      if (!previousAvailableBackend) {
        const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
        const chatId = getConfig(env, 'TG_CHAT_ID', '');
        if (botToken && chatId) {
          ctx.waitUntil(sendServiceStatusNotification(true, backendUrl, requestId, env));
        }
      }
      
      const response = await handleSubconverterRequest(request, backendUrl, requestId, env, ctx);
      
      // 记录成功请求
      console.log(`[${requestId}] 请求处理完成，状态码: ${response.status}`);
      
      return response;
    } catch (error) {
      console.error(`[${requestId}] 处理请求失败:`, error);
      return new Response(`服务错误: ${error.message}`, {
        status: 500,
        headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Request-ID': requestId
        }
      });
    }
  },
  
  // Cron触发器处理
  async scheduled(event, env, ctx) {
    const requestId = generateRequestId();
    console.log(`[${requestId}] Cron触发，开始执行健康检查`);
    
    try {
      const kv = env.SUB_BACKENDS;
      const checkResults = await performFullHealthCheck(kv, requestId, env);
      
      // 发送Telegram通知
      const botToken = getConfig(env, 'TG_BOT_TOKEN', '');
      const chatId = getConfig(env, 'TG_CHAT_ID', '');
      if (botToken && chatId) {
        console.log(`[${requestId}] 发送Telegram通知`);
        ctx.waitUntil(sendTelegramNotification(checkResults, requestId, env));
      } else {
        console.log(`[${requestId}] Telegram通知未配置，跳过发送`);
      }
      
      console.log(`[${requestId}] Cron健康检查完成`);
    } catch (error) {
      console.error(`[${requestId}] Cron健康检查失败:`, error);
    }
  }
};