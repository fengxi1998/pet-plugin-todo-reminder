/**
 * 到点提醒 · 常驻能力层（tool 上下文）。
 *
 * 宿主把插件入口 require 进独立 utilityProcess，本文件生命周期跟随插件启停。
 * 职责：
 *   1) 向宿主 Agent 注册 5 个可调用工具（增 / 列 / 完成 / 删除 / 推迟）
 *   2) 每 30 秒巡检一次待办：到期即提醒（冒泡 + unread 动作 + 徽标），
 *      逾期仍未完成的每 10 分钟催一次（最多 3 次，之后只靠徽标红档提示）
 *   3) 每天 09:00 播报今天的到期数与逾期数
 *   4) 订阅面板/卡片发出的变更事件，保证徽标不脱节
 *
 * 数据存在插件私有 storage（%APPDATA%\desktop-pet-shell\plugins\todo-reminder\data.json），
 * tool / panel / card 三侧共用同一份。
 */

'use strict';

const TODO_KEY = 'todos';
const CHANGED_EVENT = 'todo-reminder:changed';
// 跨插件广播：对话型插件（如 dsh-shenshen）监听它，把提醒写进各自的对话记录。
const REMIND_EVENT = 'todo-reminder:remind';
const COMPLETED_EVENT = 'todo-reminder:completed';   // 跨插件契约：一条待办被标记完成（payload: {id, text, doneAt}）
const MAX_TODOS = 200;

const CHECK_EVERY_MS = 30 * 1000;        // 到点提醒的检测粒度：30 秒
const NAG_INTERVAL_MS = 10 * 60 * 1000;  // 逾期催办间隔：10 分钟
const MAX_NAGS = 3;                      // 每条最多催 3 次，之后不再打扰
const MORNING_HHMM = '09:00';

// 气泡显示时长：宿主对插件气泡的默认值只有 4 秒（applyPluginPet 的兜底），
// 提醒文案需要读的时间更长，显式传第二个参数覆盖。提醒给足 30 秒。
// 注意头顶五胶囊强互斥：思考中/差事/朗读胶囊出现时仍会提前收掉，这是宿主行为。
const BUBBLE_MS_REMIND = 30 * 1000;
const BUBBLE_MS_MORNING = 8 * 1000;

let sdk = null;
const timerIds = new Set();

// ---------- 数据读写 ----------

async function readTodos(pet) {
  const raw = await pet.storage.get(TODO_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item.text === 'string');
}

async function writeTodos(pet, todos) {
  await pet.storage.set(TODO_KEY, todos.slice(0, MAX_TODOS));
}

function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 徽标（宠物脚下状态胶囊）----------
// 宿主限制：最多 2 段，每段文案不超过 4 个码点。

async function syncBadge(pet) {
  try {
    const todos = await readTodos(pet);
    const pending = todos.filter((item) => !item.done);
    const overdue = pending.filter((item) => item.due && Date.parse(item.due) < Date.now());

    const segments = [];
    if (pending.length) {
      segments.push({
        tone: overdue.length ? 'danger' : 'warning',
        text: '待' + (pending.length > 99 ? '多' : pending.length)
      });
    }
    if (overdue.length) {
      segments.push({ tone: 'danger', text: '逾' + (overdue.length > 99 ? '多' : overdue.length) });
    }

    if (!segments.length) await pet.badge.clear();
    else await pet.badge.set({ segments, onClick: 'openPanel' });
  } catch (err) {
    // 徽标名额被别的插件占用属可预期冲突，不打断主流程。
  }
}

// ---------- 到点巡检 ----------

function pickReminderText(dueList) {
  if (!dueList.length) return '';
  const first = dueList[0];
  if (dueList.length === 1) {
    return '到点了：' + (first.text.length > 30 ? first.text.slice(0, 30) + '…' : first.text);
  }
  return '到点了 ' + dueList.length + ' 件事，先说第一件：' + (first.text.length > 24 ? first.text.slice(0, 24) + '…' : first.text);
}

async function remindItems(pet, items) {
  await pet.pet.playAnim('unread');
  await pet.pet.bubble(pickReminderText(items), BUBBLE_MS_REMIND);
  // 同时广播给对话型插件，让提醒留在对话记录里可回看。
  try {
    await pet.events.emit(REMIND_EVENT, {
      items: items.map((item) => ({ text: item.text, due: item.due || '' })),
      overdue: items.some((item) => item.due && Date.parse(item.due) < Date.now())
    });
  } catch (err) { /* 没有监听方时忽略 */ }
}

async function checkDueTodos(pet) {
  const todos = await readTodos(pet);
  const now = Date.now();
  const toRemind = [];
  let changed = false;

  for (const item of todos) {
    if (item.done || !item.due) continue;
    const dueAt = Date.parse(item.due);
    if (Number.isNaN(dueAt)) continue;

    if (dueAt <= now && !item.remindedAt) {
      // 刚到期：立即提醒
      item.remindedAt = now;
      item.nagCount = 0;
      changed = true;
      toRemind.push(item);
    } else if (item.remindedAt && now - item.remindedAt >= NAG_INTERVAL_MS && (item.nagCount || 0) < MAX_NAGS) {
      // 逾期未办：周期性催办
      item.remindedAt = now;
      item.nagCount = (item.nagCount || 0) + 1;
      changed = true;
      toRemind.push(item);
    }
  }

  if (changed) {
    await writeTodos(pet, todos);
    await syncBadge(pet);
    await pet.events.emit(CHANGED_EVENT, { scope: 'todo', reminded: toRemind.length });
  }
  if (toRemind.length) await remindItems(pet, toRemind);
}

async function morningGreeting(pet) {
  const todos = await readTodos(pet);
  const now = Date.now();
  const pending = todos.filter((item) => !item.done);
  const overdue = pending.filter((item) => item.due && Date.parse(item.due) < now);
  const todayDue = pending.filter((item) => {
    if (!item.due) return false;
    const at = Date.parse(item.due);
    if (Number.isNaN(at)) return false;
    const d = new Date(at);
    const t = new Date(now);
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  });

  await pet.pet.playAnim('wake');
  let msg = '早上好';
  if (todayDue.length) msg += '，今天有 ' + todayDue.length + ' 件事到期';
  if (overdue.length) msg += '，还有 ' + overdue.length + ' 件已经逾期';
  if (!todayDue.length && !overdue.length) msg += '，今天没有到期的安排';
  await pet.pet.bubble(msg, BUBBLE_MS_MORNING);
}

// ---------- 向宿主 Agent 注册的工具 ----------

function normalizeDue(due) {
  if (due === undefined || due === null || due === '') return '';
  const s = String(due).trim();
  if (!s) return '';
  const at = Date.parse(s);
  if (Number.isNaN(at)) throw new Error('due 不是可解析的时间：' + s);
  return new Date(at).toISOString();
}

function findTodo(todos, query) {
  const q = String(query || '').trim();
  return todos.find((t) => t.id === q)
    || todos.find((t) => !t.done && t.text.includes(q))
    || todos.find((t) => t.text.includes(q));
}

function registerTools(pet) {
  pet.tools.register({
    name: 'reminder_add',
    promptHint: '添加一条待办，可带到期时间。到点后桌宠会主动冒泡提醒。',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待办内容' },
        due: { type: 'string', description: '可选，到期时间，如 2026-10-30T18:00:00+08:00 或 2026-10-30 18:00' }
      },
      required: ['text']
    },
    async handler(args) {
      const text = String(args.text || '').trim();
      if (!text) return { ok: false, error: 'text 不能为空' };
      if (text.length > 200) return { ok: false, error: 'text 过长（上限 200 字）' };

      let due;
      try { due = normalizeDue(args.due); } catch (err) { return { ok: false, error: String(err.message || err) }; }

      const todos = await readTodos(pet);
      todos.push({ id: newId(), text, done: false, due, remindedAt: 0, nagCount: 0, ts: Date.now() });
      await writeTodos(pet, todos);
      await syncBadge(pet);
      await pet.events.emit(CHANGED_EVENT, { scope: 'todo' });
      return {
        ok: true,
        total: todos.length,
        pending: todos.filter((item) => !item.done).length,
        willRemind: !!due
      };
    }
  });

  pet.tools.register({
    name: 'reminder_list',
    promptHint: '查看待办清单。',
    schema: {
      type: 'object',
      properties: {
        onlyPending: { type: 'boolean', description: '为 true 时只返回未完成项' }
      }
    },
    async handler(args) {
      const todos = await readTodos(pet);
      const onlyPending = args.onlyPending === true;
      const now = Date.now();
      const items = (onlyPending ? todos.filter((t) => !t.done) : todos).map((item) => ({
        id: item.id,
        text: item.text,
        done: !!item.done,
        due: item.due ? new Date(Date.parse(item.due)).toLocaleString('zh-CN') : '',
        overdue: !item.done && !!item.due && Date.parse(item.due) < now
      }));
      return {
        ok: true,
        pending: todos.filter((t) => !t.done).length,
        done: todos.filter((t) => t.done).length,
        items
      };
    }
  });

  pet.tools.register({
    name: 'reminder_done',
    promptHint: '把一条待办标记为完成。可用 id 或内容关键字定位。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '待办 id 或内容关键字' }
      },
      required: ['target']
    },
    async handler(args) {
      const todos = await readTodos(pet);
      const item = findTodo(todos, args.target);
      if (!item) return { ok: false, error: '没找到这条待办：' + args.target };
      item.done = true;
      item.doneAt = Date.now();
      await writeTodos(pet, todos);
      await syncBadge(pet);
      await pet.events.emit(CHANGED_EVENT, { scope: 'todo' });
      await pet.events.emit(COMPLETED_EVENT, { id: item.id, text: item.text, doneAt: item.doneAt });
      return { ok: true, text: item.text };
    }
  });

  pet.tools.register({
    name: 'reminder_delete',
    promptHint: '删除一条待办（不问完成没完成）。可用 id 或内容关键字定位。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '待办 id 或内容关键字' }
      },
      required: ['target']
    },
    async handler(args) {
      const todos = await readTodos(pet);
      const item = findTodo(todos, args.target);
      if (!item) return { ok: false, error: '没找到这条待办：' + args.target };
      const rest = todos.filter((t) => t !== item);
      await writeTodos(pet, rest);
      await syncBadge(pet);
      await pet.events.emit(CHANGED_EVENT, { scope: 'todo' });
      return { ok: true, deleted: item.text, total: rest.length };
    }
  });

  pet.tools.register({
    name: 'reminder_snooze',
    promptHint: '把一条待办推迟：到期时间顺延 N 分钟（默认 5），并重新武装提醒。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '待办 id 或内容关键字' },
        minutes: { type: 'number', description: '推迟多少分钟，默认 5，上限 7 天' }
      },
      required: ['target']
    },
    async handler(args) {
      const todos = await readTodos(pet);
      const item = findTodo(todos, args.target);
      if (!item) return { ok: false, error: '没找到这条待办：' + args.target };

      const minutes = Number.isFinite(args.minutes) && args.minutes > 0 ? args.minutes : 5;
      if (minutes > 7 * 24 * 60) return { ok: false, error: '推迟上限 7 天' };

      const base = item.due && Date.parse(item.due) > Date.now() ? Date.parse(item.due) : Date.now();
      item.due = new Date(base + minutes * 60 * 1000).toISOString();
      item.remindedAt = 0;
      item.nagCount = 0;
      await writeTodos(pet, todos);
      await syncBadge(pet);
      await pet.events.emit(CHANGED_EVENT, { scope: 'todo' });
      return { ok: true, text: item.text, newDue: new Date(Date.parse(item.due)).toLocaleString('zh-CN') };
    }
  });
}

// ---------- 生命周期 ----------

exports.activate = async function activate(pet) {
  sdk = pet;

  registerTools(pet);

  timerIds.add(await pet.scheduler.every(CHECK_EVERY_MS, () => checkDueTodos(pet)));
  timerIds.add(await pet.scheduler.daily(MORNING_HHMM, () => morningGreeting(pet)));

  pet.events.on(CHANGED_EVENT, () => {
    syncBadge(pet).catch(() => {});
  });

  await syncBadge(pet);

  // 启动时把「已逾期但还没提醒过」的旧账立即补提醒（比如宿主停了几小时）。
  try { await checkDueTodos(pet); } catch (err) { /* 首轮失败不影响后续巡检 */ }
};

exports.deactivate = async function deactivate() {
  if (!sdk) return;
  for (const id of timerIds) {
    try { await sdk.scheduler.cancel(id); } catch (err) { /* 已失效的定时器忽略 */ }
  }
  timerIds.clear();
  try { await sdk.badge.clear(); } catch (err) { /* 徽标已被宿主回收 */ }
  sdk = null;
};
