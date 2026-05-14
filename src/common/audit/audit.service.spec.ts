import { AuditService } from './audit.service';
import { safeUserSelect } from '../serialization/safe-user-select';

describe('AuditService', () => {
  const prisma = {
    auditLog: {
      findMany: jest.fn(),
    },
  };

  const projectAccessService = {
    assertCanManageProject: jest.fn(),
  };

  let service: AuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuditService(prisma as any, projectAccessService as any);
  });

  it('allows admins to list audit logs without project filter', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'audit-1' }]);

    const result = await service.findAll('admin', ['ADMIN']);

    expect(result).toEqual([{ id: 'audit-1' }]);
    expect(projectAccessService.assertCanManageProject).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        projectId: undefined,
        actorId: undefined,
        action: undefined,
      },
      include: {
        actor: { select: safeUserSelect },
        project: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns no global audit logs for non-admin managers', async () => {
    const result = await service.findAll('manager', ['PROJECT_MANAGER']);

    expect(result).toEqual([]);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('allows managers to list audit logs for managed projects', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'audit-1' }]);

    await service.findAll(
      'manager',
      ['PROJECT_MANAGER'],
      'project-1',
      'actor-1',
      'ROLE_CHANGE',
    );

    expect(projectAccessService.assertCanManageProject).toHaveBeenCalledWith(
      'manager',
      ['PROJECT_MANAGER'],
      'project-1',
    );
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        actorId: 'actor-1',
        action: 'ROLE_CHANGE',
      },
      include: {
        actor: { select: safeUserSelect },
        project: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  });
});
