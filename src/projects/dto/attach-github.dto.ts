import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class AttachGitHubDto {
  @ApiProperty({
    example: 'org/repo',
    description: 'GitHub repository in owner/repo format',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  repository: string;

  @ApiProperty({
    example: 'PVT_kwHO...',
    description: 'GitHub Project V2 ID',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  github_project_id: string;

  @ApiProperty({
    example: 'ghp_xxxx',
    description: 'Optional GitHub Personal Access Token or OAuth Access Token',
    required: false,
  })
  @IsString()
  @IsOptional()
  github_token?: string;
}
