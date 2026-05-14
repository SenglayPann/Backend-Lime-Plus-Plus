import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PrStatus } from '../../generated/prisma';

export class ListPullRequestsQueryDto {
  @IsUUID()
  @IsOptional()
  assignee_id?: string;

  @IsEnum(PrStatus)
  @IsOptional()
  status?: PrStatus;
}
