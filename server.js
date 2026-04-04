const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const DEFAULT_PORT = 3737;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3737',
  'http://127.0.0.1:3737',
  'https://dangxiaoshi.github.io'
]);

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'data', 'customers.json');
const PRODUCTS_PATH = path.join(__dirname, 'data', 'products.json');

function allowCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  }
}

app.use((req, res, next) => {
  allowCors(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Session Token Auth ────────────────────────────────────────────────────────
let sessionToken = null;

app.post('/api/login', (req, res) => {
  const cfg = loadConfig();
  const password = cfg.password || 'gaoqiantongxue';
  if (req.body.password === password) {
    sessionToken = crypto.randomUUID();
    res.json({ ok: true, token: sessionToken });
  } else {
    res.status(401).json({ ok: false, error: '密码错误' });
  }
});

// Protect all /api/* except /api/login
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/health') return next();
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== sessionToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ── JSON DB ───────────────────────────────────────────────────────────────────
let dbCache = null;
let enrichedCache = null;

function loadDB() {
  if (dbCache) return dbCache;
  if (!fs.existsSync(DB_PATH)) { dbCache = { customers: {} }; return dbCache; }
  try { dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); return dbCache; }
  catch { dbCache = { customers: {} }; return dbCache; }
}

function saveDB(db) {
  dbCache = db;
  enrichedCache = null;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Config ────────────────────────────────────────────────────────────────────
function readConfigFile() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function modelEnvPrefix(id) {
  return `GH2_MODEL_${String(id || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`;
}

function applyEnvOverrides(cfg) {
  const next = JSON.parse(JSON.stringify(cfg || {}));
  if (process.env.GH2_PASSWORD) next.password = process.env.GH2_PASSWORD;
  if (process.env.GH2_ACTIVE_MODEL) next.activeModel = process.env.GH2_ACTIVE_MODEL;

  next.models = (next.models || []).map(model => {
    const prefix = modelEnvPrefix(model.id);
    return {
      ...model,
      apiKey: process.env[`${prefix}_API_KEY`] || model.apiKey,
      baseUrl: process.env[`${prefix}_BASE_URL`] || model.baseUrl
    };
  });

  return next;
}

function loadConfig() {
  return applyEnvOverrides(readConfigFile());
}

function loadEditableConfig() {
  return readConfigFile();
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isGroupChat(name, messages) {
  if (!name) return false;
  if (name.includes('群') || name.includes('Group')) return true;
  const senders = new Set((messages || []).slice(0, 50).map(m => m.sender).filter(Boolean));
  if (senders.size > 5) return true;
  return false;
}

function makeId(account, name) {
  return `${account}::${name}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Config
app.get('/api/config', (req, res) => res.json(loadEditableConfig()));
app.put('/api/config', (req, res) => { saveConfig(req.body); res.json({ ok: true }); });
app.get('/api/health', (req, res) => res.json({ ok: true, port: PORT }));

// ── Products ──────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  if (!fs.existsSync(PRODUCTS_PATH)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'))); }
  catch { res.json([]); }
});
app.put('/api/products', (req, res) => {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Import
app.post('/api/import', (req, res) => {
  const cfg = loadConfig();
  const db = loadDB();
  let imported = 0, skipped = 0;

  for (const filePath of cfg.dataPaths) {
    if (!fs.existsSync(filePath)) { skipped++; continue; }
    const accountKey = Object.keys(cfg.accountLabels || {}).find(k => filePath.includes(k)) || 'unknown';
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { continue; }

    for (const [name, messages] of Object.entries(data)) {
      if (!Array.isArray(messages) || messages.length === 0) continue;
      if (isGroupChat(name, messages)) continue;
      const id = makeId(accountKey, name);
      if (db.customers[id]) { skipped++; continue; }
      db.customers[id] = {
        id, name, account: accountKey,
        statusEmoji: '🔥', progressStage: 0,
        activeProduct: '', notes: '', hidden: false,
        updatedAt: Date.now()
      };
      imported++;
    }
  }

  saveDB(db);  // also clears enrichedCache
  res.json({ imported, skipped, total: imported + skipped });
});

// In-memory file cache (loaded once on first request)
const wechatFileCache = {};
function getWechatData(account, cfg) {
  if (wechatFileCache[account]) return wechatFileCache[account];
  const filePath = cfg.dataPaths.find(p => p.includes(account));
  if (!filePath || !fs.existsSync(filePath)) { wechatFileCache[account] = {}; return {}; }
  try {
    console.log(`[cache] loading ${account}...`);
    wechatFileCache[account] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`[cache] ${account} loaded, ${Object.keys(wechatFileCache[account]).length} contacts`);
  } catch { wechatFileCache[account] = {}; }
  return wechatFileCache[account];
}

// Customers list
app.get('/api/customers', (req, res) => {
  const { search, limit = 100, offset = 0 } = req.query;

  if (!enrichedCache) {
    const db = loadDB();
    const cfg = loadConfig();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const all = Object.values(db.customers).filter(c => !c.hidden).map(c => {
      const data = getWechatData(c.account, cfg);
      const msgs = data[c.name] || [];
      const last = msgs[msgs.length - 1];
      const lastTime = last?.time || '';
      const messageCount = msgs.length;
      const lastMs = lastTime ? new Date(lastTime.replace(' ', 'T')).getTime() : 0;
      const highIntent = !isNaN(lastMs) && lastMs >= thirtyDaysAgo && messageCount >= 5;
      return { ...c, lastMessage: last?.content?.slice(0, 40) || '', lastTime, messageCount, highIntent };
    });
    all.sort((a, b) => {
      if (b.highIntent !== a.highIntent) return (b.highIntent ? 1 : 0) - (a.highIntent ? 1 : 0);
      return b.updatedAt - a.updatedAt;
    });
    enrichedCache = all;
    console.log(`[cache] enriched ${all.length} customers`);
  }

  let list = enrichedCache;
  if (search) list = list.filter(c => c.name.includes(search));

  const total = list.length;
  const page = list.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ customers: page, total });
});

// Customer messages
app.get('/api/customers/:id/messages', (req, res) => {
  const db = loadDB();
  const customer = db.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'not found' });

  const cfg = loadConfig();
  const data = getWechatData(customer.account, cfg);
  res.json(data[customer.name] || []);
});

// Update customer state
app.patch('/api/customers/:id', (req, res) => {
  const db = loadDB();
  const c = db.customers[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });

  const allowed = ['statusEmoji', 'progressStage', 'activeProduct', 'notes', 'hidden'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) c[key] = req.body[key];
  }
  c.updatedAt = Date.now();
  saveDB(db);
  res.json({ ok: true });
});

// Add customer manually
app.post('/api/customers', (req, res) => {
  const { name, account = 'manual' } = req.body;
  const id = makeId(account, name);
  const db = loadDB();
  if (db.customers[id]) return res.status(409).json({ error: 'already exists' });
  db.customers[id] = {
    id, name, account, statusEmoji: '🔥', progressStage: 0,
    activeProduct: '', notes: '', hidden: false, updatedAt: Date.now()
  };
  saveDB(db);
  res.json(db.customers[id]);
});

// ── AI Streaming ──────────────────────────────────────────────────────────────
async function streamFromOpenAI(baseUrl, apiKey, model, messages, res) {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 2000 })
  });

  if (!response.ok) {
    const err = await response.text();
    res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
    res.end(); return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6));

      for (const data of dataLines) {
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
        } catch { /* skip partial/non-json event */ }
      }
    }
  }
  res.end();
}

function writeStreamError(res, error) {
  const message = error?.message || String(error);
  try {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch { /* ignore secondary write errors */ }
  try { res.end(); } catch { /* ignore */ }
}

async function streamFromAnthropic(apiKey, model, messages, res, baseUrl) {
  const { default: fetch } = await import('node-fetch');
  const sysMsg = messages.find(m => m.role === 'system')?.content;
  const endpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model, max_tokens: 2000, stream: true,
      ...(sysMsg ? { system: sysMsg } : {}),
      messages: messages.filter(m => m.role !== 'system')
    })
  });

  if (!response.ok) {
    const err = await response.text();
    res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
    res.end(); return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6));

      for (const data of dataLines) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
          } else if (parsed.type === 'message_stop') {
            res.write('data: [DONE]\n\n');
          }
        } catch { /* skip partial/non-json event */ }
      }
    }
  }
  res.end();
}

async function callAI(systemPrompt, userContent, res) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(m => m.id === cfg.activeModel) || cfg.models[0];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const msgs = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  try {
    if (modelCfg.provider === 'anthropic') {
      await streamFromAnthropic(modelCfg.apiKey, modelCfg.id, msgs, res, modelCfg.baseUrl);
    } else {
      await streamFromOpenAI(modelCfg.baseUrl, modelCfg.apiKey, modelCfg.id, msgs, res);
    }
  } catch (error) {
    console.error('[ai] callAI failed:', error);
    writeStreamError(res, error);
  }
}

async function callAIWithMessages(messages, res) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(m => m.id === cfg.activeModel) || cfg.models[0];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (modelCfg.provider === 'anthropic') {
      await streamFromAnthropic(modelCfg.apiKey, modelCfg.id, messages, res, modelCfg.baseUrl);
    } else {
      await streamFromOpenAI(modelCfg.baseUrl, modelCfg.apiKey, modelCfg.id, messages, res);
    }
  } catch (error) {
    console.error('[ai] callAIWithMessages failed:', error);
    writeStreamError(res, error);
  }
}

// Analyze: 产品识别 + 进度评估
app.post('/api/ai/analyze', async (req, res) => {
  const { messages, customerName } = req.body;
  const cfg = loadConfig();
  const recentMsgs = (messages || []).slice(-30)
    .map(m => `[${m.sender === cfg.mySenderName ? '我' : customerName}] ${m.content}`)
    .join('\n');

  const system = `你是销售助理，分析微信聊天记录，输出：
产品：（从以下选一个或说"未识别"）${cfg.products.join('、')}
进度：（从以下选一个）${cfg.progressStages.join(' → ')}
分析：（2-3句话，客户意向和当前状态）`;

  await callAI(system, `与"${customerName}"的最近聊天（${messages?.length || 0}条中最近30条）：\n\n${recentMsgs}`, res);
});

// 🏹 出击: 意图分析 + A/B/C 话术
app.post('/api/ai/tactics', async (req, res) => {
  const { messages, customerName, product, progressStage, daysSince, phase, productCard, sampleScripts } = req.body;
  const cfg = loadConfig();
  const stages = cfg.progressStages;
  const curr = stages[progressStage] || stages[0];
  const next = stages[Math.min((progressStage || 0) + 1, stages.length - 1)];

  const recentMsgs = (messages || []).slice(-20)
    .map(m => `[${m.sender === cfg.mySenderName ? '我' : customerName}] ${m.content}`)
    .join('\n');

  const contactDesc = daysSince === 0 ? '今天有互动'
    : daysSince === 1 ? '昨天有互动'
    : daysSince != null ? `已${daysSince}天未互动`
    : '互动时间未知';

  const phaseNote = phase === '唤醒'
    ? '⚠️ 唤醒客户：超过30天未联系，话术要先破冰重建连接，不要上来就推产品。'
    : phase === '新客'
    ? '🌱 新客户：消息较少，话术以建立信任为主，不要过度推销。'
    : '🔥 跟进客户：正在推进中，话术直接推动成交。';

  const productSection = productCard ? `\n\n--- 产品资料 ---\n${productCard}` : '';
  const scriptsSection = (sampleScripts && sampleScripts.length)
    ? `\n\n--- 参考话术（来自话术库，仅供风格参考，不要直接照抄）---\n${sampleScripts.map((s, i) => `${i+1}. ${s}`).join('\n\n')}`
    : '';

  const system = `你是顶级销售教练，专注知识付费产品。
客户状态：${phase || '跟进'}客户，${contactDesc}。${phaseNote}
当前：客户"${customerName}"，产品"${product || '未指定'}"，阶段"${curr}"，目标推进到"${next}"。${productSection}${scriptsSection}

输出格式（严格按此）：
【意图分析】
（结合客户状态，分析真实心理，2-3句，要犀利准确）

【A话术】——直接推进型
（适合意向明显的客户，口语化，符合当前${phase || '跟进'}阶段）

【B话术】——迂回试探型
（侧面建立连接，适合还有顾虑的客户）

【C话术】——价值强化型
（重新激发痛点，适合还在观望的客户）`;

  await callAI(system, `最近聊天记录：\n\n${recentMsgs}`, res);
});

// 🏹 出击 v1 style: 完整上下文，富输出（阶段+客户类型+话术+理由）
app.post('/api/ai/tactics-v1', async (req, res) => {
  const { messages, customerName, product, progressStage, productCard, sampleScripts } = req.body;
  const cfg = loadConfig();
  const stages = cfg.progressStages;
  const curr = stages[progressStage] || stages[0];
  const next = stages[Math.min((progressStage || 0) + 1, stages.length - 1)];

  const allMsgs = (messages || [])
    .map(m => `[${m.time || ''}] [${m.sender === cfg.mySenderName ? '我' : customerName}] ${m.content}`)
    .join('\n');

  const productSection = productCard ? `\n\n---产品资料---\n${productCard}` : '';
  const scriptsSection = (sampleScripts && sampleScripts.length)
    ? `\n\n---话术库（仅供风格参考，不要照抄）---\n${sampleScripts.map((s, i) => `${i+1}. ${s}`).join('\n\n')}`
    : '';

  const system = `你是「金币猎人」销售助手，专门帮助销售人员应对客户对话、挑选话术、优化表达。

## 你的产品
播客私教课（帮助学员从零开始做播客，实现引流变现）。主理人：当小时，《搞钱搞流量》播客主理人，全平台公域粉丝破百万，私域发售一小时40w。

## 销售人员风格
- 亲切口语化，习惯称客户为"宝"或"宝子"
- 善用真实案例建立信任（如：我有个学员做美业，两位数播放就卖出2980的产品）
- 会用紧迫感推动决策（如：今天最后一天/涨价前）
- 不强推，先共情、再挖需求、再给方案

## 销售阶段（靠谱成交五步法）
1. 建立链接——初次接触，了解客户背景，建立信任
2. 同步信息——确认客户情况，对齐认知
3. 挖掘需求——找到客户痛点，激发对播客的兴趣
4. 解决顾虑——回应价格/时间/效果等疑虑
5. 达成成交——给出临门一脚，推动付款
当前阶段：${curr}，目标推进到：${next}

## 客户类型
- 学生小白：没收入/刚起步，在乎学到什么、能不能赚到钱
- 在职副业：有工作，时间有限，在乎投入产出比
- 转介绍：朋友推荐来的，信任基础高，在乎具体权益
- 公域：从抖音/小红书/视频号来的，在乎差异化和竞争优势
- 自由职业：已有一技之长，在乎如何用播客放大已有优势
- 个人成长：想提升自己，在乎知识和社群价值

## 核心销售技巧（搞钱搞流量方法论）
- 等价交换：每个行动指令配备奖励，给予vs索取要分清
- 封闭式选项：挖需求给1/2/3让客户选，降低门槛
- 肯定需求：帮客户把模糊需求变成板上钉钉
- 极限场景：把日常问题拉到最坏结果，恐惧被惊动希望才出场
- 愿景钩子：描绘"到时候"的具体场景，种草进心里变成心锚
- 残缺效应：永远留一个底牌让对方主动来找你
- 成交梯度钩子：低价成交后告知可补差价升级，埋下高价单伏笔
- 可聊不交付：成交前只描述结果，不交付具体方案
${productSection}${scriptsSection}

## 输出格式（严格按此）
📍 当前阶段：**阶段名（X/5）→ 对当前实际进展的精准判断**
📌 客户类型判断：**类型 + 2-3个关键信号（直接引用聊天里的原话或行为）**

——一句话说清这个客户是谁、现在真正想要什么。

---

✅ 推荐话术①【话术定位标签】→ 适合场景一句话
> （话术正文，口语化，可直接复制发送）

💡 *为什么用这条*：（2-3句，说清心理机制和使用时机）

---

✅ 推荐话术②【话术定位标签】→ 适合场景一句话
> （话术正文，口语化，可直接复制发送）

💡 *为什么用这条*：（2-3句，说清心理机制和使用时机）

---

⚠️ 下一句必须说的话（直接复制粘贴发）：
> （一句临门一脚，承接上面所有话术选择，消除决策负担）`;

  await callAI(system, `客户"${customerName}"的完整聊天记录（共${(messages||[]).length}条，含日期）：\n\n${allMsgs}`, res);
});

// AI multi-turn chat
app.post('/api/ai/chat', async (req, res) => {
  const { history, customerName, recentMessages } = req.body;
  const cfg = loadConfig();

  const context = (recentMessages || []).slice(-20)
    .map(m => `[${m.sender === cfg.mySenderName ? '我' : customerName}] ${m.content}`)
    .join('\n');

  const systemPrompt = `你是金币猎人销售助理，正在协助跟进客户"${customerName}"。
${context ? `\n最近聊天记录：\n${context}\n` : ''}
你可以：分析客户意向、生成话术、回答销售策略问题。回答简洁专业，中文。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || [])
  ];

  await callAIWithMessages(messages, res);
});

// Test model
app.post('/api/config/test-model', async (req, res) => {
  const { provider, apiKey, baseUrl, id } = req.body;
  const { default: fetch } = await import('node-fetch');
  try {
    if (provider === 'anthropic') {
      const endpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: id, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      });
      res.json({ ok: r.ok, status: r.status });
    } else {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: id, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      });
      res.json({ ok: r.ok, status: r.status });
    }
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
app.listen(PORT, () => {
  console.log(`\n🏹 金币猎人 运行中 → http://localhost:${PORT}\n`);
});
