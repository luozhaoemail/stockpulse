// ============================================================
// StockPulse 技术指标计算引擎
// 支持: MA, EMA, MACD, RSI, KDJ, BOLL, OBV, WR, DMI, CCI, VOL, 信号检测
// ============================================================

// ---- 基础函数 ----

function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(+(sum / period).toFixed(4));
  }
  return result;
}

function EMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push(+data[0].toFixed(4)); continue; }
    ema = data[i] * k + ema * (1 - k);
    result.push(+ema.toFixed(4));
  }
  return result;
}

// ---- 均线系统 ----

function calcMA(closes, periods = [5, 10, 20, 60, 120, 250]) {
  const result = {};
  for (const p of periods) {
    result[`ma${p}`] = SMA(closes, p);
  }
  return result;
}

function calcEMA_IND(closes, periods = [12, 26]) {
  const result = {};
  for (const p of periods) {
    result[`ema${p}`] = EMA(closes, p);
  }
  return result;
}

// ---- MACD (12, 26, 9) ----

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const dif = emaFast.map((v, i) => +(v - emaSlow[i]).toFixed(4));
  const dea = EMA(dif, signal);
  const macd = dif.map((v, i) => +((v - dea[i]) * 2).toFixed(4));
  return { dif, dea, macd };
}

// ---- RSI (相对强弱指标) ----

function calcRSI(closes, period = 14) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) { result.push(null); continue; }
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rs = losses === 0 ? 100 : gains / losses;
    result.push(+(100 - 100 / (1 + rs)).toFixed(2));
  }
  return result;
}

// ---- KDJ (随机指标) ----

function calcKDJ(highs, lows, closes, period = 9) {
  const k = [], d = [], j = [];
  let prevK = 50, prevD = 50;

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      k.push(null); d.push(null); j.push(null);
      continue;
    }
    let hMax = -Infinity, lMin = Infinity;
    for (let t = i - period + 1; t <= i; t++) {
      hMax = Math.max(hMax, highs[t]);
      lMin = Math.min(lMin, lows[t]);
    }
    const rsv = hMax === lMin ? 50 : ((closes[i] - lMin) / (hMax - lMin)) * 100;
    const kv = 2 / 3 * prevK + 1 / 3 * rsv;
    const dv = 2 / 3 * prevD + 1 / 3 * kv;
    const jv = 3 * kv - 2 * dv;
    k.push(+kv.toFixed(2));
    d.push(+dv.toFixed(2));
    j.push(+jv.toFixed(2));
    prevK = kv; prevD = dv;
  }
  return { k, d, j };
}

// ---- BOLL (布林带) ----

function calcBOLL(closes, period = 20, multiplier = 2) {
  const ma = SMA(closes, period);
  const upper = [], lower = [], bandwidth = [], percentB = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null); lower.push(null); bandwidth.push(null); percentB.push(null);
      continue;
    }
    let sumSq = 0;
    for (let t = i - period + 1; t <= i; t++) {
      sumSq += Math.pow(closes[t] - ma[i], 2);
    }
    const std = Math.sqrt(sumSq / period);
    const u = +(ma[i] + multiplier * std).toFixed(4);
    const l = +(ma[i] - multiplier * std).toFixed(4);
    upper.push(u);
    lower.push(l);
    bandwidth.push(+((u - l) / ma[i] * 100).toFixed(2));
    percentB.push(+((closes[i] - l) / (u - l) * 100).toFixed(2));
  }
  return { ma, upper, lower, bandwidth, percentB };
}

// ---- OBV (能量潮) ----

function calcOBV(closes, volumes) {
  const result = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) result.push(result[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) result.push(result[i - 1] - volumes[i]);
    else result.push(result[i - 1]);
  }
  const obvMa = SMA(result, 20);
  return { obv: result, obvMa };
}

// ---- WR (威廉指标) ----

function calcWR(highs, lows, closes, period = 14) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let hMax = -Infinity, lMin = Infinity;
    for (let t = i - period + 1; t <= i; t++) {
      hMax = Math.max(hMax, highs[t]);
      lMin = Math.min(lMin, lows[t]);
    }
    const wr = hMax === lMin ? 50 : ((hMax - closes[i]) / (hMax - lMin)) * -100;
    result.push(+wr.toFixed(2));
  }
  return result;
}

// ---- DMI (趋向指标) ----

function calcDMI(highs, lows, closes, period = 14) {
  const pDI = [], nDI = [], adx = [], adxr = [];
  const tr = [], pDM = [], nDM = [];

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
      pDM.push(0); nDM.push(0);
      pDI.push(null); nDI.push(null); adx.push(null); adxr.push(null);
      continue;
    }
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));

    const upMove = highs[i] - highs[i - 1];
    const dnMove = lows[i - 1] - lows[i];
    pDM.push(upMove > dnMove && upMove > 0 ? upMove : 0);
    nDM.push(dnMove > upMove && dnMove > 0 ? dnMove : 0);

    if (i < period) {
      pDI.push(null); nDI.push(null); adx.push(null); adxr.push(null);
      continue;
    }

    let sumTR = 0, sumPDM = 0, sumNDM = 0;
    for (let t = i - period + 1; t <= i; t++) {
      sumTR += tr[t]; sumPDM += pDM[t]; sumNDM += nDM[t];
    }
    const pdi = sumTR === 0 ? 0 : (sumPDM / sumTR) * 100;
    const ndi = sumTR === 0 ? 0 : (sumNDM / sumTR) * 100;
    pDI.push(+pdi.toFixed(2));
    nDI.push(+ndi.toFixed(2));

    const dx = (pdi + ndi) === 0 ? 0 : (Math.abs(pdi - ndi) / (pdi + ndi)) * 100;
    adx.push(+dx.toFixed(2));

    if (i >= period * 2 - 1) {
      let sumADX = 0;
      for (let t = i - period + 1; t <= i; t++) sumADX += adx[t];
      adxr.push(+((adx[i] + sumADX / period) / 2).toFixed(2));
    } else {
      adxr.push(null);
    }
  }
  return { pDI, nDI, adx, adxr };
}

// ---- CCI (顺势指标) ----

function calcCCI(highs, lows, closes, period = 14) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const tp = [];
    for (let t = i - period + 1; t <= i; t++) {
      tp.push((highs[t] + lows[t] + closes[t]) / 3);
    }
    const ma = tp.reduce((a, b) => a + b, 0) / tp.length;
    const md = tp.reduce((a, b) => a + Math.abs(b - ma), 0) / tp.length;
    const cci = md === 0 ? 0 : ((highs[i] + lows[i] + closes[i]) / 3 - ma) / (0.015 * md);
    result.push(+cci.toFixed(2));
  }
  return result;
}

// ---- 成交量分析 ----

function calcVOL(volumes, periods = [5, 10, 20]) {
  const result = {};
  for (const p of periods) {
    result[`vma${p}`] = SMA(volumes, p);
  }
  // 量比
  const ratio = [];
  for (let i = 0; i < volumes.length; i++) {
    if (i < 5) { ratio.push(null); continue; }
    const avg = volumes.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
    ratio.push(+(volumes[i] / (avg || 1)).toFixed(2));
  }
  result.ratio = ratio;
  return result;
}

// ---- 信号检测 ----

function detectSignals(klineData) {
  if (!klineData || klineData.length < 60) return [];

  const closes = klineData.map(d => d.close);
  const highs = klineData.map(d => d.high);
  const lows = klineData.map(d => d.low);
  const volumes = klineData.map(d => d.volume);
  const len = closes.length;
  const signals = [];
  const last = len - 1;

  // MACD
  const macd = calcMACD(closes);
  if (macd.dif[last] > macd.dea[last] && macd.dif[last - 1] <= macd.dea[last - 1]) {
    signals.push({ name: 'MACD金叉', type: 'bullish', strength: 8, detail: `DIF上穿DEA` });
  }
  if (macd.dif[last] < macd.dea[last] && macd.dif[last - 1] >= macd.dea[last - 1]) {
    signals.push({ name: 'MACD死叉', type: 'bearish', strength: 8, detail: `DIF下穿DEA` });
  }
  // MACD零轴上方金叉更强
  if (macd.dif[last] > macd.dea[last] && macd.dif[last - 1] <= macd.dea[last - 1] && macd.dif[last] > 0) {
    signals.push({ name: 'MACD零轴上金叉', type: 'bullish', strength: 9, detail: '强势信号' });
  }

  // KDJ
  const kdj = calcKDJ(highs, lows, closes);
  if (kdj.k[last] > kdj.d[last] && kdj.k[last - 1] <= kdj.d[last - 1]) {
    const strength = kdj.j[last] < 20 ? 9 : 6;
    signals.push({ name: 'KDJ金叉', type: 'bullish', strength, detail: `J=${kdj.j[last]?.toFixed(0)}` });
  }
  if (kdj.k[last] < kdj.d[last] && kdj.k[last - 1] >= kdj.d[last - 1]) {
    const strength = kdj.j[last] > 80 ? 9 : 6;
    signals.push({ name: 'KDJ死叉', type: 'bearish', strength, detail: `J=${kdj.j[last]?.toFixed(0)}` });
  }

  // RSI
  const rsi = calcRSI(closes);
  if (rsi[last] !== null) {
    if (rsi[last] < 20) signals.push({ name: 'RSI极度超卖', type: 'bullish', strength: 8, detail: `RSI=${rsi[last]}` });
    else if (rsi[last] < 30) signals.push({ name: 'RSI超卖', type: 'bullish', strength: 6, detail: `RSI=${rsi[last]}` });
    else if (rsi[last] > 80) signals.push({ name: 'RSI极度超买', type: 'bearish', strength: 8, detail: `RSI=${rsi[last]}` });
    else if (rsi[last] > 70) signals.push({ name: 'RSI超买', type: 'bearish', strength: 6, detail: `RSI=${rsi[last]}` });
  }

  // BOLL
  const boll = calcBOLL(closes);
  if (boll.percentB[last] !== null) {
    if (closes[last] <= boll.lower[last]) signals.push({ name: '触及布林下轨', type: 'bullish', strength: 7, detail: '可能反弹' });
    if (closes[last] >= boll.upper[last]) signals.push({ name: '触及布林上轨', type: 'bearish', strength: 7, detail: '可能回调' });
    // 布林收口
    if (boll.bandwidth[last] !== null && boll.bandwidth[last] < 5) {
      signals.push({ name: '布林收口', type: 'neutral', strength: 5, detail: `带宽${boll.bandwidth[last]}%，变盘在即` });
    }
  }

  // 均线系统
  const ma5 = SMA(closes, 5);
  const ma10 = SMA(closes, 10);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);

  // MA金叉/死叉
  if (ma5[last] > ma10[last] && ma5[last - 1] <= ma10[last - 1]) {
    signals.push({ name: 'MA5/10金叉', type: 'bullish', strength: 5, detail: '短期趋势转多' });
  }
  if (ma5[last] < ma10[last] && ma5[last - 1] >= ma10[last - 1]) {
    signals.push({ name: 'MA5/10死叉', type: 'bearish', strength: 5, detail: '短期趋势转空' });
  }

  // 多头/空头排列
  if (ma5[last] > ma10[last] && ma10[last] > ma20[last] && ma20[last] > ma60[last]) {
    signals.push({ name: '均线多头排列', type: 'bullish', strength: 7, detail: 'MA5>MA10>MA20>MA60' });
  }
  if (ma5[last] < ma10[last] && ma10[last] < ma20[last] && ma20[last] < ma60[last]) {
    signals.push({ name: '均线空头排列', type: 'bearish', strength: 7, detail: 'MA5<MA10<MA20<MA60' });
  }

  // 放量/缩量
  const vol = calcVOL(volumes);
  if (vol.ratio[last] !== null) {
    if (vol.ratio[last] > 2) {
      const priceUp = closes[last] > closes[last - 1];
      signals.push({
        name: priceUp ? '放量上涨' : '放量下跌',
        type: priceUp ? 'bullish' : 'bearish',
        strength: 7,
        detail: `量比${vol.ratio[last]}`
      });
    } else if (vol.ratio[last] < 0.5) {
      signals.push({ name: '缩量', type: 'neutral', strength: 3, detail: `量比${vol.ratio[last]}` });
    }
  }

  // OBV趋势
  const obv = calcOBV(closes, volumes);
  if (obv.obvMa[last] !== null) {
    if (obv.obv[last] > obv.obvMa[last] && obv.obv[last - 1] <= obv.obvMa[last - 1]) {
      signals.push({ name: 'OBV上穿均线', type: 'bullish', strength: 5, detail: '资金流入' });
    }
    if (obv.obv[last] < obv.obvMa[last] && obv.obv[last - 1] >= obv.obvMa[last - 1]) {
      signals.push({ name: 'OBV下穿均线', type: 'bearish', strength: 5, detail: '资金流出' });
    }
  }

  // WR
  const wr = calcWR(highs, lows, closes);
  if (wr[last] !== null) {
    if (wr[last] < -80) signals.push({ name: 'WR超卖', type: 'bullish', strength: 5, detail: `WR=${wr[last]}` });
    if (wr[last] > -20) signals.push({ name: 'WR超买', type: 'bearish', strength: 5, detail: `WR=${wr[last]}` });
  }

  // CCI
  const cci = calcCCI(highs, lows, closes);
  if (cci[last] !== null) {
    if (cci[last] < -100) signals.push({ name: 'CCI超卖', type: 'bullish', strength: 6, detail: `CCI=${cci[last]}` });
    if (cci[last] > 100) signals.push({ name: 'CCI超买', type: 'bearish', strength: 6, detail: `CCI=${cci[last]}` });
  }

  return signals;
}

// ---- 综合评分 ----

function calcScore(klineData) {
  const signals = detectSignals(klineData);
  if (signals.length === 0) return { score: 0, maxScore: 0, percent: 0, trend: '数据不足', trendClass: 'neutral' };

  let score = 0;
  let maxScore = 0;
  for (const s of signals) {
    maxScore += s.strength;
    if (s.type === 'bullish') score += s.strength;
    else if (s.type === 'bearish') score -= s.strength;
  }

  const percent = maxScore === 0 ? 0 : +((score / maxScore) * 100).toFixed(1);
  let trend, trendClass;
  if (percent > 25) { trend = '看多'; trendClass = 'bullish'; }
  else if (percent < -25) { trend = '看空'; trendClass = 'bearish'; }
  else { trend = '震荡'; trendClass = 'neutral'; }

  const bullishCount = signals.filter(s => s.type === 'bullish').length;
  const bearishCount = signals.filter(s => s.type === 'bearish').length;
  const confidence = Math.abs(bullishCount - bearishCount) / signals.length;
  const confidenceLabel = confidence > 0.5 ? '高' : confidence > 0.2 ? '中' : '低';

  return { score, maxScore, percent, trend, trendClass, confidence, confidenceLabel, signals };
}

// ---- 计算全部指标（用于 API 返回） ----

function calcAllIndicators(klineData) {
  if (!klineData || klineData.length < 5) return null;

  const closes = klineData.map(d => d.close);
  const highs = klineData.map(d => d.high);
  const lows = klineData.map(d => d.low);
  const volumes = klineData.map(d => d.volume);
  const last = closes.length - 1;

  const ma = calcMA(closes, [5, 10, 20, 60, 120, 250]);
  const macd = calcMACD(closes);
  const rsi = calcRSI(closes);
  const kdj = calcKDJ(highs, lows, closes);
  const boll = calcBOLL(closes);
  const obv = calcOBV(closes, volumes);
  const wr = calcWR(highs, lows, closes);
  const dmi = calcDMI(highs, lows, closes);
  const cci = calcCCI(highs, lows, closes);
  const vol = calcVOL(volumes, [5, 10, 20]);

  const get = (arr) => arr[last] !== null && arr[last] !== undefined ? arr[last] : null;

  return {
    ma: {
      ma5: get(ma.ma5), ma10: get(ma.ma10), ma20: get(ma.ma20),
      ma60: get(ma.ma60), ma120: get(ma.ma120), ma250: get(ma.ma250)
    },
    macd: { dif: get(macd.dif), dea: get(macd.dea), macd: get(macd.macd) },
    rsi: { rsi6: get(calcRSI(closes, 6)), rsi12: get(calcRSI(closes, 12)), rsi14: get(rsi) },
    kdj: { k: get(kdj.k), d: get(kdj.d), j: get(kdj.j) },
    boll: {
      upper: get(boll.upper), mid: get(boll.ma), lower: get(boll.lower),
      bandwidth: get(boll.bandwidth), percentB: get(boll.percentB)
    },
    obv: { value: get(obv.obv), ma: get(obv.obvMa) },
    wr: { wr14: get(wr) },
    dmi: { pDI: get(dmi.pDI), nDI: get(dmi.nDI), adx: get(dmi.adx), adxr: get(dmi.adxr) },
    cci: { cci14: get(cci) },
    vol: {
      vma5: get(vol.vma5), vma10: get(vol.vma10), vma20: get(vol.vma20),
      ratio: get(vol.ratio)
    }
  };
}

// ---- 选股评分 ----

function screenStock(klineData) {
  if (!klineData || klineData.length < 60) return null;

  const scoreResult = calcScore(klineData);
  const indicators = calcAllIndicators(klineData);
  if (!indicators) return null;

  let totalScore = 0;
  const reasons = [];

  // MACD 底部金叉 +15
  if (indicators.macd.dif > indicators.macd.dea && indicators.macd.dif < 0) {
    totalScore += 15;
    reasons.push('MACD底部金叉');
  }
  // MACD 金叉 +10
  if (indicators.macd.dif > indicators.macd.dea && indicators.macd.macd > 0) {
    totalScore += 10;
    reasons.push('MACD多头');
  }

  // RSI 超卖反弹 +12
  if (indicators.rsi.rsi14 < 35) {
    totalScore += 12;
    reasons.push('RSI超卖区');
  }

  // KDJ 超卖金叉 +10
  if (indicators.kdj.j < 25) {
    totalScore += 10;
    reasons.push('KDJ超卖');
  }

  // 布林下轨 +10
  if (indicators.boll.percentB !== null && indicators.boll.percentB < 15) {
    totalScore += 10;
    reasons.push('接近布林下轨');
  }

  // 放量 +8
  if (indicators.vol.ratio > 1.5) {
    totalScore += 8;
    reasons.push('放量');
  }

  // CCI超卖 +8
  if (indicators.cci.cci14 !== null && indicators.cci.cci14 < -100) {
    totalScore += 8;
    reasons.push('CCI超卖');
  }

  // WR超卖 +6
  if (indicators.wr.wr14 !== null && indicators.wr.wr14 < -80) {
    totalScore += 6;
    reasons.push('WR超卖');
  }

  // 均线多头排列 +15
  if (indicators.ma.ma5 > indicators.ma.ma10 && indicators.ma.ma10 > indicators.ma.ma20) {
    totalScore += 15;
    reasons.push('均线多头');
  }

  // 均线空头排列 -10
  if (indicators.ma.ma5 < indicators.ma.ma10 && indicators.ma.ma10 < indicators.ma.ma20) {
    totalScore -= 10;
    reasons.push('均线空头');
  }

  return {
    score: totalScore,
    maxScore: 100,
    trend: scoreResult.trend,
    trendClass: scoreResult.trendClass,
    reasons,
    indicators
  };
}

// ---- 回测引擎 ----

/**
 * 回测策略执行器
 * @param {Array} klineData - K线数据 [{date, open, close, high, low, volume}]
 * @param {string} strategy - 策略名称
 * @param {Object} params - 策略参数
 * @returns {Object} 回测结果
 */
function runBacktest(klineData, strategy = 'macd_cross', params = {}) {
  if (!klineData || klineData.length < 60) {
    return { error: '数据不足，需要至少60个交易日' };
  }

  const closes = klineData.map(d => d.close);
  const highs = klineData.map(d => d.high);
  const lows = klineData.map(d => d.low);
  const volumes = klineData.map(d => d.volume);
  const len = closes.length;

  // 预计算指标
  const macd = calcMACD(closes);
  const rsi = calcRSI(closes, params.rsiPeriod || 14);
  const kdj = calcKDJ(highs, lows, closes);
  const ma5 = SMA(closes, 5);
  const ma10 = SMA(closes, 10);
  const ma20 = SMA(closes, 20);
  const boll = calcBOLL(closes);
  const wr = calcWR(highs, lows, closes);
  const cci = calcCCI(highs, lows, closes);

  // 策略信号函数
  const strategies = {
    // MACD金叉买入，死叉卖出
    macd_cross: {
      name: 'MACD金叉死叉',
      buy: (i) => macd.dif[i] > macd.dea[i] && macd.dif[i - 1] <= macd.dea[i - 1],
      sell: (i) => macd.dif[i] < macd.dea[i] && macd.dif[i - 1] >= macd.dea[i - 1]
    },
    // MACD零轴上方金叉（更强信号）
    macd_strong: {
      name: 'MACD强势金叉',
      buy: (i) => macd.dif[i] > macd.dea[i] && macd.dif[i - 1] <= macd.dea[i - 1] && macd.dif[i] > 0,
      sell: (i) => macd.dif[i] < macd.dea[i] && macd.dif[i - 1] >= macd.dea[i - 1]
    },
    // RSI超卖买入，超买卖出
    rsi: {
      name: 'RSI超买超卖',
      buy: (i) => rsi[i] !== null && rsi[i] < (params.rsiOversold || 30) && rsi[i - 1] >= (params.rsiOversold || 30),
      sell: (i) => rsi[i] !== null && rsi[i] > (params.rsiOverbought || 70) && rsi[i - 1] <= (params.rsiOverbought || 70)
    },
    // KDJ金叉买入，死叉卖出
    kdj_cross: {
      name: 'KDJ金叉死叉',
      buy: (i) => kdj.k[i] > kdj.d[i] && kdj.k[i - 1] <= kdj.d[i - 1] && kdj.j[i] < 30,
      sell: (i) => kdj.k[i] < kdj.d[i] && kdj.k[i - 1] >= kdj.d[i - 1] && kdj.j[i] > 70
    },
    // 均线多头排列买入
    ma_trend: {
      name: '均线趋势',
      buy: (i) => ma5[i] > ma10[i] && ma10[i] > ma20[i] && !(ma5[i - 1] > ma10[i - 1] && ma10[i - 1] > ma20[i - 1]),
      sell: (i) => ma5[i] < ma10[i] && ma10[i] < ma20[i] && !(ma5[i - 1] < ma10[i - 1] && ma10[i - 1] < ma20[i - 1])
    },
    // 布林带下轨买入，上轨卖出
    boll: {
      name: '布林带',
      buy: (i) => closes[i] <= boll.lower[i] && closes[i - 1] > boll.lower[i - 1],
      sell: (i) => closes[i] >= boll.upper[i] && closes[i - 1] < boll.upper[i - 1]
    },
    // 综合策略（多指标投票）
    combined: {
      name: '综合策略',
      buy: (i) => {
        let votes = 0;
        if (macd.dif[i] > macd.dea[i]) votes++;
        if (rsi[i] !== null && rsi[i] < 40) votes++;
        if (kdj.k[i] > kdj.d[i] && kdj.j[i] < 30) votes++;
        if (closes[i] <= boll.lower[i] * 1.02) votes++;
        if (wr[i] !== null && wr[i] < -70) votes++;
        return votes >= (params.buyVotes || 3) && votes > 0;
      },
      sell: (i) => {
        let votes = 0;
        if (macd.dif[i] < macd.dea[i]) votes++;
        if (rsi[i] !== null && rsi[i] > 60) votes++;
        if (kdj.k[i] < kdj.d[i] && kdj.j[i] > 70) votes++;
        if (closes[i] >= boll.upper[i] * 0.98) votes++;
        if (wr[i] !== null && wr[i] > -30) votes++;
        return votes >= (params.sellVotes || 3) && votes > 0;
      }
    },
    // 金叉买入+止损止盈
    macd_stop: {
      name: 'MACD+止损止盈',
      buy: (i) => macd.dif[i] > macd.dea[i] && macd.dif[i - 1] <= macd.dea[i - 1],
      sell: (i) => macd.dif[i] < macd.dea[i] && macd.dif[i - 1] >= macd.dea[i - 1],
      stopLoss: params.stopLoss || 0.08,
      stopProfit: params.stopProfit || 0.2
    }
  };

  const strat = strategies[strategy] || strategies.macd_cross;
  const startIdx = 60; // 跳过前60个数据点（指标预热）

  // 模拟交易
  const trades = [];
  let position = 0; // 0=空仓, 1=持仓
  let buyPrice = 0;
  let buyDate = '';
  let cash = params.initCash || 100000;
  let shares = 0;
  let totalValue = cash;
  const equityCurve = [];

  for (let i = startIdx; i < len; i++) {
    const date = klineData[i].date;
    const price = closes[i];

    // 止损止盈检查
    if (position === 1 && strat.stopLoss && price <= buyPrice * (1 - strat.stopLoss)) {
      const pnl = (price - buyPrice) * shares;
      const pnlPercent = (price - buyPrice) / buyPrice * 100;
      cash += shares * price;
      trades.push({
        buyDate, buyPrice: +buyPrice.toFixed(2),
        sellDate: date, sellPrice: +price.toFixed(2),
        pnl: +pnl.toFixed(2), pnlPercent: +pnlPercent.toFixed(2),
        reason: '止损', shares
      });
      position = 0; shares = 0;
    }
    if (position === 1 && strat.stopProfit && price >= buyPrice * (1 + strat.stopProfit)) {
      const pnl = (price - buyPrice) * shares;
      const pnlPercent = (price - buyPrice) / buyPrice * 100;
      cash += shares * price;
      trades.push({
        buyDate, buyPrice: +buyPrice.toFixed(2),
        sellDate: date, sellPrice: +price.toFixed(2),
        pnl: +pnl.toFixed(2), pnlPercent: +pnlPercent.toFixed(2),
        reason: '止盈', shares
      });
      position = 0; shares = 0;
    }

    // 策略信号
    if (position === 0 && i > 0 && strat.buy(i)) {
      shares = Math.floor(cash / price / 100) * 100; // 按手买
      if (shares > 0) {
        buyPrice = price;
        buyDate = date;
        cash -= shares * price;
        position = 1;
      }
    } else if (position === 1 && i > 0 && strat.sell(i)) {
      const pnl = (price - buyPrice) * shares;
      const pnlPercent = (price - buyPrice) / buyPrice * 100;
      cash += shares * price;
      trades.push({
        buyDate, buyPrice: +buyPrice.toFixed(2),
        sellDate: date, sellPrice: +price.toFixed(2),
        pnl: +pnl.toFixed(2), pnlPercent: +pnlPercent.toFixed(2),
        reason: strategy.includes('stop') ? '信号卖出' : '卖出信号', shares
      });
      position = 0; shares = 0;
    }

    totalValue = cash + shares * price;
    equityCurve.push({ date, value: +totalValue.toFixed(2), price });
  }

  // 如果最后还持仓，按最后价格平仓计算
  if (position === 1) {
    const lastPrice = closes[len - 1];
    const lastDate = klineData[len - 1].date;
    const pnl = (lastPrice - buyPrice) * shares;
    const pnlPercent = (lastPrice - buyPrice) / buyPrice * 100;
    cash += shares * lastPrice;
    trades.push({
      buyDate, buyPrice: +buyPrice.toFixed(2),
      sellDate: lastDate, sellPrice: +lastPrice.toFixed(2),
      pnl: +pnl.toFixed(2), pnlPercent: +pnlPercent.toFixed(2),
      reason: '持仓平仓', shares
    });
    totalValue = cash;
  }

  // 统计
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0;
  const totalReturn = +((totalValue - (params.initCash || 100000)) / (params.initCash || 100000) * 100).toFixed(2);
  const avgWin = wins.length > 0 ? +(wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length).toFixed(2) : 0;
  const avgLoss = losses.length > 0 ? +(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length).toFixed(2) : 0;
  const profitFactor = losses.length > 0 && wins.length > 0
    ? +(wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))).toFixed(2)
    : wins.length > 0 ? Infinity : 0;

  // 最大回撤
  let maxDrawdown = 0, peak = 0;
  for (const pt of equityCurve) {
    if (pt.value > peak) peak = pt.value;
    const dd = (peak - pt.value) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 年化收益率
  const days = equityCurve.length;
  const annualizedReturn = days > 0 ? +((Math.pow(totalValue / (params.initCash || 100000), 252 / days) - 1) * 100).toFixed(2) : 0;

  // 夏普比率（简化版，假设无风险利率3%）
  let sharpeRatio = 0;
  if (equityCurve.length > 1) {
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i].value - equityCurve[i - 1].value) / equityCurve[i - 1].value);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length);
    sharpeRatio = stdReturn > 0 ? +((avgReturn - 0.03 / 252) / stdReturn * Math.sqrt(252)).toFixed(2) : 0;
  }

  return {
    strategy: strat.name,
    params: {
      initCash: params.initCash || 100000,
      stopLoss: params.stopLoss || null,
      stopProfit: params.stopProfit || null
    },
    summary: {
      totalTrades: trades.length,
      winRate,
      totalReturn,
      annualizedReturn,
      maxDrawdown: +maxDrawdown.toFixed(2),
      sharpeRatio: sharpeRatio || 0,
      profitFactor: profitFactor === Infinity ? '∞' : profitFactor,
      avgWin,
      avgLoss,
      finalValue: +totalValue.toFixed(2)
    },
    trades,
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 200)) === 0 || i === equityCurve.length - 1) // 降采样
  };
}

// ---- ES Module Exports ----
export {
  SMA, EMA, calcMA, calcMACD, calcRSI, calcKDJ, calcBOLL,
  calcOBV, calcWR, calcDMI, calcCCI, calcVOL,
  detectSignals, calcScore, calcAllIndicators, screenStock,
  runBacktest
};
