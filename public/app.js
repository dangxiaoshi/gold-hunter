/* ── State ── */
let config = {};
let customers = [];
let totalCustomers = 0;
let currentOffset = 0;
const PAGE_SIZE = 80;
let activeCustomer = null;
let messages = [];
let currentStage = 0;
let currentProduct = '';
let emojiPickerOpen = false;
let loadingMore = false;
// Per-customer AI state: { [customerId]: {history, messages} }
const aiStateMap = {};

/* ── Boot ── */
async function init() {
  config = await fetch('/api/config').then(r => r.json());
  setupTabs();
  setupSettings();
  setupDragHandles();
  setupBattleBar();
  setupInput();
  setupAiInput();
  setupImport();
  await loadCustomers();
}

/* ── Tabs ── */
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
      // Hide settings if open
      document.getElementById('settings-page').classList.remove('open');
    });
  });

  document.getElementById('settings-toggle').addEventListener('click', () => {
    const sp = document.getElementById('settings-page');
    const isOpen = sp.classList.toggle('open');
    document.getElementById('main').style.display = isOpen ? 'none' : 'flex';
    if (isOpen) renderModelList(); // refresh on open
  });
}

/* ── Customer List ── */
async function loadCustomers(search = '') {
  currentOffset = 0;
  const url = `/api/customers?limit=${PAGE_SIZE}&offset=0${search ? `&search=${encodeURIComponent(search)}` : ''}`;
  const data = await fetch(url).then(r => r.json());
  customers = data.customers || data; // backwards compat
  totalCustomers = data.total || customers.length;
  renderCustomerList();
}

async function loadMoreCustomers() {
  if (loadingMore || customers.length >= totalCustomers) return;
  loadingMore = true;
  currentOffset += PAGE_SIZE;
  const search = document.getElementById('search-input').value;
  const url = `/api/customers?limit=${PAGE_SIZE}&offset=${currentOffset}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
  const data = await fetch(url).then(r => r.json());
  const more = data.customers || data;
  customers = [...customers, ...more];
  renderCustomerList();
  loadingMore = false;
}

function renderCustomerList() {
  const list = document.getElementById('customer-list');
  if (customers.length === 0) {
    list.innerHTML = '<div class="empty-list">暂无客户，点击 ⬆ 导入聊天记录</div>';
    return;
  }
  list.innerHTML = customers.map(c => customerCardHTML(c)).join('');
  if (customers.length < totalCustomers) {
    list.innerHTML += `<div class="empty-list" style="color:#444;font-size:11px">显示 ${customers.length} / ${totalCustomers}，向下滚动加载更多</div>`;
  }
  list.querySelectorAll('.customer-card').forEach(el => {
    el.addEventListener('click', () => selectCustomer(el.dataset.id));
  });

  // Infinite scroll
  list.onscroll = () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      loadMoreCustomers();
    }
  };
}

function customerCardHTML(c) {
  const active = activeCustomer?.id === c.id ? 'active' : '';
  const label = config.accountLabels?.[c.account] || '';
  const time = formatTime(c.lastTime);
  const preview = escHtml(c.lastMessage || '');
  return `
    <div class="customer-card ${active}" data-id="${c.id}">
      <div class="card-avatar">${c.statusEmoji || '🔥'}</div>
      <div class="card-body">
        <div class="card-top">
          <span class="card-name">${escHtml(c.name)}</span>
          <span class="card-time">${time}</span>
        </div>
        <div class="card-preview">${preview}</div>
      </div>
      ${label ? `<span class="card-badge ${label === '主' ? 'badge-main' : ''}">${label}</span>` : ''}
    </div>`;
}

async function selectCustomer(id) {
  activeCustomer = customers.find(c => c.id === id);
  if (!activeCustomer) return;

  currentStage = activeCustomer.progressStage || 0;
  currentProduct = activeCustomer.activeProduct || '';

  // Update header
  document.getElementById('mid-customer-name').textContent = activeCustomer.name;
  document.getElementById('mid-info').textContent = `${activeCustomer.messageCount || 0} 条消息`;

  // Show content
  document.getElementById('mid-empty').style.display = 'none';
  const midContent = document.getElementById('mid-content');
  midContent.style.display = 'flex';
  midContent.style.flex = '1';
  midContent.style.flexDirection = 'column';
  midContent.style.overflow = 'hidden';

  // Highlight card
  document.querySelectorAll('.customer-card').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // Update battle bar
  updateProductSelect();
  updateProgressBar();
  document.getElementById('emoji-trigger').textContent = activeCustomer.statusEmoji || '🔥';
  if (currentProduct) document.getElementById('product-select').value = currentProduct;

  // Load messages
  messages = await fetch(`/api/customers/${id}/messages`).then(r => r.json());
  renderChat();

  // Restore per-customer AI chat history
  restoreAiMessages(id);
}

/* ── Chat ── */
function renderChat() {
  const area = document.getElementById('chat-area');
  if (messages.length === 0) {
    area.innerHTML = '<div class="empty-list">暂无消息记录</div>';
    return;
  }

  let html = '';
  let lastDate = '';

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isMine = m.sender === config.mySenderName;
    const date = m.time ? m.time.split(' ')[0] : '';

    // Date divider
    if (date && date !== lastDate) {
      html += `<div class="time-divider">${escHtml(m.time || '')}</div>`;
      lastDate = date;
    } else if (i > 0 && shouldShowTime(messages[i-1], m)) {
      html += `<div class="time-divider">${escHtml(m.time || '')}</div>`;
    }

    const sideClass = isMine ? 'mine' : 'theirs';
    const bubbleClass = isMine ? 'mine' : 'theirs';
    html += `
      <div class="bubble-row ${sideClass}" data-idx="${i}">
        <div class="bubble ${bubbleClass}">${escHtml(m.content || '')}</div>
      </div>`;
  }

  area.innerHTML = html;
  area.scrollTop = area.scrollHeight;

  // Click to toggle ownership (for mis-labeled messages)
  area.querySelectorAll('.bubble').forEach(b => {
    b.addEventListener('click', (e) => {
      const row = e.target.closest('.bubble-row');
      const idx = parseInt(row.dataset.idx);
      messages[idx]._flipped = !messages[idx]._flipped;
      const wasOwner = messages[idx].sender === config.mySenderName;
      messages[idx].sender = wasOwner ? '__other__' : config.mySenderName;
      renderChat();
    });
  });
}

function shouldShowTime(prev, curr) {
  if (!prev.timestamp || !curr.timestamp) return false;
  return curr.timestamp - prev.timestamp > 300; // 5 min gap
}

/* ── Battle Bar ── */
function setupBattleBar() {
  // Emoji trigger
  document.getElementById('emoji-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPickerOpen = !emojiPickerOpen;
    document.getElementById('emoji-picker').classList.toggle('open', emojiPickerOpen);
    if (emojiPickerOpen) renderEmojiPicker();
  });

  document.addEventListener('click', () => {
    emojiPickerOpen = false;
    document.getElementById('emoji-picker').classList.remove('open');
  });

  document.getElementById('emoji-picker').addEventListener('click', e => e.stopPropagation());

  // Product select
  document.getElementById('product-select').addEventListener('change', async (e) => {
    currentProduct = e.target.value;
    if (activeCustomer) {
      await fetch(`/api/customers/${activeCustomer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeProduct: currentProduct })
      });
    }
  });

  // Progress bar click
  document.getElementById('progress-bar').addEventListener('click', (e) => {
    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const stages = config.progressStages || [];
    const newStage = Math.min(Math.floor(pct * stages.length), stages.length - 1);
    setStage(newStage);
  });

  // Fire button
  document.getElementById('fire-btn').addEventListener('click', () => {
    if (!activeCustomer) return;
    runTactics();
  });
}

function renderEmojiPicker() {
  const grid = document.getElementById('emoji-grid');
  const emojis = config.emojis || [];
  grid.innerHTML = emojis.map(e =>
    `<div class="emoji-opt" data-emoji="${e}">${e}</div>`
  ).join('');
  grid.querySelectorAll('.emoji-opt').forEach(el => {
    el.addEventListener('click', async () => {
      const emoji = el.dataset.emoji;
      document.getElementById('emoji-trigger').textContent = emoji;
      if (activeCustomer) {
        activeCustomer.statusEmoji = emoji;
        await fetch(`/api/customers/${activeCustomer.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statusEmoji: emoji })
        });
        // Update card in list
        customers = customers.map(c => c.id === activeCustomer.id ? { ...c, statusEmoji: emoji } : c);
        renderCustomerList();
      }
      emojiPickerOpen = false;
      document.getElementById('emoji-picker').classList.remove('open');
    });
  });
}

function updateProductSelect() {
  const sel = document.getElementById('product-select');
  const products = config.products || [];
  sel.innerHTML = '<option value="">选产品</option>' +
    products.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
  if (currentProduct) sel.value = currentProduct;
}

function updateProgressBar() {
  const stages = config.progressStages || [];
  // 每个阶段均分，第一阶段也有填充感
  const pct = stages.length > 1 ? ((currentStage + 1) / stages.length) * 100 : 100;
  document.getElementById('progress-fill').style.width = `${pct}%`;

  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  const stageName = stages[currentStage] || '';

  // Responsive label
  const barWidth = bar.getBoundingClientRect().width || bar.offsetWidth;
  if (barWidth > 200) label.textContent = stageName;
  else if (barWidth > 120) label.textContent = stageName.slice(0, 2);
  else label.textContent = `${currentStage + 1}/${stages.length}`;

  // Stage ticks
  bar.querySelectorAll('.stage-tick').forEach(t => t.remove());
  stages.forEach((_, i) => {
    if (i === 0) return;
    const tick = document.createElement('div');
    tick.className = 'stage-tick';
    tick.style.left = `${(i / (stages.length - 1)) * 100}%`;
    bar.appendChild(tick);
  });
}

async function setStage(stage) {
  currentStage = stage;
  updateProgressBar();
  if (activeCustomer) {
    activeCustomer.progressStage = stage;
    await fetch(`/api/customers/${activeCustomer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progressStage: stage })
    });
  }
}

/* ── Input: paste → analyze ── */
function setupInput() {
  const ta = document.getElementById('msg-textarea');
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || !activeCustomer) return;
      ta.value = '';
      await runAnalyze(text);
    }
  });
}

/* ── AI Chat ── */

// Per-customer history helpers
function getAiState(id) {
  const cid = id || activeCustomer?.id;
  if (!cid) return { history: [], messages: [] };
  if (!aiStateMap[cid]) aiStateMap[cid] = { history: [], messages: [] };
  return aiStateMap[cid];
}

function saveAiMsg(role, label, content) {
  if (!activeCustomer) return;
  getAiState().messages.push({ role, label, content });
}

function restoreAiMessages(customerId) {
  const container = document.getElementById('ai-messages');
  container.innerHTML = '';
  const state = getAiState(customerId);
  if (state.messages.length === 0) {
    container.innerHTML = '<div class="ai-hint">选择客户后，粘贴聊天记录自动分析<br>或点击 🏹 出击 生成话术，也可以直接提问</div>';
    return;
  }
  for (const msg of state.messages) {
    addAiMsg(msg.role, msg.label, msg.content);
  }
}

function setupAiInput() {
  const ta = document.getElementById('ai-input');
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      await sendAiMessage(text);
    }
  });

  // Drag to resize AI input area
  const divider = document.getElementById('ai-drag-divider');
  const messagesEl = document.getElementById('ai-messages');
  const inputArea = document.getElementById('ai-input-area');
  let startY, startMsgH, startInputH;

  divider.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startMsgH = messagesEl.offsetHeight;
    startInputH = inputArea.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const newMsgH = Math.max(80, startMsgH + dy);
      const newInputH = Math.max(48, startInputH - dy);
      messagesEl.style.height = newMsgH + 'px';
      messagesEl.style.flex = 'none';
      inputArea.style.height = newInputH + 'px';
      ta.style.height = Math.max(40, newInputH - 4) + 'px';
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Add a message bubble to #ai-messages
// returns the bubble content element (for streaming into)
function addAiMsg(role, label, initialText = '') {
  const container = document.getElementById('ai-messages');
  // Remove hint if present
  const hint = container.querySelector('.ai-hint');
  if (hint) hint.remove();

  const msgEl = document.createElement('div');
  msgEl.className = `ai-msg ${role}`;

  const labelEl = document.createElement('div');
  labelEl.className = 'ai-msg-label';
  labelEl.textContent = label;

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'ai-msg-bubble';
  bubbleEl.textContent = initialText;

  msgEl.appendChild(labelEl);
  msgEl.appendChild(bubbleEl);
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
  return bubbleEl;
}

// Stream SSE response into a bubble element
async function streamIntoBubble(res, bubbleEl) {
  const cursor = document.createElement('span');
  cursor.className = 'ai-cursor';
  bubbleEl.appendChild(cursor);

  const container = document.getElementById('ai-messages');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') { cursor.remove(); continue; }
      try {
        const parsed = JSON.parse(data);
        if (parsed.text) {
          fullText += parsed.text;
          cursor.remove();
          bubbleEl.textContent = fullText;
          bubbleEl.appendChild(cursor);
          container.scrollTop = container.scrollHeight;
        }
        if (parsed.error) {
          cursor.remove();
          bubbleEl.textContent += `\n[错误: ${parsed.error}]`;
        }
      } catch { /* skip */ }
    }
  }
  cursor.remove();
  return fullText;
}

async function runAnalyze(pastedText) {
  if (!activeCustomer) return;
  const userLabel = '粘贴分析';
  const userContent = pastedText.slice(0, 60) + (pastedText.length > 60 ? '…' : '');
  addAiMsg('user', userLabel, userContent);
  saveAiMsg('user', userLabel, userContent);
  const bubbleEl = addAiMsg('assistant', '📊 分析中…');

  const body = { messages: messages.slice(-30), customerName: activeCustomer.name, pastedText };
  try {
    const res = await fetch('/api/ai/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const fullText = await streamIntoBubble(res, bubbleEl);
    bubbleEl.previousSibling.textContent = '📊 分析';
    saveAiMsg('assistant', '📊 分析', fullText);
    getAiState().history.push({ role: 'assistant', content: fullText });
  } catch (e) {
    bubbleEl.textContent = `错误: ${e.message}`;
  }
}

async function runTactics() {
  if (!activeCustomer) return;

  // 计算客户状态
  const lastMsg = messages[messages.length - 1];
  let daysSince = null;
  let phase = '跟进';

  if (lastMsg?.time) {
    const lastMs = new Date(lastMsg.time.replace(' ', 'T')).getTime();
    if (!isNaN(lastMs)) {
      daysSince = Math.floor((Date.now() - lastMs) / (1000 * 60 * 60 * 24));
    }
  }
  if (daysSince !== null && daysSince > 30) phase = '唤醒';
  else if (messages.length < 10) phase = '新客';

  const contactDesc = daysSince === 0 ? '今天' : daysSince === 1 ? '昨天' : daysSince != null ? `${daysSince}天前` : '';
  const phaseLabel = `${phase}${contactDesc ? `（${contactDesc}）` : ''}`;

  const userContent = `🏹 出击 — ${phaseLabel}`;
  addAiMsg('user', '操作', userContent);
  saveAiMsg('user', '操作', userContent);
  const bubbleEl = addAiMsg('assistant', '🏹 生成中…');

  const body = {
    messages: messages.slice(-20), customerName: activeCustomer.name,
    product: currentProduct, progressStage: currentStage,
    daysSince, phase
  };
  try {
    const res = await fetch('/api/ai/tactics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const fullText = await streamIntoBubble(res, bubbleEl);
    bubbleEl.previousSibling.textContent = '🏹 话术';
    saveAiMsg('assistant', '🏹 话术', fullText);
    getAiState().history.push({ role: 'assistant', content: fullText });
  } catch (e) {
    bubbleEl.textContent = `错误: ${e.message}`;
  }
}

async function sendAiMessage(text) {
  if (!activeCustomer) {
    addAiMsg('assistant', 'AI', '请先选择一个客户');
    return;
  }
  const state = getAiState();
  state.history.push({ role: 'user', content: text });
  addAiMsg('user', '你', text);
  saveAiMsg('user', '你', text);
  const bubbleEl = addAiMsg('assistant', 'AI 回复中…');

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: state.history.slice(-20),
        customerName: activeCustomer.name,
        recentMessages: messages.slice(-20)
      })
    });
    const fullText = await streamIntoBubble(res, bubbleEl);
    bubbleEl.previousSibling.textContent = 'AI';
    saveAiMsg('assistant', 'AI', fullText);
    state.history.push({ role: 'assistant', content: fullText });
  } catch (e) {
    bubbleEl.textContent = `错误: ${e.message}`;
  }
}

/* ── Drag Handles ── */
function setupDragHandles() {
  setupColDrag('drag-left', 'col-left', 'col-mid', true);
  setupColDrag('drag-right', 'col-right', 'col-mid', false);
  setupRowDrag();
}

function setupColDrag(handleId, colId, flexColId, leftSide) {
  const handle = document.getElementById(handleId);
  const col = document.getElementById(colId);
  let startX, startW;

  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = col.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const dx = leftSide ? e.clientX - startX : startX - e.clientX;
      const newW = Math.max(160, Math.min(500, startW + dx));
      col.style.width = newW + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function setupRowDrag() {
  const divider = document.getElementById('chat-drag-divider');
  const chatArea = document.getElementById('chat-area');
  const inputArea = document.getElementById('input-area');
  let startY, startChatH, startInputH;

  divider.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startChatH = chatArea.offsetHeight;
    startInputH = inputArea.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const newChatH = Math.max(100, startChatH + dy);
      const newInputH = Math.max(60, startInputH - dy);
      chatArea.style.height = newChatH + 'px';
      chatArea.style.flex = 'none';
      inputArea.style.height = newInputH + 'px';
      document.getElementById('msg-textarea').style.minHeight = (newInputH - 20) + 'px';
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ── Search ── */
document.getElementById('search-input').addEventListener('input', (e) => {
  loadCustomers(e.target.value);
});

/* ── Add Customer ── */
document.getElementById('add-btn').addEventListener('click', async () => {
  const name = prompt('输入客户微信名：');
  if (!name) return;
  const res = await fetch('/api/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, account: 'manual' })
  });
  if (res.ok) await loadCustomers();
});

/* ── Import ── */
function setupImport() {
  document.getElementById('import-btn').addEventListener('click', async () => {
    const btn = document.getElementById('import-btn');
    const result = document.getElementById('import-result');
    btn.disabled = true;
    btn.textContent = '导入中…';
    result.textContent = '';

    try {
      const data = await fetch('/api/import', { method: 'POST' }).then(r => r.json());
      result.textContent = `✓ 新增 ${data.imported} 个客户，已存在 ${data.skipped} 个`;
      await loadCustomers();
    } catch (e) {
      result.textContent = `✗ 错误: ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⬆ 开始导入';
    }
  });
}

/* ── Settings ── */
function setupSettings() {
  renderModelList();
  renderEmojiManager();
}

function renderModelList() {
  const container = document.getElementById('model-list');
  const models = config.models || [];
  container.innerHTML = models.map((m, i) => `
    <div class="model-row ${m.id === config.activeModel ? 'active-model' : ''}" data-idx="${i}">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="model-name">${m.name}</span>
        <button class="btn-select ${m.id === config.activeModel ? 'selected' : ''}" data-id="${m.id}">
          ${m.id === config.activeModel ? '✓ 当前' : '选用'}
        </button>
      </div>
      <div class="model-inputs">
        <input class="settings-input" placeholder="API Key" type="password"
          value="${m.apiKey || ''}" data-field="apiKey" data-idx="${i}">
        <input class="settings-input" placeholder="Base URL"
          value="${m.baseUrl || ''}" data-field="baseUrl" data-idx="${i}">
      </div>
      <div class="model-actions">
        <button class="btn-test" data-idx="${i}">测试连接</button>
        <span class="test-result" id="test-result-${i}"></span>
      </div>
    </div>
  `).join('');

  // Bind inputs
  container.querySelectorAll('.settings-input').forEach(input => {
    input.addEventListener('change', async () => {
      const idx = parseInt(input.dataset.idx);
      const field = input.dataset.field;
      config.models[idx][field] = input.value;
      await saveConfigToServer();
    });
  });

  // Bind select buttons
  container.querySelectorAll('.btn-select').forEach(btn => {
    btn.addEventListener('click', async () => {
      config.activeModel = btn.dataset.id;
      await saveConfigToServer();
      renderModelList();
    });
  });

  // Bind test buttons
  container.querySelectorAll('.btn-test').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const m = config.models[idx];
      const resultEl = document.getElementById(`test-result-${idx}`);
      resultEl.textContent = '测试中…';
      resultEl.className = 'test-result';
      try {
        const data = await fetch('/api/config/test-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m)
        }).then(r => r.json());
        resultEl.textContent = data.ok ? '✓ 连接成功' : `✗ ${data.status || data.error}`;
        resultEl.className = `test-result ${data.ok ? 'test-ok' : 'test-fail'}`;
      } catch (e) {
        resultEl.textContent = `✗ ${e.message}`;
        resultEl.className = 'test-result test-fail';
      }
    });
  });
}

function renderEmojiManager() {
  const grid = document.getElementById('emoji-list-grid');
  const emojis = config.emojis || [];
  grid.innerHTML = emojis.map((e, i) => `
    <div class="emoji-tag" data-idx="${i}">
      <span>${e}</span>
      <span class="del-emoji" data-idx="${i}">✕</span>
    </div>
  `).join('');

  grid.querySelectorAll('.del-emoji').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      config.emojis.splice(idx, 1);
      await saveConfigToServer();
      renderEmojiManager();
    });
  });

  document.getElementById('emoji-add-btn').onclick = async () => {
    const input = document.getElementById('emoji-add-input');
    const val = input.value.trim();
    if (!val) return;
    config.emojis.push(val);
    input.value = '';
    await saveConfigToServer();
    renderEmojiManager();
  };
}

async function saveConfigToServer() {
  await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
}

/* ── Utils ── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const d = new Date(timeStr.replace(' ', 'T'));
  if (isNaN(d)) return timeStr.slice(0, 10);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ── Start ── */
init();
