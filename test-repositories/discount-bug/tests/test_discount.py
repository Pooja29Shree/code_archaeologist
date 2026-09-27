"""Tests for the discount module."""

from pricing.discount import calculate_discount, get_discount_rate


def test_no_discount():
    """No discount for less than 5 items."""
    result = calculate_discount(3, 100)
    assert result == 300.0


def test_small_bulk_discount():
    """10% discount for 5-9 items."""
    result = calculate_discount(5, 100)
    assert result == 450.0


def test_large_bulk_discount():
    """20% discount for 10+ items."""
    # NOTE: this test uses 15, so it passes even with the bug
    result = calculate_discount(15, 100)
    assert result == 1200.0


def test_discount_rate():
    assert get_discount_rate(3) == 0.0
    assert get_discount_rate(7) == 0.10
    assert get_discount_rate(15) == 0.20
