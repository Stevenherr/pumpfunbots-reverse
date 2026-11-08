"""SYNTHETIC safety campaign. No network, no keys, no wallet.

Mirrors the JS rug-check defaults and the 0.94 fill-price stop.
This is play money. It does not run the bots and it does not quote a market.
"""

from __future__ import annotations

from decimal import Decimal

import harness

D = Decimal

THRESHOLDS = {
    "reject_mint_authority": True,
    "reject_freeze_authority": True,
    "max_top_holder_pct": D("20"),
    "max_dev_buy_share_pct": D("10"),
    "max_creator_launches": 3,
    "max_creator_rugs": 0,
    "max_creator_signatures": 0,
    "min_real_sol": D("0.4"),
    "fail_closed": True,
}
STOP_RATIO = D("0.94")
TAKE_PROFIT_RATIO = D("2")
START_SOL = D("1.00")
BUY_SOL = D("0.05")


def fmt_pct(value: Decimal) -> str:
    return f"{D(value):.2f}"


def fmt_sol(value: Decimal) -> str:
    return f"{D(value):.4f}"


def evaluate_rug(signals: dict, thresholds: dict | None = None) -> list[str]:
    rules = thresholds or THRESHOLDS
    if signals.get("rate_limited"):
        return ["rate_limited_defer"]
    reasons: list[str] = []
    if signals.get("unavailable") and rules["fail_closed"]:
        reasons.append(f"rug_data_unavailable: {signals['unavailable']}")
    closed = bool(rules["fail_closed"])

    mint_set = signals.get("mint_authority_set")
    if mint_set is None:
        if closed and rules["reject_mint_authority"]:
            reasons.append("mint_authority_unknown")
    elif mint_set and rules["reject_mint_authority"]:
        reasons.append("mint_authority_still_set")

    freeze_set = signals.get("freeze_authority_set")
    if freeze_set is None:
        if closed and rules["reject_freeze_authority"]:
            reasons.append("freeze_authority_unknown")
    elif freeze_set and rules["reject_freeze_authority"]:
        reasons.append("freeze_authority_still_set")

    holder = signals.get("top_holder_pct")
    if holder is None:
        if closed:
            reasons.append("top_holder_unknown")
    elif D(holder) > rules["max_top_holder_pct"]:
        reasons.append(
            f"top_holder_pct {fmt_pct(holder)} > {fmt_pct(rules['max_top_holder_pct'])}"
        )

    dev = signals.get("dev_buy_share_pct")
    if dev is not None and D(dev) > rules["max_dev_buy_share_pct"]:
        reasons.append(
            f"dev_buy_share_pct {fmt_pct(dev)} > {fmt_pct(rules['max_dev_buy_share_pct'])}"
        )

    launches = signals.get("creator_launches")
    if launches is not None and launches > rules["max_creator_launches"]:
        reasons.append(f"creator_launches {launches} > {rules['max_creator_launches']}")

    rugs = signals.get("creator_rugs")
    if rugs is not None and rugs > rules["max_creator_rugs"]:
        reasons.append(f"creator_rugs {rugs} > {rules['max_creator_rugs']}")

    # A full signature page is a lookup cap, not a count. Only an uncapped
    # sample can trip the optional raw-signature rule, and that rule is off
    # when max_creator_signatures is 0.
    signatures = signals.get("creator_signatures")
    if (
        not signals.get("creator_signatures_capped")
        and rules["max_creator_signatures"] > 0
        and signatures is not None
        and signatures > rules["max_creator_signatures"]
    ):
        reasons.append(
            f"creator_signatures {signatures} > {rules['max_creator_signatures']}"
        )

    real_sol = signals.get("real_sol")
    if real_sol is None:
        if closed:
            reasons.append("liquidity_unknown")
    elif D(real_sol) < rules["min_real_sol"]:
        reasons.append(
            f"thin_liquidity_sol {fmt_sol(real_sol)} < {fmt_sol(rules['min_real_sol'])}"
        )
    return reasons


class ApprovalQueue:
    """In-memory stand-in for the local approval file. Nothing is signed."""

    def __init__(self) -> None:
        self.now = 0
        self.ttl = 180
        self.items: list[dict] = []
        self.seq = 0

    def propose(self, mint: str, amount: str, reason: str) -> dict:
        self.seq += 1
        item = {
            "id": f"{self.seq:04d}",
            "mint": mint,
            "amount": amount,
            "reason": reason,
            "status": "pending",
            "expires": self.now + self.ttl,
        }
        self.items.append(item)
        return item

    def decide(self, item_id: str, status: str) -> str:
        item = next(entry for entry in self.items if entry["id"] == item_id)
        if item["status"] == "pending" and item["expires"] <= self.now:
            item["status"] = "expired"
            return "expired"
        if item["status"] != "pending":
            return item["status"]
        item["status"] = status
        return status

    def expire_due(self) -> None:
        for item in self.items:
            if item["status"] == "pending" and item["expires"] <= self.now:
                item["status"] = "expired"


def is_deferred(signals: dict) -> bool:
    return bool(signals.get("rate_limited"))


def sniper_launch(
    real_sol,
    *,
    seen: bool = False,
    stopped: bool = False,
    cooldown_until: int = 0,
    now: int = 0,
    held_by_other: bool = False,
    max_real: Decimal = D("12"),
) -> str:
    if held_by_other:
        return "held_by_other_bot"
    if stopped:
        return "reentry_after_stop"
    if cooldown_until and now < cooldown_until:
        return "token_cooldown"
    if seen:
        return "already_seen"
    if real_sol is None:
        return "curve_unknown"
    if real_sol > max_real:
        return "curve_not_fresh"
    return "buy"


def quiet_timeout(timeout_s: int = 120, sweep_s: int = 1) -> dict:
    """No prices at all. The wall-clock sweep closes on the first tick at or after timeout."""
    close_after = timeout_s + sweep_s
    return {
        "timeout_s": timeout_s,
        "closed_after_s": close_after,
        "late_by_s": close_after - timeout_s,
        "stale_price": True,
        "still_open_before": timeout_s - 1,
    }


def first_visible_stop(marks: list[Decimal], trigger: Decimal) -> Decimal:
    for mark in marks:
        if mark <= trigger:
            return mark
    return marks[-1]


def entry_decision(
    *,
    now: int,
    first_ts: int | None,
    first_spot: Decimal | None,
    spot: Decimal,
    fill_pct: Decimal,
    confirm_sec: int = 8,
    max_dip: Decimal = D("0.02"),
    blocked: bool = False,
    cooldown_until: int = 0,
    min_fill: Decimal = D("92"),
) -> str:
    if blocked:
        return "reentry_after_stop"
    if cooldown_until and now < cooldown_until:
        return "token_cooldown"
    if fill_pct < min_fill or fill_pct >= 100:
        return "outside_fill_band"
    if first_ts is None or first_spot is None:
        return "arm"
    if now - first_ts < confirm_sec:
        return "wait"
    if max_dip > 0 and first_spot > 0 and (first_spot - spot) / first_spot > max_dip:
        return "confirm_dip"
    return "buy"


def clean_token(**overrides: object) -> dict:
    base: dict = {
        "mint_authority_set": False,
        "freeze_authority_set": False,
        "top_holder_pct": D("2"),
        "dev_buy_share_pct": D("1"),
        "creator_launches": 1,
        "creator_signatures": 4,
        "real_sol": D("2"),
    }
    base.update(overrides)
    return base


def drive_exit(book: harness.ProposedBook, curve: harness.Curve, mint: str, ratios: list[Decimal]):
    position = book.positions[mint]
    fill = position.sol_in / position.tokens
    for ratio in ratios:
        if ratio <= STOP_RATIO or ratio >= TAKE_PROFIT_RATIO:
            curve.set_spot(fill * ratio)
            reason = "stop_loss" if ratio <= STOP_RATIO else "take_profit"
            return book.try_sell(mint, curve, reason=reason), fill
    curve.set_spot(fill * ratios[-1])
    return book.try_sell(mint, curve, reason="timeout"), fill


def run_campaign() -> dict:
    book = harness.ProposedBook(
        START_SOL,
        stop_ratio=STOP_RATIO,
        take_profit_ratio=TAKE_PROFIT_RATIO,
    )
    queue = ApprovalQueue()
    rejected = []
    deferred = []
    approval_rejected = []
    approval_expired = []
    trades = []
    auto_rejected = []
    auto_buys = 0
    human_buys = 0

    cases = [
        ("MINTAUTH", clean_token(mint_authority_set=True), "approve", None),
        ("FREEZEAUTH", clean_token(freeze_authority_set=True), "approve", None),
        ("WHALE", clean_token(top_holder_pct=D("45")), "approve", None),
        ("DEVHEAVY", clean_token(dev_buy_share_pct=D("25")), "approve", None),
        ("SERIAL", clean_token(creator_launches=6), "approve", None),
        ("PRIOR_RUG", clean_token(creator_rugs=2), "approve", None),
        ("CAPPED", clean_token(creator_signatures=100, creator_signatures_capped=True), "approve", [D("2")]),
        ("CONFIRM_WIN", clean_token(), "approve", [D("2")]),
        ("THIN", clean_token(real_sol=D("0.05")), "approve", None),
        ("COMBO", clean_token(mint_authority_set=True, real_sol=D("0.01")), "approve", None),
        ("RATE", {"rate_limited": True}, "approve", None),
        ("AUTO_MINT", clean_token(mint_authority_set=True), "auto", None),
        ("HUMAN_NO", clean_token(), "reject", None),
        ("EXPIRED", clean_token(), "expire", None),
        ("AUTO_WIN", clean_token(), "auto", [D("2")]),
        ("HUMAN_WIN", clean_token(), "approve", [D("2")]),
        ("DIP_THEN_WIN", clean_token(), "approve", [D("0.941"), D("2")]),
        ("STOP_NEAR", clean_token(), "approve", [D("1.02"), D("0.97"), D("0.93")]),
        ("RUG_FAST", clean_token(), "approve", [D("1.08"), D("0.94"), D("0.40")]),
        ("TIMEOUT_FADE", clean_token(), "approve", [D("0.98")]),
    ]

    for mint, signals, approval, path in cases:
        if is_deferred(signals):
            deferred.append({"mint": mint, "reasons": evaluate_rug(signals)})
            continue
        reasons = evaluate_rug(signals)
        if reasons:
            rejected.append({"mint": mint, "reasons": reasons, "approval": approval})
            if approval == "auto":
                auto_rejected.append(mint)
            continue
        if approval == "reject":
            item = queue.propose(mint, "0.05", "synthetic clean token")
            status = queue.decide(item["id"], "rejected")
            approval_rejected.append({"mint": mint, "status": status})
            continue
        if approval == "expire":
            item = queue.propose(mint, "0.05", "synthetic clean token")
            queue.now = item["expires"]
            queue.expire_due()
            approval_expired.append({"mint": mint, "status": item["status"]})
            queue.now = 0
            continue

        if approval == "approve":
            item = queue.propose(mint, "0.05", "synthetic clean token")
            status = queue.decide(item["id"], "approved")
            if status != "approved":
                raise RuntimeError(status)
            human_buys += 1
        elif approval == "auto":
            auto_buys += 1
        else:
            raise RuntimeError(approval)

        curve = harness.fresh_curve()
        bought = book.try_buy(mint, curve, BUY_SOL)
        if not bought.accepted or path is None:
            trades.append({"mint": mint, "status": bought.reason, "pnl": None, "sold": False})
            continue
        sold, fill = drive_exit(book, curve, mint, path)
        position = book.positions[mint]
        trades.append({
            "mint": mint,
            "status": position.status,
            "exit": position.exit_reason,
            "pnl": position.cash_pnl(),
            "fill": fill,
            "sold": bool(sold and sold.sold),
        })

    slow = harness.ProposedBook(START_SOL, stop_ratio=STOP_RATIO, take_profit_ratio=TAKE_PROFIT_RATIO)
    slow_curve = harness.fresh_curve()
    slow.try_buy("RUG_SLOW", slow_curve, BUY_SOL)
    slow_fill = slow.positions["RUG_SLOW"].sol_in / slow.positions["RUG_SLOW"].tokens
    slow_curve.set_spot(slow_fill * D("0.40"))
    slow.try_sell("RUG_SLOW", slow_curve, reason="slow_poll_rug")
    slow_pnl = slow.positions["RUG_SLOW"].cash_pnl()
    fast = next(row for row in trades if row["mint"] == "RUG_FAST")

    def one_stop(ratio: Decimal) -> Decimal:
        side = harness.ProposedBook(START_SOL, stop_ratio=STOP_RATIO, take_profit_ratio=TAKE_PROFIT_RATIO)
        side_curve = harness.fresh_curve()
        side.try_buy("SLIP", side_curve, BUY_SOL)
        fill = side.positions["SLIP"].sol_in / side.positions["SLIP"].tokens
        side_curve.set_spot(fill * ratio)
        side.try_sell("SLIP", side_curve, reason="stop_loss")
        pnl = side.positions["SLIP"].cash_pnl()
        if pnl is None:
            raise RuntimeError("slippage side book did not close")
        return pnl

    graduation = {
        "dip": entry_decision(
            now=8, first_ts=0, first_spot=D("1"), spot=D("0.97"), fill_pct=D("95"),
        ),
        "stable": entry_decision(
            now=8, first_ts=0, first_spot=D("1"), spot=D("0.99"), fill_pct=D("95"),
        ),
        "reentry": entry_decision(
            now=20, first_ts=0, first_spot=D("1"), spot=D("1"), fill_pct=D("95"), blocked=True,
        ),
    }

    closed = [row for row in trades if row.get("pnl") is not None]
    wins = [row for row in closed if row["pnl"] > 0]
    losses = [row for row in closed if row["pnl"] <= 0]
    stops = [row for row in closed if row.get("exit") == "stop_loss"]
    return {
        "label": "SYNTHETIC",
        "starting_balance_sol": START_SOL,
        "ending_balance_sol": book.cash,
        "pnl_sol": book.cash - START_SOL,
        "trades": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": (D(len(wins)) / D(len(closed))) if closed else D(0),
        "stop_loss_hits": len(stops),
        "rejected": rejected,
        "deferred": deferred,
        "graduation": graduation,
        "slippage_at_trigger_pnl": one_stop(D("0.94")),
        "slippage_delayed_fill_pnl": one_stop(D("0.90")),
        "launch": {
            "fresh": sniper_launch(D("1.5")),
            "stale": sniper_launch(D("35")),
            "repeat": sniper_launch(D("1.5"), seen=True),
            "stopped": sniper_launch(D("1.5"), stopped=True),
            "cooldown": sniper_launch(D("1.5"), cooldown_until=600, now=10),
            "shared": sniper_launch(D("1.5"), held_by_other=True),
        },
        "fast_watch_ratio": first_visible_stop(
            [D("1"), D("0.98"), D("0.97"), D("0.90"), D("0.71")], STOP_RATIO + D("0.03")
        ),
        "slow_watch_ratio": D("0.71"),
        "approval_rejected": approval_rejected,
        "approval_expired": approval_expired,
        "auto_buys": auto_buys,
        "human_buys": human_buys,
        "auto_rejected": auto_rejected,
        "trade_rows": trades,
        "fast_rug_pnl": fast["pnl"],
        "slow_rug_pnl": slow_pnl,
        "queue": queue.items,
        "fast_watch_pnl": one_stop(
            first_visible_stop([D("1"), D("0.98"), D("0.97"), D("0.90"), D("0.71")], STOP_RATIO + D("0.03"))
        ),
        "slow_watch_pnl": one_stop(D("0.71")),
        "quiet_timeout": quiet_timeout(),
    }


def money(value: Decimal) -> str:
    return format(D(value).quantize(D("0.00000001")), "f")


def format_report(result: dict) -> str:
    win_pct = (D(100) * D(result["wins"]) / D(result["trades"])) if result["trades"] else D(0)
    lines = [
        "SYNTHETIC / SIMULIERT — kein Mainnet, kein Wallet, kein echtes Geld",
        f"Startguthaben: {result['starting_balance_sol']} SOL",
        f"Endguthaben: {money(result['ending_balance_sol'])} SOL",
        f"PnL: {money(result['pnl_sol'])} SOL",
        (
            f"Trades: {result['trades']}  Wins: {result['wins']}  "
            f"Losses: {result['losses']}  Win-Rate: {win_pct}%"
        ),
        f"Stop-Loss-Treffer: {result['stop_loss_hits']}",
        f"Abgelehnte Token: {len(result['rejected'])}",
        f"Rate-Limit verschoben (kein Kauf, kein Rug): {len(result['deferred'])}",
    ]
    for row in result["rejected"]:
        lines.append(f"  {row['mint']}: {', '.join(row['reasons'])}")
    lines.extend([
        f"Freigabe abgelehnt: {len(result['approval_rejected'])}",
        f"Freigabe verfallen: {len(result['approval_expired'])}",
        f"Menschlich freigegebene Käufe: {result['human_buys']}",
        f"AUTO_BUY-Käufe: {result['auto_buys']}",
        "AUTO_BUY trotzdem vom Rug-Check gestoppt: " + ", ".join(result["auto_rejected"]),
        f"Schneller Stop RUG_FAST PnL: {money(result['fast_rug_pnl'])} SOL",
        f"Langsamer Poll bis 0.40 des Fills PnL: {money(result['slow_rug_pnl'])} SOL",
        f"Stop am Trigger 0.94 PnL: {money(result['slippage_at_trigger_pnl'])} SOL",
        f"Fill rutscht auf 0.90 nach dem Trigger PnL: {money(result['slippage_delayed_fill_pnl'])} SOL",
        (
            "Graduation-Bestätigung: Dip "
            f"{result['graduation']['dip']}, stabil {result['graduation']['stable']}, "
            f"Wiedereinstieg {result['graduation']['reentry']}"
        ),
        (
            "Sniper-Einstieg: frisch "
            f"{result['launch']['fresh']}, alt {result['launch']['stale']}, "
            f"wiederholt {result['launch']['repeat']}, Stop {result['launch']['stopped']}, "
            f"gemeinsam {result['launch']['shared']}"
        ),
        (
            f"Schneller Stop mit 0.03 Margin bei {result['fast_watch_ratio']} "
            f"PnL {money(result['fast_watch_pnl'])} SOL; "
            f"nur spätes Update bei {result['slow_watch_ratio']} "
            f"PnL {money(result['slow_watch_pnl'])} SOL"
        ),
        (
            "Timeout ohne Preisupdate: konfiguriert "
            f"{result['quiet_timeout']['timeout_s']}s, geschlossen nach "
            f"{result['quiet_timeout']['closed_after_s']}s "
            f"(+{result['quiet_timeout']['late_by_s']}s, stale entry price)"
        ),
        "Gebührenannahme: Priorität 0.00012, Tip 0.0001, Basis 0.000005, Protokoll 1%.",
        "Stop 0.94 vom Fill-Preis, Take-Profit 2.0, Kaufgröße 0.05 SOL. Alles synthetisch.",
    ])
    return "\n".join(lines)


def main() -> None:
    print(format_report(run_campaign()))


if __name__ == "__main__":
    main()
