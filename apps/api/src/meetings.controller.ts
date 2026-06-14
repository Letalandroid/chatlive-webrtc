import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

@Controller()
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get('health')
  health() {
    return { ok: true, service: 'api' };
  }

  @Post('meetings')
  createMeeting() {
    return this.meetings.createMeeting();
  }

  @Post('meetings/:roomId/join')
  joinMeeting(
    @Param('roomId') roomId: string,
    @Body('username') username?: string,
  ) {
    return this.meetings.joinMeeting(roomId, username?.trim() || 'Invitado');
  }
}
