# StockPulse v2.0 · 智能行情监测与趋势预测

## 🚀 v2.0 更新

### v2.0 新增功能

- **🎯 信号检测**：自动识别 MACD金叉/死叉、KDJ金叉/死叉、RSI超买/超卖、布林带突破、均线排列、放量/缩量、OBV资金流、WR/CCI 等 12+ 种技术信号
- **📐 9项技术指标**：MA、EMA、MACD、RSI、KDJ、BOLL、OBV、WR、CCI、DMI、VOL，全部前端实时计算
- **📊 综合评分系统**：多指标加权打分，自动研判趋势（看多/看空/震荡）+ 置信度
- **🔍 选股评分**：对自选股票批量评分，MACD底部金叉、RSI超卖、放量等多维度筛选
- **📈 子图指标**：支持 MACD、RSI、KDJ、WR 四种子图叠加显示
- **📉 VOL分析**：成交量均线（VMA5/10/20）+ 量比分析
- **🔔 预警系统**：价格突破/跌破、RSI超买/超卖、MACD金叉/死叉、放量监测，支持浏览器通知
- **📊 多股对比**：最多6只股票归一化走势叠加对比 + 指标横向对比表
- **🚀 回测引擎**：8种策略（MACD金叉/强势、RSI、KDJ、均线、布林、综合、MACD+止损），完整收益曲线、胜率、夏普比率、最大回撤统计

### 新增 API

| 接口 | 说明 |
|------|------|
| `/api/indicators?symbol=600519&market=A` | 获取全部技术指标 + 综合评分 |
| `/api/signals?symbol=600519&market=A` | 获取信号检测结果 |
| `/api/screen?symbols=600519,000858,300750` | 批量选股评分 |
| `/api/backtest?symbol=600519&strategy=macd_cross` | 策略回测 |

## 📦 D1 数据库缓存（可选）

启用 D1 缓存后，行情/K线数据自动缓存到 Cloudflare D1 (SQLite)，减少 API 调用，提升响应速度。

### 设置步骤

```bash
# 1. 创建 D1 数据库
npx wrangler d1 create stockpulse-db

# 2. 把输出的 database_id 填入 wrangler.toml

# 3. 部署
npx wrangler pages deploy . --project-name stockpulse
```

或通过 Dashboard：
1. **D1** → Create database → 名称 `stockpulse-db`
2. **Pages** → Settings → Functions → D1 database bindings → Add
3. Variable name: `DB`, Database: `stockpulse-db`

### 缓存策略

| 数据类型 | 缓存时间 | 说明 |
|---------|---------|------|
| 实时行情 | 30秒 | 高频刷新 |
| 日K/周K | 5-30分钟 | 按周期递增 |
| 月K/年K | 1-8小时 | 低频更新 |
| 基金估值 | 10分钟 | 盘中更新 |
| 技术指标 | 5分钟 | 随K线更新 |
| 回测结果 | 1小时 | 策略不变则复用 |

### 自动清理

- 存储上限：**50,000 条记录**
- 超出时自动删除最旧的 **10,000 条**
- 过期数据（>24小时）可通过 `/api/cache-clean` 手动清理
- 查看状态：`/api/cache-stats`

### 无 D1 也兼容

不配置 D1 时系统正常运行，只是每次请求都调用外部 API。D1 是纯增量优化。

## 快速部署

### 方式一：Wrangler CLI

```bash
npm install -g wrangler
wrangler login
cd stock-monitor
npx wrangler pages deploy . --project-name stockpulse
```

### 方式二：Git 集成（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 选择仓库 `stock-monitor`
4. Build command: 留空 | Build output directory: `/`
5. Save and Deploy → `https://stockpulse.pages.dev`

## 项目结构

```
stock-monitor/
├── index.html                      # 前端页面（增强版技术指标引擎）
├── functions/
│   └── api/
│       ├── [[path]].js             # Pages Functions API 代理
│       └── indicators-engine.js    # 服务端技术指标计算引擎
├── worker.js                       # Cloudflare Worker 单文件版本
├── wrangler.toml                   # Wrangler 配置
└── README.md
```

## 架构

```
浏览器 ──→ Cloudflare Pages
              │
              ├── /                → 静态 HTML
              └── /api/*           → Pages Functions
                    ├── /api/quote       → 实时行情（新浪/Yahoo）
                    ├── /api/kline       → K线数据（腾讯/Yahoo）
                    ├── /api/indicators  → 技术指标 + 综合评分 🆕
                    ├── /api/signals     → 信号检测 🆕
                    ├── /api/screen      → 选股评分 🆕
                    ├── /api/backtest    → 策略回测 🆕
                    ├── /api/fund        → 基金估值
                    └── /api/fund-nav    → 基金历史净值
```

## 技术指标说明

| 指标 | 说明 | 信号 |
|------|------|------|
| MA(5/10/20) | 移动平均线 | 金叉/死叉、多头/空头排列 |
| EMA(12/26) | 指数移动平均 | 趋势方向 |
| MACD(12,26,9) | 异同移动平均 | 金叉/死叉、零轴位置 |
| RSI(6/12/14) | 相对强弱指标 | 超买(>70)/超卖(<30) |
| KDJ(9,3,3) | 随机指标 | 金叉/死叉、超买/超卖区 |
| BOLL(20,2) | 布林带 | 触轨、收口/开口 |
| OBV | 能量潮 | 资金流入/流出 |
| WR(14) | 威廉指标 | 超买(>-20)/超卖(<-80) |
| CCI(14) | 顺势指标 | 超买(>100)/超卖(<-100) |
| DMI(14) | 趋向指标 | 多空力量对比 |
| VOL(5/10/20) | 成交量分析 | 放量/缩量、量比 |

## 数据源

| 市场 | 数据源 | 备注 |
|------|--------|------|
| A股 | 新浪财经 / 腾讯财经 | 实时行情 + K线 |
| 美股 | Yahoo Finance | 实时行情 + K线 |
| 基金 | 天天基金 | 估值 + 历史净值 |

## 刷新频率

报价自动刷新：**20秒**

## License

Apache License 2.0
