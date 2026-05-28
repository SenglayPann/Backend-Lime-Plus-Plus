import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, take, toArray } from 'rxjs';
import {
  ProjectEventsService,
  ProjectUpdatePayload,
} from './project-events.service';

describe('ProjectEventsService', () => {
  let service: ProjectEventsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectEventsService],
    }).compile();
    service = module.get(ProjectEventsService);
  });

  function makePayload(
    projectId: string,
    kind: ProjectUpdatePayload['kind'] = 'task',
  ): ProjectUpdatePayload {
    return { projectId, kind, at: new Date().toISOString() };
  }

  it('delivers a published payload to a subscriber on the same project', async () => {
    const stream = service.stream('proj-1');
    const first = firstValueFrom(stream);

    service.publish(makePayload('proj-1'));

    const event = await first;
    expect(event.type).toBe('project.updated');
    expect((event.data as ProjectUpdatePayload).projectId).toBe('proj-1');
  });

  it('does not deliver a payload to subscribers of a different project', async () => {
    const events: any[] = [];
    const sub = service.stream('proj-A').subscribe((e) => events.push(e));

    service.publish(makePayload('proj-B'));

    // Give RxJS one microtask to deliver if it would
    await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.type === 'project.updated')).toHaveLength(0);
    sub.unsubscribe();
  });

  it('fan-outs to multiple subscribers of the same project', async () => {
    const a = firstValueFrom(service.stream('proj-1').pipe(take(1)));
    const b = firstValueFrom(service.stream('proj-1').pipe(take(1)));

    // Give RxJS a tick to attach both subscriptions before publishing
    await new Promise((r) => setImmediate(r));
    service.publish(makePayload('proj-1'));

    const [evA, evB] = await Promise.all([a, b]);
    expect((evA.data as ProjectUpdatePayload).projectId).toBe('proj-1');
    expect((evB.data as ProjectUpdatePayload).projectId).toBe('proj-1');
  });

  it('cleans up the channel after the last subscriber unsubscribes', async () => {
    const sub = service.stream('proj-temp').subscribe();
    expect(service['channels'].has('proj-temp')).toBe(true);
    sub.unsubscribe();
    expect(service['channels'].has('proj-temp')).toBe(false);
  });

  it('OnEvent listener forwards project.updated to publish', async () => {
    const stream = service.stream('proj-bridge');
    const first = firstValueFrom(stream);

    service.onProjectUpdated(makePayload('proj-bridge', 'pull_request'));

    const event = await first;
    expect((event.data as ProjectUpdatePayload).kind).toBe('pull_request');
  });

  it('emits multiple updates in order', async () => {
    const collected = firstValueFrom(
      service.stream('proj-2').pipe(take(3), toArray()),
    );

    service.publish(makePayload('proj-2', 'task'));
    service.publish(makePayload('proj-2', 'pull_request'));
    service.publish(makePayload('proj-2', 'pr_review'));

    const events = await collected;
    expect(events.map((e) => (e.data as ProjectUpdatePayload).kind)).toEqual([
      'task',
      'pull_request',
      'pr_review',
    ]);
  });

  describe('access recheck', () => {
    it('terminates the stream when recheck returns false', async () => {
      // Tight interval so the test finishes quickly.
      const recheck = jest
        .fn<Promise<boolean>, []>()
        .mockResolvedValue(false);
      const collected = firstValueFrom(
        service
          .stream('proj-revoke', {
            recheck,
            recheckIntervalMs: 10,
          })
          .pipe(toArray()),
      );

      // No publish — stream should still close from the recheck signal.
      const events = await collected;
      expect(events.filter((e) => e.type === 'project.updated')).toHaveLength(
        0,
      );
      expect(recheck).toHaveBeenCalled();
    });

    it('keeps the stream open while recheck returns true and closes on revoke', async () => {
      let allow = true;
      const recheck = jest
        .fn<Promise<boolean>, []>()
        .mockImplementation(() => Promise.resolve(allow));

      const collected = firstValueFrom(
        service
          .stream('proj-flip', {
            recheck,
            recheckIntervalMs: 10,
          })
          .pipe(toArray()),
      );

      // Publish one event while access is allowed
      setTimeout(() => service.publish(makePayload('proj-flip', 'task')), 5);
      // Revoke after 30ms
      setTimeout(() => {
        allow = false;
      }, 30);

      const events = await collected;
      const content = events.filter((e) => e.type === 'project.updated');
      expect(content).toHaveLength(1);
      expect((content[0].data as ProjectUpdatePayload).kind).toBe('task');
    });

    it('treats recheck rejection as access revoked', async () => {
      const recheck = jest
        .fn<Promise<boolean>, []>()
        .mockRejectedValue(new Error('db down'));

      const collected = firstValueFrom(
        service
          .stream('proj-throw', {
            recheck,
            recheckIntervalMs: 10,
          })
          .pipe(toArray()),
      );

      const events = await collected;
      expect(events.filter((e) => e.type === 'project.updated')).toHaveLength(
        0,
      );
    });
  });
});
