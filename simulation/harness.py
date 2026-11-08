#!/usr/bin/env python3
"""SYNTHETIC offline harness. Not a backtest and not live trading.

This file is a standalone standard-library model. It does not import trading
code, does not read an environment file or keys, and does not touch a network.

Two models sit side by side:

* OriginalBehaviorModel sketches audited sniper defaults
  (0.1 SOL buys, stop ratio 0.5, take-profit ratio 2.0, at most 3 positions,
  in-memory positions, drop the position when the curve is marked complete).
  It does not execute that file. Integer chain math and real inclusion are
  not reproduced. An included failed transaction debits priority+base only
  when the scenario asks for that adverse assumption.

* ProposedBook is a different set of rules under test: 0.20 SOL cash standing
  for 20 USD at a hypothetical 100 USD per SOL, a -5% spot trigger (0.95),
  a fixed +10% spot take-profit (1.10), and a fee-inclusive cash limit.
  The +10% rule is a transparent test choice, not a learned policy.

USD/SOL = 100 is an assumption so that 20 USD is exactly 0.20 SOL. It is not
a market quote. Priority fee 0.00012 SOL is the audited default
(1_500_000 microlamports * 80_000 CU / 1_000_000 = 120_000 lamports).
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 50

D = Decimal

HYPOTHETICAL_USD_PER_SOL = D("100")
BUDGET_USD = D("20")
BUDGET_SOL = BUDGET_USD / HYPOTHETICAL_USD_PER_SOL

PRIORITY_FEE_SOL = D("0.00012")
TIP_SOL = D("0.0001")
BASE_FEE_SOL = D("0.000005")

PROPOSED_STOP_RATIO = D("0.95")
PROPOSED_TAKE_PROFIT_RATIO = D("1.10")

ORIGINAL_BUY_SOL = D("0.1")
ORIGINAL_STOP_RATIO = D("0.5")
ORIGINAL_TAKE_PROFIT_RATIO = D("2.0")
ORIGINAL_MAX_POSITIONS = 3

POOL_SOL = D("1000")
POOL_TOKEN = D("1000000")


def q(value: Decimal | str | int) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return D(str(value))


@dataclass(frozen=True)
class FeeAssumption:
    priority_sol: Decimal = PRIORITY_FEE_SOL
    tip_sol: Decimal = TIP_SOL
    base_sol: Decimal = BASE_FEE_SOL
    protocol_rate: Decimal = D("0.01")
    slippage_bps: int = 500

    def fixed_success(self) -> Decimal:
        return self.priority_sol + self.tip_sol + self.base_sol

    def fixed_included_failure(self) -> Decimal:
        return self.priority_sol + self.base_sol

    def slippage_factor(self) -> Decimal:
        return (D(10000) - D(self.slippage_bps)) / D(10000)


@dataclass
class Curve:
    virtual_sol: Decimal
    virtual_token: Decimal
    complete: bool = False

    def spot(self) -> Decimal:
        if self.virtual_token == 0:
            raise ValueError("zero token reserve")
        return self.virtual_sol / self.virtual_token

    def set_spot(self, spot: Decimal) -> None:
        self.virtual_sol = self.virtual_token * spot


def fresh_curve() -> Curve:
    return Curve(virtual_sol=POOL_SOL, virtual_token=POOL_TOKEN)


def quote_buy(
    virtual_sol: Decimal, virtual_token: Decimal, sol_in: Decimal, protocol_rate: Decimal
) -> Decimal:
    net = sol_in * (D(1) - protocol_rate)
    return virtual_token * net / (virtual_sol + net)


def apply_buy(curve: Curve, sol_in: Decimal, protocol_rate: Decimal) -> Decimal:
    tokens = quote_buy(curve.virtual_sol, curve.virtual_token, sol_in, protocol_rate)
    net = sol_in * (D(1) - protocol_rate)
    curve.virtual_sol += net
    curve.virtual_token -= tokens
    return tokens


def quote_sell(
    virtual_sol: Decimal, virtual_token: Decimal, tokens: Decimal, protocol_rate: Decimal
) -> Decimal:
    gross = virtual_sol * tokens / (virtual_token + tokens)
    return gross * (D(1) - protocol_rate)


def apply_sell(curve: Curve, tokens: Decimal, protocol_rate: Decimal) -> Decimal:
    gross = curve.virtual_sol * tokens / (curve.virtual_token + tokens)
    if gross > curve.virtual_sol:
        raise ValueError("sell exceeds synthetic reserves")
    net = gross * (D(1) - protocol_rate)
    curve.virtual_sol -= gross
    curve.virtual_token += tokens
    return net


@dataclass
class Position:
    mint: str
    tokens: Decimal
    entry_spot: Decimal
    sol_in: Decimal
    entry_fixed: Decimal
    status: str = "open"
    exit_reason: str | None = None
    sol_out: Decimal = D("0")
    exit_fixed: Decimal = D("0")

    @property
    def cost_basis(self) -> Decimal:
        return self.sol_in + self.entry_fixed

    def cash_pnl(self) -> Decimal | None:
        if self.status != "closed":
            return None
        return (self.sol_out - self.exit_fixed) - self.cost_basis


def loss_fraction(position: Position) -> Decimal | None:
    pnl = position.cash_pnl()
    if pnl is None or position.cost_basis == 0:
        return None
    return -pnl / position.cost_basis


@dataclass
class BuyResult:
    accepted: bool
    reason: str
    spent: Decimal = D("0")


@dataclass
class SellResult:
    sold: bool
    reason: str
    proceeds: Decimal = D("0")
    fee_paid: Decimal = D("0")


class ProposedBook:
    """Fee-inclusive 0.20 SOL book with a 0.95 stop and a 1.10 take-profit."""

    LABEL = "SYNTHETIC_PROPOSED_GUARDRAILS"

    def __init__(
        self,
        cash: Decimal,
        fees: FeeAssumption | None = None,
        stop_ratio: Decimal = PROPOSED_STOP_RATIO,
        take_profit_ratio: Decimal = PROPOSED_TAKE_PROFIT_RATIO,
    ) -> None:
        self.cash = cash
        self.fees = fees or FeeAssumption()
        self.stop_ratio = stop_ratio
        self.take_profit_ratio = take_profit_ratio
        self.positions: dict[str, Position] = {}
        self.events: list[dict[str, str]] = []

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.status == "open"]

    def locked_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.status in {"open", "stuck_migrated"}]

    def locked_exit_reserve(self) -> Decimal:
        return self.fees.fixed_success() * D(len(self.locked_positions()))

    def spendable(self) -> Decimal:
        return self.cash - self.locked_exit_reserve()

    def try_buy(
        self, mint: str, curve: Curve, sol_in: Decimal, *, adverse_slippage: bool = False
    ) -> BuyResult:
        sol_in = q(sol_in)
        if curve.complete:
            self._event("reject_migrated", mint=mint)
            return BuyResult(False, "reject_migrated")
        existing = self.positions.get(mint)
        if existing and existing.status in {"open", "stuck_migrated"}:
            self._event("reject_duplicate", mint=mint)
            return BuyResult(False, "reject_duplicate")
        entry_fixed = self.fees.fixed_success()
        exit_reserve = self.fees.fixed_success()
        if self.spendable() < sol_in + entry_fixed + exit_reserve:
            self._event("reject_budget", mint=mint, spendable=str(self.spendable()))
            return BuyResult(False, "reject_budget")
        entry_spot = curve.spot()
        tokens = apply_buy(curve, sol_in, self.fees.protocol_rate)
        if adverse_slippage:
            tokens *= self.fees.slippage_factor()
        self.cash -= sol_in + entry_fixed
        self.positions[mint] = Position(
            mint=mint,
            tokens=tokens,
            entry_spot=entry_spot,
            sol_in=sol_in,
            entry_fixed=entry_fixed,
        )
        self._event("buy", mint=mint, sol_in=str(sol_in), tokens=str(tokens))
        return BuyResult(True, "opened", spent=sol_in + entry_fixed)

    def try_sell(
        self,
        mint: str,
        curve: Curve,
        *,
        reason: str,
        adverse_slippage: bool = False,
        fail: str | None = None,
        fraction: Decimal = D("1"),
    ) -> SellResult:
        pos = self.positions.get(mint)
        if not pos or pos.status != "open":
            return SellResult(False, "no_open_position")
        frac = q(fraction)
        if frac <= 0:
            return SellResult(False, "bad_fraction")
        if frac > 1:
            frac = D("1")
        if curve.complete:
            pos.status = "stuck_migrated"
            pos.exit_reason = "stuck_migrated"
            self._event("stuck_migrated", mint=mint)
            return SellResult(False, "stuck_migrated")
        if fail == "not_included":
            self._event("sell_failed_not_included", mint=mint)
            return SellResult(False, "sell_failed_not_included")
        if fail == "included":
            fee = self.fees.fixed_included_failure()
            debit = fee if self.cash >= fee else self.cash
            self.cash -= debit
            pos.exit_fixed += debit
            self._event("sell_failed_included", mint=mint, fee=str(debit))
            return SellResult(False, "sell_failed_included", fee_paid=debit)
        sell_tokens = pos.tokens if frac >= 1 else pos.tokens * frac
        proceeds = apply_sell(curve, sell_tokens, self.fees.protocol_rate)
        if adverse_slippage:
            proceeds *= self.fees.slippage_factor()
        exit_fixed = self.fees.fixed_success()
        if self.cash < exit_fixed:
            self._event("sell_blocked_fees", mint=mint)
            return SellResult(False, "sell_blocked_fees")
        self.cash -= exit_fixed
        self.cash += proceeds
        pos.sol_out += proceeds
        pos.exit_fixed += exit_fixed
        pos.tokens -= sell_tokens
        if pos.tokens <= D("0.000000001") or frac >= 1:
            pos.tokens = D("0")
            pos.status = "closed"
            pos.exit_reason = reason
        self._event("sell", mint=mint, reason=reason, proceeds=str(proceeds), fraction=str(frac))
        return SellResult(True, reason, proceeds=proceeds, fee_paid=exit_fixed)

    def on_synthetic_mark(
        self,
        mint: str,
        curve: Curve,
        observed_ratio: Decimal,
        *,
        fill_ratio: Decimal | None = None,
        adverse_slippage: bool = False,
        fail: str | None = None,
    ) -> SellResult | None:
        pos = self.positions.get(mint)
        if not pos or pos.status != "open":
            return None
        if curve.complete:
            return self.try_sell(mint, curve, reason="migration_check")
        observed_ratio = q(observed_ratio)
        if observed_ratio >= self.take_profit_ratio or observed_ratio <= self.stop_ratio:
            fill = q(fill_ratio) if fill_ratio is not None else observed_ratio
            reason = "take_profit" if observed_ratio >= self.take_profit_ratio else "stop_trigger"
            curve.set_spot(pos.entry_spot * fill)
            return self.try_sell(
                mint, curve, reason=reason, adverse_slippage=adverse_slippage, fail=fail
            )
        curve.set_spot(pos.entry_spot * observed_ratio)
        self._event("hold", mint=mint, ratio=str(observed_ratio))
        return None

    def save(self, path: Path) -> None:
        payload = {
            "label": "SYNTHETIC",
            "model": self.LABEL,
            "hypothetical_usd_per_sol": str(HYPOTHETICAL_USD_PER_SOL),
            "note": "Not a market price. Not a backtest. Not the original bot.",
            "cash_sol": str(self.cash),
            "stop_ratio": str(self.stop_ratio),
            "take_profit_ratio": str(self.take_profit_ratio),
            "fees": {
                "priority_sol": str(self.fees.priority_sol),
                "tip_sol": str(self.fees.tip_sol),
                "base_sol": str(self.fees.base_sol),
                "protocol_rate": str(self.fees.protocol_rate),
                "slippage_bps": self.fees.slippage_bps,
            },
            "positions": [
                {
                    "mint": p.mint,
                    "tokens": str(p.tokens),
                    "entry_spot": str(p.entry_spot),
                    "sol_in": str(p.sol_in),
                    "entry_fixed": str(p.entry_fixed),
                    "status": p.status,
                    "exit_reason": p.exit_reason,
                    "sol_out": str(p.sol_out),
                    "exit_fixed": str(p.exit_fixed),
                }
                for p in self.positions.values()
            ],
            "events": self.events,
        }
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> ProposedBook:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if raw.get("label") != "SYNTHETIC":
            raise ValueError("refusing ledger without SYNTHETIC label")
        fees_raw = raw["fees"]
        fees = FeeAssumption(
            priority_sol=D(fees_raw["priority_sol"]),
            tip_sol=D(fees_raw["tip_sol"]),
            base_sol=D(fees_raw["base_sol"]),
            protocol_rate=D(fees_raw["protocol_rate"]),
            slippage_bps=int(fees_raw["slippage_bps"]),
        )
        book = cls(
            cash=D(raw["cash_sol"]),
            fees=fees,
            stop_ratio=D(raw["stop_ratio"]),
            take_profit_ratio=D(raw["take_profit_ratio"]),
        )
        for item in raw["positions"]:
            book.positions[item["mint"]] = Position(
                mint=item["mint"],
                tokens=D(item["tokens"]),
                entry_spot=D(item["entry_spot"]),
                sol_in=D(item["sol_in"]),
                entry_fixed=D(item["entry_fixed"]),
                status=item["status"],
                exit_reason=item["exit_reason"],
                sol_out=D(item["sol_out"]),
                exit_fixed=D(item["exit_fixed"]),
            )
        book.events = list(raw["events"])
        book._event("restart_loaded")
        return book

    def _event(self, kind: str, **data: str) -> None:
        self.events.append({"kind": kind, **data})


class OriginalBehaviorModel:
    """Sketch of audited sniper defaults. Does not run the JavaScript."""

    LABEL = "SYNTHETIC_ORIGINAL_BEHAVIOR_MODEL"

    def __init__(
        self,
        cash: Decimal,
        fees: FeeAssumption | None = None,
        charge_included_failure: bool = True,
    ) -> None:
        self.cash = cash
        self.fees = fees or FeeAssumption()
        self.charge_included_failure = charge_included_failure
        self.positions: dict[str, Position] = {}
        self.orphan_tokens: dict[str, Decimal] = {}
        self.events: list[dict[str, str]] = []
        self.buy_attempts = 0
        self.included_failure_fees = D("0")

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.status == "open"]

    def on_create(
        self, mint: str, curve: Curve, *, sol_in: Decimal | None = None
    ) -> BuyResult:
        """sol_in defaults to the audited 0.1 SOL. A caller may pass another size
        only to expose the max-position gate; that override is not a second bot."""
        sol_in = ORIGINAL_BUY_SOL if sol_in is None else q(sol_in)
        self.buy_attempts += 1
        if len(self.open_positions()) >= ORIGINAL_MAX_POSITIONS:
            self.events.append({"kind": "skip_max_positions", "mint": mint})
            return BuyResult(False, "skip_max_positions")
        existing = self.positions.get(mint)
        if existing and existing.status == "open":
            return BuyResult(False, "already_open")
        if curve.complete:
            self.events.append({"kind": "buy_skip_complete", "mint": mint})
            return BuyResult(False, "curve_complete")
        entry_fixed = self.fees.fixed_success()
        if self.cash < sol_in + entry_fixed:
            if self.charge_included_failure:
                fee = self.fees.fixed_included_failure()
                debit = fee if self.cash >= fee else self.cash
                self.cash -= debit
                self.included_failure_fees += debit
            self.events.append({"kind": "buy_chain_reject", "mint": mint})
            return BuyResult(False, "chain_reject")
        entry_spot = curve.spot()
        tokens = apply_buy(curve, sol_in, self.fees.protocol_rate)
        self.cash -= sol_in + entry_fixed
        self.positions[mint] = Position(
            mint=mint,
            tokens=tokens,
            entry_spot=entry_spot,
            sol_in=sol_in,
            entry_fixed=entry_fixed,
        )
        self.events.append({"kind": "buy", "mint": mint})
        return BuyResult(True, "opened", spent=sol_in + entry_fixed)

    def on_synthetic_mark(
        self,
        mint: str,
        curve: Curve,
        observed_ratio: Decimal,
        *,
        fill_ratio: Decimal | None = None,
        fail: str | None = None,
    ) -> SellResult | None:
        pos = self.positions.get(mint)
        if not pos or pos.status != "open":
            return None
        if curve.complete:
            self.orphan_tokens[mint] = self.orphan_tokens.get(mint, D("0")) + pos.tokens
            pos.status = "dropped_unmonitored"
            pos.exit_reason = "curve_complete_drop"
            pos.tokens = D("0")
            self.events.append({"kind": "drop_position", "mint": mint})
            return SellResult(False, "dropped_unmonitored")
        observed_ratio = q(observed_ratio)
        triggered = (
            observed_ratio >= ORIGINAL_TAKE_PROFIT_RATIO or observed_ratio <= ORIGINAL_STOP_RATIO
        )
        if not triggered:
            self.events.append({"kind": "hold", "mint": mint, "ratio": str(observed_ratio)})
            return None
        if fail == "not_included":
            self.events.append({"kind": "sell_failed", "mint": mint})
            return SellResult(False, "sell_failed_not_included")
        fill = q(fill_ratio) if fill_ratio is not None else observed_ratio
        curve.set_spot(pos.entry_spot * fill)
        proceeds = apply_sell(curve, pos.tokens, self.fees.protocol_rate)
        exit_fixed = self.fees.fixed_success()
        if self.cash < exit_fixed:
            self.events.append({"kind": "sell_failed", "mint": mint})
            return SellResult(False, "sell_failed_not_included")
        self.cash -= exit_fixed
        self.cash += proceeds
        pos.tokens = D("0")
        pos.sol_out = proceeds
        pos.exit_fixed = exit_fixed
        pos.status = "closed"
        pos.exit_reason = (
            "original_tp" if observed_ratio >= ORIGINAL_TAKE_PROFIT_RATIO else "original_stop"
        )
        return SellResult(True, pos.exit_reason, proceeds=proceeds, fee_paid=exit_fixed)

    def restart_forgets_positions(self) -> OriginalBehaviorModel:
        fresh = OriginalBehaviorModel(self.cash, self.fees, self.charge_included_failure)
        for mint, pos in self.positions.items():
            if pos.status == "open" and pos.tokens > 0:
                fresh.orphan_tokens[mint] = pos.tokens
        for mint, tokens in self.orphan_tokens.items():
            fresh.orphan_tokens[mint] = fresh.orphan_tokens.get(mint, D("0")) + tokens
        fresh.events.append({"kind": "restart_positions_forgotten"})
        return fresh


@dataclass
class ScenarioLine:
    name: str
    detail: str


def scenario_report() -> list[ScenarioLine]:
    """Printable synthetic outcomes. Pass/fail lives in test_harness.py."""
    lines: list[ScenarioLine] = []
    fees = FeeAssumption()
    lines.append(
        ScenarioLine(
            "assumptions",
            (
                f"SYNTHETIC hypothetical {HYPOTHETICAL_USD_PER_SOL} USD/SOL, "
                f"budget {BUDGET_SOL} SOL, priority {fees.priority_sol} SOL, "
                f"tip {fees.tip_sol}, base {fees.base_sol}, protocol {fees.protocol_rate}, "
                f"slippage {fees.slippage_bps} bps, stop {PROPOSED_STOP_RATIO}, "
                f"take-profit {PROPOSED_TAKE_PROFIT_RATIO}"
            ),
        )
    )

    book = ProposedBook(BUDGET_SOL)
    curve = fresh_curve()
    book.try_buy("FLAT", curve, D("0.05"))
    curve.set_spot(book.positions["FLAT"].entry_spot)
    book.try_sell("FLAT", curve, reason="manual_flat")
    pnl = book.positions["FLAT"].cash_pnl()
    lines.append(ScenarioLine("flat_roundtrip_pnl_sol", str(pnl)))

    proposed = ProposedBook(BUDGET_SOL)
    opened = 0
    for i in range(4):
        result = proposed.try_buy(f"P{i}", fresh_curve(), D("0.05"))
        opened += int(result.accepted)
    lines.append(
        ScenarioLine(
            "proposed_buys_of_0.05",
            f"accepted={opened} cash={proposed.cash} spendable={proposed.spendable()}",
        )
    )

    original = OriginalBehaviorModel(BUDGET_SOL)
    reasons = [original.on_create(f"O{i}", fresh_curve()).reason for i in range(3)]
    lines.append(
        ScenarioLine(
            "original_default_0.1_on_0.20",
            (
                f"reasons={reasons} open={len(original.open_positions())} "
                f"failure_fees={original.included_failure_fees} cash={original.cash}"
            ),
        )
    )

    gap = ProposedBook(BUDGET_SOL)
    gap_curve = fresh_curve()
    gap.try_buy("GAP", gap_curve, D("0.05"))
    gap.on_synthetic_mark("GAP", gap_curve, D("0.70"))
    lines.append(
        ScenarioLine(
            "gap_0.70_loss_fraction",
            str(loss_fraction(gap.positions["GAP"])),
        )
    )

    tp = ProposedBook(BUDGET_SOL)
    tp_curve = fresh_curve()
    tp.try_buy("TP", tp_curve, D("0.05"))
    tp.on_synthetic_mark("TP", tp_curve, D("1.10"))
    lines.append(
        ScenarioLine(
            "take_profit_1.10_cash_pnl_sol",
            str(tp.positions["TP"].cash_pnl()),
        )
    )
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print SYNTHETIC scenario figures. Does not trade or use the network."
    )
    parser.parse_args()
    print("SYNTHETIC offline simulation — not a backtest, not live performance")
    print("original bot JS was not executed")
    for line in scenario_report():
        print(f"{line.name}: {line.detail}")
    from safety_campaign import format_report, run_campaign

    print()
    print(format_report(run_campaign()))
    print("pass/fail: run python3 simulation/test_harness.py -v")


if __name__ == "__main__":
    main()
