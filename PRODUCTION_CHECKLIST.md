# 正式交付檢查表

## 主機與資料

- [ ] 正式網域使用 HTTPS，LINE Webhook Verify 成功且已啟用
- [ ] Render 升級為可掛載 Persistent Disk 的方案
- [ ] Persistent Disk 掛載路徑為 `/data`
- [ ] `DATA_DIR`、`BACKUP_DIR`、`REPORT_DIR` 都指向 `/data` 內
- [ ] 從後台建立一次手動備份並實際下載開啟

## 權限與隱私

- [ ] 更換 owner 強密碼，不以網址參數分享密碼
- [ ] 為朋友建立獨立 manager 帳號；只查看的人使用 viewer
- [ ] 設定隱私聯絡窗口與定位保存天數
- [ ] 將 `/privacy` 提供給員工，確認員工在 LINE 完成定位同意
- [ ] 確認停權、離職員工無法繼續打卡

## 營運設定

- [ ] 建立所有 GPS 據點並在現場測試範圍內／範圍外打卡
- [ ] 設定主管 LINE User ID，確認主管已加官方帳號好友
- [ ] 建立國定假日與倍率
- [ ] 設定休息分鐘、標準工時、加班倍率與每位員工薪資
- [ ] 建立跨日班、請假、忘記下班等測試案例
- [ ] 下載 CSV 與 Excel，人工核對至少兩位員工計算結果

## 交付

- [ ] 交付官方帳號、LINE Developers、GitHub 與 Render 的擁有權或管理權
- [ ] 不以聊天訊息傳送 Access Token、Channel Secret 或管理員密碼
- [ ] 記錄例行備份、每月報表與異常處理負責人
- [ ] 約定保固期、客製修改範圍與主機月費由誰負擔
