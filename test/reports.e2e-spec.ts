import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ReportsModule } from './../src/common/reports/reports.module';
import { ReportsService } from './../src/common/reports/reports.service';
import { JwtAuthGuard } from './../src/common/guards/jwt-auth.guard';
import { RolesGuard } from './../src/common/guards/roles.guard';
import { PrismaService } from './../src/prisma/prisma.service';

describe('ReportsController (e2e)', () => {
  let app: INestApplication;
  const mockReportsService = {
    exportIndividualPdf: jest
      .fn()
      .mockResolvedValue(Buffer.from('pdf-content')),
    exportProjectPdf: jest
      .fn()
      .mockResolvedValue(Buffer.from('project-pdf-content')),
    exportProjectCsv: jest.fn().mockResolvedValue('name,score\nUser 1,100'),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ReportsModule],
    })
      .overrideProvider(ReportsService)
      .useValue(mockReportsService)
      .overrideProvider(PrismaService)
      .useValue({}) // Empty mock as ReportsService is already mocked
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/reports/individual (POST) - generates PDF', () => {
    return request(app.getHttpServer())
      .post('/reports/individual')
      .send({ project_id: 'p1', user_id: 'u1', format: 'pdf' })
      .expect(201)
      .expect('Content-Type', /application\/pdf/)
      .expect('Content-Disposition', /attachment/);
  });

  it('/reports/project (POST) - generates PDF', () => {
    return request(app.getHttpServer())
      .post('/reports/project')
      .send({ project_id: 'p1', format: 'pdf' })
      .expect(201)
      .expect('Content-Type', /application\/pdf/);
  });

  it('/reports/project (POST) - generates CSV', () => {
    return request(app.getHttpServer())
      .post('/reports/project')
      .send({ project_id: 'p1', format: 'csv' })
      .expect(201)
      .expect((res) => {
        expect(res.text).toContain('name,score');
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
