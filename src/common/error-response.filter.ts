import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

// Keeps the `{ error: string }` response shape the mobile clients already expect.
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorResponseFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      const message = Array.isArray(raw) ? (raw[0] ?? exception.message) : (raw ?? exception.message);

      response.status(exception.getStatus()).json({ error: message });
      return;
    }

    this.logger.error(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }
}
