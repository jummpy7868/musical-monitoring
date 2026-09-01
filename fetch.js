// 抓 OPENTIX / 寬宏 / udn 售票網的音樂劇與舞台劇，正規化後寫進 data.json。
// 每站各自 try/catch，壞一站不影響其他站。
// 執行：node fetch.js       推播：設環境變數 NTFY_TOPIC
"use strict";

const fs = require("fs");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DATA_FILE = "data.json";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getText = async url => (await fetch(url, { headers: { "User-Agent": UA } })).text();

// ---------- 純函式：可單獨測試，見 test.js ----------

// udn 不分音樂劇和舞台劇，只能看標題。寬宏和 OPENTIX 有官方分類，這只用來覆寫。
const isMusical = title => /音樂劇|musical/i.test(title || "");

// OPENTIX 的 categories 是主辦自己勾的、可複選、常常亂勾——演唱會和合唱團音樂會
// 都看過被掛上「戲劇-音樂劇」。displayCategory 才是 OPENTIX 判定的主分類，準得多。
//
// 但只認 displayCategory 會誤殺真的音樂劇：《太空阿嬤》音樂劇、寶塚 OG、誠品親子
// 音樂劇都被歸在「音樂」或「親子」底下。所以主分類是戲劇就收，不是的話要標題
// 明講才收。刻意不放「劇場」——那會誤中場館名和「劇場開箱」這種活動。
const RESCUE = /音樂劇|musical|舞台劇|劇團|寶塚/i;
const isTheatre = (displayCategory, title) =>
  displayCategory === "戲劇" || RESCUE.test(title || "");

// 音樂劇 vs 舞台劇只看標題，不看 categories。
//
// 主辦勾的「戲劇-音樂劇」不能用來分這一刀：實測 150 檔裡有 14 檔只有分類標、
// 標題沒講，其中包含兩檔布袋戲、一檔兒童劇和一場「部分發表會」。台灣的劇名
// 幾乎都會把「音樂劇」寫進去（《勸世三姊妹》中文音樂劇、C MUSICAL 韓國授權
// 音樂劇⋯），所以標題反而是最可靠的訊號。
//
// 代價是標題沒寫的真音樂劇會被歸到舞台劇——兩者都在看板上，只是分組不同，
// 比起把布袋戲標成音樂劇，這個方向的錯誤便宜得多。
const kindOf = (categories, title) => (isMusical(title) ? "音樂劇" : "舞台劇");

// 寬宏詳情頁把開賣時間寫在自由文字裡：「開賣時間：2026年04月22日(三)中午12點」
// 回傳 epoch ms（台灣時間 UTC+8），解不出來回 null。
function parseSaleTime(text) {
  const m = String(text || "").match(
    // [^\d]{0,8}? 必須非貪婪：貪婪版會把「下午」一起吃掉，時段就判斷不出來了
    /(?:開賣|啟售|開始售票|售票)時間[：: ]*(\d{4})年(\d{1,2})月(\d{1,2})日[^\d]{0,8}?(上午|中午|下午|晚上)?\s*(\d{1,2})?\s*[點:時]/
  );
  if (!m) return null;
  let h = m[5] == null ? 12 : +m[5];
  if ((m[4] === "下午" || m[4] === "晚上") && h < 12) h += 12;
  if (m[4] === "上午" && h === 12) h = 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h - 8, 0, 0); // -8 換算回 UTC
}

// 節目狀態。saleStart 為 null 時當作已開賣 —— 寬宏和 udn 常常沒有這個欄位，
// 而它們的節目出現在清單上時通常已經可以買了。
function statusOf(item, now = Date.now()) {
  const end = toMs(item.showEnd) || toMs(item.showStart);
  if (end && end < now) return "ended";
  if (item.saleStart && item.saleStart > now) return "upcoming";
  return "onsale";
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v).replace(/\//g, "-"));
  return Number.isNaN(t) ? null : t;
}

// HTTP header 只能放 ASCII。含非 ASCII 的字串照 RFC 2047 編成 =?UTF-8?B?...?=，
// 純 ASCII 就原樣送出（編了反而多一層雜訊）。
function encodeHeader(s) {
  const str = String(s == null ? "" : s);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(str)) return str;
  return "=?UTF-8?B?" + Buffer.from(str, "utf8").toString("base64") + "?=";
}

// 從標記清單裡挑出「還有幾天就演出」的節目。
// 只在剛好跨過門檻的那一天提醒（前一次執行時還沒進入區間），否則會連續七天每天吵。
function dueReminders(items, watchlist, daysAhead = 7, now = Date.now(), lastRun = 0) {
  const marked = new Set(watchlist || []);
  const window = daysAhead * 864e5;
  return items.filter(it => {
    if (!marked.has(it.id)) return false;
    const t = toMs(it.showStart);
    if (!t || t < now) return false;
    const enteredNow = t - now <= window;
    const enteredBefore = lastRun > 0 && t - lastRun <= window;
    return enteredNow && !enteredBefore;
  });
}

// 把上次的 firstSeen 帶過來，沒見過的記今天。回傳 { items, fresh }。
//
// 第一次執行（沒有舊檔）是初次建檔，不是有新戲：firstSeen 記成 null，代表
// 「建檔時就已經在了，不知道何時上架」。硬記成今天會讓畫面整片標成新上架、
// 推播一次噴掉全部節目，而且那個日期是假的。「售票網提前多久上架」這個問題
// 本來也只能靠建檔之後才發現的節目來回答。
function mergeFirstSeen(items, previous, today) {
  const prev = new Map((previous || []).map(p => [p.id, p.firstSeen]));
  const isBaseline = prev.size === 0;
  const fresh = [];
  for (const it of items) {
    if (isBaseline) {
      it.firstSeen = null;
      continue;
    }
    it.firstSeen = prev.has(it.id) ? prev.get(it.id) : today;
    if (!prev.has(it.id)) fresh.push(it);
  }
  return { items, fresh };
}

// ---------- 各站抓取 ----------

// OPENTIX：非公開的搜尋 API，categoryFilter 只吃二級分類名，伺服器端就篩好。
async function opentix() {
  const now = Date.now();
  const out = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const res = await fetch("https://search.opentix.life/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        language: "zh-CHT",
        sortBy: "ABOUT_TO_BEGIN",
        pageSize: 100,
        offset,
        categoryFilter: ["戲劇-音樂劇", "戲劇-現代戲劇"],
        programTimeRangeFilter: { from: now, to: now + 365 * 864e5 }
      })
    });
    if (!res.ok) throw new Error("OPENTIX HTTP " + res.status);
    const found = (await res.json()).result?.found || [];
    if (!found.length) break;
    for (const { source: s } of found) {
      if (!isTheatre(s.displayCategory, s.title)) continue;
      out.push({
        id: "opentix:" + s.id,
        source: "OPENTIX",
        title: s.title,
        kind: kindOf(s.categories, s.title),
        saleStart: s.onlineStartDateTime || null,
        showStart: s.startDateTime || null,
        showEnd: s.endDateTime || null,
        venue: (s.eventVenues || [])[0]?.name || "",
        priceMin: s.minPrice ?? null,
        priceMax: s.maxPrice ?? null,
        image: s.imageUrl || "",
        url: "https://www.opentix.life/event/" + s.id
      });
    }
    await sleep(300);
  }
  return out;
}

// 寬宏：80=音樂劇 116=戲劇 139=國外。列表頁只有劇名和圖，其餘要進詳情頁。
async function kham() {
  const out = [];
  for (const [category, kind] of [[80, "音樂劇"], [116, "舞台劇"], [139, "舞台劇"]]) {
    const html = await getText(
      `https://kham.com.tw/application/UTK01/UTK0101_06.aspx?TYPE=1&CATEGORY=${category}`
    );
    const re = /PRODUCT_ID=([A-Z0-9]+)"[\s\S]{0,600}?<span class="title">([^<]+)</g;
    let m;
    while ((m = re.exec(html))) {
      const title = m[2].trim();
      if (!/[一-鿿]/.test(title)) continue;
      const img = (html.match(new RegExp(m[1] + "_RWD\\.[A-Za-z]+\\?v=\\d+")) || [])[0];
      out.push({
        id: "kham:" + m[1],
        source: "寬宏",
        title,
        kind: isMusical(title) ? "音樂劇" : kind,
        saleStart: null,
        showStart: null,
        showEnd: null,
        venue: "",
        priceMin: null,
        priceMax: null,
        image: img ? "https://imgs2.utiki.com.tw/Data/KHAM/Images/UTK2401/" + img : "",
        url: "https://kham.com.tw/application/UTK02/UTK0201_.aspx?PRODUCT_ID=" + m[1]
      });
    }
    await sleep(400);
  }
  return out;
}

// udn 售票網：沒有獨立的音樂劇分類，音樂劇和舞台劇都在 116 戲劇底下，靠標題分。
// 注意頁面是 UTK0101_03（不是 _06），參數是 Category（不是 CATEGORY）。
async function udn() {
  const html = await getText(
    "https://tickets.udnfunlife.com/application/UTK01/UTK0101_03.aspx?Category=116"
  );
  const out = [];
  const re = /PRODUCT_ID=([A-Z0-9]+)'[\s\S]{0,1600}?yd_card-title[^>]*>([^<]+)<[\s\S]{0,900}?yd_card-iconText'>([\s\S]{0,400}?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = m[2].trim();
    const parts = m[3].replace(/<[^>]*>/g, "|").split("|").map(s => s.trim()).filter(Boolean);
    const dates = (parts.find(x => /\d{4}\/\d{2}\/\d{2}/.test(x)) || "").split("~").map(s => s.trim());
    const prices = (parts.find(x => /NT ?\$/.test(x)) || "").match(/[\d,]+/g) || [];
    const num = s => (s ? +s.replace(/,/g, "") : null);
    out.push({
      id: "udn:" + m[1],
      source: "udn售票網",
      title,
      kind: isMusical(title) ? "音樂劇" : "舞台劇",
      saleStart: null, // 列表頁沒有，補在 fillSaleTime()
      showStart: dates[0] || null,
      showEnd: dates[1] || dates[0] || null,
      venue: parts.find(x => /(廳|院|館|堂|中心|劇場|劇院)$/.test(x)) || "",
      priceMin: num(prices[0]),
      priceMax: num(prices[1]),
      image: "",
      url: "https://tickets.udnfunlife.com/application/UTK02/UTK0201_.aspx?PRODUCT_ID=" + m[1]
    });
  }
  return out;
}

// 寬宏和 udn 的開賣時間只寫在詳情頁自由文字裡。只查沒有 saleStart 的新節目——
// 已經查過的會保留結果，所以穩定運作後每天只有個位數請求。
async function fillSaleTime(items, known) {
  const targets = items.filter(it => !it.saleStart && !known.has(it.id));
  for (const it of targets.slice(0, 30)) {
    try {
      const html = await getText(it.url);
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      const t = parseSaleTime(text);
      if (t) it.saleStart = t;
    } catch (e) {
      // 單一節目讀不到就跳過，不影響整批
    }
    await sleep(500);
  }
}

// ---------- 推播 ----------

async function push(title, body, tag) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return console.error("（未設 NTFY_TOPIC，略過推播）");
  const res = await fetch("https://ntfy.sh/" + topic, {
    method: "POST",
    headers: {
      // 標題是 HTTP header，只能放 ASCII，中文要照 RFC 2047 編碼，
      // 直接塞中文進去 ntfy 會顯示亂碼。訊息內文則是 UTF-8，不用處理。
      Title: encodeHeader(title),
      Tags: tag,
      Click: process.env.BOARD_URL || "https://ntfy.sh"
    },
    body
  });
  console.error(res.ok ? `已推播：${title}` : "推播失敗 HTTP " + res.status);
}

async function notify(fresh, due) {
  if (fresh.length) {
    const lines = fresh.slice(0, 10).map(p => `${p.kind === "音樂劇" ? "🎵" : "🎭"} ${p.title}`);
    if (fresh.length > 10) lines.push(`⋯ 另外還有 ${fresh.length - 10} 檔`);
    await push(`新上架 ${fresh.length} 檔`, lines.join("\n"), "performing_arts");
  }
  if (due.length) {
    const lines = due.map(p => {
      const d = new Date(toMs(p.showStart) + 8 * 3600e3);
      return `${d.getMonth() + 1}/${d.getDate()} ${p.title}${p.venue ? "　" + p.venue : ""}`;
    });
    await push(`你標記的戲快演了（${due.length} 檔）`, lines.join("\n"), "bell");
  }
}

// ---------- 主流程 ----------

async function main() {
  const jobs = [["OPENTIX", opentix], ["寬宏", kham], ["udn", udn]];
  const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));

  let items = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      console.error(`  ${jobs[i][0]}：${r.value.length} 檔`);
      items = items.concat(r.value);
    } else {
      failed++;
      console.error(`  ${jobs[i][0]}：失敗 — ${r.reason}`);
    }
  });
  if (failed === jobs.length) throw new Error("三個來源全部失敗，不覆寫 data.json");

  let previous = [];
  let lastRun = 0;
  try {
    const old = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    previous = old.items || [];
    lastRun = old.updated || 0;
  } catch (e) {
    // 第一次執行還沒有檔案
  }

  let watchlist = [];
  try {
    watchlist = JSON.parse(fs.readFileSync("watchlist.json", "utf8"));
  } catch (e) {
    // 沒有標記清單就只推「新上架」
  }

  // 已知節目的 saleStart 直接沿用，省掉重複的詳情頁請求
  const known = new Map(previous.filter(p => p.saleStart).map(p => [p.id, p.saleStart]));
  items.forEach(it => {
    if (!it.saleStart && known.has(it.id)) it.saleStart = known.get(it.id);
  });
  await fillSaleTime(items, known);

  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣日期
  const { fresh } = mergeFirstSeen(items, previous, today);
  items.forEach(it => (it.status = statusOf(it)));

  const live = items.filter(it => it.status !== "ended");
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ updated: Date.now(), count: live.length, items: live }, null, 1)
  );
  console.error(
    `\n共 ${live.length} 檔（音樂劇 ${live.filter(i => i.kind === "音樂劇").length}）` +
      `，其中即將開賣 ${live.filter(i => i.status === "upcoming").length} 檔，今天新上架 ${fresh.length} 檔`
  );

  const due = dueReminders(live, watchlist, 7, Date.now(), lastRun);
  if (watchlist.length) console.error(`標記 ${watchlist.length} 檔，其中 ${due.length} 檔即將演出`);
  await notify(fresh.filter(f => live.includes(f)), due);
}

module.exports = { isMusical, isTheatre, kindOf, parseSaleTime, statusOf, mergeFirstSeen, dueReminders, toMs, encodeHeader };

if (require.main === module) {
  main().catch(e => {
    console.error("執行失敗：", e.message);
    process.exit(1);
  });
}
