const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_PORT = 3737;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3737',
  'http://127.0.0.1:3737',
  'https://dangxiaoshi.github.io'
]);

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const DB_PATH = path.join(ROOT_DIR, 'data', 'customers.json');
const PRODUCTS_PATH = path.join(ROOT_DIR, 'data', 'products.json');
const KB_PATH = path.join(ROOT_DIR, 'data', 'knowledge_base.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const FEISHU_APP_ID = 'cli_a9418569aaf8dbcb';
const FEISHU_APP_SECRET = 'rcQGwaS2orrHbD9JTqxyUgJKEKvu4Pn0';
const FEISHU_SPACE_ID = '7588802359464037335';

const STAGE_KEYWORDS = {
  '建立链接': ['破冰', '信任', '初次', '链接', '了解', '打招呼', '认识'],
  '同步信息': ['情况', '确认', '了解', '背景', '信息'],
  '挖掘需求': ['痛点', '需求', '为什么', '挖', '封闭', '选择', '问题', '烦恼'],
  '解决顾虑': ['价格', '贵', '时间', '效果', '顾虑', '异议', '担心', '质疑', '考虑', '犹豫', '风险'],
  '达成成交': ['临门', '成交', '付款', '紧迫', '最后', '决定', '下单', '付钱', '转账'],
};

module.exports = {
  ROOT_DIR,
  DEFAULT_PORT,
  ALLOWED_ORIGINS,
  CONFIG_PATH,
  DB_PATH,
  PRODUCTS_PATH,
  KB_PATH,
  PUBLIC_DIR,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_SPACE_ID,
  STAGE_KEYWORDS,
};
