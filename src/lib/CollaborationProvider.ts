import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { PendingAsset, SessionMeta } from './types'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 2
const MESSAGE_REMOVE_AWARENESS = 3

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export class CollaborationProvider {
	private readonly sessionId: string
	readonly doc: Y.Doc
	readonly awareness: awarenessProtocol.Awareness
	private readonly guestName: string
	private socket: WebSocket | null = null
	private destroyed = false
	private reconnectTimer: number | null = null
	private reconnectAttempt = 0
	private status: ConnectionStatus = 'connecting'
	private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
	private readonly assetListeners = new Set<(asset: PendingAsset) => void>()
	private readonly assetRemovalListeners = new Set<(assetId: string) => void>()
	private readonly settingsListeners = new Set<(meta: SessionMeta) => void>()
	private readonly deletionListeners = new Set<(reason: string) => void>()

	constructor(
		sessionId: string,
		doc: Y.Doc,
		awareness: awarenessProtocol.Awareness,
		guestName: string,
	) {
		this.sessionId = sessionId
		this.doc = doc
		this.awareness = awareness
		this.guestName = guestName
		this.doc.on('update', this.onDocumentUpdate)
		this.awareness.on('update', this.onAwarenessUpdate)
		this.connect()
	}

	onStatus(listener: (status: ConnectionStatus) => void): () => void {
		this.statusListeners.add(listener)
		listener(this.status)
		return () => this.statusListeners.delete(listener)
	}

	onAsset(listener: (asset: PendingAsset) => void): () => void {
		this.assetListeners.add(listener)
		return () => this.assetListeners.delete(listener)
	}

	onAssetRemoved(listener: (assetId: string) => void): () => void {
		this.assetRemovalListeners.add(listener)
		return () => this.assetRemovalListeners.delete(listener)
	}

	onSettings(listener: (meta: SessionMeta) => void): () => void {
		this.settingsListeners.add(listener)
		return () => this.settingsListeners.delete(listener)
	}

	onDeleted(listener: (reason: string) => void): () => void {
		this.deletionListeners.add(listener)
		return () => this.deletionListeners.delete(listener)
	}

	destroy(): void {
		this.destroyed = true
		this.doc.off('update', this.onDocumentUpdate)
		this.awareness.off('update', this.onAwarenessUpdate)
		if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
		this.awareness.setLocalState(null)
		this.socket?.close(1000, 'Editor closed')
		this.socket = null
	}

	private setStatus(status: ConnectionStatus): void {
		this.status = status
		for (const listener of this.statusListeners) listener(status)
	}

	private connect(): void {
		if (this.destroyed) return
		this.setStatus('connecting')
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const url = new URL(
			`${protocol}//${window.location.host}/api/sessions/${this.sessionId}/connect`,
		)
		url.searchParams.set('clientId', String(this.doc.clientID))
		url.searchParams.set('name', this.guestName)
		const socket = new WebSocket(url)
		socket.binaryType = 'arraybuffer'
		this.socket = socket

		socket.addEventListener('open', () => {
			this.reconnectAttempt = 0
			this.setStatus('connected')
			const sync = encoding.createEncoder()
			encoding.writeVarUint(sync, MESSAGE_SYNC)
			syncProtocol.writeSyncStep1(sync, this.doc)
			socket.send(encoding.toUint8Array(sync))
			this.sendLocalAwareness()
		})

		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') {
				this.readControlMessage(event.data)
				return
			}
			if (!(event.data instanceof ArrayBuffer)) return
			this.readMessage(new Uint8Array(event.data))
		})

		socket.addEventListener('close', (event) => {
			if (this.socket === socket) this.socket = null
			if (this.destroyed) return
			this.setStatus('disconnected')
			if (event.code === 4003 || event.code === 4004) return
			const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 10_000)
			this.reconnectAttempt += 1
			this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
		})

		socket.addEventListener('error', () => socket.close())
	}

	private readonly onDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this || this.socket?.readyState !== WebSocket.OPEN) return
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_SYNC)
		syncProtocol.writeUpdate(encoder, update)
		this.socket.send(encoding.toUint8Array(encoder))
	}

	private readonly onAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	): void => {
		if (origin === this || this.socket?.readyState !== WebSocket.OPEN) return
		const changedClients = [...changes.added, ...changes.updated, ...changes.removed]
		if (!changedClients.length) return
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
		)
		this.socket.send(encoding.toUint8Array(encoder))
	}

	private sendLocalAwareness(): void {
		if (this.socket?.readyState !== WebSocket.OPEN) return
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
		)
		this.socket.send(encoding.toUint8Array(encoder))
	}

	private readMessage(bytes: Uint8Array): void {
		const decoder = decoding.createDecoder(bytes)
		const messageType = decoding.readVarUint(decoder)

		if (messageType === MESSAGE_SYNC) {
			const reply = encoding.createEncoder()
			encoding.writeVarUint(reply, MESSAGE_SYNC)
			syncProtocol.readSyncMessage(decoder, reply, this.doc, this)
			if (
				encoding.length(reply) > 1 &&
				this.socket?.readyState === WebSocket.OPEN
			) {
				this.socket.send(encoding.toUint8Array(reply))
			}
			return
		}

		if (messageType === MESSAGE_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(
				this.awareness,
				decoding.readVarUint8Array(decoder),
				this,
			)
			return
		}

		if (messageType === MESSAGE_QUERY_AWARENESS) {
			this.sendLocalAwareness()
			return
		}

		if (messageType === MESSAGE_REMOVE_AWARENESS) {
			awarenessProtocol.removeAwarenessStates(
				this.awareness,
				[decoding.readVarUint(decoder)],
				this,
			)
		}
	}

	private readControlMessage(message: string): void {
		try {
			const payload = JSON.parse(message) as {
				type?: string
				asset?: PendingAsset
				assetId?: string
				meta?: SessionMeta
				reason?: string
			}
			if (payload.type === 'asset' && payload.asset) {
				for (const listener of this.assetListeners) listener(payload.asset)
				return
			}
			if (payload.type === 'asset-remove' && payload.assetId) {
				for (const listener of this.assetRemovalListeners) {
					listener(payload.assetId)
				}
				return
			}
			if (payload.type === 'settings' && payload.meta) {
				for (const listener of this.settingsListeners) listener(payload.meta)
				return
			}
			if (payload.type === 'session-deleted') {
				for (const listener of this.deletionListeners) {
					listener(payload.reason ?? 'Session deleted')
				}
			}
		} catch {
			// Ignore control messages from an incompatible client version.
		}
	}
}
