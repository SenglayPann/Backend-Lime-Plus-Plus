import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service';

/**
 * Public verification endpoint for generated PDF reports. Intentionally
 * not protected by JwtAuthGuard so anyone who receives a Lime++ PDF can
 * confirm its authenticity by visiting the URL printed on the document
 * (or scanning its QR code). Returns only metadata that the PDF already
 * exposes — no sensitive project internals.
 */
@ApiTags('Reports')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('reports/verify')
export class ReportVerificationController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':id')
  @ApiOperation({
    summary:
      'Public: verify a Lime++ PDF report by its printed verification ID',
  })
  async verify(@Param('id') id: string) {
    const row = await this.reportsService.findVerification(id);
    if (!row) {
      throw new NotFoundException('No Lime++ report with that ID');
    }

    return {
      id: row.id,
      type: row.type,
      generatedAt: row.generatedAt.toISOString(),
      dataHash: row.dataHash,
      // The signature is left out of the response on purpose — its value
      // adds nothing to a third-party verifier (they can't recompute it
      // without the server secret) and exposing it makes brute-force
      // attempts on the secret marginally easier.
      project: {
        id: row.project.id,
        name: row.project.name,
        repository: row.project.repository,
        organization: row.project.department.organization.name,
        department: row.project.department.name,
      },
      subject: row.subjectUser
        ? {
            name: row.subjectUser.name,
            githubUsername: row.subjectUser.githubUsername,
          }
        : null,
      generatedBy: {
        name: row.generatedBy.name,
        githubUsername: row.generatedBy.githubUsername,
      },
      summary: row.summary,
    };
  }
}
