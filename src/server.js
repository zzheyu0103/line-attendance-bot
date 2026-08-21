require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const line = require('@line/bot-sdk');
const ExcelJS = require('exceljs');
const { taipeiDate, toMillis, addDays, distanceMeters, shiftHours } = require('./utils');

const required = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'ADMIN_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少環境變數：${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const reportDir = path.resolve(process.env.REPORT_DIR || path.join(dataDir, 'reports'));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });
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
    ('minimum_daily_staff','1'),
    ('break_minutes','60'),
    ('weekday_overtime_multiplier','1.34'),
    ('holiday_overtime_multiplier','1.67'),
    ('gps_required','0'),
    ('office_latitude',''),
    ('office_longitude',''),
    ('office_radius_meters','200'),
    ('supervisor_line_ids',''),
    ('location_retention_days','90'),
    ('privacy_contact','');
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
  CREATE TABLE IF NOT EXISTS shift_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  INSERT OR IGNORE INTO shift_templates(name,start_time,end_time,note) VALUES
    ('早班','09:00','18:00',''),
    ('晚班','13:00','22:00',''),
    ('半日班','09:00','13:00','');
  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    leave_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(line_user_id) REFERENCES employees(line_user_id)
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
  CREATE TABLE IF NOT EXISTS pending_location_clock (
    line_user_id TEXT PRIMARY KEY,
    clock_type TEXT NOT NULL CHECK(clock_type IN ('clock_in','clock_out')),
    requested_at TEXT NOT NULL,
    FOREIGN KEY(line_user_id) REFERENCES employees(line_user_id)
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    username TEXT PRIMARY KEY,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_log (
    notification_key TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_meters INTEGER NOT NULL DEFAULT 200,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS holidays (
    work_date TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1.67
  );
`);
for (const sql of [
  'ALTER TABLE employees ADD COLUMN custom_name TEXT',
  "ALTER TABLE employees ADD COLUMN employee_no TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE employees ADD COLUMN department TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE employees ADD COLUMN hire_date TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE employees ADD COLUMN termination_date TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE employees ADD COLUMN salary_type TEXT NOT NULL DEFAULT 'hourly'",
  'ALTER TABLE employees ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0',
  'ALTER TABLE employees ADD COLUMN monthly_salary REAL NOT NULL DEFAULT 0',
  "ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'line'",
  "ALTER TABLE attendance ADD COLUMN note TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE attendance ADD COLUMN latitude REAL',
  'ALTER TABLE attendance ADD COLUMN longitude REAL',
  'ALTER TABLE attendance ADD COLUMN distance_meters REAL',
  "ALTER TABLE attendance ADD COLUMN location_status TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE attendance ADD COLUMN work_location_id INTEGER',
  "ALTER TABLE attendance ADD COLUMN work_location_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE employees ADD COLUMN gps_consent_at TEXT NOT NULL DEFAULT ''",
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
const dayPrefix = () => taipeiDate().slice(0, 10);
const monthPrefix = () => taipeiDate().slice(0, 7);
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
  return { shiftStart: values.shift_start || '09:00', lateGrace: Number(values.late_grace_minutes || 5), standardHours: Number(values.standard_hours || 8), minimumStaff: Number(values.minimum_daily_staff || 1), breakMinutes: Number(values.break_minutes || 60), weekdayOvertimeMultiplier: Number(values.weekday_overtime_multiplier || 1.34), holidayOvertimeMultiplier: Number(values.holiday_overtime_multiplier || 1.67), gpsRequired: values.gps_required === '1', officeLatitude: Number(values.office_latitude), officeLongitude: Number(values.office_longitude), officeRadius: Number(values.office_radius_meters || 200), supervisorLineIds: String(values.supervisor_line_ids || '').split(',').map((value) => value.trim()).filter(Boolean), locationRetentionDays: Math.max(1, Number(values.location_retention_days || 90)), privacyContact: String(values.privacy_contact || '') };
}

function activeLocations() {
  const rows = db.prepare('SELECT * FROM work_locations WHERE active=1 ORDER BY name').all();
  if (rows.length) return rows;
  const settings = getSettings();
  return settings.officeLatitude && settings.officeLongitude ? [{ id: null, name: '主要公司據點', latitude: settings.officeLatitude, longitude: settings.officeLongitude, radius_meters: settings.officeRadius }] : [];
}

function nearestLocation(latitude, longitude) {
  return activeLocations().map((location) => ({ ...location, distance: distanceMeters(latitude, longitude, location.latitude, location.longitude) })).sort((a, b) => a.distance - b.distance)[0];
}

function audit(action, targetType, targetId, details = '', actor = 'system') {
  db.prepare('INSERT INTO audit_logs(actor,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?)')
    .run(actor, action, targetType, String(targetId || ''), String(details || '').slice(0, 1000), taipeiDate());
}

async function createDatabaseBackup(label = 'auto') {
  const stamp = taipeiDate().replace(/[-: ]/g, '').slice(0, 14);
  const filename = `attendance-${label}-${stamp}.db`;
  await db.backup(path.join(backupDir, filename));
  const retentionDays = Math.max(7, Number(process.env.BACKUP_RETENTION_DAYS || 30));
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const item of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!item.isFile() || !/^attendance-[a-z]+-\d{14}\.db$/.test(item.name)) continue;
    const fullPath = path.join(backupDir, item.name);
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
  return filename;
}

function scheduleDailyBackup() {
  let lastBackupDay = '';
  const check = async () => {
    const now = taipeiDate();
    const day = now.slice(0, 10);
    if (now.slice(11, 16) < '03:00' || lastBackupDay === day) return;
    const todayBackup = fs.readdirSync(backupDir).some((name) => name.startsWith(`attendance-auto-${day.replace(/-/g, '')}`));
    if (todayBackup) { lastBackupDay = day; return; }
    try { await createDatabaseBackup('auto'); lastBackupDay = day; }
    catch (error) { console.error('每日備份失敗', error.message); }
  };
  check();
  setInterval(check, 15 * 60000).unref();
}

function previousMonth() {
  const [year, month] = monthPrefix().split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 15));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function pushSupervisors(text) {
  const ids = getSettings().supervisorLineIds;
  for (const userId of ids) {
    try { await lineCall(() => client.pushMessage({ to: userId, messages: [{ type: 'text', text }] })); }
    catch (error) { console.error('主管通知失敗', error.message); }
  }
}

function detectAnomalies(now = taipeiDate()) {
  const today = now.slice(0, 10);
  const settings = getSettings();
  const employees = db.prepare(`SELECT line_user_id,COALESCE(NULLIF(custom_name,''),display_name) name FROM employees WHERE approved=1`).all();
  const issues = [];
  for (const employee of employees) {
    const latest = db.prepare('SELECT type,occurred_at FROM attendance WHERE line_user_id=? ORDER BY occurred_at DESC,id DESC LIMIT 1').get(employee.line_user_id);
    if (latest?.type === 'clock_in') {
      const openHours = (toMillis(now) - toMillis(latest.occurred_at)) / 3600000;
      if (openHours >= 12) issues.push({ key: `open:${employee.line_user_id}:${latest.occurred_at}`, level: openHours > 24 ? 'high' : 'medium', name: employee.name, title: openHours > 24 ? '上班超過 24 小時' : '疑似忘記下班', detail: `自 ${latest.occurred_at} 起已 ${openHours.toFixed(1)} 小時` });
    }
    const shift = db.prepare('SELECT start_time,end_time FROM schedules WHERE line_user_id=? AND work_date=?').get(employee.line_user_id, today);
    const clockIn = db.prepare("SELECT occurred_at FROM attendance WHERE line_user_id=? AND type='clock_in' AND occurred_at LIKE ? ORDER BY occurred_at LIMIT 1").get(employee.line_user_id, `${today}%`);
    if (shift && !clockIn && toMillis(now) > toMillis(`${today} ${shift.start_time}:00`) + settings.lateGrace * 60000) issues.push({ key: `missing:${employee.line_user_id}:${today}`, level: 'high', name: employee.name, title: '未依排班上班', detail: `今日排班 ${shift.start_time}–${shift.end_time}，目前尚無上班打卡` });
    const recent = db.prepare('SELECT id,type,occurred_at FROM attendance WHERE line_user_id=? ORDER BY occurred_at DESC,id DESC LIMIT 2').all(employee.line_user_id);
    if (recent.length === 2 && recent[0].type === recent[1].type) issues.push({ key: `duplicate:${employee.line_user_id}:${recent[0].id}`, level: 'medium', name: employee.name, title: '連續相同打卡', detail: `${recent[1].occurred_at}、${recent[0].occurred_at} 皆為${recent[0].type === 'clock_in' ? '上班' : '下班'}` });
  }
  return issues;
}

function scheduleOperations() {
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const now = taipeiDate();
      if (now.slice(8, 10) === '01' && now.slice(11, 16) >= '04:00') {
        const month = previousMonth();
        const reportPath = path.join(reportDir, `payroll-${month}.xlsx`);
        const key = `monthly-report:${month}`;
        if (!fs.existsSync(reportPath)) await createPayrollWorkbook(month);
        if (!db.prepare('SELECT 1 FROM notification_log WHERE notification_key=?').get(key)) {
          await pushSupervisors(`📊 ${month} 薪資報表已產生，請登入後台「自動報表」下載。`);
          db.prepare('INSERT OR IGNORE INTO notification_log(notification_key,sent_at) VALUES (?,?)').run(key, now);
        }
      }
      for (const issue of detectAnomalies(now)) {
        if (db.prepare('SELECT 1 FROM notification_log WHERE notification_key=?').get(issue.key)) continue;
        await pushSupervisors(`⚠️ 出勤異常｜${issue.title}\n${issue.name}\n${issue.detail}`);
        db.prepare('INSERT OR IGNORE INTO notification_log(notification_key,sent_at) VALUES (?,?)').run(issue.key, now);
      }
      const cutoff = addDays(now.slice(0, 10), -getSettings().locationRetentionDays);
      db.prepare("UPDATE attendance SET latitude=NULL,longitude=NULL,distance_meters=NULL,location_status='expired' WHERE occurred_at<? AND latitude IS NOT NULL").run(`${cutoff} 00:00:00`);
    } catch (error) { console.error('排程工作失敗', error.message); }
    finally { running = false; }
  };
  check();
  setInterval(check, 15 * 60000).unref();
}

function payrollFor(employee, records, settings = getSettings()) {
  const summary = summarize(records, settings);
  const hourlyRate = employee.salary_type === 'monthly' ? Number(employee.monthly_salary || 0) / 240 : Number(employee.hourly_rate || 0);
  const regularPay = employee.salary_type === 'monthly' ? Number(employee.monthly_salary || 0) : summary.regularHours * hourlyRate;
  const weekdayOvertimePay = summary.weekdayOvertimeHours * hourlyRate * settings.weekdayOvertimeMultiplier;
  const holidayPay = summary.holidayPayUnits * hourlyRate;
  return { ...summary, hourlyRate, regularPay, weekdayOvertimePay, holidayPay, totalPay: regularPay + weekdayOvertimePay + holidayPay };
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
  return db.prepare('SELECT COALESCE(NULLIF(custom_name,\'\'), display_name) AS name,approved,gps_consent_at FROM employees WHERE line_user_id=?').get(userId);
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

function requestLocation(replyToken, text) {
  return lineCall(() => client.replyMessage({ replyToken, messages: [{ type: 'text', text, quickReply: { items: [
    { type: 'action', action: { type: 'location', label: '分享目前位置' } },
    { type: 'action', action: { type: 'message', label: '取消', text: '取消定位' } },
  ] } }] }));
}

async function handleMessage(event) {
  if (event.type !== 'message' || !event.source.userId) return;
  const userId = event.source.userId;
  const employee = await ensureEmployee(userId);
  const name = employee.name;
  if (!employee.approved) return replyText(event.replyToken, `👋 ${name}，你的員工申請已建立。\n請等待管理員在後台核准後再使用打卡功能。`);
  const last = lastRecord(userId);

  if (event.message.type === 'location') {
    const pending = db.prepare('SELECT * FROM pending_location_clock WHERE line_user_id=?').get(userId);
    if (!pending || (toMillis(taipeiDate()) - toMillis(pending.requested_at)) > 10 * 60000) {
      db.prepare('DELETE FROM pending_location_clock WHERE line_user_id=?').run(userId);
      return replyText(event.replyToken, '這筆定位沒有對應的打卡請求，請先按「上班」或「下班」再分享位置。');
    }
    const latitude = Number(event.message.latitude);
    const longitude = Number(event.message.longitude);
    const location = nearestLocation(latitude, longitude);
    if (!location) return replyText(event.replyToken, '管理員尚未設定可用的 GPS 打卡據點。');
    if (location.distance > location.radius_meters) {
      audit('定位打卡遭拒', 'employee', userId, `最近據點=${location.name}；距離=${Math.round(location.distance)}m`, `LINE:${userId}`);
      return replyText(event.replyToken, `❌ 定位打卡失敗\n最近據點「${location.name}」距離約 ${Math.round(location.distance)} 公尺，允許範圍為 ${location.radius_meters} 公尺。`);
    }
    if (pending.clock_type === 'clock_in' && last?.type === 'clock_in') return replyText(event.replyToken, `${name}，你已有尚未下班的紀錄。`);
    if (pending.clock_type === 'clock_out' && (!last || last.type !== 'clock_in')) return replyText(event.replyToken, `${name}，目前沒有尚未完成的上班紀錄。`);
    const now = taipeiDate();
    db.prepare(`INSERT INTO attendance(line_user_id,type,occurred_at,source,note,latitude,longitude,distance_meters,location_status,work_location_id,work_location_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(userId, pending.clock_type, now, 'line_gps', event.message.address || '', latitude, longitude, location.distance, 'inside', location.id, location.name);
    db.prepare('DELETE FROM pending_location_clock WHERE line_user_id=?').run(userId);
    audit('GPS定位打卡', 'attendance', userId, `${pending.clock_type}；據點=${location.name}；距離=${Math.round(location.distance)}m`, `LINE:${userId}`);
    const label = pending.clock_type === 'clock_in' ? '上班' : '下班';
    return replyText(event.replyToken, `✅ ${name} ${label}定位打卡成功\n${now}\n據點：${location.name}（約 ${Math.round(location.distance)} 公尺）`);
  }

  if (event.message.type !== 'text') return;
  const rawCommand = event.message.text.trim();
  const command = rawCommand.replace(/\s+/g, '');
  if (command === '隱私權') return replyText(event.replyToken, '定位只用於確認打卡據點，保存期限由公司設定。輸入「同意定位」後才會啟用 GPS 打卡；可向管理員要求撤回或刪除定位資料。');
  if (command === '同意定位') {
    db.prepare('UPDATE employees SET gps_consent_at=? WHERE line_user_id=?').run(taipeiDate(), userId);
    audit('同意GPS定位', 'employee', userId, '', `LINE:${userId}`);
    return replyText(event.replyToken, '✅ 已記錄你的定位使用同意。定位只會在你主動分享位置完成打卡時取得。');
  }
  if (command === '取消定位') {
    db.prepare('DELETE FROM pending_location_clock WHERE line_user_id=?').run(userId);
    return replyText(event.replyToken, '已取消這次定位打卡。');
  }

  if (['上班', '打卡上班', '定位上班', '下班', '打卡下班', '定位下班'].includes(command) && (getSettings().gpsRequired || command.startsWith('定位'))) {
    if (!employee.gps_consent_at) return replyText(event.replyToken, '首次使用 GPS 打卡前，請先閱讀隱私說明並輸入「同意定位」。\n輸入「隱私權」可再次查看說明。');
    const clockType = command.includes('下班') ? 'clock_out' : 'clock_in';
    if (clockType === 'clock_in' && last?.type === 'clock_in') return replyText(event.replyToken, `${name}，你還有一筆尚未下班的紀錄：\n${last.occurred_at}`);
    if (clockType === 'clock_out' && (!last || last.type !== 'clock_in')) return replyText(event.replyToken, `${name}，目前沒有尚未完成的上班紀錄。`);
    db.prepare(`INSERT INTO pending_location_clock(line_user_id,clock_type,requested_at) VALUES (?,?,?)
      ON CONFLICT(line_user_id) DO UPDATE SET clock_type=excluded.clock_type,requested_at=excluded.requested_at`).run(userId, clockType, taipeiDate());
    return requestLocation(event.replyToken, `📍 ${name}，請按下方「分享目前位置」完成${clockType === 'clock_in' ? '上班' : '下班'}打卡。\n定位請求 10 分鐘內有效。`);
  }

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
const csrfValue = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update('csrf').digest('hex');
const sessionSecret = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update('line-attendance-session-v2').digest();
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }));
}
function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 64).toString('hex'); }
function safeEqualText(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authorized(req) {
  const token = cookies(req).attendance_admin;
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  if (!safeEqualText(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.exp < Date.now()) return null;
    if (session.username === 'owner') return session;
    const account = db.prepare('SELECT username,role,active FROM admin_users WHERE username=?').get(session.username);
    return account?.active ? { ...session, role: account.role } : null;
  } catch (_) { return null; }
}
function requireAdmin(req, res, next) { const admin = authorized(req); if (!admin) return res.redirect('/admin/login'); req.admin = admin; next(); }
function requireOwner(req, res, next) { return req.admin?.role === 'owner' ? next() : res.status(403).send('只有系統擁有者可以執行此操作。'); }
function requireCsrf(req, res, next) {
  if (req.body?.csrf !== csrfValue) return res.status(403).send('表單已失效，請重新整理。');
  if (req.admin?.role === 'viewer') return res.status(403).send('唯讀帳號不能修改資料。');
  next();
}
function setSession(res, username = 'owner', role = 'owner') {
  const payload = Buffer.from(JSON.stringify({ username, role, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  res.setHeader('Set-Cookie', `attendance_admin=${payload}.${signature}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
}

app.get('/admin/login', (_req, res) => res.send(page('管理員登入', `<main class="login"><h1>管理員登入</h1><form method="post"><label>帳號<input name="username" value="owner" maxlength="40" required autofocus></label><label>密碼<input name="password" type="password" required></label><button>登入</button></form></main>`)));
app.post('/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  let role = '';
  if (username === 'owner' && safeEqualText(password, process.env.ADMIN_PASSWORD)) role = 'owner';
  else {
    const account = db.prepare('SELECT * FROM admin_users WHERE username=? AND active=1').get(username);
    if (account && safeEqualText(hashPassword(password, account.password_salt), account.password_hash)) role = account.role;
  }
  if (!role) return res.status(401).send(page('登入失敗', '<main class="login"><h1>帳號或密碼錯誤</h1><a href="/admin/login">重試</a></main>'));
  setSession(res, username, role);
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
  const templates = db.prepare('SELECT * FROM shift_templates ORDER BY start_time,name').all();
  const templateOptions = templates.map((template) => `<option value="${template.id}" data-start="${template.start_time}" data-end="${template.end_time}" data-note="${escapeHtml(template.note)}">${escapeHtml(template.name)}（${template.start_time}–${template.end_time}）</option>`).join('');
  const templateCards = templates.map((template) => `<div class="template-card"><div><b>${escapeHtml(template.name)}</b><span>${template.start_time}–${template.end_time}${template.note ? ` · ${escapeHtml(template.note)}` : ''}</span></div><form method="post" action="/admin/schedules/template/delete" onsubmit="return confirm('刪除此班別模板？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${template.id}"><input type="hidden" name="week" value="${week}"><button class="icon-danger">×</button></form></div>`).join('');
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
    <section class="schedule-actions"><article><div class="panel-title"><span>批次建立</span><h2>一次安排多人班表</h2></div><form class="bulk-form" method="post" action="/admin/schedules/bulk"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><fieldset><legend>選擇員工</legend><div class="people-grid">${employeeChecks || '<p>目前沒有已核准員工</p>'}</div></fieldset><fieldset><legend>日期與星期</legend><div class="form-row"><label>開始日期<input type="date" name="fromDate" value="${dates[0]}" required></label><label>結束日期<input type="date" name="toDate" value="${dates[6]}" required></label></div><div class="weekday-checks">${weekdayChecks}</div><label class="skip-leave"><input type="checkbox" name="skipLeave" value="1" checked>自動略過已核准請假的員工</label></fieldset><fieldset><legend>班別內容</legend><label>快速套用模板<select id="template-select"><option value="">自訂班別</option>${templateOptions}</select></label><div class="form-row"><label>上班<input id="bulk-start" type="time" name="startTime" value="${settings.shiftStart}" required></label><label>下班<input id="bulk-end" type="time" name="endTime" value="18:00" required></label><label class="grow">備註<input id="bulk-note" name="note" maxlength="100" placeholder="例如：早班、門市支援"></label></div></fieldset><button class="primary-wide">建立／覆蓋所選班表</button></form></article>
    <article><div class="panel-title"><span>快速套用</span><h2>複製前一週班表</h2></div><p class="muted">把 ${addDays(week, -7)} ～ ${addDays(week, -1)} 的班表複製到本週；同一員工同一天已有班表時會更新。</p><form method="post" action="/admin/schedules/copy-week" onsubmit="return confirm('確定複製前一週班表到本週？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><button>複製前一週</button></form><div class="template-manager"><div class="panel-title"><span>Shift templates</span><h2>輪班模板</h2></div><div class="template-list">${templateCards}</div><form class="template-form" method="post" action="/admin/schedules/template"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="week" value="${week}"><label>名稱<input name="name" maxlength="30" placeholder="例如：中班" required></label><label>上班<input type="time" name="startTime" required></label><label>下班<input type="time" name="endTime" required></label><label>備註<input name="note" maxlength="100"></label><button>新增／更新模板</button></form></div></article></section></main><script>document.getElementById('schedule-filter')?.addEventListener('change',function(){const id=this.value;document.querySelectorAll('.shift-row').forEach(row=>row.hidden=!!id&&row.dataset.user!==id);document.querySelectorAll('[data-workload-user]').forEach(row=>row.hidden=!!id&&row.dataset.workloadUser!==id)});document.getElementById('template-select')?.addEventListener('change',function(){const option=this.options[this.selectedIndex];if(!this.value)return;document.getElementById('bulk-start').value=option.dataset.start;document.getElementById('bulk-end').value=option.dataset.end;document.getElementById('bulk-note').value=option.dataset.note||''})</script>`));
});

function formValues(value) { return Array.isArray(value) ? value : value ? [value] : []; }
app.post('/admin/schedules/template', requireAdmin, requireCsrf, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name || !/^\d{2}:\d{2}$/.test(req.body.startTime || '') || !/^\d{2}:\d{2}$/.test(req.body.endTime || '')) return res.status(400).send('班別模板格式錯誤');
  db.prepare(`INSERT INTO shift_templates(name,start_time,end_time,note) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,note=excluded.note`)
    .run(name, req.body.startTime, req.body.endTime, String(req.body.note || '').slice(0, 100));
  audit('新增或更新輪班模板', 'shift_template', name, `${req.body.startTime}-${req.body.endTime}`, req.admin.username);
  res.redirect(303, `/admin/schedules?week=${mondayOf(req.body.week)}`);
});

app.post('/admin/schedules/template/delete', requireAdmin, requireCsrf, (req, res) => {
  const template = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(Number(req.body.id));
  db.prepare('DELETE FROM shift_templates WHERE id=?').run(Number(req.body.id));
  if (template) audit('刪除輪班模板', 'shift_template', template.id, JSON.stringify(template), req.admin.username);
  res.redirect(303, `/admin/schedules?week=${mondayOf(req.body.week)}`);
});

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
  audit('批次建立班表', 'schedule', `${fromDate}~${toDate}`, `員工=${userIds.length}；星期=${[...weekdays].join(',')}`, req.admin.username);
  res.redirect(303, `/admin/schedules?week=${week}`);
});

app.post('/admin/schedules/settings', requireAdmin, requireCsrf, (req, res) => {
  const minimumStaff = Math.max(0, Math.min(99, Number(req.body.minimumStaff) || 0));
  db.prepare(`INSERT INTO settings(key,value) VALUES ('minimum_daily_staff',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(minimumStaff));
  audit('修改最低人力', 'settings', 'minimum_daily_staff', String(minimumStaff), req.admin.username);
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
  audit('複製整週班表', 'schedule', targetWeek, `來源=${sourceWeek}；${source.length} 筆`, req.admin.username);
  res.redirect(303, `/admin/schedules?week=${targetWeek}`);
});

app.get('/admin/audit', requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all();
  const rows = logs.map((log) => `<tr><td>${escapeHtml(log.created_at)}</td><td>${escapeHtml(log.actor)}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.target_type)} #${escapeHtml(log.target_id)}</td><td class="audit-details">${escapeHtml(log.details)}</td></tr>`).join('');
  res.send(page('稽核紀錄', `<header><div><h1>稽核紀錄</h1><p>保留最近 300 筆後台變更</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/anomalies">異常中心</a></nav></header><main class="standalone"><article><div class="panel-title"><span>Audit trail</span><h2>資料修改歷程</h2></div><div class="table-wrap"><table><thead><tr><th>時間</th><th>操作者</th><th>動作</th><th>對象</th><th>修改前內容／說明</th></tr></thead><tbody>${rows || '<tr><td colspan="5">尚無修改紀錄</td></tr>'}</tbody></table></div></article></main>`));
});

app.get('/admin/anomalies', requireAdmin, (req, res) => {
  const now = taipeiDate();
  const issues = detectAnomalies(now);
  const issueHtml = issues.map((issue) => `<article class="issue ${issue.level}"><div><span>${issue.level === 'high' ? '需立即處理' : '請確認'}</span><h2>${escapeHtml(issue.title)}</h2></div><b>${escapeHtml(issue.name)}</b><p>${escapeHtml(issue.detail)}</p></article>`).join('');
  res.send(page('出勤異常中心', `<header><div><h1>異常中心</h1><p>${now} 即時檢查</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/audit">稽核紀錄</a></nav></header><main class="standalone"><section class="issue-summary"><b>${issues.length}</b><span>目前需確認項目</span></section><section class="issue-list">${issueHtml || '<div class="all-clear">✓ 目前沒有偵測到異常</div>'}</section></main>`));
});

function payrollRows(month) {
  const employees = db.prepare(`SELECT *,COALESCE(NULLIF(custom_name,''),display_name) name FROM employees WHERE approved=1 ORDER BY department,name`).all();
  const attendance = db.prepare('SELECT * FROM attendance WHERE occurred_at LIKE ? ORDER BY line_user_id,occurred_at,id').all(`${month}%`);
  const settings = getSettings();
  return employees.map((employee) => ({ employee, payroll: payrollFor(employee, attendance.filter((row) => row.line_user_id === employee.line_user_id), settings) }));
}

async function createPayrollWorkbook(month) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LINE 出勤管理系統';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(`${month} 薪資`, { views: [{ state: 'frozen', ySplit: 3 }] });
  sheet.mergeCells('A1:N1');
  sheet.getCell('A1').value = `${month} 薪資與出勤報表`;
  sheet.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F5B' } };
  sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 30;
  sheet.addRow([]);
  const headers = ['員工編號', '姓名', '部門', '薪資制', '出勤天數', '正常工時', '平日加班', '假日工時', '遲到', '早退', '未配對', '本薪／正常薪資', '加班與假日薪資', '預估總薪資'];
  sheet.addRow(headers);
  const rows = payrollRows(month);
  rows.forEach(({ employee, payroll }, index) => {
    const excelRow = index + 4;
    sheet.addRow([employee.employee_no, employee.name, employee.department, employee.salary_type === 'monthly' ? '月薪' : '時薪', payroll.shifts, payroll.regularHours, payroll.weekdayOvertimeHours, payroll.holidayHours, payroll.late, payroll.early, payroll.incomplete, payroll.regularPay, payroll.weekdayOvertimePay + payroll.holidayPay, { formula: `L${excelRow}+M${excelRow}` }]);
  });
  const totalRow = rows.length + 4;
  const totalCell = (column) => rows.length ? { formula: `SUM(${column}4:${column}${totalRow - 1})` } : 0;
  sheet.addRow(['', '合計', '', '', ...['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].map(totalCell)]);
  sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315046' } };
  sheet.getRow(totalRow).font = { bold: true };
  sheet.getRow(totalRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF9F1' } };
  sheet.columns = [{ width: 14 }, { width: 16 }, { width: 15 }, { width: 10 }, { width: 11 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 9 }, { width: 10 }, { width: 17 }, { width: 19 }, { width: 17 }];
  sheet.getColumn(1).numFmt = '@';
  ['F', 'G', 'H'].forEach((column) => { sheet.getColumn(column).numFmt = '0.00'; });
  ['L', 'M', 'N'].forEach((column) => { sheet.getColumn(column).numFmt = '[$NT$-zh-TW]#,##0'; });
  sheet.autoFilter = { from: 'A3', to: 'N3' };
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.alignment = { vertical: 'middle', horizontal: rowNumber <= 3 ? 'center' : 'left' };
    row.eachCell((cell) => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8E5' } } }; });
  });
  const rules = workbook.addWorksheet('計算規則');
  const settings = getSettings();
  rules.addRows([['項目', '設定值'], ['每日標準工時', settings.standardHours], ['休息分鐘', settings.breakMinutes], ['平日加班倍率', settings.weekdayOvertimeMultiplier], ['假日倍率', settings.holidayOvertimeMultiplier], ['產生時間', taipeiDate()], ['說明', '本報表為預估結果，正式發薪前請確認異常與未配對紀錄。']]);
  rules.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rules.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F5B' } };
  rules.columns = [{ width: 24 }, { width: 60 }];
  const filename = `payroll-${month}.xlsx`;
  const target = path.join(reportDir, filename);
  await workbook.xlsx.writeFile(target);
  return { filename, target };
}

app.get('/admin/payroll', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const rows = payrollRows(month);
  const totalHours = rows.reduce((sum, row) => sum + row.payroll.hours, 0);
  const totalPay = rows.reduce((sum, row) => sum + row.payroll.totalPay, 0);
  const tableRows = rows.map(({ employee, payroll }) => `<tr><td><b>${escapeHtml(employee.name)}</b><small>${escapeHtml(employee.employee_no || '未設定編號')} · ${escapeHtml(employee.department || '未設定部門')}</small></td><td>${employee.salary_type === 'monthly' ? '月薪' : '時薪'}</td><td>${payroll.regularHours.toFixed(2)}</td><td>${payroll.weekdayOvertimeHours.toFixed(2)}</td><td>${payroll.holidayHours.toFixed(2)}</td><td>${payroll.late}</td><td>${payroll.early}</td><td>$${Math.round(payroll.totalPay).toLocaleString('zh-TW')}</td></tr>`).join('');
  res.send(page('薪資中心', `<header><div><h1>薪資中心</h1><p>${month} 預估薪資</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/payroll/export?month=${month}">匯出 CSV</a><a href="/admin/payroll/excel?month=${month}">下載 Excel</a><a href="/admin/reports">自動報表</a><a href="/admin/holidays">假日設定</a></nav></header><main class="standalone payroll-page"><section class="payroll-toolbar"><form method="get"><label>薪資月份<input type="month" name="month" value="${month}"></label><button>查詢</button></form><button class="secondary" onclick="window.print()">列印薪資表</button></section><section class="schedule-summary"><div><b>${rows.length}</b><span>計薪員工</span></div><div><b>${totalHours.toFixed(1)}</b><span>總計薪工時</span></div><div><b>$${Math.round(totalPay).toLocaleString('zh-TW')}</b><span>預估薪資總額</span></div><div><b>${rows.reduce((sum, row) => sum + row.payroll.incomplete, 0)}</b><span>未配對紀錄</span></div></section><article><div class="table-wrap"><table class="payroll-table"><thead><tr><th>員工</th><th>薪資制</th><th>正常工時</th><th>平日加班</th><th>假日工時</th><th>遲到</th><th>早退</th><th>預估薪資</th></tr></thead><tbody>${tableRows || '<tr><td colspan="8">本月尚無員工資料</td></tr>'}</tbody></table></div></article><p class="payroll-note">預估金額依目前設定的休息時間、國定假日及加班倍率計算，正式發薪前仍應由管理員確認未配對與異常紀錄。</p></main>`));
});

app.get('/admin/payroll/export', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const output = ['月份,員工編號,姓名,部門,薪資制,正常工時,平日加班工時,假日工時,遲到,早退,未配對,預估薪資'];
  payrollRows(month).forEach(({ employee, payroll }) => output.push([month, employee.employee_no, employee.name, employee.department, employee.salary_type === 'monthly' ? '月薪' : '時薪', payroll.regularHours.toFixed(2), payroll.weekdayOvertimeHours.toFixed(2), payroll.holidayHours.toFixed(2), payroll.late, payroll.early, payroll.incomplete, Math.round(payroll.totalPay)].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${month}.csv"`);
  res.send('\ufeff' + output.join('\r\n'));
});
app.get('/admin/payroll/excel', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  try {
    const report = await createPayrollWorkbook(month);
    const workbookData = fs.readFileSync(report.target);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.send(workbookData);
  }
  catch (error) { res.status(500).send(`Excel 產生失敗：${escapeHtml(error.message)}`); }
});
app.get('/admin/reports', requireAdmin, (req, res) => {
  const files = fs.readdirSync(reportDir, { withFileTypes: true }).filter((item) => item.isFile() && /^payroll-\d{4}-\d{2}\.xlsx$/.test(item.name)).map((item) => ({ name: item.name, modified: taipeiDate(fs.statSync(path.join(reportDir, item.name)).mtime) })).sort((a, b) => b.name.localeCompare(a.name));
  const rows = files.map((file) => `<tr><td>${escapeHtml(file.name.slice(8, 15))}</td><td>${escapeHtml(file.modified)}</td><td><a class="nav-button" href="/admin/reports/download?file=${encodeURIComponent(file.name)}">下載 Excel</a></td></tr>`).join('');
  res.send(page('自動報表中心', `<header><div><h1>自動報表</h1><p>每月 1 日產生上月薪資 Excel</p></div><nav><a href="/admin/payroll">薪資中心</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone"><section class="payroll-toolbar"><div><span>Monthly reports</span><h2>薪資報表檔案</h2></div><form method="post" action="/admin/reports/create"><input type="hidden" name="csrf" value="${csrfValue}"><label>月份<input type="month" name="month" value="${monthPrefix()}"></label><button>立即產生</button></form></section><article><div class="table-wrap"><table><thead><tr><th>月份</th><th>產生時間</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">尚無 Excel 報表</td></tr>'}</tbody></table></div></article></main>`));
});
app.post('/admin/reports/create', requireAdmin, requireCsrf, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : monthPrefix();
  try { await createPayrollWorkbook(month); audit('產生薪資Excel', 'report', month, '', req.admin.username); res.redirect(303, '/admin/reports'); }
  catch (error) { res.status(500).send(`Excel 產生失敗：${escapeHtml(error.message)}`); }
});
app.get('/admin/reports/download', requireAdmin, (req, res) => {
  const filename = String(req.query.file || '');
  if (!/^payroll-\d{4}-\d{2}\.xlsx$/.test(filename)) return res.status(400).send('報表檔名錯誤');
  const target = path.join(reportDir, filename);
  if (!fs.existsSync(target)) return res.status(404).send('找不到報表');
  res.download(target, filename);
});

app.get('/admin/leaves', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'all';
  const params = [`${month}%`];
  let where = 'l.leave_date LIKE ?';
  if (status !== 'all') { where += ' AND l.status=?'; params.push(status); }
  const leaves = db.prepare(`SELECT l.*,COALESCE(NULLIF(e.custom_name,''),e.display_name) name,e.employee_no,e.department
    FROM leave_requests l JOIN employees e USING(line_user_id) WHERE ${where}
    ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END,l.leave_date DESC,l.id DESC`).all(...params);
  const counts = db.prepare(`SELECT status,COUNT(*) count FROM leave_requests WHERE leave_date LIKE ? GROUP BY status`).all(`${month}%`);
  const countMap = Object.fromEntries(counts.map((row) => [row.status, row.count]));
  const labels = { pending: '待審核', approved: '已核准', rejected: '已駁回' };
  const rows = leaves.map((leave) => `<tr><td>${leave.leave_date}</td><td><b>${escapeHtml(leave.name)}</b><small>${escapeHtml(leave.employee_no || '未設定編號')} · ${escapeHtml(leave.department || '未設定部門')}</small></td><td>${escapeHtml(leave.reason)}</td><td><span class="status-${leave.status}">${labels[leave.status]}</span></td><td>${leave.status === 'pending' ? `<form method="post" action="/admin/leave/status"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${leave.id}"><input type="hidden" name="returnTo" value="/admin/leaves?month=${month}&status=${status}"><button name="status" value="approved">核准</button><button class="danger" name="status" value="rejected">駁回</button></form>` : ''}</td></tr>`).join('');
  res.send(page('請假中心', `<header><div><h1>請假中心</h1><p>${month} 申請紀錄</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/schedules">排班中心</a><a href="/admin/logout">登出</a></nav></header><main class="standalone leave-page"><section class="schedule-summary"><div><b>${countMap.pending || 0}</b><span>待審核</span></div><div><b>${countMap.approved || 0}</b><span>已核准</span></div><div><b>${countMap.rejected || 0}</b><span>已駁回</span></div><div><b>${leaves.length}</b><span>目前顯示</span></div></section><section class="payroll-toolbar"><form method="get"><label>月份<input type="month" name="month" value="${month}"></label><label>狀態<select name="status"><option value="all" ${status === 'all' ? 'selected' : ''}>全部</option><option value="pending" ${status === 'pending' ? 'selected' : ''}>待審核</option><option value="approved" ${status === 'approved' ? 'selected' : ''}>已核准</option><option value="rejected" ${status === 'rejected' ? 'selected' : ''}>已駁回</option></select></label><button>篩選</button></form></section><article><div class="table-wrap"><table class="leave-table"><thead><tr><th>日期</th><th>員工</th><th>原因</th><th>狀態</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">此條件沒有請假紀錄</td></tr>'}</tbody></table></div></article></main>`));
});

app.get('/admin/employees', requireAdmin, (_req, res) => {
  const employees = db.prepare(`SELECT *,COALESCE(NULLIF(custom_name,''),display_name) name FROM employees ORDER BY approved,name`).all();
  const pending = employees.filter((employee) => !employee.approved);
  const active = employees.filter((employee) => employee.approved);
  const pendingHtml = pending.map((employee) => `<article class="approval-card"><div><span>等待核准</span><h2>${escapeHtml(employee.display_name)}</h2><small>首次聯絡：${escapeHtml(employee.created_at)}</small></div><form method="post" action="/admin/employee/approval"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(employee.line_user_id)}"><input type="hidden" name="returnTo" value="/admin/employees"><button name="approved" value="1">核准員工</button><button class="danger" name="approved" value="-1">拒絕並移除</button></form></article>`).join('');
  const activeHtml = active.map((employee) => `<article class="staff-card" data-staff="${escapeHtml(`${employee.name} ${employee.employee_no} ${employee.department}`.toLowerCase())}"><div class="staff-title"><div><span>${escapeHtml(employee.department || '未設定部門')}</span><h2>${escapeHtml(employee.name)}</h2><small>LINE：${escapeHtml(employee.display_name)}</small></div><form method="post" action="/admin/employee/approval" onsubmit="return confirm('確定停用此員工？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(employee.line_user_id)}"><input type="hidden" name="returnTo" value="/admin/employees"><button class="danger" name="approved" value="0">停用</button></form></div><form class="profile-form employee-center-form" method="post" action="/admin/employee/profile"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="userId" value="${escapeHtml(employee.line_user_id)}"><input type="hidden" name="returnTo" value="/admin/employees"><label>公司姓名<input name="name" value="${escapeHtml(employee.custom_name || '')}" maxlength="50"></label><label>員工編號<input name="employeeNo" value="${escapeHtml(employee.employee_no || '')}" maxlength="30"></label><label>部門<input name="department" value="${escapeHtml(employee.department || '')}" maxlength="50"></label><label>到職日<input type="date" name="hireDate" value="${escapeHtml(employee.hire_date || '')}"></label><label>離職日<input type="date" name="terminationDate" value="${escapeHtml(employee.termination_date || '')}"></label><label>薪資類型<select name="salaryType"><option value="hourly" ${employee.salary_type === 'hourly' ? 'selected' : ''}>時薪</option><option value="monthly" ${employee.salary_type === 'monthly' ? 'selected' : ''}>月薪</option></select></label><label>時薪<input type="number" name="hourlyRate" value="${Number(employee.hourly_rate || 0)}" min="0" step="1"></label><label>月薪<input type="number" name="monthlySalary" value="${Number(employee.monthly_salary || 0)}" min="0" step="1"></label><button>儲存資料</button></form></article>`).join('');
  res.send(page('員工中心', `<header><div><h1>員工中心</h1><p>${active.length} 位在職 · ${pending.length} 位待核准</p></div><nav><a href="/admin">返回出勤管理</a><a href="/admin/payroll">薪資中心</a><a href="/admin/logout">登出</a></nav></header><main class="standalone employee-center">${pending.length ? `<section class="approval-section"><div class="panel-title"><span>待處理</span><h2>新員工申請</h2></div>${pendingHtml}</section>` : ''}<section class="staff-toolbar"><div><span>員工名冊</span><h2>在職員工</h2></div><input id="staff-search" placeholder="搜尋姓名、編號或部門…"></section><section class="staff-grid">${activeHtml || '<div class="all-clear">尚無已核准員工</div>'}</section></main><script>document.getElementById('staff-search')?.addEventListener('input',function(){const q=this.value.trim().toLowerCase();document.querySelectorAll('[data-staff]').forEach(card=>card.hidden=!card.dataset.staff.includes(q))})</script>`));
});

app.get('/admin/settings', requireAdmin, requireOwner, (_req, res) => {
  const settings = getSettings();
  res.send(page('系統設定中心', `<header><div><h1>系統設定</h1><p>出勤、通知與資料保存規則</p></div><nav><a href="/admin/locations">GPS 據點</a><a href="/admin/holidays">假日設定</a><a href="/admin/backups">備份中心</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone settings-page"><form class="settings-save" method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="returnTo" value="/admin/settings"><section class="settings-grid"><article><div class="panel-title"><span>Attendance</span><h2>出勤與薪資規則</h2></div><div class="settings-form"><label>標準上班時間<input type="time" name="shiftStart" value="${settings.shiftStart}" required></label><label>遲到寬限分鐘<input type="number" name="lateGrace" value="${settings.lateGrace}" min="0" max="120" required></label><label>每日標準工時<input type="number" name="standardHours" value="${settings.standardHours}" min="1" max="24" step="0.5" required></label><label>每日休息分鐘<input type="number" name="breakMinutes" value="${settings.breakMinutes}" min="0" max="480" required></label><label>平日加班倍率<input type="number" name="weekdayOvertimeMultiplier" value="${settings.weekdayOvertimeMultiplier}" min="1" max="5" step="0.01" required></label><label>預設假日倍率<input type="number" name="holidayOvertimeMultiplier" value="${settings.holidayOvertimeMultiplier}" min="1" max="5" step="0.01" required></label></div></article><article><div class="panel-title"><span>Notifications & privacy</span><h2>通知與個資</h2></div><div class="settings-form gps-settings"><label class="toggle"><input type="checkbox" name="gpsRequired" value="1" ${settings.gpsRequired ? 'checked' : ''}>所有 LINE 上下班都必須定位</label><label>主管 LINE User ID<input name="supervisorLineIds" value="${escapeHtml(settings.supervisorLineIds.join(','))}" placeholder="多筆以逗號分隔"><small>用於異常與月報通知</small></label><label>定位保存天數<input type="number" name="locationRetentionDays" value="${settings.locationRetentionDays}" min="1" max="3650" required></label><label>隱私聯絡窗口<input name="privacyContact" value="${escapeHtml(settings.privacyContact)}" maxlength="100" placeholder="電話或 Email"></label><p class="gps-help">座標與範圍請到獨立的「GPS 據點」管理；員工首次使用前必須在 LINE 輸入「同意定位」。</p></div></article></section><button class="primary-wide settings-submit">儲存所有設定</button></form><section class="system-card"><div class="panel-title"><span>System centers</span><h2>獨立管理功能</h2></div><div class="system-list"><div><b>GPS 據點</b><span><a href="/admin/locations">管理多個打卡範圍</a></span></div><div><b>國定假日</b><span><a href="/admin/holidays">管理假日計薪</a></span></div><div><b>自動報表</b><span><a href="/admin/reports">下載每月 Excel</a></span></div><div><b>管理員</b><span><a href="/admin/admins">帳號與權限</a></span></div><div><b>公開隱私說明</b><span><a href="/privacy" target="_blank">查看</a></span></div></div></section></main>`));
});

app.get('/admin/locations', requireAdmin, (req, res) => {
  const locations = db.prepare('SELECT * FROM work_locations ORDER BY active DESC,name').all();
  const rows = locations.map((location) => `<tr><td><b>${escapeHtml(location.name)}</b></td><td>${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}</td><td>${location.radius_meters} 公尺</td><td><span class="${location.active ? 'status-approved' : 'status-rejected'}">${location.active ? '啟用' : '停用'}</span></td><td><form method="post" action="/admin/locations/toggle"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${location.id}"><button class="${location.active ? 'danger' : ''}" name="active" value="${location.active ? 0 : 1}">${location.active ? '停用' : '啟用'}</button></form><form method="post" action="/admin/locations/delete" onsubmit="return confirm('確定刪除此據點？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${location.id}"><button class="danger">刪除</button></form></td></tr>`).join('');
  res.send(page('GPS 據點管理', `<header><div><h1>GPS 據點</h1><p>員工可在任一啟用據點範圍內打卡</p></div><nav><a href="/admin/settings">系統設定</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone"><section class="payroll-toolbar"><form method="post" action="/admin/locations"><input type="hidden" name="csrf" value="${csrfValue}"><label>據點名稱<input name="name" maxlength="60" required></label><label>緯度<input type="number" name="latitude" min="-90" max="90" step="0.000001" required></label><label>經度<input type="number" name="longitude" min="-180" max="180" step="0.000001" required></label><label>允許半徑（公尺）<input type="number" name="radius" value="200" min="20" max="10000" required></label><button>新增據點</button></form></section><article><div class="table-wrap"><table><thead><tr><th>據點</th><th>座標</th><th>範圍</th><th>狀態</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">尚未設定據點；新增後才可使用定位打卡。</td></tr>'}</tbody></table></div></article></main>`));
});
app.post('/admin/locations', requireAdmin, requireCsrf, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const latitude = Number(req.body.latitude); const longitude = Number(req.body.longitude);
  const radius = Math.max(20, Math.min(10000, Number(req.body.radius) || 200));
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return res.status(400).send('據點資料格式錯誤');
  const result = db.prepare('INSERT INTO work_locations(name,latitude,longitude,radius_meters,active,created_at) VALUES (?,?,?,?,1,?)').run(name, latitude, longitude, radius, taipeiDate());
  audit('新增GPS據點', 'work_location', result.lastInsertRowid, name, req.admin.username); res.redirect(303, '/admin/locations');
});
app.post('/admin/locations/toggle', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('UPDATE work_locations SET active=? WHERE id=?').run(req.body.active === '1' ? 1 : 0, Number(req.body.id));
  audit('切換GPS據點狀態', 'work_location', req.body.id, `active=${req.body.active}`, req.admin.username); res.redirect(303, '/admin/locations');
});
app.post('/admin/locations/delete', requireAdmin, requireCsrf, (req, res) => {
  const before = db.prepare('SELECT * FROM work_locations WHERE id=?').get(Number(req.body.id));
  db.prepare('DELETE FROM work_locations WHERE id=?').run(Number(req.body.id));
  if (before) audit('刪除GPS據點', 'work_location', req.body.id, JSON.stringify(before), req.admin.username); res.redirect(303, '/admin/locations');
});

app.get('/admin/holidays', requireAdmin, (_req, res) => {
  const holidays = db.prepare('SELECT * FROM holidays ORDER BY work_date DESC LIMIT 200').all();
  const rows = holidays.map((holiday) => `<tr><td>${holiday.work_date}</td><td>${escapeHtml(holiday.name)}</td><td>${holiday.multiplier}</td><td><form method="post" action="/admin/holidays/delete"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="workDate" value="${holiday.work_date}"><button class="danger">刪除</button></form></td></tr>`).join('');
  res.send(page('國定假日管理', `<header><div><h1>假日設定</h1><p>只有此處登記的日期會計入假日工時</p></div><nav><a href="/admin/payroll">薪資中心</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone"><section class="payroll-toolbar"><form method="post" action="/admin/holidays"><input type="hidden" name="csrf" value="${csrfValue}"><label>日期<input type="date" name="workDate" required></label><label>名稱<input name="name" maxlength="60" placeholder="例如：中秋節" required></label><label>薪資倍率<input type="number" name="multiplier" value="1.67" min="1" max="5" step="0.01" required></label><button>新增／更新</button></form></section><article><div class="table-wrap"><table><thead><tr><th>日期</th><th>名稱</th><th>倍率</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">尚未設定假日</td></tr>'}</tbody></table></div></article></main>`));
});
app.post('/admin/holidays', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.workDate || '')) return res.status(400).send('日期格式錯誤');
  const name = String(req.body.name || '').trim().slice(0, 60); const multiplier = Math.max(1, Math.min(5, Number(req.body.multiplier) || 1));
  db.prepare('INSERT INTO holidays(work_date,name,multiplier) VALUES (?,?,?) ON CONFLICT(work_date) DO UPDATE SET name=excluded.name,multiplier=excluded.multiplier').run(req.body.workDate, name, multiplier);
  audit('新增或更新假日', 'holiday', req.body.workDate, name, req.admin.username); res.redirect(303, '/admin/holidays');
});
app.post('/admin/holidays/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM holidays WHERE work_date=?').run(req.body.workDate); audit('刪除假日', 'holiday', req.body.workDate, '', req.admin.username); res.redirect(303, '/admin/holidays');
});

app.get('/privacy', (_req, res) => {
  const settings = getSettings();
  res.send(page('定位與個資說明', `<main class="login" style="max-width:680px"><h1>定位與個資說明</h1><p style="margin-top:18px;line-height:1.8">本系統僅在員工主動分享位置完成上下班打卡時，取得當下座標，用於判斷是否位於公司允許的據點範圍。定位資料保存 ${settings.locationRetentionDays} 天後會自動去識別化，出勤時間仍保留供薪資與稽核使用。員工可在 LINE 輸入「同意定位」表示同意，並可聯絡管理員申請撤回或刪除定位資料。</p><p style="margin-top:14px">聯絡窗口：${escapeHtml(settings.privacyContact || '請洽公司管理員')}</p></main>`));
});

app.get('/admin/admins', requireAdmin, requireOwner, (_req, res) => {
  const accounts = db.prepare('SELECT username,role,active,created_at FROM admin_users ORDER BY username').all();
  const roleLabels = { owner: '擁有者', manager: '管理員', viewer: '唯讀' };
  const rows = accounts.map((account) => `<tr><td>${escapeHtml(account.username)}</td><td>${roleLabels[account.role]}</td><td><span class="${account.active ? 'status-approved' : 'status-rejected'}">${account.active ? '啟用' : '停用'}</span></td><td>${escapeHtml(account.created_at)}</td><td><form method="post" action="/admin/admins/toggle"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="username" value="${escapeHtml(account.username)}"><button class="${account.active ? 'danger' : ''}" name="active" value="${account.active ? 0 : 1}">${account.active ? '停用' : '啟用'}</button></form></td></tr>`).join('');
  res.send(page('管理員帳號', `<header><div><h1>管理員帳號</h1><p>角色與後台存取權限</p></div><nav><a href="/admin/settings">系統設定</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone"><section class="settings-grid"><article><div class="panel-title"><span>New account</span><h2>新增或重設管理員</h2></div><form class="settings-form" method="post" action="/admin/admins"><input type="hidden" name="csrf" value="${csrfValue}"><label>帳號<input name="username" pattern="[a-z0-9._-]{3,40}" minlength="3" maxlength="40" required><small>限小寫英文、數字及 . _ -</small></label><label>角色<select name="role"><option value="manager">管理員（可修改）</option><option value="viewer">唯讀（不可修改）</option></select></label><label>密碼<input type="password" name="password" minlength="10" required></label><button>建立／重設帳號</button></form></article><article><div class="panel-title"><span>Permissions</span><h2>角色說明</h2></div><div class="system-list"><div><b>owner</b><span>最高權限及帳號管理</span></div><div><b>manager</b><span>排班、請假、打卡與員工管理</span></div><div><b>viewer</b><span>只能查看與匯出資料</span></div></div><p class="data-warning">主帳號 owner 的密碼仍由主機環境變數 ADMIN_PASSWORD 控制。</p></article></section><article><div class="table-wrap"><table><thead><tr><th>帳號</th><th>角色</th><th>狀態</th><th>建立時間</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">尚未建立其他管理員</td></tr>'}</tbody></table></div></article></main>`));
});

app.post('/admin/admins', requireAdmin, requireOwner, requireCsrf, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ['manager', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer';
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || username === 'owner' || password.length < 10) return res.status(400).send('帳號格式錯誤或密碼少於 10 碼。');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO admin_users(username,password_salt,password_hash,role,active,created_at) VALUES (?,?,?,?,1,?)
    ON CONFLICT(username) DO UPDATE SET password_salt=excluded.password_salt,password_hash=excluded.password_hash,role=excluded.role,active=1`).run(username, salt, hashPassword(password, salt), role, taipeiDate());
  audit('新增或重設管理員', 'admin_user', username, `role=${role}`, req.admin.username);
  res.redirect(303, '/admin/admins');
});

app.post('/admin/admins/toggle', requireAdmin, requireOwner, requireCsrf, (req, res) => {
  const username = String(req.body.username || '');
  const active = req.body.active === '1' ? 1 : 0;
  db.prepare('UPDATE admin_users SET active=? WHERE username=?').run(active, username);
  audit(active ? '啟用管理員' : '停用管理員', 'admin_user', username, '', req.admin.username);
  res.redirect(303, '/admin/admins');
});

app.get('/admin', (req, res) => {
  if (req.query.password === process.env.ADMIN_PASSWORD) { setSession(res); return res.redirect('/admin'); }
  const signedInAdmin = authorized(req);
  if (!signedInAdmin) return res.redirect('/admin/login');
  req.admin = signedInAdmin;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthPrefix();
  const settings = getSettings();
  const employees = db.prepare(`SELECT *,COALESCE(NULLIF(custom_name,''),display_name) AS name FROM employees ORDER BY approved,name`).all();
  const rows = db.prepare(`SELECT a.id,a.line_user_id,a.type,a.occurred_at,a.source,a.note,a.latitude,a.longitude,a.distance_meters,a.location_status,
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
  const pendingLeaves = db.prepare("SELECT COUNT(*) count FROM leave_requests WHERE status='pending'").get().count;
  res.send(page('LINE 打卡管理', `<header><div><h1>出勤管理</h1><p>${month} 月報表 · ${escapeHtml(signedInAdmin.username)}</p></div><nav><a href="/admin/employees">員工中心${pending.length ? ` (${pending.length})` : ''}</a><a href="/admin/schedules">排班中心</a><a href="/admin/leaves">請假中心${pendingLeaves ? ` (${pendingLeaves})` : ''}</a><a href="/admin/payroll?month=${month}">薪資中心</a><a href="/admin/anomalies">異常中心</a>${signedInAdmin.role === 'owner' ? '<a href="/admin/settings">系統設定</a><a href="/admin/admins">管理員帳號</a>' : ''}<a href="/admin/audit">稽核紀錄</a><a href="/admin/export?month=${month}">匯出 CSV</a><a href="/admin/logout">登出</a></nav></header>
    <nav class="section-nav"><a href="#overview">總覽</a><a href="#tools">查詢與補登</a><a href="#employees">出勤紀錄</a><a href="/admin/employees">員工中心</a><a href="/admin/schedules">排班中心</a><a href="/admin/leaves">請假中心</a>${signedInAdmin.role === 'owner' ? '<a href="/admin/settings">系統設定</a>' : ''}</nav>
    <section id="overview" class="today four"><div><b>${activeEmployees.length}</b><span>正式員工</span></div><div><b>${arrived}</b><span>今日已到</span></div><div><b>${working}</b><span>目前上班中</span></div><div><b class="${pendingLeaves ? 'warn' : ''}">${pendingLeaves}</b><span>待審請假</span></div></section>
    <section id="tools" class="toolbar"><div class="section-heading"><span>管理工具</span><h2>查詢與補登</h2></div><form><label>月份<input type="month" name="month" value="${month}"></label><button>查詢</button></form>
    <form method="post" action="/admin/attendance/add"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="month" value="${month}"><label>員工<select name="userId" required>${options}</select></label><label>類型<select name="type"><option value="clock_in">上班</option><option value="clock_out">下班</option></select></label><label>時間<input type="datetime-local" name="occurredAt" required></label><label>備註<input name="note" maxlength="100"></label><button>補登</button></form></section>
    <section id="employees" class="employee-filter"><div><span>出勤紀錄</span><h2>工時與異常</h2></div><input id="employee-search" placeholder="搜尋員工姓名…" autocomplete="off"></section>
    <main class="cards">${cards || '<div class="empty">尚無員工資料，員工加入好友並傳送訊息後會自動出現。</div>'}</main>
    <script>document.getElementById('employee-search')?.addEventListener('input',function(){const q=this.value.trim().toLowerCase();document.querySelectorAll('.employee-card').forEach(card=>card.hidden=!card.dataset.name.includes(q))})</script>`));
});

function employeeCard(employee, settings) {
  const summary = summarize(employee.rows, settings);
  const records = employee.rows.map((r) => `<tr><td>${r.type === 'clock_in' ? '<span class="in">上班</span>' : '<span class="out">下班</span>'}<form id="edit-${r.id}" method="post" action="/admin/attendance/edit"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${r.id}"></form></td><td><input form="edit-${r.id}" type="datetime-local" name="occurredAt" value="${r.occurred_at.slice(0,16).replace(' ','T')}" required></td><td><input form="edit-${r.id}" name="note" value="${escapeHtml(r.note || '')}" maxlength="100"></td><td>${r.source === 'admin' ? '補登' : r.source === 'line_gps' ? `GPS ${Math.round(r.distance_meters || 0)}m<br><a href="https://www.google.com/maps?q=${r.latitude},${r.longitude}" target="_blank" rel="noopener">查看位置</a>` : 'LINE'}</td><td><button form="edit-${r.id}">修改</button><form method="post" action="/admin/attendance/delete" onsubmit="return confirm('確定刪除？')"><input type="hidden" name="csrf" value="${csrfValue}"><input type="hidden" name="id" value="${r.id}"><button class="danger">刪除</button></form></td></tr>`).join('');
  return `<article class="employee-card" data-name="${escapeHtml(employee.name.toLowerCase())}"><div class="employee"><div><h2>${escapeHtml(employee.name)}</h2><small>本月出勤明細</small></div><a class="nav-button" href="/admin/employees">前往員工資料</a></div>
    <div class="stats five"><b>${summary.shifts}<small>出勤天數</small></b><b>${summary.hours.toFixed(2)}<small>計薪工時</small></b><b class="${summary.late ? 'warn' : ''}">${summary.late}<small>遲到</small></b><b class="${summary.early ? 'warn' : ''}">${summary.early}<small>早退</small></b><b>${summary.overtime.toFixed(2)}<small>加班工時</small></b></div>
    <div class="table-wrap"><table><thead><tr><th>類型</th><th>時間</th><th>備註</th><th>來源</th><th></th></tr></thead><tbody>${records || '<tr><td colspan="5">本月無紀錄</td></tr>'}</tbody></table></div></article>`;
}

app.post('/admin/employee/name', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('UPDATE employees SET custom_name=? WHERE line_user_id=?').run(String(req.body.name || '').trim().slice(0, 50), req.body.userId);
  audit('修改姓名', 'employee', req.body.userId, String(req.body.name || ''), req.admin.username);
  res.redirect(303, '/admin');
});
app.post('/admin/employee/profile', requireAdmin, requireCsrf, (req, res) => {
  const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
  const salaryType = req.body.salaryType === 'monthly' ? 'monthly' : 'hourly';
  db.prepare(`UPDATE employees SET custom_name=?,employee_no=?,department=?,hire_date=?,termination_date=?,salary_type=?,hourly_rate=?,monthly_salary=? WHERE line_user_id=?`)
    .run(String(req.body.name || '').trim().slice(0, 50), String(req.body.employeeNo || '').trim().slice(0, 30), String(req.body.department || '').trim().slice(0, 50), date(req.body.hireDate), date(req.body.terminationDate), salaryType, Math.max(0, Number(req.body.hourlyRate) || 0), Math.max(0, Number(req.body.monthlySalary) || 0), req.body.userId);
  audit('修改員工與薪資資料', 'employee', req.body.userId, `編號=${String(req.body.employeeNo || '').slice(0, 30)}；部門=${String(req.body.department || '').slice(0, 50)}；薪資類型=${salaryType}`, req.admin.username);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo === '/admin/employees' ? returnTo : '/admin');
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
  audit(req.body.approved === '1' ? '核准員工' : req.body.approved === '0' ? '停用員工' : '移除申請', 'employee', userId, '', req.admin.username);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo === '/admin/employees' ? returnTo : '/admin');
});
app.post('/admin/settings', requireAdmin, requireOwner, requireCsrf, (req, res) => {
  if (!/^\d{2}:\d{2}$/.test(req.body.shiftStart || '')) return res.status(400).send('上班時間格式錯誤');
  const lateGrace = Math.max(0, Math.min(120, Number(req.body.lateGrace)));
  const standardHours = Math.max(1, Math.min(24, Number(req.body.standardHours)));
  const breakMinutes = Math.max(0, Math.min(480, Number(req.body.breakMinutes) || 0));
  const weekdayOvertimeMultiplier = Math.max(1, Math.min(5, Number(req.body.weekdayOvertimeMultiplier) || 1));
  const holidayOvertimeMultiplier = Math.max(1, Math.min(5, Number(req.body.holidayOvertimeMultiplier) || 1));
  const gpsRequired = req.body.gpsRequired === '1';
  const supervisorLineIds = String(req.body.supervisorLineIds || '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 20).join(',');
  const locationRetentionDays = Math.max(1, Math.min(3650, Number(req.body.locationRetentionDays) || 90));
  const privacyContact = String(req.body.privacyContact || '').trim().slice(0, 100);
  if (gpsRequired && !activeLocations().length) return res.status(400).send('啟用強制 GPS 前，請先到 GPS 據點新增至少一個啟用據點。');
  const save = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const transaction = db.transaction(() => {
    save.run('shift_start', req.body.shiftStart);
    save.run('late_grace_minutes', String(lateGrace));
    save.run('standard_hours', String(standardHours));
    save.run('break_minutes', String(breakMinutes));
    save.run('weekday_overtime_multiplier', String(weekdayOvertimeMultiplier));
    save.run('holiday_overtime_multiplier', String(holidayOvertimeMultiplier));
    save.run('gps_required', gpsRequired ? '1' : '0');
    save.run('supervisor_line_ids', supervisorLineIds);
    save.run('location_retention_days', String(locationRetentionDays));
    save.run('privacy_contact', privacyContact);
  });
  transaction();
  audit('修改出勤、通知與隱私設定', 'settings', 'attendance', JSON.stringify({ shiftStart: req.body.shiftStart, lateGrace, standardHours, breakMinutes, weekdayOvertimeMultiplier, holidayOvertimeMultiplier, gpsRequired, supervisorCount: supervisorLineIds ? supervisorLineIds.split(',').length : 0, locationRetentionDays }), req.admin.username);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo === '/admin/settings' ? returnTo : '/admin');
});
app.post('/admin/schedule', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.workDate || '') || !/^\d{2}:\d{2}$/.test(req.body.startTime || '') || !/^\d{2}:\d{2}$/.test(req.body.endTime || '')) return res.status(400).send('排班格式錯誤');
  db.prepare(`INSERT INTO schedules(line_user_id,work_date,start_time,end_time,note) VALUES (?,?,?,?,?)
    ON CONFLICT(line_user_id,work_date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,note=excluded.note`)
    .run(req.body.userId, req.body.workDate, req.body.startTime, req.body.endTime, String(req.body.note || '').slice(0, 100));
  audit('新增或更新班表', 'schedule', `${req.body.userId}|${req.body.workDate}`, `${req.body.startTime}-${req.body.endTime}`, req.admin.username);
  res.redirect(303, '/admin');
});
app.post('/admin/schedule/delete', requireAdmin, requireCsrf, (req, res) => {
  const before = db.prepare('SELECT * FROM schedules WHERE id=?').get(Number(req.body.id));
  db.prepare('DELETE FROM schedules WHERE id=?').run(Number(req.body.id));
  if (before) audit('刪除班表', 'schedule', before.id, JSON.stringify(before), req.admin.username);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo.startsWith('/admin/schedules') ? returnTo : '/admin');
});
app.post('/admin/leave/status', requireAdmin, requireCsrf, async (req, res) => {
  if (!['approved', 'rejected'].includes(req.body.status)) return res.status(400).send('狀態錯誤');
  const leave = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(Number(req.body.id));
  if (leave) {
    db.prepare('UPDATE leave_requests SET status=? WHERE id=?').run(req.body.status, leave.id);
    audit(req.body.status === 'approved' ? '核准請假' : '駁回請假', 'leave', leave.id, `${leave.leave_date} ${leave.reason}`, req.admin.username);
    const label = req.body.status === 'approved' ? '已核准 ✅' : '已駁回 ❌';
    try { await client.pushMessage({ to: leave.line_user_id, messages: [{ type: 'text', text: `你的請假申請${label}\n日期：${leave.leave_date}\n原因：${leave.reason}` }] }); } catch (error) { console.error('請假通知發送失敗', error.message); }
  }
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, returnTo.startsWith('/admin/leaves') ? returnTo : '/admin/leaves');
});
app.post('/admin/attendance/add', requireAdmin, requireCsrf, (req, res) => {
  if (!['clock_in', 'clock_out'].includes(req.body.type) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.occurredAt || '')) return res.status(400).send('資料格式錯誤');
  const occurredAt = `${req.body.occurredAt.replace('T', ' ')}:00`;
  const result = db.prepare('INSERT INTO attendance(line_user_id,type,occurred_at,source,note) VALUES (?,?,?,?,?)').run(req.body.userId, req.body.type, occurredAt, 'admin', String(req.body.note || '').slice(0, 100));
  audit('補登打卡', 'attendance', result.lastInsertRowid, `${req.body.type} ${occurredAt}`, req.admin.username);
  res.redirect(303, `/admin?month=${encodeURIComponent(req.body.month || monthPrefix())}`);
});
app.post('/admin/attendance/edit', requireAdmin, requireCsrf, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.occurredAt || '')) return res.status(400).send('時間格式錯誤');
  const before = db.prepare('SELECT * FROM attendance WHERE id=?').get(Number(req.body.id));
  db.prepare('UPDATE attendance SET occurred_at=?,note=?,source=? WHERE id=?').run(`${req.body.occurredAt.replace('T', ' ')}:00`, String(req.body.note || '').slice(0, 100), 'admin', Number(req.body.id));
  audit('修改打卡', 'attendance', req.body.id, JSON.stringify(before || {}), req.admin.username);
  res.redirect(303, '/admin');
});
app.post('/admin/attendance/delete', requireAdmin, requireCsrf, (req, res) => {
  const before = db.prepare('SELECT * FROM attendance WHERE id=?').get(Number(req.body.id));
  db.prepare('DELETE FROM attendance WHERE id=?').run(Number(req.body.id));
  if (before) audit('刪除打卡', 'attendance', req.body.id, JSON.stringify(before), req.admin.username);
  res.redirect(303, '/admin');
});
app.get('/admin/backup', requireAdmin, (_req, res) => {
  db.pragma('wal_checkpoint(PASSIVE)');
  res.download(path.join(dataDir, 'attendance.db'), `attendance-backup-${dayPrefix()}.db`);
});
app.get('/admin/backups', requireAdmin, requireOwner, (_req, res) => {
  const files = fs.readdirSync(backupDir, { withFileTypes: true }).filter((item) => item.isFile() && /^attendance-[a-z]+-\d{14}\.db$/.test(item.name)).map((item) => {
    const stat = fs.statSync(path.join(backupDir, item.name));
    return { name: item.name, size: stat.size, modified: taipeiDate(stat.mtime) };
  }).sort((a, b) => b.name.localeCompare(a.name));
  const rows = files.map((file) => `<tr><td>${escapeHtml(file.modified)}</td><td>${escapeHtml(file.name)}</td><td>${(file.size / 1024 / 1024).toFixed(2)} MB</td><td><a class="nav-button" href="/admin/backups/download?file=${encodeURIComponent(file.name)}">下載</a></td></tr>`).join('');
  res.send(page('備份中心', `<header><div><h1>備份中心</h1><p>每日 03:00 自動建立資料庫備份</p></div><nav><a href="/admin/settings">系統設定</a><a href="/admin">返回出勤管理</a></nav></header><main class="standalone"><section class="payroll-toolbar"><div><span>保存位置</span><h2>${escapeHtml(backupDir)}</h2></div><form method="post" action="/admin/backups/create"><input type="hidden" name="csrf" value="${csrfValue}"><button>立即建立備份</button></form></section><article><div class="table-wrap"><table><thead><tr><th>建立時間</th><th>檔案</th><th>大小</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">尚無自動備份</td></tr>'}</tbody></table></div></article><p class="data-warning">只有當 DATA_DIR 或 BACKUP_DIR 位於永久磁碟時，主機重新部署後備份才會保留。</p></main>`));
});
app.post('/admin/backups/create', requireAdmin, requireOwner, requireCsrf, async (req, res) => {
  try { const filename = await createDatabaseBackup('manual'); audit('手動建立資料庫備份', 'backup', filename, '', req.admin.username); res.redirect(303, '/admin/backups'); }
  catch (error) { res.status(500).send(`備份失敗：${escapeHtml(error.message)}`); }
});
app.get('/admin/backups/download', requireAdmin, requireOwner, (req, res) => {
  const filename = String(req.query.file || '');
  if (!/^attendance-[a-z]+-\d{14}\.db$/.test(filename)) return res.status(400).send('備份檔名錯誤');
  const target = path.join(backupDir, filename);
  if (!fs.existsSync(target)) return res.status(404).send('找不到備份');
  res.download(target, filename);
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
  let open = null; let hours = 0; let overtime = 0; let late = 0; let early = 0; let incomplete = 0; let regularHours = 0; let weekdayOvertimeHours = 0; let holidayHours = 0; let holidayPayUnits = 0; const days = new Set();
  for (const row of rows) {
    if (row.type === 'clock_in') {
      if (open) incomplete += 1;
      open = row;
      const scheduled = row.line_user_id ? db.prepare('SELECT start_time FROM schedules WHERE line_user_id=? AND work_date=?').get(row.line_user_id, row.occurred_at.slice(0, 10)) : null;
      const threshold = toMillis(`${row.occurred_at.slice(0, 10)} ${scheduled?.start_time || settings.shiftStart}:00`) + settings.lateGrace * 60000;
      if (toMillis(row.occurred_at) > threshold) late += 1;
    }
    else if (open) {
      const duration = (toMillis(row.occurred_at) - toMillis(open.occurred_at)) / 3600000;
      if (duration >= 0 && duration <= 24) {
        const net = Math.max(0, duration - settings.breakMinutes / 60);
        const workDate = open.occurred_at.slice(0, 10);
        const holiday = db.prepare('SELECT multiplier FROM holidays WHERE work_date=?').get(workDate);
        hours += net;
        if (holiday) { holidayHours += net; holidayPayUnits += net * Number(holiday.multiplier || settings.holidayOvertimeMultiplier); }
        else { regularHours += Math.min(net, settings.standardHours); weekdayOvertimeHours += Math.max(0, net - settings.standardHours); }
        overtime = weekdayOvertimeHours + holidayHours;
        days.add(open.occurred_at.slice(0, 10));
        if (open.line_user_id) {
          const scheduled = db.prepare('SELECT start_time,end_time FROM schedules WHERE line_user_id=? AND work_date=?').get(open.line_user_id, open.occurred_at.slice(0, 10));
          if (scheduled) {
            let scheduledEndDate = open.occurred_at.slice(0, 10);
            if (scheduled.end_time <= scheduled.start_time) scheduledEndDate = addDays(scheduledEndDate, 1);
            if (toMillis(row.occurred_at) < toMillis(`${scheduledEndDate} ${scheduled.end_time}:00`)) early += 1;
          }
        }
      } else incomplete += 2;
      open = null;
    }
    else incomplete += 1;
  }
  if (open) incomplete += 1;
  return { shifts: days.size, hours, late, early, overtime, incomplete, regularHours, weekdayOvertimeHours, holidayHours, holidayPayUnits };
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function csvCell(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function page(title, body) {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>
  :root{font-family:Inter,"Noto Sans TC",system-ui;color:#18201d;background:#f2f5f3;scroll-behavior:smooth}*{box-sizing:border-box}body{margin:0}header{background:linear-gradient(135deg,#063d2d,#087f5b);color:white;padding:32px max(5vw,20px);display:flex;justify-content:space-between;align-items:center}h1,h2,h3,p{margin:0}header p{opacity:.75;margin-top:5px}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#06c755;text-decoration:none}header a{color:white}.section-nav{position:sticky;top:0;z-index:20;background:#ffffffed;backdrop-filter:blur(12px);padding:12px max(5vw,20px);box-shadow:0 3px 14px #133b2c10;overflow:auto;flex-wrap:nowrap}.section-nav a{color:#315046;background:#edf7f2;border-radius:999px;padding:8px 14px;white-space:nowrap}.today,.pending-box,.toolbar,.operations,.employee-filter,.cards{max-width:1100px;margin:22px auto;padding:0 18px}.today{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.today.four{grid-template-columns:repeat(4,1fr)}.today div{background:white;border-radius:16px;padding:20px;box-shadow:0 3px 18px #133b2c12;border:1px solid #e8efeb}.today b{display:block;font-size:30px;color:#087f5b}.today span{font-size:13px;color:#68766f}.pending-box{background:#fff7ed;border:1px solid #fed7aa;border-radius:16px;padding:18px}.pending-box h2 span{background:#c2410c;color:white;border-radius:20px;padding:2px 9px;font-size:14px}.pending-person{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:13px 0;border-top:1px solid #fed7aa}.pending-person:first-of-type{margin-top:12px}.pending-person small{display:block;color:#78716c}.section-heading span,.employee-filter span,.panel-title span{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#087f5b}.section-heading h2,.employee-filter h2,.panel-title h2{margin-top:3px}.toolbar,.operations{display:grid;gap:12px}.toolbar form,article,.login{background:white;padding:18px;border-radius:16px;box-shadow:0 3px 18px #133b2c12}form{display:flex;gap:10px;align-items:end;flex-wrap:wrap}label{display:grid;gap:5px;font-size:13px;color:#52615b}input,select,button{font:inherit;padding:9px 11px;border:1px solid #ccd5d1;border-radius:9px;background:white}input:focus,select:focus{outline:2px solid #a7dcc8;border-color:#087f5b}button{background:#087f5b;color:white;border:0;cursor:pointer}.operations article{padding:0;scroll-margin-top:75px}.operations h2,.operations>article>form{padding:18px}.employee-filter{display:flex;align-items:end;justify-content:space-between;gap:18px;scroll-margin-top:75px}.employee-filter input{min-width:260px}.cards{display:grid;gap:18px}article{padding:0;overflow:hidden;border:1px solid #e8efeb}.employee{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:20px}.employee small{color:#77827e}.employee-actions{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.profile-form{padding:16px 20px;background:#f8fbf9;border-top:1px solid #e4ebe7}.stats{display:grid;background:#f6faf8;text-align:center}.stats.five{grid-template-columns:repeat(5,1fr)}.stats.six{grid-template-columns:repeat(6,1fr)}.stats b{padding:15px;font-size:22px}.stats small{display:block;font-weight:400;font-size:12px;color:#68766f}.warn,.status-rejected{color:#c2410c}.status-approved{color:#087f5b}.status-pending{color:#a16207}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:11px 16px;border-top:1px solid #edf0ee;font-size:14px}th{color:#52615b;background:#fbfdfc}td:last-child{display:flex;gap:6px;align-items:center}.leave-table td:nth-child(2) b,.leave-table td:nth-child(2) small{display:block}.leave-table td:nth-child(2) small{color:#77827e;margin-top:3px}.in{color:#087f5b}.out{color:#2563eb}.danger{background:#fff;color:#c2410c;border:1px solid #fed7aa;padding:6px 9px}.login{max-width:380px;margin:12vh auto}.login form{margin-top:20px;display:grid}.empty{text-align:center;padding:40px;color:#66736e}[hidden]{display:none!important}.standalone{max-width:1200px;margin:24px auto;padding:0 18px}.standalone article{padding:18px}.standalone article .table-wrap{margin:18px -18px -18px}.audit-details{max-width:430px;white-space:normal;word-break:break-word}.issue-summary{display:flex;align-items:center;gap:12px;background:white;border-radius:16px;padding:18px;border:1px solid #e8efeb}.issue-summary b{font-size:32px;color:#c2410c}.issue-list{display:grid;gap:12px;margin-top:16px}.issue{display:grid;grid-template-columns:1fr auto;gap:7px;padding:18px;border-left:5px solid #f0b429}.issue.high{border-left-color:#c2410c}.issue span{font-size:11px;color:#9a6700}.issue.high span{color:#c2410c}.issue p{grid-column:1/-1;color:#66736e}.all-clear{background:#eaf9f1;color:#087f5b;border-radius:16px;padding:30px;text-align:center;font-size:18px}.approval-section{background:#fff7ed;border:1px solid #fed7aa;border-radius:16px;padding:18px;margin-bottom:18px}.approval-card{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border:0;border-top:1px solid #fed7aa;border-radius:0;box-shadow:none;background:transparent}.approval-card:first-of-type{margin-top:14px}.approval-card span,.staff-title span,.staff-toolbar span{font-size:12px;color:#087f5b}.approval-card small,.staff-title small{color:#77827e}.staff-toolbar{display:flex;justify-content:space-between;align-items:end;margin:18px 0}.staff-toolbar input{min-width:280px}.staff-grid{display:grid;gap:16px}.staff-card{padding:0}.staff-title{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px}.employee-center-form{display:grid;grid-template-columns:repeat(4,1fr);align-items:end}.employee-center-form button{height:40px}
  .schedule-page{max-width:1400px;margin:22px auto;padding:0 18px 50px}.schedule-toolbar{display:flex;justify-content:space-between;align-items:end;gap:14px;background:white;border:1px solid #e8efeb;border-radius:16px;padding:14px 18px;box-shadow:0 3px 18px #133b2c12}.schedule-tools{display:flex;gap:8px;align-items:center}.nav-button{background:#edf7f2;color:#087f5b;border-radius:9px;padding:10px 14px;white-space:nowrap}.secondary{background:#fff;color:#087f5b;border:1px solid #b9d9cc}.schedule-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.schedule-summary div{background:white;border:1px solid #e8efeb;border-radius:14px;padding:16px}.schedule-summary b{display:block;color:#087f5b;font-size:25px}.schedule-summary span{color:#68766f;font-size:12px}.schedule-controls{display:flex;justify-content:space-between;gap:12px;align-items:end;background:white;border:1px solid #e8efeb;border-radius:14px;padding:13px 16px;margin-bottom:12px}.week-grid{display:grid;grid-template-columns:repeat(7,minmax(165px,1fr));gap:10px;overflow:auto;padding-bottom:8px}.schedule-day{min-height:275px;padding:0;background:white}.schedule-day.is-today{border:2px solid #06c755}.schedule-day.understaffed{border-color:#f0b429}.day-head{display:flex;justify-content:space-between;align-items:center;padding:15px;background:#f6faf8;border-bottom:1px solid #e8efeb}.is-today .day-head{background:#eaf9f1}.day-head span{font-size:12px;color:#68766f}.day-head h3{margin-top:3px}.day-head>b{color:#087f5b;font-size:22px}.day-head small{font-size:11px;margin-left:2px}.staff-warning{background:#fff7db;color:#8a5d00;padding:6px 10px;text-align:center;font-size:12px}.day-shifts{padding:8px}.shift-row{display:flex;justify-content:space-between;gap:5px;border-bottom:1px solid #edf0ee;padding:10px 4px}.shift-row>div{min-width:0}.shift-row b,.shift-row span{display:block}.shift-row span{color:#66736e;font-size:12px;margin-top:3px}.shift-row em{display:inline-block;color:#b42318;background:#fff0ed;border-radius:99px;font-size:11px;font-style:normal;padding:2px 7px;margin-top:5px}.shift-row.conflict{background:#fff8f6}.shift-row form{align-self:start}.icon-danger{padding:0;background:transparent;color:#b42318;font-size:22px;line-height:1}.no-shift{padding:20px 4px;color:#929c98;font-size:13px;text-align:center}.leave-only{color:#9a6700;background:#fff8db;border-radius:7px;padding:7px;margin:5px 0;font-size:12px}.workload{background:white;border:1px solid #e8efeb;border-radius:16px;margin-top:18px;overflow:hidden}.workload .panel-title{padding:18px}.schedule-actions{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-top:18px}.schedule-actions article{padding:20px}.schedule-actions .muted{color:#66736e;line-height:1.6;margin:12px 0 18px}.bulk-form{display:grid;margin-top:18px}.bulk-form fieldset{border:1px solid #dde6e2;border-radius:12px;padding:14px;min-width:0}.bulk-form legend{font-weight:700;padding:0 7px}.people-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.check-person{display:flex;align-items:center;border:1px solid #e2e8e5;border-radius:9px;padding:9px;background:#fbfdfc}.check-person input,.weekday-checks input,.skip-leave input{accent-color:#087f5b}.form-row,.weekday-checks{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.weekday-checks{margin-top:12px}.weekday-checks label,.skip-leave{display:flex;align-items:center;gap:4px}.skip-leave{margin-top:12px;color:#315046}.grow{flex:1}.grow input{width:100%}.primary-wide{width:100%;padding:12px;font-weight:700}.template-manager{border-top:1px solid #e2e8e5;margin-top:24px;padding-top:20px}.template-list{display:grid;gap:7px;margin:14px 0}.template-card{display:flex;justify-content:space-between;align-items:center;background:#f6faf8;border-radius:9px;padding:9px 12px}.template-card span{display:block;color:#66736e;font-size:12px;margin-top:2px}.template-form{display:grid;grid-template-columns:1fr 1fr}.template-form button{grid-column:1/-1}.payroll-toolbar{display:flex;justify-content:space-between;align-items:end;background:white;border:1px solid #e8efeb;border-radius:14px;padding:14px 18px}.payroll-table td:first-child b,.payroll-table td:first-child small{display:block}.payroll-table td:first-child small{color:#77827e;margin-top:3px}.payroll-table td:last-child{font-weight:700;color:#087f5b}.payroll-note{color:#66736e;font-size:13px;line-height:1.6;margin-top:14px}.settings-save{display:block}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.settings-grid article,.system-card{padding:20px}.settings-form{display:grid;grid-template-columns:1fr 1fr;margin-top:20px}.settings-form label small{color:#86918c}.gps-settings .toggle{grid-column:1/-1;display:flex;align-items:center;gap:8px;background:#edf7f2;border-radius:10px;padding:12px}.gps-settings .toggle input{accent-color:#087f5b}.gps-help{grid-column:1/-1;color:#66736e;font-size:12px;line-height:1.5}.settings-submit{margin:16px 0}.system-card{background:white;border:1px solid #e8efeb;border-radius:16px}.system-list{display:grid;margin:18px 0}.system-list div{display:flex;justify-content:space-between;gap:14px;padding:13px 0;border-bottom:1px solid #e8efeb}.system-list span{text-align:right;color:#66736e}.backup-button{display:block;text-align:center;background:#087f5b;color:white;border-radius:9px;padding:11px}.data-warning{background:#fff7ed;color:#9a3412;border-radius:10px;padding:12px;margin-top:13px;font-size:12px;line-height:1.5}
  @media(max-width:900px){.week-grid{grid-template-columns:repeat(7,190px)}.schedule-actions,.settings-grid{grid-template-columns:1fr}.people-grid{grid-template-columns:repeat(2,1fr)}.employee-center-form{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){header{align-items:flex-start;gap:15px;flex-direction:column}.employee,.pending-person,.employee-filter,.approval-card,.staff-title,.staff-toolbar{align-items:flex-start;flex-direction:column}.employee-filter input,.staff-toolbar input{width:100%;min-width:0}.employee-center-form,.settings-form,.template-form{grid-template-columns:1fr}.settings-form button,.template-form button{grid-column:auto}.stats.five{grid-template-columns:repeat(2,1fr)}.stats b{font-size:18px}.today{grid-template-columns:1fr 1fr 1fr;padding:0 12px}.today.four{grid-template-columns:1fr 1fr}.today div{padding:14px}.today b{font-size:22px}.today span{font-size:11px}.schedule-toolbar,.schedule-controls,.payroll-toolbar{align-items:stretch;flex-direction:column}.schedule-toolbar .nav-button{text-align:center}.schedule-tools{display:grid;grid-template-columns:1fr 1fr 1fr}.schedule-summary{grid-template-columns:1fr 1fr}.people-grid{grid-template-columns:1fr}.form-row>label{width:100%}.form-row input{width:100%}}@media print{header,.schedule-toolbar,.schedule-controls,.schedule-actions,.icon-danger,.payroll-toolbar,.payroll-note{display:none!important}.schedule-page,.standalone{max-width:none;margin:0;padding:0}.week-grid{grid-template-columns:repeat(7,1fr);overflow:visible}.schedule-day{min-height:240px;box-shadow:none}.workload{break-before:page}.shift-row{font-size:10px}}
  </style>${body}</html>`;
}

scheduleDailyBackup();
scheduleOperations();
app.listen(port, () => console.log(`LINE 打卡系統已啟動：http://localhost:${port}`));
