#!/usr/bin/env node
const fs = require('fs');

const csv = fs.readFileSync('/Users/dang/Documents/播客私教销售话术.csv', 'utf8');

// Stage mapping
const stageMap = {
  '1️⃣ 建立连接同步信息': '建立连接',
  '2️⃣ 挖掘需求': '挖掘需求',
  '3️⃣ 解决顾虑': '解决顾虑',
  '4️⃣最后成交': '最后成交',
};

// Parse CSV with quoted multiline fields
function parseCSV(text) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    const row = [];
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < text.length) {
          if (text[i] === '"' && text[i+1] === '"') {
            field += '"';
            i += 2;
          } else if (text[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            field += text[i++];
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n') {
          field += text[i++];
        }
        row.push(field.trim());
      }
      if (text[i] === ',') i++; // skip comma
    }
    if (text[i] === '\n') i++; // skip newline
    if (row.length > 0 && row.some(f => f.trim())) rows.push(row);
  }
  return rows;
}

const rows = parseCSV(csv);

// Generate label from content (first meaningful line, max 20 chars)
function makeLabel(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return '话术';
  const first = lines[0].replace(/[「」]/g, '');
  return first.length > 18 ? first.slice(0, 18) + '…' : first;
}

const scripts = [];
let id = 1001;
let skippedHeader = false;

for (const row of rows) {
  const [rawStage, content] = row;
  if (!rawStage || !content) continue;

  // Skip header row
  if (rawStage === '销售阶段') { skippedHeader = true; continue; }

  const stage = stageMap[rawStage.trim()];
  if (!stage) continue;

  const cleaned = content.trim().replace(/\n{3,}/g, '\n\n');

  scripts.push({
    id: id++,
    product: '播客私教',
    stage,
    label: makeLabel(cleaned),
    content: cleaned,
    useCount: 0,
    rate: 0,
  });
}

// Output as JS array entries
const lines = scripts.map(s => {
  const escaped = s.content.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const label = s.label.replace(/'/g, "\\'");
  return `    { id: ${s.id}, product: '播客私教', stage: '${s.stage}', label: '${label}', content: '${escaped}', useCount: 0, rate: 0 },`;
});

console.log(`// Total: ${scripts.length} scripts`);
console.log(lines.join('\n'));
