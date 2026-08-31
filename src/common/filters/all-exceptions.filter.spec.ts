import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { BusinessRuleError, TenantMismatchError } from '@/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: { error: { code: string; message: string }; meta: { requestId: string; path: string } };
}

function runFilter(exception: unknown): CapturedResponse {
  const captured = {} as CapturedResponse;

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    send(body: CapturedResponse['body']) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ id: 'req-1', url: '/api/v1/orders' }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  it('maps an AppError to its own status and code', () => {
    const result = runFilter(new BusinessRuleError('Order is below the minimum quantity'));

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(result.body.error.message).toBe('Order is below the minimum quantity');
  });

  it('keeps the tenant mismatch code distinct from a plain forbidden', () => {
    const result = runFilter(new TenantMismatchError());

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('maps built-in Nest exceptions onto the shared error codes', () => {
    expect(runFilter(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
    expect(runFilter(new HttpException('nope', HttpStatus.TOO_MANY_REQUESTS)).body.error.code).toBe(
      'RATE_LIMITED',
    );
  });

  it('never leaks an unexpected error message shape', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = runFilter(new Error('connection string user=admin password=hunter2'));

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('always attaches correlation metadata', () => {
    const result = runFilter(new NotFoundException());

    expect(result.body.meta.requestId).toBe('req-1');
    expect(result.body.meta.path).toBe('/api/v1/orders');
  });
});
