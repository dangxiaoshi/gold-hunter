const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'data', 'customers.json');
const PRODUCTS_PATH = path.join(__dirname, 'data', 'products.json');

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
  if (req.path === '/login') return next();
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
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.put('/api/config', (req, res) => { saveConfig(req.body); res.json({ ok: true }); });

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

  for await (const chunk of response.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
      } catch { /* skip */ }
    }
  }
  res.end();
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

  for await (const chunk of response.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta') {
          res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
        } else if (parsed.type === 'message_stop') {
          res.write('data: [DONE]\n\n');
        }
      } catch { /* skip */ }
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

  if (modelCfg.provider === 'anthropic') {
    await streamFromAnthropic(modelCfg.apiKey, modelCfg.id, msgs, res, modelCfg.baseUrl);
  } else {
    await streamFromOpenAI(modelCfg.baseUrl, modelCfg.apiKey, modelCfg.id, msgs, res);
  }
}

async function callAIWithMessages(messages, res) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(m => m.id === cfg.activeModel) || cfg.models[0];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (modelCfg.provider === 'anthropic') {
    await streamFromAnthropic(modelCfg.apiKey, modelCfg.id, messages, res, modelCfg.baseUrl);
  } else {
    await streamFromOpenAI(modelCfg.baseUrl, modelCfg.apiKey, modelCfg.id, messages, res);
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
const PORT = 3737;
app.listen(PORT, () => {
  console.log(`\n🏹 金币猎人 运行中 → http://localhost:${PORT}\n`);
});
