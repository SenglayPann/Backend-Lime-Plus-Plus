import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ReportsModule } from './../src/common/reports/reports.module';
import { ReportsService } from './../src/common/reports/reports.service';
import { JwtAuthGuard } from './../src/common/guards/jwt-auth.guard';
import { RolesGuard } from './../src/common/guards/roles.guard';
import { PrismaService } from './../src/prisma/prisma.service';
import { TransformInterceptor } from './../src/common/interceptors';

describe('ReportsController (e2e)', () => {
  let app: INestApplication;
  const mockReportsService = {
    exportIndividualPdf: jest
      .fn()
      .mockResolvedValue(Buffer.from('%PDF-individual')),
    exportProjectPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-project')),
    exportProjectCsv: jest
      .fn()
      .mockResolvedValue(
        '\uFEFF"rank","student_name","total_score"\n1,"User 1",100',
      ),
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
      .useValue({
        canActivate: (context) => {
          const request = context.switchToHttp().getRequest();
          request.user = {
            id: 'teacher',
            roles: ['DEPARTMENT_MANAGER'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  it('/reports/individual (POST) - generates PDF', () => {
    return request(app.getHttpServer())
      .post('/reports/individual')
      .send({ project_id: 'p1', user_id: 'u1', format: 'pdf' })
      .expect(201)
      .expect('Content-Type', /application\/pdf/)
      .expect('Content-Disposition', /lime_individual_report_u1\.pdf/)
      .expect((res) => {
        expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
      });
  });

  it('/reports/project (POST) - generates PDF', () => {
    return request(app.getHttpServer())
      .post('/reports/project')
      .send({ project_id: 'p1', format: 'pdf' })
      .expect(201)
      .expect('Content-Type', /application\/pdf/)
      .expect('Content-Disposition', /lime_project_report_p1\.pdf/)
      .expect((res) => {
        expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
      });
  });

  it('/reports/project (POST) - generates CSV', () => {
    return request(app.getHttpServer())
      .post('/reports/project')
      .send({ project_id: 'p1', format: 'csv' })
      .expect(201)
      .expect('Content-Type', /text\/csv/)
      .expect('Content-Disposition', /lime_project_scores_p1\.csv/)
      .expect((res) => {
        expect(res.text).toContain('"rank","student_name","total_score"');
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
