export class OrderRepository {
  async save(order: Order) {
    return OrderModel.create(order);
  }
}

export async function createOrder(repository: OrderRepository, input: OrderInput) {
  return repository.save(validateOrder(input));
}
