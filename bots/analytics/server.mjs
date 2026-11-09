#!/usr/bin/env node
// Аналитический дашборд: собирает статистику pump.fun в реальном времени (V3 API)
// HTTP API на порту 3000, фронтенд на bots/analytics/dashboard.html
//
// Использование: node bots/analytics/server.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachBotStatus } from "../../lib/bot-status.mjs";
import { PUMP_PROGRAM } from "../../lib/constants.mjs";
import { ROOT } from "../../lib/config.mjs";
import { eventsFromLogs } from "../../lib/market-events.mjs";
import { paperSnapshot, readOpenPositions } from "../../lib/paper-book.mjs";
import { readTrades, summarize, tradeLogFile } from "../../lib/trade-log.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import { handleApprovalHttp } from "../../lib/approval-http.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANALYTICS_PORT || 3000);

// In-memory state
const stats = {
  startTime: Date.now(),
  totalCreates: 0,
  totalTrades: 0,
  totalBuys: 0,
  totalSells: 0,
  totalVolumeSol: 0,
  flaggedTrades: 0,
  recentTokens: [],    // last 50 creates
  topBuyers: new Map(), // user → { count, volume }
  tokenVolume: new Map(), // mint → volume SOL
  minuteData: [],       // { ts, creates, buys, sells, volume }
};

let currentMinute = { ts: Date.now(), creates: 0, buys: 0, sells: 0, volume: 0 };

function flushMinute() {
  if (currentMinute.creates + currentMinute.buys + currentMinute.sells > 0) {
    stats.minuteData.push({ ...currentMinute });
    if (stats.minuteData.length > 60) stats.minuteData.shift();
  }
  currentMinute = { ts: Date.now(), creates: 0, buys: 0, sells: 0, volume: 0 };
}
setInterval(flushMinute, 60_000);

function parseLogEvents(logs) {
  return eventsFromLogs(logs);
}

function processEvents(parsed) {
  const events = parsed?.events || parsed || [];
  stats.flaggedTrades += parsed?.flagged || 0;
  for (const ev of events) {
    if (ev.type === "flagged") continue;
    if (ev.type === "create") {
      stats.totalCreates++;
      currentMinute.creates++;
      stats.recentTokens.unshift({
        name: ev.mint.slice(0, 8),
        symbol: "?",
        mint: ev.mint,
        creator: ev.creator,
        ts: ev.ts,
      });
      if (stats.recentTokens.length > 50) stats.recentTokens.pop();
    } else if (ev.type === "trade") {
      stats.totalTrades++;
      stats.totalVolumeSol += ev.solAmount;
      currentMinute.volume += ev.solAmount;

      if (ev.isBuy) {
        stats.totalBuys++;
        currentMinute.buys++;
      } else {
        stats.totalSells++;
        currentMinute.sells++;
      }

      const buyer = stats.topBuyers.get(ev.user) || { count: 0, volume: 0 };
      buyer.count++;
      buyer.volume += ev.solAmount;
      stats.topBuyers.set(ev.user, buyer);
      if (stats.topBuyers.size > 5000) {
        const sorted = [...stats.topBuyers.entries()].sort((a, b) => b[1].volume - a[1].volume);
        stats.topBuyers.clear();
        for (const [k, v] of sorted.slice(0, 1000)) stats.topBuyers.set(k, v);
      }

      const tv = stats.tokenVolume.get(ev.mint) || 0;
      stats.tokenVolume.set(ev.mint, tv + ev.solAmount);
      if (stats.tokenVolume.size > 5000) {
        const sorted = [...stats.tokenVolume.entries()].sort((a, b) => b[1] - a[1]);
        stats.tokenVolume.clear();
        for (const [k, v] of sorted.slice(0, 1000)) stats.tokenVolume.set(k, v);
      }
    }
  }
}

// WebSocket listener
const ws = new SolanaWs();
attachBotStatus(ROOT, "analytics", () => ({
  dryRun: true,
  autoBuy: false,
  wsReconnects: ws?.reconnects ?? 0,
  wsLastDataAt: ws?.lastDataAt ?? null,
}));
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  processEvents(parseLogEvents(value.logs));
});

// HTTP server
function getApiResponse() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const topBuyers = [...stats.topBuyers.entries()]
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 20)
    .map(([addr, d]) => ({ addr: addr.slice(0, 12) + "...", count: d.count, volume: d.volume.toFixed(2) }));

  const topTokens = [...stats.tokenVolume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([mint, vol]) => ({ mint: mint.slice(0, 12) + "...", volume: vol.toFixed(2) }));

  return {
    uptime: elapsed.toFixed(0),
    creates: stats.totalCreates,
    trades: stats.totalTrades,
    buys: stats.totalBuys,
    sells: stats.totalSells,
    volume: stats.totalVolumeSol.toFixed(2),
    flagged: stats.flaggedTrades,
    createsPerMin: stats.minuteData.length
      ? (stats.minuteData.reduce((s, m) => s + m.creates, 0) / stats.minuteData.length).toFixed(1)
      : "0",
    tradesPerMin: stats.minuteData.length
      ? (stats.minuteData.reduce((s, m) => s + m.buys + m.sells, 0) / stats.minuteData.length).toFixed(0)
      : "0",
    recentTokens: stats.recentTokens.slice(0, 10),
    topBuyers,
    topTokens,
    minuteData: stats.minuteData,
  };
}

const server = http.createServer((req, res) => {
  if (handleApprovalHttp(req, res)) return;
  if (req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getApiResponse()));
  } else if (req.url === "/api/report" || req.url === "/api/positions") {
    const trades = readTrades(tradeLogFile(ROOT));
    const summary = summarize(trades);
    const open = readOpenPositions(path.join(ROOT, "data", "positions"));
    const body = req.url === "/api/positions"
      ? { open }
      : { summary, paper: paperSnapshot(summary, open) };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(body));
  } else if (req.url === "/" || req.url === "/dashboard.html") {
    const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`[analytics] Dashboard: http://localhost:${PORT}`);
  console.log(`[analytics] API: http://localhost:${PORT}/api/stats`);
  console.log(`[analytics] Listening for pump.fun V3 events...`);
});

process.on("SIGINT", () => {
  ws.close();
  server.close();
  process.exit(0);
});
