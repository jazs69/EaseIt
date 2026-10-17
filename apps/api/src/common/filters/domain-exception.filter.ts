/**
 * The single place HTTP error responses are built (CLAUDE.md section 5).
 * Controllers never construct an error body.
 */

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ErrorCode, type ApiError } from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { DomainError } from '../errors/domain-error.js';

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    default:
      return status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? ErrorCode.INTERNAL_ERROR
        : ErrorCode.VALIDATION_FAILED;
  }
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const { status, body } = this.describe(exception, request.id);

    // Logged once, here, at the boundary that handles the error rather than at
    // every level it passed through. Server faults carry the stack; client
    // faults do not, or a scanner fills the logs with noise.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.code} [${request.id}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${status} ${body.code} [${request.id}]`,
      );
    }

    // A 429 that does not say when to retry forces the client to guess, and
    // the guess is always "immediately". The number already exists in the
    // error's details, so publish it where an HTTP client will look for it.
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const retryAfter = body.details?.['retryAfterSeconds'];
      if (typeof retryAfter === 'number') {
        void reply.header('retry-after', String(Math.ceil(retryAfter)));
      }
    }

    void reply.status(status).send(body);
  }

  private describe(exception: unknown, requestId: string): { status: number; body: ApiError } {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined ? { details: exception.details } : {}),
          requestId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const raw =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        body: {
          code: codeForStatus(status),
          message: Array.isArray(raw) ? raw.join('; ') : raw,
          requestId,
        },
      };
    }

    // Anything unrecognised is a bug. Say nothing specific: a Prisma error
    // string or a stack trace in a response body is a security problem.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        requestId,
      },
    };
  }
}
