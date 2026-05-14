import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

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
}
