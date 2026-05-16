import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export const LICENSE_PLANS = ['standard', 'academic', 'enterprise', 'trial'] as const;

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Engineering Faculty' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'enterprise',
    description: 'License plan for the organization',
  })
  @IsString()
  @IsIn(LICENSE_PLANS)
  @IsNotEmpty()
  license_plan: string;

  @ApiPropertyOptional({
    example: '9d4a6df2-7644-4d6e-9f0a-3deaf8c5328d',
    description:
      'Optional user to grant ORGANIZATION_MANAGER for the new organization',
  })
  @IsOptional()
  @IsUUID()
  manager_user_id?: string;
}
