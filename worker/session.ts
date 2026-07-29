import { DurableObject } from 'cloudflare:workers'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { archiveExpiredSession } from './archive.js'
import type {
	AppEnv,
	PendingAsset,
	SessionAccessPolicy,
	SessionExport,
	SessionMeta,
	SessionParticipant,
	SessionRetentionDays,
} from './types.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 2
const MESSAGE_REMOVE_AWARENESS = 3
const DAY_MS = 24 * 60 * 60 * 1_000
const RETENTION_DAYS = new Set<SessionRetentionDays>([7, 14, 21, 28])

function defaultAssetDirectory(documentPath: string): string {
	const separator = documentPath.lastIndexOf('/')
	return separator === -1
		? 'images'
		: `${documentPath.slice(0, separator)}/images`
}

type ConnectionAttachment = {
	clientId: number
	login: string
	canWrite: boolean
}

type SqlMetaRow = { value: string }
type SqlParticipantRow = {
	github_id: number | null
	login: string
	display_name: string
	avatar_url: string | null
	commit_email: string | null
	last_seen_at: string
}
type SqlAssetRow = {
	id: string
	final_path: string
	markdown_path: string
	r2_key: string
	mime_type: string
	size: number
	original_name: string
	uploaded_by: string
	created_at: string
}

export class EditingSession extends DurableObject<AppEnv> {
	private readonly doc = new Y.Doc()
	private readonly text = this.doc.getText('markdown')
	private deleted = false

	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
			const rows = [...this.ctx.storage.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM snapshot WHERE id = 1')]
			if (rows[0]?.data) {
				Y.applyUpdate(this.doc, new Uint8Array(rows[0].data), 'restore')
			}
			this.doc.on('update', (update: Uint8Array) => {
				this.persistSnapshot()
				const encoder = encoding.createEncoder()
				encoding.writeVarUint(encoder, MESSAGE_SYNC)
				syncProtocol.writeUpdate(encoder, update)
				this.broadcast(encoding.toUint8Array(encoder))
			})
			const meta = this.getMeta()
			if (meta && (await this.ctx.storage.getAlarm()) === null) {
				await this.ctx.storage.setAlarm(Date.parse(meta.expiresAt))
			}
		})
	}

	private initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS snapshot (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				data BLOB NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS participants (
				login TEXT PRIMARY KEY,
				github_id INTEGER,
				display_name TEXT NOT NULL,
				avatar_url TEXT,
				commit_email TEXT,
				last_seen_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS assets (
				id TEXT PRIMARY KEY,
				final_path TEXT NOT NULL UNIQUE,
				markdown_path TEXT NOT NULL,
				r2_key TEXT NOT NULL UNIQUE,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				original_name TEXT NOT NULL,
				uploaded_by TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`)
		const participantColumns = [
			...this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(participants)'),
		]
		if (!participantColumns.some((column) => column.name === 'commit_email')) {
			this.ctx.storage.sql.exec(
				'ALTER TABLE participants ADD COLUMN commit_email TEXT',
			)
		}
	}

	private persistSnapshot(): void {
		const snapshot = Y.encodeStateAsUpdate(this.doc)
		this.ctx.storage.sql.exec(
			`INSERT INTO snapshot (id, data, updated_at)
			 VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
			snapshot,
			new Date().toISOString(),
		)
	}

	private getMeta(): SessionMeta | null {
		const rows = [
			...this.ctx.storage.sql.exec<SqlMetaRow>(
				"SELECT value FROM metadata WHERE key = 'session' LIMIT 1",
			),
		]
		if (!rows[0]) return null
		const raw = JSON.parse(rows[0].value) as Partial<SessionMeta> &
			Pick<
				SessionMeta,
				| 'id'
				| 'demo'
				| 'repository'
				| 'baseBranch'
				| 'documentPath'
				| 'baseCommitSha'
				| 'baseBlobSha'
				| 'createdAt'
				| 'createdBy'
				| 'status'
				| 'pullRequestUrl'
			>
		const retentionDays = RETENTION_DAYS.has(
			raw.retentionDays as SessionRetentionDays,
		)
			? (raw.retentionDays as SessionRetentionDays)
			: 14
		const createdAt = Date.parse(raw.createdAt)
		return {
			...raw,
			accessPolicy: raw.accessPolicy === 'write' ? 'write' : 'link',
			retentionDays,
			pullRequestNumber:
				typeof raw.pullRequestNumber === 'number'
					? raw.pullRequestNumber
					: null,
			pullRequestBranch:
				typeof raw.pullRequestBranch === 'string'
					? raw.pullRequestBranch
					: null,
			lastPublishedCommitSha:
				typeof raw.lastPublishedCommitSha === 'string'
					? raw.lastPublishedCommitSha
					: null,
			publishedAssetPaths: Array.isArray(raw.publishedAssetPaths)
				? raw.publishedAssetPaths.filter(
						(path): path is string => typeof path === 'string',
					)
				: [],
			assetDirectory:
				typeof raw.assetDirectory === 'string' && raw.assetDirectory
					? raw.assetDirectory
					: defaultAssetDirectory(raw.documentPath),
			expiresAt:
				typeof raw.expiresAt === 'string' &&
				Number.isFinite(Date.parse(raw.expiresAt))
					? raw.expiresAt
					: new Date(createdAt + retentionDays * DAY_MS).toISOString(),
		}
	}

	private setMeta(meta: SessionMeta): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO metadata (key, value) VALUES ('session', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			JSON.stringify(meta),
		)
	}

	private upsertParticipant(participant: SessionParticipant): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO participants
			 (login, github_id, display_name, avatar_url, commit_email, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(login) DO UPDATE SET
			   github_id = excluded.github_id,
			   display_name = excluded.display_name,
			   avatar_url = excluded.avatar_url,
			   commit_email = COALESCE(excluded.commit_email, participants.commit_email),
			   last_seen_at = excluded.last_seen_at`,
			participant.login,
			participant.id,
			participant.name,
			participant.avatarUrl,
			participant.commitEmail,
			participant.lastSeenAt,
		)
	}

	private getParticipants(): SessionParticipant[] {
		return [
			...this.ctx.storage.sql.exec<SqlParticipantRow>(
				`SELECT github_id, login, display_name, avatar_url, commit_email, last_seen_at
				 FROM participants ORDER BY last_seen_at ASC`,
			),
		].map((row) => ({
			id: row.github_id,
			login: row.login,
			name: row.display_name,
			avatarUrl: row.avatar_url,
			commitEmail: row.commit_email,
			lastSeenAt: row.last_seen_at,
		}))
	}

	private getAssets(): PendingAsset[] {
		return [
			...this.ctx.storage.sql.exec<SqlAssetRow>(
				`SELECT id, final_path, markdown_path, r2_key, mime_type, size,
				        original_name, uploaded_by, created_at
				 FROM assets ORDER BY created_at ASC`,
			),
		].map((row) => ({
			id: row.id,
			finalPath: row.final_path,
			markdownPath: row.markdown_path,
			r2Key: row.r2_key,
			mimeType: row.mime_type,
			size: row.size,
			originalName: row.original_name,
			uploadedBy: row.uploaded_by,
			createdAt: row.created_at,
		}))
	}

	private broadcast(message: string | ArrayBuffer | Uint8Array, except?: WebSocket): void {
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === except || socket.readyState !== WebSocket.OPEN) continue
			try {
				socket.send(message)
			} catch {
				// A stale socket will be removed by the runtime.
			}
		}
	}

	private json(value: unknown, status = 200): Response {
		return Response.json(value, { status })
	}

	async fetch(request: Request): Promise<Response> {
		if (this.deleted) return this.json({ error: 'Session expired' }, 410)
		const url = new URL(request.url)

		if (url.pathname === '/init' && request.method === 'POST') {
			if (this.getMeta()) return this.json({ error: 'Session already exists' }, 409)
			const payload = (await request.json()) as {
				meta: SessionMeta
				markdown: string
				participant: SessionParticipant
			}
			this.setMeta(payload.meta)
			this.upsertParticipant(payload.participant)
			if (payload.markdown) this.text.insert(0, payload.markdown)
			this.persistSnapshot()
			await this.ctx.storage.setAlarm(Date.parse(payload.meta.expiresAt))
			return this.json({ ok: true }, 201)
		}

		const meta = this.getMeta()
		if (!meta) return this.json({ error: 'Session not found' }, 404)

		if (url.pathname === '/delete' && request.method === 'POST') {
			const payload = (await request.json().catch(() => ({}))) as {
				reason?: string
			}
			await this.clearSession(
				typeof payload.reason === 'string'
					? payload.reason
					: 'Session deleted',
			)
			return this.json({ ok: true })
		}

		if (url.pathname === '/meta' && request.method === 'GET') {
			return this.json({
				meta,
				participants: this.getParticipants().map(
					({ commitEmail: _commitEmail, ...participant }) => participant,
				),
				assets: this.getAssets(),
			})
		}

		if (url.pathname === '/export' && request.method === 'GET') {
			const result: SessionExport = {
				meta,
				markdown: this.text.toString(),
				participants: this.getParticipants(),
				assets: this.getAssets(),
			}
			return this.json(result)
		}

		if (url.pathname === '/assets' && request.method === 'POST') {
			const asset = (await request.json()) as PendingAsset
			this.ctx.storage.sql.exec(
				`INSERT INTO assets
				 (id, final_path, markdown_path, r2_key, mime_type, size,
				  original_name, uploaded_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				asset.id,
				asset.finalPath,
				asset.markdownPath,
				asset.r2Key,
				asset.mimeType,
				asset.size,
				asset.originalName,
				asset.uploadedBy,
				asset.createdAt,
			)
			const { r2Key: _r2Key, ...publicAsset } = asset
			this.broadcast(JSON.stringify({ type: 'asset', asset: publicAsset }))
			return this.json(publicAsset, 201)
		}

		if (url.pathname === '/asset-directory' && request.method === 'PATCH') {
			const payload = (await request.json()) as {
				assetDirectory?: unknown
			}
			if (
				typeof payload.assetDirectory !== 'string' ||
				!payload.assetDirectory
			) {
				return this.json({ error: 'Invalid image directory' }, 400)
			}
			meta.assetDirectory = payload.assetDirectory
			this.setMeta(meta)
			this.broadcast(JSON.stringify({ type: 'settings', meta }))
			return this.json({ meta })
		}

		const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f-]+)$/i)
		if (assetMatch && request.method === 'PATCH') {
			const asset = this.getAssets().find((item) => item.id === assetMatch[1])
			if (!asset) return this.json({ error: 'Image not found' }, 404)
			const payload = (await request.json()) as {
				finalPath?: unknown
				markdownPath?: unknown
			}
			if (
				typeof payload.finalPath !== 'string' ||
				!payload.finalPath ||
				typeof payload.markdownPath !== 'string' ||
				!payload.markdownPath
			) {
				return this.json({ error: 'Invalid image file name' }, 400)
			}
			const finalPath = payload.finalPath
			const markdownPath = payload.markdownPath
			const collision = this.getAssets().some(
				(item) =>
					item.id !== asset.id &&
					item.finalPath.toLowerCase() === finalPath.toLowerCase(),
			)
			if (collision) {
				return this.json(
					{ error: 'An image with that file name already exists' },
					409,
				)
			}

			this.ctx.storage.sql.exec(
				`UPDATE assets
				 SET final_path = ?, markdown_path = ?
				 WHERE id = ?`,
				finalPath,
				markdownPath,
				asset.id,
			)

			if (asset.markdownPath !== markdownPath) {
				const current = this.text.toString()
				const positions: number[] = []
				let position = current.indexOf(asset.markdownPath)
				while (position !== -1) {
					positions.push(position)
					position = current.indexOf(
						asset.markdownPath,
						position + asset.markdownPath.length,
					)
				}
				if (positions.length) {
					this.doc.transact(() => {
						for (const index of positions.reverse()) {
							this.text.delete(index, asset.markdownPath.length)
							this.text.insert(index, markdownPath)
						}
					}, 'asset-rename')
				}
			}

			const renamed = {
				...asset,
				finalPath,
				markdownPath,
			}
			const { r2Key: _r2Key, ...publicAsset } = renamed
			this.broadcast(JSON.stringify({ type: 'asset', asset: publicAsset }))
			return this.json(renamed)
		}

		if (assetMatch && request.method === 'DELETE') {
			const asset = this.getAssets().find((item) => item.id === assetMatch[1])
			if (!asset) return this.json({ error: 'Image not found' }, 404)
			this.ctx.storage.sql.exec('DELETE FROM assets WHERE id = ?', asset.id)
			this.broadcast(JSON.stringify({ type: 'asset-remove', assetId: asset.id }))
			return this.json(asset)
		}

		if (url.pathname === '/complete' && request.method === 'POST') {
			const payload = (await request.json()) as {
				pullRequestUrl: string
				pullRequestNumber: number
				pullRequestBranch: string
				lastPublishedCommitSha: string
				publishedAssetPaths: string[]
			}
			meta.status = 'published'
			meta.pullRequestUrl = payload.pullRequestUrl
			meta.pullRequestNumber = payload.pullRequestNumber
			meta.pullRequestBranch = payload.pullRequestBranch
			meta.lastPublishedCommitSha = payload.lastPublishedCommitSha
			meta.publishedAssetPaths = payload.publishedAssetPaths
			this.setMeta(meta)
			this.broadcast(JSON.stringify({ type: 'settings', meta }))
			return this.json({ ok: true, meta })
		}

		if (url.pathname === '/settings' && request.method === 'PATCH') {
			const payload = (await request.json()) as {
				accessPolicy?: SessionAccessPolicy
				retentionDays?: SessionRetentionDays
				expiresAt?: string
			}
			if (
				(payload.accessPolicy !== 'link' &&
					payload.accessPolicy !== 'write') ||
				!RETENTION_DAYS.has(payload.retentionDays as SessionRetentionDays) ||
				typeof payload.expiresAt !== 'string' ||
				!Number.isFinite(Date.parse(payload.expiresAt))
			) {
				return this.json({ error: 'Invalid session settings' }, 400)
			}
			meta.accessPolicy = payload.accessPolicy
			meta.retentionDays = payload.retentionDays as SessionRetentionDays
			meta.expiresAt = payload.expiresAt
			this.setMeta(meta)
			await this.ctx.storage.setAlarm(Date.parse(meta.expiresAt))
			this.broadcast(JSON.stringify({ type: 'settings', meta }))
			if (meta.accessPolicy === 'write') {
				for (const socket of this.ctx.getWebSockets()) {
					const attachment =
						socket.deserializeAttachment() as ConnectionAttachment | null
					if (attachment && !attachment.canWrite) {
						socket.close(4003, 'Repository write access required')
					}
				}
			}
			return this.json({ meta })
		}

		if (url.pathname === '/connect') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected a WebSocket upgrade', { status: 426 })
			}
			const clientId = Number(url.searchParams.get('clientId'))
			if (!Number.isSafeInteger(clientId) || clientId < 0) {
				return this.json({ error: 'Invalid client ID' }, 400)
			}
			const participant: SessionParticipant = {
				id: request.headers.get('X-User-Id')
					? Number(request.headers.get('X-User-Id'))
					: null,
				login: request.headers.get('X-User-Login') ?? `guest-${clientId}`,
				name:
					request.headers.get('X-User-Name') ??
					request.headers.get('X-User-Login') ??
					'Guest',
				avatarUrl: request.headers.get('X-User-Avatar'),
				commitEmail: request.headers.get('X-User-Email'),
				lastSeenAt: new Date().toISOString(),
			}
			this.upsertParticipant(participant)

			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			this.ctx.acceptWebSocket(server)
			server.serializeAttachment({
				clientId,
				login: participant.login,
				canWrite: request.headers.get('X-User-Can-Write') === 'true',
			} satisfies ConnectionAttachment)

			const sync = encoding.createEncoder()
			encoding.writeVarUint(sync, MESSAGE_SYNC)
			syncProtocol.writeSyncStep1(sync, this.doc)
			server.send(encoding.toUint8Array(sync))

			const query = encoding.createEncoder()
			encoding.writeVarUint(query, MESSAGE_QUERY_AWARENESS)
			this.broadcast(encoding.toUint8Array(query))

			return new Response(null, { status: 101, webSocket: client })
		}

		return this.json({ error: 'Not found' }, 404)
	}

	async alarm(): Promise<void> {
		const meta = this.getMeta()
		if (!meta) return
		const expiresAt = Date.parse(meta.expiresAt)
		if (expiresAt > Date.now()) {
			await this.ctx.storage.setAlarm(expiresAt)
			return
		}

		try {
			const session: SessionExport = {
				meta,
				markdown: this.text.toString(),
				participants: this.getParticipants(),
				assets: this.getAssets(),
			}
			let archive:
				| { branch: string; branchUrl: string; commitSha: string }
				| undefined
			if (!meta.demo) {
				archive = await archiveExpiredSession(this.env, session)
			}
			await Promise.all(
				session.assets.map((asset) =>
					this.env.ASSET_BUCKET.delete(asset.r2Key),
				),
			)
			if (!meta.demo) {
				await this.env.SESSION_REGISTRY.getByName('global').fetch(
					`https://registry/sessions/${meta.id}/delete`,
					{ method: 'DELETE' },
				)
			}
			await this.clearSession(
				'Session expired',
				archive?.branchUrl ?? null,
			)
		} catch (error) {
			console.error('Could not archive expired editing session', {
				sessionId: meta.id,
				error: error instanceof Error ? error.message : String(error),
			})
			await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
		}
	}

	private async clearSession(
		reason: string,
		archiveBranchUrl: string | null = null,
	): Promise<void> {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(
					JSON.stringify({
						type: 'session-deleted',
						reason,
						archiveBranchUrl,
					}),
				)
				socket.close(4004, reason.slice(0, 120))
			} catch {
				// The runtime will discard stale sockets.
			}
		}
		this.deleted = true
		await this.ctx.storage.deleteAll()
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message === 'string') return
		const bytes = new Uint8Array(message)
		const decoder = decoding.createDecoder(bytes)
		const messageType = decoding.readVarUint(decoder)

		if (messageType === MESSAGE_SYNC) {
			const reply = encoding.createEncoder()
			encoding.writeVarUint(reply, MESSAGE_SYNC)
			syncProtocol.readSyncMessage(decoder, reply, this.doc, socket)
			if (encoding.length(reply) > 1 && socket.readyState === WebSocket.OPEN) {
				socket.send(encoding.toUint8Array(reply))
			}
			return
		}

		if (messageType === MESSAGE_AWARENESS) {
			this.broadcast(bytes, socket)
		}
	}

	webSocketClose(socket: WebSocket): void {
		const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
		if (attachment) {
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_REMOVE_AWARENESS)
			encoding.writeVarUint(encoder, attachment.clientId)
			this.broadcast(encoding.toUint8Array(encoder), socket)
		}
	}

	webSocketError(socket: WebSocket): void {
		const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
		if (attachment) {
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_REMOVE_AWARENESS)
			encoding.writeVarUint(encoder, attachment.clientId)
			this.broadcast(encoding.toUint8Array(encoder), socket)
		}
	}
}
