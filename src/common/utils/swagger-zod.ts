import { ApiBody, type ApiBodyOptions } from '@nestjs/swagger';
import type { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * The `schema`-carrying half of ApiBodyOptions, derived rather than imported.
 *
 * `SchemaObject` lives in `@nestjs/swagger/dist/interfaces/...`, which the
 * package's `exports` map does not publish — a deep import type-checks under
 * the old resolver but fails under `nodenext`, which this project uses.
 */
type ApiBodySchemaHost = Extract<ApiBodyOptions, { schema: unknown }>;

/**
 * Documents a request body from the same Zod schema that validates it.
 *
 * `@nestjs/swagger` builds body schemas by reflecting over decorated *classes*.
 * This codebase validates with Zod schemas instead — which are types, not
 * classes — so Swagger sees no body at all and renders "Try it out" with
 * nothing to type into. Hand-writing an `@ApiBody({ schema })` next to each
 * route would fix the UI while creating exactly the drift that using Zod
 * everywhere was meant to avoid: the docs would keep promising a field long
 * after validation stopped accepting it.
 *
 * Converting instead means one definition stays authoritative.
 */
export function ApiZodBody(
  schema: ZodSchema,
  options: { description?: string; example?: unknown } = {},
): MethodDecorator {
  const jsonSchema = zodToJsonSchema(schema, {
    // OpenAPI 3 dialect, and inlined: Swagger UI cannot follow $refs that point
    // at a definitions block this decorator never contributes to the document.
    target: 'openApi3',
    $refStrategy: 'none',
  }) as ApiBodySchemaHost['schema'];

  return ApiBody({
    schema: jsonSchema,
    ...(options.description ? { description: options.description } : {}),
    ...(options.example !== undefined ? { examples: { default: { value: options.example } } } : {}),
  });
}
