import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LICENSE_PLANS } from './create-organization.dto';

export class UpdateOrganizationDto {
  @ApiProperty({ example: 'Engineering Faculty', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    example: 'enterprise',
    description: 'License plan for the organization',
    required: false,
  })
  @IsString()
  @IsIn(LICENSE_PLANS)
  @IsOptional()
  license_plan?: string;
}
