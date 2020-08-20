// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// See: https://github.com/octokit/rest.js/issues/1624
//  https://github.com/octokit/types.ts/issues/25.
import {Octokit} from '@octokit/rest';
import {PromiseValue} from 'type-fest';
type PullsListResponseItems = PromiseValue<
  ReturnType<InstanceType<typeof Octokit>['pulls']['list']>
>['data'];
type PullsListResponseItem = PromiseValue<
  ReturnType<InstanceType<typeof Octokit>['pulls']['get']>
>['data'];

import * as semver from 'semver';

import {checkpoint, CheckpointType} from './util/checkpoint';
import {ConventionalCommits} from './conventional-commits';
import {GitHub, GitHubReleasePR, GitHubTag, OctokitAPIs} from './github';
import {Commit} from './graphql-to-commits';
import {Update} from './updaters/update';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parseGithubRepoUrl = require('parse-github-repo-url');

export interface BuildOptions {
  bumpMinorPreMajor?: boolean;
  defaultBranch?: string;
  label?: string;
  token?: string;
  repoUrl: string;
  packageName: string;
  // When releasing multiple libraries from one repository, include a prefix
  // on tags and branch names:
  monorepoTags?: boolean;
  path?: string;
  releaseAs?: string;
  apiUrl: string;
  proxyKey?: string;
  snapshot?: boolean;
  lastPackageVersion?: string;
  octokitAPIs?: OctokitAPIs;
}

export interface ReleasePROptions extends BuildOptions {
  releaseType: string;
}

export interface ReleaseCandidate {
  version: string;
  previousTag?: string;
}

interface GetCommitsOptions {
  sha?: string;
  perPage?: number;
  labels?: boolean;
  path?: string;
}

interface OpenPROptions {
  sha: string;
  changelogEntry: string;
  updates: Update[];
  version: string;
  includePackageName: boolean;
}

const DEFAULT_LABELS = 'autorelease: pending';

export class ReleasePR {
  static releaserName = 'base';

  apiUrl: string;
  defaultBranch?: string;
  labels: string[];
  gh: GitHub;
  bumpMinorPreMajor?: boolean;
  repoUrl: string;
  token: string | undefined;
  path?: string;
  packageName: string;
  monorepoTags: boolean;
  releaseAs?: string;
  proxyKey?: string;
  snapshot?: boolean;
  lastPackageVersion?: string;

  constructor(options: ReleasePROptions) {
    this.bumpMinorPreMajor = options.bumpMinorPreMajor || false;
    this.defaultBranch = options.defaultBranch;
    this.labels = options.label
      ? options.label.split(',')
      : DEFAULT_LABELS.split(',');
    this.repoUrl = options.repoUrl;
    this.token = options.token;
    this.path = options.path;
    this.packageName = options.packageName;
    this.monorepoTags = options.monorepoTags || false;
    this.releaseAs = options.releaseAs;
    this.apiUrl = options.apiUrl;
    this.proxyKey = options.proxyKey;
    this.snapshot = options.snapshot;
    // drop a `v` prefix if provided:
    this.lastPackageVersion = options.lastPackageVersion
      ? options.lastPackageVersion.replace(/^v/, '')
      : undefined;

    this.gh = this.gitHubInstance(options.octokitAPIs);
  }

  async run() {
    if (this.snapshot && !this.supportsSnapshots()) {
      checkpoint(
        'snapshot releases not supported for this releaser',
        CheckpointType.Failure
      );
      return;
    }
    const pr: GitHubReleasePR | undefined = await this.gh.findMergedReleasePR(
      this.labels
    );
    if (pr) {
      // a PR already exists in the autorelease: pending state.
      checkpoint(
        `pull #${pr.number} ${pr.sha} has not yet been released`,
        CheckpointType.Failure
      );
    } else {
      return this._run();
    }
  }

  protected async _run() {
    throw Error('must be implemented by subclass');
  }

  protected supportsSnapshots(): boolean {
    return false;
  }

  private async closeStaleReleasePRs(
    currentPRNumber: number,
    includePackageName = false
  ) {
    const prs: PullsListResponseItems = await this.gh.findOpenReleasePRs(
      this.labels
    );
    for (let i = 0, pr; i < prs.length; i++) {
      pr = prs[i];
      // don't close the most up-to-date release PR.
      if (pr.number !== currentPRNumber) {
        // on mono repos that maintain multiple open release PRs, we use the
        // pull request title to differentiate between PRs:
        if (includePackageName && !pr.title.includes(` ${this.packageName} `)) {
          continue;
        }
        checkpoint(
          `closing pull #${pr.number} on ${this.repoUrl}`,
          CheckpointType.Failure
        );
        await this.gh.closePR(pr.number);
      }
    }
  }

  protected defaultInitialVersion(): string {
    return '1.0.0';
  }

  // A releaser can implement this method to automatically detect
  // the release name when creating a GitHub release, for instance by returning
  // name in package.json, or setup.py.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async lookupPackageName(gh: GitHub): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  protected async coerceReleaseCandidate(
    cc: ConventionalCommits,
    latestTag: GitHubTag | undefined
  ): Promise<ReleaseCandidate> {
    const releaseAsRe = /release-as:\s*v?([0-9]+\.[0-9]+\.[0-9a-z]+(-[0-9a-z.]+)?)\s*/i;
    const previousTag = latestTag ? latestTag.name : undefined;
    let version = latestTag ? latestTag.version : this.defaultInitialVersion();

    // If a commit contains the footer release-as: 1.x.x, we use this version
    // from the commit footer rather than the version returned by suggestBump().
    const releaseAsCommit = cc.commits.find((element: Commit) => {
      if (element.message.match(releaseAsRe)) {
        return true;
      } else {
        return false;
      }
    });

    if (releaseAsCommit) {
      const match = releaseAsCommit.message.match(releaseAsRe);
      version = match![1];
    } else if (latestTag && !this.releaseAs) {
      const bump = await cc.suggestBump(version);
      const candidate: string | null = semver.inc(version, bump.releaseType);
      if (!candidate) throw Error(`failed to increment ${version}`);
      version = candidate;
    } else if (this.releaseAs) {
      version = this.releaseAs;
    }

    return {version, previousTag};
  }

  protected async commits(opts: GetCommitsOptions): Promise<Commit[]> {
    const sha = opts.sha;
    const perPage = opts.perPage || 100;
    const labels = opts.labels || false;
    const path = opts.path || undefined;
    const commits = await this.gh.commitsSinceSha(sha, perPage, labels, path);
    if (commits.length) {
      checkpoint(
        `found ${commits.length} commits since ${
          sha ? sha : 'beginning of time'
        }`,
        CheckpointType.Success
      );
    } else {
      checkpoint(`no commits found since ${sha}`, CheckpointType.Failure);
    }
    return commits;
  }

  protected gitHubInstance(octokitAPIs?: OctokitAPIs): GitHub {
    const [owner, repo] = parseGithubRepoUrl(this.repoUrl);
    return new GitHub({
      token: this.token,
      defaultBranch: this.defaultBranch,
      owner,
      repo,
      apiUrl: this.apiUrl,
      proxyKey: this.proxyKey,
      octokitAPIs,
    });
  }

  protected async openPR(options: OpenPROptions) {
    const sha = options.sha;
    const changelogEntry = options.changelogEntry;
    const updates = options.updates;
    const version = options.version;
    const includePackageName = options.includePackageName;

    const title = includePackageName
      ? `Release ${this.packageName} ${version}`
      : `chore: release ${version}`;
    const body = `:robot: I have created a release \\*beep\\* \\*boop\\* \n---\n${changelogEntry}\n\nThis PR was generated with [Release Please](https://github.com/googleapis/release-please).`;
    const pr: number = await this.gh.openPR({
      branch: includePackageName
        ? `release-${this.packageName}-v${version}`
        : `release-v${version}`,
      version,
      sha,
      updates,
      title,
      body,
      labels: this.labels,
    });
    // a return of -1 indicates that PR was not updated.
    if (pr > 0) {
      await this.gh.addLabels(this.labels, pr);
      checkpoint(
        `${this.repoUrl} find stale PRs with label "${this.labels.join(',')}"`,
        CheckpointType.Success
      );
      await this.closeStaleReleasePRs(pr, includePackageName);
    }
  }

  protected changelogEmpty(changelogEntry: string) {
    return changelogEntry.split('\n').length === 1;
  }

  addPath(file: string) {
    if (this.path === undefined) {
      return file;
    } else {
      const path = this.path.replace(/[/\\]$/, '');
      file = file.replace(/^[/\\]/, '');
      return `${path}/${file}`;
    }
  }
}
