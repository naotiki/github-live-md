export type GitHubUser = {
	id: number
	login: string
	name: string | null
	avatar_url: string
}

export type AuthStatus = {
	configured: boolean
	user: GitHubUser | null
	appSlug: string | null
	commitEmail: string | null
}

export type CommitEmailOption = {
	email: string
	primary: boolean
	verified: boolean
	visibility: 'public' | 'private' | null
	kind: 'github' | 'noreply'
	recommended: boolean
}

export type SessionAccessPolicy = 'link' | 'write'
export type SessionRetentionDays = 7 | 14 | 21 | 28

export type SessionMeta = {
	id: string
	demo: boolean
	repository: string | null
	baseBranch: string | null
	documentPath: string
	baseCommitSha: string | null
	baseBlobSha: string | null
	createdAt: string
	createdBy: {
		id: number | null
		login: string
		name: string
		avatarUrl: string | null
	}
	status: 'editing' | 'published'
	pullRequestUrl: string | null
	pullRequestNumber: number | null
	pullRequestBranch: string | null
	lastPublishedCommitSha: string | null
	publishedAssetPaths: string[]
	assetDirectory: string
	accessPolicy: SessionAccessPolicy
	retentionDays: SessionRetentionDays
	expiresAt: string
}

export type Participant = {
	id: number | null
	login: string
	name: string
	avatarUrl: string | null
	lastSeenAt: string
}

export type PendingAsset = {
	id: string
	finalPath: string
	markdownPath: string
	mimeType: string
	size: number
	originalName: string
	uploadedBy: string
	createdAt: string
	previewUrl?: string
}

export type SessionState = {
	meta: SessionMeta
	participants: Participant[]
	assets: PendingAsset[]
}

export type Repository = {
	id: number
	full_name: string
	private: boolean
	default_branch: string
	updated_at: string
	owner: { avatar_url: string }
}

export type SessionListItem = {
	id: string
	ownerId: number
	ownerLogin: string
	repository: string
	baseBranch: string
	documentPath: string
	createdAt: string
	expiresAt: string
	status: 'editing' | 'published'
	accessPolicy: SessionAccessPolicy
	pullRequestUrl: string | null
	pullRequestNumber: number | null
	pullRequestBranch: string | null
	lastPublishedCommitSha: string | null
}

export type PublishResult = {
	pullRequestUrl: string
	pullRequestNumber: number
	branch: string
	commitSha: string
	alreadyPublished?: boolean
	createdPullRequest?: boolean
}
