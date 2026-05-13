import { Injectable } from '@nestjs/common';
import { Prisma, Role as PrismaRole } from '../../generated/prisma';
import type { Role } from '../decorators/roles.decorator';

@Injectable()
export class UserVisibilityService {
  buildVisibleUserWhere(
    actorId: string,
    actorRoles: Role[],
  ): Prisma.UserWhereInput {
    const clauses: Prisma.UserWhereInput[] = [{ id: actorId }];

    if (actorRoles.includes('ADMIN')) {
      return {};
    }

    if (actorRoles.includes('ORGANIZATION_MANAGER')) {
      clauses.push({
        OR: [
          {
            userRoles: {
              some: {
                organization: {
                  userRoles: {
                    some: {
                      userId: actorId,
                      role: PrismaRole.ORGANIZATION_MANAGER,
                    },
                  },
                },
              },
            },
          },
          {
            userRoles: {
              some: {
                department: {
                  organization: {
                    userRoles: {
                      some: {
                        userId: actorId,
                        role: PrismaRole.ORGANIZATION_MANAGER,
                      },
                    },
                  },
                },
              },
            },
          },
          {
            projectMembers: {
              some: {
                project: {
                  department: {
                    organization: {
                      userRoles: {
                        some: {
                          userId: actorId,
                          role: PrismaRole.ORGANIZATION_MANAGER,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });
    }

    if (actorRoles.includes('DEPARTMENT_MANAGER')) {
      clauses.push({
        OR: [
          {
            userRoles: {
              some: {
                department: {
                  userRoles: {
                    some: {
                      userId: actorId,
                      role: PrismaRole.DEPARTMENT_MANAGER,
                    },
                  },
                },
              },
            },
          },
          {
            projectMembers: {
              some: {
                project: {
                  department: {
                    userRoles: {
                      some: {
                        userId: actorId,
                        role: PrismaRole.DEPARTMENT_MANAGER,
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });
    }

    if (actorRoles.includes('PROJECT_MANAGER')) {
      clauses.push({
        projectMembers: {
          some: {
            project: {
              members: {
                some: {
                  userId: actorId,
                  role: PrismaRole.PROJECT_MANAGER,
                },
              },
            },
          },
        },
      });
    }

    if (actorRoles.includes('PROJECT_MEMBER')) {
      clauses.push({
        projectMembers: {
          some: {
            project: {
              members: {
                some: {
                  userId: actorId,
                },
              },
            },
          },
        },
      });
    }

    return { OR: clauses };
  }
}
