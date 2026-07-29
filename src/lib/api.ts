import type {
	AuthStatus,
	CommitEmailOption,
	PendingAsset,
	PublishResult,
	Repository,
	SessionAccessPolicy,
	SessionListItem,
	SessionMeta,
	SessionRetentionDays,
	SessionState,
} from './types'

type ApiErrorBody = {
	error?: string
	details?: unknown
}

export class ApiClientError extends Error {
	readonly status: number
	readonly details?: unknown

	constructor(
		message: string,
		status: number,
		details?: unknown,
	) {
		super(message)
		this.status = status
		this.details = details
	}
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers)
	if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}
	const response = await fetch(path, { ...init, headers })
	if (!response.ok) {
		let body: ApiErrorBody = {}
		try {
			body = (await response.json()) as ApiErrorBody
		} catch {
			// The HTTP status remains useful if an intermediary returned HTML.
		}
		throw new ApiClientError(body.error ?? `Request failed (${response.status})`, response.status, body.details)
	}
	return (await response.json()) as T
}

export const client = {
	authStatus: () => api<AuthStatus>('/api/auth/status'),

	commitEmails: () =>
		api<{ emails: CommitEmailOption[]; selected: string | null }>(
			'/api/auth/emails',
		),

	selectCommitEmail: (email: string) =>
		api<{ selected: string }>('/api/auth/email', {
			method: 'POST',
			body: JSON.stringify({ email }),
		}),

	logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

	repositories: () =>
		api<{ repositories: Repository[] }>('/api/github/repositories'),

	sessions: () =>
		api<{ sessions: SessionListItem[] }>('/api/sessions'),

	branches: (repository: string) =>
		api<{ branches: Array<{ name: string; protected: boolean }> }>(
			`/api/github/branches?repository=${encodeURIComponent(repository)}`,
		),

	markdownFiles: (repository: string, branch: string) =>
		api<{ files: Array<{ path: string; size: number }>; truncated: boolean }>(
			`/api/github/markdown-files?repository=${encodeURIComponent(repository)}&branch=${encodeURIComponent(branch)}`,
		),

	createDemoSession: (guestName: string, retentionDays: SessionRetentionDays = 14) =>
		api<{ session: SessionMeta; reused: boolean }>('/api/sessions', {
			method: 'POST',
			body: JSON.stringify({ demo: true, guestName, retentionDays }),
		}),

	createGitHubSession: (
		repository: string,
		branch: string,
		path: string,
		retentionDays: SessionRetentionDays = 14,
		accessPolicy: SessionAccessPolicy = 'link',
	) =>
		api<{ session: Pick<SessionMeta, 'id'>; reused: boolean }>('/api/sessions', {
			method: 'POST',
			body: JSON.stringify({
				repository,
				branch,
				path,
				retentionDays,
				accessPolicy,
			}),
		}),

	session: (sessionId: string) =>
		api<SessionState>(`/api/sessions/${sessionId}`),

	uploadAsset: async (
		sessionId: string,
		file: File,
		guestName: string,
	): Promise<PendingAsset> => {
		const form = new FormData()
		form.set('file', file)
		if (guestName) form.set('guestName', guestName)
		const result = await api<{ asset: PendingAsset }>(
			`/api/sessions/${sessionId}/assets`,
			{ method: 'POST', body: form },
		)
		return result.asset
	},

	updateAssetDirectory: (sessionId: string, directory: string) =>
		api<{ meta: SessionMeta }>(
			`/api/sessions/${sessionId}/asset-directory`,
			{
				method: 'PATCH',
				body: JSON.stringify({ directory }),
			},
		),

	renameAsset: async (
		sessionId: string,
		assetId: string,
		fileName: string,
	): Promise<PendingAsset> => {
		const result = await api<{ asset: PendingAsset }>(
			`/api/sessions/${sessionId}/assets/${assetId}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ fileName }),
			},
		)
		return result.asset
	},

	deleteAsset: (sessionId: string, assetId: string) =>
		api<{ assetId: string }>(
			`/api/sessions/${sessionId}/assets/${assetId}`,
			{ method: 'DELETE' },
		),

	deleteSession: (sessionId: string) =>
		api<{ ok: boolean }>(`/api/sessions/${sessionId}`, {
			method: 'DELETE',
		}),

	updateSessionSettings: (
		sessionId: string,
		payload: {
			accessPolicy: SessionAccessPolicy
			retentionDays: SessionRetentionDays
		},
	) =>
		api<{ meta: SessionMeta }>(`/api/sessions/${sessionId}/settings`, {
			method: 'PATCH',
			body: JSON.stringify(payload),
		}),

	publish: (
		sessionId: string,
		payload: { title: string; description: string; commitMessage: string },
	) =>
		api<PublishResult>(`/api/sessions/${sessionId}/publish`, {
			method: 'POST',
			body: JSON.stringify(payload),
		}),
}
