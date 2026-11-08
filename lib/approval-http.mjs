import { decide, defaultApprovalFile, listProposals } from "./approval.mjs";

export function isLoopback(req) {
  const address = req.socket?.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// Local dashboard only changes the queue file. It never signs or sends a transaction.
export function handleApprovalHttp(req, res, opts = {}) {
  const file = opts.file || defaultApprovalFile();
  let pathname = req.url || "/";
  const query = pathname.indexOf("?");
  if (query !== -1) pathname = pathname.slice(0, query);

  if (pathname === "/api/approvals" && req.method === "GET") {
    const proposals = listProposals(file);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ proposals }));
    return true;
  }

  const match = pathname.match(/^\/api\/approvals\/([a-f0-9]+)\/(approve|reject)$/);
  if (match && req.method === "POST") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "local_only" }));
      return true;
    }
    const status = match[2] === "approve" ? "approved" : "rejected";
    const result = decide(file, match[1], status);
    res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
    return true;
  }

  return false;
}
