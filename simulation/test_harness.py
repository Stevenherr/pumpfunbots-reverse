#!/usr/bin/env python3
"""Assertions for the SYNTHETIC harness. Not a market backtest."""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import harness  # noqa: E402

D = Decimal


def independent_buy(vsol: D, vtok: D, sol_in: D, rate: D) -> tuple[D, D, D]:
    net = sol_in * (D(1) - rate)
    tokens = vtok * net / (vsol + net)
    return tokens, vsol + net, vtok - tokens


def independent_sell(vsol: D, vtok: D, tokens: D, rate: D) -> D:
    gross = vsol * tokens / (vtok + tokens)
    return gross * (D(1) - rate)


class SyntheticHarnessTests(unittest.TestCase):
    def test_priority_fee_unit_is_120000_lamports(self) -> None:
        self.assertEqual(harness.PRIORITY_FEE_SOL, D("0.00012"))
        self.assertEqual(harness.PRIORITY_FEE_SOL * D(10**9), D(120000))
        self.assertEqual(harness.BUDGET_SOL, D("0.20"))
        self.assertEqual(harness.HYPOTHETICAL_USD_PER_SOL, D("100"))

    def test_flat_roundtrip_loses_cash_to_assumed_fees(self) -> None:
        rate = D("0.01")
        sol_in = D("0.05")
        fixed = D("0.000225")
        vsol, vtok = harness.POOL_SOL, harness.POOL_TOKEN
        tokens, vsol2, vtok2 = independent_buy(vsol, vtok, sol_in, rate)
        entry_spot = vsol / vtok
        vsol_flat = vtok2 * entry_spot
        proceeds = independent_sell(vsol_flat, vtok2, tokens, rate)
        expected_pnl = proceeds - fixed - sol_in - fixed
        self.assertLess(expected_pnl, 0)

        book = harness.ProposedBook(harness.BUDGET_SOL)
        curve = harness.fresh_curve()
        bought = book.try_buy("FLAT", curve, sol_in)
        self.assertTrue(bought.accepted)
        curve.set_spot(book.positions["FLAT"].entry_spot)
        sold = book.try_sell("FLAT", curve, reason="manual_flat")
        self.assertTrue(sold.sold)
        self.assertEqual(book.positions["FLAT"].cash_pnl(), expected_pnl)
        self.assertEqual(book.positions["FLAT"].sol_out, proceeds)
        self.assertLess(book.cash, harness.BUDGET_SOL)

    def test_budget_counts_fees_and_is_not_a_position_cap_of_three(self) -> None:
        book = harness.ProposedBook(harness.BUDGET_SOL)
        accepted = []
        for i in range(4):
            accepted.append(book.try_buy(f"P{i}", harness.fresh_curve(), D("0.05")).accepted)
        self.assertEqual(accepted, [True, True, True, False])
        self.assertEqual(book.positions["P3"].status if "P3" in book.positions else "absent", "absent")
        self.assertEqual(len(book.open_positions()), 3)
        fixed = D("0.000225")
        self.assertEqual(book.cash, D("0.20") - 3 * (D("0.05") + fixed))
        self.assertEqual(book.events[-1]["kind"], "reject_budget")
        cash_after_reject = book.cash

        fourth_small = book.try_buy("P3", harness.fresh_curve(), D("0.04"))
        self.assertTrue(fourth_small.accepted)
        self.assertEqual(len(book.open_positions()), 4)
        self.assertLess(book.cash, cash_after_reject)

    def test_whole_budget_buy_is_rejected_without_a_debit(self) -> None:
        book = harness.ProposedBook(harness.BUDGET_SOL)
        result = book.try_buy("TOO_BIG", harness.fresh_curve(), D("0.20"))
        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "reject_budget")
        self.assertEqual(book.cash, harness.BUDGET_SOL)
        self.assertEqual([event["kind"] for event in book.events], ["reject_budget"])
        self.assertEqual(len(book.open_positions()), 0)

    def test_original_default_size_retries_and_can_pay_inclusion_fees(self) -> None:
        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        reasons = [original.on_create(f"O{i}", harness.fresh_curve()).reason for i in range(3)]
        self.assertEqual(reasons, ["opened", "chain_reject", "chain_reject"])
        self.assertEqual(len(original.open_positions()), 1)
        self.assertEqual(original.buy_attempts, 3)
        self.assertEqual(original.included_failure_fees, 2 * D("0.000125"))
        self.assertEqual(
            original.cash,
            D("0.20") - (D("0.1") + D("0.000225")) - 2 * D("0.000125"),
        )

        capped = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        small = [capped.on_create(f"S{i}", harness.fresh_curve(), sol_in=D("0.01")).reason for i in range(4)]
        self.assertEqual(small, ["opened", "opened", "opened", "skip_max_positions"])
        self.assertEqual(capped.included_failure_fees, 0)
        self.assertGreater(capped.cash, D("0.15"))

    def test_gap_through_five_percent_original_holds_proposed_sells_for_a_larger_loss(self) -> None:
        proposed = harness.ProposedBook(harness.BUDGET_SOL)
        p_curve = harness.fresh_curve()
        proposed.try_buy("GAP", p_curve, D("0.05"))
        sold = proposed.on_synthetic_mark("GAP", p_curve, D("0.70"))
        self.assertIsNotNone(sold)
        assert sold is not None
        self.assertTrue(sold.sold)
        self.assertEqual(sold.reason, "stop_trigger")
        fraction = harness.loss_fraction(proposed.positions["GAP"])
        self.assertIsNotNone(fraction)
        assert fraction is not None
        self.assertGreater(fraction, D("0.05"))

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("GAP", o_curve)
        held = original.on_synthetic_mark("GAP", o_curve, D("0.70"))
        self.assertIsNone(held)
        self.assertEqual(original.positions["GAP"].status, "open")
        self.assertEqual(original.positions["GAP"].sol_out, 0)

    def test_delayed_fill_is_worse_than_the_trigger_mark(self) -> None:
        rate = D("0.01")
        sol_in = D("0.05")
        book = harness.ProposedBook(harness.BUDGET_SOL)
        curve = harness.fresh_curve()
        book.try_buy("LATE", curve, sol_in)
        pos = book.positions["LATE"]
        tokens_after_buy = pos.tokens
        vtok = curve.virtual_token
        entry = pos.entry_spot
        fill_spot = entry * D("0.80")
        expected = independent_sell(vtok * fill_spot, vtok, tokens_after_buy, rate)

        result = book.on_synthetic_mark("LATE", curve, D("0.94"), fill_ratio=D("0.80"))
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result.sold)
        self.assertEqual(result.reason, "stop_trigger")
        self.assertEqual(result.proceeds, expected)
        fraction = harness.loss_fraction(book.positions["LATE"])
        assert fraction is not None
        self.assertGreater(fraction, D("0.05"))

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("LATE", o_curve)
        self.assertIsNone(original.on_synthetic_mark("LATE", o_curve, D("0.94"), fill_ratio=D("0.80")))
        self.assertEqual(original.positions["LATE"].status, "open")

    def test_failed_exit_does_not_invent_proceeds(self) -> None:
        quiet = harness.ProposedBook(harness.BUDGET_SOL)
        q_curve = harness.fresh_curve()
        quiet.try_buy("FAIL", q_curve, D("0.05"))
        cash = quiet.cash
        tokens = quiet.positions["FAIL"].tokens
        missed = quiet.on_synthetic_mark("FAIL", q_curve, D("0.94"), fail="not_included")
        self.assertIsNotNone(missed)
        assert missed is not None
        self.assertFalse(missed.sold)
        self.assertEqual(missed.reason, "sell_failed_not_included")
        self.assertEqual(quiet.cash, cash)
        self.assertEqual(quiet.positions["FAIL"].status, "open")
        self.assertEqual(quiet.positions["FAIL"].tokens, tokens)
        self.assertEqual(quiet.positions["FAIL"].sol_out, 0)

        included = harness.ProposedBook(harness.BUDGET_SOL)
        i_curve = harness.fresh_curve()
        included.try_buy("FAIL", i_curve, D("0.05"))
        before = included.cash
        hit = included.on_synthetic_mark("FAIL", i_curve, D("0.94"), fail="included")
        assert hit is not None
        self.assertFalse(hit.sold)
        self.assertEqual(included.cash, before - D("0.000125"))
        self.assertEqual(included.positions["FAIL"].status, "open")
        self.assertEqual(included.positions["FAIL"].sol_out, 0)

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("FAIL", o_curve)
        before_o = original.cash
        # 0.40 is through the original 0.5 stop, so this isolates the failed-sell path.
        failed = original.on_synthetic_mark("FAIL", o_curve, D("0.40"), fail="not_included")
        assert failed is not None
        self.assertFalse(failed.sold)
        self.assertEqual(original.cash, before_o)
        self.assertEqual(original.positions["FAIL"].status, "open")

    def test_migration_original_drops_monitoring_proposed_locks_cash(self) -> None:
        proposed = harness.ProposedBook(harness.BUDGET_SOL)
        p_curve = harness.fresh_curve()
        proposed.try_buy("MIG", p_curve, D("0.05"))
        cash = proposed.cash
        spendable = proposed.spendable()
        p_curve.complete = True
        result = proposed.on_synthetic_mark("MIG", p_curve, D("1.50"))
        assert result is not None
        self.assertFalse(result.sold)
        self.assertEqual(result.reason, "stuck_migrated")
        self.assertEqual(proposed.positions["MIG"].status, "stuck_migrated")
        self.assertEqual(proposed.cash, cash)
        self.assertEqual(proposed.spendable(), spendable)
        self.assertGreater(proposed.positions["MIG"].tokens, 0)

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("MIG", o_curve)
        cash_o = original.cash
        tokens = original.positions["MIG"].tokens
        o_curve.complete = True
        dropped = original.on_synthetic_mark("MIG", o_curve, D("0.10"))
        assert dropped is not None
        self.assertEqual(dropped.reason, "dropped_unmonitored")
        self.assertEqual(original.open_positions(), [])
        self.assertEqual(original.orphan_tokens["MIG"], tokens)
        self.assertEqual(original.cash, cash_o)
        self.assertEqual(original.positions["MIG"].sol_out, 0)

    def test_restart_ledger_keeps_proposed_stop_and_original_forgets(self) -> None:
        proposed = harness.ProposedBook(harness.BUDGET_SOL)
        curve = harness.fresh_curve()
        proposed.try_buy("KEEP", curve, D("0.05"))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.json"
            proposed.save(path)
            text = path.read_text(encoding="utf-8")
            self.assertIn("SYNTHETIC", text)
            self.assertNotIn("keypair", text.lower())
            restored = harness.ProposedBook.load(path)
        self.assertEqual(restored.cash, proposed.cash)
        self.assertEqual(restored.positions["KEEP"].tokens, proposed.positions["KEEP"].tokens)
        self.assertEqual(restored.stop_ratio, D("0.95"))
        sold = restored.on_synthetic_mark("KEEP", curve, D("0.70"))
        assert sold is not None
        self.assertTrue(sold.sold)
        self.assertEqual(sold.reason, "stop_trigger")
        fraction = harness.loss_fraction(restored.positions["KEEP"])
        assert fraction is not None
        self.assertGreater(fraction, D("0.05"))

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("LOST", o_curve)
        tokens = original.positions["LOST"].tokens
        cash = original.cash
        fresh = original.restart_forgets_positions()
        self.assertEqual(fresh.open_positions(), [])
        self.assertEqual(fresh.orphan_tokens["LOST"], tokens)
        self.assertIsNone(fresh.on_synthetic_mark("LOST", o_curve, D("0.40")))
        self.assertEqual(fresh.cash, cash)

    def test_fixed_plus_10_percent_rule_exits_and_original_2x_rule_does_not(self) -> None:
        rate = D("0.01")
        sol_in = D("0.05")
        fixed = D("0.000225")
        book = harness.ProposedBook(harness.BUDGET_SOL)
        curve = harness.fresh_curve()
        book.try_buy("TP", curve, sol_in)
        pos = book.positions["TP"]
        vtok = curve.virtual_token
        fill_spot = pos.entry_spot * D("1.10")
        expected = independent_sell(vtok * fill_spot, vtok, pos.tokens, rate)
        expected_pnl = expected - fixed - pos.cost_basis
        self.assertGreater(expected_pnl, 0)

        result = book.on_synthetic_mark("TP", curve, D("1.10"))
        assert result is not None
        self.assertTrue(result.sold)
        self.assertEqual(result.reason, "take_profit")
        self.assertEqual(result.proceeds, expected)
        self.assertEqual(book.positions["TP"].cash_pnl(), expected_pnl)

        original = harness.OriginalBehaviorModel(harness.BUDGET_SOL)
        o_curve = harness.fresh_curve()
        original.on_create("TP", o_curve)
        self.assertIsNone(original.on_synthetic_mark("TP", o_curve, D("1.10")))
        self.assertEqual(original.positions["TP"].status, "open")
        fired = original.on_synthetic_mark("TP", o_curve, D("2.0"))
        assert fired is not None
        self.assertTrue(fired.sold)
        self.assertEqual(fired.reason, "original_tp")

    def test_adverse_slippage_and_protocol_rate_widen_the_cash_loss(self) -> None:
        def flat_pnl(rate: D, slippage: bool) -> D:
            fees = harness.FeeAssumption(protocol_rate=rate)
            book = harness.ProposedBook(harness.BUDGET_SOL, fees=fees)
            curve = harness.fresh_curve()
            book.try_buy("A", curve, D("0.05"))
            curve.set_spot(book.positions["A"].entry_spot)
            book.try_sell("A", curve, reason="flat", adverse_slippage=slippage)
            pnl = book.positions["A"].cash_pnl()
            assert pnl is not None
            return pnl

        base = flat_pnl(D("0.01"), False)
        slipped = flat_pnl(D("0.01"), True)
        wider_protocol = flat_pnl(D("0.0125"), False)
        self.assertLess(base, 0)
        self.assertLess(slipped, base)
        self.assertLess(wider_protocol, base)

        book = harness.ProposedBook(harness.BUDGET_SOL)
        curve = harness.fresh_curve()
        book.try_buy("STOP", curve, D("0.05"))
        plain = harness.ProposedBook(harness.BUDGET_SOL)
        plain_curve = harness.fresh_curve()
        plain.try_buy("STOP", plain_curve, D("0.05"))
        book.on_synthetic_mark("STOP", curve, D("0.95"), adverse_slippage=True)
        plain.on_synthetic_mark("STOP", plain_curve, D("0.95"), adverse_slippage=False)
        slipped_loss = harness.loss_fraction(book.positions["STOP"])
        plain_loss = harness.loss_fraction(plain.positions["STOP"])
        assert slipped_loss is not None and plain_loss is not None
        self.assertGreater(plain_loss, D("0.05"))
        self.assertGreater(slipped_loss, plain_loss)

    def test_sources_stay_offline_and_local(self) -> None:
        root = Path(__file__).resolve().parent
        allowed = {
            "harness.py": {"__future__", "argparse", "json", "dataclasses", "decimal", "pathlib"},
            "test_harness.py": {
                "__future__",
                "ast",
                "sys",
                "tempfile",
                "unittest",
                "decimal",
                "pathlib",
                "harness",
            },
        }
        for name, modules in allowed.items():
            path = root / name
            tree = ast.parse(path.read_text(encoding="utf-8"))
            found: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    found.update(alias.name.split(".")[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    found.add(node.module.split(".")[0])
            self.assertEqual(found, modules, name)
        harness_text = (root / "harness.py").read_text(encoding="utf-8").lower()
        for bit in (
            "web3",
            "helius",
            "keypair",
            ".env",
            "socket",
            "urllib",
            "requests",
            "sendrawtransaction",
            "bots/",
            "lib/",
        ):
            self.assertNotIn(bit, harness_text, bit)


if __name__ == "__main__":
    unittest.main(verbosity=2)
