const fs = require('fs');
const { loadConfig } = require('../repositories/config-repo');
const {
  loadDB,
  saveDB,
  getEnrichedCache,
  setEnrichedCache,
  clearEnrichedCache,
} = require('../repositories/customer-repo');

const wechatFileCache = {};
const wechatFileMeta = {};
let importedSourceSignature = '';

function isGroupChat(name, messages) {
  if (!name) return false;
  if (name.includes('群') || name.includes('Group')) return true;
  const senders = new Set((messages || []).slice(0, 50).map(message => message.sender).filter(Boolean));
  return senders.size > 5;
}

function makeId(account, name) {
  return `${account}::${name}`;
}

function formatDateOnly(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
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

function normalizeSearchTerm(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesCustomerSearch(customer, query, cfg) {
  const term = normalizeSearchTerm(query);
  if (!term) return true;

  const baseFields = [
    customer.name,
    customer.id,
    customer.notes,
    customer.activeProduct,
    customer.account,
    cfg.accountLabels?.[customer.account],
    customer.lastMessage,
  ].filter(Boolean).map(normalizeSearchTerm);

  if (baseFields.some(field => field.includes(term))) return true;

  const data = getWechatData(customer.account, cfg);
  const messages = [...(data[customer.name] || []), ...((Array.isArray(customer.extraMessages) ? customer.extraMessages : []))];
  return messages.some(message => normalizeSearchTerm(message.content).includes(term) || normalizeSearchTerm(message.sender).includes(term));
}

function resolveAccountKey(filePath, cfg) {
  return Object.keys(cfg.accountLabels || {}).find(key => filePath.includes(key)) || 'unknown';
}

function getWechatFilePath(account, cfg) {
  return cfg.dataPaths.find(filePath => filePath.includes(account));
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
        id,
        name,
        account: accountKey,
        statusEmoji: '🔥',
        progressStage: 0,
        activeProduct: '',
        notes: '',
        hidden: false,
        pinned: false,
        unread: false,
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
    clearEnrichedCache();
  }

  return { imported, skipped, total: imported + skipped };
}

function listCustomers({ search, limit = 100, offset = 0 } = {}) {
  syncCustomersFromSources();
  let enriched = getEnrichedCache();
  const cfg = loadConfig();

  if (!enriched) {
    const db = loadDB();
    enriched = Object.values(db.customers)
      .filter(customer => !customer.hidden)
      .map(customer => {
        const data = getWechatData(customer.account, cfg);
        const messages = [...(data[customer.name] || []), ...((Array.isArray(customer.extraMessages) ? customer.extraMessages : []))];
        const activity = deriveCustomerActivity(messages, customer.updatedAt);
        return { ...customer, ...activity };
      });
    enriched.sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if ((b.lastActiveAt || 0) !== (a.lastActiveAt || 0)) return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
      return b.updatedAt - a.updatedAt;
    });
    setEnrichedCache(enriched);
    console.log(`[cache] enriched ${enriched.length} customers`);
  }

  let list = enriched;
  if (search) list = list.filter(customer => matchesCustomerSearch(customer, search, cfg));

  const total = list.length;
  const page = list.slice(Number(offset), Number(offset) + Number(limit));
  return { customers: page, total };
}

function getCustomerMessages(id) {
  const db = loadDB();
  const customer = db.customers[id];
  if (!customer) return null;

  const cfg = loadConfig();
  const data = getWechatData(customer.account, cfg);
  const manualMessages = (Array.isArray(customer.extraMessages) ? customer.extraMessages : [])
    .map(msg => (msg?.time ? msg : normalizeStoredMessage(msg, formatDateOnly(new Date(customer.updatedAt || Date.now())))))
    .filter(Boolean);
  return [...(data[customer.name] || []), ...manualMessages];
}

function appendMessages(id, incoming) {
  const db = loadDB();
  const customer = db.customers[id];
  if (!customer) return null;
  const appended = appendCustomerMessages(customer, incoming);
  customer.updatedAt = Date.now();
  saveDB(db);
  return {
    ok: true,
    appended,
    total: Array.isArray(customer.extraMessages) ? customer.extraMessages.length : 0
  };
}

function replaceMessages(id, incoming) {
  const db = loadDB();
  const customer = db.customers[id];
  if (!customer) return { error: 'not_found' };
  if (customer.account !== 'manual') return { error: 'only_manual' };

  const total = replaceCustomerMessages(customer, incoming);
  customer.updatedAt = Date.now();
  saveDB(db);
  return { ok: true, total };
}

function updateCustomer(id, patch) {
  const db = loadDB();
  const customer = db.customers[id];
  if (!customer) return null;

  const allowed = ['statusEmoji', 'progressStage', 'activeProduct', 'notes', 'hidden', 'pinned', 'unread'];
  for (const key of allowed) {
    if (patch[key] !== undefined) customer[key] = patch[key];
  }
  customer.updatedAt = Date.now();
  saveDB(db);
  return { ok: true };
}

function deleteCustomer(id) {
  const db = loadDB();
  const customer = db.customers[id];
  if (!customer) return null;
  delete db.customers[id];
  saveDB(db);
  return { ok: true };
}

function createCustomer({ name, account = 'manual' }) {
  const id = makeId(account, name);
  const db = loadDB();
  if (db.customers[id]) return { error: 'already_exists' };
  db.customers[id] = {
    id,
    name,
    account,
    statusEmoji: '🔥',
    progressStage: 0,
    activeProduct: '',
    notes: '',
    hidden: false,
    pinned: false,
    unread: false,
    extraMessages: [],
    updatedAt: Date.now()
  };
  saveDB(db);
  return db.customers[id];
}

module.exports = {
  syncCustomersFromSources,
  listCustomers,
  getCustomerMessages,
  appendMessages,
  replaceMessages,
  updateCustomer,
  deleteCustomer,
  createCustomer,
};
