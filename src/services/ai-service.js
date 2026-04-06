const { loadConfig } = require('../repositories/config-repo');
const { buildKbSection, retrieveRelevantChunks } = require('./kb-service');

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function buildRecentContext(messages, mySenderName, customerName, limit = 18) {
  return (messages || []).slice(-limit)
    .map(message => `[${message.time || ''}] [${message.sender === mySenderName ? '我' : customerName}] ${message.content}`)
    .join('\n');
}

function getRecentMySentMessages(messages, mySenderName, limit = 5) {
  return (messages || [])
    .filter(message => message.sender === mySenderName)
    .slice(-limit)
    .map(message => message.content || '')
    .filter(Boolean);
}

async function completeWithModel(messages) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(model => model.id === cfg.activeModel) || cfg.models[0];
  const { default: fetch } = await import('node-fetch');

  if (modelCfg.provider === 'anthropic') {
    const system = messages.find(message => message.role === 'system')?.content;
    const response = await fetch((modelCfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': modelCfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelCfg.id,
        max_tokens: 1200,
        ...(system ? { system } : {}),
        messages: messages.filter(message => message.role !== 'system')
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return (data.content || []).map(item => item.text || '').join('');
  }

  const response = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelCfg.apiKey}` },
    body: JSON.stringify({ model: modelCfg.id, messages, max_tokens: 1200, stream: false })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data.choices?.[0]?.message?.content || '';
}

async function diagnoseTacticsInput({ messages, customerName, curr, product, mySenderName }) {
  const recentContext = buildRecentContext(messages, mySenderName, customerName, 18);
  const recentMySent = getRecentMySentMessages(messages, mySenderName, 5);

  const system = `你是销售诊断器，只负责判断，不负责写话术。

硬规则：
- 当前阶段为人工确认结果，必须严格服从，不允许改判为其他阶段
- 你可以判断客户真实顾虑和下一步目标，但 stage 字段必须原样返回 "${curr}"
- 只输出 JSON，不要输出解释、markdown 或代码块

输出 JSON 结构：
{
  "follow_manual_stage": true,
  "stage": "${curr}",
  "objection_type": "价格顾虑|时间顾虑|效果顾虑|执行力顾虑|信任顾虑|时机顾虑|无明显顾虑",
  "customer_intent": "一句话说清客户现在真正想要什么",
  "next_goal": "当前最应该推进到什么具体动作",
  "must_avoid": ["生成话术时必须避开的点1", "点2"],
  "evidence": ["支持判断的聊天信号1", "信号2"]
}`;

  const user = `客户名：${customerName}
当前产品：${product || '未指定'}
人工确认阶段：${curr}

最近相关聊天：
${recentContext || '无'}

最近我方已发送的话：
${recentMySent.length ? recentMySent.map((item, index) => `${index + 1}. ${item}`).join('\n') : '无'}`;

  const text = await completeWithModel([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);
  const parsed = extractJsonObject(text);
  if (parsed) return parsed;

  return {
    follow_manual_stage: true,
    stage: curr,
    objection_type: '无明显顾虑',
    customer_intent: '需要基于当前聊天继续推进',
    next_goal: `围绕${curr}阶段继续推进`,
    must_avoid: ['不要重复最近已经发过的话', '不要偏离人工确认阶段'],
    evidence: []
  };
}

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
    res.end();
    return;
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
        } catch {
          // skip partial/non-json event
        }
      }
    }
  }
  res.end();
}

async function streamFromAnthropic(apiKey, model, messages, res, baseUrl) {
  const { default: fetch } = await import('node-fetch');
  const sysMsg = messages.find(message => message.role === 'system')?.content;
  const endpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      stream: true,
      ...(sysMsg ? { system: sysMsg } : {}),
      messages: messages.filter(message => message.role !== 'system')
    })
  });

  if (!response.ok) {
    const err = await response.text();
    res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
    res.end();
    return;
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
        } catch {
          // skip partial/non-json event
        }
      }
    }
  }
  res.end();
}

function ensureSseHeaders(res) {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

function writeStreamError(res, error) {
  const message = error?.message || String(error);
  try {
    ensureSseHeaders(res);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch {
    // ignore secondary write errors
  }
  try {
    res.end();
  } catch {
    // ignore
  }
}

async function callAI(systemPrompt, userContent, res) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(model => model.id === cfg.activeModel) || cfg.models[0];
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  ensureSseHeaders(res);
  try {
    if (modelCfg.provider === 'anthropic') {
      await streamFromAnthropic(modelCfg.apiKey, modelCfg.id, messages, res, modelCfg.baseUrl);
    } else {
      await streamFromOpenAI(modelCfg.baseUrl, modelCfg.apiKey, modelCfg.id, messages, res);
    }
  } catch (error) {
    console.error('[ai] callAI failed:', error);
    writeStreamError(res, error);
  }
}

async function callAIWithMessages(messages, res) {
  const cfg = loadConfig();
  const modelCfg = cfg.models.find(model => model.id === cfg.activeModel) || cfg.models[0];

  ensureSseHeaders(res);
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

async function handleAnalyze(req, res) {
  const { messages, customerName } = req.body;
  const cfg = loadConfig();
  const recentMsgs = (messages || []).slice(-30)
    .map(message => `[${message.sender === cfg.mySenderName ? '我' : customerName}] ${message.content}`)
    .join('\n');

  const system = `你是销售助理，分析微信聊天记录，输出：
产品：（从以下选一个或说"未识别"）${cfg.products.join('、')}
进度：（从以下选一个）${cfg.progressStages.join(' → ')}
分析：（2-3句话，客户意向和当前状态）`;

  await callAI(system, `与"${customerName}"的最近聊天（${messages?.length || 0}条中最近30条）：\n\n${recentMsgs}`, res);
}

async function handleTactics(req, res) {
  const { messages, customerName, product, progressStage, daysSince, phase, productCard, sampleScripts } = req.body;
  const cfg = loadConfig();
  const stages = cfg.progressStages;
  const curr = stages[progressStage] || stages[0];
  const next = stages[Math.min((progressStage || 0) + 1, stages.length - 1)];

  const recentMsgs = (messages || []).slice(-20)
    .map(message => `[${message.sender === cfg.mySenderName ? '我' : customerName}] ${message.content}`)
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
    ? `\n\n--- 参考话术（来自话术库，仅供风格参考，不要直接照抄）---\n${sampleScripts.map((script, index) => `${index + 1}. ${script}`).join('\n\n')}`
    : '';
  const kbSection = buildKbSection(curr, messages, cfg.mySenderName);
  const scenario = (messages || []).slice(-5).map(message => message.content || '').join(' ');
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

  ensureSseHeaders(res);
  if (referenceChunks.length > 0) {
    res.write(`data: ${JSON.stringify({ referenceChunks })}\n\n`);
  }
  await callAI(system, `最近聊天记录：\n\n${recentMsgs}`, res);
}

async function handleTacticsV1(req, res) {
  const { messages, customerName, product, progressStage, productCard, sampleScripts } = req.body;
  const cfg = loadConfig();
  const stages = cfg.progressStages;
  const curr = stages[progressStage] || stages[0];
  const next = stages[Math.min((progressStage || 0) + 1, stages.length - 1)];
  const recentContext = buildRecentContext(messages, cfg.mySenderName, customerName, 18);
  const recentMySent = getRecentMySentMessages(messages, cfg.mySenderName, 5);

  const productSection = productCard ? `\n\n---产品资料---\n${productCard}` : '';
  const scriptsSection = (sampleScripts && sampleScripts.length)
    ? `\n\n---话术库（仅供风格参考，不要照抄）---\n${sampleScripts.map((script, index) => `${index + 1}. ${script}`).join('\n\n')}`
    : '';
  const kbSection = buildKbSection(curr, messages, cfg.mySenderName);
  const scenario = (messages || []).slice(-5).map(message => message.content || '').join(' ');
  const referenceChunks = retrieveRelevantChunks(scenario);
  const diagnosis = await diagnoseTacticsInput({
    messages,
    customerName,
    curr,
    product,
    mySenderName: cfg.mySenderName
  });

  const system = `你是「金币猎人」销售助手，帮助销售人员针对当前客户对话生成可直接发送的微信话术。

你的产品：根据产品库选框调用，如果空白默认推播客变现私教。
默认产品：播客私教5200，帮学员从零做播客实现引流变现。${productSection}${scriptsSection}${kbSection}

工作流说明：
- 诊断已经完成，下面提供的是诊断结果，不需要你重新判断阶段
- 当前阶段是人工确认结果，必须严格执行 "${curr}" 阶段，不允许改判
- 如果你觉得客户真实状态和人工阶段有偏差，只能在“判断”里轻微提示，但生成策略仍必须严格按 "${curr}" 阶段执行

当前任务：
客户处于${curr}阶段，目标推进到${next}阶段。
诊断结果：
- follow_manual_stage: ${diagnosis.follow_manual_stage ? 'true' : 'false'}
- stage: ${diagnosis.stage || curr}
- objection_type: ${diagnosis.objection_type || '无明显顾虑'}
- customer_intent: ${diagnosis.customer_intent || ''}
- next_goal: ${diagnosis.next_goal || ''}
- must_avoid: ${(diagnosis.must_avoid || []).join('；') || '不要重复最近已发原句'}
- evidence: ${(diagnosis.evidence || []).join('；') || '无'}

阶段策略：
* 建立链接：让客户愿意聊，不推产品
* 同步信息：确认客户情况，对齐认知
* 挖掘需求：找痛点和规划愿景，激发对产品的需求，肯定需求
* 解决顾虑：70%放大需求愿景画饼，30%戳痛点极限场景，引入更大顾虑，让客户觉得我们的产品就是他的顾虑的解决方案
* 达成成交：需求和痛点聊透了才给临门一脚

销售技巧：
* 问句结尾
* yesand
* 放大损失
* 愿景钩子
* 不接飞盘拉回成交
* 肯定需求
* 极限场景
* 残缺效应
* 成交梯度钩子

输出要求：
* 先基于给定诊断结果做一句判断，再给话术，不要重新改判阶段
* 话术必须自然口语，像真实微信聊天，能直接复制发送
* 不要写成分析报告、培训讲义、客服公告、销售SOP
* 不要用markdown、项目符号、数字清单、A/B/C、1/2/3、双引号、书名号、加粗符号
* 如果当前阶段是挖掘需求，优先继续挖需求，不要急着推产品、讲完整方案、报价或催成交
* 严禁直接复用“最近我方已发送的话”里的原句或高度相似表达

输出格式：
判断：2个关键信号 + 一句话说清客户现在真正想要什么
推荐发送：最建议现在就发
备选1：更柔一点
备选2：更推进一点`;

  ensureSseHeaders(res);
  if (referenceChunks.length > 0) {
    res.write(`data: ${JSON.stringify({ referenceChunks })}\n\n`);
  }
  await callAI(system, `客户"${customerName}"的最近相关聊天：\n\n${recentContext || '无'}\n\n最近我方已发送的话（禁止复用原句）：\n${recentMySent.length ? recentMySent.map((item, index) => `${index + 1}. ${item}`).join('\n') : '无'}`, res);
}

async function handleChat(req, res) {
  const { history, customerName, recentMessages } = req.body;
  const cfg = loadConfig();

  const context = (recentMessages || []).slice(-20)
    .map(message => `[${message.sender === cfg.mySenderName ? '我' : customerName}] ${message.content}`)
    .join('\n');

  const systemPrompt = `你是金币猎人销售助理，正在协助跟进客户"${customerName}"。
${context ? `\n最近聊天记录：\n${context}\n` : ''}
你可以：分析客户意向、生成话术、回答销售策略问题。回答简洁专业，中文。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || [])
  ];

  await callAIWithMessages(messages, res);
}

async function testModel({ provider, apiKey, baseUrl, id }) {
  const { default: fetch } = await import('node-fetch');
  try {
    if (provider === 'anthropic') {
      const endpoint = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: id, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      });
      return { ok: response.ok, status: response.status };
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: id, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  handleAnalyze,
  handleTactics,
  handleTacticsV1,
  handleChat,
  testModel,
};
