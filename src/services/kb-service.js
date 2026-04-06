const fs = require('fs');
const {
  KB_PATH,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_SPACE_ID,
  STAGE_KEYWORDS,
} = require('../constants');

let kbCache = null;
let feishuToken = null;
let feishuTokenExpiresAt = 0;
let kbSyncing = false;

function loadKnowledgeBase() {
  if (kbCache) return kbCache;
  if (!fs.existsSync(KB_PATH)) return null;
  try {
    kbCache = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    return kbCache;
  } catch {
    return null;
  }
}

async function getFeishuToken() {
  if (feishuToken && Date.now() < feishuTokenExpiresAt) return feishuToken;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
  });
  const data = await res.json();
  if (!data.tenant_access_token) throw new Error(`飞书 token 获取失败: ${JSON.stringify(data)}`);
  feishuToken = data.tenant_access_token;
  feishuTokenExpiresAt = Date.now() + (data.expire - 300) * 1000;
  return feishuToken;
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
    (data.data?.items || []).forEach(node => nodes.push(node));
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
  const allNodes = await fetchAllWikiNodes(token);
  const docNodes = allNodes.filter(node => node.obj_type === 'docx' && node.title && /【\d{4}年/.test(node.title));
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
    } catch (error) {
      console.error(`[kb-sync] [${i + 1}/${docNodes.length}] "${node.title}" 失败: ${error.message}`);
    }
  }

  let existing = null;
  if (fs.existsSync(KB_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    } catch {
      existing = null;
    }
  }
  const flomoChunks = (existing?.chunks || []).filter(chunk => !chunk.docTitle);

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
  kbCache = null;

  const avgChunksPerDoc = docNodes.length ? docChunkTotal / docNodes.length : 0;
  console.log(`[kb-sync] 总共切出 ${feishuChunks.length} 个飞书块，平均每篇 ${avgChunksPerDoc.toFixed(2)} 块`);
  console.log(`\n[kb-sync] ✅ 同步完成！飞书 ${feishuChunks.length} 块 + flomo ${flomoChunks.length} 块 = 共 ${merged.totalChunks} 块\n`);
  return merged;
}

function extractChatKeywords(messages, mySenderName) {
  const stopWords = new Set(['我', '你', '他', '她', '的', '了', '是', '在', '有', '不', '也', '都', '和', '与', '但', '就', '把', '被', '让', '给', '对', '会', '能', '要', '想', '说', '看', '到', '很', '这', '那', '可以', '可能', '没有', '因为', '所以', '如果', '虽然', '但是', '什么', '怎么', '一个', '还是', '一下', '一点', '一些', '感觉', '其实', '然后', '这个', '那个']);
  const recent = (messages || []).slice(-10)
    .filter(message => message.sender !== mySenderName)
    .map(message => message.content || '').join('');
  const chars = recent.replace(/[^\u4e00-\u9fa5]/g, '');
  const freq = {};
  for (let i = 0; i < chars.length; i++) {
    for (let n = 2; n <= 4; n++) {
      if (i + n <= chars.length) {
        const word = chars.slice(i, i + n);
        if (!stopWords.has(word)) freq[word] = (freq[word] || 0) + 1;
      }
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word]) => word);
}

function searchKnowledgeBase(stageName, messages, mySenderName, topN = 5) {
  const kb = loadKnowledgeBase();
  if (!kb?.chunks?.length) return [];

  const stageKeywords = STAGE_KEYWORDS[stageName] || [];
  const chatKeywords = extractChatKeywords(messages, mySenderName);

  return kb.chunks
    .map(chunk => {
      let score = 0;
      const text = chunk.content;
      stageKeywords.forEach(keyword => { if (text.includes(keyword)) score += 2; });
      chatKeywords.forEach(keyword => { if (text.includes(keyword)) score += 1; });
      if (chunk.tags && chunk.tags.includes('💰/金句')) score += 1;
      return { chunk, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(item => item.chunk.content);
}

function buildKbSection(stageName, messages, mySenderName) {
  const results = searchKnowledgeBase(stageName, messages, mySenderName);
  if (results.length === 0) return '';
  const lines = results.map((result, index) => `${index + 1}. ${result.replace(/\n/g, ' ').slice(0, 200)}`).join('\n\n');
  return `\n\n--- 参考话术语料（这是真实销售中说过的原话，照这个腔调来，不要改写）---\n${lines}`;
}

function retrieveRelevantChunks(scenario, topN = 2) {
  const kb = loadKnowledgeBase();
  if (!kb?.chunks?.length) return [];

  const stopWords = new Set(['我', '你', '他', '她', '的', '了', '是', '在', '有', '不', '也', '都', '和', '与', '但', '就', '把', '被', '让', '给', '对', '会', '能', '要', '想', '说', '看', '到', '很', '这', '那', '可以', '可能', '没有', '因为', '所以', '如果', '虽然', '但是', '什么', '怎么', '一个', '还是', '一下', '一点', '一些', '感觉', '其实', '然后', '这个', '那个']);
  const chars = (scenario || '').replace(/[^\u4e00-\u9fa5]/g, '');
  const freq = {};
  for (let i = 0; i < chars.length; i++) {
    for (let n = 2; n <= 4; n++) {
      if (i + n <= chars.length) {
        const word = chars.slice(i, i + n);
        if (!stopWords.has(word)) freq[word] = (freq[word] || 0) + 1;
      }
    }
  }
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word]) => word);
  if (keywords.length === 0) return [];

  return kb.chunks
    .filter(chunk => chunk.docTitle)
    .map(chunk => {
      let score = 0;
      (chunk.tags || []).forEach(tag => { keywords.forEach(keyword => { if (tag.includes(keyword)) score += 3; }); });
      keywords.forEach(keyword => { if ((chunk.topic || '').includes(keyword)) score += 2; });
      keywords.forEach(keyword => { if (chunk.content.includes(keyword)) score += 1; });
      return { chunk, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(item => ({
      date: item.chunk.date,
      topic: item.chunk.topic,
      content: item.chunk.content
    }));
}

function getKnowledgeBaseStatus() {
  if (!fs.existsSync(KB_PATH)) return { exists: false };
  try {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    return {
      exists: true,
      syncing: kbSyncing,
      updatedAt: kb.updatedAt,
      feishuSyncedAt: kb.feishuSyncedAt || null,
      totalChunks: kb.totalChunks,
      feishuChunks: kb.feishuChunks || 0,
      flomoChunks: kb.flomoChunks || 0,
    };
  } catch {
    return { exists: true, error: '读取失败' };
  }
}

function isKbSyncing() {
  return kbSyncing;
}

function setKbSyncing(value) {
  kbSyncing = Boolean(value);
}

module.exports = {
  chunkDoc,
  syncKnowledgeBase,
  buildKbSection,
  retrieveRelevantChunks,
  getKnowledgeBaseStatus,
  isKbSyncing,
  setKbSyncing,
};
