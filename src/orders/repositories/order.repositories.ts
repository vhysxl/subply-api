import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { NeonDatabase } from 'drizzle-orm/neon-serverless';
import { DATABASE_CONNECTION } from 'src/database/database-connection';
import * as schemas from 'schemas/tables';
import {
  GetOrderData,
  GetOrderDetails,
  Order,
  orderRequest,
} from '../interface';
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  sql,
  sum,
} from 'drizzle-orm';
import { today } from 'src/common/constants/today.date';

@Injectable()
export class OrderRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: NeonDatabase<typeof schemas>,
  ) {}

  async createVoucherOrder({
    userId,
    gameId,
    value,
    type,
    customerName,
    email,
    quantity,
  }: orderRequest) {
    try {
      //pake trx biar atomic
      const order = await this.db.transaction(async (trx) => {
        //cek ketersediaan voucher
        const availableVouchers = await trx
          .select({
            product: schemas.productsTable,
            gameName: schemas.games.name,
          })
          .from(schemas.productsTable)
          .innerJoin(
            schemas.games,
            eq(schemas.productsTable.gameId, schemas.games.gameId),
          )
          .where(
            and(
              eq(schemas.productsTable.status, 'available'),
              eq(schemas.productsTable.type, type),
              eq(schemas.productsTable.gameId, gameId),
              eq(schemas.productsTable.value, String(value)),
            ),
          )
          .limit(quantity);

        //throw kalo voucher kurang
        if (availableVouchers.length < quantity) {
          throw new NotFoundException(
            `Only ${availableVouchers.length} vouchers available, but ${quantity} requested`,
          );
        }

        // ambil data voucher pertama jadi patokan data
        const firstVoucher = availableVouchers[0];
        const totalPrice = Number(firstVoucher.product.price) * quantity;
        const productIds = availableVouchers.map((v) => v.product.productId);

        //bikin order
        const [newOrder] = await trx
          .insert(schemas.ordersTable)
          .values({
            userId: userId,
            customerName: customerName,
            email: email,
            value: firstVoucher.product.value,
            priceTotal: String(totalPrice),
            type: firstVoucher.product.type,
            status: 'pending',
            target: '',
            gameName: firstVoucher.gameName,
          })
          .returning();

        //insert produk dan order ke table junction
        const orderProducts = await trx
          .insert(schemas.orderProductsTable)
          .values(
            availableVouchers.map((voucher) => ({
              orderId: newOrder.orderId,
              productId: voucher.product.productId,
              quantity: 1,
            })),
          )
          .returning();

        //set status voucher yang dipake ke used
        await trx
          .update(schemas.productsTable)
          .set({
            status: 'used',
            updatedAt: new Date(),
          })
          .where(inArray(schemas.productsTable.productId, productIds));

        //casting tipe data
        const order: Order = {
          ...newOrder,
          value: Number(newOrder.value),
          priceTotal: Number(newOrder.priceTotal),
          productsOrder: orderProducts,
          quantity: orderProducts.reduce((sum, item) => sum + item.quantity, 0),
        };

        return order;
      });

      return order;
    } catch (error) {
      console.error('Error creating quick order:', error);

      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        'Failed to create order, please try again later',
      );
    }
  }

  async createDirectTopup({
    userId,
    gameId,
    value,
    type,
    customerName,
    email,
    target,
    quantity,
  }: orderRequest) {
    try {
      const order = await this.db.transaction(async (trx) => {
        //cari produk (takutnya produk goib)
        const [availableProduct] = await trx
          .select({
            product: schemas.productsTable,
            gameName: schemas.games.name,
          })
          .from(schemas.productsTable)
          .innerJoin(
            schemas.games,
            eq(schemas.productsTable.gameId, schemas.games.gameId),
          )
          .where(
            and(
              eq(schemas.productsTable.status, 'available'),
              eq(schemas.productsTable.type, type),
              eq(schemas.productsTable.gameId, gameId),
              eq(schemas.productsTable.value, String(value)),
            ),
          )
          .limit(1);

        //throw error kalo goib
        if (!availableProduct) {
          throw new NotFoundException('No available topup option');
        }

        const totalPrice = Number(availableProduct.product.price) * quantity;

        //buat order baru
        const [newOrder] = await trx
          .insert(schemas.ordersTable)
          .values({
            userId: userId,
            customerName: customerName,
            email: email,
            value: availableProduct.product.value,
            priceTotal: String(totalPrice),
            type: availableProduct.product.type,
            status: 'pending',
            target: target,
            gameName: availableProduct.gameName,
          })
          .returning();

        // insert ke junction table
        const orderProducts = await trx
          .insert(schemas.orderProductsTable)
          .values({
            orderId: newOrder.orderId,
            productId: availableProduct.product.productId,
            quantity: quantity,
          })
          .returning();

        //casting
        const order: Order = {
          ...newOrder,
          priceTotal: Number(newOrder.priceTotal),
          value: Number(newOrder.value),
          productsOrder: orderProducts,
          quantity: orderProducts.reduce((sum, item) => sum + item.quantity, 0),
        };

        return order;
      });

      return order;
    } catch (error) {
      console.error('Error creating quick order:', error);

      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        'Failed to create order, please try again later',
      );
    }
  }

  async fallbackDeleteOrder(orderId: string, type: 'voucher' | 'topup') {
    try {
      await this.db.transaction(async (trx) => {
        // ambil products id
        const products = await trx
          .select({ productId: schemas.orderProductsTable.productId })
          .from(schemas.orderProductsTable)
          .where(eq(schemas.orderProductsTable.orderId, orderId));

        const productIds = products.map((v) => v.productId);

        if (productIds.length > 0 && type === 'voucher') {
          await trx
            .update(schemas.productsTable)
            .set({ status: 'available' })
            .where(inArray(schemas.productsTable.productId, productIds));
        }

        await trx
          .delete(schemas.ordersTable)
          .where(eq(schemas.ordersTable.orderId, orderId));
      });
    } catch (error) {
      console.error('Error deleting order:', error);
    }
  }

  async getOrdersByUser(userId: string) {
    try {
      // Get orders with payments
      const ordersWithPayments = await this.db
        .select({
          orderId: schemas.ordersTable.orderId,
          target: schemas.ordersTable.target,
          status: schemas.ordersTable.status,
          createdAt: schemas.ordersTable.createdAt,
          priceTotal: schemas.ordersTable.priceTotal,
          value: schemas.ordersTable.value,
          type: schemas.ordersTable.type,
          gameName: schemas.ordersTable.gameName,
          paymentLink: schemas.paymentsTable.paymentLink,
          quantity: sum(schemas.orderProductsTable.quantity),
        })
        .from(schemas.ordersTable)
        .leftJoin(
          schemas.paymentsTable,
          eq(schemas.ordersTable.orderId, schemas.paymentsTable.orderId),
        )
        .leftJoin(
          schemas.orderProductsTable,
          eq(schemas.ordersTable.orderId, schemas.orderProductsTable.orderId),
        )
        .groupBy(
          schemas.ordersTable.orderId,
          schemas.ordersTable.target,
          schemas.ordersTable.status,
          schemas.ordersTable.createdAt,
          schemas.ordersTable.priceTotal,
          schemas.ordersTable.value,
          schemas.ordersTable.type,
          schemas.ordersTable.gameName,
          schemas.paymentsTable.paymentLink,
        )
        .where(eq(schemas.ordersTable.userId, userId))
        .orderBy(desc(schemas.ordersTable.createdAt));

      //casting
      const data: GetOrderData[] = ordersWithPayments.map((v) => ({
        ...v,
        quantity: Number(v.quantity),
        priceTotal: Number(v.priceTotal),
        value: Number(v.value),
      }));

      return data;
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException('Failed to fetch orders');
    }
  }

  async getOrderDetails(orderId: string, userId: string) {
    try {
      //ambil singular order
      const [orderResult] = await this.db
        .select({
          orderId: schemas.ordersTable.orderId,
          userId: schemas.ordersTable.userId,
          target: schemas.ordersTable.target,
          status: schemas.ordersTable.status,
          createdAt: schemas.ordersTable.createdAt,
          priceTotal: schemas.ordersTable.priceTotal,
          value: schemas.ordersTable.value,
          type: schemas.ordersTable.type,
          gameName: schemas.ordersTable.gameName,
          paymentLink: schemas.paymentsTable.paymentLink,
          quantity: sum(schemas.orderProductsTable.quantity),
        })
        .from(schemas.ordersTable)
        .leftJoin(
          schemas.paymentsTable,
          eq(schemas.ordersTable.orderId, schemas.paymentsTable.orderId),
        )
        .leftJoin(
          schemas.orderProductsTable,
          eq(schemas.ordersTable.orderId, schemas.orderProductsTable.orderId),
        )
        .groupBy(
          schemas.ordersTable.orderId,
          schemas.ordersTable.target,
          schemas.ordersTable.status,
          schemas.ordersTable.createdAt,
          schemas.ordersTable.priceTotal,
          schemas.ordersTable.value,
          schemas.ordersTable.type,
          schemas.ordersTable.gameName,
          schemas.paymentsTable.paymentLink,
        )
        .where(
          and(
            eq(schemas.ordersTable.orderId, orderId),
            eq(schemas.ordersTable.userId, userId),
          ),
        );

      if (!orderResult) {
        throw new NotFoundException('Order not found');
      }

      //ambil codes
      const codes = await this.db
        .select({
          orderId: schemas.orderProductsTable.orderId,
          codes: schemas.productsTable.code,
        })
        .from(schemas.orderProductsTable)
        .leftJoin(
          schemas.productsTable,
          eq(
            schemas.orderProductsTable.productId,
            schemas.productsTable.productId,
          ),
        )
        .where(eq(schemas.orderProductsTable.orderId, orderResult.orderId));

      const baseResult = {
        ...orderResult,
        priceTotal: Number(orderResult.priceTotal),
        value: Number(orderResult.value),
        quantity: Number(orderResult.quantity),
      };

      const voucherCodes =
        orderResult.type === 'voucher'
          ? codes.map((c) => c.codes).filter((code) => code !== null) // left join makanya perlu null check
          : null;

      const finalResult: GetOrderDetails = {
        ...baseResult,
        voucherCode: voucherCodes,
      };

      return finalResult;
    } catch (error) {
      console.error(error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to fetch order details');
    }
  }

  async updateOrderStatus(
    orderId: string,
    status: 'pending' | 'completed' | 'cancelled' | 'processed' | 'failed',
  ) {
    try {
      const [updatedOrder] = await this.db
        .update(schemas.ordersTable)
        .set({
          status: status,
        })
        .where(eq(schemas.ordersTable.orderId, orderId))
        .returning();

      if (!updatedOrder) {
        throw new NotFoundException('Order not found');
      }

      const { value, priceTotal } = updatedOrder;

      const convertedOrder = {
        ...updatedOrder,
        value: Number(value),
        priceTotal: Number(priceTotal),
      };

      return convertedOrder;
    } catch (error) {
      console.error('Error updating order status:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error.code === '22P02') {
        throw new NotFoundException('Order not found');
      }

      throw new InternalServerErrorException(
        'Failed to update order status, please try again later',
      );
    }
  }

  async cancelOder(orderId: string, userId: string) {
    try {
      const result = await this.db.transaction(async (trx) => {
        const [result] = await trx
          .update(schemas.ordersTable)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(schemas.ordersTable.orderId, orderId),
              eq(schemas.ordersTable.userId, userId),
              //avoid canceling completed order
              inArray(schemas.ordersTable.status, ['pending', 'processed']),
            ),
          )
          .returning();

        if (!result) {
          throw new NotFoundException('Order not found or cannot be cancelled');
        }

        const productsToRecover = await trx
          .select({
            productId: schemas.orderProductsTable.productId,
          })
          .from(schemas.orderProductsTable)
          .where(eq(schemas.orderProductsTable.orderId, result.orderId));

        const productIds = productsToRecover.map((v) => v.productId);

        if (productIds.length > 0 && result.type === 'voucher') {
          await trx
            .update(schemas.productsTable)
            .set({ status: 'available' })
            .where(inArray(schemas.productsTable.productId, productIds));
        }

        return result;
      });

      if (!result) {
        throw new NotFoundException('Orders not found');
      }

      const castedResult = {
        ...result,
        priceTotal: Number(result.priceTotal),
        value: Number(result.value),
      };

      return castedResult;
    } catch (error) {
      console.error(error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Failed to cancel order, Please try again later',
      );
    }
  }

  async getAllOrders(page: number = 1, limit: number = 20) {
    try {
      const offset = (page - 1) * limit;
      const orders = await this.db
        .select({
          ...getTableColumns(schemas.ordersTable),
          paymentStatus: schemas.paymentsTable.status,
          paymentMethod: schemas.paymentsTable.paymentMethod,
          paymentLink: schemas.paymentsTable.paymentLink,
          paidAt: schemas.paymentsTable.paidAt,
          quantity: sum(schemas.orderProductsTable.quantity).as(
            'total_quantity',
          ),
        })
        .from(schemas.ordersTable)
        .leftJoin(
          schemas.paymentsTable,
          eq(schemas.ordersTable.orderId, schemas.paymentsTable.orderId),
        )
        .leftJoin(
          schemas.orderProductsTable,
          eq(schemas.ordersTable.orderId, schemas.orderProductsTable.orderId),
        )
        .groupBy(
          schemas.ordersTable.orderId,
          schemas.ordersTable.userId,
          schemas.ordersTable.target,
          schemas.ordersTable.status,
          schemas.ordersTable.priceTotal,
          schemas.ordersTable.value,
          schemas.ordersTable.type,
          schemas.ordersTable.gameName,
          schemas.ordersTable.customerName,
          schemas.ordersTable.email,
          schemas.ordersTable.createdAt,
          schemas.paymentsTable.status,
          schemas.paymentsTable.paymentMethod,
          schemas.paymentsTable.paymentLink,
          schemas.paymentsTable.paidAt,
        )
        .orderBy(desc(schemas.ordersTable.createdAt))
        .limit(limit)
        .offset(offset);

      return orders.map((order) => ({
        ...order,
        value: Number(order.value),
        priceTotal: Number(order.priceTotal),
        quantity: Number(order.quantity),
      }));
    } catch (error) {
      console.error('Error fetching all orders:', error);
      throw new InternalServerErrorException('Error fetching all orders');
    }
  }

  async newOrdersToday() {
    try {
      const [{ count }] = await this.db
        .select({ count: sql`COUNT(*)`.as('count') })
        .from(schemas.ordersTable)
        .where(gte(schemas.ordersTable.createdAt, today));

      return Number(count);
    } catch (error) {
      console.error('Error fetching new orders today:', error);
      throw new InternalServerErrorException('Error fetching new orders today');
    }
  }

  async getDailyCompletedRevenue() {
    try {
      const [{ total }] = await this.db
        .select({
          total: sql`COALESCE(SUM(price_total), 0)`.as('total'),
        })
        .from(schemas.ordersTable)
        .where(
          and(
            eq(schemas.ordersTable.status, 'completed'),
            gte(schemas.ordersTable.createdAt, today),
          ),
        );

      return Number(total);
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException('Failed to sum completed revenue');
    }
  }
}
