import { SetMetadata } from '@nestjs/common';

// Role enum values matching Prisma schema
export type Role = 'ORGANIZATION_OWNER' | 'ADMIN' | 'DEPARTMENT_MANAGER' | 'PROJECT_MANAGER' | 'PROJECT_MEMBER';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
