import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';
import { Role } from '../../generated/prisma';

export class UpsertProjectMemberDto {
  @ApiProperty({ example: 'd6c54a4d-8a13-4a99-9d19-901c40b3a8ff' })
  @IsUUID()
  @IsNotEmpty()
  user_id: string;

  @ApiProperty({
    enum: [Role.PROJECT_MEMBER, Role.PROJECT_MANAGER],
    example: Role.PROJECT_MEMBER,
    required: false,
  })
  @IsEnum(Role)
  @IsOptional()
  role?: Role;
}
