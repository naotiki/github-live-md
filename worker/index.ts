import {
	arrayBufferToBase64,
	decodeBase64Utf8,
	encodeGitHubPath,
	getGitHubToken,
	getGitHubUser,
	githubNoReplyEmail,
	githubRequest,
	handleAuth,
	isGitHubConfigured,
	resolveCommitEmail,
} from './github.js'
import {
	ApiError,
	readJsonBody,
	readMultipartFormData,
	readRequestBody,
} from './http.js'
import {
	MAX_IMAGE_UPLOAD_BODY_BYTES,
	MAX_JSON_BODY_BYTES,
	MAX_MARKDOWN_BYTES,
	MAX_WEBHOOK_BODY_BYTES,
	utf8ByteLength,
} from '../shared/limits.js'
import { isAutomaticArchiveConfigured } from './archive.js'
import { SessionRegistry } from './registry.js'
import { EditingSession } from './session.js'
import type {
	AppEnv,
	GitHubUser,
	PendingAsset,
	PublicSessionParticipant,
	SessionExport,
	SessionMeta,
	SessionParticipant,
	SessionRegistryEntry,
	SessionRetentionDays,
} from './types.js'

export { EditingSession, SessionRegistry }

type SessionState = {
	meta: SessionMeta
	participants: PublicSessionParticipant[]
	assets: PendingAsset[]
}

type SessionAccess = {
	user: GitHubUser
	commitEmail: string | null
	canWrite: boolean
}

type GitHubContent = {
	type: string
	sha: string
	encoding?: string
	content?: string
}

type GitHubRef = {
	object: { sha: string }
}

type GitHubCommit = {
	sha: string
	tree: { sha: string }
}

const DAY_MS = 24 * 60 * 60 * 1_000
const RETENTION_DAYS = new Set<SessionRetentionDays>([7, 14, 21, 28])

function jsonError(message: string, status: number, details?: unknown): Response {
	return Response.json({ error: message, details }, { status })
}

function sessionStub(env: AppEnv, sessionId: string): DurableObjectStub {
	return env.EDITING_SESSIONS.getByName(sessionId, { locationHint: 'apac-ne' })
}

function registryStub(env: AppEnv): DurableObjectStub {
	return env.SESSION_REGISTRY.getByName('global', { locationHint: 'apac-ne' })
}

async function fetchSessionState(env: AppEnv, sessionId: string): Promise<SessionState> {
	const response = await sessionStub(env, sessionId).fetch('https://session/meta')
	if (!response.ok) {
		throw new ApiError('Session not found', response.status)
	}
	return (await response.json()) as SessionState
}

async function fetchSessionExport(env: AppEnv, sessionId: string): Promise<SessionExport> {
	const response = await sessionStub(env, sessionId).fetch('https://session/export')
	if (!response.ok) {
		throw new ApiError('Session not found', response.status)
	}
	return (await response.json()) as SessionExport
}

function validSessionId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	)
}

function requireRepository(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^[-_.a-zA-Z0-9]+\/[-_.a-zA-Z0-9]+$/.test(value)
	) {
		throw new ApiError('Invalid repository name', 400)
	}
	return value
}

function requireRepositoryPath(value: unknown, markdownOnly = false): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.startsWith('/') ||
		value.includes('\\') ||
		value.includes('\0') ||
		value.split('/').some((part) => part === '..' || part === '')
	) {
		throw new ApiError('Invalid repository path', 400)
	}
	if (markdownOnly && !value.toLowerCase().endsWith('.md')) {
		throw new ApiError('The editing target must be a .md file', 400)
	}
	return value
}

function defaultAssetDirectory(documentPath: string): string {
	const separator = documentPath.lastIndexOf('/')
	return separator === -1
		? 'images'
		: `${documentPath.slice(0, separator)}/images`
}

function requireStoredAssetDirectory(value: unknown): string {
	if (typeof value !== 'string') {
		throw new ApiError('Image directory is required', 400)
	}
	if (value === '.') return value
	return requireRepositoryPath(value)
}

function resolveAssetDirectory(documentPath: string, value: unknown): string {
	if (typeof value !== 'string') {
		throw new ApiError('Image directory is required', 400)
	}
	const input = value.trim()
	if (
		!input ||
		input.length > 500 ||
		input.startsWith('/') ||
		input.includes('\\') ||
		input.includes('\0') ||
		[...input].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint < 32 || codePoint === 127
		})
	) {
		throw new ApiError('Invalid image directory', 400)
	}

	const documentDirectory = documentPath.includes('/')
		? documentPath.slice(0, documentPath.lastIndexOf('/'))
		: ''
	const resolved = documentDirectory ? documentDirectory.split('/') : []
	const parts = input.split('/')
	for (const [index, part] of parts.entries()) {
		if (!part && index === parts.length - 1) continue
		if (!part) throw new ApiError('Invalid image directory', 400)
		if (part === '.') continue
		if (part === '..') {
			if (!resolved.length) {
				throw new ApiError('Image directory cannot escape the repository', 400)
			}
			resolved.pop()
			continue
		}
		resolved.push(part)
	}

	const directory = resolved.join('/') || '.'
	if (directory.length > 500) {
		throw new ApiError('Image directory is too long', 400)
	}
	return requireStoredAssetDirectory(directory)
}

function requireBranch(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.startsWith('/') ||
		value.endsWith('/') ||
		value.includes('..') ||
		value.includes('~') ||
		value.includes('^') ||
		value.includes(':') ||
		value.includes('?') ||
		value.includes('*') ||
		value.includes('[') ||
		value.includes('\\')
	) {
		throw new ApiError('Invalid branch name', 400)
	}
	return value
}

function requireRetentionDays(value: unknown): SessionRetentionDays {
	const days = value === undefined ? 14 : Number(value)
	if (!RETENTION_DAYS.has(days as SessionRetentionDays)) {
		throw new ApiError('Retention must be 7, 14, 21, or 28 days', 400)
	}
	return days as SessionRetentionDays
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
	if (typeof value !== 'string') return fallback
	const cleaned = [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint < 32 || codePoint === 127 ? ' ' : character
		})
		.join('')
		.trim()
	return cleaned.slice(0, maxLength) || fallback
}

function participantFromUser(
	user: GitHubUser,
	commitEmail: string | null,
): SessionParticipant {
	return {
		id: user.id,
		login: user.login,
		name: cleanText(user.name, user.login, 100),
		avatarUrl: user.avatar_url,
		commitEmail,
		lastSeenAt: new Date().toISOString(),
	}
}

async function requireGitHub(request: Request): Promise<{ token: string; user: GitHubUser }> {
	const token = getGitHubToken(request)
	if (!token) throw new ApiError('GitHub login required', 401)
	const user = await getGitHubUser(request)
	if (!user) throw new ApiError('GitHub session expired', 401)
	return { token, user }
}

type RepositoryAccess = {
	permissions?: {
		admin?: boolean
		maintain?: boolean
		push?: boolean
		pull?: boolean
	}
}

async function requireRepositoryWriteAccess(
	token: string,
	repository: string,
): Promise<void> {
	const access = await githubRequest<RepositoryAccess>(
		token,
		`/repos/${repository}`,
	)
	if (
		!access.permissions?.push &&
		!access.permissions?.maintain &&
		!access.permissions?.admin
	) {
		throw new ApiError(
			'このリポジトリへのwrite権限が必要です',
			403,
		)
	}
}

async function ensureSessionAccess(
	request: Request,
	state: SessionState,
): Promise<SessionAccess> {
	if (!state.meta.repository || !state.meta.baseBranch) {
		throw new ApiError('This session type is no longer supported', 410)
	}
	const { token, user } = await requireGitHub(request)
	const repository = await githubRequest<RepositoryAccess>(
		token,
		`/repos/${state.meta.repository}`,
	)
	const canWrite = Boolean(
		repository.permissions?.push ||
			repository.permissions?.maintain ||
			repository.permissions?.admin,
	)
	if (state.meta.accessPolicy === 'write' && !canWrite) {
		throw new ApiError('このセッションへの参加にはwrite権限が必要です', 403)
	}
	return {
		user,
		commitEmail: await resolveCommitEmail(request, token, user, false),
		canWrite,
	}
}

async function getBranchTip(
	token: string,
	repository: string,
	branch: string,
): Promise<{ commitSha: string; treeSha: string }> {
	const gitRef = await githubRequest<GitHubRef>(
		token,
		`/repos/${repository}/git/ref/heads/${encodeGitHubPath(branch)}`,
	)
	const commit = await githubRequest<GitHubCommit>(
		token,
		`/repos/${repository}/git/commits/${gitRef.object.sha}`,
	)
	return { commitSha: gitRef.object.sha, treeSha: commit.tree.sha }
}

async function readMarkdownFile(
	token: string,
	repository: string,
	branch: string,
	path: string,
): Promise<{ markdown: string; blobSha: string | null }> {
	try {
		const file = await githubRequest<GitHubContent>(
			token,
			`/repos/${repository}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`,
		)
		if (file.type !== 'file' || file.encoding !== 'base64' || !file.content) {
			throw new ApiError('The selected path is not a readable text file', 400)
		}
		return { markdown: decodeBase64Utf8(file.content), blobSha: file.sha }
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return { markdown: `# ${path.split('/').pop()?.replace(/\.md$/i, '') ?? 'New document'}\n\n`, blobSha: null }
		}
		throw error
	}
}

async function handleGitHubApi(request: Request, pathname: string): Promise<Response> {
	const { token } = await requireGitHub(request)
	const url = new URL(request.url)

	if (pathname === '/api/github/repositories') {
		const installations = await githubRequest<{
			installations: Array<{ id: number; account: { login: string } }>
		}>(token, '/user/installations?per_page=100')
		const repositories = (
			await Promise.all(
				installations.installations.map(async (installation) => {
					const result = await githubRequest<{
						repositories: Array<{
							id: number
							full_name: string
							private: boolean
							default_branch: string
							updated_at: string
							owner: { avatar_url: string }
							permissions?: {
								admin?: boolean
								maintain?: boolean
								push?: boolean
							}
						}>
					}>(
						token,
						`/user/installations/${installation.id}/repositories?per_page=100`,
					)
					return result.repositories.filter(
						(repo) =>
							repo.permissions?.push ||
							repo.permissions?.maintain ||
							repo.permissions?.admin,
					)
				}),
			)
		).flat()
		const unique = [...new Map(repositories.map((repo) => [repo.id, repo])).values()]
		unique.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
		return Response.json({ repositories: unique })
	}

	const repository = requireRepository(url.searchParams.get('repository'))

	if (pathname === '/api/github/branches') {
		const branches = await githubRequest<Array<{ name: string; protected: boolean }>>(
			token,
			`/repos/${repository}/branches?per_page=100`,
		)
		return Response.json({ branches })
	}

	if (pathname === '/api/github/markdown-files') {
		const branch = requireBranch(url.searchParams.get('branch'))
		const { treeSha } = await getBranchTip(token, repository, branch)
		const tree = await githubRequest<{
			truncated: boolean
			tree: Array<{ path: string; type: string; size?: number }>
		}>(token, `/repos/${repository}/git/trees/${treeSha}?recursive=1`)
		const files = tree.tree
			.filter(
				(item) =>
					item.type === 'blob' &&
					item.path.toLowerCase().endsWith('.md') &&
					(item.size ?? 0) <= 2_000_000,
			)
			.map((item) => ({ path: item.path, size: item.size ?? 0 }))
		return Response.json({ files, truncated: tree.truncated })
	}

	throw new ApiError('Not found', 404)
}

async function createSession(request: Request, env: AppEnv): Promise<Response> {
	if (request.method !== 'POST') throw new ApiError('Method not allowed', 405)
	const payload = await readJsonBody<{
		repository?: string
		branch?: string
		path?: string
		retentionDays?: number
		accessPolicy?: 'link' | 'write'
	}>(request, MAX_JSON_BODY_BYTES)
	const id = crypto.randomUUID()
	const retentionDays = requireRetentionDays(payload.retentionDays)
	const createdAt = new Date()
	const expiresAt = new Date(
		createdAt.getTime() + retentionDays * DAY_MS,
	).toISOString()

	const { token, user } = await requireGitHub(request)
	const commitEmail = await resolveCommitEmail(request, token, user)
	const repository = requireRepository(payload.repository)
	const branch = requireBranch(payload.branch)
	const documentPath = requireRepositoryPath(payload.path, true)
	const accessPolicy = payload.accessPolicy === 'write' ? 'write' : 'link'
	await requireRepositoryWriteAccess(token, repository)
	const targetKey = [repository.toLowerCase(), branch, documentPath].join('\n')
	const reservation = await registryStub(env).fetch('https://registry/reserve', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			id,
			ownerId: user.id,
			ownerLogin: user.login,
			repository,
			baseBranch: branch,
			documentPath,
			createdAt: createdAt.toISOString(),
			expiresAt,
			status: 'editing',
			accessPolicy,
			pullRequestUrl: null,
			pullRequestNumber: null,
			pullRequestBranch: null,
			lastPublishedCommitSha: null,
			targetKey,
		}),
	})
	if (!reservation.ok) {
		throw new ApiError('Could not reserve the editing session', reservation.status)
	}
	const reserved = (await reservation.json()) as {
		created: boolean
		session: SessionRegistryEntry
	}
	if (!reserved.created) {
		return Response.json({
			session: { id: reserved.session.id },
			reused: true,
		})
	}

	let meta: SessionMeta
	let markdown: string
	let participant: SessionParticipant
	try {
		const [{ commitSha }, file] = await Promise.all([
			getBranchTip(token, repository, branch),
			readMarkdownFile(token, repository, branch, documentPath),
		])
		markdown = file.markdown
		if (utf8ByteLength(markdown) > MAX_MARKDOWN_BYTES) {
			throw new ApiError('Markdown files must not exceed 2 MB', 413)
		}
		participant = participantFromUser(user, commitEmail)
		meta = {
			id,
			repository,
			baseBranch: branch,
			documentPath,
			baseCommitSha: commitSha,
			baseBlobSha: file.blobSha,
			createdAt: createdAt.toISOString(),
			createdBy: {
				id: user.id,
				login: user.login,
				name: cleanText(user.name, user.login, 100),
				avatarUrl: user.avatar_url,
			},
			status: 'editing',
			pullRequestUrl: null,
			pullRequestNumber: null,
			pullRequestBranch: null,
			lastPublishedCommitSha: null,
			publishedAssetPaths: [],
			assetDirectory: defaultAssetDirectory(documentPath),
			accessPolicy,
			retentionDays,
			expiresAt,
		}
	} catch (error) {
		await registryStub(env).fetch(
			`https://registry/sessions/${id}/release`,
			{ method: 'DELETE' },
		)
		throw error
	}

	const response = await sessionStub(env, id).fetch('https://session/init', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ meta, markdown, participant }),
	})
	if (!response.ok) {
		await registryStub(env).fetch(
			`https://registry/sessions/${id}/release`,
			{ method: 'DELETE' },
		)
		throw new ApiError('Could not initialize the editing session', response.status)
	}

	return Response.json({ session: meta, reused: false }, { status: 201 })
}

async function listSessions(
	request: Request,
	env: AppEnv,
): Promise<Response> {
	if (request.method !== 'GET') throw new ApiError('Method not allowed', 405)
	const { user } = await requireGitHub(request)
	const response = await registryStub(env).fetch(
		`https://registry/list?ownerId=${user.id}`,
	)
	if (!response.ok) {
		throw new ApiError('Could not load editing sessions', response.status)
	}
	return new Response(response.body, {
		status: response.status,
		headers: { 'Content-Type': 'application/json' },
	})
}

async function handleSessionsCollection(
	request: Request,
	env: AppEnv,
): Promise<Response> {
	return request.method === 'GET'
		? listSessions(request, env)
		: createSession(request, env)
}

function extensionForMime(mimeType: string): string {
	switch (mimeType) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		case 'image/gif':
			return 'gif'
		default:
			throw new ApiError('Unsupported image type', 415)
	}
}

function requireAssetFileName(value: unknown, mimeType: string): string {
	if (typeof value !== 'string') {
		throw new ApiError('Image file name is required', 400)
	}
	let fileName = value.trim().normalize('NFKC')
	if (
		!fileName ||
		fileName.length > 160 ||
		fileName === '.' ||
		fileName === '..' ||
		fileName.includes('/') ||
		fileName.includes('\\') ||
		fileName.includes('\0') ||
		[...fileName].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint < 32 || codePoint === 127
		})
	) {
		throw new ApiError('Invalid image file name', 400)
	}

	const expectedExtension = extensionForMime(mimeType)
	if (!fileName.includes('.')) {
		fileName = `${fileName}.${expectedExtension}`
	}
	const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
	const allowedExtensions =
		mimeType === 'image/jpeg' ? new Set(['jpg', 'jpeg']) : new Set([expectedExtension])
	if (!allowedExtensions.has(extension)) {
		throw new ApiError(
			`File extension must match the image type (.${[...allowedExtensions].join(' or .')})`,
			400,
		)
	}
	return fileName
}

function safeAssetBaseName(originalName: string): string {
	const withoutExtension = originalName.replace(/\.[^.]+$/, '')
	const safe = withoutExtension
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
	return safe || 'image'
}

function relativeRepositoryPath(fromDirectory: string, target: string): string {
	const from = fromDirectory ? fromDirectory.split('/') : []
	const to = target.split('/')
	let common = 0
	while (common < from.length && common < to.length && from[common] === to[common]) {
		common += 1
	}
	const relative = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
	return relative.startsWith('.') ? relative : `./${relative}`
}

async function uploadAsset(
	request: Request,
	env: AppEnv,
	sessionId: string,
	state: SessionState,
	user: GitHubUser,
): Promise<Response> {
	if (request.method !== 'POST') throw new ApiError('Method not allowed', 405)
	const form = await readMultipartFormData(request, MAX_IMAGE_UPLOAD_BODY_BYTES)
	const file = form.get('file')
	if (!(file instanceof File)) throw new ApiError('An image file is required', 400)
	if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
		throw new ApiError('Images must be between 1 byte and 10 MB', 413)
	}
	const extension = extensionForMime(file.type)
	const documentDirectory = state.meta.documentPath.includes('/')
		? state.meta.documentPath.slice(0, state.meta.documentPath.lastIndexOf('/'))
		: ''
	const assetDirectory = requireStoredAssetDirectory(state.meta.assetDirectory)
	const id = crypto.randomUUID()
	const fileName = `${safeAssetBaseName(file.name)}-${id.slice(0, 8)}.${extension}`
	const finalPath = requireRepositoryPath(
		assetDirectory === '.' ? fileName : `${assetDirectory}/${fileName}`,
	)
	const markdownPath = relativeRepositoryPath(documentDirectory, finalPath)
	const r2Key = `sessions/${sessionId}/${id}`
	const uploadedBy = user.login
	const asset: PendingAsset = {
		id,
		finalPath,
		markdownPath,
		r2Key,
		mimeType: file.type,
		size: file.size,
		originalName: file.name,
		uploadedBy,
		createdAt: new Date().toISOString(),
	}

	await env.ASSET_BUCKET.put(r2Key, file.stream(), {
		httpMetadata: { contentType: file.type },
		customMetadata: {
			sessionId,
			assetId: id,
			finalPath,
		},
	})
	const register = await sessionStub(env, sessionId).fetch('https://session/assets', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(asset),
	})
	if (!register.ok) {
		await env.ASSET_BUCKET.delete(r2Key)
		throw new ApiError('Could not register the uploaded image', register.status)
	}

	const { r2Key: _r2Key, ...publicAsset } = asset
	return Response.json(
		{
			asset: {
				...publicAsset,
				previewUrl: `/api/sessions/${sessionId}/assets/${id}`,
			},
		},
		{ status: 201 },
	)
}

async function serveAsset(
	env: AppEnv,
	assetId: string,
	state: SessionState,
): Promise<Response> {
	const asset = state.assets.find((item) => item.id === assetId)
	if (!asset) throw new ApiError('Image not found', 404)
	const object = await env.ASSET_BUCKET.get(asset.r2Key)
	if (!object) throw new ApiError('Image data not found', 404)
	const headers = new Headers()
	object.writeHttpMetadata(headers)
	headers.set('Content-Type', asset.mimeType)
	headers.set('Cache-Control', 'private, max-age=60')
	headers.set('X-Content-Type-Options', 'nosniff')
	return new Response(object.body, { headers })
}

async function removeAsset(
	env: AppEnv,
	sessionId: string,
	assetId: string,
): Promise<Response> {
	const response = await sessionStub(env, sessionId).fetch(
		`https://session/assets/${assetId}`,
		{ method: 'DELETE' },
	)
	if (!response.ok) {
		throw new ApiError('Image not found', response.status)
	}
	const asset = (await response.json()) as PendingAsset
	try {
		await env.ASSET_BUCKET.delete(asset.r2Key)
	} catch (error) {
		console.error('Could not remove unreferenced staged image data', {
			sessionId,
			assetId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
	return Response.json({ assetId })
}

async function renameAsset(
	request: Request,
	env: AppEnv,
	sessionId: string,
	assetId: string,
	state: SessionState,
): Promise<Response> {
	if (request.method !== 'PATCH') throw new ApiError('Method not allowed', 405)
	const asset = state.assets.find((item) => item.id === assetId)
	if (!asset) throw new ApiError('Image not found', 404)
	const payload = await readJsonBody<{ fileName?: unknown }>(
		request,
		MAX_JSON_BODY_BYTES,
	)
	const fileName = requireAssetFileName(payload.fileName, asset.mimeType)
	const separator = asset.finalPath.lastIndexOf('/')
	const directory =
		separator === -1 ? '' : asset.finalPath.slice(0, separator)
	const finalPath = requireRepositoryPath(
		directory ? `${directory}/${fileName}` : fileName,
	)
	const documentDirectory = state.meta.documentPath.includes('/')
		? state.meta.documentPath.slice(0, state.meta.documentPath.lastIndexOf('/'))
		: ''
	const markdownPath = relativeRepositoryPath(documentDirectory, finalPath)
	const response = await sessionStub(env, sessionId).fetch(
		`https://session/assets/${assetId}`,
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ finalPath, markdownPath }),
		},
	)
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			error?: string
		}
		throw new ApiError(
			body.error ?? 'Could not rename the image',
			response.status,
		)
	}
	const renamed = (await response.json()) as PendingAsset
	const { r2Key: _r2Key, ...publicAsset } = renamed
	return Response.json({
		asset: {
			...publicAsset,
			previewUrl: `/api/sessions/${sessionId}/assets/${assetId}`,
		},
	})
}

async function updateAssetDirectory(
	request: Request,
	env: AppEnv,
	sessionId: string,
	state: SessionState,
): Promise<Response> {
	if (request.method !== 'PATCH') throw new ApiError('Method not allowed', 405)
	const payload = await readJsonBody<{ directory?: unknown }>(
		request,
		MAX_JSON_BODY_BYTES,
	)
	const assetDirectory = resolveAssetDirectory(
		state.meta.documentPath,
		payload.directory,
	)
	const response = await sessionStub(env, sessionId).fetch(
		'https://session/asset-directory',
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ assetDirectory }),
		},
	)
	if (!response.ok) {
		throw new ApiError('Could not update the image directory', response.status)
	}
	const result = (await response.json()) as { meta: SessionMeta }
	return Response.json({ meta: result.meta })
}

async function currentBlobSha(
	token: string,
	repository: string,
	branch: string,
	path: string,
): Promise<string | null> {
	try {
		const content = await githubRequest<GitHubContent>(
			token,
			`/repos/${repository}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`,
		)
		return content.sha
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null
		throw error
	}
}

function branchSlug(path: string): string {
	const file = path.split('/').pop()?.replace(/\.md$/i, '') ?? 'document'
	return (
		file
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'document'
	)
}

async function publishSession(
	request: Request,
	env: AppEnv,
	sessionId: string,
): Promise<Response> {
	if (request.method !== 'POST') throw new ApiError('Method not allowed', 405)
	const { token, user } = await requireGitHub(request)
	const commitEmail = await resolveCommitEmail(request, token, user)
	const session = await fetchSessionExport(env, sessionId)
	const { meta } = session
	if (!meta.repository || !meta.baseBranch) {
		throw new ApiError('This session cannot create a pull request', 400)
	}
	await requireRepositoryWriteAccess(token, meta.repository)
	const isFollowUp = meta.status === 'published'

	let pullRequest:
		| {
				html_url: string
				number: number
				state: 'open' | 'closed'
				merged_at: string | null
				head: { ref: string }
			}
		| null = null
	let branch: string

	if (isFollowUp) {
		const numberFromUrl = Number(meta.pullRequestUrl?.split('/').pop())
		const pullRequestNumber =
			meta.pullRequestNumber ??
			(Number.isSafeInteger(numberFromUrl) ? numberFromUrl : null)
		if (!pullRequestNumber) {
			throw new ApiError(
				'このセッションのPull Request情報を復元できません',
				409,
			)
		}
		const currentPullRequest = await githubRequest<{
			html_url: string
			number: number
			state: 'open' | 'closed'
			merged_at: string | null
			head: { ref: string }
		}>(
			token,
			`/repos/${meta.repository}/pulls/${pullRequestNumber}`,
		)
		pullRequest = currentPullRequest
		if (currentPullRequest.merged_at) {
			throw new ApiError(
				'Pull Requestはmerge済みです。セッションを削除してください',
				409,
			)
		}
		if (currentPullRequest.state !== 'open') {
			throw new ApiError(
				'Pull Requestが閉じられているためコミットを追加できません',
				409,
			)
		}
		branch = meta.pullRequestBranch ?? currentPullRequest.head.ref
	} else {
		branch = `collab/${branchSlug(meta.documentPath)}-${sessionId.slice(0, 6)}-${crypto.randomUUID().slice(0, 4)}`
	}

	if (!isFollowUp) {
		const currentSha = await currentBlobSha(
			token,
			meta.repository,
			meta.baseBranch,
			meta.documentPath,
		)
		if (currentSha !== meta.baseBlobSha) {
			throw new ApiError(
				'The target Markdown file changed on GitHub after this session started',
				409,
				{ expected: meta.baseBlobSha, current: currentSha },
			)
		}
	}

	const payload = await readJsonBody<{
		title?: string
		description?: string
		commitMessage?: string
	}>(request, MAX_JSON_BODY_BYTES)
	const defaultTitle = `${meta.baseBlobSha ? 'Update' : 'Add'} ${meta.documentPath}`
	const title = cleanText(payload.title, defaultTitle, 160)
	const description = cleanText(
		payload.description,
		'Collaboratively edited with GitHub Live MD.',
		4_000,
	)
	const commitSubject = cleanText(
		payload.commitMessage,
		`docs: ${isFollowUp || meta.baseBlobSha ? 'update' : 'add'} ${meta.documentPath}`,
		200,
	)

	const { commitSha: latestCommitSha, treeSha: latestTreeSha } = await getBranchTip(
		token,
		meta.repository,
		isFollowUp ? branch : meta.baseBranch,
	)
	const markdownBlob = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/blobs`,
		{
			method: 'POST',
			body: JSON.stringify({ content: session.markdown, encoding: 'utf-8' }),
		},
	)
	const assetBlobs = await Promise.all(
		session.assets.map(async (asset) => {
			const object = await env.ASSET_BUCKET.get(asset.r2Key)
			if (!object) throw new ApiError(`Missing staged image: ${asset.originalName}`, 500)
			const blob = await githubRequest<{ sha: string }>(
				token,
				`/repos/${meta.repository}/git/blobs`,
				{
					method: 'POST',
					body: JSON.stringify({
						content: arrayBufferToBase64(await object.arrayBuffer()),
						encoding: 'base64',
					}),
				},
			)
			return { asset, sha: blob.sha }
		}),
	)
	const tree = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/trees`,
		{
			method: 'POST',
			body: JSON.stringify({
				base_tree: latestTreeSha,
				tree: [
					{
						path: meta.documentPath,
						mode: '100644',
						type: 'blob',
						sha: markdownBlob.sha,
					},
					...assetBlobs.map(({ asset, sha }) => ({
						path: asset.finalPath,
						mode: '100644',
						type: 'blob',
						sha,
					})),
					...meta.publishedAssetPaths
						.filter(
							(path) =>
								!session.assets.some((asset) => asset.finalPath === path),
						)
						.map((path) => ({
							path,
							mode: '100644',
							type: 'blob',
							sha: null,
						})),
				],
			}),
		},
	)
	if (isFollowUp && tree.sha === latestTreeSha) {
		throw new ApiError('コミットする変更がありません', 409)
	}
	const coAuthors = session.participants
		.filter(
			(participant) =>
				participant.id !== null &&
				participant.login.toLowerCase() !== user.login.toLowerCase(),
		)
		.map(
			(participant) =>
				`Co-authored-by: ${cleanText(participant.name, participant.login, 100)} <${participant.commitEmail ?? githubNoReplyEmail({ id: participant.id!, login: participant.login })}>`,
		)
	const message = [
		commitSubject,
		'',
		'Created with GitHub Live MD.',
		...(coAuthors.length ? ['', ...coAuthors] : []),
	].join('\n')
	const commit = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/commits`,
		{
			method: 'POST',
			body: JSON.stringify({
				message,
				tree: tree.sha,
				parents: [latestCommitSha],
				author: {
					name: cleanText(user.name, user.login, 100),
					email: commitEmail,
					date: new Date().toISOString(),
				},
			}),
		},
	)
	if (isFollowUp) {
		await githubRequest(
			token,
			`/repos/${meta.repository}/git/refs/heads/${encodeGitHubPath(branch)}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ sha: commit.sha, force: false }),
			},
		)
	} else {
		await githubRequest(token, `/repos/${meta.repository}/git/refs`, {
			method: 'POST',
			body: JSON.stringify({
				ref: `refs/heads/${branch}`,
				sha: commit.sha,
			}),
		})
		pullRequest = await githubRequest(
			token,
			`/repos/${meta.repository}/pulls`,
			{
				method: 'POST',
				body: JSON.stringify({
					title,
					body: `${description}\n\n---\n\nEdited by ${session.participants
						.map((participant) => `@${participant.login}`)
						.join(', ')}.`,
					head: branch,
					base: meta.baseBranch,
					draft: true,
				}),
			},
		)
	}

	if (!pullRequest) {
		throw new ApiError('Pull Request information is unavailable', 500)
	}
	const completion = {
		pullRequestUrl: pullRequest.html_url,
		pullRequestNumber: pullRequest.number,
		pullRequestBranch: branch,
		lastPublishedCommitSha: commit.sha,
		publishedAssetPaths: session.assets.map((asset) => asset.finalPath),
	}
	const completeResponse = await sessionStub(env, sessionId).fetch(
		'https://session/complete',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(completion),
		},
	)
	if (!completeResponse.ok) {
		throw new ApiError(
			'Commit was created but session metadata could not be updated',
			completeResponse.status,
		)
	}
	const registryResponse = await registryStub(env).fetch(
		`https://registry/sessions/${sessionId}/published`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(completion),
		},
	)
	if (!registryResponse.ok) {
		throw new ApiError(
			'Commit was created but session list could not be updated',
			registryResponse.status,
		)
	}

	return Response.json({
		pullRequestUrl: pullRequest.html_url,
		pullRequestNumber: pullRequest.number,
		branch,
		commitSha: commit.sha,
		alreadyPublished: isFollowUp,
		createdPullRequest: !isFollowUp,
	})
}

async function updateSessionSettings(
	request: Request,
	env: AppEnv,
	sessionId: string,
	state: SessionState,
	user: GitHubUser,
): Promise<Response> {
	if (request.method !== 'PATCH') throw new ApiError('Method not allowed', 405)
	if (state.meta.createdBy.id !== user.id) {
		throw new ApiError('Only the session creator can change sharing settings', 403)
	}
	const payload = await readJsonBody<{
		accessPolicy?: unknown
		retentionDays?: unknown
	}>(request, MAX_JSON_BODY_BYTES)
	const accessPolicy =
		payload.accessPolicy === 'write'
			? 'write'
			: payload.accessPolicy === 'link'
				? 'link'
				: null
	if (!accessPolicy) throw new ApiError('Invalid access policy', 400)
	const retentionDays = requireRetentionDays(payload.retentionDays)
	const expiresAt = new Date(
		Date.parse(state.meta.createdAt) + retentionDays * DAY_MS,
	).toISOString()
	const response = await sessionStub(env, sessionId).fetch(
		'https://session/settings',
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accessPolicy, retentionDays, expiresAt }),
		},
	)
	if (!response.ok) {
		throw new ApiError('Could not update session settings', response.status)
	}
	await registryStub(env).fetch(
		`https://registry/sessions/${sessionId}/settings`,
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accessPolicy, expiresAt }),
		},
	)
	const result = (await response.json()) as { meta: SessionMeta }
	return Response.json({ meta: result.meta })
}

async function deleteSessionAssets(
	env: AppEnv,
	sessionId: string,
): Promise<void> {
	const prefix = `sessions/${sessionId}/`
	let cursor: string | undefined
	do {
		const page = await env.ASSET_BUCKET.list({ prefix, cursor })
		const keys = page.objects.map((object) => object.key)
		if (keys.length) await env.ASSET_BUCKET.delete(keys)
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
}

async function cleanupSession(
	env: AppEnv,
	sessionId: string,
	reason: string,
): Promise<void> {
	await deleteSessionAssets(env, sessionId)
	const deleteResponse = await sessionStub(env, sessionId).fetch(
		'https://session/delete',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason }),
		},
	)
	if (
		!deleteResponse.ok &&
		deleteResponse.status !== 404 &&
		deleteResponse.status !== 410
	) {
		throw new ApiError('Could not delete editing session', deleteResponse.status)
	}
	const registryResponse = await registryStub(env).fetch(
		`https://registry/sessions/${sessionId}/delete`,
		{ method: 'DELETE' },
	)
	if (!registryResponse.ok) {
		throw new ApiError('Could not remove session from registry', registryResponse.status)
	}
}

function hexBytes(value: string): Uint8Array | null {
	if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null
	const bytes = new Uint8Array(value.length / 2)
	for (let index = 0; index < value.length; index += 2) {
		bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
	}
	return bytes
}

async function verifyWebhookSignature(
	secret: string,
	signatureHeader: string | null,
	body: Uint8Array,
): Promise<boolean> {
	if (!signatureHeader?.startsWith('sha256=')) return false
	const actual = hexBytes(signatureHeader.slice('sha256='.length))
	if (!actual) return false
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const expected = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, body),
	)
	if (actual.length !== expected.length) return false
	let difference = 0
	for (let index = 0; index < expected.length; index += 1) {
		difference |= actual[index] ^ expected[index]
	}
	return difference === 0
}

async function handleGitHubWebhook(
	request: Request,
	env: AppEnv,
): Promise<Response> {
	if (request.method !== 'POST') throw new ApiError('Method not allowed', 405)
	if (!env.GITHUB_WEBHOOK_SECRET) {
		throw new ApiError('GitHub webhook secret is not configured', 503)
	}
	const body = await readRequestBody(request, MAX_WEBHOOK_BODY_BYTES)
	if (
		!(await verifyWebhookSignature(
			env.GITHUB_WEBHOOK_SECRET,
			request.headers.get('X-Hub-Signature-256'),
			body,
		))
	) {
		throw new ApiError('Invalid GitHub webhook signature', 401)
	}
	if (request.headers.get('X-GitHub-Event') !== 'pull_request') {
		return Response.json({ ok: true, ignored: true })
	}
	let payload: {
		action?: string
		pull_request?: {
			number?: number
			merged?: boolean
		}
		repository?: {
			full_name?: string
		}
	}
	try {
		payload = JSON.parse(new TextDecoder().decode(body)) as typeof payload
	} catch {
		throw new ApiError('Invalid GitHub webhook JSON', 400)
	}
	if (
		payload.action !== 'closed' ||
		payload.pull_request?.merged !== true ||
		!Number.isSafeInteger(payload.pull_request.number) ||
		!payload.repository?.full_name
	) {
		return Response.json({ ok: true, ignored: true })
	}
	const findResponse = await registryStub(env).fetch(
		`https://registry/find-by-pr?repository=${encodeURIComponent(payload.repository.full_name)}&number=${payload.pull_request.number}`,
	)
	if (findResponse.status === 404) {
		return Response.json({ ok: true, sessionDeleted: false })
	}
	if (!findResponse.ok) {
		throw new ApiError('Could not locate merged session', findResponse.status)
	}
	const result = (await findResponse.json()) as {
		session: SessionRegistryEntry
	}
	await cleanupSession(
		env,
		result.session.id,
		'Pull Request merged',
	)
	return Response.json({
		ok: true,
		sessionDeleted: true,
		sessionId: result.session.id,
	})
}

async function handleSessionRoute(
	request: Request,
	env: AppEnv,
	pathname: string,
): Promise<Response> {
	const match = pathname.match(
		/^\/api\/sessions\/([0-9a-f-]+)(?:\/(connect|assets|asset-directory|publish|settings))?(?:\/([0-9a-f-]+))?$/,
	)
	if (!match || !validSessionId(match[1])) throw new ApiError('Session not found', 404)
	const [, sessionId, action, resourceId] = match
	const state = await fetchSessionState(env, sessionId)
	const access = await ensureSessionAccess(request, state)
	const { user } = access

	if (!action && request.method === 'DELETE') {
		if (
			state.meta.createdBy.id === null ||
			state.meta.createdBy.id !== user.id
		) {
			throw new ApiError('Only the session creator can delete this session', 403)
		}
		await cleanupSession(env, sessionId, 'Deleted by session creator')
		return Response.json({ ok: true })
	}

	if (!action && request.method === 'GET') {
		return Response.json({
			...state,
			assets: state.assets.map(({ r2Key: _r2Key, ...asset }) => asset),
		})
	}

	if (action === 'connect') {
		const url = new URL(request.url)
		const clientId = url.searchParams.get('clientId')
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			throw new ApiError('Expected a WebSocket upgrade', 426)
		}
		const headers = new Headers({
			Upgrade: 'websocket',
			'X-User-Id': String(user.id),
			'X-User-Login': user.login,
			'X-User-Name': cleanText(user.name, user.login, 100),
			'X-User-Avatar': user.avatar_url,
			'X-User-Can-Write': String(access.canWrite),
		})
		if (access.commitEmail) headers.set('X-User-Email', access.commitEmail)
		return sessionStub(env, sessionId).fetch(
			new Request(`https://session/connect?clientId=${encodeURIComponent(clientId ?? '')}`, {
				headers,
			}),
		)
	}

	if (action === 'assets' && resourceId && request.method === 'GET') {
		return serveAsset(env, resourceId, state)
	}

	if (action === 'assets' && resourceId && request.method === 'DELETE') {
		return removeAsset(env, sessionId, resourceId)
	}

	if (action === 'assets' && resourceId && request.method === 'PATCH') {
		return renameAsset(request, env, sessionId, resourceId, state)
	}

	if (action === 'assets') {
		return uploadAsset(request, env, sessionId, state, user)
	}

	if (action === 'asset-directory') {
		return updateAssetDirectory(request, env, sessionId, state)
	}

	if (action === 'publish') {
		return publishSession(request, env, sessionId)
	}

	if (action === 'settings') {
		return updateSessionSettings(request, env, sessionId, state, user)
	}

	throw new ApiError('Not found', 404)
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			const url = new URL(request.url)
			const pathname = url.pathname

			if (pathname.startsWith('/api/auth/')) {
				return await handleAuth(request, env, pathname)
			}
			if (pathname === '/api/github/webhook') {
				return await handleGitHubWebhook(request, env)
			}
			if (pathname.startsWith('/api/github/')) {
				return await handleGitHubApi(request, pathname)
			}
			if (pathname === '/api/sessions') {
				return await handleSessionsCollection(request, env)
			}
			if (pathname.startsWith('/api/sessions/')) {
				return await handleSessionRoute(request, env, pathname)
			}
			if (pathname === '/api/health') {
				return Response.json({
					ok: true,
					githubConfigured: isGitHubConfigured(env),
					automaticArchiveConfigured: isAutomaticArchiveConfigured(env),
					webhookConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
				})
			}
			if (pathname.startsWith('/api/')) {
				return jsonError('Not found', 404)
			}
			return new Response(null, { status: 404 })
		} catch (error) {
			if (error instanceof ApiError) {
				return jsonError(error.message, error.status, error.details)
			}
			console.error(error)
			return jsonError('Internal server error', 500)
		}
	},
} satisfies ExportedHandler<AppEnv>
