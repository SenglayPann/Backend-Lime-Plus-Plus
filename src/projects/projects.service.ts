import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectStatus, AuditAction, Role } from '../generated/prisma/enums';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private githubService: GitHubService,
  ) {}

  async create(dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        name: dto.name,
        departmentId: dto.department_id,
        repository: dto.repository,
        externalProjectId: dto.github_project_id,
        evalStart: dto.evaluation_window?.start ? new Date(dto.evaluation_window.start) : null,
        evalEnd: dto.evaluation_window?.end ? new Date(dto.evaluation_window.end) : null,
      },
    });
  }

  async findAll(departmentId?: string) {
    return this.prisma.project.findMany({
      where: departmentId ? { departmentId } : {},
      include: { department: true },
    });
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        department: true,
        members: { include: { user: true } },
        _count: { select: { tasks: true, pullRequests: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async lockProject(id: string, actorId: string) {
    const project = await this.findOne(id);
    
    if (project.status === ProjectStatus.LOCKED) {
      throw new ConflictException('Project is already locked');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: {
          status: ProjectStatus.LOCKED,
          lockedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          action: AuditAction.PROJECT_LOCK,
          actorId,
          projectId: id,
          metadata: { previousStatus: project.status },
        },
      });

      return updated;
    });
  }

  async syncTasks(id: string, accessToken: string, actorId: string) {
    const project = await this.findOne(id);
    
    if (!project.externalProjectId) {
      throw new ConflictException('Project is not linked to a GitHub Project');
    }

    const items = await this.githubService.getProjectItems(project.externalProjectId, accessToken);
    
    const results = await Promise.all(
      items.map(async (item) => {
        // Skip items without a title (e.g. empty rows)
        if (!item.content?.title) return null;

        // Try to find status from field values
        const statusValue = item.fieldValues.nodes.find(n => n.name === 'Status')?.name;
        
        // Find assignee
        const assigneeLogin = item.content.assignees?.nodes[0]?.login;
        let assigneeId = null;

        if (assigneeLogin) {
          const user = await this.prisma.user.findUnique({
            where: { githubUserId: assigneeLogin }, // Assuming githubUserId is the login
          });
          assigneeId = user?.id;
        }

        // Only upsert if we have an assignee (or handle null assignee according to business rules)
        // For sync, we might just create them even without assignee and let PM assign them later
        
        // Map GitHub status to TaskStatus
        let taskStatus = 'TODO';
        if (statusValue === 'In Progress') taskStatus = 'IN_PROGRESS';
        if (statusValue === 'Done') taskStatus = 'DONE';

        return this.prisma.task.upsert({
          where: {
            projectId_externalTaskId: {
              projectId: id,
              externalTaskId: item.id,
            },
          },
          update: {
            title: item.content.title,
            status: taskStatus as any,
            assigneeId: assigneeId || undefined, // Don't overwrite with null if not found?
          },
          create: {
            projectId: id,
            externalTaskId: item.id,
            title: item.content.title,
            status: taskStatus as any,
            assigneeId: assigneeId || 'unassigned', // We might need a placeholder or allow null
          },
        });
      })
    );

    return {
      syncedCount: results.filter(r => r !== null).length,
    };
  }
}
