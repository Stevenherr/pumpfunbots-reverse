#!/usr/bin/env node
// Local approval CLI. Changes data/approvals.json only. Never signs or sends.
//
//   node bots/approve.mjs list
//   node bots/approve.mjs approve <id>
//   node bots/approve.mjs reject <id>

import { decide, defaultApprovalFile, listProposals } from "../lib/approval.mjs";

const [cmd, id] = process.argv.slice(2);
const file = defaultApprovalFile();

function printItem(item) {
  const rug = item.rugCheck?.ok ? "rug ok" : `rug ${ (item.rugCheck?.reasons || []).join(", ") }`;
  console.log(`${item.status.padEnd(11)} ${item.id}  ${item.bot}  ${item.amountSol} SOL  ${item.mint}`);
  console.log(`  reason: ${item.reason}`);
  console.log(`  ${rug}`);
  console.log(`  expires: ${new Date(item.expiresAt).toISOString()}`);
}

if (cmd === "list") {
  const items = listProposals(file);
  if (!items.length) {
    console.log(`no proposals in ${file}`);
  } else {
    for (const item of items) printItem(item);
  }
} else if ((cmd === "approve" || cmd === "reject") && id) {
  const status = cmd === "approve" ? "approved" : "rejected";
  const result = decide(file, id, status);
  if (!result.ok) {
    console.error(`cannot ${cmd} ${id}: ${result.error}`);
    process.exit(1);
  }
  console.log(`${status} ${id}`);
  printItem(result.item);
} else {
  console.log("Usage: node bots/approve.mjs list | approve <id> | reject <id>");
  process.exit(cmd ? 1 : 0);
}
