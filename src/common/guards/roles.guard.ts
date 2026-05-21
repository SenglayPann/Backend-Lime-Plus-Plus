import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { RequestWithUser } from '../types/request.interface';

/**
 * Role hierarchy for RBAC.
 * Higher roles automatically have permissions of lower roles.
 */
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  ADMIN: [
    'ADMIN',
    'ORGANIZATION_MANAGER',
    'DEPARTMENT_MANAGER',
    'PROJECT_MANAGER',
    'PROJECT_LEAD',
    'PROJECT_MEMBER',
  ],
  ORGANIZATION_MANAGER: [
    'ORGANIZATION_MANAGER',
    'DEPARTMENT_MANAGER',
    'PROJECT_MANAGER',
    'PROJECT_LEAD',
    'PROJECT_MEMBER',
  ],
  DEPARTMENT_MANAGER: [
    'DEPARTMENT_MANAGER',
    'PROJECT_MANAGER',
    'PROJECT_LEAD',
    'PROJECT_MEMBER',
  ],
  PROJECT_MANAGER: ['PROJECT_MANAGER', 'PROJECT_LEAD', 'PROJECT_MEMBER'],
  PROJECT_LEAD: ['PROJECT_LEAD', 'PROJECT_MEMBER'],
  PROJECT_MEMBER: ['PROJECT_MEMBER'],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are required, allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user || !user.roles) {
      return false;
    }

    // Check if user has any of the required roles (considering hierarchy)
    return requiredRoles.some((requiredRole) =>
      this.hasRoleWithHierarchy(user.roles, requiredRole),
    );
  }

  /**
   * Check if user has the required role, considering role hierarchy.
   * For example, ADMIN role satisfies DEPARTMENT_MANAGER requirement.
   */
  private hasRoleWithHierarchy(userRoles: Role[], requiredRole: Role): boolean {
    return userRoles.some((userRole) => {
      const impliedRoles = ROLE_HIERARCHY[userRole] || [];
      return impliedRoles.includes(requiredRole);
    });
  }
}
