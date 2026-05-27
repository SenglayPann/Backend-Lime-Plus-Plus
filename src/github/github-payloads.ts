export interface GitHubUserPayload {
  id: number;
  login: string;
  avatar_url?: string;
}

export interface GitHubRepositoryPayload {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUserPayload;
}

export interface GitHubInstallationPayload {
  id: number;
}

export interface GitHubPullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  user: GitHubUserPayload;
  head: {
    sha: string;
  };
}

export interface GitHubWebhookPayload {
  action: string;
  repository: GitHubRepositoryPayload;
  sender: GitHubUserPayload;
  installation?: GitHubInstallationPayload;
}

export interface GitHubPullRequestEventPayload extends GitHubWebhookPayload {
  pull_request: GitHubPullRequestPayload;
}

export interface GitHubPullRequestReviewPayload {
  id: number;
  state: string;
  body: string | null;
  user: GitHubUserPayload;
  submitted_at: string;
}

export interface GitHubPullRequestReviewEventPayload extends GitHubWebhookPayload {
  pull_request: GitHubPullRequestPayload;
  review: GitHubPullRequestReviewPayload;
}

export interface GitHubProjectV2Payload {
  id: number;
  node_id: string;
  owner: GitHubUserPayload;
  creator: GitHubUserPayload;
  title: string;
  description: string | null;
  public: boolean;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubProjectV2EventPayload extends GitHubWebhookPayload {
  projects_v2: GitHubProjectV2Payload;
}

export interface GitHubProjectV2ItemPayload {
  id: string;
  node_id: string;
  project_node_id: string;
  content_node_id?: string;
  content_type: string;
  creator: GitHubUserPayload;
  content?: {
    title?: string;
    number?: number;
    assignees?: {
      nodes: GitHubUserPayload[];
    };
  };
  created_at: string;
  updated_at: string;
}

export interface GitHubProjectV2ItemEventPayload extends GitHubWebhookPayload {
  projects_v2_item: GitHubProjectV2ItemPayload;
  changes?: {
    field_value?: {
      field_node_id: string;
      field_type: string;
      field_name?: string;
      from?: {
        name?: string;
        id?: string;
      };
      to?: {
        name?: string;
        id?: string;
      };
    };
  };
}

export interface GitHubIssuePayload {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  user: GitHubUserPayload;
  assignees: GitHubUserPayload[];
  labels?: Array<{ id: number; name: string; color?: string }>;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssuesEventPayload extends GitHubWebhookPayload {
  issue: GitHubIssuePayload;
  assignee?: GitHubUserPayload;
  label?: { id: number; name: string; color?: string };
  changes?: {
    title?: { from: string };
    body?: { from: string };
  };
}

export interface GitHubPushEventPayload extends GitHubWebhookPayload {
  ref: string;
  before: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    author: { name: string; email: string; username: string };
  }>;
}
