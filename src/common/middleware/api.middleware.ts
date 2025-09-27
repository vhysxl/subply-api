import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class ApiKeyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers['api-key'] || req.headers['x-api-key'];
    const validApiKey = process.env.API_KEY;

    if (!validApiKey) {
      console.warn('Warning: API_KEY not set in env!');
    }

    if (apiKey === validApiKey) {
      return next();
    }

    throw new UnauthorizedException('Invalid or missing API key');
  }
}
