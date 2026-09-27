"""
Discount calculation module.
Handles bulk discounts and promotional pricing.
"""


def calculate_discount(quantity, price_per_unit):
    """Calculate the total price after applying bulk discount.

    Rules:
        - 10 or more items: 20% discount
        - 5 or more items: 10% discount
        - Less than 5 items: no discount
    """
    # BUG: should be >= 10, but uses > 10
    if quantity > 10:
        discount = 0.20
    elif quantity >= 5:
        discount = 0.10
    else:
        discount = 0.0

    total = price_per_unit * quantity
    discounted_total = total * (1 - discount)
    return round(discounted_total, 2)


def get_discount_rate(quantity):
    """Return the discount rate for a given quantity."""
    if quantity > 10:
        return 0.20
    elif quantity >= 5:
        return 0.10
    return 0.0
