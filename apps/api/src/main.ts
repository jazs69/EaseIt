import 'reflect-metadata';
// Must precede every other import: the module graph below reaches
// @repo/database, which builds its Prisma client at module scope and needs
// DATABASE_URL already present. See config/load-env.ts.
import './config/load-env.js';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter.js';
import { RedactingLogger } from './common/logging/redacting-logger.js';
import { ErrorReporter } from './common/observability/error-reporter.service.js';
import { MetricsService } from './common/observability/metrics.service.js';
import { formatTraceparent, traceForRequest } from './common/observability/trace.js';
import { TRACE_KEY, TraceInterceptor } from './common/observability/trace.interceptor.js';
import { UuidParamPipe } from './common/pipes/uuid-param.pipe.js';
import { TenantScopeInterceptor } from './common/tenancy/tenant-scope.interceptor.js';

const API_PREFIX = 'api';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Nest's logger is the one source of application logs; Fastify's own
      // would duplicate every line.
      logger: false,
      trustProxy: true,
      // Every response carries this id, and so does every log line for the
      // request, which is what makes a production error report traceable.
      genReqId: () => crypto.randomUUID(),
      bodyLimit: 2 * 1024 * 1024,
    }),
    // rawBody: the Razorpay webhook's signature is an HMAC of the exact bytes
    // received (FO-15), so they are kept beside the parsed JSON.
    { bufferLogs: true, rawBody: true },
  );
  // Every log line is redacted of personal data and carries the trace id
  // (SE-02, OB-05). Installed before anything logs; buffered boot lines
  // flush through it too.
  app.useLogger(new RedactingLogger());

  const config = app.get(ConfigService);

  const port = config.get<number>('PORT', 4000);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const swaggerEnabled = config.get<boolean>('SWAGGER_ENABLED', nodeEnv !== 'production');
  const origins = config
    .get<string>('API_CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // The three web apps are separate origins (yourdomain.com,
  // pms.yourdomain.com, book.yourdomain.com), so CORS is an allowlist rather
  // than a wildcard — credentials ride on these requests.
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    // Malformed :...Id params answer 404 instead of reaching the uuid cast as a 500.
    new UuidParamPipe(),
    new ValidationPipe({
      // Strip unknown keys and reject requests that send them: a body that
      // tries to set its own `propertyId` must fail loudly, not silently
      // (CLAUDE.md section 3.2).
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  /**
   * Trace context and request metrics (OB-05), as Fastify hooks so they cover
   * every request, including ones a guard refuses and ones no route matches.
   * The trace id continues an incoming W3C `traceparent` or starts a new one;
   * both ids go back in the response. Metrics are labelled by the route
   * TEMPLATE, never the URL.
   */
  const metrics = app.get(MetricsService);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    const trace = traceForRequest(request.headers.traceparent, request.id);
    (request as unknown as Record<string, unknown>)[TRACE_KEY] = trace;
    void reply.header('traceparent', formatTraceparent(trace.traceId, trace.spanId, trace.sampled));
    void reply.header('x-request-id', request.id);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.recordHttp(request.method, route, reply.statusCode, reply.elapsedTime / 1_000);
    done();
  });

  app.useGlobalFilters(new DomainExceptionFilter(app.get(ErrorReporter)));
  // The trace binds first, so the tenant scope (MT-02) and the handler both
  // run inside it.
  app.useGlobalInterceptors(new TraceInterceptor(), new TenantScopeInterceptor());

  // Lets onModuleDestroy run so Prisma closes its pool on SIGTERM.
  app.enableShutdownHooks();

  if (swaggerEnabled) {
    const document = new DocumentBuilder()
      .setTitle('EaseIt API')
      .setDescription(
        'Multi-tenant Hotel PMS, Channel Manager and Direct Booking Engine. ' +
          'Every operational endpoint is scoped to one property; the active ' +
          'property is resolved server-side from the session or the booking ' +
          'engine slug and is never accepted from the request body.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addTag('health', 'Liveness and readiness probes')
      .addTag('auth', 'Sign-in, two-factor verification and sessions')
      .addTag('rbac', 'Role and permission catalog')
      .addTag('properties', 'Property configuration and the portfolio')
      .addTag('reservations', 'Booking lifecycle and room assignment')
      .addTag('rates', 'Rate plans and pricing')
      .addTag('folios', 'Folios, charges, taxes and payments')
      .addTag('housekeeping', 'Room status and tasks')
      .addTag('night-audit', 'Audit runs and the business date')
      .addTag('channels', 'OTA mappings and ARI distribution')
      .build();

    SwaggerModule.setup(`${API_PREFIX}/docs`, app, SwaggerModule.createDocument(app, document), {
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
      customSiteTitle: 'EaseIt API reference',
    });
  }

  await app.listen(port, '0.0.0.0');

  logger.log(`EaseIt API listening on http://localhost:${port}/${API_PREFIX}`);
  if (swaggerEnabled) {
    logger.log(`API reference at http://localhost:${port}/${API_PREFIX}/docs`);
  }
}

void bootstrap().catch((error: unknown) => {
  // Nothing is initialised yet, so there is no filter or logger context to
  // fall back on — fail loudly and exit non-zero so the supervisor restarts.
  console.error('Failed to start the EaseIt API:', error);
  process.exit(1);
});
