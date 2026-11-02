import { Body, Controller, Get, Headers, HttpCode, Post, RawBodyRequest, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PaymentsResponse, PaymentsService } from './payments.service';

type PaymentBody = Record<string, any> | null;

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('budpay-webhook')
  @HttpCode(200)
  async budpayWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-budpay-signature') signature: string | undefined,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.budpayWebhook(signature, request.rawBody));
  }

  @Post('list-budpay-banks')
  @HttpCode(200)
  async listBudpayBanks(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.listBudpayBanks(authorization));
  }

  @Get('list-budpay-banks')
  async listBudpayBanksGet(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.listBudpayBanks(authorization));
  }

  @Post('resolve-driver-bank-account')
  @HttpCode(200)
  async resolveDriverBankAccount(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PaymentBody,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.resolveDriverBankAccount(authorization, body));
  }

  @Post('create-driver-virtual-account')
  @HttpCode(200)
  async createDriverVirtualAccount(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.createVirtualAccount(authorization, 'driver'));
  }

  @Post('create-virtual-account')
  @HttpCode(200)
  async createVirtualAccount(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.createVirtualAccount(authorization, 'rider'));
  }

  @Post('create-driver-payout')
  @HttpCode(200)
  async createDriverPayout(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PaymentBody,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.createDriverPayout(authorization, body));
  }

  @Post('save-driver-payout-account')
  @HttpCode(200)
  async saveDriverPayoutAccount(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PaymentBody,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.saveDriverPayoutAccount(authorization, body));
  }

  @Post('set-driver-transfer-pin')
  @HttpCode(200)
  async setDriverTransferPin(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PaymentBody,
    @Res() response: Response,
  ) {
    return this.send(response, await this.payments.setDriverTransferPin(authorization, body));
  }

  private send(response: Response, result: PaymentsResponse) {
    return response.status(result.status).json(result.body);
  }
}
