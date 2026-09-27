"""
Shopping cart module.
Manages items and calculates totals using the discount engine.
"""

from pricing.discount import calculate_discount


class Cart:
    def __init__(self):
        self.items = []

    def add_item(self, name, quantity, price_per_unit):
        self.items.append({
            "name": name,
            "quantity": quantity,
            "price_per_unit": price_per_unit,
        })

    def get_total(self):
        total = 0
        for item in self.items:
            total += calculate_discount(item["quantity"], item["price_per_unit"])
        return round(total, 2)

    def clear(self):
        self.items = []
