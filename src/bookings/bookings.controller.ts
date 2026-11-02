import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BookingsService, EndpointResponse } from './bookings.service';

@Controller()
export class BookingsController {
  constructor(private readonly service: BookingsService) {}

  @Post('notify-new-booking-drivers')
  @HttpCode(200)
  notifyNewBookingDrivers(@Body() body: unknown, @Res() res: Response) {
    return this.send(res, this.service.notifyNewBookingDrivers(body));
  }

  @Post('notify-rider-booking-status')
  @HttpCode(200)
  notifyRiderBookingStatus(@Body() body: unknown, @Res() res: Response) {
    return this.send(res, this.service.notifyRiderBookingStatus(body));
  }

  @Post('notify-rider-scheduled-booking-created')
  @HttpCode(200)
  notifyRiderScheduledBookingCreated(@Body() body: unknown, @Res() res: Response) {
    return this.send(res, this.service.notifyRiderScheduledBookingCreated(body));
  }

  @Post('promote-scheduled-bookings')
  @HttpCode(200)
  promoteScheduledBookings(@Body() body: unknown, @Res() res: Response) {
    return this.send(res, this.service.promoteScheduledBookings(body));
  }

  @Post('expire-stale-rider-bookings')
  @HttpCode(200)
  expireStaleRiderBookings(@Body() body: unknown, @Res() res: Response) {
    return this.send(res, this.service.expireStaleRiderBookings(body));
  }

  @Post('manage-rider-notifications')
  @HttpCode(200)
  manageRiderNotifications(@Body() body: unknown, @Headers('authorization') authorization: string | undefined, @Res() res: Response) {
    return this.send(res, this.service.manageRiderNotifications(body, authorization));
  }

  @Post('manage-driver-notifications')
  @HttpCode(200)
  manageDriverNotifications(@Body() body: unknown, @Headers('authorization') authorization: string | undefined, @Res() res: Response) {
    return this.send(res, this.service.manageDriverNotifications(body, authorization));
  }

  private async send(res: Response, result: Promise<EndpointResponse>) {
    const reply = await result;
    return res.status(reply.status).json(reply.body);
  }
}
