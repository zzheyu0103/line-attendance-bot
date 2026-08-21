require('dotenv').config();
const fs = require('fs');
const path = require('path');

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, options, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok) return response;
    const body = await response.text();
    if (response.status !== 429 && response.status < 500) throw new Error(`${response.status}: ${body}`);
    if (attempt === attempts - 1) throw new Error(`${response.status}: ${body}`);
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
    await sleep(retryAfter || 1000 * (2 ** attempt));
  }
}

const headers = { Authorization: `Bearer ${token}` };
const menu = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: '出勤快速選單',
  chatBarText: '打卡選單',
  areas: ['上班', '下班', '今日', '班表'].map((text, index) => ({
    bounds: { x: index * 625, y: 0, width: 625, height: 843 },
    action: { type: 'message', text },
  })),
};

(async () => {
  const created = await request('https://api.line.me/v2/bot/richmenu', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(menu),
  });
  const { richMenuId } = await created.json();
  const image = fs.readFileSync(path.join(__dirname, '..', 'assets', 'rich-menu.png'));
  await request(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: image,
  });
  await request(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST', headers });
  console.log(`已啟用圖文選單：${richMenuId}`);
})().catch((error) => { console.error(error.message); process.exit(1); });
