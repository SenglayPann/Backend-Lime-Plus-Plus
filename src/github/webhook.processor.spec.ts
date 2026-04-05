import { Test, TestingModule } from '@nestjs/testing';
import { WebhookProcessor } from './webhook.processor';
import { WebhooksService } from './webhooks.service';

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let webhooksService: WebhooksService;

  const mockWebhooksService = {
    routeEvent: jest.fn(),
    markProcessed: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookProcessor,
        { provide: WebhooksService, useValue: mockWebhooksService },
      ],
    }).compile();

    processor = module.get<WebhookProcessor>(WebhookProcessor);
    webhooksService = module.get<WebhooksService>(WebhooksService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should route event and mark as processed', async () => {
    const job = {
      data: {
        event: 'pull_request',
        deliveryId: 'del-123',
        payload: { action: 'opened' },
      },
    } as any;

    await processor.process(job);

    expect(mockWebhooksService.routeEvent).toHaveBeenCalledWith({
      event: 'pull_request',
      deliveryId: 'del-123',
      payload: { action: 'opened' },
    });
    expect(mockWebhooksService.markProcessed).toHaveBeenCalledWith('del-123');
  });

  it('should throw on routing failure (triggers BullMQ retry)', async () => {
    const job = {
      data: {
        event: 'pull_request',
        deliveryId: 'del-456',
        payload: { action: 'opened' },
      },
    } as any;

    mockWebhooksService.routeEvent.mockRejectedValue(new Error('DB error'));

    await expect(processor.process(job)).rejects.toThrow('DB error');
    expect(mockWebhooksService.markProcessed).not.toHaveBeenCalled();
  });
});
