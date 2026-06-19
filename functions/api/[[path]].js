// Cloudflare Pages Function - API Proxy with D1 Cache
// 处理所有 /api/* 请求

import {
  calcMA, calcMACD, calcRSI, calcKDJ, calcBOLL,
  calcOBV, calcWR, calcDMI, calcCCI, calcVOL,
  detectSignals, calcScore, calcAllIndicators, screenStock,
  runBacktest
} from './indicators-engine.js';

import {
  initDB, cacheKey, cacheGet, cacheSet,
  cleanExpired, cacheStats, CACHE_TTL
} from './cache.js';

// ---- 市场前缀判断（修复指数代码） ----
const SH_INDEX = new Set(['000001','000016','000300','000688','000905','000010','000012','000013','000015','000031','000032','000033']);
const SZ_INDEX = new Set(['399001','399002','399003','399004','399005','399006','399100','399101','399102','399103','399106','399300','399330','399606','399673','399678','399903','399905','399975','399986','399987','399990','399991','399992','399993','399994','399995','399996','399997','399998','399999']);

function getMarketPrefix(symbol) {
  if (SH_INDEX.has(symbol)) return 'sh';
  if (SZ_INDEX.has(symbol)) return 'sz';
  return symbol.startsWith('6') || symbol.startsWith('9') ? 'sh' : 'sz';
}

// D1 实例缓存（避免重复初始化）
let _db = null;
let _dbInited = false;

function getDB(env) {
  if (_db) return _db;
  // CF Pages Functions: D1 binding 通过 env 传入
  if (env?.DB) {
    _db = env.DB;
    return _db;
  }
  return null;
}

async function ensureDB(env) {
  const db = getDB(env);
  if (db && !_dbInited) {
    await initDB(db);
    _dbInited = true;
  }
  return db;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace('/api/', '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 初始化 DB（如果可用）
    const db = await ensureDB(context.env);
    let data;

    switch (path) {
      case 'quote':
        data = await handleQuote(url, db);
        break;
      case 'kline':
        data = await handleKline(url, db);
        break;
      case 'indicators':
        data = await handleIndicators(url, db);
        break;
      case 'signals':
        data = await handleSignals(url, db);
        break;
      case 'screen':
        data = await handleScreen(url, db);
        break;
      case 'backtest':
        data = await handleBacktest(url, db);
        break;
      case 'fund':
        data = await handleFund(url, db);
        break;
      case 'fund-nav':
        data = await handleFundNav(url, db);
        break;
      case 'health':
        data = { ok: true, ts: Date.now(), db: !!db };
        break;
      case 'cache-stats':
        data = await cacheStats(db);
        break;
      case 'cache-clean':
        data = await cleanExpired(db);
        break;
      default:
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: corsHeaders });
    }

    return new Response(JSON.stringify(data), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

// ---- 股票实时行情（带缓存） ----
async function handleQuote(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  if (!symbol) throw new Error('missing symbol');

  const key = cacheKey('quote', symbol, market);

  // 尝试从缓存读取
  const cached = await cacheGet(db, key, CACHE_TTL.quote);
  if (cached) return cached;

  // 从 API 获取
  let result = null;

  if (market === 'A') {
    const prefix = getMarketPrefix(symbol);
    const resp = await fetch(`https://hq.sinajs.cn/list=${prefix}${symbol}`, {
      headers: { 'Referer': 'https://finance.sina.com.cn' }
    });
    const text = await resp.text();
    result = parseSinaQuote(text);
  }

  if (market === 'US' && !result) {
    try {
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await resp.json();
      const r = data?.chart?.result?.[0];
      if (r) {
        const meta = r.meta;
        const prev = meta.chartPreviousClose || meta.previousClose;
        result = {
          name: meta.shortName || symbol,
          price: meta.regularMarketPrice,
          prevClose: prev,
          open: meta.regularMarketPrice,
          high: meta.regularMarketDayHigh || meta.regularMarketPrice,
          low: meta.regularMarketDayLow || meta.regularMarketPrice,
          volume: meta.regularMarketVolume || 0,
          change: meta.regularMarketPrice - prev,
          changePercent: ((meta.regularMarketPrice - prev) / prev) * 100
        };
      }
    } catch (e) { /* fallback */ }
  }

  if (!result) throw new Error('not found');

  // 写入缓存
  await cacheSet(db, key, 'quote', result, symbol, market);
  return result;
}

// ---- K线数据（带缓存） ----
async function handleKline(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1w';
  if (!symbol) throw new Error('missing symbol');

  const ttlKey = `kline_${period}`;
  const ttl = CACHE_TTL[ttlKey] || CACHE_TTL.kline_1w;
  const key = cacheKey('kline', symbol, market, period);

  // 尝试从缓存读取
  const cached = await cacheGet(db, key, ttl);
  if (cached) return cached;

  // 从 API 获取
  let result = [];

  if (market === 'A') {
    // 主力数据源：新浪财经 K 线 API（scale=240 = 日K）
    const prefix = getMarketPrefix(symbol);
    const countMap = { '1d': 30, '1w': 60, '1m': 120, '3m': 180, '6m': 250, '1y': 365 };
    const count = countMap[period] || 60;

    try {
      const resp = await fetch(
        `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${prefix}${symbol}&scale=240&ma=no&datalen=${count}`
      );
      const data = await resp.json();
      if (Array.isArray(data) && data.length) {
        result = data.map(k => ({
          date: k.day, open: +k.open, close: +k.close,
          high: +k.high, low: +k.low, volume: +k.volume || 0
        }));
      }
    } catch (e) { /* fallback to Tencent */ }

    // 备用数据源：腾讯财经
    if (!result.length) {
      try {
        const periodMap = { '1d': 'day', '1w': 'week', '1m': 'month', '3m': 'month', '6m': 'month', '1y': 'month' };
        const countMap2 = { '1d': 30, '1w': 60, '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
        const p = periodMap[period] || 'day';
        const c = countMap2[period] || 60;
        const prefix2 = getMarketPrefix(symbol) === 'sh' ? '1' : '0';
        const resp = await fetch(
          `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix2}${symbol},${p},,,${c},qfq`
        );
        const json_data = await resp.json();
        const stock = json_data?.data?.[`${prefix2}${symbol}`];
        const klines = stock?.[`qfq${p}`] || stock?.[p];
        if (klines && klines.length) {
          result = klines.map(k => ({
            date: k[0], open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] || 0
          }));
        }
      } catch (e) { /* skip */ }
    }
  }

  if (market === 'US' && !result.length) {
    try {
      const rangeMap = { '1d': '1mo', '1w': '3mo', '1m': '3mo', '3m': '6mo', '6m': '1y', '1y': '2y' };
      const range = rangeMap[period] || '3mo';
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await resp.json();
      const r = data?.chart?.result?.[0];
      if (r) {
        const ts = r.timestamp || [];
        const q = r.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if (q.close?.[i] == null) continue;
          result.push({
            date: new Date(ts[i] * 1000).toISOString().split('T')[0],
            open: +q.open[i], close: +q.close[i],
            high: +q.high[i], low: +q.low[i],
            volume: q.volume?.[i] || 0
          });
        }
      }
    } catch (e) { /* fallback */ }
  }

  if (result.length) {
    await cacheSet(db, key, 'kline', result, symbol, market);
  }
  return result;
}

// ---- 技术指标 API（带缓存） ----
async function handleIndicators(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1y';
  if (!symbol) throw new Error('missing symbol');

  const key = cacheKey('indicators', symbol, market, period);
  const cached = await cacheGet(db, key, CACHE_TTL.indicators);
  if (cached) return cached;

  const klineUrl = new URL(url);
  klineUrl.searchParams.set('period', period);
  const klineData = await handleKline(klineUrl, db);

  if (!klineData || klineData.length < 5) {
    return { error: '数据不足', symbol, market };
  }

  const indicators = calcAllIndicators(klineData);
  const scoreResult = calcScore(klineData);

  const result = {
    symbol, market,
    dataPoints: klineData.length,
    latestDate: klineData[klineData.length - 1]?.date,
    latestPrice: klineData[klineData.length - 1]?.close,
    indicators,
    score: {
      total: scoreResult.score, max: scoreResult.maxScore,
      percent: scoreResult.percent, trend: scoreResult.trend,
      trendClass: scoreResult.trendClass, confidence: scoreResult.confidenceLabel
    }
  };

  await cacheSet(db, key, 'indicators', result, symbol, market);
  return result;
}

// ---- 信号检测 API（带缓存） ----
async function handleSignals(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1y';
  if (!symbol) throw new Error('missing symbol');

  const key = cacheKey('signals', symbol, market, period);
  const cached = await cacheGet(db, key, CACHE_TTL.signals);
  if (cached) return cached;

  const klineUrl = new URL(url);
  klineUrl.searchParams.set('period', period);
  const klineData = await handleKline(klineUrl, db);

  if (!klineData || klineData.length < 60) {
    return { signals: [], message: '数据不足（需至少60个交易日）' };
  }

  const signals = detectSignals(klineData);
  const scoreResult = calcScore(klineData);

  const result = {
    symbol, market,
    dataPoints: klineData.length,
    trend: scoreResult.trend, trendClass: scoreResult.trendClass,
    score: scoreResult.score, maxScore: scoreResult.maxScore,
    confidence: scoreResult.confidenceLabel, signals
  };

  await cacheSet(db, key, 'signals', result, symbol, market);
  return result;
}

// ---- 选股评分 API ----
async function handleScreen(url, db) {
  const symbols = url.searchParams.get('symbols');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  if (!symbols) throw new Error('missing symbols (comma separated)');

  const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  const results = [];

  for (const symbol of symbolList.slice(0, 20)) {
    try {
      const klineUrl = new URL(url);
      klineUrl.searchParams.set('symbol', symbol);
      klineUrl.searchParams.set('period', '1y');
      const klineData = await handleKline(klineUrl, db);

      if (klineData && klineData.length >= 60) {
        const result = screenStock(klineData);
        if (result) results.push({ symbol, ...result });
      }
    } catch (e) { /* skip */ }
  }

  results.sort((a, b) => b.score - a.score);
  return { count: results.length, results };
}

// ---- 回测 API（带缓存） ----
async function handleBacktest(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const strategy = url.searchParams.get('strategy') || 'macd_cross';
  const period = url.searchParams.get('period') || '1y';
  const initCash = parseFloat(url.searchParams.get('initCash')) || 100000;
  const stopLoss = parseFloat(url.searchParams.get('stopLoss')) || null;
  const stopProfit = parseFloat(url.searchParams.get('stopProfit')) || null;
  if (!symbol) throw new Error('missing symbol');

  const cacheExtra = `${strategy}_${initCash}_${stopLoss || 0}_${stopProfit || 0}`;
  const key = cacheKey('backtest', symbol, market, `${period}_${cacheExtra}`);
  const cached = await cacheGet(db, key, CACHE_TTL.backtest);
  if (cached) return cached;

  const klineUrl = new URL(url);
  klineUrl.searchParams.set('period', period);
  const klineData = await handleKline(klineUrl, db);

  if (!klineData || klineData.length < 60) {
    return { error: '数据不足，需要至少60个交易日', symbol, dataPoints: klineData?.length || 0 };
  }

  const result = { symbol, market, ...runBacktest(klineData, strategy, { initCash, stopLoss, stopProfit }) };
  await cacheSet(db, key, 'backtest', result, symbol, market);
  return result;
}

// ---- 基金信息（带缓存） ----
async function handleFund(url, db) {
  const code = url.searchParams.get('code');
  if (!code) throw new Error('missing code');

  const key = cacheKey('fund', code, 'FUND');
  const cached = await cacheGet(db, key, CACHE_TTL.fund);
  if (cached) return cached;

  const resp = await fetch(`https://fundgz.1702.com/js/${code}.js`, {
    headers: { 'Referer': 'https://fund.eastmoney.com' }
  });
  const text = await resp.text();
  const match = text.match(/jsonpgz\((.+)\)/);
  if (match) {
    const d = JSON.parse(match[1]);
    const result = {
      code: d.fundcode, name: d.name,
      nav: +d.dwjz, navDate: d.jzrq,
      estimate: +d.gsz, estimateChange: +d.gszzl, estimateTime: d.gztime
    };
    await cacheSet(db, key, 'fund', result, code, 'FUND');
    return result;
  }
  throw new Error('not found');
}

// ---- 基金历史净值（带缓存） ----
async function handleFundNav(url, db) {
  const code = url.searchParams.get('code');
  const days = url.searchParams.get('days') || '180';
  if (!code) throw new Error('missing code');

  const key = cacheKey('fund_nav', code, 'FUND', days);
  const cached = await cacheGet(db, key, CACHE_TTL.fund_nav);
  if (cached) return cached;

  const resp = await fetch(
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${days}`,
    { headers: { 'Referer': 'https://fund.eastmoney.com' } }
  );
  const data = await resp.json();
  const list = data?.Data?.LSJZList || [];
  const result = list.reverse().map(item => ({
    date: item.FSRQ, nav: +item.DWJZ, accNav: +item.LJJZ, change: +item.JZZZL || 0
  }));

  await cacheSet(db, key, 'fund_nav', result, code, 'FUND');
  return result;
}

// ---- 工具函数 ----
function parseSinaQuote(text) {
  try {
    const match = text.match(/="(.+)"/);
    if (!match) return null;
    const p = match[1].split(',');
    if (p.length < 32) return null;
    const price = parseFloat(p[3]);
    const prevClose = parseFloat(p[2]);
    return {
      name: p[0], open: parseFloat(p[1]), prevClose, price,
      high: parseFloat(p[4]), low: parseFloat(p[5]),
      volume: parseInt(p[8]), amount: parseFloat(p[9]),
      change: price - prevClose,
      changePercent: ((price - prevClose) / prevClose) * 100
    };
  } catch { return null; }
}
