import type { Request, Response } from 'express';
import {
  registerCustomer,
  login,
  createStaffAccount,
  AuthError,
  type RegisterCustomerInput,
  type LoginInput,
  type CreateStaffInput,
} from '../services/auth.service.js';

export async function handleRegister(req: Request, res: Response): Promise<void> {
  try {
    const { full_name, email, phone, password } = req.body as RegisterCustomerInput;
    // Note: any 'role' supplied by client is strictly ignored
    const result = await registerCustomer({ full_name, email, phone, password });

    res.status(201).json({
      status: 'success',
      message: 'Account registered successfully',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[auth register error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Registration failed due to an internal server error',
    });
  }
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
  try {
    const { identifier, password } = req.body as LoginInput;
    const result = await login({ identifier, password });

    res.status(200).json({
      status: 'success',
      message: 'Logged in successfully',
      data: result,
    });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[auth login error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Login failed due to an internal server error',
    });
  }
}

export async function handleGetMe(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: 'error',
      message: 'Authentication required',
    });
    return;
  }

  res.status(200).json({
    status: 'success',
    data: {
      user: req.user,
    },
  });
}

export async function handleCreateStaff(req: Request, res: Response): Promise<void> {
  try {
    const { full_name, email, phone, password, role } = req.body as CreateStaffInput;
    const staff = await createStaffAccount({ full_name, email, phone, password, role });

    res.status(201).json({
      status: 'success',
      message: 'Staff account created successfully',
      data: {
        staff,
      },
    });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({
        status: 'error',
        message: err.message,
      });
      return;
    }

    console.error('[auth create staff error]', err instanceof Error ? err.message : err);
    res.status(500).json({
      status: 'error',
      message: 'Staff account creation failed due to an internal server error',
    });
  }
}
