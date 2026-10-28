import type { Request, Response } from 'express';
import {
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer,
  CustomerError,
} from '../services/customer.service.js';
import type { CreateCustomerInput, UpdateCustomerInput, GenderType } from '../types/customer.js';

export async function handleCreateCustomer(req: Request, res: Response): Promise<void> {
  try {
    const { full_name, phone, email, gender, address, notes } = req.body as CreateCustomerInput;
    const customer = await createCustomer({ full_name, phone, email, gender, address, notes });

    res.status(201).json({
      status: 'success',
      message: 'Customer profile created successfully',
      data: {
        customer,
      },
    });
  } catch (err: unknown) {
    if (err instanceof CustomerError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[create customer error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to create customer due to an internal server error',
    });
  }
}

export async function handleGetCustomers(req: Request, res: Response): Promise<void> {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const gender = typeof req.query.gender === 'string' ? (req.query.gender as GenderType) : undefined;

    const result = await getCustomers({ page, limit, search, gender });

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof CustomerError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[list customers error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve customers due to an internal server error',
    });
  }
}

export async function handleGetCustomerById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const customer = await getCustomerById(id);

    res.status(200).json({
      status: 'success',
      data: {
        customer,
      },
    });
  } catch (err: unknown) {
    if (err instanceof CustomerError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[get customer by id error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve customer due to an internal server error',
    });
  }
}

export async function handleUpdateCustomer(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { full_name, phone, email, gender, address, notes } = req.body as UpdateCustomerInput;
    const customer = await updateCustomer(id, { full_name, phone, email, gender, address, notes });

    res.status(200).json({
      status: 'success',
      message: 'Customer profile updated successfully',
      data: {
        customer,
      },
    });
  } catch (err: unknown) {
    if (err instanceof CustomerError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[update customer error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update customer due to an internal server error',
    });
  }
}
