import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { graphql } from '@octokit/graphql';

export interface GitHubPR {
  number: number;
  title: string;
  url: string;
  state: string;
  mergedAt: string | null;
  createdAt: string;
  author: {
    login: string;
    avatarUrl: string;
  };
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: {
    nodes: Array<{
      author: { login: string };
      state: string;
      body: string;
      createdAt: string;
    }>;
  };
}

export interface GitHubProjectItem {
  id: string;
  content: {
    __typename: string;
    title: string;
    number?: number;
    state?: string;
    assignees?: {
      nodes: Array<{ login: string }>;
    };
  };
  fieldValues: {
    nodes: Array<{
      __typename: string;
      name?: string;
      text?: string;
    }>;
  };
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private graphqlWithAuth: typeof graphql;

  constructor(private configService: ConfigService) {
    // Will be initialized when an installation token is available
    this.graphqlWithAuth = graphql;
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
      const response: any = await client(query, {
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
      const response: any = await client(query, { owner, repo, number });
      return response.repository.pullRequest;
    } catch (error) {
      this.logger.error(`Failed to fetch PR #${number} for ${owner}/${repo}`, error);
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
      query($projectId: ID!, $first: Int!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: $first) {
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    title
                    number
                    state
                    assignees(first: 5) {
                      nodes { login }
                    }
                  }
                  ... on PullRequest {
                    title
                    number
                    state
                    assignees(first: 5) {
                      nodes { login }
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
      const response: any = await client(query, { projectId, first });
      return response.node.items.nodes;
    } catch (error) {
      this.logger.error(`Failed to fetch project items for ${projectId}`, error);
      throw error;
    }
  }
}
