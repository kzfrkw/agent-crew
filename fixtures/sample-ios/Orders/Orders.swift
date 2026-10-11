struct Order: Identifiable, Equatable {
    let id: Int
    let item: String
    let quantity: Int
}

func listOrders() -> [Order] {
    [Order(id: 1, item: "りんご", quantity: 3), Order(id: 2, item: "みかん", quantity: 1), Order(id: 3, item: "ぶどう", quantity: 2)]
}
