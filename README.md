# LINE 上下班打卡系統

員工加入 LINE 官方帳號後，在聊天室輸入：

- `上班`：記錄上班時間
- `下班`：記錄下班時間
- `今日`：查看今天的紀錄
- `本月`：查看本月出勤天數與累計工時
- `狀態`：查看今天的打卡狀態
- `班表`：查看未來 7 天排班
- `請假 2026-08-20 原因`：提出請假申請
- `我的請假`：查看最近 5 筆申請狀態

系統支援跨日班次；單次班別最多 24 小時。重複上班、沒有上班就下班等異常會直接提示員工。

## 本機啟動

1. 安裝 Node.js 20 或以上版本。
2. 執行 `npm install`。
3. 複製 `.env.example` 為 `.env`，填入 LINE 憑證與管理員密碼。
4. 執行 `npm start`。
5. 開啟 `http://localhost:3000/health`，應顯示 `{ "ok": true }`。

管理頁網址：

`http://localhost:3000/admin`

管理後台支援：

- 安全登入與 30 天登入狀態
- 自訂員工在公司的顯示姓名
- 每人每月出勤天數、總工時與未配對紀錄
- 管理員補登、備註與刪除錯誤紀錄
- 月報表 CSV 匯出
- 未來 30 天排班建立、更新與刪除
- 依個人排班時間判斷遲到
- 請假申請核准／駁回，並由 LINE 自動通知員工

## LINE Developers 設定

1. 建立 LINE Official Account 與 Messaging API channel。
2. 在 Messaging API 頁取得 Channel access token。
3. 在 Basic settings 頁取得 Channel secret。
4. 把服務部署到有 HTTPS 的主機。
5. Webhook URL 設為 `https://你的網域/webhook`，按 Verify 並啟用 Use webhook。
6. 關閉 LINE 官方帳號內建的自動回覆，避免一次收到兩則訊息。

資料儲存在 `data/attendance.db`。正式使用前，建議設定定期備份。
