import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  Observable,
  Subject,
  merge,
  interval,
  from,
  NEVER,
  EMPTY,
} from 'rxjs';
import {
  catchError,
  filter,
  finalize,
  map,
  switchMap,
  take,
  takeUntil,
} from 'rxjs/operators';

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
export interface StreamOptions {
  /**
   * Optional periodic access check. The service calls this every
   * recheckIntervalMs and terminates the stream as soon as it resolves
   * `false` (or rejects). Used to close SSE connections when an actor
   * loses access to the project while connected — without this, a
   * removed user keeps receiving project.updated events until their JWT
   * expires.
   */
  recheck?: () => Promise<boolean>;
  /** Default 30s — bounded info-disclosure window after role revocation. */
  recheckIntervalMs?: number;
}

@Injectable()
export class ProjectEventsService {
  private readonly logger = new Logger(ProjectEventsService.name);
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly HEARTBEAT_MS = 25_000;
  private readonly RECHECK_MS = 30_000;

  publish(payload: ProjectUpdatePayload): void {
    const channel = this.channels.get(payload.projectId);
    if (!channel) return;
    channel.subject.next({
      type: 'project.updated',
      data: payload,
    } as MessageEvent);
  }

  stream(
    projectId: string,
    options: StreamOptions = {},
  ): Observable<MessageEvent> {
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

    // Periodic access re-check. When the check returns false (or throws),
    // emit one value into `revoked$` which then trips takeUntil to close
    // the stream. EventSource on the client will see connection close and
    // attempt to reconnect — the reconnect will then fail at the controller
    // guard with 403/404 and the badge flips to "Reconnecting".
    const revoked$ = options.recheck
      ? interval(options.recheckIntervalMs ?? this.RECHECK_MS).pipe(
          switchMap(() =>
            from(
              options
                .recheck!()
                .catch(() => false),
            ),
          ),
          filter((ok) => !ok),
          take(1),
          map(() => {
            this.logger.log(
              `SSE stream for project ${projectId} closing: access revoked`,
            );
          }),
          catchError(() => EMPTY),
        )
      : NEVER;

    return merge(channel.subject.asObservable(), heartbeat$).pipe(
      takeUntil(revoked$),
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
