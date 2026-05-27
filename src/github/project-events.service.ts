import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, merge, interval } from 'rxjs';
import { finalize, map } from 'rxjs/operators';

export interface ProjectUpdatePayload {
  projectId: string;
  kind: 'task' | 'pull_request' | 'pr_review' | 'project_metadata' | 'issue';
  at: string;
}

interface ChannelEntry {
  subject: Subject<MessageEvent>;
  subscriberCount: number;
}

/**
 * Per-project SSE fan-out. In-memory, single-instance only.
 *
 * TODO: if this app ever runs more than one backend instance, swap the
 * in-memory Map for a Redis pub/sub bridge so updates fan out across pods.
 */
@Injectable()
export class ProjectEventsService {
  private readonly logger = new Logger(ProjectEventsService.name);
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly HEARTBEAT_MS = 25_000;

  publish(payload: ProjectUpdatePayload): void {
    const channel = this.channels.get(payload.projectId);
    if (!channel) return;
    channel.subject.next({
      type: 'project.updated',
      data: payload,
    } as MessageEvent);
  }

  stream(projectId: string): Observable<MessageEvent> {
    const channel = this.getOrCreateChannel(projectId);
    channel.subscriberCount += 1;

    const heartbeat$ = interval(this.HEARTBEAT_MS).pipe(
      map(
        () =>
          ({
            type: 'heartbeat',
            data: { at: new Date().toISOString() },
          }) as MessageEvent,
      ),
    );

    return merge(channel.subject.asObservable(), heartbeat$).pipe(
      finalize(() => {
        channel.subscriberCount -= 1;
        if (channel.subscriberCount <= 0) {
          channel.subject.complete();
          this.channels.delete(projectId);
        }
      }),
    );
  }

  @OnEvent('project.updated')
  onProjectUpdated(payload: ProjectUpdatePayload) {
    this.publish(payload);
  }

  private getOrCreateChannel(projectId: string): ChannelEntry {
    let channel = this.channels.get(projectId);
    if (!channel) {
      channel = { subject: new Subject<MessageEvent>(), subscriberCount: 0 };
      this.channels.set(projectId, channel);
    }
    return channel;
  }
}
