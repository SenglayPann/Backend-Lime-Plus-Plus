import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

type PdfDate = Date | string | null | undefined;

export interface IndividualReportData {
  student: {
    name: string;
    githubUsername: string;
    email: string;
    projectRole: string;
  };
  project: {
    name: string;
    organization: string;
    department: string;
    repository: string;
    externalProjectId: string;
    status: string;
    evalStart?: PdfDate;
    evalEnd?: PdfDate;
    lockedAt?: PdfDate;
    generatedAt: PdfDate;
  };
  score: {
    totalScore: number;
    taskCompletionPoints: number;
    reviewPoints: number;
    overrideDelta: number;
    lastUpdated: PdfDate;
  };
  contributionEvidence: Array<{
    taskId: string;
    title: string;
    prNumber: string;
    prTitle: string;
    status: string;
    mergedAt: PdfDate;
    score: number;
    url: string;
  }>;
  reviews: Array<{ prNumber: string; state: string; createdAt: PdfDate }>;
  overrides: Array<{
    delta: number;
    reason: string;
    overriddenBy: string;
    createdAt: PdfDate;
  }>;
  warnings: string[];
}

export interface ProjectReportData {
  project: {
    name: string;
    organization: string;
    department: string;
    repository: string;
    externalProjectId: string;
    status: string;
    evalStart?: PdfDate;
    evalEnd?: PdfDate;
    lockedAt?: PdfDate;
    generatedAt: PdfDate;
  };
  leadership: {
    projectManagers: string[];
  };
  summary: {
    totalMembers: number;
    activeContributors: number;
    totalTasks: number;
    doneTasks: number;
    mergedPrs: number;
    averageDoneTasks: number;
  };
  members: Array<{
    name: string;
    githubUsername: string;
    projectRole: string;
    totalScore: number;
    doneTasks: number;
    mergedPrs: number;
    approvedReviews: number;
    overrideDelta: number;
  }>;
  tasks: Array<{
    taskId: string;
    title: string;
    assignee: string;
    status: string;
    linkedPr: string;
    prStatus: string;
    mergedAt: PdfDate;
    score: number;
  }>;
  overrides: Array<{
    student: string;
    delta: number;
    reason: string;
    overriddenBy: string;
    createdAt: PdfDate;
  }>;
  auditLogs: Array<{
    action: string;
    actor: string;
    createdAt: PdfDate;
    metadata: string;
  }>;
}

@Injectable()
export class PdfService {
  async generateIndividualReport(data: IndividualReportData): Promise<Buffer> {
    return this.createDocument((doc) => {
      this.generateHeader(doc, 'Individual Contribution Report');

      this.section(doc, 'Student');
      this.keyValues(doc, [
        ['Name', data.student.name],
        ['GitHub', data.student.githubUsername],
        ['Email', data.student.email],
        ['Project role', data.student.projectRole],
        ['Organization', data.project.organization],
        ['Department', data.project.department],
        ['Project', data.project.name],
        ['Repository', data.project.repository],
      ]);

      this.section(doc, 'Score Summary');
      this.keyValues(doc, [
        ['Final score', String(data.score.totalScore)],
        ['Task completion points', String(data.score.taskCompletionPoints)],
        ['Review points', String(data.score.reviewPoints)],
        ['Override delta', String(data.score.overrideDelta)],
        ['Last score update', this.formatDate(data.score.lastUpdated)],
        ['Generated at', this.formatDateTime(data.project.generatedAt)],
      ]);

      this.section(doc, 'Contribution Evidence');
      this.table(
        doc,
        ['Task', 'PR', 'Status', 'Merged', 'Score'],
        data.contributionEvidence.map((item) => [
          `${item.taskId} ${item.title}`,
          `#${item.prNumber} ${item.prTitle}`,
          item.status,
          this.formatDate(item.mergedAt),
          String(item.score),
        ]),
      );

      this.section(doc, 'Reviews');
      this.table(
        doc,
        ['PR', 'State', 'Date'],
        data.reviews.map((review) => [
          `#${review.prNumber}`,
          review.state,
          this.formatDate(review.createdAt),
        ]),
      );

      this.section(doc, 'Score Overrides');
      this.table(
        doc,
        ['Delta', 'Reason', 'By', 'Date'],
        data.overrides.map((override) => [
          String(override.delta),
          override.reason,
          override.overriddenBy,
          this.formatDate(override.createdAt),
        ]),
      );

      this.section(doc, 'Warnings / Non-scoring Activity');
      data.warnings.forEach((warning) => this.bullet(doc, warning));

      this.section(doc, 'Scoring Notes');
      [
        'Only merged pull request evidence contributes to task completion score.',
        'Moving a Kanban card to Done changes task status only; it does not create score by itself.',
        'Completed task timestamps come from pull request merge time.',
      ].forEach((note) => this.bullet(doc, note));
    });
  }

  async generateProjectReport(data: ProjectReportData): Promise<Buffer> {
    return this.createDocument((doc) => {
      this.generateHeader(doc, 'Project Evaluation Report');

      this.section(doc, 'Project');
      this.keyValues(doc, [
        ['Project name', data.project.name],
        ['Organization', data.project.organization],
        ['Department', data.project.department],
        ['Repository', data.project.repository],
        ['GitHub Project V2 ID', data.project.externalProjectId],
        ['Status', data.project.status],
        [
          'Evaluation window',
          `${this.formatDate(data.project.evalStart)} to ${this.formatDate(
            data.project.evalEnd,
          )}`,
        ],
        ['Locked at', this.formatDateTime(data.project.lockedAt)],
        ['Generated at', this.formatDateTime(data.project.generatedAt)],
      ]);

      this.section(doc, 'Project Leadership');
      this.keyValues(doc, [
        ['Project manager(s)', data.leadership.projectManagers.join(', ')],
      ]);

      this.section(doc, 'Scoring Rules Summary');
      [
        'Scoring source: merged pull requests linked to tasks.',
        'Kanban Done movement is status only and does not create score by itself.',
        'Completed task timestamp source: pull request merge timestamp.',
        'Retroactive linking after project lock is blocked.',
      ].forEach((note) => this.bullet(doc, note));

      this.section(doc, 'Team Summary');
      this.keyValues(doc, [
        ['Total members', String(data.summary.totalMembers)],
        ['Active contributors', String(data.summary.activeContributors)],
        ['Total tasks', String(data.summary.totalTasks)],
        ['Done tasks', String(data.summary.doneTasks)],
        ['Merged PRs', String(data.summary.mergedPrs)],
        ['Average done tasks', String(data.summary.averageDoneTasks)],
      ]);

      this.section(doc, 'Leaderboard');
      this.table(
        doc,
        ['#', 'Student', 'GitHub', 'Done', 'Merged PRs', 'Reviews', 'Score'],
        data.members.map((member, index) => [
          String(index + 1),
          member.name,
          member.githubUsername,
          String(member.doneTasks),
          String(member.mergedPrs),
          String(member.approvedReviews),
          String(member.totalScore),
        ]),
      );

      this.section(doc, 'Task Evidence');
      this.table(
        doc,
        ['Task', 'Assignee', 'Status', 'PR', 'Merged', 'Score'],
        data.tasks.map((task) => [
          `${task.taskId} ${task.title}`,
          task.assignee,
          task.status,
          task.linkedPr,
          this.formatDate(task.mergedAt),
          String(task.score),
        ]),
      );

      this.section(doc, 'Score Overrides');
      this.table(
        doc,
        ['Student', 'Delta', 'Reason', 'By', 'Date'],
        data.overrides.map((override) => [
          override.student,
          String(override.delta),
          override.reason,
          override.overriddenBy,
          this.formatDate(override.createdAt),
        ]),
      );

      this.section(doc, 'Audit Trail');
      this.table(
        doc,
        ['Action', 'Actor', 'Date', 'Metadata'],
        data.auditLogs.map((entry) => [
          entry.action,
          entry.actor,
          this.formatDate(entry.createdAt),
          entry.metadata,
        ]),
      );
    });
  }

  private createDocument(draw: (doc: PDFKit.PDFDocument) => void) {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        margin: 48,
        size: 'A4',
        info: {
          Title: 'Lime++ Evaluation Report',
          Author: 'Lime++',
          Subject: 'Objective technical evaluation evidence',
        },
      });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      draw(doc);
      doc.end();
    });
  }

  private generateHeader(doc: PDFKit.PDFDocument, title: string) {
    doc
      .fillColor('#4d7c0f')
      .fontSize(20)
      .text('Lime++', { align: 'right' })
      .fillColor('#334155')
      .fontSize(9)
      .text('Objective Technical Evaluation System', { align: 'right' })
      .moveDown(1.5);

    doc.fillColor('#111827').fontSize(22).text(title).moveDown(0.5);
    doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#cbd5e1').stroke();
    doc.moveDown();
  }

  private section(doc: PDFKit.PDFDocument, title: string) {
    this.ensureSpace(doc, 80);
    doc
      .moveDown(0.6)
      .fillColor('#111827')
      .fontSize(14)
      .text(title)
      .moveDown(0.3);
  }

  private keyValues(doc: PDFKit.PDFDocument, rows: Array<[string, string]>) {
    rows.forEach(([key, value]) => {
      this.ensureSpace(doc, 24);
      doc
        .fontSize(9)
        .fillColor('#475569')
        .text(`${key}: `, { continued: true })
        .fillColor('#111827')
        .text(value || 'N/A');
    });
    doc.moveDown(0.4);
  }

  private table(doc: PDFKit.PDFDocument, headers: string[], rows: string[][]) {
    const normalizedRows = rows.length ? rows : [['No records']];
    this.ensureSpace(doc, 42);
    doc.fontSize(8).fillColor('#111827').text(headers.join(' | '));
    doc
      .moveTo(48, doc.y + 2)
      .lineTo(547, doc.y + 2)
      .strokeColor('#e2e8f0')
      .stroke();
    doc.moveDown(0.4);

    normalizedRows.forEach((row) => {
      this.ensureSpace(doc, 32);
      doc
        .fontSize(8)
        .fillColor('#334155')
        .text(row.map((cell) => this.truncate(cell, 42)).join(' | '), {
          lineGap: 2,
        });
    });
    doc.moveDown(0.4);
  }

  private bullet(doc: PDFKit.PDFDocument, text: string) {
    this.ensureSpace(doc, 24);
    doc.fontSize(9).fillColor('#334155').text(`- ${text}`);
  }

  private ensureSpace(doc: PDFKit.PDFDocument, height: number) {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
  }

  private truncate(value: string, maxLength: number) {
    if (!value) return 'N/A';
    return value.length > maxLength
      ? `${value.slice(0, maxLength - 3)}...`
      : value;
  }

  private formatDate(value: PdfDate) {
    if (!value) return 'N/A';
    return new Date(value).toISOString().slice(0, 10);
  }

  private formatDateTime(value: PdfDate) {
    if (!value) return 'N/A';
    return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
  }
}
