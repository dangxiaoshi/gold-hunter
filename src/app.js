const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DEFAULT_PORT,
  ALLOWED_ORIGINS,
  PUBLIC_DIR,
  PRODUCTS_PATH,
} = require('./constants');
const { readConfigFile, loadConfig, loadEditableConfig, saveConfig } = require('./repositories/config-repo');
const {
  syncCustomersFromSources,
  listCustomers,
  getCustomerMessages,
  appendMessages,
  replaceMessages,
  updateCustomer,
  deleteCustomer,
  createCustomer,
} = require('./services/customer-service');
const {
  syncKnowledgeBase,
  getKnowledgeBaseStatus,
  isKbSyncing,
  setKbSyncing,
} = require('./services/kb-service');
const {
  handleAnalyze,
  handleTactics,
  handleTacticsV1,
  handleChat,
  testModel,
} = require('./services/ai-service');

function deriveToken(password) {
  return crypto.createHash('sha256').update(`jinjie:${password}`).digest('hex');
}

function allowCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  }
}

function createApp({ port = DEFAULT_PORT } = {}) {
  const app = express();
  const initCfg = (() => {
    try {
      return readConfigFile();
    } catch {
      return {};
    }
  })();
  let sessionToken = deriveToken(initCfg.password || 'gaoqiantongxue');

  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(PUBLIC_DIR));

  app.use((req, res, next) => {
    allowCors(req, res);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.post('/api/login', (req, res) => {
    const cfg = loadConfig();
    const password = cfg.password || 'gaoqiantongxue';
    if (req.body.password === password) {
      sessionToken = deriveToken(password);
      res.json({ ok: true, token: sessionToken });
      return;
    }
    res.status(401).json({ ok: false, error: '密码错误' });
  });

  app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/health') return next();
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || token !== sessionToken) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/config', (req, res) => res.json(loadEditableConfig()));
  app.put('/api/config', (req, res) => {
    saveConfig(req.body);
    res.json({ ok: true });
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, port }));

  app.get('/api/products', (req, res) => {
    if (!fs.existsSync(PRODUCTS_PATH)) return res.json([]);
    try {
      res.json(JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')));
    } catch {
      res.json([]);
    }
  });
  app.put('/api/products', (req, res) => {
    fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  });

  app.post('/api/import', (req, res) => {
    res.json(syncCustomersFromSources({ force: true }));
  });

  app.get('/api/customers', (req, res) => {
    const { search, limit = 100, offset = 0 } = req.query;
    res.json(listCustomers({ search, limit, offset }));
  });

  app.get('/api/customers/:id/messages', (req, res) => {
    const messages = getCustomerMessages(req.params.id);
    if (!messages) return res.status(404).json({ error: 'not found' });
    res.json(messages);
  });

  app.post('/api/customers/:id/messages', (req, res) => {
    const result = appendMessages(req.params.id, Array.isArray(req.body?.messages) ? req.body.messages : []);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  });

  app.put('/api/customers/:id/messages', (req, res) => {
    const result = replaceMessages(req.params.id, Array.isArray(req.body?.messages) ? req.body.messages : []);
    if (result?.error === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result?.error === 'only_manual') {
      return res.status(400).json({ error: 'only manual customers support full message replace' });
    }
    res.json(result);
  });

  app.patch('/api/customers/:id', (req, res) => {
    const result = updateCustomer(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  });

  app.delete('/api/customers/:id', (req, res) => {
    const result = deleteCustomer(req.params.id);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  });

  app.post('/api/customers', (req, res) => {
    const result = createCustomer(req.body || {});
    if (result?.error === 'already_exists') return res.status(409).json({ error: 'already exists' });
    res.json(result);
  });

  app.post('/api/ai/analyze', handleAnalyze);
  app.post('/api/ai/tactics', handleTactics);
  app.post('/api/ai/tactics-v1', handleTacticsV1);
  app.post('/api/ai/chat', handleChat);

  app.get('/api/kb/status', (req, res) => {
    res.json(getKnowledgeBaseStatus());
  });

  app.post('/api/kb/sync', async (req, res) => {
    if (isKbSyncing()) return res.status(409).json({ error: '同步进行中，请稍候' });
    setKbSyncing(true);
    try {
      const result = await syncKnowledgeBase();
      res.json({
        ok: true,
        totalChunks: result.totalChunks,
        feishuChunks: result.feishuChunks,
        flomoChunks: result.flomoChunks,
      });
    } catch (error) {
      console.error('[kb-sync] 失败:', error);
      res.status(500).json({ error: error.message });
    } finally {
      setKbSyncing(false);
    }
  });

  app.post('/api/config/test-model', async (req, res) => {
    res.json(await testModel(req.body || {}));
  });

  return app;
}

module.exports = {
  createApp,
};
