import type { AppEnv, GitHubUser } from './types.js'
import { ApiError, readJsonBody } from './http.js'
import { MAX_JSON_BODY_BYTES } from '../shared/limits.js'

const GITHUB_API_VERSION = '2026-03-10'
const COMMIT_EMAIL_MAX_AGE = 60 * 60 * 24 * 365

type GitHubEmail = {
	email: string
	primary: boolean
	verified: boolean
	visibility: 'public' | 'private' | null
}

export type CommitEmailOption = GitHubEmail & {
	kind: 'github' | 'noreply'
	recommended: boolean
}

export async function githubRequest<T>(
	token: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const headers = new Headers(init.headers)
	headers.set('Accept', 'application/vnd.github+json')
	headers.set('Authorization', `Bearer ${token}`)
	headers.set('User-Agent', 'GitHub-Live-MD')
	headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION)
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}

	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers,
	})

	if (!response.ok) {
		const responseBody = await response.text()
		let details: unknown = responseBody
		try {
			details = JSON.parse(responseBody)
		} catch {
			// Keep the original text when GitHub or an intermediary returned non-JSON.
		}
		const message =
			typeof details === 'object' &&
			details !== null &&
			'message' in details &&
			typeof details.message === 'string'
				? details.message
				: `GitHub API request failed (${response.status})`
		throw new ApiError(message, response.status, details)
	}

	if (response.status === 204) {
		return undefined as T
	}
	return (await response.json()) as T
}

export function parseCookies(request: Request): Map<string, string> {
	const cookies = new Map<string, string>()
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const index = part.indexOf('=')
		if (index === -1) continue
		const key = part.slice(0, index).trim()
		const value = part.slice(index + 1).trim()
		if (key) cookies.set(key, decodeURIComponent(value))
	}
	return cookies
}

export function getGitHubToken(request: Request): string | null {
	return parseCookies(request).get('github_token') ?? null
}

export function getCommitEmailSelection(
	request: Request,
	user: Pick<GitHubUser, 'id'>,
): string | null {
	const raw = parseCookies(request).get('commit_email')
	if (!raw) return null
	try {
		const selection = JSON.parse(raw) as { userId?: unknown; email?: unknown }
		return selection.userId === user.id && typeof selection.email === 'string'
			? selection.email
			: null
	} catch {
		return null
	}
}

export async function getGitHubUser(request: Request): Promise<GitHubUser | null> {
	const token = getGitHubToken(request)
	if (!token) return null
	try {
		return await githubRequest<GitHubUser>(token, '/user')
	} catch (error) {
		console.error(
			'GitHub user lookup failed',
			error instanceof ApiError
				? { status: error.status, message: error.message }
				: error,
		)
		return null
	}
}

function cookieSecurity(requestUrl: string): string {
	return new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''
}

export function authCookie(requestUrl: string, token: string, maxAge: number): string {
	return `github_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(requestUrl)}`
}

export function stateCookie(requestUrl: string, state: string, maxAge: number): string {
	return `oauth_state=${encodeURIComponent(state)}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(requestUrl)}`
}

function oauthReturnCookie(
	requestUrl: string,
	returnTo: string,
	maxAge: number,
): string {
	return `oauth_return_to=${encodeURIComponent(returnTo)}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(requestUrl)}`
}

function safeReturnTo(value: string | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
		return '/'
	}
	try {
		const parsed = new URL(value, 'https://github-live-md.invalid')
		if (
			parsed.origin !== 'https://github-live-md.invalid' ||
			parsed.pathname.startsWith('/api/')
		) {
			return '/'
		}
		return `${parsed.pathname}${parsed.search}`
	} catch {
		return '/'
	}
}

export function commitEmailCookie(
	requestUrl: string,
	userId: number,
	email: string,
	maxAge = COMMIT_EMAIL_MAX_AGE,
): string {
	const value = JSON.stringify({ userId, email })
	return `commit_email=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity(requestUrl)}`
}

function clearCommitEmailCookie(requestUrl: string): string {
	return `commit_email=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(requestUrl)}`
}

export function isGitHubConfigured(env: AppEnv): boolean {
	return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
}

export async function listCommitEmailOptions(
	token: string,
	user: Pick<GitHubUser, 'id' | 'login'>,
): Promise<CommitEmailOption[]> {
	let emails: GitHubEmail[]
	try {
		emails = await githubRequest<GitHubEmail[]>(token, '/user/emails?per_page=100')
	} catch (error) {
		if (error instanceof ApiError && error.status === 403) {
			throw new ApiError(
				'GitHub Appの「Email addresses」User permissionをReadにして、再ログインしてください',
				403,
				error.details,
			)
		}
		throw error
	}

	const noReplyEmail = githubNoReplyEmail(user)
	const options = new Map<string, CommitEmailOption>()
	for (const email of emails) {
		if (!email.verified) continue
		const isNoReply = email.email
			.toLowerCase()
			.endsWith('@users.noreply.github.com')
		options.set(email.email.toLowerCase(), {
			...email,
			kind: isNoReply ? 'noreply' : 'github',
			recommended: isNoReply,
		})
	}
	if (![...options.values()].some((option) => option.kind === 'noreply')) {
		options.set(noReplyEmail.toLowerCase(), {
			email: noReplyEmail,
			primary: false,
			verified: true,
			visibility: 'private',
			kind: 'noreply',
			recommended: true,
		})
	}

	return [...options.values()].sort((left, right) => {
		if (left.recommended !== right.recommended) return left.recommended ? -1 : 1
		if (left.primary !== right.primary) return left.primary ? -1 : 1
		return left.email.localeCompare(right.email)
	})
}

export async function resolveCommitEmail(
	request: Request,
	token: string,
	user: Pick<GitHubUser, 'id' | 'login'>,
	required = true,
): Promise<string | null> {
	const selected = getCommitEmailSelection(request, user)
	if (!selected) {
		if (required) throw new ApiError('コミット用メールアドレスを選択してください', 428)
		return null
	}
	const options = await listCommitEmailOptions(token, user)
	const match = options.find(
		(option) => option.email.toLowerCase() === selected.toLowerCase(),
	)
	if (!match) {
		throw new ApiError(
			'選択中のメールアドレスをGitHubで確認できません。もう一度選択してください',
			409,
		)
	}
	return match.email
}

export async function handleAuth(request: Request, env: AppEnv, pathname: string): Promise<Response> {
	const url = new URL(request.url)

	if (pathname === '/api/auth/status') {
		const user = await getGitHubUser(request)
		return Response.json({
			configured: isGitHubConfigured(env),
			user,
			appSlug: env.GITHUB_APP_SLUG ?? null,
			commitEmail: user ? getCommitEmailSelection(request, user) : null,
		})
	}

	if (pathname === '/api/auth/emails' && request.method === 'GET') {
		const token = getGitHubToken(request)
		if (!token) throw new ApiError('GitHub login required', 401)
		const user = await getGitHubUser(request)
		if (!user) throw new ApiError('GitHub session expired', 401)
		return Response.json({
			emails: await listCommitEmailOptions(token, user),
			selected: getCommitEmailSelection(request, user),
		})
	}

	if (pathname === '/api/auth/email' && request.method === 'POST') {
		const token = getGitHubToken(request)
		if (!token) throw new ApiError('GitHub login required', 401)
		const user = await getGitHubUser(request)
		if (!user) throw new ApiError('GitHub session expired', 401)
		const payload = await readJsonBody<{ email?: unknown }>(
			request,
			MAX_JSON_BODY_BYTES,
		)
		if (typeof payload.email !== 'string') {
			throw new ApiError('メールアドレスを選択してください', 400)
		}
		const requestedEmail = payload.email
		const options = await listCommitEmailOptions(token, user)
		const selected = options.find(
			(option) => option.email.toLowerCase() === requestedEmail.toLowerCase(),
		)
		if (!selected) {
			throw new ApiError('GitHubで検証済みのメールアドレスを選択してください', 400)
		}
		return Response.json(
			{ selected: selected.email },
			{
				headers: {
					'Set-Cookie': commitEmailCookie(request.url, user.id, selected.email),
				},
			},
		)
	}

	if (pathname === '/api/auth/github/start') {
		if (!isGitHubConfigured(env)) {
			throw new ApiError('GitHub App is not configured', 503)
		}
		const state = crypto.randomUUID()
		const returnTo = safeReturnTo(url.searchParams.get('return_to'))
		const authorize = new URL('https://github.com/login/oauth/authorize')
		authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID!)
		authorize.searchParams.set('redirect_uri', `${url.origin}/api/auth/github/callback`)
		authorize.searchParams.set('state', state)
		const headers = new Headers({ Location: authorize.toString() })
		headers.append('Set-Cookie', stateCookie(request.url, state, 600))
		headers.append('Set-Cookie', oauthReturnCookie(request.url, returnTo, 600))
		return new Response(null, { status: 302, headers })
	}

	if (pathname === '/api/auth/github/callback') {
		if (!isGitHubConfigured(env)) {
			throw new ApiError('GitHub App is not configured', 503)
		}
		const code = url.searchParams.get('code')
		const state = url.searchParams.get('state')
		const expectedState = parseCookies(request).get('oauth_state')
		if (!code || !state || !expectedState || state !== expectedState) {
			throw new ApiError('Invalid OAuth state', 400)
		}

		const response = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${url.origin}/api/auth/github/callback`,
			}),
		})
		const payload = (await response.json()) as {
			access_token?: string
			expires_in?: number
			error?: string
			error_description?: string
		}
		if (!response.ok || !payload.access_token) {
			throw new ApiError(
				payload.error_description ?? payload.error ?? 'GitHub OAuth failed',
				400,
				payload,
			)
		}

		const returnTo = safeReturnTo(parseCookies(request).get('oauth_return_to') ?? null)
		const headers = new Headers({ Location: returnTo })
		headers.append(
			'Set-Cookie',
			authCookie(
				request.url,
				payload.access_token,
				Math.min(payload.expires_in ?? 28_800, 28_800),
			),
		)
		headers.append('Set-Cookie', stateCookie(request.url, '', 0))
		headers.append('Set-Cookie', oauthReturnCookie(request.url, '', 0))
		return new Response(null, { status: 302, headers })
	}

	if (pathname === '/api/auth/logout' && request.method === 'POST') {
		const headers = new Headers()
		headers.append('Set-Cookie', authCookie(request.url, '', 0))
		headers.append('Set-Cookie', clearCommitEmailCookie(request.url))
		return Response.json(
			{ ok: true },
			{ headers },
		)
	}

	throw new ApiError('Not found', 404)
}

export function encodeGitHubPath(path: string): string {
	return path
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/')
}

export function decodeBase64Utf8(value: string): string {
	const normalized = value.replace(/\s/g, '')
	const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0))
	return new TextDecoder().decode(bytes)
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	const chunkSize = 0x8000
	let binary = ''
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
	}
	return btoa(binary)
}

export function githubNoReplyEmail(user: Pick<GitHubUser, 'id' | 'login'>): string {
	return `${user.id}+${user.login}@users.noreply.github.com`
}
