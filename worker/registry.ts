import { DurableObject } from 'cloudflare:workers'
import type {
	AppEnv,
	SessionAccessPolicy,
	SessionRegistryEntry,
} from './types.js'

type RegistryRow = {
	id: string
	owner_id: number
	owner_login: string
	repository: string
	base_branch: string
	document_path: string
	created_at: string
	expires_at: string
	status: 'editing' | 'published'
	access_policy: SessionAccessPolicy
	pull_request_url: string | null
	pull_request_number: number | null
	pull_request_branch: string | null
	last_published_commit_sha: string | null
	target_key: string | null
}

type Reservation = SessionRegistryEntry & {
	targetKey: string
}

function entryFromRow(row: RegistryRow): SessionRegistryEntry {
	return {
		id: row.id,
		ownerId: row.owner_id,
		ownerLogin: row.owner_login,
		repository: row.repository,
		baseBranch: row.base_branch,
		documentPath: row.document_path,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		status: row.status,
		accessPolicy: row.access_policy,
		pullRequestUrl: row.pull_request_url,
		pullRequestNumber: row.pull_request_number,
		pullRequestBranch: row.pull_request_branch,
		lastPublishedCommitSha: row.last_published_commit_sha,
	}
}

export class SessionRegistry extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env)
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				owner_id INTEGER NOT NULL,
				owner_login TEXT NOT NULL,
				repository TEXT NOT NULL,
				base_branch TEXT NOT NULL,
				document_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				status TEXT NOT NULL,
				access_policy TEXT NOT NULL,
				pull_request_url TEXT,
				pull_request_number INTEGER,
				pull_request_branch TEXT,
				last_published_commit_sha TEXT,
				target_key TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_target
				ON sessions(owner_id, target_key)
				WHERE target_key IS NOT NULL;
			CREATE INDEX IF NOT EXISTS sessions_owner
				ON sessions(owner_id, created_at DESC);
		`)
		const columns = [
			...ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(sessions)'),
		]
		if (!columns.some((column) => column.name === 'pull_request_number')) {
			ctx.storage.sql.exec(
				'ALTER TABLE sessions ADD COLUMN pull_request_number INTEGER',
			)
		}
		if (!columns.some((column) => column.name === 'pull_request_branch')) {
			ctx.storage.sql.exec(
				'ALTER TABLE sessions ADD COLUMN pull_request_branch TEXT',
			)
		}
		if (!columns.some((column) => column.name === 'last_published_commit_sha')) {
			ctx.storage.sql.exec(
				'ALTER TABLE sessions ADD COLUMN last_published_commit_sha TEXT',
			)
		}
		ctx.storage.sql.exec(
			`UPDATE OR IGNORE sessions
			 SET target_key =
			   lower(repository) || char(10) || base_branch || char(10) || document_path
			 WHERE target_key IS NULL`,
		)
		for (const row of ctx.storage.sql.exec<{
			id: string
			pull_request_url: string
		}>(
			`SELECT id, pull_request_url
			 FROM sessions
			 WHERE pull_request_number IS NULL
			   AND pull_request_url IS NOT NULL`,
		)) {
			const match = row.pull_request_url.match(/\/pull\/(\d+)\/?$/)
			if (!match) continue
			ctx.storage.sql.exec(
				`UPDATE sessions SET pull_request_number = ? WHERE id = ?`,
				Number(match[1]),
				row.id,
			)
		}
	}

	private json(value: unknown, status = 200): Response {
		return Response.json(value, { status })
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/reserve' && request.method === 'POST') {
			const payload = (await request.json()) as Reservation
			const existing = [
				...this.ctx.storage.sql.exec<RegistryRow>(
					`SELECT * FROM sessions
					 WHERE owner_id = ? AND target_key = ?
					 LIMIT 1`,
					payload.ownerId,
					payload.targetKey,
				),
			][0]
			if (existing) {
				return this.json({ created: false, session: entryFromRow(existing) })
			}

			this.ctx.storage.sql.exec(
				`INSERT INTO sessions
				 (id, owner_id, owner_login, repository, base_branch, document_path,
				  created_at, expires_at, status, access_policy, pull_request_url,
				  pull_request_number, pull_request_branch,
				  last_published_commit_sha, target_key)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				payload.id,
				payload.ownerId,
				payload.ownerLogin,
				payload.repository,
				payload.baseBranch,
				payload.documentPath,
				payload.createdAt,
				payload.expiresAt,
				payload.status,
				payload.accessPolicy,
				payload.pullRequestUrl,
				payload.pullRequestNumber,
				payload.pullRequestBranch,
				payload.lastPublishedCommitSha,
				payload.targetKey,
			)
			return this.json({ created: true, session: payload }, 201)
		}

		if (url.pathname === '/list' && request.method === 'GET') {
			const ownerId = Number(url.searchParams.get('ownerId'))
			if (!Number.isSafeInteger(ownerId)) {
				return this.json({ error: 'Invalid owner ID' }, 400)
			}
			const sessions = [
				...this.ctx.storage.sql.exec<RegistryRow>(
					`SELECT * FROM sessions
					 WHERE owner_id = ?
					 ORDER BY created_at DESC`,
					ownerId,
				),
			].map(entryFromRow)
			return this.json({ sessions })
		}

		if (url.pathname === '/find-by-pr' && request.method === 'GET') {
			const repository = url.searchParams.get('repository')
			const pullRequestNumber = Number(url.searchParams.get('number'))
			if (
				!repository ||
				!Number.isSafeInteger(pullRequestNumber) ||
				pullRequestNumber <= 0
			) {
				return this.json({ error: 'Invalid pull request target' }, 400)
			}
			const session = [
				...this.ctx.storage.sql.exec<RegistryRow>(
					`SELECT * FROM sessions
					 WHERE lower(repository) = lower(?)
					   AND pull_request_number = ?
					 LIMIT 1`,
					repository,
					pullRequestNumber,
				),
			][0]
			return session
				? this.json({ session: entryFromRow(session) })
				: this.json({ error: 'Session not found' }, 404)
		}

		const sessionMatch = url.pathname.match(
			/^\/sessions\/([0-9a-f-]+)\/(settings|published|delete|release)$/i,
		)
		if (!sessionMatch) return this.json({ error: 'Not found' }, 404)
		const [, sessionId, action] = sessionMatch

		if (action === 'settings' && request.method === 'PATCH') {
			const payload = (await request.json()) as {
				accessPolicy: SessionAccessPolicy
				expiresAt: string
			}
			this.ctx.storage.sql.exec(
				`UPDATE sessions
				 SET access_policy = ?, expires_at = ?
				 WHERE id = ?`,
				payload.accessPolicy,
				payload.expiresAt,
				sessionId,
			)
			return this.json({ ok: true })
		}

		if (action === 'published' && request.method === 'POST') {
			const payload = (await request.json()) as {
				pullRequestUrl: string
				pullRequestNumber: number
				pullRequestBranch: string
				lastPublishedCommitSha: string
			}
			this.ctx.storage.sql.exec(
				`UPDATE sessions
				 SET status = 'published',
				     pull_request_url = ?,
				     pull_request_number = ?,
				     pull_request_branch = ?,
				     last_published_commit_sha = ?
				 WHERE id = ?`,
				payload.pullRequestUrl,
				payload.pullRequestNumber,
				payload.pullRequestBranch,
				payload.lastPublishedCommitSha,
				sessionId,
			)
			return this.json({ ok: true })
		}

		if (
			(action === 'delete' || action === 'release') &&
			request.method === 'DELETE'
		) {
			this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId)
			return this.json({ ok: true })
		}

		return this.json({ error: 'Not found' }, 404)
	}
}
