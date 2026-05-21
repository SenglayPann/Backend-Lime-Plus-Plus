import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { graphql } from '@octokit/graphql';
import { createAppAuth } from '@octokit/auth-app';
import {
  GitHubPR,
  GitHubProjectItem,
  GraphQLRepositoryResponse,
  GraphQLSinglePRResponse,
  GraphQLProjectResponse,
  GraphQLRepositoryValidationResponse,
  GraphQLProjectValidationResponse,
} from './github.types';

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private graphqlWithAuth: typeof graphql;

  constructor(private configService: ConfigService) {
    // Will be initialized when an installation token is available
    this.graphqlWithAuth = graphql;
  }

  /**
   * Get an installation-scoped access token for a specific GitHub App installation
   */
  async getAppInstallationToken(
    installationId: string,
  ): Promise<string | null> {
    const appId = this.configService.get<string>('GITHUB_APP_ID');
    const privateKey = this.configService.get<string>('GITHUB_APP_PRIVATE_KEY');

    if (!appId || !privateKey) {
      this.logger.warn(
        'GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing. Cannot get installation token.',
      );
      return null;
    }

    try {
      const auth = createAppAuth({
        appId,
        privateKey: privateKey.replace(/\\n/g, '\n'), // handle nested newlines in env vars
      });

      const installationAuthentication = await auth({
        type: 'installation',
        installationId: parseInt(installationId, 10),
      });

      return installationAuthentication.token;
    } catch (error) {
      this.logger.error(
        `Failed to authorize GitHub App for installation ${installationId}`,
        error,
      );
      return null;
    }
  }

  /**
   * Create an authenticated GraphQL client using a user's access token
   */
  private getAuthenticatedClient(accessToken: string) {
    return graphql.defaults({
      headers: {
        authorization: `token ${accessToken}`,
      },
    });
  }

  /**
   * Fetch all PRs from a repository
   */
  async getRepositoryPRs(
    owner: string,
    repo: string,
    accessToken: string,
    state: 'OPEN' | 'CLOSED' | 'MERGED' = 'OPEN',
    first = 50,
  ): Promise<GitHubPR[]> {
    const client = this.getAuthenticatedClient(accessToken);

    const query = `
      query($owner: String!, $repo: String!, $states: [PullRequestState!], $first: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: $states, first: $first, orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
              number
              title
              url
              state
              mergedAt
              createdAt
              author {
                login
                avatarUrl
              }
              additions
              deletions
              changedFiles
              reviews(first: 10) {
                nodes {
                  author { login }
                  state
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    `;

    try {
      const response = await client<GraphQLRepositoryResponse>(query, {
        owner,
        repo,
        states: [state],
        first,
      });

      return response.repository.pullRequests.nodes;
    } catch (error) {
      this.logger.error(`Failed to fetch PRs for ${owner}/${repo}`, error);
      throw error;
    }
  }

  /**
   * Fetch a single PR by number
   */
  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
    accessToken: string,
  ): Promise<GitHubPR> {
    const client = this.getAuthenticatedClient(accessToken);

    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            number
            title
            url
            state
            mergedAt
            createdAt
            author {
              login
              avatarUrl
            }
            additions
            deletions
            changedFiles
            reviews(first: 50) {
              nodes {
                author { login }
                state
                body
                createdAt
              }
            }
          }
        }
      }
    `;

    try {
      const response = await client<GraphQLSinglePRResponse>(query, {
        owner,
        repo,
        number,
      });
      return response.repository.pullRequest;
    } catch (error) {
      this.logger.error(
        `Failed to fetch PR #${number} for ${owner}/${repo}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Fetch GitHub Projects v2 items
   */
  async getProjectItems(
    projectId: string,
    accessToken: string,
    first = 100,
  ): Promise<GitHubProjectItem[]> {
    const client = this.getAuthenticatedClient(accessToken);

    const query = `
      query($projectId: ID!, $first: Int!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    title
                    number
                    state
                    assignees(first: 5) {
                      nodes { databaseId id login avatarUrl }
                    }
                  }
                  ... on PullRequest {
                    title
                    number
                    state
                    assignees(first: 5) {
                      nodes { databaseId id login avatarUrl }
                    }
                  }
                  ... on DraftIssue {
                    title
                  }
                }
                fieldValues(first: 10) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2FieldCommon {
                          name
                        }
                      }
                    }
                    ... on ProjectV2ItemFieldTextValue {
                      text
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const items: GitHubProjectItem[] = [];
      let after: string | null = null;
      let hasNextPage = true;

      while (hasNextPage) {
        const response: GraphQLProjectResponse =
          await client<GraphQLProjectResponse>(query, {
          projectId,
          first,
          after,
        });
        items.push(...response.node.items.nodes);
        hasNextPage = response.node.items.pageInfo.hasNextPage;
        after = response.node.items.pageInfo.endCursor;
      }

      return items;
    } catch (error) {
      this.logger.error(
        `Failed to fetch project items for ${projectId}`,
        error,
      );
      throw error;
    }
  }

  async getRepositoryInfo(
    owner: string,
    repo: string,
    accessToken: string,
  ): Promise<GraphQLRepositoryValidationResponse['repository']> {
    const client = this.getAuthenticatedClient(accessToken);

    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          id
          nameWithOwner
          url
        }
      }
    `;

    try {
      const response = await client<GraphQLRepositoryValidationResponse>(
        query,
        { owner, repo },
      );
      return response.repository;
    } catch {
      this.logger.warn(
        `GitHub repository validation failed for ${owner}/${repo}`,
      );
      return null;
    }
  }

  async repositoryExists(
    owner: string,
    repo: string,
    accessToken: string,
  ): Promise<boolean> {
    return Boolean(await this.getRepositoryInfo(owner, repo, accessToken));
  }

  async projectV2Exists(
    projectId: string,
    accessToken: string,
  ): Promise<boolean> {
    const client = this.getAuthenticatedClient(accessToken);

    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          __typename
          ... on ProjectV2 {
            id
            title
            url
          }
        }
      }
    `;

    try {
      const response = await client<GraphQLProjectValidationResponse>(query, {
        projectId,
      });
      return response.node?.__typename === 'ProjectV2';
    } catch {
      this.logger.warn(`GitHub ProjectV2 validation failed for ${projectId}`);
      return false;
    }
  }

  /**
   * Create a commit status check on a PR (spec §5.2)
   */
  async createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string,
    context: string,
    installationToken: string,
  ): Promise<void> {
    const url = `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${installationToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state,
          description,
          context,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(
          `Failed to create commit status: ${response.status} ${response.statusText} - ${errorText}`,
        );
      } else {
        this.logger.debug(
          `Commit status created successfully for ${sha} (${context}: ${state})`,
        );
      }
    } catch (error) {
      this.logger.error(`Error creating commit status for ${sha}`, error);
    }
  }

  /**
   * Check if a user is a collaborator on a repository (returns boolean)
   */
  async isCollaborator(
    owner: string,
    repo: string,
    username: string,
    accessToken: string,
  ): Promise<boolean> {
    const url = `https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.status === 204) {
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(
        `Failed to check collaborator status for ${username} in ${owner}/${repo}`,
        error,
      );
      return false;
    }
  }
}
