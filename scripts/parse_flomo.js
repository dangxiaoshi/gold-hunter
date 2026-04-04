#!/usr/bin/env node
// parse_flomo.js — 一次性手动运行：node scripts/parse_flomo.js
// 解析 flomo 导出的 HTML，提取销售语料，输出到 data/knowledge_base.json

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
const flomoPath = config.flomoPath;

if (!flomoPath) {
  console.error('❌ config.json 里没有 flomoPath 字段');
  process.exit(1);
}

if (!fs.existsSync(flomoPath)) {
  console.error(`❌ 文件不存在：${flomoPath}`);
  process.exit(1);
}

const html = fs.readFileSync(flomoPath, 'utf8');

// 提取所有 memo 块
const memoPattern = /<div class="memo">\s*<div class="time">([^<]+)<\/div>\s*<div class="content">([\s\S]*?)<\/div>\s*<div class="files">/g;

const TARGET_TAGS = ['💰/销售', '💰/金句', '💰'];

function stripHtml(html) {
  // 把 <p>、<li> 等块级标签换成换行，然后去掉所有 HTML 标签
  return html
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
}

function extractTags(text) {
  const tagPattern = /#([\u4e00-\u9fa5\w\/💰]+)/g;
  const tags = [];
  let m;
  while ((m = tagPattern.exec(text)) !== null) {
    tags.push(m[1]);
  }
  return tags;
}

function isTargetTag(tags) {
  return tags.some(tag => TARGET_TAGS.includes(tag));
}

function removeTagLines(lines) {
  return lines
    .map(line => line.replace(/#[\u4e00-\u9fa5\w\/💰]+/g, '').trim())
    .filter(line => line.length > 0);
}

const chunks = [];
let match;

while ((match = memoPattern.exec(html)) !== null) {
  const time = match[1].trim();
  const contentHtml = match[2];
  const rawText = stripHtml(contentHtml);
  const lines = rawText.split('\n');
  const tags = extractTags(rawText);

  if (!isTargetTag(tags)) continue;

  const cleanLines = removeTagLines(lines);
  const content = cleanLines.join('\n').trim();

  if (content.length < 5) continue; // 太短跳过

  chunks.push({ time, tags, content });
}

const output = {
  updatedAt: new Date().toISOString().slice(0, 10),
  sourceFile: flomoPath,
  totalChunks: chunks.length,
  chunks
};

const outPath = path.join(__dirname, '../data/knowledge_base.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

console.log(`✅ 完成！共提取 ${chunks.length} 条语料`);
console.log(`📁 输出：${outPath}`);

// 预览前 3 条
console.log('\n--- 前 3 条预览 ---');
chunks.slice(0, 3).forEach((c, i) => {
  console.log(`\n[${i+1}] ${c.time} | 标签：${c.tags.join(', ')}`);
  console.log(c.content.slice(0, 100) + (c.content.length > 100 ? '...' : ''));
});
