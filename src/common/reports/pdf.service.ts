import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

export interface IndividualReportData {
  name: string;
  email: string;
  organization: string;
  department: string;
  totalScore: number;
  breakdown: { name: string; value: number }[];
  pullRequests: { id: string; title: string; score: number; url: string }[];
}

export interface ProjectReportData {
  name: string;
  organization: string;
  status: string;
  members: { name: string; score: number }[];
}

@Injectable()
export class PdfService {
  async generateIndividualReport(data: IndividualReportData): Promise<Buffer> {
    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // Header
      this.generateHeader(doc, 'Student Contribution Report');

      // Student Info
      doc
        .fontSize(12)
        .text(`Student: ${data.name}`, { underline: true })
        .text(`Email: ${data.email}`)
        .text(`Organization: ${data.organization}`)
        .text(`Department: ${data.department}`)
        .moveDown();

      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

      // Score Summary
      doc
        .fontSize(16)
        .text('Evaluation Summary', { underline: true })
        .moveDown(0.5);
      doc
        .fontSize(24)
        .fillColor('#4d7c0f')
        .text(`Final Score: ${data.totalScore}`, { align: 'center' })
        .fillColor('black')
        .moveDown();

      // Breakdown
      doc.fontSize(14).text('Contribution Breakdown').moveDown(0.5);
      data.breakdown.forEach((item) => {
        doc.fontSize(10).text(`${item.name}: ${item.value} points`);
      });
      doc.moveDown();

      // Audit Log / Evidence
      doc.fontSize(14).text('Evidence (Merged PRs)').moveDown(0.5);
      data.pullRequests.forEach((pr) => {
        doc.fontSize(10).text(`- [${pr.id}] ${pr.title} (+${pr.score} pts)`, {
          link: pr.url,
        });
      });

      doc.end();
    });
  }

  async generateProjectReport(data: ProjectReportData): Promise<Buffer> {
    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      this.generateHeader(doc, 'Project Completion Report');

      doc
        .fontSize(12)
        .text(`Project: ${data.name}`, { underline: true })
        .text(`Organization: ${data.organization}`)
        .text(`Status: ${data.status}`)
        .moveDown();

      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

      // Team Performance
      doc.fontSize(14).text('Team Performance Leaderboard').moveDown(0.5);
      data.members.forEach((member, index) => {
        doc
          .fontSize(10)
          .text(`${index + 1}. ${member.name} - ${member.score} points`);
      });

      doc.end();
    });
  }

  private generateHeader(doc: PDFKit.PDFDocument, title: string) {
    doc
      .fillColor('#4d7c0f')
      .fontSize(20)
      .text('Lime++', { align: 'right' })
      .fillColor('black')
      .fontSize(10)
      .text('Objective Technical Evaluation System', { align: 'right' })
      .moveDown(2);

    doc.fontSize(25).text(title, { align: 'center' }).moveDown();
  }
}
