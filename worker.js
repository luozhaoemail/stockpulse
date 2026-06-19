// ============================================================
// StockPulse · Cloudflare Worker
// 股票/基金行情监测与趋势预测 + D1 缓存
// ============================================================

// ---- D1 缓存层 ----
const _ttl={quote:30,kline_1d:300,kline_1w:1800,kline_1m:3600,kline_3m:7200,kline_6m:14400,kline_1y:28800,fund:600,fund_nav:86400,indicators:300,signals:300,backtest:3600};
const _MAX=50000,_CLEAN=10000;
function _ck(t,s,m,e=''){return`${t}:${s}:${m}:${e}`.replace(/:+$/,'')}
async function _cGet(db,k,ttl){if(!db)return null;try{const c=Math.floor(Date.now()/1000)-ttl;const r=await db.prepare('SELECT data,created_at FROM cache WHERE cache_key=? AND created_at>?').bind(k,c).first();if(r)return JSON.parse(r.data);await db.prepare('DELETE FROM cache WHERE cache_key=?').bind(k).run();return null}catch(e){return null}}
async function _cSet(db,k,t,d,s='',m=''){if(!db)return;try{const j=JSON.stringify(d);await db.prepare('DELETE FROM cache WHERE cache_key=?').bind(k).run();await db.prepare('INSERT INTO cache(cache_key,cache_type,symbol,market,data,created_at) VALUES(?,?,?,?,?,unixepoch())').bind(k,t,s,m,j).run();_cClean(db).catch(()=>{})}catch(e){}}
async function _cClean(db){try{const c=await db.prepare('SELECT COUNT(*) as cnt FROM cache').first();if(c&&c.cnt>_MAX)await db.prepare('DELETE FROM cache WHERE id IN(SELECT id FROM cache ORDER BY created_at ASC LIMIT ?)').bind(_CLEAN).run()}catch(e){}}
async function _initDB(db){if(!db)return;try{await db.exec(`CREATE TABLE IF NOT EXISTS cache(id INTEGER PRIMARY KEY AUTOINCREMENT,cache_key TEXT NOT NULL,cache_type TEXT NOT NULL,symbol TEXT,market TEXT,data TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()));CREATE INDEX IF NOT EXISTS idx_ck ON cache(cache_key);CREATE INDEX IF NOT EXISTS idx_ct ON cache(cache_type);CREATE INDEX IF NOT EXISTS idx_cc ON cache(created_at);CREATE INDEX IF NOT EXISTS idx_cs ON cache(symbol,cache_type)`)}catch(e){}}

let _db=null,_dbInit=false;
function _getDB(env){if(_db)return _db;if(env?.DB){_db=env.DB;return _db}return null}
async function _ensureDB(env){const db=_getDB(env);if(db&&!_dbInit){await _initDB(db);_dbInit=true}return db}

// ---- 市场前缀判断（修复指数代码） ----
// A股指数代码 → 新浪/腾讯前缀
const SH_INDEX = new Set(['000001','000016','000300','000688','000905','000010','000012','000013','000015','000031','000032','000033']);
const SZ_INDEX = new Set(['399001','399002','399003','399004','399005','399006','399100','399101','399102','399103','399106','399300','399330','399606','399673','399678','399903','399905','399975','399986','399987','399990','399991','399992','399993','399994','399995','399996','399997','399998','399999']);

function getMarketPrefix(symbol) {
  if (SH_INDEX.has(symbol)) return 'sh';
  if (SZ_INDEX.has(symbol)) return 'sz';
  // 普通股票：6/9开头=上海，其他=深圳
  return symbol.startsWith('6') || symbol.startsWith('9') ? 'sh' : 'sz';
}

// ---- 路由 ----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = await _ensureDB(env);

    // API 代理路由
    if (path === '/api/quote')    return handleQuote(url, db);
    if (path === '/api/kline')    return handleKline(url, db);
    if (path === '/api/indicators') return handleIndicators(url, db);
    if (path === '/api/signals')  return handleSignals(url, db);
    if (path === '/api/screen')   return handleScreen(url, db);
    if (path === '/api/backtest') return handleBacktest(url, db);
    if (path === '/api/fund')     return handleFund(url, db);
    if (path === '/api/fund-nav') return handleFundNav(url, db);
    if (path === '/api/cache-stats') return json(db ? await (async()=>{const t=await db.prepare('SELECT COUNT(*) as cnt FROM cache').first();const bt=await db.prepare('SELECT cache_type,COUNT(*) as cnt FROM cache GROUP BY cache_type').all();return{total:t?.cnt||0,byType:bt?.results||[]}})() : {total:0,db:false});
    if (path === '/api/cache-clean') return json(db ? await (async()=>{const r=await db.prepare('DELETE FROM cache WHERE created_at<?').bind(Math.floor(Date.now()/1000)-86400).run();return{deleted:r.meta?.changes||0}})() : {deleted:0});
    if (path === '/api/health')   return json({ ok: true, ts: Date.now(), db: !!db });

    // 非 API 路由返回 404（Pages 部署时静态文件由 Pages 处理）
    return json({ error: 'not found' }, 404);
  }
};

// ---- API 代理：股票实时行情 ----
async function handleQuote(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  if (!symbol) return json({ error: 'missing symbol' }, 400);

  const key = _ck('quote', symbol, market);
  const cached = await _cGet(db, key, _ttl.quote);
  if (cached) return json(cached);

  try {
    let result = null;

    if (market === 'A') {
      const prefix = getMarketPrefix(symbol);
      const resp = await fetch(`https://hq.sinajs.cn/list=${prefix}${symbol}`, {
        headers: { 'Referer': 'https://finance.sina.com.cn' }
      });
      const text = await resp.text();
      result = parseSinaQuote(text);
    }

    if (!result && market === 'US') {
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
          name: meta.shortName || symbol, price: meta.regularMarketPrice,
          prevClose: prev, open: meta.regularMarketPrice,
          high: meta.regularMarketDayHigh || meta.regularMarketPrice,
          low: meta.regularMarketDayLow || meta.regularMarketPrice,
          volume: meta.regularMarketVolume || 0,
          change: meta.regularMarketPrice - prev,
          changePercent: ((meta.regularMarketPrice - prev) / prev) * 100
        };
      }
    }

    if (result) { await _cSet(db, key, 'quote', result, symbol, market); return json(result); }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ---- API 代理：K线数据 ----
async function handleKline(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1w';
  if (!symbol) return json({ error: 'missing symbol' }, 400);

  const ttlKey = `kline_${period}`;
  const ttl = _ttl[ttlKey] || _ttl.kline_1w;
  const key = _ck('kline', symbol, market, period);
  const cached = await _cGet(db, key, ttl);
  if (cached) return json(cached);

  try {
    let result = [];

    if (market === 'A') {
      // 主力数据源：新浪财经 K 线 API
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
    }

    if (result.length) await _cSet(db, key, 'kline', result, symbol, market);
    return json(result);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ---- 技术指标引擎 ----
function _SMA(d,p){const r=[];for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue}let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j];r.push(+(s/p).toFixed(4))}return r}
function _EMA(d,p){const r=[],k=2/(p+1);let e=d[0];for(let i=0;i<d.length;i++){if(i===0){r.push(+d[0].toFixed(4));continue}e=d[i]*k+e*(1-k);r.push(+e.toFixed(4))}return r}
function _MACD(c,f=12,s=26,sig=9){const ef=_EMA(c,f),es=_EMA(c,s),dif=ef.map((v,i)=>+(v-es[i]).toFixed(4)),dea=_EMA(dif,sig),macd=dif.map((v,i)=>+((v-dea[i])*2).toFixed(4));return{dif,dea,macd}}
function _RSI(c,p=14){const r=[];for(let i=0;i<c.length;i++){if(i<p){r.push(null);continue}let g=0,l=0;for(let j=i-p+1;j<=i;j++){const d=c[j]-c[j-1];if(d>0)g+=d;else l+=Math.abs(d)}r.push(+(100-100/(1+(l===0?100:g/l))).toFixed(2))}return r}
function _KDJ(data,p=9){const k=[],d=[],j=[];let pk=50,pd=50;for(let i=0;i<data.length;i++){if(i<p-1){k.push(null);d.push(null);j.push(null);continue}let hm=-Infinity,lm=Infinity;for(let t=i-p+1;t<=i;t++){hm=Math.max(hm,data[t].high);lm=Math.min(lm,data[t].low)}const rsv=hm===lm?50:((data[i].close-lm)/(hm-lm))*100;const kv=2/3*pk+1/3*rsv,dv=2/3*pd+1/3*kv,jv=3*kv-2*dv;k.push(+kv.toFixed(2));d.push(+dv.toFixed(2));j.push(+jv.toFixed(2));pk=kv;pd=dv}return{k,d,j}}
function _BOLL(data,p=20){const c=data.map(d=>d.close),ma=_SMA(c,p),u=[],l=[];for(let i=0;i<data.length;i++){if(i<p-1){u.push(null);l.push(null);continue}let ss=0;for(let t=i-p+1;t<=i;t++)ss+=Math.pow(c[t]-ma[i],2);const s=Math.sqrt(ss/p);u.push(+(ma[i]+2*s).toFixed(2));l.push(+(ma[i]-2*s).toFixed(2))}return{ma,u,l}}
function _OBV(c,v){const r=[0];for(let i=1;i<c.length;i++){if(c[i]>c[i-1])r.push(r[i-1]+v[i]);else if(c[i]<c[i-1])r.push(r[i-1]-v[i]);else r.push(r[i-1])}return{obv:r,obvMa:_SMA(r,20)}}
function _WR(h,l,c,p=14){const r=[];for(let i=0;i<c.length;i++){if(i<p-1){r.push(null);continue}let hm=-Infinity,lm=Infinity;for(let t=i-p+1;t<=i;t++){hm=Math.max(hm,h[t]);lm=Math.min(lm,l[t])}r.push(+(hm===lm?-50:((hm-c[i])/(hm-lm))*-100).toFixed(2))}return r}
function _CCI(h,l,c,p=14){const r=[];for(let i=0;i<c.length;i++){if(i<p-1){r.push(null);continue}const tp=[];for(let t=i-p+1;t<=i;t++)tp.push((h[t]+l[t]+c[t])/3);const ma=tp.reduce((a,b)=>a+b,0)/tp.length,md=tp.reduce((a,b)=>a+Math.abs(b-ma),0)/tp.length;r.push(+(md===0?0:((h[i]+l[i]+c[i])/3-ma)/(0.015*md)).toFixed(2))}return r}
function _VOL(v){const r5=_SMA(v,5),r10=_SMA(v,10),r20=_SMA(v,20),ratio=[];for(let i=0;i<v.length;i++){if(i<5){ratio.push(null);continue}const avg=v.slice(i-5,i).reduce((a,b)=>a+b,0)/5;ratio.push(+(v[i]/(avg||1)).toFixed(2))}return{vma5:r5,vma10:r10,vma20:r20,ratio}}
function _detectSignals(data){if(!data||data.length<60)return[];const c=data.map(d=>d.close),h=data.map(d=>d.high),l=data.map(d=>d.low),v=data.map(d=>d.volume),L=c.length-1,sig=[];const macd=_MACD(c);if(macd.dif[L]>macd.dea[L]&&macd.dif[L-1]<=macd.dea[L-1]){sig.push({name:'MACD金叉',type:'bullish',strength:8,detail:'DIF上穿DEA'});if(macd.dif[L]>0)sig.push({name:'零轴上金叉',type:'bullish',strength:9,detail:'强势'})}if(macd.dif[L]<macd.dea[L]&&macd.dif[L-1]>=macd.dea[L-1])sig.push({name:'MACD死叉',type:'bearish',strength:8,detail:'DIF下穿DEA'});const kdj=_KDJ(data);if(kdj.k[L]>kdj.d[L]&&kdj.k[L-1]<=kdj.d[L-1])sig.push({name:'KDJ金叉',type:'bullish',strength:kdj.j[L]<20?9:6,detail:'J='+kdj.j[L]?.toFixed(0)});if(kdj.k[L]<kdj.d[L]&&kdj.k[L-1]>=kdj.d[L-1])sig.push({name:'KDJ死叉',type:'bearish',strength:kdj.j[L]>80?9:6,detail:'J='+kdj.j[L]?.toFixed(0)});const rsi=_RSI(c);if(rsi[L]!=null){if(rsi[L]<20)sig.push({name:'RSI极度超卖',type:'bullish',strength:8,detail:'RSI='+rsi[L]});else if(rsi[L]<30)sig.push({name:'RSI超卖',type:'bullish',strength:6,detail:'RSI='+rsi[L]});else if(rsi[L]>80)sig.push({name:'RSI极度超买',type:'bearish',strength:8,detail:'RSI='+rsi[L]});else if(rsi[L]>70)sig.push({name:'RSI超买',type:'bearish',strength:6,detail:'RSI='+rsi[L]})}const boll=_BOLL(data);if(c[L]<=boll.l[L])sig.push({name:'触及布林下轨',type:'bullish',strength:7,detail:'可能反弹'});if(c[L]>=boll.u[L])sig.push({name:'触及布林上轨',type:'bearish',strength:7,detail:'可能回调'});const ma5=_SMA(c,5),ma10=_SMA(c,10),ma20=_SMA(c,20),ma60=_SMA(c,60);if(ma5[L]>ma10[L]&&ma5[L-1]<=ma10[L-1])sig.push({name:'MA5/10金叉',type:'bullish',strength:5,detail:'短期转多'});if(ma5[L]<ma10[L]&&ma5[L-1]>=ma10[L-1])sig.push({name:'MA5/10死叉',type:'bearish',strength:5,detail:'短期转空'});if(ma5[L]>ma10[L]&&ma10[L]>ma20[L]&&ma20[L]>ma60[L])sig.push({name:'均线多头排列',type:'bullish',strength:7,detail:'MA5>10>20>60'});if(ma5[L]<ma10[L]&&ma10[L]<ma20[L]&&ma20[L]<ma60[L])sig.push({name:'均线空头排列',type:'bearish',strength:7,detail:'MA5<10<20<60'});const vol=_VOL(v);if(vol.ratio[L]>2){const up=c[L]>c[L-1];sig.push({name:up?'放量上涨':'放量下跌',type:up?'bullish':'bearish',strength:7,detail:'量比'+vol.ratio[L]})}else if(vol.ratio[L]<0.5)sig.push({name:'缩量',type:'neutral',strength:3,detail:'量比'+vol.ratio[L]});const obv=_OBV(c,v);if(obv.obvMa[L]!=null){if(obv.obv[L]>obv.obvMa[L]&&obv.obv[L-1]<=obv.obvMa[L-1])sig.push({name:'OBV上穿',type:'bullish',strength:5,detail:'资金流入'});if(obv.obv[L]<obv.obvMa[L]&&obv.obv[L-1]>=obv.obvMa[L-1])sig.push({name:'OBV下穿',type:'bearish',strength:5,detail:'资金流出'})}const wr=_WR(h,l,c);if(wr[L]!=null){if(wr[L]<-80)sig.push({name:'WR超卖',type:'bullish',strength:5,detail:'WR='+wr[L]});if(wr[L]>-20)sig.push({name:'WR超买',type:'bearish',strength:5,detail:'WR='+wr[L]})}const cci=_CCI(h,l,c);if(cci[L]!=null){if(cci[L]<-100)sig.push({name:'CCI超卖',type:'bullish',strength:6,detail:'CCI='+cci[L]});if(cci[L]>100)sig.push({name:'CCI超买',type:'bearish',strength:6,detail:'CCI='+cci[L]})}return sig}
function _calcScore(data){const sig=_detectSignals(data);if(!sig.length)return{score:0,maxScore:0,percent:0,trend:'数据不足',trendClass:'neutral',signals:[],confidenceLabel:'--'};let sc=0,ms=0;for(const s of sig){ms+=s.strength;if(s.type==='bullish')sc+=s.strength;else if(s.type==='bearish')sc-=s.strength}const pct=ms?+((sc/ms)*100).toFixed(1):0;const trend=pct>25?'看多':pct<-25?'看空':'震荡';const tc=pct>25?'bullish':pct<-25?'bearish':'neutral';const bc=sig.filter(s=>s.type==='bullish').length,brc=sig.filter(s=>s.type==='bearish').length,conf=Math.abs(bc-brc)/sig.length;return{score:sc,maxScore:ms,percent:pct,trend,trendClass:tc,signals:sig,confidenceLabel:conf>0.5?'高':conf>0.2?'中':'低'}}
function _calcAll(data){if(!data||data.length<5)return null;const c=data.map(d=>d.close),h=data.map(d=>d.high),l=data.map(d=>d.low),v=data.map(d=>d.volume),L=c.length-1;const g=a=>a[L]!=null?a[L]:null;const macd=_MACD(c),kdj=_KDJ(data),boll=_BOLL(data),obv=_OBV(c,v),wr=_WR(h,l,c),cci=_CCI(h,l,c),vol=_VOL(v),ma5=_SMA(c,5),ma10=_SMA(c,10),ma20=_SMA(c,20),ma60=_SMA(c,60);return{ma:{ma5:g(ma5),ma10:g(ma10),ma20:g(ma20),ma60:g(ma60)},macd:{dif:g(macd.dif),dea:g(macd.dea),macd:g(macd.macd)},rsi:{rsi6:g(_RSI(c,6)),rsi12:g(_RSI(c,12)),rsi14:g(_RSI(c))},kdj:{k:g(kdj.k),d:g(kdj.d),j:g(kdj.j)},boll:{upper:g(boll.u),mid:g(boll.ma),lower:g(boll.l)},obv:{value:g(obv.obv),ma:g(obv.obvMa)},wr:{wr14:g(wr)},cci:{cci14:g(cci)},vol:{vma5:g(vol.vma5),vma10:g(vol.vma10),vma20:g(vol.vma20),ratio:g(vol.ratio)}}}

async function handleIndicators(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1y';
  if (!symbol) return json({ error: 'missing symbol' }, 400);
  try {
    const kUrl = new URL(url); kUrl.searchParams.set('period', period);
    const kData = await handleKline(kUrl, db);
    if (!kData || kData.length < 5) return json({ error: '数据不足', symbol, market });
    const indicators = _calcAll(kData);
    const score = _calcScore(kData);
    return json({ symbol, market, dataPoints: kData.length, latestDate: kData[kData.length-1]?.date, latestPrice: kData[kData.length-1]?.close, indicators, score: { total: score.score, max: score.maxScore, percent: score.percent, trend: score.trend, trendClass: score.trendClass, confidence: score.confidenceLabel } });
  } catch (e) { return json({ error: e.message }, 500); }
}

async function handleSignals(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const period = url.searchParams.get('period') || '1y';
  if (!symbol) return json({ error: 'missing symbol' }, 400);
  try {
    const kUrl = new URL(url); kUrl.searchParams.set('period', period);
    const kData = await handleKline(kUrl, db);
    if (!kData || kData.length < 60) return json({ signals: [], message: '数据不足' });
    const score = _calcScore(kData);
    return json({ symbol, market, dataPoints: kData.length, trend: score.trend, trendClass: score.trendClass, score: score.score, maxScore: score.maxScore, confidence: score.confidenceLabel, signals: score.signals });
  } catch (e) { return json({ error: e.message }, 500); }
}

async function handleScreen(url, db) {
  const symbols = url.searchParams.get('symbols');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  if (!symbols) return json({ error: 'missing symbols' }, 400);
  try {
    const list = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
    const results = [];
    for (const symbol of list) {
      try {
        const kUrl = new URL(url); kUrl.searchParams.set('symbol', symbol); kUrl.searchParams.set('period', '1y');
        const kData = await handleKline(kUrl, db);
        if (kData && kData.length >= 60) {
          const score = _calcScore(kData);
          const indicators = _calcAll(kData);
          let totalScore = 0; const reasons = [];
          if (indicators.macd.dif > indicators.macd.dea && indicators.macd.dif < 0) { totalScore += 15; reasons.push('MACD底部金叉'); }
          if (indicators.macd.dif > indicators.macd.dea && indicators.macd.macd > 0) { totalScore += 10; reasons.push('MACD多头'); }
          if (indicators.rsi.rsi14 < 35) { totalScore += 12; reasons.push('RSI超卖区'); }
          if (indicators.kdj.j < 25) { totalScore += 10; reasons.push('KDJ超卖'); }
          if (indicators.vol.ratio > 1.5) { totalScore += 8; reasons.push('放量'); }
          if (indicators.cci.cci14 < -100) { totalScore += 8; reasons.push('CCI超卖'); }
          if (indicators.wr.wr14 < -80) { totalScore += 6; reasons.push('WR超卖'); }
          if (indicators.ma.ma5 > indicators.ma.ma10 && indicators.ma.ma10 > indicators.ma.ma20) { totalScore += 15; reasons.push('均线多头'); }
          if (indicators.ma.ma5 < indicators.ma.ma10 && indicators.ma.ma10 < indicators.ma.ma20) { totalScore -= 10; reasons.push('均线空头'); }
          results.push({ symbol, score: totalScore, maxScore: 100, trend: score.trend, trendClass: score.trendClass, reasons, indicators });
        }
      } catch (e) { /* skip */ }
    }
    results.sort((a, b) => b.score - a.score);
    return json({ count: results.length, results });
  } catch (e) { return json({ error: e.message }, 500); }
}

// ---- 回测引擎 ----
function _runBacktest(data, strategy='macd_cross', params={}) {
  if (!data || data.length < 60) return { error: '数据不足' };
  const c=data.map(d=>d.close), h=data.map(d=>d.high), l=data.map(d=>d.low), v=data.map(d=>d.volume), L=c.length;
  const macd=_MACD(c), rsi=_RSI(c), kdj=_KDJ(data), ma5=_SMA(c,5), ma10=_SMA(c,10), ma20=_SMA(c,20), boll=_BOLL(data), wr=_WR(h,l,c);
  const strats = {
    macd_cross: { name:'MACD金叉死叉', buy:i=>macd.dif[i]>macd.dea[i]&&macd.dif[i-1]<=macd.dea[i-1], sell:i=>macd.dif[i]<macd.dea[i]&&macd.dif[i-1]>=macd.dea[i-1] },
    macd_strong: { name:'MACD强势金叉', buy:i=>macd.dif[i]>macd.dea[i]&&macd.dif[i-1]<=macd.dea[i-1]&&macd.dif[i]>0, sell:i=>macd.dif[i]<macd.dea[i]&&macd.dif[i-1]>=macd.dea[i-1] },
    rsi: { name:'RSI超买超卖', buy:i=>rsi[i]!=null&&rsi[i]<30&&rsi[i-1]>=30, sell:i=>rsi[i]!=null&&rsi[i]>70&&rsi[i-1]<=70 },
    kdj_cross: { name:'KDJ金叉死叉', buy:i=>kdj.k[i]>kdj.d[i]&&kdj.k[i-1]<=kdj.d[i-1]&&kdj.j[i]<30, sell:i=>kdj.k[i]<kdj.d[i]&&kdj.k[i-1]>=kdj.d[i-1]&&kdj.j[i]>70 },
    ma_trend: { name:'均线趋势', buy:i=>ma5[i]>ma10[i]&&ma10[i]>ma20[i]&&!(ma5[i-1]>ma10[i-1]&&ma10[i-1]>ma20[i-1]), sell:i=>ma5[i]<ma10[i]&&ma10[i]<ma20[i]&&!(ma5[i-1]<ma10[i-1]&&ma10[i-1]<ma20[i-1]) },
    boll: { name:'布林带', buy:i=>c[i]<=boll.l[i]&&c[i-1]>boll.l[i-1], sell:i=>c[i]>=boll.u[i]&&c[i-1]<boll.u[i-1] },
    combined: { name:'综合策略', buy:i=>{let v=0;if(macd.dif[i]>macd.dea[i])v++;if(rsi[i]!=null&&rsi[i]<40)v++;if(kdj.k[i]>kdj.d[i]&&kdj.j[i]<30)v++;if(c[i]<=boll.l[i]*1.02)v++;if(wr[i]!=null&&wr[i]<-70)v++;return v>=3}, sell:i=>{let v=0;if(macd.dif[i]<macd.dea[i])v++;if(rsi[i]!=null&&rsi[i]>60)v++;if(kdj.k[i]<kdj.d[i]&&kdj.j[i]>70)v++;if(c[i]>=boll.u[i]*0.98)v++;if(wr[i]!=null&&wr[i]>-30)v++;return v>=3} },
    macd_stop: { name:'MACD+止损止盈', buy:i=>macd.dif[i]>macd.dea[i]&&macd.dif[i-1]<=macd.dea[i-1], sell:i=>macd.dif[i]<macd.dea[i]&&macd.dif[i-1]>=macd.dea[i-1], stopLoss:params.stopLoss||0.08, stopProfit:params.stopProfit||0.2 }
  };
  const strat=strats[strategy]||strats.macd_cross;
  const trades=[], eq=[]; let pos=0,bp=0,bd='',cash=params.initCash||100000,shares=0;
  for (let i=60;i<L;i++) {
    const date=data[i].date, price=c[i];
    if (pos===1&&strat.stopLoss&&price<=bp*(1-strat.stopLoss)) { const pnl=(price-bp)*shares; cash+=shares*price; trades.push({buyDate:bd,buyPrice:+bp.toFixed(2),sellDate:date,sellPrice:+price.toFixed(2),pnl:+pnl.toFixed(2),pnlPercent:+((price-bp)/bp*100).toFixed(2),reason:'止损',shares}); pos=0;shares=0; }
    if (pos===1&&strat.stopProfit&&price>=bp*(1+strat.stopProfit)) { const pnl=(price-bp)*shares; cash+=shares*price; trades.push({buyDate:bd,buyPrice:+bp.toFixed(2),sellDate:date,sellPrice:+price.toFixed(2),pnl:+pnl.toFixed(2),pnlPercent:+((price-bp)/bp*100).toFixed(2),reason:'止盈',shares}); pos=0;shares=0; }
    if (pos===0&&i>0&&strat.buy(i)) { shares=Math.floor(cash/price/100)*100; if(shares>0){bp=price;bd=date;cash-=shares*price;pos=1;} }
    else if (pos===1&&i>0&&strat.sell(i)) { const pnl=(price-bp)*shares; cash+=shares*price; trades.push({buyDate:bd,buyPrice:+bp.toFixed(2),sellDate:date,sellPrice:+price.toFixed(2),pnl:+pnl.toFixed(2),pnlPercent:+((price-bp)/bp*100).toFixed(2),reason:'卖出信号',shares}); pos=0;shares=0; }
    eq.push({date,value:+(cash+shares*price).toFixed(2),price});
  }
  if (pos===1) { const lp=c[L-1],pnl=(lp-bp)*shares;cash+=shares*lp;trades.push({buyDate:bd,buyPrice:+bp.toFixed(2),sellDate:data[L-1].date,sellPrice:+lp.toFixed(2),pnl:+pnl.toFixed(2),pnlPercent:+((lp-bp)/bp*100).toFixed(2),reason:'持仓平仓',shares}); }
  const tv=cash, ic=params.initCash||100000;
  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<=0);
  const wr2=trades.length?+(wins.length/trades.length*100).toFixed(1):0;
  const tr2=+((tv-ic)/ic*100).toFixed(2);
  const aw=wins.length?+(wins.reduce((s,t)=>s+t.pnlPercent,0)/wins.length).toFixed(2):0;
  const al=losses.length?+(losses.reduce((s,t)=>s+t.pnlPercent,0)/losses.length).toFixed(2):0;
  const pf=losses.length&&wins.length?+(wins.reduce((s,t)=>s+t.pnl,0)/Math.abs(losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2):(wins.length?Infinity:0);
  let md=0,pk=0; for(const pt of eq){if(pt.value>pk)pk=pt.value;const dd=(pk-pt.value)/pk*100;if(dd>md)md=dd;}
  const ar=eq.length?+((Math.pow(tv/ic,252/eq.length)-1)*100).toFixed(2):0;
  let sr=0; if(eq.length>1){const rets=[];for(let i=1;i<eq.length;i++)rets.push((eq[i].value-eq[i-1].value)/eq[i-1].value);const avg=rets.reduce((a,b)=>a+b,0)/rets.length,std=Math.sqrt(rets.reduce((s,r)=>s+Math.pow(r-avg,2),0)/rets.length);sr=std>0?+((avg-0.03/252)/std*Math.sqrt(252)).toFixed(2):0;}
  return { strategy:strat.name, params:{initCash:ic,stopLoss:params.stopLoss||null,stopProfit:params.stopProfit||null}, summary:{totalTrades:trades.length,winRate:wr2,totalReturn:tr2,annualizedReturn:ar,maxDrawdown:+md.toFixed(2),sharpeRatio:sr,profitFactor:pf===Infinity?'∞':pf,avgWin:aw,avgLoss:al,finalValue:+tv.toFixed(2)}, trades, equityCurve:eq.filter((_,i)=>i%Math.max(1,Math.floor(eq.length/200))===0||i===eq.length-1) };
}

async function handleBacktest(url, db) {
  const symbol = url.searchParams.get('symbol');
  const market = (url.searchParams.get('market') || 'A').toUpperCase();
  const strategy = url.searchParams.get('strategy') || 'macd_cross';
  const period = url.searchParams.get('period') || '1y';
  const initCash = parseFloat(url.searchParams.get('initCash')) || 100000;
  const stopLoss = parseFloat(url.searchParams.get('stopLoss')) || null;
  const stopProfit = parseFloat(url.searchParams.get('stopProfit')) || null;
  if (!symbol) return json({ error: 'missing symbol' }, 400);
  try {
    const kUrl = new URL(url); kUrl.searchParams.set('period', period);
    const kData = await handleKline(kUrl, db);
    if (!kData || kData.length < 60) return json({ error: '数据不足', symbol, dataPoints: kData?.length || 0 });
    const result = _runBacktest(kData, strategy, { initCash, stopLoss, stopProfit });
    return json({ symbol, market, ...result });
  } catch (e) { return json({ error: e.message }, 500); }
}

// ---- API 代理：基金信息 ----
async function handleFund(url, db) {
  const code = url.searchParams.get('code');
  if (!code) return json({ error: 'missing code' }, 400);

  try {
    // 天天基金
    const resp = await fetch(`https://fundgz.1702.com/js/${code}.js`, {
      headers: { 'Referer': 'https://fund.eastmoney.com' }
    });
    const text = await resp.text();
    // jsonpgz({"fundcode":"110011","name":"易方达中小盘混合","jzrq":"2024-01-01","dwjz":"3.2150","gsz":"3.2301","gszzl":"0.47","gztime":"2024-01-02 15:00"});
    const match = text.match(/jsonpgz\((.+)\)/);
    if (match) {
      const d = JSON.parse(match[1]);
      return json({
        code: d.fundcode,
        name: d.name,
        nav: +d.dwjz,
        navDate: d.jzrq,
        estimate: +d.gsz,
        estimateChange: +d.gszzl,
        estimateTime: d.gztime
      });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ---- API 代理：基金历史净值 ----
async function handleFundNav(url, db) {
  const code = url.searchParams.get('code');
  const days = url.searchParams.get('days') || '180';
  if (!code) return json({ error: 'missing code' }, 400);

  try {
    const resp = await fetch(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${days}`,
      { headers: { 'Referer': 'https://fund.eastmoney.com' } }
    );
    const data = await resp.json();
    const list = data?.Data?.LSJZList || [];
    return json(list.reverse().map(item => ({
      date: item.FSRQ,
      nav: +item.DWJZ,
      accNav: +item.LJJZ,
      change: +item.JZZZL || 0
    })));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
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
      name: p[0],
      open: parseFloat(p[1]),
      prevClose,
      price,
      high: parseFloat(p[4]),
      low: parseFloat(p[5]),
      volume: parseInt(p[8]),
      amount: parseFloat(p[9]),
      change: price - prevClose,
      changePercent: ((price - prevClose) / prevClose) * 100
    };
  } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
  });
