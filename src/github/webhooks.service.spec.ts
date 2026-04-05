jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { createHmac } from 'crypto';
import {
  PrLifecycleHandler,
  PrReviewHandler,
  TaskSyncHandler,
  ProjectMetadataHandler,
  PushHandler,
} from './handlers';

describe('WebhooksService', () => {
  let service: WebhooksService;

  const webhookSecret = 'test-webhook-secret';

  const mockPrismaService = {
    webhookDelivery: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockPrLifecycleHandler = { handle: jest.fn() };
  const mockPrReviewHandler = { handle: jest.fn() };
  const mockTaskSyncHandler = { handle: jest.fn() };
  const mockProjectMetadataHandler = { handle: jest.fn() };
  const mockPushHandler = { handle: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PrLifecycleHandler, useValue: mockPrLifecycleHandler },
        { provide: PrReviewHandler, useValue: mockPrReviewHandler },
        { provide: TaskSyncHandler, useValue: mockTaskSyncHandler },
        { provide: ProjectMetadataHandler, useValue: mockProjectMetadataHandler },
        { provide: PushHandler, useValue: mockPushHandler },
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
        'sha256=' + createHmac('sha256', webhookSecret).update(payload).digest('hex');
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
        'sha256=' + createHmac('sha256', webhookSecret).update(original).digest('hex');
      expect(service.verifySignature(tampered, sig)).toBe(false);
    });
  });

  // === §3.2 Idempotency ===

  describe('isDuplicate', () => {
    it('should return true if delivery exists', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue({
        id: '1',
        deliveryId: 'abc-123',
      });
      expect(await service.isDuplicate('abc-123')).toBe(true);
      expect(mockPrismaService.webhookDelivery.findUnique).toHaveBeenCalledWith({
        where: { deliveryId: 'abc-123' },
      });
    });

    it('should return false if delivery does not exist', async () => {
      mockPrismaService.webhookDelivery.findUnique.mockResolvedValue(null);
      expect(await service.isDuplicate('new-delivery')).toBe(false);
    });
  });

  describe('storeDelivery', () => {
    it('should store a webhook delivery with correct platform', async () => {
      const event = {
        event: 'pull_request',
        deliveryId: 'del-456',
        payload: { action: 'opened' },
      };
      await service.storeDelivery(event);
      expect(mockPrismaService.webhookDelivery.create).toHaveBeenCalledWith({
        data: {
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
        data: { processedAt: expect.any(Date) },
      });
    });
  });

  // === §4 Event Routing Matrix ===

  describe('routeEvent', () => {
    it('should handle pull_request events (spec §5)', async () => {
      const event = {
        event: 'pull_request',
        deliveryId: 'del-1',
        payload: {
          action: 'opened',
          pull_request: { number: 1, title: 'Test PR' },
          repository: { full_name: 'owner/repo' },
        },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle pull_request_review events (spec §7)', async () => {
      const event = {
        event: 'pull_request_review',
        deliveryId: 'del-2',
        payload: {
          action: 'submitted',
          review: { state: 'approved' },
          pull_request: { number: 1 },
          repository: { full_name: 'owner/repo' },
        },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle projects_v2_item events (spec §8)', async () => {
      const event = {
        event: 'projects_v2_item',
        deliveryId: 'del-3',
        payload: { action: 'edited' },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle projects_v2 events (spec §9)', async () => {
      const event = {
        event: 'projects_v2',
        deliveryId: 'del-4',
        payload: { action: 'edited' },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle push events (spec §10)', async () => {
      const event = {
        event: 'push',
        deliveryId: 'del-5',
        payload: {
          ref: 'refs/heads/main',
          repository: { full_name: 'owner/repo' },
          commits: [{ id: 'abc123', message: 'fix: something' }],
        },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle ping events', async () => {
      const event = {
        event: 'ping',
        deliveryId: 'del-6',
        payload: { zen: 'Design for failure.' },
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });

    it('should handle unknown events without throwing', async () => {
      const event = {
        event: 'unknown_event',
        deliveryId: 'del-7',
        payload: {},
      };
      await expect(service.routeEvent(event)).resolves.not.toThrow();
    });
  });
});
