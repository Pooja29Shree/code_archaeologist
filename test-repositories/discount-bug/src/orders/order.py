"""
Order processing module.
"""

from pricing.cart import Cart


class Order:
    def __init__(self, customer_id):
        self.customer_id = customer_id
        self.cart = Cart()
        self.status = "pending"

    def add_product(self, name, quantity, price):
        self.cart.add_item(name, quantity, price)

    def checkout(self):
        total = self.cart.get_total()
        self.status = "completed"
        return {"customer": self.customer_id, "total": total, "status": self.status}
