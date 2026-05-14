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
      nodes: Array<{
        databaseId?: number | null;
        id?: string;
        login: string;
        avatarUrl?: string;
      }>;
    };
  };
  fieldValues: {
    nodes: Array<{
      __typename: string;
      name?: string;
      text?: string;
      field?: {
        name?: string;
      };
    }>;
  };
}

export interface GraphQLRepositoryResponse {
  repository: {
    pullRequests: {
      nodes: GitHubPR[];
    };
  };
}

export interface GraphQLSinglePRResponse {
  repository: {
    pullRequest: GitHubPR;
  };
}

export interface GraphQLProjectResponse {
  node: {
    items: {
      nodes: GitHubProjectItem[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
}

export interface GraphQLRepositoryValidationResponse {
  repository: {
    id: string;
    nameWithOwner: string;
    url: string;
  } | null;
}

export interface GraphQLProjectValidationResponse {
  node: {
    __typename: string;
    id?: string;
    title?: string;
    url?: string;
  } | null;
}
