jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest
    .fn()
    .mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhooksService, WebhookEvent } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { createHmac } from 'crypto';
import {
  PrLifecycleHandler,
  PrReviewHandler,
  TaskSyncHandler,
  ProjectMetadataHandler,
  PushHandler,
  IssuesHandler,
} from './handlers';

describe('WebhooksService', () => {
  let service: WebhooksService;

  const webhookSecret = 'test-webhook-secret';

  const mockPrismaService = {
    webhookDelivery: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockPrLifecycleHandler = { handle: jest.fn() };
  const mockPrReviewHandler = { handle: jest.fn() };
  const mockTaskSyncHandler = { handle: jest.fn() };
  const mockProjectMetadataHandler = { handle: jest.fn() };
  const mockPushHandler = { handle: jest.fn() };
  const mockIssuesHandler = { handle: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PrLifecycleHandler, useValue: mockPrLifecycleHandler },
        { provide: PrReviewHandler, useValue: mockPrReviewHandler },
        { provide: TaskSyncHandler, useValue: mockTaskSyncHandler },
        {
          provide: ProjectMetadataHandler,
          useValue: mockProjectMetadataHandler,
        },
        { provide: PushHandler, useValue: mockPushHandler },
        { provide: IssuesHandler, useValue: mockIssuesHandler },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'GITHUB_WEBHOOK_SECRET') return webhookSecret;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
    jest.clearAllMocks();
  });

  // === §3.1 HMAC Signature Verification ===

  describe('verifySignature', () => {
    it('should return true for a valid signature', () => {
      const payload = '{"action":"opened"}';
      const sig =
        'sha256=' +
        createHmac('sha256', webhookSecret).update(payload).digest('hex');
      expect(service.verifySignature(payload, sig)).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      expect(service.verifySignature('payload', 'sha256=invalid')).toBe(false);
    });

    it('should return false when no signature is provided', () => {
      expect(service.verifySignature('payload', '')).toBe(false);
    });

    it('should return false for tampered payload', () => {
      const original = '{"action":"opened"}';
      const tampered = '{"action":"closed"}';
      const sig =
        'sha256=' +
        createHmac('sha256', webhookSecret).update(original).digest('hex');
      expect(service.verifySignature(tampered, sig)).toBe(false);
    });

    it('should reject unsigned production webhooks when no secret is configured', () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const serviceWithoutSecret = new WebhooksService(
        mockPrismaService as any,
        {
          get: jest.fn(() => undefined),
        } as any,
        mockPrLifecycleHandler as any,
        mockPrReviewHandler as any,
        mockTaskSyncHandler as any,
        mockProjectMetadataHandler as any,
        mockPushHandler as any,
        mockIssuesHandler as any,
      );

      try {
        expect(serviceWithoutSecret.verifySignature('payload', '')).toBe(false);
      } finally {
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previousNodeEnv;
        }
      }
    });
  });

  // === §3.2 Idempotency ===

  describe('isDuplicate', () => {
    it('should return true if delivery exists', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue({
        id: '1',
        deliveryId: 'abc-123',
        queuedAt: new Date(),
        processedAt: null,
      });
      expect(await service.isDuplicate('abc-123')).toBe(true);
      expect(mockPrismaService.webhookDelivery.findUnique).toHaveBeenCalledWith(
        {
          where: { deliveryId: 'abc-123' },
        },
      );
    });

    it('should return false if delivery does not exist', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue(null);
      expect(await service.isDuplicate('new-delivery')).toBe(false);
    });

    it('should return false if delivery exists but was never queued', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue({
        id: '1',
        deliveryId: 'stalled-delivery',
        queuedAt: null,
        processedAt: null,
      });

      expect(await service.isDuplicate('stalled-delivery')).toBe(false);
    });

    it('should return false for failed unprocessed deliveries so GitHub redelivery can requeue them', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue({
        id: '1',
        deliveryId: 'failed-delivery',
        queuedAt: new Date(),
        processedAt: null,
        failedAt: new Date(),
      });

      expect(await service.isDuplicate('failed-delivery')).toBe(false);
    });
  });

  describe('storeDelivery', () => {
    it('should store a webhook delivery with correct platform', async () => {
      const event: WebhookEvent = {
        event: 'pull_request',
        deliveryId: 'del-456',
        payload: { action: 'opened' } as Record<string, unknown>,
      };
      await service.storeDelivery(event);
      expect(mockPrismaService.webhookDelivery.upsert).toHaveBeenCalledWith({
        where: { deliveryId: 'del-456' },
        update: {
          eventType: 'pull_request',
          payload: { action: 'opened' },
          failedAt: null,
          lastError: null,
        },
        create: {
          deliveryId: 'del-456',
          platform: 'GITHUB',
          eventType: 'pull_request',
          payload: { action: 'opened' },
        },
      });
    });
  });

  describe('markProcessed', () => {
    it('should update processedAt timestamp', async () => {
      await service.markProcessed('del-456');
      expect(mockPrismaService.webhookDelivery.update).toHaveBeenCalledWith({
        where: { deliveryId: 'del-456' },
        data: {
          processedAt: expect.any(Date) as unknown,
          failedAt: null,
          lastError: null,
        },
      });
    });
  });

  // === §4 Event Routing Matrix ===

  describe('routeEvent', () => {
    it('should handle pull_request events (spec §5)', async () => {
      const event: WebhookEvent = {
        event: 'pull_request',
        deliveryId: 'del-1',
        payload: {
          action: 'opened',
          pull_request: { number: 1, title: 'Test PR' },
          repository: { full_name: 'owner/repo' },
        } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle pull_request_review events (spec §7)', async () => {
      const event: WebhookEvent = {
        event: 'pull_request_review',
        deliveryId: 'del-2',
        payload: {
          action: 'submitted',
          review: { state: 'approved' },
          pull_request: { number: 1 },
          repository: { full_name: 'owner/repo' },
        } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle projects_v2_item events (spec §8)', async () => {
      const event: WebhookEvent = {
        event: 'projects_v2_item',
        deliveryId: 'del-3',
        payload: { action: 'edited' } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle projects_v2 events (spec §9)', async () => {
      const event: WebhookEvent = {
        event: 'projects_v2',
        deliveryId: 'del-4',
        payload: { action: 'edited' } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle push events (spec §10)', async () => {
      const event: WebhookEvent = {
        event: 'push',
        deliveryId: 'del-5',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'owner/repo' },
          commits: [{ id: 'abc123', message: 'fix: something' }],
        } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle ping events', async () => {
      const event: WebhookEvent = {
        event: 'ping',
        deliveryId: 'del-6',
        payload: { zen: 'Design for failure.' } as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle unknown events without throwing', async () => {
      const event: WebhookEvent = {
        event: 'unknown_event',
        deliveryId: 'del-7',
        payload: {} as Record<string, unknown>,
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });
  });
});
