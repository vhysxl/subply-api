import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';

interface MidtransRequest {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
}

@Injectable()
export class MidtransMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const body = req.body as MidtransRequest;
    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
    }: MidtransRequest = body;
    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    //logic server key midtrans
    const signatureString = `${order_id}${status_code}${gross_amount}${serverKey}`;
    const calculatedSignature = createHash('sha512')
      .update(signatureString)
      .digest('hex');

    // Verify signature
    if (calculatedSignature !== signature_key) {
      throw new UnauthorizedException('Invalid signature');
    }

    next();
  }
}
