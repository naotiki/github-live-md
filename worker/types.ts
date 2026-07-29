export type GitHubUser = {
	id: number
	login: string
	name: string | null
	avatar_url: string
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

export type SessionParticipant = {
	id: number | null
	login: string
	name: string
	avatarUrl: string | null
	commitEmail: string | null
	lastSeenAt: string
}

export type PublicSessionParticipant = Omit<SessionParticipant, 'commitEmail'>

export type PendingAsset = {
	id: string
	finalPath: string
	markdownPath: string
	r2Key: string
	mimeType: string
	size: number
	originalName: string
	uploadedBy: string
	createdAt: string
}

export type SessionExport = {
	meta: SessionMeta
	markdown: string
	participants: SessionParticipant[]
	assets: PendingAsset[]
}

export type SessionRegistryEntry = {
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

export interface AppEnv extends Env {
	GITHUB_APP_ID?: string
	GITHUB_PRIVATE_KEY?: string
	GITHUB_WEBHOOK_SECRET?: string
}
