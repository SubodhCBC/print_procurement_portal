import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ValidationError, type FieldIssue } from '@/common';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Validates and *parses* a payload with a Zod schema.
 *
 * Zod rather than class-validator because the same schema is reused to derive
 * the TypeScript type, to validate queue job payloads in the workers, and to
 * generate the OpenAPI body — one definition instead of three that drift.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues: FieldIssue[] = error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        }));
        throw new ValidationError('Request validation failed', { details: { issues } });
      }
      throw error;
    }
  }
}

/** Sugar for route handlers: `@Body(zodBody(CreateThingSchema)) body: CreateThing`. */
export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
