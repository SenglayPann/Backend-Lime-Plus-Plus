import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

const HTTP_STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  502: 'BAD_GATEWAY',
  500: 'INTERNAL_ERROR',
};

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let message: string;
    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    } else if (
      exceptionResponse !== null &&
      typeof exceptionResponse === 'object' &&
      'message' in exceptionResponse
    ) {
      const resp = exceptionResponse as Record<string, unknown>;
      const msg = resp.message;
      message = Array.isArray(msg) ? msg.join(', ') : String(msg);
    } else {
      message = 'An error occurred';
    }

    const errorResponse: ApiErrorResponse = {
      success: false,
      error: {
        code: HTTP_STATUS_TO_CODE[status] || 'INTERNAL_ERROR',
        message,
      },
    };

    response.status(status).json(errorResponse);
  }
}
