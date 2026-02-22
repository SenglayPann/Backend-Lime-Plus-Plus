import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(userRoles: Role[]): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { roles: userRoles },
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function createMockContextNoUser(): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('when no roles are required', () => {
    it('should allow access when no @Roles() decorator is present', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext(['PROJECT_MEMBER']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when empty roles array is specified', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
      const context = createMockContext(['PROJECT_MEMBER']);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('when roles are required', () => {
    it('should deny access when user has no roles', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN'] as Role[]);
      const context = createMockContextNoUser();
      expect(guard.canActivate(context)).toBe(false);
    });

    it('should allow access when user has the exact required role', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN'] as Role[]);
      const context = createMockContext(['ADMIN']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user lacks the required role', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN'] as Role[]);
      const context = createMockContext(['PROJECT_MEMBER']);
      expect(guard.canActivate(context)).toBe(false);
    });
  });

  describe('role hierarchy', () => {
    it('ORGANIZATION_OWNER should satisfy ADMIN requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN'] as Role[]);
      const context = createMockContext(['ORGANIZATION_OWNER']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('ORGANIZATION_OWNER should satisfy PROJECT_MEMBER requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['PROJECT_MEMBER'] as Role[]);
      const context = createMockContext(['ORGANIZATION_OWNER']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('ADMIN should satisfy DEPARTMENT_MANAGER requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['DEPARTMENT_MANAGER'] as Role[]);
      const context = createMockContext(['ADMIN']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('ADMIN should satisfy PROJECT_MANAGER requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['PROJECT_MANAGER'] as Role[]);
      const context = createMockContext(['ADMIN']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('DEPARTMENT_MANAGER should NOT satisfy ADMIN requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN'] as Role[]);
      const context = createMockContext(['DEPARTMENT_MANAGER']);
      expect(guard.canActivate(context)).toBe(false);
    });

    it('PROJECT_MEMBER should NOT satisfy PROJECT_MANAGER requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['PROJECT_MANAGER'] as Role[]);
      const context = createMockContext(['PROJECT_MEMBER']);
      expect(guard.canActivate(context)).toBe(false);
    });

    it('PROJECT_MANAGER should satisfy PROJECT_MEMBER requirement', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['PROJECT_MEMBER'] as Role[]);
      const context = createMockContext(['PROJECT_MANAGER']);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('multiple roles', () => {
    it('should allow access if user has ANY of the required roles', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(
        ['ADMIN', 'DEPARTMENT_MANAGER'] as Role[],
      );
      const context = createMockContext(['DEPARTMENT_MANAGER']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access if user has a higher role than any required', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(
        ['PROJECT_MANAGER', 'DEPARTMENT_MANAGER'] as Role[],
      );
      const context = createMockContext(['ADMIN']);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access if user has none of the required roles', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(
        ['ADMIN', 'ORGANIZATION_OWNER'] as Role[],
      );
      const context = createMockContext(['PROJECT_MEMBER']);
      expect(guard.canActivate(context)).toBe(false);
    });
  });
});
