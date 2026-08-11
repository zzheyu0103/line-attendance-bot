require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const line = require('@line/bot-sdk');

const required = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'ADMIN_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少環境變數：${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'attendance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    line_user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('clock_in', 'clock_out')),
    occurred_at TEXT NOT NULL,
    FOREIGN KEY(line_user_id) REFERENCES employees(line_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_user_time
    ON attendance(line_user_id, occurred_at);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings(key,value) VALUES
    ('shift_start','09:00'),
    ('late_grace_minutes','5'),
    ('standard_hours','8'),
    ('minimum_daily_staff','1');
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    work_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE(line_user_id,work_date),
    FOREIGN KEY(line_user_id) REFERENCES employees(line_user_id)
  );
  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    leave_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(line_user_id) REFERENCES employees(line_user_id)
  );
`);
for (const sql of [
  'ALTER TABLE employees ADD COLUMN custom_name TEXT',
  "ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'line'",
  "ALTER TABLE attendance ADD COLUMN note TEXT NOT NULL DEFAULT ''",
]) {
  try { db.exec(sql); } catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
}
let approvalColumnAdded = false;
try { db.exec('ALTER TABLE employees ADD COLUMN approved INTEGER NOT NULL DEFAULT 0'); approvalColumnAdded = true; }
catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
if (approvalColumnAdded) db.exec('UPDATE employees SET approved=1');

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const taipeiDate = (date = new Date()) => dateFormatter.format(date);
const dayPrefix = () => taipeiDate().slice(0, 10);
const monthPrefix = () => taipeiDate().slice(0, 7);
const toMillis = (value) => new Date(`${value.replace(' ', 'T')}+08:00`).getTime();
const addDays = (date, days) => taipeiDate(new Date(new Date(`${date}T12:00:00+08:00`).getTime() + days * 86400000)).slice(0, 10);
function mondayOf(date) {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : dayPrefix();
  const weekday = new Date(`${value}T12:00:00+08:00`).getUTCDay() || 7;
  return addDays(value, 1 - weekday);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function lineCall(operation, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const status = error.status || error.statusCode || error.response?.status;
      if (attempt === attempts - 1 || (status !== 429 && status < 500)) throw error;
      await sleep(750 * (2 ** attempt));
    }
  }
}
function getSettings() {
  const values = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
  return { shiftStart: values.shift_start || '09:00', lateGrace: Number(values.late_grace_minutes || 5), standardHours: Number(values.standard_hours || 8), minimumStaff: Number(values.minimum_daily_staff || 1) };
}

function shiftHours(start, end) {
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  let minutes = endHour * 60 + endMinute - startHour * 60 - startMinute;
  if (minutes < 0) minutes += 1440;
  return minutes / 60;
}

async function ensureEmployee(userId) {
  let displayName = '未命名員工';
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName || displayName;
  } catch (_) {}
  db.prepare(`INSERT INTO employees(line_user_id, display_name, created_at)
    VALUES (?, ?, ?) ON CONFLICT(line_user_id) DO UPDATE SET display_name=excluded.display_name`)
    .run(userId, displayName, taipeiDate());
  return db.prepare('SELECT COALESCE(NULLIF(custom_name,\'\'), display_name) AS name,approved FROM employees WHERE line_user_id=?').get(userId);
}

function todayRecords(userId) {
  return db.prepare(`SELECT id, type, occurred_at FROM attendance
    WHERE line_user_id=? AND occurred_at LIKE ? ORDER BY occurred_at`).all(userId, `${dayPrefix()}%`);
}

function lastRecord(userId) {
  return db.prepare('SELECT id, type, occurred_at FROM attendance WHERE line_user_id=? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(userId);
}

function replyText(replyToken, text) {
  return lineCall(() => client.replyMessage({ replyToken, messages: [{ type: 'text', text, quickReply: { items: [
    { type: 'action', action: { type: 'message', label: '上班', text: '上班' } },
    { type: 'action', action: { type: 'message', label: '下班', text: '下班' } },
    { type: 'action', action: { type: 'message', label: '今日', text: '今日' } },
    { type: 'action', action: { type: 'message', label: '班表', text: '班表' } },
  ] } }] }));
}

async function handleMessage(event) {
  if (event.type !== 'message' || event.message.type !== 'text' || !event.source.userId) return;
  const rawCommand = event.message.text.trim();
  const command = rawCommand.replace(/\s+/g, '');
  const userId = event.source.userId;
  const employee = await ensureEmployee(userId);
  const name = employee.name;
  if (!employee.approved) return replyText(event.replyToken, `👋 ${name}，你的員工申請已建立。\n請等待管理員在後台核准後再使用打卡功能。`);
  const last = lastRecord(userId);

  if (['上班', '打卡上班'].includes(command)) {
    if (last?.type === 'clock_in') {
      return replyText(event.replyToken, `${name}，你還有一筆尚未下班的紀錄：\n${last.occurred_at}\n如需更正請聯絡管理員。`);
    }
    const now = taipeiDate();
    db.prepare('INSERT INTO attendance(line_user_id,type,occurred_at,source) VALUES (?,?,?,?)').run(userId, 'clock_in', now, 'line');
    const settings = getSettings();
    const shift = db.prepare('SELECT start_time FROM schedules WHERE line_user_id=? AND work_date=?').get(userId, now.slice(0, 10));
    const scheduled = toMillis(`${now.slice(0, 10)} ${shift?.start_time || settings.shiftStart}:00`) + settings.lateGrace * 60000;
    const lateText = toMillis(now) > scheduled ? '\n⚠️ 已超過上班時間' : '';
    return replyText(event.replyToken, `✅ ${name} 上班打卡成功\n${now}${lateText}`);
  }

  if (['下班', '打卡下班'].includes(command)) {
    if (!last || last.type !== 'clock_in') return replyText(event.replyToken, `${name}，目前沒有尚未完成的上班紀錄。`);
    const now = taipeiDate();
    const hours = (toMillis(now) - toMillis(last.occurred_at)) / 3600000;
    if (hours > 24) return replyText(event.replyToken, `${name}，上次上班紀錄已超過 24 小時，請聯絡管理員更正。`);
    db.prepare('INSERT INTO attendance(line_user_id,type,occurred_at,source) VALUES (?,?,?,?)').run(userId, 'clock_out', now, 'line');
    return replyText(event.replyToken, `✅ ${name} 下班打卡成功\n${now}\n本次工時：${hours.toFixed(2)} 小時`);
  }

  if (['今日', '狀態'].includes(command)) {
    const records = todayRecords(userId);
    const text = records.length ? records.map((r) => `${r.type === 'clock_in' ? '上班' : '下班'}：${r.occurred_at.slice(11, 16)}`).join('\n') : '今天還沒有打卡紀錄。';
    return replyText(event.replyToken, `📋 ${name} 今日紀錄\n${text}`);
  }

  if (command === '本月') {
    const rows = db.prepare('SELECT type,occurred_at FROM attendance WHERE line_user_id=? AND occurred_at LIKE ? ORDER BY occurred_at').all(userId, `${monthPrefix()}%`);
    const summary = summarize(rows);
    return replyText(event.replyToken, `📅 ${name} ${monthPrefix()}\n出勤：${summary.shifts} 天\n累計：${summary.hours.toFixed(2)} 小時\n未完成：${summary.incomplete} 筆`);
  }

  if (command === '班表') {
    const from = dayPrefix();
    const to = addDays(from, 6);
    const shifts = db.prepare('SELECT work_date,start_time,end_time,note FROM schedules WHERE line_user_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date').all(userId, from, to);
    if (!shifts.length) return replyText(event.replyToken, `📆 ${name}，未來 7 天尚未安排班表。`);
    const text = shifts.map((s) => `${s.work_date.slice(5)}　${s.start_time}–${s.end_time}${s.note ? `　${s.note}` : ''}`).join('\n');
    return replyText(event.replyToken, `📆 ${name} 未來 7 天班表\n${text}`);
  }

  const leaveMatch = rawCommand.match(/^請假\s+(\d{4}-\d{2}-\d{2})\s+(.{1,100})$/);
  if (leaveMatch) {
    if (leaveMatch[1] < dayPrefix()) return replyText(event.replyToken, '請假日期不可早於今天。');
    db.prepare('INSERT INTO leave_requests(line_user_id,leave_date,reason,status,created_at) VALUES (?,?,?,?,?)').run(userId, leaveMatch[1], leaveMatch[2], 'pending', taipeiDate());
    return replyText(event.replyToken, `📝 請假申請已送出\n日期：${leaveMatch[1]}\n原因：${leaveMatch[2]}\n請等待管理員審核。`);
  }

  if (command === '我的請假') {
    const leaves = db.prepare('SELECT leave_date,reason,status FROM leave_requests WHERE line_user_id=? ORDER BY id DESC LIMIT 5').all(userId);
    const labels = { pending: '待審核', approved: '已核准', rejected: '已駁回' };
    const text = leaves.length ? leaves.map((l) => `${l.leave_date}　${labels[l.status]}　${l.reason}`).join('\n') : '目前沒有請假申請。';
    return replyText(event.replyToken, `📋 ${name} 的請假紀錄\n${text}`);
  }

  return replyText(event.replyToken, '可用指令：\n上班／下班－打卡\n今日／狀態－查看今天\n本月－查看本月工時\n班表－未來 7 天班表\n請假 2026-08-20 原因\n我的請假－查看申請');
}

app.get('/health', (_req, res) => res.json({ ok: true, time: taipeiDate() }));
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleMessage));
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

app.use(express.urlencoded({ extended: false }));
const sessionValue = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update('line-attendance-admin').digest('hex');
const csrfValue = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update('csrf').digest('hex');
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }));
}
function authorized(req) { return cookies(req).attendance_admin === sessionValue; }
function requireAdmin(req, res, next) { return authorized(req) ? next() : res.redirect('/admin/login'); }
function requireCsrf(req, res, next) { return req.body.csrf === csrfValue ? next() : res.status(403).send('表單已失效，請重新整理。'); }
function setSession(res) {
  res.setHeader('Set-Cookie', `attendance_admin=${sessionValue}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=2592000`);
}

app.get('/admin/login', (_req, res) => res.send(page('管理員登入', `<main class="login"><h1>管理員登入</h1><form method="post"><label>密碼<input name="password" type="password" required autofocus></label><button>登入</button></form></main>`)));
app.post('/admin/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || ''));
  const b = Buffer.from(process.env.ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send(page('登入失敗', '<main class="login"><h1>密碼錯誤</h1><a href="/admin/login">重試</a></main>'));
  setSession(res);
  res.redirect('/admin');
});
app.get('/admin/logout', (_req, res) => { res.setHeader('Set-Cookie', 'attendance_admin=; Path=/admin; Max-Age=0'); res.redirect('/admin/login'); });

app.get('/admin/schedules', requireAdmin, (req, res) => {
  const week = mondayOf(req.query.week);
  const settings = getSettings();
  const dates = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const employees = db.prepare(`SELECT line_user_id,COALESCE(NULLIF(custom_name,''),display_name) name
    FROM employees WHERE approved=1 ORDER BY name`).all();
  const shifts = db.prepare(`SELECT s.*,COALESCE(NULLIF(e.custom_name,''),e.display_name) name
    FROM schedules s JOIN employees e USING(line_user_id)
    WHERE s.work_date BETWEEN ? AND ? ORDER BY s.work_date,s.start_time,name`).all(dates[0], dates[6]);
  const leaves = db.prepare(`SELECT l.line_user_id,l.leave_date,l.reason,COALESCE(NULLIF(e.custom_name,''),e.display_name) name
    FROM leave_requests l JOIN employees e USING(line_user_id)
    WHERE l.status='approved' AND l.leave_date BETWEEN ? AND ?`).all(dates[0], dates[6]);
  const leaveMap = new Map(leaves.map((leave) => [`${leave.line_user_id}|${leave.leave_date}`, leave]));
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const cards = dates.map((date, index) => {
    const dayShifts = shifts.filter((shift) => shift.work_date === date);
    const rows = dayShifts.map((shift) => {
      const leave = leaveMap.get(`${shift.line_user_id}|${date}`);
      return `<div class="shift-row${leave ? ' conflict' : ''}" data-user="${escapeHtml(shift.line_user_id)}"><div><b>${escapeHtml(shift.name)}</b><span>${shift.start_time}–${shift.end_time} · ${shiftHours(shift.start_time, shift.end_time).toFixed(1)} 小時${shift.note ? ` · ${escapeHtml(shift.note)}` : ''}</span>${leave ? `<em title="${escapeHtml(leave.reason)}">請假衝突</em>` : ''}</div><form method="post" action="/admin/schedule/delete"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${shift.id}"><input type="hidden" name="returnTo" value="/admin/schedules?week=${week}"><button class="icon-danger" title="刪除班表">×</button></form></div>`;
    }).join('');
    const dayLeaves = leaves.filter((leave) => leave.leave_date === date && !dayShifts.some((shift) => shift.line_user_id === leave.line_user_id));
    const understaffed = dayShifts.length < settings.minimumStaff;
    return `<article class="schedule-day${date === dayPrefix() ? ' is-today' : ''}${understaffed ? ' understaffed' : ''}"><div class="day-head"><div><span>週${weekdayNames[index]}</span><h3>${date.slice(5).replace('-', '/')}</h3></div><b>${dayShifts.length}<small>人</small></b></div>${understaffed ? `<div class="staff-warning">尚缺 ${settings.minimumStaff - dayShifts.length} 人</div>` : ''}<div class="day-shifts">${rows || '<p class="no-shift">尚未排班</p>'}${dayLeaves.map((leave) => `<div class="leave-only">休假 · ${escapeHtml(leave.name)}</div>`).join('')}</div></article>`;
  }).join('');
  const employeeChecks = employees.map((employee) => `<label class="check-person"><input type="checkbox" name="userIds" value="${escapeHtml(employee.line_user_id)}"><span>${escapeHtml(employee.name)}</span></label>`).join('');
  const weekdayChecks = weekdayNames.map((name, index) => `<label><input type="checkbox" name="weekdays" value="${index + 1}" ${index < 5 ? 'checked' : ''}>週${name}</label>`).join('');
  const totalAssignments = shifts.length;
  const staffedDays = new Set(shifts.map((shift) => shift.work_date)).size;
  const totalHours = shifts.reduce((sum, shift) => sum + shiftHours(shift.start_time, shift.end_time), 0);
  const employeeWorkload = employees.map((employee) => {
    const assigned = shifts.filter((shift) => shift.line_user_id === employee.line_user_id);
    const hours = assigned.reduce((sum, shift) => sum + shiftHours(shift.start_time, shift.end_time), 0);
    return `<tr data-workload-user="${escapeHtml(employee.line_user_id)}"><td>${escapeHtml(employee.name)}</td><td>${assigned.length}</td><td>${hours.toFixed(1)}</td><td>${assigned.map((shift) => shift.work_date.slice(5)).join('、') || '—'}</td></tr>`;
  }).join('');
  const filterOptions = employees.map((employee) => `<option value="${escapeHtml(employee.line_user_id)}">${escapeHtml(employee.name)}</option>`).join('');
  res.send(page('排班中心', `<header><div><h1>排班中心</h1><p>${dates[0]} ～ ${dates[6]}</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/logout">登出</a></nav></header>
    <main class="schedule-page"><section class="schedule-toolbar"><a class="nav-button" href="/admin/schedules?week=${addDays(week, -7)}">← 上一週</a><form method="get"><label>快速跳到<input type="date" name="week" value="${week}"></label><button>前往</button></form><div class="schedule-tools"><button type="button" class="secondary" onclick="window.print()">列印</button><a class="nav-button" href="/admin/schedules/export?week=${week}">匯出 CSV</a><a class="nav-button" href="/admin/schedules?week=${addDays(week, 7)}">下一週 →</a></div></section>
    <section class="schedule-summary"><div><b>${employees.length}</b><span>可排班員工</span></div><div><b>${totalAssignments}</b><span>本週班次</span></div><div><b>${totalHours.toFixed(1)}</b><span>本週總工時</span></div><div><b>${leaves.length}</b><span>核准休假</span></div></section>
    <section class="schedule-controls"><label>只看特定員工<select id="schedule-filter"><option value="">全部員工</option>${filterOptions}</select></label><form method="post" action="/admin/schedules/settings"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><label>每日最低人力<input type="number" name="minimumStaff" value="${settings.minimumStaff}" min="0" max="99" required></label><button>儲存</button></form></section>
    <section class="week-grid">${cards}</section>
    <section class="workload"><div class="panel-title"><span>本週負荷</span><h2>員工班次與工時</h2></div><div class="table-wrap"><table><thead><tr><th>員工</th><th>班次</th><th>預排工時</th><th>出勤日期</th></tr></thead><tbody>${employeeWorkload || '<tr><td colspan="4">尚無員工</td></tr>'}</tbody></table></div></section>
    <section class="schedule-actions"><article><div class="panel-title"><span>批次建立</span><h2>一次安排多人班表</h2></div><form class="bulk-form" method="post" action="/admin/schedules/bulk"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><fieldset><legend>選擇員工</legend><div class="people-grid">${employeeChecks || '<p>目前沒有已核准員工</p>'}</div></fieldset><fieldset><legend>日期與星期</legend><div class="form-row"><label>開始日期<input type="date" name="fromDate" value="${dates[0]}" required></label><label>結束日期<input type="date" name="toDate" value="${dates[6]}" required></label></div><div class="weekday-checks">${weekdayChecks}</div><label class="skip-leave"><input type="checkbox" name="skipLeave" value="1" checked>自動略過已核准請假的員工</label></fieldset><fieldset><legend>班別內容</legend><div class="form-row"><label>上班<input type="time" name="startTime" value="${settings.shiftStart}" required></label><label>下班<input type="time" name="endTime" value="18:00" required></label><label class="grow">備註<input name="note" maxlength="100" placeholder="例如：早班、門市支援"></label></div></fieldset><button class="primary-wide">建立／覆蓋所選班表</button></form></article>
    <article><div class="panel-title"><span>快速套用</span><h2>複製前一週班表</h2></div><p class="muted">把 ${addDays(week, -7)} ～ ${addDays(week, -1)} 的班表複製到本週；同一員工同一天已有班表時會更新。</p><form method="post" action="/admin/schedules/copy-week" onsubmit="return confirm('確定複製前一週班表到本週？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><button>複製前一週</button></form></article></section></main><script>document.getElementById('schedule-filter')?.addEventListener('change',function(){const id=this.value;document.querySelectorAll('.shift-row').forEach(row=>row.hidden=!!id&&row.dataset.user!==id);document.querySelectorAll('[data-workload-user]').forEach(row=>row.hidden=!!id&&row.dataset.workloadUser!==id)})</script>`));
});

function formValues(value) { return Array.isArray(value) ? value : value ? [value] : []; }
app.post('/admin/schedules/bulk', requireAdmin, requireCsrf, (req, res) => {
  const userIds = [...new Set(formValues(req.body.userIds).map(String))];
  const weekdays = new Set(formValues(req.body.weekdays).map(Number));
  const { fromDate, toDate, startTime, endTime } = req.body;
  const week = mondayOf(req.body.week);
  if (!userIds.length || !weekdays.size) return res.status(400).send('請至少選擇一位員工與一個星期。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(toDate || '') || !/^\d{2}:\d{2}$/.test(startTime || '') || !/^\d{2}:\d{2}$/.test(endTime || '') || fromDate > toDate) return res.status(400).send('排班日期或時間格式錯誤。');
  const span = Math.round((toMillis(`${toDate} 12:00:00`) - toMillis(`${fromDate} 12:00:00`)) / 86400000);
  if (span > 62) return res.status(400).send('一次批次排班最多 63 天。');
  const approved = new Set(db.prepare('SELECT line_user_id FROM employees WHERE approved=1').all().map((row) => row.line_user_id));
  const leaveDays = req.body.skipLeave === '1' ? new Set(db.prepare(`SELECT line_user_id || '|' || leave_date key FROM leave_requests
    WHERE status='approved' AND leave_date BETWEEN ? AND ?`).all(fromDate, toDate).map((row) => row.key)) : new Set();
  const save = db.prepare(`INSERT INTO schedules(line_user_id,work_date,start_time,end_time,note) VALUES (?,?,?,?,?)
    ON CONFLICT(line_user_id,work_date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,note=excluded.note`);
  db.transaction(() => {
    for (let offset = 0; offset <= span; offset += 1) {
      const date = addDays(fromDate, offset);
      const day = new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
      if (!weekdays.has(day)) continue;
      for (const userId of userIds) if (approved.has(userId) && !leaveDays.has(`${userId}|${date}`)) save.run(userId, date, startTime, endTime, String(req.body.note || '').slice(0, 100));
    }
  })();
  res.redirect(303, `/admin/schedules?week=${week}`);
});

app.post('/admin/schedules/settings', requireAdmin, requireCsrf, (req, res) => {
  const minimumStaff = Math.max(0, Math.min(99, Number(req.body.minimumStaff) || 0));
  db.prepare(`INSERT INTO settings(key,value) VALUES ('minimum_daily_staff',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(minimumStaff));
  res.redirect(303, `/admin/schedules?week=${mondayOf(req.body.week)}`);
});

app.get('/admin/schedules/export', requireAdmin, (req, res) => {
  const week = mondayOf(req.query.week);
  const rows = db.prepare(`SELECT s.work_date,COALESCE(NULLIF(e.custom_name,''),e.display_name) name,s.start_time,s.end_time,s.note
    FROM schedules s JOIN employees e USING(line_user_id) WHERE s.work_date BETWEEN ? AND ? ORDER BY s.work_date,s.start_time,name`).all(week, addDays(week, 6));
  const output = ['日期,員工,上班,下班,預排工時,備註'];
  rows.forEach((row) => output.push([row.work_date, row.name, row.start_time, row.end_time, shiftHours(row.start_time, row.end_time).toFixed(1), row.note].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="schedule-${week}.csv"`);
  res.send('\ufeff' + output.join('\r\n'));
});

app.post('/admin/schedules/copy-week', requireAdmin, requireCsrf, (req, res) => {
  const targetWeek = mondayOf(req.body.week);
  const sourceWeek = addDays(targetWeek, -7);
  const source = db.prepare('SELECT line_user_id,work_date,start_time,end_time,note FROM schedules WHERE work_date BETWEEN ? AND ?').all(sourceWeek, addDays(sourceWeek, 6));
  const save = db.prepare(`INSERT INTO schedules(line_user_id,work_date,start_time,end_time,note) VALUES (?,?,?,?,?)
    ON CONFLICT(line_user_id,work_date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,note=excluded.note`);
  db.transaction(() => source.forEach((shift) => save.run(shift.line_user_id, addDays(shift.work_date, 7), shift.start_time, shift.end_time, shift.note)))();
  res.redirect(303, `/admin/schedules?week=${targetWeek}`);
});

app.get('/admin', (req, res) => {
  if (req.query.password === process.env.ADMIN_PASSWORD) { setSession(res); return res.redirect('/admin'); }
  if (!authorized(req)) return res.redirect('/admin/login');
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const settings = getSettings();
  const employees = db.prepare(`SELECT line_user_id,display_name,custom_name,approved,COALESCE(NULLIF(custom_name,''),display_name) AS name FROM employees ORDER BY approved,name`).all();
  const rows = db.prepare(`SELECT a.id,a.line_user_id,a.type,a.occurred_at,a.source,a.note,
    COALESCE(NULLIF(e.custom_name,''),e.display_name) AS name FROM attendance a JOIN employees e USING(line_user_id)
    WHERE a.occurred_at LIKE ? ORDER BY name,a.occurred_at,a.id`).all(`${month}%`);
  const grouped = new Map(employees.filter((employee) => employee.approved).map((employee) => [employee.line_user_id, { ...employee, rows: [] }]));
  for (const row of rows) grouped.get(row.line_user_id)?.rows.push(row);
  const cards = [...grouped.values()].map((employee) => employeeCard(employee, settings)).join('');
  const latest = db.prepare(`SELECT a.line_user_id,a.type,a.occurred_at FROM attendance a
    JOIN (SELECT line_user_id,MAX(id) id FROM attendance GROUP BY line_user_id) x ON x.id=a.id`).all();
  const today = dayPrefix();
  const working = latest.filter((r) => r.type === 'clock_in' && (toMillis(taipeiDate()) - toMillis(r.occurred_at)) <= 86400000).length;
  const arrived = db.prepare("SELECT COUNT(DISTINCT line_user_id) count FROM attendance WHERE type='clock_in' AND occurred_at LIKE ?").get(`${today}%`).count;
  const activeEmployees = employees.filter((e) => e.approved);
  const options = activeEmployees.map((e) => `<option value="${escapeHtml(e.line_user_id)}">${escapeHtml(e.name)}</option>`).join('');
  const pending = employees.filter((e) => !e.approved);
  const pendingHtml = pending.map((e) => `<div class="pending-person"><div><b>${escapeHtml(e.display_name)}</b><small>${escapeHtml(e.line_user_id)}</small></div><form method="post" action="/admin/employee/approval"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(e.line_user_id)}"><button name="approved" value="1">核准</button><button class="danger" name="approved" value="-1">拒絕並移除</button></form></div>`).join('');
  const schedules = db.prepare(`SELECT s.*,COALESCE(NULLIF(e.custom_name,''),e.display_name) name FROM schedules s JOIN employees e USING(line_user_id) WHERE work_date BETWEEN ? AND ? ORDER BY work_date,start_time,name`).all(today, addDays(today, 30));
  const scheduleRows = schedules.map((s) => `<tr><td>${s.work_date}</td><td>${escapeHtml(s.name)}</td><td>${s.start_time}–${s.end_time}</td><td>${escapeHtml(s.note)}</td><td><form method="post" action="/admin/schedule/delete" onsubmit="return confirm('刪除此班表？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${s.id}"><button class="danger">刪除</button></form></td></tr>`).join('');
  const leaves = db.prepare(`SELECT l.*,COALESCE(NULLIF(e.custom_name,''),e.display_name) name FROM leave_requests l JOIN employees e USING(line_user_id) ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC LIMIT 30`).all();
  const leaveLabels = { pending: '待審核', approved: '已核准', rejected: '已駁回' };
  const leaveRows = leaves.map((l) => `<tr><td>${l.leave_date}</td><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.reason)}</td><td><span class="status-${l.status}">${leaveLabels[l.status]}</span></td><td>${l.status === 'pending' ? `<form method="post" action="/admin/leave/status"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${l.id}"><button name="status" value="approved">核准</button><button class="danger" name="status" value="rejected">駁回</button></form>` : ''}</td></tr>`).join('');
  res.send(page('LINE 打卡管理', `<header><div><h1>出勤管理</h1><p>${month} 月報表</p></div><nav><a href="/admin/schedules">排班中心</a><a href="/admin/export?month=${month}">匯出 CSV</a><a href="/admin/backup">備份資料</a><a href="/admin/logout">登出</a></nav></header>
    <nav class="section-nav"><a href="#overview">總覽</a><a href="#tools">設定與補登</a><a href="#schedule">排班</a><a href="#leave">請假</a><a href="#employees">員工紀錄</a></nav>
    <section id="overview" class="today"><div><b>${activeEmployees.length}</b><span>正式員工</span></div><div><b>${arrived}</b><span>今日已到</span></div><div><b>${working}</b><span>目前上班中</span></div></section>
    ${pending.length ? `<section class="pending-box"><h2>待核准員工 <span>${pending.length}</span></h2>${pendingHtml}</section>` : ''}
    <section id="tools" class="toolbar"><div class="section-heading"><span>管理工具</span><h2>設定與補登</h2></div><form><label>月份<input type="month" name="month" value="${month}"></label><button>查詢</button></form>
    <form method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrfValue}"><label>標準上班時間<input type="time" name="shiftStart" value="${settings.shiftStart}" required></label><label>寬限分鐘<input type="number" name="lateGrace" value="${settings.lateGrace}" min="0" max="120" required></label><label>每日標準工時<input type="number" name="standardHours" value="${settings.standardHours}" min="1" max="24" step="0.5" required></label><button>儲存班別</button></form>
    <form method="post" action="/admin/attendance/add"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="month" value="${month}"><label>員工<select name="userId" required>${options}</select></label><label>類型<select name="type"><option value="clock_in">上班</option><option value="clock_out">下班</option></select></label><label>時間<input type="datetime-local" name="occurredAt" required></label><label>備註<input name="note" maxlength="100"></label><button>補登</button></form></section>
    <section class="operations"><article id="schedule"><h2>排班管理</h2><form method="post" action="/admin/schedule"><input type="hidden" name="csrf" value="${csrfValue}"><label>員工<select name="userId" required>${options}</select></label><label>日期<input type="date" name="workDate" required></label><label>上班<input type="time" name="startTime" value="${settings.shiftStart}" required></label><label>下班<input type="time" name="endTime" value="18:00" required></label><label>備註<input name="note" maxlength="100"></label><button>新增／更新</button></form><div class="table-wrap"><table><thead><tr><th>日期</th><th>員工</th><th>班別</th><th>備註</th><th></th></tr></thead><tbody>${scheduleRows || '<tr><td colspan="5">未來 30 天尚無排班</td></tr>'}</tbody></table></div></article>
    <article id="leave"><h2>請假審核</h2><div class="table-wrap"><table><thead><tr><th>日期</th><th>員工</th><th>原因</th><th>狀態</th><th></th></tr></thead><tbody>${leaveRows || '<tr><td colspan="5">尚無請假申請</td></tr>'}</tbody></table></div></article></section>
    <section id="employees" class="employee-filter"><div><span>員工紀錄</span><h2>工時與異常</h2></div><input id="employee-search" placeholder="搜尋員工姓名…" autocomplete="off"></section>
    <main class="cards">${cards || '<div class="empty">尚無員工資料，員工加入好友並傳送訊息後會自動出現。</div>'}</main>
    <script>document.getElementById('employee-search')?.addEventListener('input',function(){const q=this.value.trim().toLowerCase();document.querySelectorAll('.employee-card').forEach(card=>card.hidden=!card.dataset.name.includes(q))})</script>`));
});

function employeeCard(employee, settings) {
  const summary = summarize(employee.rows, settings);
  const records = employee.rows.map((r) => `<tr><td>${r.type === 'clock_in' ? '<span class="in">上班</span>' : '<span class="out">下班</span>'}<form id="edit-${r.id}" method="post" action="/admin/attendance/edit"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${r.id}"></form></td><td><input form="edit-${r.id}" type="datetime-local" name="occurredAt" value="${r.occurred_at.slice(0,16).replace(' ','T')}" required></td><td><input form="edit-${r.id}" name="note" value="${escapeHtml(r.note || '')}" maxlength="100"></td><td>${r.source === 'admin' ? '補登' : 'LINE'}</td><td><button form="edit-${r.id}">修改</button><form method="post" action="/admin/attendance/delete" onsubmit="return confirm('確定刪除？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${r.id}"><button class="danger">刪除</button></form></td></tr>`).join('');
  return `<article class="employee-card" data-name="${escapeHtml(employee.name.toLowerCase())}"><div class="employee"><div><h2>${escapeHtml(employee.name)}</h2><small>LINE：${escapeHtml(employee.display_name)}</small></div><div class="employee-actions"><form method="post" action="/admin/employee/name"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(employee.line_user_id)}"><input name="name" value="${escapeHtml(employee.custom_name || '')}" placeholder="公司使用姓名"><button>儲存姓名</button></form><form method="post" action="/admin/employee/approval" onsubmit="return confirm('確定停用此員工？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(employee.line_user_id)}"><button class="danger" name="approved" value="0">停用</button></form></div></div>
    <div class="stats five"><b>${summary.shifts}<small>出勤天數</small></b><b>${summary.hours.toFixed(2)}<small>總工時</small></b><b class="${summary.late ? 'warn' : ''}">${summary.late}<small>遲到次數</small></b><b>${summary.overtime.toFixed(2)}<small>加班時數</small></b><b class="${summary.incomplete ? 'warn' : ''}">${summary.incomplete}<small>未配對</small></b></div>
    <div class="table-wrap"><table><thead><tr><th>類型</th><th>時間</th><th>備註</th><th>來源</th><th></th></tr></thead><tbody>${records || '<tr><td colspan="5">本月無紀錄</td></tr>'}</tbody></table></div></article>`;
}

app.post('/admin/employee/name', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('UPDATE employees SET custom_name=? WHERE line_user_id=?').run(String(req.body.name || '').trim().slice(0, 50), req.body.userId);
  res.redirect(303, '/admin');
});
app.post('/admin/employee/approval', requireAdmin, requireCsrf, async (req, res) => {
  const userId = String(req.body.userId || '');
  if (req.body.approved === '1') {
    db.prepare('UPDATE employees SET approved=1 WHERE line_user_id=?').run(userId);
    try { await client.pushMessage({ to: userId, messages: [{ type: 'text', text: '✅ 管理員已核准你的員工身分。\n現在可以使用下方按鈕打卡。', quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '上班', text: '上班' } },
      { type: 'action', action: { type: 'message', label: '班表', text: '班表' } },
    ] } }] }); } catch (error) { console.error('核准通知發送失敗', error.message); }
  } else if (req.body.approved === '-1') {
    db.prepare('DELETE FROM employees WHERE line_user_id=? AND approved=0').run(userId);
  } else if (req.body.approved === '0') {
    db.prepare('UPDATE employees SET approved=0 WHERE line_user_id=?').run(userId);
  }
  res.redirect(303, '/admin');
});
app.post('/admin/settings', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{2}:\d{2}$/.test(req.body.shiftStart || '')) return res.status(400).send('上班時間格式錯誤');
  const lateGrace = Math.max(0, Math.min(120, Number(req.body.lateGrace)));
  const standardHours = Math.max(1, Math.min(24, Number(req.body.standardHours)));
  const save = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const transaction = db.transaction(() => {
    save.run('shift_start', req.body.shiftStart);
    save.run('late_grace_minutes', String(lateGrace));
    save.run('standard_hours', String(standardHours));
  });
  transaction();
  res.redirect(303, '/admin');
});
app.post('/admin/schedule', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.workDate || '') || !/^\d{2}:\d{2}$/.test(req.body.startTime || '') || !/^\d{2}:\d{2}$/.test(req.body.endTime || '')) return res.status(400).send('排班格式錯誤');
  db.prepare(`INSERT INTO schedules(line_user_id,work_date,start_time,end_time,note) VALUES (?,?,?,?,?)
    ON CONFLICT(line_user_id,work_date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,note=excluded.note`)
    .run(req.body.userId, req.body.workDate, req.body.startTime, req.body.endTime, String(req.body.note || '').slice(0, 100));
  res.redirect(303, '/admin');
});
app.post('/admin/schedule/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=?').run(Number(req.body.id));
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo.startsWith('/admin/schedules') ? returnTo : '/admin');
});
app.post('/admin/leave/status', requireAdmin, requireCsrf, async (req, res) => {
  if (!['approved', 'rejected'].includes(req.body.status)) return res.status(400).send('狀態錯誤');
  const leave = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(Number(req.body.id));
  if (leave) {
    db.prepare('UPDATE leave_requests SET status=? WHERE id=?').run(req.body.status, leave.id);
    const label = req.body.status === 'approved' ? '已核准 ✅' : '已駁回 ❌';
    try { await client.pushMessage({ to: leave.line_user_id, messages: [{ type: 'text', text: `你的請假申請${label}\n日期：${leave.leave_date}\n原因：${leave.reason}` }] }); } catch (error) { console.error('請假通知發送失敗', error.message); }
  }
  res.redirect(303, '/admin');
});
app.post('/admin/attendance/add', requireAdmin, requireCsrf, (req, res) => {
  if (!['clock_in', 'clock_out'].includes(req.body.type) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.occurredAt || '')) return res.status(400).send('資料格式錯誤');
  const occurredAt = `${req.body.occurredAt.replace('T', ' ')}:00`;
  db.prepare('INSERT INTO attendance(line_user_id,type,occurred_at,source,note) VALUES (?,?,?,?,?)').run(req.body.userId, req.body.type, occurredAt, 'admin', String(req.body.note || '').slice(0, 100));
  res.redirect(303, `/admin?month=${encodeURIComponent(req.body.month || monthPrefix())}`);
});
app.post('/admin/attendance/edit', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.occurredAt || '')) return res.status(400).send('時間格式錯誤');
  db.prepare('UPDATE attendance SET occurred_at=?,note=?,source=? WHERE id=?').run(`${req.body.occurredAt.replace('T', ' ')}:00`, String(req.body.note || '').slice(0, 100), 'admin', Number(req.body.id));
  res.redirect(303, '/admin');
});
app.post('/admin/attendance/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE id=?').run(Number(req.body.id));
  res.redirect(303, '/admin');
});
app.get('/admin/backup', requireAdmin, (_req, res) => {
  db.pragma('wal_checkpoint(PASSIVE)');
  res.download(path.join(dataDir, 'attendance.db'), `attendance-backup-${dayPrefix()}.db`);
});
app.get('/admin/export', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const rows = db.prepare(`SELECT COALESCE(NULLIF(e.custom_name,''),e.display_name) AS name,a.line_user_id,a.type,a.occurred_at,a.note
    FROM attendance a JOIN employees e USING(line_user_id) WHERE a.occurred_at LIKE ? ORDER BY name,a.occurred_at`).all(`${month}%`);
  const byName = new Map();
  for (const row of rows) { if (!byName.has(row.name)) byName.set(row.name, []); byName.get(row.name).push(row); }
  const settings = getSettings();
  const output = ['姓名,出勤天數,總工時,遲到次數,加班時數,未配對紀錄'];
  for (const [name, records] of byName) { const s = summarize(records, settings); output.push([name, s.shifts, s.hours.toFixed(2), s.late, s.overtime.toFixed(2), s.incomplete].map(csvCell).join(',')); }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  res.send('\ufeff' + output.join('\r\n'));
});

function summarize(rows, settings = getSettings()) {
  let open = null; let hours = 0; let overtime = 0; let late = 0; let incomplete = 0; const days = new Set();
  for (const row of rows) {
    if (row.type === 'clock_in') {
      if (open) incomplete += 1;
      open = row;
      const scheduled = row.line_user_id ? db.prepare('SELECT start_time FROM schedules WHERE line_user_id=? AND work_date=?').get(row.line_user_id, row.occurred_at.slice(0, 10)) : null;
      const threshold = toMillis(`${row.occurred_at.slice(0, 10)} ${scheduled?.start_time || settings.shiftStart}:00`) + settings.lateGrace * 60000;
      if (toMillis(row.occurred_at) > threshold) late += 1;
    }
    else if (open) { const duration = (toMillis(row.occurred_at) - toMillis(open.occurred_at)) / 3600000; if (duration >= 0 && duration <= 24) { hours += duration; overtime += Math.max(0, duration - settings.standardHours); days.add(open.occurred_at.slice(0, 10)); } else incomplete += 2; open = null; }
    else incomplete += 1;
  }
  if (open) incomplete += 1;
  return { shifts: days.size, hours, late, overtime, incomplete };
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function csvCell(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function page(title, body) {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>
  :root{font-family:Inter,"Noto Sans TC",system-ui;color:#18201d;background:#f2f5f3;scroll-behavior:smooth}*{box-sizing:border-box}body{margin:0}header{background:linear-gradient(135deg,#063d2d,#087f5b);color:white;padding:32px max(5vw,20px);display:flex;justify-content:space-between;align-items:center}h1,h2,h3,p{margin:0}header p{opacity:.75;margin-top:5px}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#06c755;text-decoration:none}header a{color:white}.section-nav{position:sticky;top:0;z-index:20;background:#ffffffed;backdrop-filter:blur(12px);padding:12px max(5vw,20px);box-shadow:0 3px 14px #133b2c10;overflow:auto;flex-wrap:nowrap}.section-nav a{color:#315046;background:#edf7f2;border-radius:999px;padding:8px 14px;white-space:nowrap}.today,.pending-box,.toolbar,.operations,.employee-filter,.cards{max-width:1100px;margin:22px auto;padding:0 18px}.today{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.today div{background:white;border-radius:16px;padding:20px;box-shadow:0 3px 18px #133b2c12;border:1px solid #e8efeb}.today b{display:block;font-size:30px;color:#087f5b}.today span{font-size:13px;color:#68766f}.pending-box{background:#fff7ed;border:1px solid #fed7aa;border-radius:16px;padding:18px}.pending-box h2 span{background:#c2410c;color:white;border-radius:20px;padding:2px 9px;font-size:14px}.pending-person{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:13px 0;border-top:1px solid #fed7aa}.pending-person:first-of-type{margin-top:12px}.pending-person small{display:block;color:#78716c}.section-heading span,.employee-filter span,.panel-title span{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#087f5b}.section-heading h2,.employee-filter h2,.panel-title h2{margin-top:3px}.toolbar,.operations{display:grid;gap:12px}.toolbar form,article,.login{background:white;padding:18px;border-radius:16px;box-shadow:0 3px 18px #133b2c12}form{display:flex;gap:10px;align-items:end;flex-wrap:wrap}label{display:grid;gap:5px;font-size:13px;color:#52615b}input,select,button{font:inherit;padding:9px 11px;border:1px solid #ccd5d1;border-radius:9px;background:white}input:focus,select:focus{outline:2px solid #a7dcc8;border-color:#087f5b}button{background:#087f5b;color:white;border:0;cursor:pointer}.operations article{padding:0;scroll-margin-top:75px}.operations h2,.operations>article>form{padding:18px}.employee-filter{display:flex;align-items:end;justify-content:space-between;gap:18px;scroll-margin-top:75px}.employee-filter input{min-width:260px}.cards{display:grid;gap:18px}article{padding:0;overflow:hidden;border:1px solid #e8efeb}.employee{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:20px}.employee small{color:#77827e}.employee-actions{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.stats{display:grid;background:#f6faf8;text-align:center}.stats.five{grid-template-columns:repeat(5,1fr)}.stats b{padding:15px;font-size:22px}.stats small{display:block;font-weight:400;font-size:12px;color:#68766f}.warn,.status-rejected{color:#c2410c}.status-approved{color:#087f5b}.status-pending{color:#a16207}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:11px 16px;border-top:1px solid #edf0ee;font-size:14px}th{color:#52615b;background:#fbfdfc}td:last-child{display:flex;gap:6px;align-items:center}.in{color:#087f5b}.out{color:#2563eb}.danger{background:#fff;color:#c2410c;border:1px solid #fed7aa;padding:6px 9px}.login{max-width:380px;margin:12vh auto}.login form{margin-top:20px;display:grid}.empty{text-align:center;padding:40px;color:#66736e}[hidden]{display:none!important}
  .schedule-page{max-width:1400px;margin:22px auto;padding:0 18px 50px}.schedule-toolbar{display:flex;justify-content:space-between;align-items:end;gap:14px;background:white;border:1px solid #e8efeb;border-radius:16px;padding:14px 18px;box-shadow:0 3px 18px #133b2c12}.schedule-tools{display:flex;gap:8px;align-items:center}.nav-button{background:#edf7f2;color:#087f5b;border-radius:9px;padding:10px 14px;white-space:nowrap}.secondary{background:#fff;color:#087f5b;border:1px solid #b9d9cc}.schedule-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.schedule-summary div{background:white;border:1px solid #e8efeb;border-radius:14px;padding:16px}.schedule-summary b{display:block;color:#087f5b;font-size:25px}.schedule-summary span{color:#68766f;font-size:12px}.schedule-controls{display:flex;justify-content:space-between;gap:12px;align-items:end;background:white;border:1px solid #e8efeb;border-radius:14px;padding:13px 16px;margin-bottom:12px}.week-grid{display:grid;grid-template-columns:repeat(7,minmax(165px,1fr));gap:10px;overflow:auto;padding-bottom:8px}.schedule-day{min-height:275px;padding:0;background:white}.schedule-day.is-today{border:2px solid #06c755}.schedule-day.understaffed{border-color:#f0b429}.day-head{display:flex;justify-content:space-between;align-items:center;padding:15px;background:#f6faf8;border-bottom:1px solid #e8efeb}.is-today .day-head{background:#eaf9f1}.day-head span{font-size:12px;color:#68766f}.day-head h3{margin-top:3px}.day-head>b{color:#087f5b;font-size:22px}.day-head small{font-size:11px;margin-left:2px}.staff-warning{background:#fff7db;color:#8a5d00;padding:6px 10px;text-align:center;font-size:12px}.day-shifts{padding:8px}.shift-row{display:flex;justify-content:space-between;gap:5px;border-bottom:1px solid #edf0ee;padding:10px 4px}.shift-row>div{min-width:0}.shift-row b,.shift-row span{display:block}.shift-row span{color:#66736e;font-size:12px;margin-top:3px}.shift-row em{display:inline-block;color:#b42318;background:#fff0ed;border-radius:99px;font-size:11px;font-style:normal;padding:2px 7px;margin-top:5px}.shift-row.conflict{background:#fff8f6}.shift-row form{align-self:start}.icon-danger{padding:0;background:transparent;color:#b42318;font-size:22px;line-height:1}.no-shift{padding:20px 4px;color:#929c98;font-size:13px;text-align:center}.leave-only{color:#9a6700;background:#fff8db;border-radius:7px;padding:7px;margin:5px 0;font-size:12px}.workload{background:white;border:1px solid #e8efeb;border-radius:16px;margin-top:18px;overflow:hidden}.workload .panel-title{padding:18px}.schedule-actions{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-top:18px}.schedule-actions article{padding:20px}.schedule-actions .muted{color:#66736e;line-height:1.6;margin:12px 0 18px}.bulk-form{display:grid;margin-top:18px}.bulk-form fieldset{border:1px solid #dde6e2;border-radius:12px;padding:14px;min-width:0}.bulk-form legend{font-weight:700;padding:0 7px}.people-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.check-person{display:flex;align-items:center;border:1px solid #e2e8e5;border-radius:9px;padding:9px;background:#fbfdfc}.check-person input,.weekday-checks input,.skip-leave input{accent-color:#087f5b}.form-row,.weekday-checks{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.weekday-checks{margin-top:12px}.weekday-checks label,.skip-leave{display:flex;align-items:center;gap:4px}.skip-leave{margin-top:12px;color:#315046}.grow{flex:1}.grow input{width:100%}.primary-wide{width:100%;padding:12px;font-weight:700}
  @media(max-width:900px){.week-grid{grid-template-columns:repeat(7,190px)}.schedule-actions{grid-template-columns:1fr}.people-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){header{align-items:flex-start;gap:15px;flex-direction:column}.employee,.pending-person,.employee-filter{align-items:flex-start;flex-direction:column}.employee-filter input{width:100%;min-width:0}.stats.five{grid-template-columns:repeat(2,1fr)}.stats b{font-size:18px}.today{grid-template-columns:1fr 1fr 1fr;padding:0 12px}.today div{padding:14px}.today b{font-size:22px}.today span{font-size:11px}.schedule-toolbar,.schedule-controls{align-items:stretch;flex-direction:column}.schedule-toolbar .nav-button{text-align:center}.schedule-tools{display:grid;grid-template-columns:1fr 1fr 1fr}.schedule-summary{grid-template-columns:1fr 1fr}.people-grid{grid-template-columns:1fr}.form-row>label{width:100%}.form-row input{width:100%}}@media print{header,.schedule-toolbar,.schedule-controls,.schedule-actions,.icon-danger{display:none!important}.schedule-page{max-width:none;margin:0;padding:0}.week-grid{grid-template-columns:repeat(7,1fr);overflow:visible}.schedule-day{min-height:240px;box-shadow:none}.workload{break-before:page}.shift-row{font-size:10px}}
  </style>${body}</html>`;
}

app.listen(port, () => console.log(`LINE 打卡系統已啟動：http://localhost:${port}`));
