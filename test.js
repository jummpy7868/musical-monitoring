// 自我檢查：node test.js
// 只測純邏輯（分類、開賣時間解析、狀態判定、firstSeen 合併），不打網路。
"use strict";

const assert = require("assert");
const { isMusical, parseSaleTime, statusOf, mergeFirstSeen, encodeHeader } = require("./fetch.js");

const DAY = 864e5;
const NOW = Date.UTC(2026, 8, 1); // 2026-09-01

// --- 標題判斷音樂劇（udn 唯一需要的地方）---
assert.equal(isMusical("躍演《勸世三姊妹》中文音樂劇"), true);
assert.equal(isMusical("倫敦全本音樂劇《史瑞克》"), true);
assert.equal(isMusical("Broadway Musical CATS"), true);
assert.equal(isMusical("舞台劇《都更男女》"), false);
assert.equal(isMusical("金枝演社《有佇咧無》"), false);
assert.equal(isMusical(null), false);

// --- 寬宏詳情頁的開賣時間 ---
// 台灣中午 12 點 = UTC 04:00
assert.equal(parseSaleTime("開賣時間：2026年04月22日(三)中午12點。"), Date.UTC(2026, 3, 22, 4));
assert.equal(parseSaleTime("售票時間：2026年12月01日 上午10點"), Date.UTC(2026, 11, 1, 2));
assert.equal(parseSaleTime("開賣時間：2026年3月5日下午2點"), Date.UTC(2026, 2, 5, 6));
// 沒寫幾點就當中午
assert.equal(parseSaleTime("開賣時間：2026年04月22日(三)12:"), Date.UTC(2026, 3, 22, 4));
// 解不出來要回 null，不能亂猜
assert.equal(parseSaleTime("本節目可使用文化幣購票。"), null);
assert.equal(parseSaleTime(""), null);
assert.equal(parseSaleTime(null), null);

// --- 狀態判定 ---
const at = d => NOW + d * DAY;
assert.equal(statusOf({ saleStart: at(3), showStart: at(30), showEnd: at(31) }, NOW), "upcoming");
assert.equal(statusOf({ saleStart: at(-3), showStart: at(30), showEnd: at(31) }, NOW), "onsale");
assert.equal(statusOf({ saleStart: at(-30), showStart: at(-9), showEnd: at(-8) }, NOW), "ended");
// 寬宏/udn 常常沒有 saleStart，不能因此被當成未開賣而藏起來
assert.equal(statusOf({ saleStart: null, showStart: at(30), showEnd: at(31) }, NOW), "onsale");
// 只有單日演出（showEnd 缺）也要能判斷已結束
assert.equal(statusOf({ saleStart: null, showStart: at(-5), showEnd: null }, NOW), "ended");
// 演出日期完全未知的先留著，不要誤刪
assert.equal(statusOf({ saleStart: null, showStart: null, showEnd: null }, NOW), "onsale");

// --- firstSeen 合併：舊的要留住，新的才算 fresh ---
const previous = [{ id: "a", firstSeen: "2026-08-20" }, { id: "b", firstSeen: null }];
const r = mergeFirstSeen([{ id: "a" }, { id: "b" }, { id: "c" }], previous, "2026-09-01");
assert.equal(r.items.find(x => x.id === "a").firstSeen, "2026-08-20", "既有節目要沿用舊日期");
assert.equal(r.items.find(x => x.id === "b").firstSeen, null, "建檔批次的 null 也要沿用，不能被改寫成今天");
assert.equal(r.items.find(x => x.id === "c").firstSeen, "2026-09-01");
assert.deepEqual(r.fresh.map(x => x.id), ["c"], "只有沒見過的算新上架");

// 初次建檔：不算新上架，firstSeen 記 null（不知道何時上架，不要假裝是今天）
const first = mergeFirstSeen([{ id: "x" }, { id: "y" }], [], "2026-09-01");
assert.equal(first.fresh.length, 0, "初次建檔不該推播");
assert.equal(first.items[0].firstSeen, null, "初次建檔的 firstSeen 是未知");

// --- 推播標題編碼：HTTP header 只能放 ASCII，中文直接塞會變亂碼 ---
assert.equal(encodeHeader("新上架 3 檔"), "=?UTF-8?B?" + Buffer.from("新上架 3 檔","utf8").toString("base64") + "?=");
assert.ok(
  [...encodeHeader("新上架 3 檔")].every(c => c.charCodeAt(0) < 128),
  "編碼後必須全是 ASCII，否則 header 送不出去，ntfy 會顯示亂碼"
);
assert.equal(encodeHeader("New shows: 3"), "New shows: 3", "純 ASCII 不用編碼");
assert.equal(encodeHeader(""), "");

console.log("全部通過");
