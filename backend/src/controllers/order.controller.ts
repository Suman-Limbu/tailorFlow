import type { Request, Response } from 'express';
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrder,
  changeOrderStatus,
  assignItemTailor,
  OrderError,
} from '../services/order.service.js';
import type {
  CreateOrderInput,
  UpdateOrderInput,
  ChangeOrderStatusInput,
  OrderStatus,
  OrderPriority,
} from '../types/order.js';

export async function handleCreateOrder(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as CreateOrderInput;
    const order = await createOrder(input, req.user!.id);

    res.status(201).json({
      status: 'success',
      message: 'Order created successfully',
      data: {
        order,
      },
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[create order error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to create order due to an internal server error',
    });
  }
}

export async function handleGetOrders(req: Request, res: Response): Promise<void> {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const status = req.query.status as OrderStatus | undefined;
    const customer_id = req.query.customer_id as string | undefined;
    const assigned_tailor_id = req.query.assigned_tailor_id as string | undefined;
    const priority = req.query.priority as OrderPriority | undefined;
    const due_date = req.query.due_date as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await getOrders(
      { page, limit, status, customer_id, assigned_tailor_id, priority, due_date, search },
      req.user!
    );

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get orders error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve orders due to an internal server error',
    });
  }
}

export async function handleGetOrderById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const order = await getOrderById(id, req.user!);

    res.status(200).json({
      status: 'success',
      data: {
        order,
      },
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get order by id error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve order due to an internal server error',
    });
  }
}

export async function handleUpdateOrder(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const input = req.body as UpdateOrderInput;
    const order = await updateOrder(id, input, req.user!);

    res.status(200).json({
      status: 'success',
      message: 'Order updated successfully',
      data: {
        order,
      },
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[update order error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update order due to an internal server error',
    });
  }
}

export async function handleChangeOrderStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const input = req.body as ChangeOrderStatusInput;
    const order = await changeOrderStatus(id, input, req.user!);

    res.status(200).json({
      status: 'success',
      message: 'Order status updated successfully',
      data: {
        order,
      },
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[change order status error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update order status due to an internal server error',
    });
  }
}

export async function handleAssignItemTailor(req: Request, res: Response): Promise<void> {
  try {
    const { id, itemId } = req.params;
    const { assigned_tailor_id } = req.body as { assigned_tailor_id: string | null };

    const item = await assignItemTailor(id, itemId, assigned_tailor_id || null);

    res.status(200).json({
      status: 'success',
      message: 'Garment item tailor assignment updated successfully',
      data: {
        item,
      },
    });
  } catch (err: unknown) {
    if (err instanceof OrderError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[assign item tailor error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to assign tailor to garment item due to an internal server error',
    });
  }
}
