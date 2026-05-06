import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsEnum, IsString, IsOptional, IsUUID } from 'class-validator';
import { Role } from '../../generated/prisma';

export class AssignRoleDto {
  @ApiProperty({ enum: Role, example: 'DEPARTMENT_MANAGER' })
  @IsEnum(Role)
  @IsNotEmpty()
  role: Role;

  @ApiProperty({ example: 'org_123', required: false })
  @IsUUID()
  @IsOptional()
  organization_id?: string;

  @ApiProperty({ example: 'dept_456', required: false })
  @IsUUID()
  @IsOptional()
  department_id?: string;
}
