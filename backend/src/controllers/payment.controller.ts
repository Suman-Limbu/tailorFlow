import type { Request, Response } from 'express';
import {
  recordPayment,
  recordRefund,
  getOrderPayments,
  PaymentError,
} from '../services/payment.service.js';
import type { RecordPaymentInput, RecordRefundInput } from '../types/payment.js';

export async function handleRecordPayment(req: Request, res: Response): Promise<void> {
  try {
    const { orderId } = req.params;
    const input = req.body as RecordPaymentInput;
    const result = await recordPayment(orderId, input, req.user!.id);

    res.status(201).json({
      status: 'success',
      message: 'Payment recorded successfully',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof PaymentError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[record payment error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to record payment due to an internal server error',
    });
  }
}

export async function handleRecordRefund(req: Request, res: Response): Promise<void> {
  try {
    const { orderId, paymentId } = req.params;
    const input = req.body as RecordRefundInput;
    const result = await recordRefund(orderId, paymentId, input, req.user!.id);

    res.status(201).json({
      status: 'success',
      message: 'Refund recorded successfully',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof PaymentError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[record refund error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process refund due to an internal server error',
    });
  }
}

export async function handleGetOrderPayments(req: Request, res: Response): Promise<void> {
  try {
    const { orderId } = req.params;
    const summary = await getOrderPayments(orderId);

    res.status(200).json({
      status: 'success',
      data: summary,
    });
  } catch (err: unknown) {
    if (err instanceof PaymentError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get order payments error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve payments due to an internal server error',
    });
  }
}
