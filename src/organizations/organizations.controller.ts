import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { EnrollmentService } from './enrollment.service';
import { ContributorVerificationService } from './contributor-verification.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { AddAllowlistEntriesDto } from './dto/add-allowlist-entries.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly enrollmentService: EnrollmentService,
    private readonly contributorVerification: ContributorVerificationService,
  ) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a new organization (Admin only)' })
  async create(
    @Body() createOrganizationDto: CreateOrganizationDto,
    @Request() req: RequestWithUser,
  ) {
    return this.organizationsService.create(
      createOrganizationDto,
      req.user.id,
      req.user.roles,
    );
  }

  @Get()
  @Roles(Role.ORGANIZATION_MEMBER)
  @ApiOperation({ summary: 'List accessible organizations' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by organization name, license plan, or manager',
  })
  async findAll(
    @Query('search') search: string | undefined,
    @Request() req: RequestWithUser,
  ) {
    return this.organizationsService.findAll(
      req.user.id,
      req.user.roles,
      search,
    );
  }

  @Get(':id')
  @Roles(Role.ORGANIZATION_MEMBER)
  @ApiOperation({ summary: 'Get organization details' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.organizationsService.findOne(id, req.user.id, req.user.roles);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update an organization (Admin only)' })
  async update(
    @Param('id') id: string,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
    @Request() req: RequestWithUser,
  ) {
    return this.organizationsService.update(
      id,
      updateOrganizationDto,
      req.user.id,
      req.user.roles,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete an organization (Admin only)' })
  async remove(@Param('id') id: string) {
    return this.organizationsService.remove(id);
  }

  // --- Allowlist Endpoints ---

  @Get(':id/allowlist')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'List organization allowlist entries' })
  async getAllowlistEntries(
    @Param('id') id: string,
    @Request() req: RequestWithUser,
  ) {
    return this.enrollmentService.getAllowlistEntries(
      id,
      req.user.id,
      req.user.roles,
    );
  }

  @Post(':id/allowlist')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Add allowlist entries to an organization' })
  async addAllowlistEntries(
    @Param('id') id: string,
    @Body() dto: AddAllowlistEntriesDto,
    @Request() req: RequestWithUser,
  ) {
    return this.enrollmentService.addAllowlistEntries(
      id,
      dto.entries,
      req.user.id,
      req.user.roles,
    );
  }

  @Post(':id/allowlist/csv')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Add allowlist entries from CSV content' })
  async addAllowlistEntriesFromCsv(
    @Param('id') id: string,
    @Body('csv') csv: string,
    @Request() req: RequestWithUser,
  ) {
    return this.enrollmentService.addAllowlistEntriesFromCsv(
      id,
      csv,
      req.user.id,
      req.user.roles,
    );
  }

  @Delete(':id/allowlist/:entryId')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Remove an allowlist entry from an organization' })
  @ApiQuery({
    name: 'revokeMembership',
    required: false,
    description:
      'When true, also revokes the ORGANIZATION_MEMBER role of the user who claimed this entry.',
  })
  async removeAllowlistEntry(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Query('revokeMembership') revokeMembership: string | undefined,
    @Request() req: RequestWithUser,
  ) {
    return this.enrollmentService.removeAllowlistEntry(
      id,
      entryId,
      req.user.id,
      req.user.roles,
      revokeMembership === 'true',
    );
  }

  @Post(':id/allowlist/:entryId/approve')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({
    summary:
      'Approve a pending contributor; retroactively credits their merged PRs',
  })
  async approveAllowlistEntry(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.contributorVerification.approveAndRetroCredit(
      id,
      entryId,
      req.user.id,
      req.user.roles,
    );
  }

  @Post(':id/allowlist/:entryId/reject')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({
    summary: 'Reject a pending contributor; future PRs stay uncredited',
  })
  async rejectAllowlistEntry(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.contributorVerification.rejectContributor(
      id,
      entryId,
      req.user.id,
      req.user.roles,
    );
  }
}
