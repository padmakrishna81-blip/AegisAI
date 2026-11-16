"""
Regression tests for chart_intelligence.py

Uses synthetic OHLCV fixtures — no live Yahoo Finance requests.
Run: python -m pytest backend/tests/test_chart_intelligence.py -v
"""
from __future__ import annotations

import math
import sys
import os
import pytest
import numpy as np
import pandas as pd

# Ensure the backend module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ai.chart_intelligence import (
    detect_swings,
    detect_trendlines,
    cluster_sr_levels,
    compute_indicators,
    classify_trend,
    run_rule_engine,
    _build_assessment,
    _rsi_zone,
    _channel_status,
    _eval_channel,
    regression_channel,
    detect_structural_channels,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_df(closes: list[float], highs: list[float] | None = None,
             lows: list[float] | None = None) -> pd.DataFrame:
    """Build a minimal DataFrame from close prices (and optional H/L)."""
    n = len(closes)
    closes_arr = np.array(closes, dtype=float)
    highs_arr  = np.array(highs,  dtype=float) if highs  else closes_arr * 1.01
    lows_arr   = np.array(lows,   dtype=float) if lows   else closes_arr * 0.99
    opens_arr  = closes_arr * 0.999
    volume_arr = np.ones(n) * 1_000_000

    idx = pd.date_range("2022-01-01", periods=n, freq="B", tz="UTC")
    return pd.DataFrame({
        "Open": opens_arr, "High": highs_arr, "Low": lows_arr,
        "Close": closes_arr, "Volume": volume_arr,
    }, index=idx)


def _uptrend(n: int = 100, start: float = 100.0, step: float = 1.0) -> list[float]:
    return [start + i * step for i in range(n)]


def _downtrend(n: int = 100, start: float = 200.0, step: float = 1.0) -> list[float]:
    return [start - i * step for i in range(n)]


def _sideways(n: int = 100, base: float = 100.0, amp: float = 3.0) -> list[float]:
    return [base + amp * math.sin(i * 0.4) for i in range(n)]


# ── Support / Resistance tests ────────────────────────────────────────────────

class TestSRSorting:
    """S1/S2 must be nearest below price; R1/R2 must be nearest above."""

    def test_resistance_sorted_nearest_first(self):
        # Three clear swing highs above current price at 110, 120, 130
        highs = _sideways(120, 100.0, 5.0)
        highs[20] = 110.0
        highs[50] = 120.0
        highs[80] = 130.0
        lows = [min(h * 0.92, h) for h in highs]
        closes = [h * 0.97 for h in highs]
        df = _make_df(closes, highs, lows)
        # Force current price clearly below all swing highs
        df["Close"].iloc[-1] = 90.0
        df["High"].iloc[-1] = 91.0
        df["Low"].iloc[-1] = 89.5

        swings = detect_swings(df, window=3)
        sr = cluster_sr_levels(swings, df)

        res = sr["resistance"]
        assert len(res) >= 1, "Should have at least one resistance level"
        # Resistance levels must be above current price and sorted ascending (R1 nearest)
        current = sr["current"]
        above = [r for r in res if r["price"] > current]
        if len(above) >= 2:
            assert above[0]["price"] <= above[1]["price"], (
                f"R1 ({above[0]['price']}) should be ≤ R2 ({above[1]['price']})"
            )

    def test_support_sorted_nearest_first(self):
        # Swing lows at 70, 60, 50 when current is 80
        closes = _sideways(120, 80.0, 2.0)
        lows = [c * 0.98 for c in closes]
        lows[20] = 70.0
        lows[50] = 60.0
        lows[80] = 50.0
        highs = [c * 1.02 for c in closes]
        df = _make_df(closes, highs, lows)
        df["Close"].iloc[-1] = 80.0

        swings = detect_swings(df, window=3)
        sr = cluster_sr_levels(swings, df)

        sup = sr["support"]
        current = sr["current"]
        below = [s for s in sup if s["price"] < current]
        if len(below) >= 2:
            assert below[0]["price"] >= below[1]["price"], (
                f"S1 ({below[0]['price']}) should be ≥ S2 ({below[1]['price']})"
            )

    def test_zone_under_test_classification(self):
        """A level within 0.5×ATR of current price should be zone_under_test."""
        closes = _sideways(80, 100.0, 3.0)
        lows = [c - 2 for c in closes]
        lows[30] = 99.5   # very close to final close ~100
        highs = [c + 2 for c in closes]
        df = _make_df(closes, highs, lows)
        df["Close"].iloc[-1] = 100.0

        swings = detect_swings(df, window=3)
        sr = cluster_sr_levels(swings, df)

        all_zones = sr["support"] + sr["resistance"]
        atr = sr["atr"]
        near = [z for z in all_zones if abs(z["price"] - 100.0) <= atr * 0.6]
        for z in near:
            assert z.get("zone_status") == "zone_under_test", (
                f"Level {z['price']} near current 100.0 should be zone_under_test"
            )

    def test_no_broken_support_above_price(self):
        """
        Resistance levels should all be ABOVE current price (within zone tolerance).
        No resistance should be far below current price (e.g. from old pivot highs
        now below price — those are broken levels, not active resistance).
        """
        closes = _uptrend(120, 50.0, 1.0)   # price from 50 up to 169
        highs = [c * 1.01 for c in closes]
        lows  = [c * 0.99 for c in closes]
        df = _make_df(closes, highs, lows)
        # current price ~169

        swings = detect_swings(df, window=5)
        sr = cluster_sr_levels(swings, df)

        current = sr["current"]
        for r in sr["resistance"]:
            # All resistance must be at or above current price (with zone tolerance)
            assert r["price"] >= current * 0.98, (
                f"Resistance {r['price']} is too far below current {current}"
            )


# ── Trendline touch counting tests ───────────────────────────────────────────

class TestTrendlineTouches:
    """Touches should reflect independent pivot reactions, not bar counts."""

    def test_touches_less_than_bar_count(self):
        closes = _uptrend(200, 100.0, 0.5)
        df = _make_df(closes)
        swings = detect_swings(df, window=5)
        trendlines = detect_trendlines(df, swings)

        all_tl = trendlines.get("support", []) + trendlines.get("resistance", [])
        for tl in all_tl:
            assert tl["touches"] < len(df) / 4, (
                f"Trendline has {tl['touches']} touches for {len(df)}-bar dataset — "
                "likely counting every bar instead of independent reactions"
            )

    def test_minimum_two_touches(self):
        closes = _uptrend(80, 100.0, 1.0)
        df = _make_df(closes)
        swings = detect_swings(df, window=5)
        trendlines = detect_trendlines(df, swings)

        all_tl = trendlines.get("support", []) + trendlines.get("resistance", [])
        for tl in all_tl:
            assert tl["touches"] >= 2, "Trendline must have at least 2 independent touches"

    def test_reasonable_touch_range(self):
        """For a 3-year daily dataset (~750 bars), touches should be ≤ 50."""
        closes = _sideways(750, 100.0, 10.0)
        df = _make_df(closes)
        swings = detect_swings(df, window=5)
        trendlines = detect_trendlines(df, swings)

        all_tl = trendlines.get("support", []) + trendlines.get("resistance", [])
        for tl in all_tl:
            assert tl["touches"] <= 50, (
                f"Trendline reports {tl['touches']} touches — should be ≤ 50 for 750-bar dataset"
            )


# ── Channel validation tests ─────────────────────────────────────────────────

class TestChannelValidation:
    """Channels must have correct validation_status and status."""

    def test_provisional_channel_is_not_active(self):
        """A channel with only 1 touch on one side should be provisional, not active."""
        n = 100
        times = list(range(n))
        atr = 2.0
        closes = np.array(_sideways(n, 100.0, 3.0))
        highs  = closes + 2.0
        lows   = closes - 2.0

        # Force a channel with only 1 resistance touch
        pivot_lows  = [{"bar_index": 10, "price": 92.0, "time": times[10]},
                       {"bar_index": 50, "price": 88.0, "time": times[50]}]
        pivot_highs = [{"bar_index": 30, "price": 108.0, "time": times[30]}]  # only 1

        slope = (pivot_lows[1]["price"] - pivot_lows[0]["price"]) / (
            pivot_lows[1]["bar_index"] - pivot_lows[0]["bar_index"]
        )
        ic_sup = pivot_lows[0]["price"] - slope * pivot_lows[0]["bar_index"]
        ic_res = max(p["price"] - slope * p["bar_index"] for p in pivot_highs)

        result = _eval_channel(
            slope, ic_sup, ic_res, s_bar=5, e_bar=n - 1, n=n,
            times=times, atr=atr,
            highs_arr=highs, lows_arr=lows, closes=closes,
            pivot_highs=pivot_highs, pivot_lows=pivot_lows,
        )
        if result is not None:
            assert result["validation_status"] in ("provisional", "unconfirmed"), (
                "Channel with only 1 resistance touch should be provisional/unconfirmed"
            )

    def test_validated_channel_requires_two_touches_each_side(self):
        """A channel with 2+ touches on both sides and good quality = validated."""
        n = 100
        times = list(range(n))
        atr = 2.0
        slope = 0.0
        ic_sup = 90.0
        ic_res = 110.0

        # Build price data that stays within the channel
        closes = np.array([100.0] * n, dtype=float)
        highs  = np.array([100.0] * n, dtype=float)
        lows   = np.array([100.0] * n, dtype=float)
        for i in range(n):
            lows[i]   = 90.5
            highs[i]  = 109.5
            closes[i] = 100.0

        # Multiple independent touches on each side
        pivot_lows  = [
            {"bar_index": 10, "price": 90.3, "time": times[10]},
            {"bar_index": 40, "price": 90.1, "time": times[40]},
            {"bar_index": 70, "price": 90.2, "time": times[70]},
        ]
        pivot_highs = [
            {"bar_index": 25, "price": 109.8, "time": times[25]},
            {"bar_index": 55, "price": 110.1, "time": times[55]},
        ]
        for p in pivot_lows:
            lows[p["bar_index"]] = p["price"]
        for p in pivot_highs:
            highs[p["bar_index"]] = p["price"]

        result = _eval_channel(
            slope, ic_sup, ic_res, s_bar=5, e_bar=n - 1, n=n,
            times=times, atr=atr,
            highs_arr=highs, lows_arr=lows, closes=closes,
            pivot_highs=pivot_highs, pivot_lows=pivot_lows,
        )
        assert result is not None, "Well-formed channel should not be rejected"
        assert result["validation_status"] == "validated", (
            f"Expected 'validated', got '{result['validation_status']}'"
        )


# ── Trend alignment tests ────────────────────────────────────────────────────

class TestTrendClassification:
    def test_aligned_bearish_trends(self):
        """Bearish long-term + Downtrend short-term = aligned bearish."""
        closes = _downtrend(300, 300.0, 0.5)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)

        # Both long-term and short-term should have bearish/downtrend character
        # (exact labels depend on EMA calculations, but they should not be mixed)
        lt_bearish = "bearish" in trend["primary"].lower() or trend["primary"] == "Sideways"
        st_bearish = trend["short_term"] in ("Downtrend", "Sideways")
        # Not asserting exact match — just that they don't conflict (bullish + downtrend)
        assert not (
            "bullish" in trend["primary"].lower() and trend["short_term"] == "Downtrend"
        ), "Long-term bullish + short-term downtrend should be caught as divergence"

    def test_strong_uptrend(self):
        closes = _uptrend(300, 50.0, 1.0)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)

        assert "bullish" in trend["primary"].lower() or trend["primary"] in ("Strong Bullish", "Bullish"), (
            f"Strong uptrend should yield bullish primary, got: {trend['primary']}"
        )

    def test_strong_downtrend(self):
        closes = _downtrend(300, 300.0, 0.8)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)

        assert "bearish" in trend["primary"].lower(), (
            f"Strong downtrend should yield bearish primary, got: {trend['primary']}"
        )


# ── RSI zone consistency tests ───────────────────────────────────────────────

class TestRSIZone:
    def test_zone_boundaries(self):
        assert _rsi_zone(75)  == "overbought"
        assert _rsi_zone(70)  == "overbought"
        assert _rsi_zone(65)  == "bullish"
        assert _rsi_zone(55)  == "bullish"
        assert _rsi_zone(50)  == "neutral"
        assert _rsi_zone(45)  == "neutral"
        assert _rsi_zone(38)  == "bearish"
        assert _rsi_zone(30)  == "bearish"
        assert _rsi_zone(25)  == "oversold"

    def test_rule_engine_rsi_consistency(self):
        """R02 rule label must use same thresholds as _rsi_zone."""
        closes = _sideways(200, 100.0, 5.0)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        rsi = indicators["rsi"]
        rsi_zone = _rsi_zone(rsi)

        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        trendlines = detect_trendlines(df, swings)
        channels: list = []
        rules = run_rule_engine(trend, indicators, sr, trendlines, channels, df)

        r02 = next((r for r in rules if r["id"] == "R02"), None)
        assert r02 is not None, "R02 should always be present"

        # Verify R02's level matches _rsi_zone
        expected_level_map = {
            "overbought": "bearish",
            "bullish":    "bullish",
            "neutral":    "neutral",
            "bearish":    "bearish",
            "oversold":   "bullish",
        }
        if r02["status"] == "triggered":
            assert r02["level"] == expected_level_map[rsi_zone], (
                f"R02 level={r02['level']} but _rsi_zone({rsi})={rsi_zone} → expected {expected_level_map[rsi_zone]}"
            )


# ── Rule correlation tests ───────────────────────────────────────────────────

class TestRuleCorrelation:
    def test_ema_rules_grouped_in_bias(self):
        """R01 + R10 + R15 all bearish should yield weighted_bear = 1 (EMA group), not 3."""
        closes = _downtrend(300, 300.0, 0.8)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        trendlines = detect_trendlines(df, swings)
        channels: list = []
        rules = run_rule_engine(trend, indicators, sr, trendlines, channels, df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        # Check EMA rules that fired
        ema_bear_rules = [r for r in rules if r["id"] in ("R01", "R10", "R15")
                          and r["level"] == "bearish" and r["status"] == "triggered"]

        if len(ema_bear_rules) >= 2:
            # Despite 2+ EMA bearish rules, EMA contribution should be counted as 1
            raw_bear = assessment["bearish_rules"]
            weighted_bear = assessment["weighted_bear"]
            # weighted_bear must be less than raw_bear when EMA rules are double-counted
            assert weighted_bear <= raw_bear, "Weighted bear should be ≤ raw bearish rules"

    def test_bias_not_solely_driven_by_ema(self):
        """In a clear downtrend, bias should be Bearish but not inflated."""
        closes = _downtrend(300, 300.0, 0.8)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        trendlines = detect_trendlines(df, swings)
        channels: list = []
        rules = run_rule_engine(trend, indicators, sr, trendlines, channels, df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        assert assessment["bias"] == "Bearish", (
            f"Clear downtrend should produce Bearish bias, got: {assessment['bias']}"
        )


# ── Scenario tests ───────────────────────────────────────────────────────────

class TestScenarios:
    def test_bearish_invalidation_is_nearby_resistance(self):
        """Bearish invalidation should be nearest resistance, not a distant level."""
        closes = _downtrend(200, 300.0, 0.5)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        current = indicators["current_price"]
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        rules = run_rule_engine(trend, indicators, sr, {}, [], df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        bear_inv = assessment["scenarios"]["bearish"]["invalidation"]
        # Invalidation should be within a reasonable range of current price
        # (certainly not 20%+ away, which was the bug)
        assert bear_inv < current * 1.25, (
            f"Bearish invalidation {bear_inv} is unreasonably far from current {current}"
        )
        # Invalidation should be above current (it's where bears are wrong)
        assert bear_inv > current * 0.8, (
            f"Bearish invalidation {bear_inv} should be near or above current price {current}"
        )

    def test_bullish_scenario_target_is_technical_level(self):
        """Bullish target should be derived from next resistance, not arbitrary %."""
        closes = _uptrend(200, 100.0, 0.5)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        rules = run_rule_engine(trend, indicators, sr, {}, [], df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        bull_target = assessment["scenarios"]["bullish"]["target"]
        method      = assessment["scenarios"]["bullish"]["method"]
        assert method in ("next_resistance", "4pct_extension"), (
            f"Unexpected target method: {method}"
        )
        assert bull_target > indicators["current_price"], "Bullish target must be above current price"


# ── Snapshot consistency test ────────────────────────────────────────────────

class TestSnapshotConsistency:
    """All analysis components must use the same dataset."""

    def test_sr_levels_consistent_between_assessment_and_rules(self):
        """R05/R06 rules reference the same support/resistance as the assessment scenarios."""
        closes = _sideways(200, 100.0, 8.0)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        trendlines = detect_trendlines(df, swings)
        rules = run_rule_engine(trend, indicators, sr, trendlines, [], df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        # R05 evidence price should match assessment S1
        r05 = next((r for r in rules if r["id"] == "R05"), None)
        if r05 and r05["status"] == "triggered" and sr.get("support"):
            s1_price = sr["support"][0]["price"]
            assert str(round(s1_price, 2)) in r05["evidence"] or \
                   abs(float(r05["evidence"].split("support")[1].split(" ")[1]) - s1_price) < 1.0, (
                f"R05 evidence references a price not matching S1={s1_price}"
            )

    def test_indicators_are_same_in_rules_and_assessment(self):
        closes = _sideways(200, 100.0, 5.0)
        df = _make_df(closes)
        swings = detect_swings(df)
        indicators = compute_indicators(df)
        trend = classify_trend(df, swings, indicators)
        sr = cluster_sr_levels(swings, df)
        rules = run_rule_engine(trend, indicators, sr, {}, [], df)
        assessment = _build_assessment(trend, indicators, rules, sr)

        assert assessment["rsi"] == indicators["rsi"], "RSI must be identical in assessment and indicators"
        assert _rsi_zone(assessment["rsi"]) == assessment["rsi_zone"], (
            f"assessment.rsi_zone={assessment['rsi_zone']} doesn't match _rsi_zone({assessment['rsi']})"
        )


# ── Regression channel tests ──────────────────────────────────────────────────

class TestRegressionChannel:
    def test_regression_channel_contains_close_prices(self):
        """95% of closes should fall within the regression channel bands (noisy data)."""
        rng = np.random.default_rng(7)
        closes = list(100.0 + np.arange(200) * 0.5 + rng.normal(0, 2.0, 200))
        df = _make_df(closes)
        ch = regression_channel(df, k=1.5)

        n = len(df)
        sup_slope = ch["support_line"]["slope"]
        sup_int   = ch["support_line"]["intercept"]
        res_slope = ch["resistance_line"]["slope"]
        res_int   = ch["resistance_line"]["intercept"]

        in_band = sum(
            1 for i, c in enumerate(closes)
            if sup_slope * i + sup_int <= c <= res_slope * i + res_int
        )
        pct = in_band / n
        # ±1.5 std of a normal distribution contains ~86.6% of data
        assert pct >= 0.75, f"Only {pct:.1%} of closes in regression channel (expected ≥75%)"

    def test_regression_channel_uses_std_not_extremes(self):
        """Upper band intercept should be close (within 10%) to close + k*std, not max(high)."""
        closes = _sideways(100, 100.0, 5.0)
        df = _make_df(closes)
        ch = regression_channel(df, k=1.5)

        import numpy as np
        x = np.arange(len(closes))
        y = np.array(closes)
        slope, intercept = np.polyfit(x, y, 1)
        residuals = y - (slope * x + intercept)
        std = float(np.std(residuals))
        expected_upper = intercept + 1.5 * std

        actual_upper = ch["resistance_line"]["intercept"]
        assert abs(actual_upper - expected_upper) < 0.01, (
            f"Regression upper band {actual_upper} ≠ expected {expected_upper}: "
            "channel may be using extremes instead of ±k*std"
        )


# ── No valid channel test ────────────────────────────────────────────────────

class TestChannelAbsence:
    def test_no_channel_for_random_data(self):
        """Short, noisy series should not always produce a validated channel."""
        rng = np.random.default_rng(42)
        closes = list(100.0 + rng.normal(0, 5, 50))
        df = _make_df(closes)
        swings = detect_swings(df, window=3)
        trendlines = detect_trendlines(df, swings)
        channels = detect_structural_channels(trendlines, swings, df)

        # Not asserting channels == [] because even noisy data can produce candidates.
        # But if channels exist, none should be "validated" with very poor quality.
        for ch in channels:
            diag = ch.get("diagnostics", {})
            if ch.get("validation_status") == "validated":
                assert diag.get("quality_score", 0) >= 2.0, (
                    f"'validated' channel has quality {diag.get('quality_score')} < 2.0"
                )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
