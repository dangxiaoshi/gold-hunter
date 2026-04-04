# 任务：实现金币猎人 contacts.html 通讯录页面

## 你是谁
你是这个项目的代码执行者。主设计师（Claude Code）已经完成了整体架构，你来填充一个具体页面的业务逻辑。

## 项目背景
**金币猎人 V2** — 一个销售追单工具，帮用户管理微信客户、生成追销话术。
- 路径：`~/金币猎人2/`
- 启动：`cd ~/金币猎人2 && node server.js`（端口 3737）
- 架构：多页面，`public/index.html` 用 iframe 加载各子页面

## 你的任务
实现 `~/金币猎人2/public/pages/contacts.html` 通讯录页面。

现在这个文件是空骨架（只有 placeholder），你来写完整内容。

## 设计规范

**必须参考** `~/金币猎人2/public/pages/chat.html` 的视觉风格：
- 背景色：`#141414`，侧栏：`#1c1c1c`
- 文字：`#d0d0d0`，边框：`#2a2a2a`
- 金色强调：`#d4a017`（主号角标色）
- 灰色强调：`#888`（副号角标色）
- 字体：`-apple-system, 'PingFang SC', sans-serif`，13px
- **不用外部 CSS 库**，所有样式写在 `<style>` 里
- 文件自包含，不依赖 `app.js`（参考 products.html 的写法）

## 功能规格

### 数据来源
后端 API（与 chat.html 同一个 server.js）：
- `GET /api/customers?q=&page=1&limit=80` → 返回客户列表
- 每个客户字段：`{ name, source, msgCount, lastMsg, lastTime, isHighIntent }`
- `source` 值：`"main"`（主号）或 `"side"`（副号）

### 页面布局（两栏）
**左栏（260px）**：筛选器
- 顶部搜索框（实时过滤，防抖 300ms）
- 分组按钮：全部 / 主号 / 副号 / 高意向
- 标签筛选区（从 localStorage 读取用户创建的标签）

**右栏（剩余宽度）**：联系人网格
- 每张卡片显示：头像首字（圆形，随机暖色背景）、姓名、来源角标、最后互动时间、消息数、备注摘要
- 点击卡片 → 展开详情面板（侧滑抽屉，从右边出来）
  - 显示：姓名、来源、消息统计、最后一条消息
  - 可输入"备注"（多行文本，保存到 localStorage）
  - 可添加/删除标签（输入 + 回车添加，点击删除）
  - 按钮：「去对话」→ 通知父框架切换到 chat tab 并选中该客户

### 数据存储
备注和标签存在 `localStorage['gh_contacts_meta']`，结构：
```json
{
  "客户姓名": {
    "note": "备注文字",
    "tags": ["重点客户", "已付定金"]
  }
}
```

### 跨页面通信（跳转到对话框）
```js
// 通知父框架切换 tab 并选中客户
window.parent.postMessage({ action: 'switchTab', tab: 'chat', customer: name }, '*')
```

### 空状态
搜索无结果时显示："没找到匹配的客户" + 清空搜索按钮

## 验收标准
1. 页面加载显示客户卡片网格（无报错）
2. 搜索框能实时过滤
3. 点击卡片右侧滑出详情抽屉
4. 备注输入后刷新页面还在（localStorage 持久化）
5. 标签可以添加和删除
6. 视觉风格与 chat.html 保持一致（深色背景，金色强调）

## 注意事项
- 只改 `contacts.html`，不动其他文件
- 所有 JS 写在文件底部 `<script>` 里
- 错误处理：API 失败时显示"加载失败，请刷新"
