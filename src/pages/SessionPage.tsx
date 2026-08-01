import {
	AlertTriangle,
	AtSign,
	Bold,
	CalendarClock,
	Check,
	ClipboardPaste,
	Code2,
	Columns2,
	Copy,
	ExternalLink,
	FileCode2,
	FolderCog,
	GitBranch,
	GitPullRequestArrow,
	Heading2,
	ImagePlus,
	Images,
	Italic,
	Keyboard,
	Link2,
	List,
	LoaderCircle,
	PanelLeft,
	PanelRight,
	Palette,
	Pencil,
	Quote,
	Share2,
	ShieldCheck,
	Trash2,
	Upload,
	Users,
	Wifi,
	WifiOff,
	X,
} from 'lucide-react'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { Brand } from '../components/Brand'
import { GithubLogo } from '../components/GithubLogo'
import {
	MarkdownEditor,
	type MarkdownEditorHandle,
} from '../components/MarkdownEditor'
import {
	EditorToc,
	MarkdownPreview,
	PreviewToc,
} from '../components/MarkdownPreview'
import { ApiClientError, client } from '../lib/api'
import {
	CollaborationProvider,
	type ConnectionStatus,
} from '../lib/CollaborationProvider'
import {
	EDITOR_COLOR_SCHEMES,
	type EditorColorScheme,
} from '../lib/editorColorSchemes'
import { parseMarkdownDocument } from '../lib/markdown'
import type {
	AuthStatus,
	PendingAsset,
	PublishResult,
	SessionAccessPolicy,
	SessionMeta,
	SessionRetentionDays,
	SessionState,
} from '../lib/types'

type SessionPageProps = {
	sessionId: string
	auth: AuthStatus
	onEmailSettings: () => void
}

type PresenceUser = {
	name: string
	login?: string
	color: string
	colorLight: string
	avatarUrl?: string | null
}

type WorkspaceMode = 'editor' | 'split' | 'preview'

const PRESENCE_COLORS = [
	['#b7f36b', '#b7f36b22'],
	['#b69cff', '#b69cff22'],
	['#ff9e6b', '#ff9e6b22'],
	['#65d9ff', '#65d9ff22'],
	['#ff7ab6', '#ff7ab622'],
]

function storedEditorColorScheme(): EditorColorScheme {
	const stored = localStorage.getItem('livemd.editorColorScheme')
	return EDITOR_COLOR_SCHEMES.some((scheme) => scheme.value === stored)
		? (stored as EditorColorScheme)
		: 'midnight'
}

function storedWorkspaceMode(): WorkspaceMode {
	const stored = localStorage.getItem('livemd.workspaceMode')
	return stored === 'editor' || stored === 'preview' || stored === 'split'
		? stored
		: 'split'
}

function storedVimMode(): boolean {
	return localStorage.getItem('livemd.vimMode') === 'true'
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function relativeAssetDirectory(
	documentPath: string,
	targetDirectory: string,
): string {
	const documentDirectory = documentPath.includes('/')
		? documentPath.slice(0, documentPath.lastIndexOf('/'))
		: ''
	const from = documentDirectory ? documentDirectory.split('/') : []
	const to =
		targetDirectory === '.' || !targetDirectory
			? []
			: targetDirectory.split('/')
	let common = 0
	while (
		common < from.length &&
		common < to.length &&
		from[common] === to[common]
	) {
		common += 1
	}
	const relative = [
		...from.slice(common).map(() => '..'),
		...to.slice(common),
	].join('/')
	if (!relative) return './'
	return relative.startsWith('.') ? relative : `./${relative}`
}

export function SessionPage({ sessionId, auth, onEmailSettings }: SessionPageProps) {
	const [session, setSession] = useState<SessionState | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<{ message: string; status?: number } | null>(null)

	useEffect(() => {
		client
			.session(sessionId)
			.then(setSession)
			.catch((caught: unknown) => {
				setError({
					message: caught instanceof Error ? caught.message : 'セッションを読み込めませんでした',
					status: caught instanceof ApiClientError ? caught.status : undefined,
				})
			})
			.finally(() => setLoading(false))
	}, [sessionId])

	if (loading) {
		return (
			<div className="session-loading">
				<Brand />
				<LoaderCircle className="spin" size={28} />
				<p>共同編集セッションを復元しています…</p>
			</div>
		)
	}

	if (!session || error) {
		return (
			<div className="session-error-page">
				<Brand />
				<div className="error-card">
					<span><AlertTriangle size={26} /></span>
					<h1>{error?.status === 401 ? 'GitHubログインが必要です' : 'セッションを開けません'}</h1>
					<p>{error?.message ?? 'セッションが見つかりませんでした。'}</p>
					{error?.status === 401 ? (
						<a className="button button-primary" href="/api/auth/github/start">
							<GithubLogo size={17} />
							GitHubでログイン
						</a>
					) : (
						<a className="button button-secondary" href="/">ホームへ戻る</a>
					)}
				</div>
			</div>
		)
	}

	return (
		<EditorWorkspace
			initialSession={session}
			auth={auth}
			onEmailSettings={onEmailSettings}
		/>
	)
}

function EditorWorkspace({
	initialSession,
	auth,
	onEmailSettings,
}: {
	initialSession: SessionState
	auth: AuthStatus
	onEmailSettings: () => void
}) {
	const [resources] = useState(() => {
		const doc = new Y.Doc()
		return { doc, awareness: new awarenessProtocol.Awareness(doc) }
	})
	const { doc, awareness } = resources
	const text = useMemo(() => doc.getText('markdown'), [doc])
	const editorRef = useRef<MarkdownEditorHandle>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const editorPaneRef = useRef<HTMLElement>(null)
	const previewPaneRef = useRef<HTMLElement>(null)
	const previewScrollRef = useRef<HTMLDivElement>(null)
	const pendingEditorScrollRef = useRef<number | null>(null)
	const pendingPreviewScrollRef = useRef<number | null>(null)
	const [meta, setMeta] = useState(initialSession.meta)
	const [markdown, setMarkdown] = useState('')
	const [assets, setAssets] = useState<PendingAsset[]>(
		initialSession.assets.map((asset) => ({
			...asset,
			previewUrl: `/api/sessions/${meta.id}/assets/${asset.id}`,
		})),
	)
	const [connection, setConnection] = useState<ConnectionStatus>('connecting')
	const [presence, setPresence] = useState<PresenceUser[]>([])
	const [uploading, setUploading] = useState(false)
	const [assetsOpen, setAssetsOpen] = useState(false)
	const [shareOpen, setShareOpen] = useState(false)
	const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null)
	const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
	const [mobilePane, setMobilePane] = useState<'editor' | 'preview'>('editor')
	const [editorColorScheme, setEditorColorScheme] =
		useState<EditorColorScheme>(storedEditorColorScheme)
	const [workspaceMode, setWorkspaceMode] =
		useState<WorkspaceMode>(storedWorkspaceMode)
	const [vimMode, setVimMode] = useState(storedVimMode)
	const [publishOpen, setPublishOpen] = useState(false)
	const [publishResult, setPublishResult] = useState<PublishResult | null>(
		meta.pullRequestUrl
			? {
					pullRequestUrl: meta.pullRequestUrl,
					pullRequestNumber: meta.pullRequestNumber ?? 0,
					branch: meta.pullRequestBranch ?? '',
					commitSha: meta.lastPublishedCommitSha ?? '',
					alreadyPublished: true,
					createdPullRequest: false,
				}
			: null,
	)

	const identity = useMemo(() => {
		const colorIndex = doc.clientID % PRESENCE_COLORS.length
		const [color, colorLight] = PRESENCE_COLORS[colorIndex]
		return {
			name: auth.user?.name?.trim() || auth.user?.login || 'GitHub user',
			login: auth.user?.login,
			avatarUrl: auth.user?.avatar_url,
			color,
			colorLight,
		}
	}, [auth.user, doc.clientID])

	useEffect(() => {
		if (!auth.user || !auth.commitEmail) return
		// Restore a complete local state after a provider cleanup as well as on first mount.
		// Awareness#setLocalStateField is intentionally a no-op when the local state is null.
		awareness.setLocalState({ user: identity })
		const provider = new CollaborationProvider(
			meta.id,
			doc,
			awareness,
		)
		const unsubscribe = provider.onStatus(setConnection)
		const unsubscribeAssets = provider.onAsset((asset) => {
			setAssets((current) =>
				current.some((item) => item.id === asset.id)
					? current.map((item) =>
							item.id === asset.id
								? {
										...item,
										...asset,
										previewUrl: `/api/sessions/${meta.id}/assets/${asset.id}`,
									}
								: item,
						)
					: [
							...current,
							{
								...asset,
								previewUrl: `/api/sessions/${meta.id}/assets/${asset.id}`,
							},
						],
			)
		})
		const unsubscribeAssetRemovals = provider.onAssetRemoved((assetId) => {
			setAssets((current) => current.filter((asset) => asset.id !== assetId))
		})
		const unsubscribeSettings = provider.onSettings(setMeta)
		const unsubscribeErrors = provider.onError((message) => {
			setNotice({ kind: 'error', message })
		})
		const unsubscribeDeleted = provider.onDeleted((reason) => {
			setNotice({
				kind: 'error',
				message:
					reason === 'Pull Request merged'
						? 'Pull Requestがmergeされたためセッションを終了しました'
						: 'セッションが終了しました',
			})
			window.setTimeout(() => window.location.assign('/'), 1_500)
		})
		return () => {
			unsubscribe()
			unsubscribeAssets()
			unsubscribeAssetRemovals()
			unsubscribeSettings()
			unsubscribeErrors()
			unsubscribeDeleted()
			provider.destroy()
		}
	}, [
		auth.commitEmail,
		auth.user,
		awareness,
		doc,
		identity,
		meta.id,
	])

	useEffect(() => {
		const updateMarkdown = () => setMarkdown(text.toString())
		updateMarkdown()
		text.observe(updateMarkdown)
		return () => text.unobserve(updateMarkdown)
	}, [text])

	useEffect(() => {
		localStorage.setItem('livemd.editorColorScheme', editorColorScheme)
	}, [editorColorScheme])

	useEffect(() => {
		localStorage.setItem('livemd.workspaceMode', workspaceMode)
	}, [workspaceMode])

	useEffect(() => {
		localStorage.setItem('livemd.vimMode', String(vimMode))
	}, [vimMode])

	useEffect(() => {
		const updatePresence = () => {
			const users = [...awareness.getStates().values()]
				.map((state) => state.user as PresenceUser | undefined)
				.filter((user): user is PresenceUser => Boolean(user?.name))
			setPresence(users)
		}
		updatePresence()
		awareness.on('change', updatePresence)
		return () => awareness.off('change', updatePresence)
	}, [awareness])

	const bothPanesVisible = useCallback(
		() =>
			Boolean(
				editorPaneRef.current?.getClientRects().length &&
					previewPaneRef.current?.getClientRects().length,
			),
		[],
	)

	const syncPreviewFromEditor = useCallback(
		(progress: number) => {
			if (!bothPanesVisible()) return
			const pending = pendingEditorScrollRef.current
			if (pending !== null && Math.abs(progress - pending) < 0.015) {
				pendingEditorScrollRef.current = null
				return
			}
			pendingEditorScrollRef.current = null

			const preview = previewScrollRef.current
			if (!preview) return
			const maximum = preview.scrollHeight - preview.clientHeight
			const target = Math.max(0, Math.min(progress, 1))
			const current = maximum > 0 ? preview.scrollTop / maximum : 0
			if (Math.abs(current - target) < 0.001) {
				pendingPreviewScrollRef.current = null
				return
			}
			pendingPreviewScrollRef.current = target
			preview.scrollTop = target * Math.max(maximum, 0)
		},
		[bothPanesVisible],
	)

	const syncEditorFromPreview = useCallback(() => {
		if (!bothPanesVisible()) return
		const preview = previewScrollRef.current
		if (!preview) return
		const maximum = preview.scrollHeight - preview.clientHeight
		const progress = maximum > 0 ? preview.scrollTop / maximum : 0
		const pending = pendingPreviewScrollRef.current
		if (pending !== null && Math.abs(progress - pending) < 0.015) {
			pendingPreviewScrollRef.current = null
			return
		}
		pendingPreviewScrollRef.current = null
		pendingEditorScrollRef.current = progress
		const changed = editorRef.current?.scrollToProgress(progress)
		if (!changed) pendingEditorScrollRef.current = null
	}, [bothPanesVisible])

	const showDocumentLimit = useCallback(() => {
		setNotice({
			kind: 'error',
			message: 'Markdownは2 MBまでです。上限を超える変更は保存されません。',
		})
	}, [])

	const uploadImages = useCallback(async (files: File[]) => {
		if (!files.length) return
		setUploading(true)
		setNotice(null)
		let uploaded = 0
		try {
			for (const file of files) {
				const asset = await client.uploadAsset(meta.id, file)
				setAssets((current) =>
					current.some((item) => item.id === asset.id)
						? current
						: [...current, asset],
				)
				const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
				editorRef.current?.insertText(
					`\n\n![${alt}](${asset.markdownPath})\n\n`,
				)
				uploaded += 1
			}
			setNotice({
				kind: 'success',
				message:
					uploaded === 1
						? `${files[0].name} をコミット候補へ追加しました`
						: `${uploaded}件の画像をコミット候補へ追加しました`,
			})
		} catch (caught) {
			setNotice({
				kind: 'error',
				message:
					caught instanceof Error
						? caught.message
						: '画像をアップロードできませんでした',
			})
		} finally {
			setUploading(false)
			if (fileInputRef.current) fileInputRef.current.value = ''
		}
	}, [
		meta.id,
	])

	const deleteAsset = async (asset: PendingAsset) => {
		setDeletingAssetId(asset.id)
		setNotice(null)
		try {
			await client.deleteAsset(meta.id, asset.id)
			setAssets((current) => current.filter((item) => item.id !== asset.id))
			setNotice({
				kind: 'success',
				message: `${asset.originalName} をコミット候補から削除しました`,
			})
		} catch (caught) {
			setNotice({
				kind: 'error',
				message:
					caught instanceof Error ? caught.message : '画像を削除できませんでした',
			})
		} finally {
			setDeletingAssetId(null)
		}
	}

	const renameAsset = async (
		asset: PendingAsset,
		fileName: string,
	): Promise<void> => {
		const renamed = await client.renameAsset(meta.id, asset.id, fileName)
		setAssets((current) =>
			current.map((item) =>
				item.id === asset.id
					? { ...item, ...renamed }
					: item,
			),
		)
		setNotice({
			kind: 'success',
			message: `画像ファイル名を ${renamed.finalPath.split('/').pop()} に変更しました`,
		})
	}

	const wordCount = markdown.trim() ? markdown.trim().split(/\s+/).length : 0
	const previewHeadings = useMemo(
		() => parseMarkdownDocument(markdown).headings,
		[markdown],
	)
	const readOnly = false
	const pullRequestUrl =
		publishResult?.pullRequestUrl ?? meta.pullRequestUrl

	return (
		<div className="editor-shell">
			<header className="editor-header">
				<Brand />
				<div className="document-crumb">
					<GithubLogo size={15} />
					<span>{meta.repository}</span>
					<i>/</i>
					<b>{meta.documentPath}</b>
				</div>
				<div className="editor-header-actions">
					<div className={`connection-chip ${connection}`}>
						{connection === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />}
						{connection === 'connected' ? 'Saved to edge' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
					</div>
					<div className="presence-stack" title={`${presence.length} editors online`}>
						{presence.slice(0, 4).map((user, index) => (
							user.avatarUrl ? (
								<img key={`${user.login ?? user.name}-${index}`} src={user.avatarUrl} alt={user.name} />
							) : (
								<span
									key={`${user.login ?? user.name}-${index}`}
									style={{ background: user.color, color: '#10140f' }}
								>
									{user.name.slice(0, 1).toUpperCase()}
								</span>
							)
						))}
						{presence.length > 4 && <span className="presence-more">+{presence.length - 4}</span>}
					</div>
					<button className="icon-button labeled" onClick={() => setShareOpen(true)}>
						<Share2 size={16} />
						Share
					</button>
					<button
						className="icon-button labeled asset-manager-button"
						onClick={() => setAssetsOpen(true)}
					>
						<Images size={16} />
						Assets
						<b>{assets.length}</b>
					</button>
					{pullRequestUrl && (
						<a
							className="button editor-pr-button success"
							href={pullRequestUrl}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink size={15} />
							Open PR
						</a>
					)}
					<button
						className="button editor-pr-button"
						onClick={() => setPublishOpen(true)}
					>
						<GitPullRequestArrow size={16} />
						{pullRequestUrl ? 'Add commit' : 'Create PR'}
					</button>
				</div>
			</header>

			<div className="editor-toolbar">
				<div className="toolbar-group">
					<button title="見出し" onClick={() => editorRef.current?.insertText('## ')}>
						<Heading2 size={16} />
					</button>
					<button title="太字" onClick={() => editorRef.current?.wrapSelection('**')}>
						<Bold size={16} />
					</button>
					<button title="斜体" onClick={() => editorRef.current?.wrapSelection('_')}>
						<Italic size={16} />
					</button>
					<button title="インラインコード" onClick={() => editorRef.current?.wrapSelection('`')}>
						<Code2 size={16} />
					</button>
					<span className="toolbar-divider" />
					<button title="リンク" onClick={() => editorRef.current?.wrapSelection('[', '](https://)')}>
						<Link2 size={16} />
					</button>
					<button title="引用" onClick={() => editorRef.current?.insertText('> ')}>
						<Quote size={16} />
					</button>
					<button title="リスト" onClick={() => editorRef.current?.insertText('- ')}>
						<List size={16} />
					</button>
					<button
						title="画像をアップロード"
						onClick={() => fileInputRef.current?.click()}
						disabled={uploading || readOnly}
					>
						{uploading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						multiple
						hidden
						onChange={(event) => {
							const files = [...(event.target.files ?? [])]
							if (files.length) void uploadImages(files)
						}}
					/>
				</div>
				<div className="workspace-view-controls">
					<button
						type="button"
						className={`vim-mode-toggle${vimMode ? ' active' : ''}`}
						aria-pressed={vimMode}
						title={vimMode ? 'Vim modeを無効にする' : 'Vim modeを有効にする'}
						onClick={() => setVimMode((enabled) => !enabled)}
					>
						<Keyboard size={14} />
						<span>Vim</span>
					</button>
					<label className="editor-scheme-select" title="エディタのカラースキーマ">
						<Palette size={14} />
						<select
							aria-label="エディタのカラースキーマ"
							value={editorColorScheme}
							onChange={(event) =>
								setEditorColorScheme(
									event.target.value as EditorColorScheme,
								)
							}
						>
							{EDITOR_COLOR_SCHEMES.map((scheme) => (
								<option key={scheme.value} value={scheme.value}>
									{scheme.label}
								</option>
							))}
						</select>
					</label>
					<div className="workspace-mode-toggle" aria-label="表示モード">
						<button
							className={workspaceMode === 'editor' ? 'active' : ''}
							aria-pressed={workspaceMode === 'editor'}
							title="エディタのみ"
							onClick={() => setWorkspaceMode('editor')}
						>
							<PanelLeft size={14} />
							<span>Editor</span>
						</button>
						<button
							className={workspaceMode === 'split' ? 'active' : ''}
							aria-pressed={workspaceMode === 'split'}
							title="エディタとプレビュー（同期スクロール）"
							onClick={() => setWorkspaceMode('split')}
						>
							<Columns2 size={14} />
							<span>Split</span>
						</button>
						<button
							className={workspaceMode === 'preview' ? 'active' : ''}
							aria-pressed={workspaceMode === 'preview'}
							title="プレビューのみ"
							onClick={() => setWorkspaceMode('preview')}
						>
							<PanelRight size={14} />
							<span>Preview</span>
						</button>
					</div>
				</div>
				<div className="mobile-pane-toggle">
					<button
						className={mobilePane === 'editor' ? 'active' : ''}
						onClick={() => setMobilePane('editor')}
					>
						<PanelLeft size={15} /> Edit
					</button>
					<button
						className={mobilePane === 'preview' ? 'active' : ''}
						onClick={() => setMobilePane('preview')}
					>
						<PanelRight size={15} /> Preview
					</button>
				</div>
				<div className="toolbar-meta">
					<span>{wordCount} words</span>
					<span>{markdown.length} chars</span>
					<span>Markdown</span>
				</div>
			</div>

			<main
				className={`editor-workspace mode-${workspaceMode} show-${mobilePane}`}
			>
				<section
					className="editor-pane"
					data-color-scheme={editorColorScheme}
					ref={editorPaneRef}
				>
					<div className="pane-heading">
						<span><FileCode2 size={14} /> MARKDOWN</span>
						<span>{readOnly ? 'READ ONLY' : 'LIVE'}</span>
					</div>
					<MarkdownEditor
						ref={editorRef}
						text={text}
						awareness={awareness}
						readOnly={readOnly}
						onPasteImages={uploadImages}
						onScrollProgress={syncPreviewFromEditor}
						onDocumentLimitExceeded={showDocumentLimit}
						colorScheme={editorColorScheme}
						vimMode={vimMode}
					/>
					<EditorToc
						headings={previewHeadings}
						onNavigate={(heading) =>
							editorRef.current?.scrollToPosition(heading.from)
						}
					/>
				</section>
				<section className="preview-pane" ref={previewPaneRef}>
					<div className="pane-heading">
						<span><PanelRight size={14} /> PREVIEW</span>
						<span>GFM</span>
					</div>
					<div
						className="preview-scroll"
						ref={previewScrollRef}
						onScroll={syncEditorFromPreview}
					>
						<MarkdownPreview
							markdown={markdown}
							meta={meta}
							assets={assets}
						/>
					</div>
					<PreviewToc headings={previewHeadings} />
				</section>
			</main>

			<footer className="editor-statusbar">
				<div>
					<span className={`status-dot ${connection}`} />
					{connection === 'connected' ? 'Durable Object connected' : 'Local changes preserved by Yjs'}
					<span className="status-divider" />
					<Users size={13} /> {presence.length} online
				</div>
				<div>
					{assets.length > 0 && <span><Upload size={13} /> {assets.length} staged asset{assets.length === 1 ? '' : 's'}</span>}
					<span>UTF-8</span>
					<span>Ln endings: LF</span>
				</div>
			</footer>

			{notice && (
				<div className={`toast ${notice.kind}`}>
					{notice.kind === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}
					<span>{notice.message}</span>
					<button onClick={() => setNotice(null)}><X size={14} /></button>
				</div>
			)}

			{publishOpen && (
				<PublishDialog
					session={{ ...initialSession, meta }}
					assets={assets}
					commitEmail={auth.commitEmail}
					onEmailSettings={onEmailSettings}
					onClose={() => setPublishOpen(false)}
					onPublished={(result) => {
						setPublishResult(result)
						setMeta((current) => ({
							...current,
							status: 'published',
							pullRequestUrl: result.pullRequestUrl,
							pullRequestNumber: result.pullRequestNumber,
							pullRequestBranch: result.branch,
							lastPublishedCommitSha: result.commitSha,
							publishedAssetPaths: assets.map(
								(asset) => asset.finalPath,
							),
						}))
						setPublishOpen(false)
						setNotice({
							kind: 'success',
							message: result.createdPullRequest
								? 'Draft PRを作成しました'
								: '同じPull Requestへコミットを追加しました',
						})
					}}
				/>
			)}

			{shareOpen && (
				<ShareDialog
					meta={meta}
					canManage={Boolean(
						auth.user &&
							meta.createdBy.id !== null &&
							auth.user.id === meta.createdBy.id,
					)}
					onClose={() => setShareOpen(false)}
					onSaved={(updatedMeta) => {
						setMeta(updatedMeta)
						setShareOpen(false)
						setNotice({
							kind: 'success',
							message: '共有範囲と有効期限を更新しました',
						})
					}}
					onDeleted={() => window.location.assign('/')}
				/>
			)}

			{assetsOpen && (
				<AssetManagerDialog
					sessionId={meta.id}
					assets={assets}
					readOnly={readOnly}
					uploading={uploading}
					deletingAssetId={deletingAssetId}
					assetDirectory={relativeAssetDirectory(
						meta.documentPath,
						meta.assetDirectory,
					)}
					defaultDirectory="./images"
					onUpload={() => fileInputRef.current?.click()}
					onDelete={(asset) => void deleteAsset(asset)}
					onRename={renameAsset}
					onSaveDirectory={async (directory) => {
						const result = await client.updateAssetDirectory(
							meta.id,
							directory,
						)
						setMeta(result.meta)
						setNotice({
							kind: 'success',
							message: `画像の追加先を ${relativeAssetDirectory(
								result.meta.documentPath,
								result.meta.assetDirectory,
							)} に変更しました`,
						})
					}}
					onClose={() => setAssetsOpen(false)}
				/>
			)}
		</div>
	)
}

function ShareDialog({
	meta,
	canManage,
	onClose,
	onSaved,
	onDeleted,
}: {
	meta: SessionMeta
	canManage: boolean
	onClose: () => void
	onSaved: (meta: SessionMeta) => void
	onDeleted: () => void
}) {
	const [accessPolicy, setAccessPolicy] =
		useState<SessionAccessPolicy>(meta.accessPolicy)
	const [retentionDays, setRetentionDays] =
		useState<SessionRetentionDays>(meta.retentionDays)
	const [copied, setCopied] = useState(false)
	const [saving, setSaving] = useState(false)
	const [deleting, setDeleting] = useState(false)
	const [deleteArmed, setDeleteArmed] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(window.location.href)
			setCopied(true)
			window.setTimeout(() => setCopied(false), 1_800)
		} catch {
			setError('共有URLをコピーできませんでした')
		}
	}

	const deleteSession = async () => {
		if (!deleteArmed) {
			setDeleteArmed(true)
			return
		}
		setDeleting(true)
		setError(null)
		try {
			await client.deleteSession(meta.id)
			onDeleted()
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: 'セッションを削除できませんでした',
			)
			setDeleting(false)
		}
	}

	const save = async () => {
		setSaving(true)
		setError(null)
		try {
			const result = await client.updateSessionSettings(meta.id, {
				accessPolicy,
				retentionDays,
			})
			onSaved(result.meta)
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: '共有設定を更新できませんでした',
			)
			setSaving(false)
		}
	}

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<div
				className="publish-dialog share-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="share-dialog-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="dialog-header">
					<div>
						<span className="dialog-icon"><Share2 size={20} /></span>
						<div>
							<small>SESSION ACCESS</small>
							<h2 id="share-dialog-title">セッションを共有</h2>
						</div>
					</div>
					<button className="icon-button" onClick={onClose} aria-label="閉じる">
						<X size={18} />
					</button>
				</div>

				<div className="share-url-row">
					<span>
						<Share2 size={16} />
						<code>{window.location.href}</code>
					</span>
					<button className="button button-secondary" onClick={() => void copy()}>
						{copied ? <Check size={16} /> : <Copy size={16} />}
						{copied ? 'コピー済み' : 'URLをコピー'}
					</button>
				</div>

				<div className="share-settings">
					<fieldset disabled={!canManage}>
						<legend>参加できるユーザー</legend>
						<label className={accessPolicy === 'link' ? 'selected' : ''}>
							<input
								type="radio"
								name="access-policy"
								value="link"
								checked={accessPolicy === 'link'}
								onChange={() => setAccessPolicy('link')}
							/>
							<span className="share-option-icon"><Share2 size={18} /></span>
							<span>
								<b>リンクを知っているアクセス可能なユーザー</b>
								<small>
									公開リポジトリはGitHubログイン済みユーザー、
									非公開リポジトリは閲覧権限があるユーザーが参加できます。
								</small>
							</span>
						</label>
						<label className={accessPolicy === 'write' ? 'selected' : ''}>
							<input
								type="radio"
								name="access-policy"
								value="write"
								checked={accessPolicy === 'write'}
								onChange={() => setAccessPolicy('write')}
							/>
							<span className="share-option-icon"><ShieldCheck size={18} /></span>
							<span>
								<b>リポジトリのwrite権限を持つユーザーのみ</b>
								<small>
									公開リポジトリでもpushできないユーザーは参加できません。
								</small>
							</span>
						</label>
					</fieldset>

					<label className="share-retention">
						<span>セッションの保存期間</span>
						<div className="select-wrap">
							<CalendarClock size={16} className="field-icon" />
							<select
								value={retentionDays}
								disabled={!canManage}
								onChange={(event) =>
									setRetentionDays(
										Number(event.target.value) as SessionRetentionDays,
									)
								}
							>
								<option value={7}>7日</option>
								<option value={14}>14日（デフォルト）</option>
								<option value={21}>21日</option>
								<option value={28}>28日</option>
							</select>
						</div>
						<small>
							期限は作成日時から計算します。未反映の変更を専用ブランチまたは
							既存PRブランチへ自動保存後、セッションと仮画像を削除します。
						</small>
					</label>

					{!canManage && (
						<p className="share-owner-note">
							共有範囲と保存期間を変更できるのはセッション作成者だけです。
						</p>
					)}

					{canManage && (
						<div className="session-delete-zone">
							<div>
								<b>セッションを削除</b>
								<small>
									Durable Objectの編集内容と仮画像を削除します。
									GitHub上のブランチやPull Requestは削除しません。
								</small>
							</div>
							<button
								className={`button session-delete-button${deleteArmed ? ' armed' : ''}`}
								onClick={() => void deleteSession()}
								disabled={deleting}
							>
								{deleting ? (
									<LoaderCircle className="spin" size={16} />
								) : (
									<Trash2 size={16} />
								)}
								{deleting
									? '削除中…'
									: deleteArmed
										? '本当に削除する'
										: 'セッションを削除'}
							</button>
						</div>
					)}
				</div>

				{error && (
					<div className="dialog-error">
						<AlertTriangle size={17} />
						<span>{error}</span>
					</div>
				)}

				<div className="dialog-footer">
					<p>
						有効期限: {new Intl.DateTimeFormat('ja-JP', {
							dateStyle: 'medium',
							timeStyle: 'short',
						}).format(
							new Date(
								Date.parse(meta.createdAt) + retentionDays * 86_400_000,
							),
						)}
					</p>
					<div>
						<button className="button button-secondary" onClick={onClose}>
							閉じる
						</button>
						{canManage && (
							<button
								className="button button-primary"
								onClick={() => void save()}
								disabled={saving}
							>
								{saving ? (
									<LoaderCircle className="spin" size={17} />
								) : (
									<Check size={17} />
								)}
								{saving ? '保存中…' : '共有設定を保存'}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	)
}

function AssetManagerDialog({
	sessionId,
	assets,
	readOnly,
	uploading,
	deletingAssetId,
	assetDirectory,
	defaultDirectory,
	onUpload,
	onDelete,
	onRename,
	onSaveDirectory,
	onClose,
}: {
	sessionId: string
	assets: PendingAsset[]
	readOnly: boolean
	uploading: boolean
	deletingAssetId: string | null
	assetDirectory: string
	defaultDirectory: string
	onUpload: () => void
	onDelete: (asset: PendingAsset) => void
	onRename: (asset: PendingAsset, fileName: string) => Promise<void>
	onSaveDirectory: (directory: string) => Promise<void>
	onClose: () => void
}) {
	const [directory, setDirectory] = useState(assetDirectory)
	const [savingDirectory, setSavingDirectory] = useState(false)
	const [directoryError, setDirectoryError] = useState<string | null>(null)
	const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null)
	const [renameValue, setRenameValue] = useState('')
	const [savingRename, setSavingRename] = useState(false)
	const [renameError, setRenameError] = useState<string | null>(null)
	const trimmedDirectory = directory.trim()
	const normalizedDirectory =
		trimmedDirectory === '.' || trimmedDirectory === './'
			? './'
			: trimmedDirectory.replace(/\/+$/, '')
	const directoryChanged =
		Boolean(normalizedDirectory) && normalizedDirectory !== assetDirectory

	useEffect(() => {
		setDirectory(assetDirectory)
	}, [assetDirectory])

	const saveDirectory = async () => {
		setSavingDirectory(true)
		setDirectoryError(null)
		try {
			await onSaveDirectory(normalizedDirectory)
		} catch (caught) {
			setDirectoryError(
				caught instanceof Error
					? caught.message
					: '画像の追加先を変更できませんでした',
			)
		} finally {
			setSavingDirectory(false)
		}
	}

	const startRename = (asset: PendingAsset) => {
		setRenamingAssetId(asset.id)
		setRenameValue(asset.finalPath.split('/').pop() ?? asset.originalName)
		setRenameError(null)
	}

	const cancelRename = () => {
		setRenamingAssetId(null)
		setRenameValue('')
		setRenameError(null)
	}

	const saveRename = async (asset: PendingAsset) => {
		setSavingRename(true)
		setRenameError(null)
		try {
			await onRename(asset, renameValue)
			cancelRename()
		} catch (caught) {
			setRenameError(
				caught instanceof Error
					? caught.message
					: '画像ファイル名を変更できませんでした',
			)
		} finally {
			setSavingRename(false)
		}
	}

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<div
				className="publish-dialog asset-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="asset-dialog-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="dialog-header">
					<div>
						<span className="dialog-icon"><Images size={20} /></span>
						<div>
							<small>STAGED FOR COMMIT</small>
							<h2 id="asset-dialog-title">アップロード予定の画像</h2>
						</div>
					</div>
					<button className="icon-button" onClick={onClose} aria-label="閉じる">
						<X size={18} />
					</button>
				</div>

				<div className="asset-directory-settings">
					<div className="asset-directory-heading">
						<span><FolderCog size={17} /></span>
						<div>
							<label htmlFor="asset-directory">画像の追加先</label>
							<small>Markdownファイルからの相対パス</small>
						</div>
					</div>
					<div className="asset-directory-controls">
						<input
							id="asset-directory"
							value={directory}
							onChange={(event) => setDirectory(event.target.value)}
							placeholder={defaultDirectory}
							disabled={readOnly || savingDirectory}
							spellCheck={false}
						/>
						<button
							className="button button-secondary"
							onClick={() => setDirectory(defaultDirectory)}
							disabled={
								readOnly ||
								savingDirectory ||
								normalizedDirectory === defaultDirectory
							}
						>
							既定に戻す
						</button>
						<button
							className="button button-primary"
							onClick={() => void saveDirectory()}
							disabled={readOnly || savingDirectory || !directoryChanged}
						>
							{savingDirectory ? (
								<LoaderCircle className="spin" size={16} />
							) : (
								<Check size={16} />
							)}
							保存
						</button>
					</div>
					<p>
						<code>./</code> ならMarkdownと同じ場所です。既定は
						<code>{defaultDirectory}/</code>。変更後に追加する画像から反映し、
						追加済みの画像は移動しません。
					</p>
					{directoryError && (
						<div className="asset-directory-error">
							<AlertTriangle size={15} />
							<span>{directoryError}</span>
						</div>
					)}
				</div>

				<div className="asset-dialog-toolbar">
					<p>
						<ClipboardPaste size={16} />
						エディタへ画像をペーストしても追加できます
					</p>
					<button
						className="button button-primary"
						onClick={onUpload}
						disabled={readOnly || uploading}
					>
						{uploading ? (
							<LoaderCircle className="spin" size={16} />
						) : (
							<ImagePlus size={16} />
						)}
						画像を追加
					</button>
				</div>

				{assets.length ? (
					<div className="asset-manager-list">
						{assets.map((asset) => (
							<div className="asset-manager-item" key={asset.id}>
								<img
									src={
										asset.previewUrl ??
										`/api/sessions/${sessionId}/assets/${asset.id}`
									}
									alt=""
								/>
								<span>
									{renamingAssetId === asset.id ? (
										<>
											<input
												className="asset-name-input"
												value={renameValue}
												onChange={(event) => setRenameValue(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === 'Enter') {
														event.preventDefault()
														void saveRename(asset)
													}
													if (event.key === 'Escape') cancelRename()
												}}
												aria-label={`${asset.originalName}のファイル名`}
												disabled={savingRename}
												autoFocus
												spellCheck={false}
											/>
											{renameError && (
												<small className="asset-rename-error">
													{renameError}
												</small>
											)}
										</>
									) : (
										<b>{asset.finalPath.split('/').pop()}</b>
									)}
									<code>{asset.finalPath}</code>
									<small>
										元: {asset.originalName} · {formatBytes(asset.size)} · {asset.mimeType} · @{asset.uploadedBy}
									</small>
								</span>
								<div className="asset-action-buttons">
									{renamingAssetId === asset.id ? (
										<>
											<button
												className="asset-action-button save"
												onClick={() => void saveRename(asset)}
												disabled={savingRename || !renameValue.trim()}
												aria-label="ファイル名を保存"
											>
												{savingRename ? (
													<LoaderCircle className="spin" size={17} />
												) : (
													<Check size={17} />
												)}
											</button>
											<button
												className="asset-action-button"
												onClick={cancelRename}
												disabled={savingRename}
												aria-label="名前変更をキャンセル"
											>
												<X size={17} />
											</button>
										</>
									) : (
										<>
											<button
												className="asset-action-button rename"
												onClick={() => startRename(asset)}
												disabled={readOnly || deletingAssetId === asset.id}
												aria-label={`${asset.originalName}のファイル名を変更`}
											>
												<Pencil size={16} />
											</button>
											<button
												className="asset-action-button delete"
												onClick={() => onDelete(asset)}
												disabled={readOnly || deletingAssetId === asset.id}
												aria-label={`${asset.originalName}を削除`}
											>
												{deletingAssetId === asset.id ? (
													<LoaderCircle className="spin" size={17} />
												) : (
													<Trash2 size={17} />
												)}
											</button>
										</>
									)}
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="asset-manager-empty">
						<Images size={30} />
						<b>画像はまだありません</b>
						<p>ボタンから選ぶか、エディタへ画像をペーストしてください。</p>
					</div>
				)}

				<div className="asset-dialog-note">
					<AlertTriangle size={16} />
					<p>
						ファイル名を変更するとMarkdown本文中の参照も自動更新します。
						画像を削除した場合、参照は残るため本文から削除してください。
					</p>
				</div>
			</div>
		</div>
	)
}

function PublishDialog({
	session,
	assets,
	commitEmail,
	onEmailSettings,
	onClose,
	onPublished,
}: {
	session: SessionState
	assets: PendingAsset[]
	commitEmail: string | null
	onEmailSettings: () => void
	onClose: () => void
	onPublished: (result: PublishResult) => void
}) {
	const isFollowUp = Boolean(session.meta.pullRequestUrl)
	const defaultAction =
		isFollowUp || session.meta.baseBlobSha ? 'Update' : 'Add'
	const [title, setTitle] = useState(`${defaultAction} ${session.meta.documentPath}`)
	const [commitMessage, setCommitMessage] = useState(
		`docs: ${defaultAction.toLowerCase()} ${session.meta.documentPath}`,
	)
	const [description, setDescription] = useState(
		'Collaboratively edited with GitHub Live MD.',
	)
	const [publishing, setPublishing] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const publish = async () => {
		setPublishing(true)
		setError(null)
		try {
			onPublished(
				await client.publish(session.meta.id, { title, commitMessage, description }),
			)
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: isFollowUp
						? 'Pull Requestへコミットを追加できませんでした'
						: 'Draft PRを作成できませんでした',
			)
			setPublishing(false)
		}
	}

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<div
				className="publish-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="publish-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="dialog-header">
					<div>
						<span className="dialog-icon"><GitPullRequestArrow size={20} /></span>
						<div>
							<small>{isFollowUp ? 'UPDATE THE PR' : 'READY FOR REVIEW'}</small>
							<h2 id="publish-title">
								{isFollowUp ? '変更をPRへ追加' : 'Draft PRを作成'}
							</h2>
						</div>
					</div>
					<button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
				</div>
				<div className="publish-summary">
					<div>
						<GitBranch size={16} />
						<span>
							{isFollowUp ? (
								<><b>{session.meta.pullRequestBranch ?? '既存PRブランチ'}</b> へfast-forward</>
							) : (
								<><b>{session.meta.baseBranch}</b> から共同編集ブランチを作成</>
							)}
						</span>
					</div>
					<div><FileCode2 size={16} /><span>Markdown 1件 + 画像 <b>{assets.length}件</b> を1コミット</span></div>
					<div><Users size={16} /><span><b>{session.participants.length}名</b> をCo-authored-byへ追加</span></div>
				</div>
				<div className="publish-author">
					<AtSign size={16} />
					<span>
						<small>COMMIT AUTHOR EMAIL</small>
						<b>{commitEmail ?? '未選択'}</b>
					</span>
					<button onClick={onEmailSettings}>変更</button>
				</div>
				<div className="dialog-form">
					{!isFollowUp && (
						<label>
							<span>PR title</span>
							<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
						</label>
					)}
					<label>
						<span>Commit message</span>
						<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={200} />
					</label>
					{!isFollowUp && (
						<label>
							<span>Description</span>
							<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} />
						</label>
					)}
				</div>
				{assets.length > 0 && (
					<div className="staged-assets">
						<div><span>STAGED ASSETS</span><b>{assets.length}</b></div>
						{assets.map((asset) => (
							<div className="staged-asset" key={asset.id}>
								<img src={asset.previewUrl ?? `/api/sessions/${session.meta.id}/assets/${asset.id}`} alt="" />
								<span><b>{asset.finalPath}</b><small>{formatBytes(asset.size)} · {asset.mimeType}</small></span>
								<Check size={16} />
							</div>
						))}
					</div>
				)}
				{error && (
					<div className="dialog-error">
						<AlertTriangle size={17} />
						<span>{error}</span>
					</div>
				)}
				<div className="dialog-footer">
					<p>
						{isFollowUp
							? '同じPRブランチへforce pushせず追加します。変更がなければコミットしません。'
							: '対象ファイルがGitHub側で変更されている場合は、作成前に停止します。'}
					</p>
					<div>
						<button className="button button-secondary" onClick={onClose} disabled={publishing}>キャンセル</button>
						<button
							className="button button-primary"
							onClick={() => void publish()}
							disabled={
								publishing ||
								(!isFollowUp && !title.trim()) ||
								!commitMessage.trim()
							}
						>
							{publishing ? <LoaderCircle className="spin" size={17} /> : <GitPullRequestArrow size={17} />}
							{publishing
								? 'コミット作成中…'
								: isFollowUp
									? '変更をコミット'
									: 'Draft PRを作成'}
							{!publishing && <ExternalLink size={14} />}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
