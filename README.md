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

- owner／manager／viewer 多管理員角色與 30 天安全登入狀態
- 自訂員工在公司的顯示姓名
- 員工核准、停權、員工編號、部門、到離職日與薪資資料
- 每人每月出勤、工時、遲到、早退與未配對紀錄
- 管理員補登、修改及刪除，並保存完整稽核紀錄
- CSV、Excel 薪資報表與每月自動產生
- 週班表、批次排班、班別模板、複製上週與人力警示
- 依個人排班時間判斷遲到
- 請假申請核准／駁回，並由 LINE 自動通知員工
- 多據點 GPS 圍欄、員工定位同意與定位資料自動到期
- 國定假日及個別倍率設定
- 忘記下班、未依排班與連續打卡的主管 LINE 通知
- 每日資料庫備份、手動備份與保存期限

## LINE Developers 設定

1. 建立 LINE Official Account 與 Messaging API channel。
2. 在 Messaging API 頁取得 Channel access token。
3. 在 Basic settings 頁取得 Channel secret。
4. 把服務部署到有 HTTPS 的主機。
5. Webhook URL 設為 `https://你的網域/webhook`，按 Verify 並啟用 Use webhook。
6. 關閉 LINE 官方帳號內建的自動回覆，避免一次收到兩則訊息。

資料預設儲存在 `data/attendance.db`，可用 `DATA_DIR` 指定永久磁碟路徑。系統每日 03:00 自動備份，並可在 `/admin/backups` 手動建立或下載備份。正式環境必須把 `/data` 掛載到主機的永久磁碟。

## 正式部署必要設定

- `DATA_DIR=/data`、`BACKUP_DIR=/data/backups`、`REPORT_DIR=/data/reports`
- Render 掛載 Persistent Disk 到 `/data`（免費方案不支援永久磁碟，重新部署可能遺失 SQLite 資料）
- 後台「GPS 據點」至少建立一個啟用據點，才可開啟強制定位
- 後台設定主管 LINE User ID，才會收到異常與月報通知
- 管理員需向員工提供 `/privacy` 隱私說明；員工輸入「同意定位」後才可 GPS 打卡
- 上線前執行 `npm run check && npm test && npm audit --omit=dev`

詳細交付檢查請見 [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md)。
