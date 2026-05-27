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
});
