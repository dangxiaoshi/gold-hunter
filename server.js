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
// Derived from password so it survives server restarts
function deriveToken(password) {
  return crypto.createHash('sha256').update('jinjie:' + password).digest('hex');
}
const _initCfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
let sessionToken = deriveToken(_initCfg.password || 'gaoqiantongxue');

app.post('/api/login', (req, res) => {
  const cfg = loadConfig();
  const password = cfg.password || 'gaoqiantongxue';
  if (req.body.password === password) {
    sessionToken = deriveToken(password);
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

// ── 知识库检索 ────────────────────────────────────────────────────────────────
const KB_PATH = path.join(__dirname, 'data', 'knowledge_base.json');
let _kb = null;

function loadKnowledgeBase() {
  if (_kb) return _kb;
  if (!fs.existsSync(KB_PATH)) return null;
  try {
    _kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    return _kb;
  } catch (e) {
    return null;
  }
}

// ── 飞书知识库同步 ─────────────────────────────────────────────────────────────
const FEISHU_APP_ID = 'cli_a9418569aaf8dbcb';
const FEISHU_APP_SECRET = 'rcQGwaS2orrHbD9JTqxyUgJKEKvu4Pn0';
const FEISHU_SPACE_ID = '7588802359464037335';

let _feishuToken = null;
let _feishuTokenExpiresAt = 0;
let _kbSyncing = false;

async function getFeishuToken() {
  if (_feishuToken && Date.now() < _feishuTokenExpiresAt) return _feishuToken;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
  });
  const data = await res.json();
  if (!data.tenant_access_token) throw new Error(`飞书 token 获取失败: ${JSON.stringify(data)}`);
  _feishuToken = data.tenant_access_token;
  _feishuTokenExpiresAt = Date.now() + (data.expire - 300) * 1000;
  return _feishuToken;
}

async function fetchAllWikiNodes(token) {
  const { default: fetch } = await import('node-fetch');
  const nodes = [];
  let pageToken = '';
  do {
    const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${FEISHU_SPACE_ID}/nodes?page_size=50${pageToken ? '&page_token=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`列出节点失败: ${JSON.stringify(data)}`);
    (data.data?.items || []).forEach(n => nodes.push(n));
    pageToken = data.data?.page_token || '';
  } while (pageToken);
  return nodes;
}

async function fetchDocContent(token, objToken) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://open.feishu.cn/open-apis/docx/v1/documents/${objToken}/raw_content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取文档内容失败 (${objToken}): ${JSON.stringify(data)}`);
  return data.data?.content || '';
}

function chunkDoc(docTitle, content) {
  // 先按【MM.DD】切出每天，再按 👇 切出当天的独立话题块
  const pattern = /【(\d{1,2}\.\d{2})】([^\n]*)/g;
  const chunks = [];
  let match;
  let lastIndex = 0;
  let lastDate = null;
  let lastTitleSuffix = '';

  function buildTopicChunk(date, rawTopic, body) {
    const topic = rawTopic.trim();
    const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const trimmedBody = body
      .trim()
      .replace(new RegExp(`^👇\\s*${escapedTopic}\\s*\\n*`), '')
      .trim();
    if (!trimmedBody) return null;
    return {
      docTitle,
      date,
      topic,
      tags: topic.split('+').map(tag => tag.trim()).filter(Boolean),
      content: trimmedBody,
    };
  }

  function chunkDay(date, titleSuffix, body) {
    const dayBody = body.trim();
    if (!dayBody) return;

    const topicPattern = /(^|\n)\s*👇\s*([^\n]+)\s*(?=\n|$)/g;
    const topicMatches = Array.from(dayBody.matchAll(topicPattern));

    if (topicMatches.length === 0) {
      const fallbackTopic = titleSuffix.trim();
      chunks.push({
        docTitle,
        date,
        topic: fallbackTopic,
        tags: fallbackTopic.split('+').map(tag => tag.trim()).filter(Boolean),
        content: dayBody,
      });
      return;
    }

    let leadingContent = dayBody.slice(0, topicMatches[0].index).trim();
    for (let i = 0; i < topicMatches.length; i++) {
      const topicMatch = topicMatches[i];
      const topic = topicMatch[2].trim();
      const markerStart = topicMatch.index + topicMatch[1].length;
      const markerLineEnd = dayBody.indexOf('\n', markerStart);
      const contentStart = markerLineEnd === -1 ? dayBody.length : markerLineEnd + 1;
      const contentEnd = i + 1 < topicMatches.length ? topicMatches[i + 1].index : dayBody.length;
      let topicContent = dayBody.slice(contentStart, contentEnd).trim();

      if (i === 0 && leadingContent) {
        topicContent = topicContent ? `${leadingContent}\n\n${topicContent}` : leadingContent;
      }

      const chunk = buildTopicChunk(date, topic, topicContent);
      if (chunk) chunks.push(chunk);
      leadingContent = '';
    }
  }

  while ((match = pattern.exec(content)) !== null) {
    if (lastDate !== null) {
      chunkDay(lastDate, lastTitleSuffix, content.slice(lastIndex, match.index));
    }
    lastDate = match[1];
    lastTitleSuffix = match[2] || '';
    lastIndex = match.index + match[0].length;
  }

  if (lastDate) {
    chunkDay(lastDate, lastTitleSuffix, content.slice(lastIndex));
  }

  return chunks;
}

async function syncKnowledgeBase() {
  console.log('\n[kb-sync] 开始同步飞书知识库...');
  const token = await getFeishuToken();

  // 拉全部节点
  const allNodes = await fetchAllWikiNodes(token);
  // 只同步销冠每日精华文档（标题含年月格式），跳过首页、系统文档、空标题
  const docNodes = allNodes.filter(n => n.obj_type === 'docx' && n.title && /【\d{4}年/.test(n.title));
  console.log(`[kb-sync] 共发现 ${docNodes.length} 篇文档`);

  const feishuChunks = [];
  let docChunkTotal = 0;
  for (let i = 0; i < docNodes.length; i++) {
    const node = docNodes[i];
    try {
      const content = await fetchDocContent(token, node.obj_token);
      const chunks = chunkDoc(node.title, content);
      feishuChunks.push(...chunks);
      docChunkTotal += chunks.length;
      console.log(`[kb-sync] [${i + 1}/${docNodes.length}] "${node.title}" → ${chunks.length} 块`);
    } catch (e) {
      console.error(`[kb-sync] [${i + 1}/${docNodes.length}] "${node.title}" 失败: ${e.message}`);
    }
  }

  // 加载现有知识库，保留非飞书的块（flomo 块没有 docTitle 字段）
  let existing = null;
  if (fs.existsSync(KB_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(KB_PATH, 'utf8')); } catch { /* ignore */ }
  }
  const flomoChunks = (existing?.chunks || []).filter(c => !c.docTitle);

  const merged = {
    updatedAt: new Date().toISOString(),
    feishuSyncedAt: new Date().toISOString(),
    totalChunks: flomoChunks.length + feishuChunks.length,
    feishuChunks: feishuChunks.length,
    flomoChunks: flomoChunks.length,
    chunks: [...flomoChunks, ...feishuChunks],
    ...(existing?.sourceFile ? { sourceFile: existing.sourceFile } : {}),
  };

  fs.writeFileSync(KB_PATH, JSON.stringify(merged, null, 2));
  _kb = null; // 清缓存，下次检索读新数据

  const avgChunksPerDoc = docNodes.length ? docChunkTotal / docNodes.length : 0;
  console.log(`[kb-sync] 总共切出 ${feishuChunks.length} 个飞书块，平均每篇 ${avgChunksPerDoc.toFixed(2)} 块`);
  console.log(`\n[kb-sync] ✅ 同步完成！飞书 ${feishuChunks.length} 块 + flomo ${flomoChunks.length} 块 = 共 ${merged.totalChunks} 块\n`);
  return merged;
}

// 阶段关键词映射（用于语料相关性打分）
const STAGE_KEYWORDS = {
  '建立链接': ['破冰', '信任', '初次', '链接', '了解', '打招呼', '认识'],
  '同步信息': ['情况', '确认', '了解', '背景', '信息'],
  '挖掘需求': ['痛点', '需求', '为什么', '挖', '封闭', '选择', '问题', '烦恼'],
  '解决顾虑': ['价格', '贵', '时间', '效果', '顾虑', '异议', '担心', '质疑', '考虑', '犹豫', '风险'],
  '达成成交': ['临门', '成交', '付款', '紧迫', '最后', '决定', '下单', '付钱', '转账'],
};

// 从最近聊天里提取关键词（滑动 n-gram，保证词语完整性）
function extractChatKeywords(messages, mySenderName) {
  const STOP = new Set(['我', '你', '他', '她', '的', '了', '是', '在', '有', '不', '也', '都', '和', '与', '但', '就', '把', '被', '让', '给', '对', '会', '能', '要', '想', '说', '看', '到', '很', '这', '那', '可以', '可能', '没有', '因为', '所以', '如果', '虽然', '但是', '什么', '怎么', '一个', '还是', '一下', '一点', '一些', '感觉', '其实', '然后', '这个', '那个']);
  // 只取客户消息（排除自己发的）
  const recent = (messages || []).slice(-10)
    .filter(m => m.sender !== mySenderName)
    .map(m => m.content || '').join('');
  // 只保留中文字符，滑动 bigram/trigram/4-gram 生成候选词
  const chars = recent.replace(/[^\u4e00-\u9fa5]/g, '');
  const freq = {};
  for (let i = 0; i < chars.length; i++) {
    for (let n = 2; n <= 4; n++) {
      if (i + n <= chars.length) {
        const w = chars.slice(i, i + n);
        if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
      }
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w);
}

function searchKnowledgeBase(stageName, messages, mySenderName, topN = 5) {
  const kb = loadKnowledgeBase();
  if (!kb || !kb.chunks || kb.chunks.length === 0) return [];

  const stageKws = STAGE_KEYWORDS[stageName] || [];
  const chatKws = extractChatKeywords(messages, mySenderName);

  const scored = kb.chunks.map(chunk => {
    let score = 0;
    const text = chunk.content;
    // 阶段关键词匹配（权重 2）
    stageKws.forEach(kw => { if (text.includes(kw)) score += 2; });
    // 聊天关键词匹配（权重 1）
    chatKws.forEach(kw => { if (text.includes(kw)) score += 1; });
    // 金句标签加分
    if (chunk.tags && chunk.tags.includes('💰/金句')) score += 1;
    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.chunk.content);
}

function buildKbSection(stageName, messages, mySenderName) {
  const results = searchKnowledgeBase(stageName, messages, mySenderName);
  if (results.length === 0) return '';
  const lines = results.map((r, i) => `${i + 1}. ${r.replace(/\n/g, ' ').slice(0, 200)}`).join('\n\n');
  return `\n\n--- 参考话术语料（这是真实销售中说过的原话，照这个腔调来，不要改写）---\n${lines}`;
}

// 检索相关飞书块（返回完整 chunk 对象，供前端展示原文）
function retrieveRelevantChunks(scenario, topN = 2) {
  const kb = loadKnowledgeBase();
  if (!kb || !kb.chunks || kb.chunks.length === 0) return [];

  // 从 scenario 提取 n-gram 关键词
  const STOP = new Set(['我', '你', '他', '她', '的', '了', '是', '在', '有', '不', '也', '都', '和', '与', '但', '就', '把', '被', '让', '给', '对', '会', '能', '要', '想', '说', '看', '到', '很', '这', '那', '可以', '可能', '没有', '因为', '所以', '如果', '虽然', '但是', '什么', '怎么', '一个', '还是', '一下', '一点', '一些', '感觉', '其实', '然后', '这个', '那个']);
  const chars = (scenario || '').replace(/[^\u4e00-\u9fa5]/g, '');
  const freq = {};
  for (let i = 0; i < chars.length; i++) {
    for (let n = 2; n <= 4; n++) {
      if (i + n <= chars.length) {
        const w = chars.slice(i, i + n);
        if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
      }
    }
  }
  const kws = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w);
  if (kws.length === 0) return [];

  // 只对飞书块评分（有 docTitle 字段的）
  const feishuChunks = kb.chunks.filter(c => c.docTitle);
  const scored = feishuChunks.map(chunk => {
    let score = 0;
    // tags 匹配（权重 3）
    (chunk.tags || []).forEach(tag => { kws.forEach(kw => { if (tag.includes(kw)) score += 3; }); });
    // topic 匹配（权重 2）
    kws.forEach(kw => { if ((chunk.topic || '').includes(kw)) score += 2; });
    // content 匹配（权重 1）
    kws.forEach(kw => { if (chunk.content.includes(kw)) score += 1; });
    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => ({ date: s.chunk.date, topic: s.chunk.topic, content: s.chunk.content }));
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

function formatDateOnly(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseMessageTimeToMs(time) {
  if (!time) return 0;
  const raw = String(time).trim();
  if (!raw) return 0;
  const normalized = /\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw} 00:00:00` : raw;
  const ms = new Date(normalized.replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function normalizeStoredMessage(msg, fallbackTime = formatDateOnly(new Date())) {
  if (!msg || typeof msg !== 'object') return null;
  const sender = String(msg.sender || '').trim();
  const content = String(msg.content || '').trim();
  const time = msg.time ? String(msg.time).trim() : String(fallbackTime || '').trim();
  if (!sender || !content) return null;
  return time ? { sender, content, time } : { sender, content };
}

function appendCustomerMessages(customer, incomingMessages) {
  const existing = Array.isArray(customer.extraMessages) ? customer.extraMessages : [];
  const existingKeys = new Set(existing.map(msg => `${msg.sender}::${msg.content}::${msg.time || ''}`));
  let appended = 0;
  const fallbackTime = formatDateOnly(new Date());

  for (const raw of incomingMessages || []) {
    const msg = normalizeStoredMessage(raw, fallbackTime);
    if (!msg) continue;
    const key = `${msg.sender}::${msg.content}::${msg.time || ''}`;
    if (existingKeys.has(key)) continue;
    existing.push(msg);
    existingKeys.add(key);
    appended++;
  }

  customer.extraMessages = existing;
  return appended;
}

function replaceCustomerMessages(customer, incomingMessages) {
  const fallbackTime = formatDateOnly(new Date(customer.updatedAt || Date.now()));
  customer.extraMessages = (incomingMessages || [])
    .map(msg => normalizeStoredMessage(msg, fallbackTime))
    .filter(Boolean);
  return customer.extraMessages.length;
}

function deriveCustomerActivity(messages, updatedAt) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1] || null;
  const messageCount = list.length;
  const lastContent = last?.content?.slice(0, 40) || '';
  const updatedMs = Number(updatedAt) || 0;
  const lastMs = parseMessageTimeToMs(last?.time);
  const fallbackMs = lastMs || updatedMs;
  const fallbackTime = last?.time || (fallbackMs ? formatDateOnly(fallbackMs) : '');
  return {
    last,
    lastMessage: lastContent,
    lastTime: fallbackTime,
    lastActiveAt: fallbackMs,
    messageCount
  };
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
  const result = syncCustomersFromSources({ force: true });
  res.json(result);
});

// In-memory file cache
const wechatFileCache = {};
const wechatFileMeta = {};
let importedSourceSignature = '';

function resolveAccountKey(filePath, cfg) {
  return Object.keys(cfg.accountLabels || {}).find(k => filePath.includes(k)) || 'unknown';
}

function getWechatFilePath(account, cfg) {
  return cfg.dataPaths.find(p => p.includes(account));
}

function getFileSnapshot(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, mtimeMs: 0, size: 0, signature: `${filePath || ''}::missing` };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    signature: `${filePath}::${stat.mtimeMs}::${stat.size}`
  };
}

function getSourceSignature(cfg) {
  return (cfg.dataPaths || [])
    .map(filePath => {
      const snapshot = getFileSnapshot(filePath);
      return `${resolveAccountKey(filePath, cfg)}::${snapshot.signature}`;
    })
    .join('||');
}

function getWechatData(account, cfg, opts = {}) {
  const filePath = getWechatFilePath(account, cfg);
  const snapshot = getFileSnapshot(filePath);
  const forceReload = Boolean(opts.forceReload);
  const prevMeta = wechatFileMeta[account];

  if (!forceReload && wechatFileCache[account] && prevMeta?.signature === snapshot.signature) {
    return wechatFileCache[account];
  }

  if (!filePath || !snapshot.exists) {
    wechatFileCache[account] = {};
    wechatFileMeta[account] = snapshot;
    return {};
  }

  try {
    console.log(`[cache] loading ${account}...`);
    wechatFileCache[account] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    wechatFileMeta[account] = snapshot;
    console.log(`[cache] ${account} loaded, ${Object.keys(wechatFileCache[account]).length} contacts`);
  } catch {
    wechatFileCache[account] = {};
    wechatFileMeta[account] = snapshot;
  }
  return wechatFileCache[account];
}

function syncCustomersFromSources(opts = {}) {
  const force = Boolean(opts.force);
  const cfg = loadConfig();
  const sourceSignature = getSourceSignature(cfg);

  if (!force && importedSourceSignature === sourceSignature) {
    return { imported: 0, skipped: 0, total: 0 };
  }

  const db = loadDB();
  let imported = 0;
  let skipped = 0;

  for (const filePath of cfg.dataPaths || []) {
    if (!fs.existsSync(filePath)) continue;
    const accountKey = resolveAccountKey(filePath, cfg);
    const data = getWechatData(accountKey, cfg, { forceReload: force });

    for (const [name, messages] of Object.entries(data)) {
      if (!Array.isArray(messages) || messages.length === 0) continue;
      if (isGroupChat(name, messages)) continue;
      const id = makeId(accountKey, name);
      if (db.customers[id]) {
        skipped++;
        continue;
      }
      db.customers[id] = {
        id, name, account: accountKey,
        statusEmoji: '🔥', progressStage: 0,
        activeProduct: '', notes: '', hidden: false, pinned: false, unread: false,
        updatedAt: Date.now()
      };
      imported++;
    }
  }

  importedSourceSignature = sourceSignature;

  if (imported > 0) {
    saveDB(db);
    console.log(`[contacts] auto-imported ${imported} new customers`);
  } else {
    enrichedCache = null;
  }

  return { imported, skipped, total: imported + skipped };
}

// Customers list
app.get('/api/customers', (req, res) => {
  syncCustomersFromSources();
  const { search, limit = 100, offset = 0 } = req.query;

  if (!enrichedCache) {
    const db = loadDB();
    const cfg = loadConfig();
    const all = Object.values(db.customers).filter(c => !c.hidden).map(c => {
      const data = getWechatData(c.account, cfg);
      const msgs = [...(data[c.name] || []), ...((Array.isArray(c.extraMessages) ? c.extraMessages : []))];
      const activity = deriveCustomerActivity(msgs, c.updatedAt);
      return { ...c, ...activity };
    });
    all.sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if ((b.lastActiveAt || 0) !== (a.lastActiveAt || 0)) return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
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
  const manualMessages = (Array.isArray(customer.extraMessages) ? customer.extraMessages : []).map(msg => {
    if (msg?.time) return msg;
    return normalizeStoredMessage(msg, formatDateOnly(new Date(customer.updatedAt || Date.now())));
  }).filter(Boolean);
  res.json([...(data[customer.name] || []), ...manualMessages]);
});

app.post('/api/customers/:id/messages', (req, res) => {
  const db = loadDB();
  const customer = db.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'not found' });

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const appended = appendCustomerMessages(customer, incoming);
  customer.updatedAt = Date.now();
  saveDB(db);
  res.json({
    ok: true,
    appended,
    total: Array.isArray(customer.extraMessages) ? customer.extraMessages.length : 0
  });
});

app.put('/api/customers/:id/messages', (req, res) => {
  const db = loadDB();
  const customer = db.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'not found' });

  if (customer.account !== 'manual') {
    return res.status(400).json({ error: 'only manual customers support full message replace' });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const total = replaceCustomerMessages(customer, incoming);
  customer.updatedAt = Date.now();
  saveDB(db);
  res.json({ ok: true, total });
});

// Update customer state
app.patch('/api/customers/:id', (req, res) => {
  const db = loadDB();
  const c = db.customers[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });

  const allowed = ['statusEmoji', 'progressStage', 'activeProduct', 'notes', 'hidden', 'pinned', 'unread'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) c[key] = req.body[key];
  }
  c.updatedAt = Date.now();
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/customers/:id', (req, res) => {
  const db = loadDB();
  const customer = db.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'not found' });
  delete db.customers[req.params.id];
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
    activeProduct: '', notes: '', hidden: false, pinned: false, unread: false, extraMessages: [], updatedAt: Date.now()
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

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

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

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

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
  const kbSection = buildKbSection(curr, messages, cfg.mySenderName);

  // 检索飞书知识库相关块
  const scenario = (messages || []).slice(-5).map(m => m.content || '').join(' ');
  const referenceChunks = retrieveRelevantChunks(scenario);

  const system = `你是顶级销售教练，专注知识付费产品。
客户状态：${phase || '跟进'}客户，${contactDesc}。${phaseNote}
当前：客户"${customerName}"，产品"${product || '未指定'}"，阶段"${curr}"，目标推进到"${next}"。${productSection}${scriptsSection}${kbSection}

输出格式（严格按此）：
【意图分析】
（结合客户状态，分析真实心理，2-3句，要犀利准确）

【A话术】——直接推进型
（适合意向明显的客户，口语化，符合当前${phase || '跟进'}阶段）

【B话术】——迂回试探型
（侧面建立连接，适合还有顾虑的客户）

【C话术】——价值强化型
（重新激发痛点，适合还在观望的客户）`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (referenceChunks.length > 0) {
    res.write(`data: ${JSON.stringify({ referenceChunks })}\n\n`);
  }
  await callAI(system, `最近聊天记录：\n\n${recentMsgs}`, res);
});

// 🏹 直接出击: 完整上下文，输出更贴近真人微信口语
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
  const kbSection = buildKbSection(curr, messages, cfg.mySenderName);

  // 检索飞书知识库相关块
  const scenario = (messages || []).slice(-5).map(m => m.content || '').join(' ');
  const referenceChunks = retrieveRelevantChunks(scenario);

  const system = `你是「金币猎人」销售助手，专门帮助销售人员应对客户对话、挑选话术、优化表达。

## 你的产品
播客私教课（帮助学员从零开始做播客，实现引流变现）。主理人：当小时，《搞钱搞流量》播客主理人，全平台公域粉丝破百万，私域发售一小时40w。

## 销售人员风格
- 亲切口语化，习惯称客户为宝或宝子
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

## 阶段策略要求
- 建立链接：先让客户愿意聊，不急着推产品
- 同步信息：先把客户背景、现状、卡点、目标对齐
- 挖掘需求：这是最关键的一步，优先帮销售把客户真正想要什么、为什么现在想做、最担心什么、卡在哪一步聊出来
- 只要还在挖掘需求阶段，就不要急着给完整方案，不要急着报价，不要急着催成交
- 挖掘需求阶段的话术重点是继续追问、确认、放大需求，让客户自己把需求说实，而不是替客户直接下结论
- 解决顾虑：针对客户已经说出口的担心逐个化解
- 达成成交：只在需求和顾虑已经聊透时，才给临门一脚

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

## 话术硬性要求
- 给客户的话必须像真人在微信里发消息，能直接复制发送
- 严禁使用双引号、书名号包裹整句、markdown加粗符号、项目符号、数字清单、A/B/C、1/2/3 这类模板化表达
- 严禁写成培训课讲义、分析报告、客服公告、销售SOP
- 不要一上来长篇大论，语气要自然，有停顿感，像真实销售在顺着对方的话往下聊
- 可以给多个说法，但必须用自然语言区分，比如更柔一点、再直接一点、想继续往下挖可以这样聊
- 如果当前阶段是挖掘需求，优先输出继续挖需求的话术，不要跳到成交话术
- 优先用口语并列来给客户选择感，比如你是更想先搞清楚这个，还是更想先解决那个，还是你现在最卡的是这块
- 除非客户已经明显准备付款，否则不要上来就逼单
${productSection}${scriptsSection}${kbSection}

## 输出格式（严格按此）
当前阶段：阶段名（X/5） + 一句精准判断
客户类型判断：类型 + 2到3个关键信号
一句话判断：直接说清这个客户是谁、现在真正想要什么

推荐先发：
直接给一段可复制发送的话术，必须是自然微信口语

如果想聊得更柔一点：
直接给一段可复制发送的话术，必须是自然微信口语

如果想继续往下推进：
直接给一段可复制发送的话术，必须是自然微信口语

为什么这样聊：
只用2到3句解释策略

额外要求：
如果当前阶段是挖掘需求，那么三段话术里至少两段必须以继续挖需求为主，帮助销售把客户的目标、动机、痛点和顾虑聊出来，不要急着推方案或催成交。`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (referenceChunks.length > 0) {
    res.write(`data: ${JSON.stringify({ referenceChunks })}\n\n`);
  }
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

// ── 知识库管理路由 ────────────────────────────────────────────────────────────
app.get('/api/kb/status', (req, res) => {
  if (!fs.existsSync(KB_PATH)) return res.json({ exists: false });
  try {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    res.json({
      exists: true,
      syncing: _kbSyncing,
      updatedAt: kb.updatedAt,
      feishuSyncedAt: kb.feishuSyncedAt || null,
      totalChunks: kb.totalChunks,
      feishuChunks: kb.feishuChunks || 0,
      flomoChunks: kb.flomoChunks || 0,
    });
  } catch { res.json({ exists: true, error: '读取失败' }); }
});

app.post('/api/kb/sync', async (req, res) => {
  if (_kbSyncing) return res.status(409).json({ error: '同步进行中，请稍候' });
  _kbSyncing = true;
  try {
    const result = await syncKnowledgeBase();
    res.json({
      ok: true,
      totalChunks: result.totalChunks,
      feishuChunks: result.feishuChunks,
      flomoChunks: result.flomoChunks,
    });
  } catch (e) {
    console.error('[kb-sync] 失败:', e);
    res.status(500).json({ error: e.message });
  } finally {
    _kbSyncing = false;
  }
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
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🏹 金币猎人 运行中 → http://localhost:${PORT}\n`);
  });
}

module.exports = {
  app,
  chunkDoc,
  syncKnowledgeBase,
};
