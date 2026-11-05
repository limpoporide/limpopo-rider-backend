import { Body, Controller, Get, Headers, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TripsService, TripEndpointResponse } from './trips.service';

@Controller()
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Post('create-trip-share-link')
  @HttpCode(200)
  createTripShareLink(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    return this.send(res, this.trips.createTripShareLink(body, authorization));
  }

  @Post('create-agora-call-token')
  @HttpCode(200)
  createAgoraCallToken(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    return this.send(res, this.trips.createAgoraCallToken(body, authorization));
  }

  @Get('trip-share')
  tripShare(
    @Query('token') token: string | undefined,
    @Query('format') format: string | undefined,
    @Headers('accept') accept: string | undefined,
    @Res() res: Response,
  ) {
    return this.send(res, this.trips.tripShare(token, format, accept));
  }

  private async send(res: Response, replyPromise: Promise<TripEndpointResponse>) {
    const reply = await replyPromise;
    res.status(reply.status).set(reply.headers);
    return typeof reply.body === 'string' ? res.send(reply.body) : res.json(reply.body);
  }
}
