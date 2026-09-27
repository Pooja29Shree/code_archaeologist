"""Tests for the order module."""

from orders.order import Order


def test_order_checkout():
    order = Order("customer_1")
    order.add_product("Widget", 3, 50)
    result = order.checkout()
    assert result["total"] == 150.0
    assert result["status"] == "completed"
