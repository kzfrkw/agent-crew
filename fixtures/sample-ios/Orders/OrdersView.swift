import SwiftUI

struct OrdersView: View {
    var body: some View {
        NavigationStack {
            List(listOrders()) { o in
                HStack {
                    Text("#\(o.id)").foregroundStyle(.secondary)
                    Text(o.item)
                    Spacer()
                    Text("\(o.quantity) 個")
                }
            }
            .navigationTitle("注文の一覧")
        }
    }
}
