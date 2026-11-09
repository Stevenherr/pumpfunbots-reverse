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
    "max_same_slot_buyers": 6,
    "max_common_funder_pct": D("0"),
    "block_on_unknown": False,
}
STOP_RATIO = D("0.94")
TAKE_PROFIT_RATIO = D("2")
PARTIAL_TP_X = D("1.3")
PARTIAL_TP_PCT = D("0.5")
TRAIL_ACTIVATE_X = D("1.15")
TRAIL_PCT = D("0.08")
START_SOL = D("1.00")
BUY_SOL = D("0.05")
MIN_BUY_SOL = D("0.02")
MAX_EXIT_IMPACT = D("0.05")
MAX_BUY_OF_REAL_PCT = D("5")


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

    unknowns: list[str] = []
    dev = signals.get("dev_buy_share_pct", None)
    if "dev_buy_share_pct" not in signals or dev is None:
        if "dev_buy_share_pct" in signals and dev is None:
            unknowns.append("dev_buy_share_unknown")
    elif D(dev) > rules["max_dev_buy_share_pct"]:
        reasons.append(
            f"dev_buy_share_pct {fmt_pct(dev)} > {fmt_pct(rules['max_dev_buy_share_pct'])}"
        )

    launches = signals.get("creator_launches", None)
    if "creator_launches" in signals and launches is None:
        unknowns.append("creator_launches_unknown")
    elif launches is not None and launches > rules["max_creator_launches"]:
        reasons.append(f"creator_launches {launches} > {rules['max_creator_launches']}")

    rugs = signals.get("creator_rugs", None)
    if "creator_rugs" in signals and rugs is None:
        unknowns.append("creator_rugs_unknown")
    elif rugs is not None and rugs > rules["max_creator_rugs"]:
        reasons.append(f"creator_rugs {rugs} > {rules['max_creator_rugs']}")

    slot = signals.get("same_slot_buyers", None)
    max_slot = rules.get("max_same_slot_buyers", 0)
    if max_slot and "same_slot_buyers" in signals and slot is None:
        unknowns.append("same_slot_buyers_unknown")
    elif max_slot and slot is not None and slot > max_slot:
        reasons.append(f"bundled_same_slot {slot} > {max_slot}")

    if rules.get("block_on_unknown"):
        reasons.extend(f"unknown_blocks {name}" for name in unknowns)

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


def exit_spot_gap(vsol: Decimal, vtok: Decimal, sol_in: Decimal, rate: Decimal = D("0.01")) -> Decimal:
    tokens = harness.quote_buy(vsol, vtok, sol_in, rate)
    net = sol_in * (D(1) - rate)
    vsol2 = vsol + net
    vtok2 = vtok - tokens
    out = harness.quote_sell(vsol2, vtok2, tokens, rate)
    post_spot = vsol2 / vtok2
    expected = out / tokens
    return (post_spot - expected) / post_spot


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
    confirm_sec: int = 15,
    max_dip: Decimal = D("0.01"),
    blocked: bool = False,
    cooldown_until: int = 0,
    min_fill: Decimal = D("92"),
    buys: int = 0,
    sells: int = 0,
    min_buys: int = 0,
    min_buy_sell_ratio: Decimal = D("0"),
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
    if min_buys > 0 and buys < min_buys:
        return "buy_pressure"
    if min_buy_sell_ratio > 0:
        ratio = (D(buys) / D(sells)) if sells else (D("999") if buys else D("0"))
        if ratio < min_buy_sell_ratio:
            return "buy_pressure"
    return "buy"


def size_for_liquidity(real_sol, max_sol, min_sol, max_real_pct):
    """Cap by real SOL. A deep virtual pool does not do this by itself."""
    cap = max_sol
    if max_real_pct > 0 and real_sol is not None and real_sol > 0:
        cap = min(cap, real_sol * max_real_pct / D(100))
    if cap < min_sol:
        return cap, True
    return cap, False


def band_bar(real_sol, *, base_buyers=3, band_min=D("2"), band_max=D("4"), band_buyers=5):
    if band_max > band_min and real_sol is not None and band_min <= real_sol < band_max:
        return band_buyers, True
    return base_buyers, False


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


def plan_exit(ratio: Decimal, *, partial_done: bool, peak: Decimal) -> tuple[str, Decimal, bool, Decimal]:
    """Same order as the JS exit plan: hard stop, full TP, partial, trail."""
    peak = ratio if ratio > peak else peak
    if ratio <= STOP_RATIO:
        return "stop_loss", D("1"), partial_done, peak
    if ratio >= TAKE_PROFIT_RATIO:
        return "take_profit", D("1"), partial_done, peak
    if not partial_done and ratio >= PARTIAL_TP_X:
        return "partial_take_profit", PARTIAL_TP_PCT, True, peak
    if peak >= TRAIL_ACTIVATE_X and ratio <= peak * (D(1) - TRAIL_PCT):
        return "trailing_stop", D("1"), partial_done, peak
    return "hold", D("0"), partial_done, peak


def expand_path(ratios: list[Decimal]) -> list[Decimal]:
    """A quote that jumps straight to 2x still has to pass the 1.3 partial."""
    out: list[Decimal] = []
    armed = False
    for ratio in ratios:
        if ratio >= PARTIAL_TP_X and not armed and ratio > PARTIAL_TP_X:
            out.append(PARTIAL_TP_X)
        out.append(ratio)
        if ratio >= PARTIAL_TP_X:
            armed = True
    return out


def drive_exit(book: harness.ProposedBook, curve: harness.Curve, mint: str, ratios: list[Decimal]):
    position = book.positions[mint]
    fill = position.sol_in / position.tokens
    partial_done = False
    peak = D("1")
    sold = None
    for ratio in expand_path(ratios):
        kind, frac, partial_done, peak = plan_exit(ratio, partial_done=partial_done, peak=peak)
        if kind == "hold":
            continue
        curve.set_spot(fill * ratio)
        sold = book.try_sell(mint, curve, reason=kind, fraction=frac)
        if book.positions[mint].status == "closed":
            return sold, fill
    if book.positions[mint].status == "open":
        curve.set_spot(fill * ratios[-1])
        sold = book.try_sell(mint, curve, reason="timeout", fraction=D("1"))
    return sold, fill


def confirm_entry(*, buyers: int, buys: int, sells: int, pump: Decimal, window_ms: int = 8000, elapsed_ms: int = 8000) -> str:
    if window_ms <= 0:
        return "confirm_off"
    if elapsed_ms < window_ms:
        return "confirm_wait"
    reasons = []
    if buyers < 3:
        reasons.append(f"buyers {buyers} < 3")
    ratio = D(buys) / D(sells) if sells else D("999")
    if ratio < D("1.5"):
        reasons.append(f"buy_sell_ratio {ratio}")
    if pump > D("1.8"):
        reasons.append(f"pre_entry_pump {pump}")
    if reasons:
        return "skip:" + "; ".join(reasons)
    return "confirmed"


def size_for_impact(vsol: Decimal, vtok: Decimal, max_sol: Decimal, min_sol: Decimal, limit: Decimal):
    def gap(sol: Decimal) -> Decimal:
        return exit_spot_gap(vsol, vtok, sol)

    if gap(max_sol) <= limit:
        return max_sol, False, gap(max_sol)
    if gap(min_sol) > limit:
        return min_sol, True, gap(min_sol)
    lo, hi = min_sol, max_sol
    for _ in range(18):
        mid = (lo + hi) / D(2)
        if gap(mid) <= limit:
            lo = mid
        else:
            hi = mid
    return lo, False, gap(lo)


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
        ("BUNDLE", clean_token(same_slot_buyers=9), "approve", None),
        ("PARTIAL_TRAIL", clean_token(), "approve", [D("1.40"), D("1.20")]),
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

    sized_pool = (D("1"), D("10000"))
    sized_sol, sized_skipped, sized_gap = size_for_impact(
        *sized_pool, BUY_SOL, MIN_BUY_SOL, MAX_EXIT_IMPACT,
    )
    floor_sol, floor_skip, floor_gap = size_for_impact(
        D("0.35"), D("500"), BUY_SOL, MIN_BUY_SOL, MAX_EXIT_IMPACT,
    )
    if not sized_skipped:
        human_buys += 1
        sized_item = queue.propose("SIZED", str(sized_sol), "scaled under exit impact")
        queue.decide(sized_item["id"], "approved")
        sized_curve = harness.Curve(virtual_sol=sized_pool[0], virtual_token=sized_pool[1])
        sized_buy = book.try_buy("SIZED", sized_curve, sized_sol)
        if sized_buy.accepted:
            sold, fill = drive_exit(book, sized_curve, "SIZED", [D("1.05")])
            position = book.positions["SIZED"]
            trades.append({
                "mint": "SIZED",
                "status": position.status,
                "exit": position.exit_reason,
                "pnl": position.cash_pnl(),
                "fill": fill,
                "sold": bool(sold and sold.sold),
                "size": sized_sol,
            })

    entry_skip = confirm_entry(buyers=1, buys=1, sells=2, pump=D("1.1"))
    entry_pump = confirm_entry(buyers=5, buys=8, sells=1, pump=D("2.4"))
    entry_ok = confirm_entry(buyers=4, buys=6, sells=1, pump=D("1.2"))

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

    real_scaled, real_skipped = size_for_liquidity(D("0.8"), BUY_SOL, MIN_BUY_SOL, MAX_BUY_OF_REAL_PCT)
    deep_virtual_gap = exit_spot_gap(D("30"), D("1000000"), D("0.1"))
    if not real_skipped:
        human_buys += 1
        real_item = queue.propose("REAL_LIQ", str(real_scaled), "capped by real SOL")
        queue.decide(real_item["id"], "approved")
        real_curve = harness.fresh_curve()
        real_buy = book.try_buy("REAL_LIQ", real_curve, real_scaled)
        if real_buy.accepted:
            sold, fill = drive_exit(book, real_curve, "REAL_LIQ", [D("0.98")])
            position = book.positions["REAL_LIQ"]
            trades.append({
                "mint": "REAL_LIQ",
                "status": position.status,
                "exit": position.exit_reason,
                "pnl": position.cash_pnl(),
                "fill": fill,
                "sold": bool(sold and sold.sold),
                "size": real_scaled,
            })

    graduation = {
        "dip": entry_decision(
            now=15, first_ts=0, first_spot=D("1"), spot=D("0.97"), fill_pct=D("95"),
        ),
        "stable": entry_decision(
            now=15, first_ts=0, first_spot=D("1"), spot=D("0.995"), fill_pct=D("95"),
            buys=4, sells=1, min_buys=3, min_buy_sell_ratio=D("1.5"),
        ),
        "reentry": entry_decision(
            now=20, first_ts=0, first_spot=D("1"), spot=D("1"), fill_pct=D("95"), blocked=True,
        ),
        "pressure": entry_decision(
            now=15, first_ts=0, first_spot=D("1"), spot=D("1"), fill_pct=D("95"),
            buys=1, sells=2, min_buys=3, min_buy_sell_ratio=D("1.5"),
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
        "thin_exit_gap": exit_spot_gap(D("1"), D("1000"), D("0.2")),
        "deep_exit_gap": exit_spot_gap(D("1000"), D("1000000"), D("0.05")),
        "partial_exits": sum(1 for event in book.events if event.get("reason") == "partial_take_profit"),
        "trail_exits": sum(1 for event in book.events if event.get("reason") == "trailing_stop"),
        "sized_sol": sized_sol,
        "sized_skipped": sized_skipped,
        "sized_gap": sized_gap,
        "floor_skip": floor_skip,
        "floor_gap": floor_gap,
        "floor_sol": floor_sol,
        "entry_skip": entry_skip,
        "entry_pump": entry_pump,
        "entry_ok": entry_ok,
        "real_scaled_sol": real_scaled,
        "real_scaled_skipped": real_skipped,
        "deep_virtual_gap": deep_virtual_gap,
        "band_mid_buyers": band_bar(D("3"))[0],
        "band_mid": band_bar(D("3"))[1],
        "band_outside_buyers": band_bar(D("6"))[0],
        "band_outside": band_bar(D("6"))[1],
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
        (
            "Abstand Spot zu Verkauf unserer Groesse: duenn "
            f"{result['thin_exit_gap']}, tief {result['deep_exit_gap']}. "
            "Ueber 5% wird nicht gekauft. Ein Crash in einem einzelnen Trade kann den Quote trotzdem unter 0.94 druecken."
        ),
        "Gebührenannahme: Priorität 0.00012, Tip 0.0001, Basis 0.000005, Protokoll 1%.",
        "Stop 0.94 vom Fill-Preis, Take-Profit 2.0, Teilverkauf 50% bei 1.3, Trail 8% unter dem Peak ab 1.15. Kaufgröße höchstens 0.05 SOL, skaliert unter 5% Exit-Impact. Alles synthetisch.",
        (
            f"Teilverkäufe: {result['partial_exits']}, Trailing-Stops: {result['trail_exits']}, "
            f"skalierte Größe: {money(result['sized_sol'])} SOL (übersprungen={result['sized_skipped']}), "
            f"Floor zu groß: {result['floor_skip']}."
        ),
        (
            f"Einstiegsfenster: knapp {result['entry_skip']}; schon gelaufen {result['entry_pump']}; "
            f"bestätigt {result['entry_ok']}."
        ),
        (
            "Reale Liquidität deckelt die Größe, auch wenn der Spot-Abstand auf 30 virtuellen SOL "
            f"nur {result['deep_virtual_gap']} ist. 0.8 reale SOL bei 5% ergeben {money(result['real_scaled_sol'])} SOL "
            f"(übersprungen={result['real_scaled_skipped']})."
        ),
        (
            f"Band 2-4 SOL verlangt {result['band_mid_buyers']} Käufer (aktiv={result['band_mid']}); "
            f"außerhalb bleiben {result['band_outside_buyers']} (aktiv={result['band_outside']})."
        ),
        (
            "Graduation: Dip "
            f"{result['graduation']['dip']}, stabil {result['graduation']['stable']}, "
            f"Druck {result['graduation']['pressure']}, Wiedereinstieg {result['graduation']['reentry']}."
        ),
    ])
    return "\n".join(lines)


def main() -> None:
    print(format_report(run_campaign()))


if __name__ == "__main__":
    main()
