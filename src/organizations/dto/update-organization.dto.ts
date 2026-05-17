import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';
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

  @ApiProperty({
    example: 'd6c54a4d-8a13-4a99-9d19-901c40b3a8ff',
    description: 'User to add as an organization manager',
    required: false,
    nullable: true,
  })
  @IsUUID()
  @IsOptional()
  @ValidateIf((o) => o.manager_user_id !== null && o.manager_user_id !== '')
  manager_user_id?: string | null;
}
