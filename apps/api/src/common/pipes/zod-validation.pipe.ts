/**
 * Validates a request body or query against a zod schema from @repo/types.
 *
 * This is what keeps CLAUDE.md section 5's "one schema, one source of truth"
 * honest: the API validates with exactly the schema the web apps import for
 * their forms, so a contract change breaks the build rather than production.
 *
 *   @Post()
 *   create(@Body(new ZodValidationPipe(createRoleRequestSchema)) body: CreateRoleRequest)
 */

import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ValidationFailedError } from '../errors/domain-error.js';

@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Field-keyed messages, safe to show a user. No stack, no schema dump.
      const issues: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '(root)';
        issues[path] ??= issue.message;
      }
      throw new ValidationFailedError(issues);
    }

    return result.data;
  }
}
