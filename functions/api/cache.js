// ============================================================
// StockPulse D1 缓存层
// 自动缓存行情/K线数据，过期自动清理，存储满时删除最旧数据
// ============================================================

// 缓存过期时间（秒）
export const CACHE_TTL = {
  quote: 30,        // 实时行情 30秒
  kline_1d: 300,    // 日K 5分钟
  kline_1w: 1800,   // 周K 30分钟
  kline_1m: 3600,   // 月K 1小时
  kline_3m: 7200,   // 3月K 2小时
  kline_6m: 14400,  // 6月K 4小时
  kline_1y: 28800,  // 年K 8小时
  fund: 600,        // 基金估值 10分钟
  fund_nav: 86400,  // 基金净值 1天
  indicators: 300,  // 指标 5分钟
  signals: 300,     // 信号 5分钟
  backtest: 3600,   // 回测 1小时
};

// D1 存储上限（记录数），超过时自动清理
const MAX_RECORDS = 50000;
const CLEANUP_BATCH = 10000;

/**
 * 初始化数据库表（幂等）
 */
export async function initDB(db) {
  if (!db) return;
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL,
        cache_type TEXT NOT NULL,
        symbol TEXT,
        market TEXT,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_cache_key ON cache(cache_key);
      CREATE INDEX IF NOT EXISTS idx_cache_type ON cache(cache_type);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_symbol ON cache(symbol, cache_type);
    `);
  } catch (e) {
    console.error('initDB error:', e.message);
  }
}

/**
 * 生成缓存 key
 */
export function cacheKey(type, symbol, market, extra = '') {
  return `${type}:${symbol}:${market}:${extra}`.replace(/:+$/, '');
}

/**
 * 从缓存读取
 */
export async function cacheGet(db, key, ttlSeconds) {
  if (!db) return null;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
    const row = await db.prepare(
      'SELECT data, created_at FROM cache WHERE cache_key = ? AND created_at > ?'
    ).bind(key, cutoff).first();
    if (row) {
      return JSON.parse(row.data);
    }
    // 清理这条过期记录
    await db.prepare('DELETE FROM cache WHERE cache_key = ?').bind(key).run();
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入缓存
 */
export async function cacheSet(db, key, type, data, symbol = '', market = '') {
  if (!db) return;
  try {
    const json = JSON.stringify(data);
    // 先删除同 key 的旧数据
    await db.prepare('DELETE FROM cache WHERE cache_key = ?').bind(key).run();
    // 插入新数据
    await db.prepare(
      'INSERT INTO cache (cache_key, cache_type, symbol, market, data, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())'
    ).bind(key, type, symbol, market, json).run();
    // 异步检查是否需要清理（不阻塞主流程）
    checkCleanup(db).catch(() => {});
  } catch (e) {
    console.error('cacheSet error:', e.message);
  }
}

/**
 * 检查并清理旧数据
 */
async function checkCleanup(db) {
  try {
    const count = await db.prepare('SELECT COUNT(*) as cnt FROM cache').first();
    if (count && count.cnt > MAX_RECORDS) {
      // 删除最旧的一批
      await db.prepare(
        `DELETE FROM cache WHERE id IN (SELECT id FROM cache ORDER BY created_at ASC LIMIT ?)`
      ).bind(CLEANUP_BATCH).run();
      console.log(`Cleaned up ${CLEANUP_BATCH} old cache records`);
    }
  } catch (e) {
    // ignore
  }
}

/**
 * 手动清理所有过期数据
 */
export async function cleanExpired(db) {
  if (!db) return { deleted: 0 };
  try {
    const maxTTL = 86400; // 最大TTL
    const cutoff = Math.floor(Date.now() / 1000) - maxTTL;
    const result = await db.prepare('DELETE FROM cache WHERE created_at < ?').bind(cutoff).run();
    return { deleted: result.meta?.changes || 0 };
  } catch (e) {
    return { deleted: 0, error: e.message };
  }
}

/**
 * 获取缓存统计
 */
export async function cacheStats(db) {
  if (!db) return { total: 0 };
  try {
    const total = await db.prepare('SELECT COUNT(*) as cnt FROM cache').first();
    const byType = await db.prepare(
      'SELECT cache_type, COUNT(*) as cnt FROM cache GROUP BY cache_type'
    ).all();
    const oldest = await db.prepare('SELECT MIN(created_at) as ts FROM cache').first();
    const newest = await db.prepare('SELECT MAX(created_at) as ts FROM cache').first();

    return {
      total: total?.cnt || 0,
      byType: byType?.results || [],
      oldest: oldest?.ts ? new Date(oldest.ts * 1000).toISOString() : null,
      newest: newest?.ts ? new Date(newest.ts * 1000).toISOString() : null
    };
  } catch (e) {
    return { total: 0, error: e.message };
  }
}
