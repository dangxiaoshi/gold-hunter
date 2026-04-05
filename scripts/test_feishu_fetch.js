/**
 * 飞书知识库接入验证脚本
 * 只验证流程，不写文件，不调 AI，不改任何现有文件
 * 运行: node scripts/test_feishu_fetch.js
 */

const APP_ID = 'cli_a9418569aaf8dbcb';
const APP_SECRET = 'rcQGwaS2orrHbD9JTqxyUgJKEKvu4Pn0';
const SPACE_ID = '7588802359464037335';

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (!data.tenant_access_token) {
    throw new Error(`获取 token 失败: ${JSON.stringify(data)}`);
  }
  console.log('✅ Token 获取成功');
  return data.tenant_access_token;
}

async function listNodes(token) {
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/${SPACE_ID}/nodes?page_size=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`列出节点失败: ${JSON.stringify(data)}`);
  }
  const nodes = data.data?.items || [];
  console.log(`✅ 知识库节点数: ${nodes.length}`);
  if (nodes.length === 0) throw new Error('知识库为空，没有节点');
  return nodes;
}

async function getDocContent(token, docToken) {
  // 获取文档纯文本内容（blocks API）
  const url = `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/raw_content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) {
    // 回退：尝试 wiki node 的 document token
    throw new Error(`获取文档内容失败: ${JSON.stringify(data)}`);
  }
  return data.data?.content || '';
}

async function getNodeContent(token, node) {
  // wiki node 有 obj_token（文档 token）和 obj_type（doc/sheet/...）
  const objToken = node.obj_token;
  const objType = node.obj_type; // 'doc' or 'docx'

  console.log(`  文档类型: ${objType}, token: ${objToken}`);

  if (objType === 'docx') {
    return await getDocContent(token, objToken);
  } else if (objType === 'doc') {
    // 旧版 doc
    const url = `https://open.feishu.cn/open-apis/doc/v2/${objToken}/content`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`获取旧版 doc 失败: ${JSON.stringify(data)}`);
    // 旧版返回的是 JSON 结构，提取 body.content 里的文本
    try {
      const body = JSON.parse(data.data.content);
      return extractTextFromDocBody(body);
    } catch {
      return data.data?.content || '';
    }
  } else {
    throw new Error(`不支持的文档类型: ${objType}`);
  }
}

function extractTextFromDocBody(body) {
  // 旧版 doc 的 body 是嵌套 JSON，递归提取文本
  let text = '';
  function walk(node) {
    if (typeof node === 'string') { text += node; return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (node.text) text += node.text;
      if (node.body) walk(node.body);
      if (node.content) walk(node.content);
      if (node.children) walk(node.children);
      if (node.elements) walk(node.elements);
    }
  }
  walk(body);
  return text;
}

/**
 * 按 【MM.DD】 切块
 * 匹配格式: 【MM.DD】或 【M.DD】，后面跟主题
 */
function splitByDate(content) {
  // 匹配 【MM.DD】 或 【M.DD】，允许全角/半角
  const pattern = /【(\d{1,2}\.\d{2})】([^\n]*)/g;
  const chunks = [];
  let match;
  let lastIndex = 0;
  let lastChunk = null;

  while ((match = pattern.exec(content)) !== null) {
    if (lastChunk !== null) {
      lastChunk.content = content.slice(lastIndex, match.index).trim();
      chunks.push(lastChunk);
    }
    lastChunk = {
      date: match[1],
      topic: match[2].trim(),
      content: '',
    };
    lastIndex = match.index + match[0].length;
  }

  if (lastChunk !== null) {
    lastChunk.content = content.slice(lastIndex).trim();
    chunks.push(lastChunk);
  }

  return chunks;
}

async function main() {
  try {
    // 1. 拉 token
    console.log('\n== 步骤1：获取飞书 Token ==');
    const token = await getToken();

    // 2. 列出节点，取第一篇
    console.log('\n== 步骤2：列出知识库节点 ==');
    const nodes = await listNodes(token);
    nodes.forEach((n, i) => console.log(`  [${i}] "${n.title}" type=${n.obj_type} token=${n.obj_token}`));

    // 跳过首页模板，找第一篇有实际内容的节点
    const firstNode = nodes.find(n => n.title !== '首页') || nodes[0];
    console.log(`\n  选中: title="${firstNode.title}", type=${firstNode.obj_type}`);

    // 3. 获取文档内容
    console.log('\n== 步骤3：获取文档内容 ==');
    const content = await getNodeContent(token, firstNode);
    console.log(`  文档字数: ${content.length} 字`);
    console.log(`  内容预览（前200字）:\n  ${content.slice(0, 200).replace(/\n/g, '\n  ')}`);

    // 4. 切块
    console.log('\n== 步骤4：按【MM.DD】切块 ==');
    const chunks = splitByDate(content);
    console.log(`\n共切出 ${chunks.length} 块\n`);

    chunks.forEach((chunk, i) => {
      const topicPreview = chunk.topic.slice(0, 50);
      const contentPreview = chunk.content.slice(0, 100).replace(/\n/g, ' ');
      console.log(`[${i + 1}] 📅 ${chunk.date} | 主题: ${topicPreview}`);
      console.log(`     内容: ${contentPreview}`);
      console.log();
    });

    if (chunks.length === 0) {
      console.log('⚠️  没有切出任何块。可能格式不匹配，检查文档是否包含 【MM.DD】 格式。');
      console.log('   文档完整内容（前500字）:');
      console.log(content.slice(0, 500));
    }

  } catch (err) {
    console.error('\n❌ 出错:', err.message);
    process.exit(1);
  }
}

main();
