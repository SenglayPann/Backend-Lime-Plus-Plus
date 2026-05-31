import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

type PdfDate = Date | string | null | undefined;

export interface ReportVerification {
  id: string;
  hash: string;
  verifyUrl: string;
  generatedAt: Date;
}

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
    repository?: string | null;
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
  verification?: ReportVerification;
}

export interface ProjectReportData {
  project: {
    name: string;
    organization: string;
    department: string;
    repository?: string | null;
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
    difficulty: string;
    dueDate: PdfDate;
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
  verification?: ReportVerification;
}

// Design tokens — keep them in one place so the look stays consistent.
const COLOR = {
  brand: '#4d7c0f', // lime-700
  brandSoft: '#f7fee7', // lime-50
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  divider: '#e2e8f0',
  rowAlt: '#f8fafc',
  card: '#f1f5f9',
  // Status pill palette: (text, bg)
  green: { fg: '#166534', bg: '#dcfce7' },
  blue: { fg: '#1d4ed8', bg: '#dbeafe' },
  gray: { fg: '#475569', bg: '#e2e8f0' },
  red: { fg: '#b91c1c', bg: '#fee2e2' },
  amber: { fg: '#a16207', bg: '#fef3c7' },
};

interface Column {
  header: string;
  /** Fraction of total table width (0–1). Should sum to 1 across all columns. */
  width: number;
  /** "left" (default) | "right" | "center" */
  align?: 'left' | 'right' | 'center';
  /** Pass "pill" to render the cell value as a status badge. */
  render?: 'pill';
}

@Injectable()
export class PdfService {
  async generateIndividualReport(data: IndividualReportData): Promise<Buffer> {
    const qrPng = data.verification
      ? await this.renderQr(data.verification.verifyUrl)
      : null;

    return this.createDocument(data.verification, qrPng, (doc) => {
      this.drawHeader(doc, 'Individual Contribution Report');

      // Hero score card up top — what reviewers look at first.
      this.drawHeroScoreCard(doc, {
        name: data.student.name,
        subtitle: `${data.student.projectRole.replace(/_/g, ' ')} · ${data.project.name}`,
        totalScore: data.score.totalScore,
        breakdown: [
          { label: 'Task completion', value: data.score.taskCompletionPoints },
          { label: 'Reviews', value: data.score.reviewPoints },
          { label: 'Overrides', value: data.score.overrideDelta },
        ],
      });

      this.drawSection(doc, 'Student & Project');
      this.drawKeyValueGrid(doc, [
        ['Name', data.student.name],
        ['GitHub', data.student.githubUsername],
        ['Email', data.student.email],
        ['Project role', data.student.projectRole.replace(/_/g, ' ')],
        ['Organization', data.project.organization],
        ['Department', data.project.department],
        ['Project', data.project.name],
        ['Repository', data.project.repository || 'N/A'],
        ['Last score update', this.formatDate(data.score.lastUpdated)],
        ['Generated at', this.formatDateTime(data.project.generatedAt)],
      ]);

      this.drawSection(doc, 'Contribution Evidence');
      this.drawTable(
        doc,
        [
          { header: 'Task', width: 0.18 },
          { header: 'Title', width: 0.3 },
          { header: 'PR', width: 0.1 },
          { header: 'Status', width: 0.12, render: 'pill' },
          { header: 'Merged', width: 0.16 },
          { header: 'Score', width: 0.14, align: 'right' },
        ],
        data.contributionEvidence.map((item) => [
          item.taskId,
          item.title,
          `#${item.prNumber}`,
          item.status,
          this.formatDate(item.mergedAt),
          String(item.score),
        ]),
      );

      this.drawSection(doc, 'Reviews');
      this.drawTable(
        doc,
        [
          { header: 'PR', width: 0.2 },
          { header: 'State', width: 0.3, render: 'pill' },
          { header: 'Date', width: 0.5 },
        ],
        data.reviews.map((review) => [
          `#${review.prNumber}`,
          review.state,
          this.formatDate(review.createdAt),
        ]),
      );

      this.drawSection(doc, 'Score Overrides');
      this.drawTable(
        doc,
        [
          { header: 'Delta', width: 0.12, align: 'right' },
          { header: 'Reason', width: 0.48 },
          { header: 'By', width: 0.2 },
          { header: 'Date', width: 0.2 },
        ],
        data.overrides.map((override) => [
          this.formatDelta(override.delta),
          override.reason,
          override.overriddenBy,
          this.formatDate(override.createdAt),
        ]),
      );

      this.drawSection(doc, 'Warnings & Non-scoring Activity');
      data.warnings.forEach((warning) => this.drawBullet(doc, warning));

      this.drawSection(doc, 'Scoring Notes');
      [
        'Only merged pull request evidence contributes to task completion score.',
        'Moving a Kanban card to Done changes task status only; it does not create score.',
        'Completed task timestamps come from pull request merge time.',
      ].forEach((note) => this.drawBullet(doc, note));
    });
  }

  async generateProjectReport(data: ProjectReportData): Promise<Buffer> {
    const qrPng = data.verification
      ? await this.renderQr(data.verification.verifyUrl)
      : null;

    return this.createDocument(data.verification, qrPng, (doc) => {
      this.drawHeader(doc, 'Project Evaluation Report');

      this.drawProjectCover(doc, data);

      this.drawSection(doc, 'Project Details');
      this.drawKeyValueGrid(doc, [
        ['Project', data.project.name],
        ['Organization', data.project.organization],
        ['Department', data.project.department],
        ['Repository', data.project.repository || 'N/A'],
        ['GitHub Project V2 ID', data.project.externalProjectId],
        ['Status', data.project.status],
        ['Project manager(s)', data.leadership.projectManagers.join(', ')],
        [
          'Evaluation window',
          `${this.formatDate(data.project.evalStart)} → ${this.formatDate(data.project.evalEnd)}`,
        ],
        ['Locked at', this.formatDateTime(data.project.lockedAt)],
        ['Generated at', this.formatDateTime(data.project.generatedAt)],
      ]);

      this.drawSection(doc, 'Leaderboard');
      this.drawTable(
        doc,
        [
          { header: '#', width: 0.05, align: 'right' },
          { header: 'Student', width: 0.24 },
          { header: 'GitHub', width: 0.18 },
          { header: 'Role', width: 0.18 },
          { header: 'Done', width: 0.08, align: 'right' },
          { header: 'PRs', width: 0.08, align: 'right' },
          { header: 'Reviews', width: 0.09, align: 'right' },
          { header: 'Score', width: 0.1, align: 'right' },
        ],
        data.members.map((member, index) => [
          String(index + 1),
          member.name,
          member.githubUsername,
          member.projectRole.replace(/_/g, ' '),
          String(member.doneTasks),
          String(member.mergedPrs),
          String(member.approvedReviews),
          String(member.totalScore),
        ]),
      );

      this.drawSection(doc, 'Task Evidence');
      this.drawTable(
        doc,
        [
          { header: 'Task', width: 0.09 },
          { header: 'Title', width: 0.21 },
          { header: 'Assignee', width: 0.14 },
          { header: 'Status', width: 0.1, render: 'pill' },
          { header: 'Diff.', width: 0.08, render: 'pill' },
          { header: 'Due', width: 0.09 },
          { header: 'PR', width: 0.07 },
          { header: 'Merged', width: 0.1 },
          { header: 'Score', width: 0.06, align: 'right' },
          { header: 'Overdue', width: 0.06, render: 'pill' },
        ],
        data.tasks.map((task) => [
          task.taskId,
          task.title,
          task.assignee,
          task.status,
          task.difficulty,
          this.formatDate(task.dueDate),
          task.linkedPr,
          this.formatDate(task.mergedAt),
          String(task.score),
          this.dueStatus(task.dueDate, task.mergedAt, task.status),
        ]),
      );

      this.drawSection(doc, 'Score Overrides');
      this.drawTable(
        doc,
        [
          { header: 'Student', width: 0.2 },
          { header: 'Delta', width: 0.1, align: 'right' },
          { header: 'Reason', width: 0.34 },
          { header: 'By', width: 0.18 },
          { header: 'Date', width: 0.18 },
        ],
        data.overrides.map((override) => [
          override.student,
          this.formatDelta(override.delta),
          override.reason,
          override.overriddenBy,
          this.formatDate(override.createdAt),
        ]),
      );

      this.drawSection(doc, 'Audit Trail');
      this.drawTable(
        doc,
        [
          { header: 'Action', width: 0.15 },
          { header: 'Actor', width: 0.18 },
          { header: 'Date', width: 0.12 },
          { header: 'Details', width: 0.55 },
        ],
        data.auditLogs.map((entry) => [
          entry.action.replace(/_/g, ' '),
          entry.actor,
          this.formatDate(entry.createdAt),
          entry.metadata,
        ]),
      );

      this.drawSection(doc, 'Scoring Rules');
      [
        'Source of truth: merged pull requests linked to tasks.',
        'Kanban Done movement is status-only and never creates score.',
        'Completed-task timestamp comes from pull-request merge time.',
        'Retroactive linking after project lock is blocked.',
      ].forEach((note) => this.drawBullet(doc, note));
    });
  }

  // ── document lifecycle ───────────────────────────────────────────

  private createDocument(
    verification: ReportVerification | undefined,
    qrPng: Buffer | null,
    draw: (doc: PDFKit.PDFDocument) => void,
  ) {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        margin: 48,
        size: 'A4',
        bufferPages: true, // needed to back-fill page numbers
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

      // Verification block at the end of the body, before footers are
      // back-filled. Drawn last so it always sits on the final page,
      // visually anchoring the document's authenticity claim.
      if (verification && qrPng) {
        this.drawVerificationBlock(doc, verification, qrPng);
      }

      // Page footer with page numbers, drawn after content so we know the count.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        this.drawFooter(doc, i + 1, range.count);
      }

      doc.end();
    });
  }

  private async renderQr(text: string): Promise<Buffer> {
    return QRCode.toBuffer(text, {
      type: 'png',
      width: 180,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Authenticity block at the end of every report. Anyone can scan the
   * QR (or open the printed URL) and the public verify endpoint will
   * confirm whether this PDF really came from Lime++ with these numbers.
   */
  private drawVerificationBlock(
    doc: PDFKit.PDFDocument,
    verification: ReportVerification,
    qrPng: Buffer,
  ) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usable = right - left;
    const h = 110;

    this.ensureSpace(doc, h + 30);
    doc.moveDown(0.8);
    const y = doc.y;

    doc.roundedRect(left, y, usable, h, 6).fill(COLOR.card);
    doc
      .roundedRect(left, y, usable, h, 6)
      .lineWidth(0.5)
      .strokeColor(COLOR.divider)
      .stroke();

    // QR on the right, info on the left.
    const qrSize = 80;
    const qrX = right - qrSize - 14;
    const qrY = y + (h - qrSize) / 2;
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    const textX = left + 16;
    const textWidth = qrX - textX - 16;

    doc
      .fillColor(COLOR.brand)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('AUTHENTICITY', textX, y + 12, {
        width: textWidth,
        lineBreak: false,
      });
    doc
      .fillColor(COLOR.ink)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text('Verify this report at:', textX, y + 26, {
        width: textWidth,
        lineBreak: false,
      });
    doc
      .fillColor(COLOR.body)
      .font('Helvetica')
      .fontSize(9)
      .text(verification.verifyUrl, textX, y + 40, {
        width: textWidth,
        link: verification.verifyUrl,
        underline: true,
      });

    const idLine = `Report ID: ${verification.id}`;
    const hashLine = `SHA-256: ${verification.hash}`;
    const stampLine = `Generated: ${this.formatDateTime(verification.generatedAt)} UTC`;

    doc
      .fillColor(COLOR.muted)
      .font('Helvetica')
      .fontSize(7.5)
      .text(idLine, textX, y + 64, { width: textWidth, lineBreak: false })
      .text(hashLine, textX, y + 76, { width: textWidth, lineBreak: false })
      .text(stampLine, textX, y + 88, { width: textWidth, lineBreak: false });

    doc.y = y + h + 8;
  }

  // ── layout primitives ────────────────────────────────────────────

  private drawHeader(doc: PDFKit.PDFDocument, title: string) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    doc
      .fillColor(COLOR.brand)
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('Lime++', left, doc.page.margins.top - 8)
      .fillColor(COLOR.muted)
      .font('Helvetica')
      .fontSize(8)
      .text('Objective Technical Evaluation', { align: 'left' });

    doc
      .fillColor(COLOR.ink)
      .font('Helvetica-Bold')
      .fontSize(22)
      .text(title, left, doc.y + 12, {
        width: right - left,
        align: 'left',
      });

    doc
      .moveTo(left, doc.y + 4)
      .lineTo(right, doc.y + 4)
      .lineWidth(0.5)
      .strokeColor(COLOR.brand)
      .stroke();

    doc.moveDown(1.4);
  }

  private drawFooter(doc: PDFKit.PDFDocument, page: number, total: number) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom + 18;

    doc
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text('Lime++ · Objective Technical Evaluation', left, bottom, {
        width: right - left,
        align: 'left',
        lineBreak: false,
      })
      .text(`Page ${page} of ${total}`, left, bottom, {
        width: right - left,
        align: 'right',
        lineBreak: false,
      });
  }

  private drawSection(doc: PDFKit.PDFDocument, title: string) {
    // Reserve room for the heading + table header + one row of content so
    // a section heading never lands at the bottom of a page with its body
    // pushed to the next page (the classic source of "almost-blank" page
    // tails). 100pt is enough for heading + 18pt table header + ~one row.
    this.ensureSpace(doc, 100);
    const left = doc.page.margins.left;

    doc.moveDown(0.6);
    const y = doc.y;
    // Lime accent bar to the left of the heading.
    doc.rect(left, y + 3, 3, 14).fill(COLOR.brand);
    doc
      .fillColor(COLOR.ink)
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(title, left + 10, y);
    doc.moveDown(0.4);
  }

  private drawBullet(doc: PDFKit.PDFDocument, text: string) {
    this.ensureSpace(doc, 22);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    doc.fillColor(COLOR.brand).fontSize(9).text('•', left, doc.y, {
      lineBreak: false,
    });
    doc
      .fillColor(COLOR.body)
      .font('Helvetica')
      .fontSize(9)
      .text(text, left + 12, doc.y, {
        width: right - left - 12,
      });
    doc.moveDown(0.2);
  }

  /**
   * Two-column key/value list — sturdier than the previous single-line
   * "Key: Value" layout because long values wrap inside their column
   * without pushing the next row off the page.
   */
  private drawKeyValueGrid(
    doc: PDFKit.PDFDocument,
    rows: Array<[string, string]>,
  ) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usable = right - left;
    const labelWidth = 130;
    const valueWidth = usable - labelWidth - 8;

    rows.forEach(([key, value]) => {
      const display = value || 'N/A';
      const rowHeight = Math.max(
        14,
        doc
          .font('Helvetica')
          .fontSize(9)
          .heightOfString(display, { width: valueWidth }) + 4,
      );
      this.ensureSpace(doc, rowHeight + 4);

      const y = doc.y;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text(key, left, y, { width: labelWidth, lineBreak: false });
      doc
        .fillColor(COLOR.ink)
        .text(display, left + labelWidth + 8, y, { width: valueWidth });
      doc.y = y + rowHeight;
    });
    doc.moveDown(0.3);
  }

  // ── tables ───────────────────────────────────────────────────────

  /**
   * Real columnar table with header fill and alternating row stripes.
   * Each cell wraps inside its column width and the row height is the
   * max of cell heights so columns stay aligned.
   */
  private drawTable(
    doc: PDFKit.PDFDocument,
    columns: Column[],
    rows: string[][],
  ) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usable = right - left;
    const colWidths = columns.map((c) => usable * c.width);
    const colX: number[] = [];
    let cursor = left;
    for (const w of colWidths) {
      colX.push(cursor);
      cursor += w;
    }
    const cellPad = 4;

    const drawHeader = () => {
      const h = 18;
      this.ensureSpace(doc, h + 24);
      const y = doc.y;
      doc.rect(left, y, usable, h).fill(COLOR.brand);
      columns.forEach((col, i) => {
        const align = col.align || 'left';
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor('#ffffff')
          .text(col.header.toUpperCase(), colX[i] + cellPad, y + 5, {
            width: colWidths[i] - cellPad * 2,
            align,
            lineBreak: false,
          });
      });
      doc.y = y + h;
    };

    if (rows.length === 0) {
      // Skip the table chrome entirely — a header strip with "No records"
      // wastes most of a page worth of vertical space when several
      // sections in a row are empty (common on fresh projects).
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text('No records yet.', left, doc.y, {
          width: usable,
          lineBreak: false,
        });
      doc.moveDown(0.6);
      return;
    }

    drawHeader();

    rows.forEach((row, rowIndex) => {
      // Measure tallest cell.
      doc.font('Helvetica').fontSize(8.5);
      const cellHeights = row.map((value, i) => {
        const col = columns[i];
        const text = value || '—';
        if (col.render === 'pill') return 16;
        return (
          doc.heightOfString(text, { width: colWidths[i] - cellPad * 2 }) + 2
        );
      });
      const rowHeight = Math.max(18, Math.max(...cellHeights) + 6);

      // Page break — re-draw the header on the new page so the table
      // remains readable across spreads.
      if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        drawHeader();
      }

      const y = doc.y;
      if (rowIndex % 2 === 1) {
        doc.rect(left, y, usable, rowHeight).fill(COLOR.rowAlt);
      }

      row.forEach((value, i) => {
        const col = columns[i];
        const display = value && value.length > 0 ? value : '—';
        const x = colX[i] + cellPad;
        const w = colWidths[i] - cellPad * 2;
        const align = col.align || 'left';

        if (col.render === 'pill') {
          this.drawPill(doc, display, x, y + (rowHeight - 14) / 2, w);
          return;
        }
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(COLOR.body)
          .text(display, x, y + 5, { width: w, align });
      });

      // Bottom divider line for clarity.
      doc
        .moveTo(left, y + rowHeight)
        .lineTo(right, y + rowHeight)
        .lineWidth(0.3)
        .strokeColor(COLOR.divider)
        .stroke();
      doc.y = y + rowHeight;
    });
    doc.moveDown(0.5);
  }

  // ── hero & summary visuals ───────────────────────────────────────

  private drawHeroScoreCard(
    doc: PDFKit.PDFDocument,
    data: {
      name: string;
      subtitle: string;
      totalScore: number;
      breakdown: Array<{ label: string; value: number }>;
    },
  ) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usable = right - left;
    const h = 90;
    const y = doc.y;

    doc.roundedRect(left, y, usable, h, 6).fill(COLOR.brandSoft);
    doc
      .roundedRect(left, y, usable, h, 6)
      .lineWidth(0.5)
      .strokeColor(COLOR.brand)
      .stroke();

    // Left: name + subtitle
    doc
      .fillColor(COLOR.muted)
      .font('Helvetica')
      .fontSize(8)
      .text('CONTRIBUTOR', left + 16, y + 14, { lineBreak: false });
    doc
      .fillColor(COLOR.ink)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(data.name, left + 16, y + 26, {
        width: usable * 0.55 - 16,
        lineBreak: false,
      });
    doc
      .fillColor(COLOR.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(data.subtitle, left + 16, y + 48, {
        width: usable * 0.55 - 16,
        lineBreak: false,
      });

    // Right: huge total score
    const scoreX = left + usable * 0.6;
    doc
      .fillColor(COLOR.muted)
      .font('Helvetica')
      .fontSize(8)
      .text('TOTAL SCORE', scoreX, y + 14, {
        width: usable * 0.4 - 16,
        align: 'right',
        lineBreak: false,
      });
    doc
      .fillColor(COLOR.brand)
      .font('Helvetica-Bold')
      .fontSize(32)
      .text(String(data.totalScore), scoreX, y + 26, {
        width: usable * 0.4 - 16,
        align: 'right',
        lineBreak: false,
      });

    doc.y = y + h + 10;

    // Breakdown chips row below the card.
    const chipH = 38;
    const chipGap = 10;
    const chipW = (usable - chipGap * (data.breakdown.length - 1)) /
      data.breakdown.length;
    const cy = doc.y;
    data.breakdown.forEach((entry, i) => {
      const cx = left + i * (chipW + chipGap);
      doc.roundedRect(cx, cy, chipW, chipH, 4).fill(COLOR.card);
      doc
        .fillColor(COLOR.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(entry.label.toUpperCase(), cx + 10, cy + 6, {
          width: chipW - 20,
          lineBreak: false,
        });
      doc
        .fillColor(COLOR.ink)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(this.formatDelta(entry.value), cx + 10, cy + 17, {
          width: chipW - 20,
          lineBreak: false,
        });
    });
    doc.y = cy + chipH + 8;
  }

  private drawProjectCover(
    doc: PDFKit.PDFDocument,
    data: ProjectReportData,
  ) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usable = right - left;

    // Project name as a hero line, then status pill underneath.
    doc
      .fillColor(COLOR.ink)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(data.project.name, left, doc.y, { width: usable });
    this.drawPill(doc, data.project.status, left, doc.y + 4, 140);
    doc.moveDown(2);

    // 6-up stats strip across the page.
    const stats: Array<[string, string]> = [
      ['Members', String(data.summary.totalMembers)],
      ['Active', String(data.summary.activeContributors)],
      ['Tasks', String(data.summary.totalTasks)],
      ['Done', String(data.summary.doneTasks)],
      ['Merged PRs', String(data.summary.mergedPrs)],
      ['Avg done', String(data.summary.averageDoneTasks)],
    ];
    const gap = 8;
    const cardW = (usable - gap * (stats.length - 1)) / stats.length;
    const cardH = 52;
    const cy = doc.y;
    stats.forEach(([label, value], i) => {
      const cx = left + i * (cardW + gap);
      doc.roundedRect(cx, cy, cardW, cardH, 5).fill(COLOR.card);
      doc
        .fillColor(COLOR.muted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(label.toUpperCase(), cx, cy + 8, {
          width: cardW,
          align: 'center',
          lineBreak: false,
        });
      doc
        .fillColor(COLOR.ink)
        .font('Helvetica-Bold')
        .fontSize(18)
        .text(value, cx, cy + 22, {
          width: cardW,
          align: 'center',
          lineBreak: false,
        });
    });
    doc.y = cy + cardH + 12;
  }

  // ── pills ────────────────────────────────────────────────────────

  private drawPill(
    doc: PDFKit.PDFDocument,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
  ) {
    const palette = this.pillPalette(text);
    const display = text || '—';

    doc.font('Helvetica-Bold').fontSize(7.5);
    const textW = Math.min(
      doc.widthOfString(display.toUpperCase()),
      maxWidth - 12,
    );
    const pillW = textW + 12;
    const pillH = 14;

    doc.roundedRect(x, y, pillW, pillH, pillH / 2).fill(palette.bg);
    doc
      .fillColor(palette.fg)
      .text(display.toUpperCase(), x + 6, y + 3.5, {
        width: textW,
        lineBreak: false,
      });
  }

  private pillPalette(value: string): { fg: string; bg: string } {
    const upper = (value || '').toUpperCase();
    if (
      [
        'DONE',
        'MERGED',
        'APPROVED',
        'VALID',
        'ACTIVE',
        'PASSED',
        'ON TIME',
        'ON TRACK',
        'LOW',
      ].includes(upper)
    ) {
      return COLOR.green;
    }
    if (
      ['IN_PROGRESS', 'IN PROGRESS', 'OPEN', 'COMMENTED', 'MEDIUM'].includes(
        upper,
      )
    ) {
      return COLOR.blue;
    }
    if (
      [
        'BLOCKED',
        'FAILED',
        'CLOSED',
        'INVALID',
        'CHANGES_REQUESTED',
        'LOCKED',
        'LOCKED (FINAL)',
        'LATE',
        'OVERDUE',
      ].includes(upper)
    ) {
      return COLOR.red;
    }
    if (['FLAGGED', 'WARNING', 'HIGH'].includes(upper)) {
      return COLOR.amber;
    }
    return COLOR.gray;
  }

  /**
   * Compact label for the "Overdue" column in the task table. Returns a
   * string the pill renderer can color: "On time" / "Late" when the task
   * is DONE, "On track" / "Overdue" when it isn't. Empty when there's no
   * due date so the pill renderer prints a dash.
   */
  private dueStatus(
    dueDate: PdfDate,
    mergedAt: PdfDate,
    status: string,
  ): string {
    if (!dueDate) return '';
    const due = new Date(dueDate);
    if (status === 'DONE') {
      const completed = mergedAt ? new Date(mergedAt) : null;
      if (!completed) return 'On time';
      return completed > due ? 'Late' : 'On time';
    }
    return new Date() > due ? 'Overdue' : 'On track';
  }

  // ── utility ──────────────────────────────────────────────────────

  private ensureSpace(doc: PDFKit.PDFDocument, height: number) {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
  }

  private formatDate(value: PdfDate) {
    if (!value) return '—';
    return new Date(value).toISOString().slice(0, 10);
  }

  private formatDateTime(value: PdfDate) {
    if (!value) return '—';
    return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
  }

  private formatDelta(value: number) {
    if (value > 0) return `+${value}`;
    return String(value);
  }
}
