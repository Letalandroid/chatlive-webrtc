import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface MeetingSession {
  roomId: string;
  username: string;
  sfuUrl: string;
  createdAt: string;
}

@Injectable()
export class MeetingsService {
  private readonly meetings = new Map<string, { createdAt: string }>();

  createMeeting() {
    const roomId = randomUUID().slice(0, 8);
    const meeting = { createdAt: new Date().toISOString() };
    this.meetings.set(roomId, meeting);

    return {
      roomId,
      url: `/r/${roomId}`,
      ...meeting,
    };
  }

  joinMeeting(roomId: string, username: string): MeetingSession {
    if (!this.meetings.has(roomId)) {
      this.meetings.set(roomId, { createdAt: new Date().toISOString() });
    }

    return {
      roomId,
      username,
      sfuUrl: process.env.SFU_PUBLIC_URL ?? 'http://localhost:4000',
      createdAt: this.meetings.get(roomId)!.createdAt,
    };
  }
}
