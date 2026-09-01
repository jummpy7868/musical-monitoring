# 劇場開賣看板

追蹤台灣售票網的音樂劇與舞台劇：**新節目上架就推播到手機**，並提供一個可以隨時翻閱的看板。

解決的問題是「常常已經開賣一陣子才知道有這齣戲」。排程在雲端跑，不需要你主動打開任何東西。

## 運作方式

```
GitHub Actions（每天 09:00 / 21:00）
   └─ node fetch.js
        ├─ 抓 OPENTIX / 寬宏 / udn 售票網
        ├─ 跟上一版 data.json 比對，找出新上架的節目
        ├─ 有新的就推播到 ntfy
        └─ 寫回 data.json 並 commit（用 git 歷史當狀態，不需要資料庫）
                 ↓
        GitHub Pages 提供 index.html，讀 data.json 顯示看板
```

## 部署

**1. 推上 GitHub**

```bash
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main
```

**2. 開啟 GitHub Pages**

Settings → Pages → Source 選 `Deploy from a branch`，分支選 `main`、資料夾選 `/ (root)`。

**3. 設定推播（選用，但這是整個工具的重點）**

手機安裝 [ntfy](https://ntfy.sh/) app，訂閱一個你自己取的 topic 名稱（例如 `my-stage-board-8f3k`，取難猜一點，因為知道名稱的人都能訂閱）。

然後在 repo 的 Settings → Secrets and variables → Actions：

| 類型 | 名稱 | 值 |
|---|---|---|
| Secret | `NTFY_TOPIC` | 你的 topic 名稱 |
| Variable | `BOARD_URL` | 看板網址，推播點擊時會開啟（選用） |

**4. 手動跑一次**

Actions → 抓取售票資料 → Run workflow。第一次執行是初次建檔，不會推播。

**5. 加到手機主畫面**

用手機瀏覽器開啟看板網址，選「加入主畫面」，就會像一個 App。

## 本機執行

需要 Node 18 以上（用到內建的 `fetch`）。沒有任何套件相依。

```bash
node test.js    # 純邏輯自我檢查
node fetch.js   # 抓資料，寫入 data.json
```

看板要透過 HTTP 開啟才讀得到 `data.json`，直接用檔案路徑開會被瀏覽器擋下來：

```bash
npx serve
```

## 資料來源

| 來源 | 端點 | 分類方式 |
|---|---|---|
| OPENTIX | `POST search.opentix.life/search` | `categoryFilter: ["戲劇-音樂劇","戲劇-現代戲劇"]`，伺服器端就篩好 |
| 寬宏 | `UTK01/UTK0101_06.aspx?TYPE=1&CATEGORY=` | `80`=音樂劇 `116`=戲劇 `139`=國外 |
| udn售票網 | `UTK01/UTK0101_03.aspx?Category=116` | 只有「戲劇」一個分類，音樂劇與舞台劇靠標題關鍵字分 |

寬宏和 udn 用的是同一套售票系統，分類代碼共用（`77`=音樂 `100`=舞蹈 `129`=親子 `205`=演唱會 `231`=展覽），但**頁面路徑和參數大小寫不同**，所以 parser 各寫一支。

國外音樂劇來台會落在寬宏 `CATEGORY=80` 和 udn `Category=116`（歷史上《獅子王》《悲慘世界》《日落大道》都在寬宏，現在 udn 有《倫敦全本音樂劇〈史瑞克〉》）。

分類一律以售票網的官方分類為準，不用關鍵字過濾 —— 實測 600 筆 OPENTIX 節目，官方分類「戲劇」151 筆，改用標題加內文關鍵字會撈出 334 筆，誤收超過一倍（「導演」「演員」「劇場」在展覽和音樂會的介紹文裡到處都是）。

## 已知限制

**拿不到開賣前預告。** OPENTIX 的搜尋索引只收已經開賣的節目（全站 1017 檔，沒有一檔的開賣時間在未來），所以它的節目最快只能在開賣當天知道，延遲最多 12 小時。寬宏和 udn 是傳統售票系統，節目頁很可能會先掛出來，但目前樣本不足以確認。

每檔節目都會記錄 `firstSeen`（首次被抓到的日期）。跑一段時間後把它跟 `saleStart` 一比，就知道各站實際提前多久上架 —— 這是唯一能回答這個問題的方式。初次建檔的節目 `firstSeen` 記為 `null`，因為當下確實不知道它們何時上架。

**「開賣中」不代表還有票。** 售票網的列表頁不標示售完，要知道實際票況得逐一進購票頁，成本高一個量級，目前不做。

**售票網改版會讓對應的 parser 失效。** 每站各自 `try/catch`，壞一站不影響其他站；三站全掛才會中止且不覆寫 `data.json`。Actions 失敗會寄信通知。

## 沒有收錄的來源

- **拓元 tixcraft** — 實測首頁 36 檔節目，音樂劇與舞台劇 0 檔，主力是演唱會和體育賽事
- **KKTIX** — 全站 `events.json` 100 筆 0 命中，幾乎都是技術聚會。要用的話得改成訂閱特定劇團的子網域（`<劇團>.kktix.cc/events.json`）

## 檔案

| 檔案 | 用途 |
|---|---|
| `fetch.js` | 三站抓取、正規化、比對、推播 |
| `test.js` | 純邏輯自我檢查，不打網路 |
| `index.html` | 看板，讀 `data.json` |
| `data.json` | 目前的節目快照，由 Actions 更新 |
| `.github/workflows/watch.yml` | 排程 |
