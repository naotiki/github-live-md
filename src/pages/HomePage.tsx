import {
	ArrowRight,
	Braces,
	CalendarClock,
	Check,
	ChevronDown,
	Clock3,
	FileCode2,
	GitBranch,
	ImagePlus,
	LockKeyhole,
	LogOut,
	LoaderCircle,
	Mail,
	Sparkles,
	Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Brand } from '../components/Brand'
import { GithubLogo } from '../components/GithubLogo'
import { ApiClientError, client } from '../lib/api'
import type {
	AuthStatus,
	Repository,
	SessionListItem,
	SessionRetentionDays,
} from '../lib/types'

type HomePageProps = {
	auth: AuthStatus
	onAuthChanged: () => void
	onEmailSettings: () => void
}

function initialGuestName(): string {
	return localStorage.getItem('livemd.guestName') ?? 'Markdown explorer'
}

function expiryLabel(expiresAt: string): string {
	return new Intl.DateTimeFormat('ja-JP', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(expiresAt))
}

export function HomePage({ auth, onAuthChanged, onEmailSettings }: HomePageProps) {
	const [repositories, setRepositories] = useState<Repository[]>([])
	const [sessions, setSessions] = useState<SessionListItem[]>([])
	const [repository, setRepository] = useState('')
	const [branches, setBranches] = useState<string[]>([])
	const [branch, setBranch] = useState('')
	const [files, setFiles] = useState<string[]>([])
	const [path, setPath] = useState('')
	const [guestName, setGuestName] = useState(initialGuestName)
	const [retentionDays, setRetentionDays] =
		useState<SessionRetentionDays>(14)
	const [loadingRepos, setLoadingRepos] = useState(false)
	const [loadingSessions, setLoadingSessions] = useState(false)
	const [loadingTarget, setLoadingTarget] = useState(false)
	const [creating, setCreating] = useState<'demo' | 'github' | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!auth.user) return
		setLoadingRepos(true)
		client
			.repositories()
			.then(({ repositories: result }) => {
				setRepositories(result)
				if (result[0]) {
					setRepository(result[0].full_name)
					setBranch(result[0].default_branch)
				}
			})
			.catch((caught: unknown) =>
				setError(caught instanceof Error ? caught.message : 'リポジトリを取得できませんでした'),
			)
			.finally(() => setLoadingRepos(false))
	}, [auth.user])

	useEffect(() => {
		if (!auth.user) {
			setSessions([])
			return
		}
		setLoadingSessions(true)
		client
			.sessions()
			.then(({ sessions: result }) => setSessions(result))
			.catch((caught: unknown) =>
				setError(
					caught instanceof Error
						? caught.message
						: 'セッション一覧を取得できませんでした',
				),
			)
			.finally(() => setLoadingSessions(false))
	}, [auth.user])

	const selectedRepository = useMemo(
		() => repositories.find((item) => item.full_name === repository) ?? null,
		[repositories, repository],
	)

	useEffect(() => {
		if (!auth.user || !repository) return
		setLoadingTarget(true)
		setFiles([])
		const defaultBranch =
			repositories.find((item) => item.full_name === repository)?.default_branch ?? ''
		client
			.branches(repository)
			.then(({ branches: result }) => {
				const names = result.map((item) => item.name)
				setBranches(names)
				setBranch((current) =>
					names.includes(current) ? current : defaultBranch || names[0] || '',
				)
			})
			.catch((caught: unknown) =>
				setError(caught instanceof Error ? caught.message : 'ブランチを取得できませんでした'),
			)
			.finally(() => setLoadingTarget(false))
	}, [auth.user, repositories, repository])

	useEffect(() => {
		if (!auth.user || !repository || !branch) return
		setLoadingTarget(true)
		client
			.markdownFiles(repository, branch)
			.then(({ files: result }) => {
				const paths = result.map((item) => item.path)
				setFiles(paths)
				setPath((current) => current || paths[0] || 'README.md')
			})
			.catch((caught: unknown) =>
				setError(caught instanceof Error ? caught.message : 'Markdownを取得できませんでした'),
			)
			.finally(() => setLoadingTarget(false))
	}, [auth.user, branch, repository])

	const createDemo = async () => {
		setCreating('demo')
		setError(null)
		localStorage.setItem('livemd.guestName', guestName.trim() || 'Markdown explorer')
		try {
			const { session } = await client.createDemoSession(guestName, 14)
			window.location.assign(`/session/${session.id}`)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'デモを開始できませんでした')
			setCreating(null)
		}
	}

	const createGitHub = async () => {
		if (!repository || !branch || !path.trim()) return
		setCreating('github')
		setError(null)
		try {
			const { session } = await client.createGitHubSession(
				repository,
				branch,
				path.trim(),
				retentionDays,
			)
			window.location.assign(`/session/${session.id}`)
		} catch (caught) {
			setError(
				caught instanceof ApiClientError
					? caught.message
					: '共同編集セッションを開始できませんでした',
			)
			setCreating(null)
		}
	}

	const logout = async () => {
		await client.logout()
		onAuthChanged()
	}

	return (
		<div className="site-shell">
			<header className="site-header">
				<Brand />
				<nav className="site-nav" aria-label="Primary navigation">
					<a href="#workflow">仕組み</a>
					<a href="#security">セキュリティ</a>
					{auth.user ? (
						<div className="account-actions">
							<button
								className="user-chip"
								onClick={onEmailSettings}
								title={auth.commitEmail ?? 'コミット用メールを選択'}
							>
								<img src={auth.user.avatar_url} alt="" />
								<span>{auth.user.login}</span>
								<Mail size={13} />
							</button>
							<button
								className="account-logout"
								onClick={() => void logout()}
								aria-label="ログアウト"
								title="ログアウト"
							>
								<LogOut size={14} />
							</button>
						</div>
					) : auth.configured ? (
						<a className="nav-github" href="/api/auth/github/start">
							<GithubLogo size={16} />
							Sign in
						</a>
					) : (
						<span className="nav-local">Local demo</span>
					)}
				</nav>
			</header>

			<main>
				<section className="hero-section">
					<div className="hero-copy">
						<div className="eyebrow">
							<span className="pulse-dot" />
							Markdown collaboration, built for GitHub
						</div>
						<h1>
							書く時間は一緒に。
							<br />
							<span>履歴はGitHubに。</span>
						</h1>
						<p className="hero-lead">
							ひとつのMarkdownをリアルタイムで共同編集。画像もまとめて、
							<br className="desktop-only" />
							編集者連名のコミットとDraft PRにします。
						</p>
						<div className="hero-actions">
							{auth.user ? (
								<a className="button button-primary" href="#start">
									セッションを作る
									<ArrowRight size={17} />
								</a>
							) : auth.configured ? (
								<a className="button button-primary" href="/api/auth/github/start">
									<GithubLogo size={18} />
									GitHubで始める
								</a>
							) : (
								<button className="button button-muted" disabled>
									GitHub Appは未設定
								</button>
							)}
							<button
								className="button button-secondary"
								onClick={() => void createDemo()}
								disabled={creating !== null}
							>
								<Sparkles size={17} />
								{creating === 'demo' ? '準備中…' : 'デモを試す'}
							</button>
						</div>
						<div className="hero-proof">
							<span><Check size={14} /> Yjs CRDT</span>
							<span><Check size={14} /> Durable Objects</span>
							<span><Check size={14} /> Commit history / Draft PR</span>
						</div>
					</div>

					<div className="product-shot" aria-label="Product preview">
						<div className="shot-window">
							<div className="shot-titlebar">
								<div className="window-dots"><i /><i /><i /></div>
								<div className="shot-path">
									<FileCode2 size={13} />
									writeups / tsukuCTF-2026.md
								</div>
								<div className="shot-avatars">
									<span className="avatar avatar-green">N</span>
									<span className="avatar avatar-purple">M</span>
									<span className="avatar-more">+2</span>
								</div>
							</div>
							<div className="shot-toolbar">
								<span className="active">EDIT</span>
								<span>PREVIEW</span>
								<span className="shot-live"><i /> 4 LIVE</span>
							</div>
							<div className="shot-body">
								<div className="shot-code">
									<div><b>1</b><span className="token-dim">---</span></div>
									<div><b>2</b><span className="token-key">title:</span> <span className="token-string">"Cache of Castaways"</span></div>
									<div><b>3</b><span className="token-key">category:</span> Web</div>
									<div><b>4</b><span className="token-dim">---</span></div>
									<div><b>5</b></div>
									<div><b>6</b><span className="token-heading"># Challenge overview</span></div>
									<div><b>7</b></div>
									<div className="cursor-line">
										<b>8</b>The cache key ignores the <span className="selection">Origin header</span>.
										<i className="remote-caret" />
										<em>m01n</em>
									</div>
									<div><b>9</b></div>
									<div><b>10</b><span className="token-code">```http</span></div>
									<div><b>11</b>GET /flag HTTP/1.1</div>
									<div><b>12</b><span className="token-code">```</span></div>
								</div>
								<div className="shot-preview">
									<span className="preview-kicker">WEB · WRITEUP</span>
									<h3>Challenge overview</h3>
									<p>The cache key ignores the <mark>Origin header</mark>.</p>
									<div className="preview-code">GET /flag HTTP/1.1</div>
								</div>
							</div>
							<div className="shot-status">
								<span><i /> Saved to edge</span>
								<span>UTF-8&nbsp;&nbsp; · &nbsp;&nbsp;Markdown</span>
							</div>
						</div>
						<div className="floating-card float-pr">
							<span className="float-icon"><GitBranch size={17} /></span>
							<div><b>Draft PR ready</b><small>1 commit · 4 authors</small></div>
							<Check size={16} />
						</div>
						<div className="floating-card float-image">
							<span className="float-icon purple"><ImagePlus size={17} /></span>
							<div><b>exploit-flow.png</b><small>Staged for commit</small></div>
						</div>
					</div>
				</section>

				{auth.user && (
					<section className="sessions-section" aria-labelledby="sessions-title">
						<div className="sessions-heading">
							<div>
								<span>YOUR SESSIONS</span>
								<h2 id="sessions-title">自分のセッション</h2>
								<p>同じ対象をもう一度開くと、既存セッションへ戻ります。</p>
							</div>
							<a className="button button-secondary" href="#start">
								新しいセッション
								<ArrowRight size={16} />
							</a>
						</div>
						{loadingSessions ? (
							<div className="sessions-loading">
								<LoaderCircle className="spin" size={20} />
								セッションを読み込んでいます…
							</div>
						) : sessions.length ? (
							<div className="sessions-grid">
								{sessions.map((session) => (
									<a
										className="session-list-card"
										href={`/session/${session.id}`}
										key={session.id}
									>
										<div className="session-list-top">
											<span className={`session-state ${session.status}`}>
												{session.status === 'editing' ? 'EDITING' : 'PUBLISHED'}
											</span>
											<span>
												<Clock3 size={14} />
												{expiryLabel(session.expiresAt)}まで
											</span>
										</div>
										<b>{session.documentPath}</b>
										<small>
											{session.repository} · {session.baseBranch}
										</small>
										<div className="session-list-footer">
											<span>
												{session.accessPolicy === 'write'
													? 'write権限限定'
													: 'リンク参加'}
											</span>
											{session.pullRequestUrl ? (
												<span>PRへ追記 <ArrowRight size={13} /></span>
											) : (
												<span>編集を続ける <ArrowRight size={13} /></span>
											)}
										</div>
									</a>
								))}
							</div>
						) : (
							<div className="sessions-empty">
								<CalendarClock size={25} />
								<div>
									<b>セッションはまだありません</b>
									<p>GitHubのMarkdownを選ぶと、ここから再開できます。</p>
								</div>
							</div>
						)}
					</section>
				)}

				<section className="start-section" id="start">
					<div className="section-heading">
						<span>START A SESSION</span>
						<h2>リポジトリから、編集する1ファイルを選ぶ。</h2>
						<p>
							既存のMarkdownを選ぶか、
							GitHubのファイルURLの <code>github.com</code> を
							このサイトのドメインへ置き換えて直接開けます。
						</p>
					</div>

					<div className="start-grid">
						<div className="session-card">
							<div className="card-heading">
								<span className="step-number">01</span>
								<div><h3>GitHub source</h3><p>Appが利用でき、自分にwrite権限があるリポジトリだけ表示します。</p></div>
							</div>
							{auth.user ? (
								<div className="source-form">
									<label>
										<span>Repository</span>
										<div className="select-wrap">
											<select
												value={repository}
												onChange={(event) => {
													setRepository(event.target.value)
													setPath('')
												}}
												disabled={loadingRepos}
											>
												{repositories.map((item) => (
													<option key={item.id} value={item.full_name}>
														{item.full_name}{item.private ? ' · private' : ''}
													</option>
												))}
											</select>
											<ChevronDown size={15} />
										</div>
									</label>
									<div className="form-row">
										<label>
											<span>Base branch</span>
											<div className="select-wrap">
												<GitBranch size={15} className="field-icon" />
												<select value={branch} onChange={(event) => setBranch(event.target.value)}>
													{branches.map((item) => <option key={item}>{item}</option>)}
												</select>
												<ChevronDown size={15} />
											</div>
										</label>
										<label>
											<span>Markdown path</span>
											<input
												list="markdown-paths"
												value={path}
												onChange={(event) => setPath(event.target.value)}
												placeholder="writeups/new-post.md"
											/>
											<datalist id="markdown-paths">
												{files.map((item) => <option key={item} value={item} />)}
											</datalist>
										</label>
									</div>
									<div className="source-summary">
										<img src={selectedRepository?.owner.avatar_url} alt="" />
										<div>
											<b>{path || 'Markdown path'}</b>
											<small>{repository} · {branch}</small>
										</div>
										{loadingTarget ? <span className="mini-spinner" /> : <Check size={17} />}
									</div>
									<label className="retention-field">
										<span>Session retention</span>
										<div className="select-wrap">
											<CalendarClock size={15} className="field-icon" />
											<select
												value={retentionDays}
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
											<ChevronDown size={15} />
										</div>
									</label>
									<button
										className="button button-primary button-full"
										onClick={() => void createGitHub()}
										disabled={!repository || !branch || !path.trim() || creating !== null}
									>
										{creating === 'github' ? '読み込み中…' : '共同編集を開始'}
										<ArrowRight size={17} />
									</button>
								</div>
							) : (
								<div className="auth-empty">
									<span className="large-github"><GithubLogo size={30} /></span>
									<h3>GitHubに接続</h3>
									<p>リポジトリとMarkdownを選ぶため、GitHub Appでログインします。</p>
									{auth.configured ? (
										<a className="button button-primary button-full" href="/api/auth/github/start">
											<GithubLogo size={17} />
											GitHubでログイン
										</a>
									) : (
										<div className="config-notice">
											<Braces size={17} />
											<code>.dev.vars</code> にGitHub App設定を追加してください
										</div>
									)}
								</div>
							)}
						</div>

						<div className="demo-card">
							<div className="demo-card-top">
								<span className="step-number inverted">00</span>
								<span className="demo-pill">NO LOGIN</span>
							</div>
							<h3>まず共同編集だけ試す</h3>
							<p>GitHubへの書き込みなしで、別タブとのリアルタイム同期を確認できます。</p>
							<label>
								<span>表示名</span>
								<input
									value={guestName}
									onChange={(event) => setGuestName(event.target.value)}
									maxLength={50}
								/>
							</label>
							<div className="demo-users">
								<div className="stacked-avatars">
									<span className="avatar avatar-green">Y</span>
									<span className="avatar avatar-purple">C</span>
									<span className="avatar avatar-orange">R</span>
								</div>
								<span>共有リンクを開くだけで参加</span>
							</div>
							<button
								className="button button-light button-full"
								onClick={() => void createDemo()}
								disabled={creating !== null}
							>
								<Sparkles size={17} />
								{creating === 'demo' ? 'セッション準備中…' : 'デモセッションを作る'}
							</button>
						</div>
					</div>
					{error && <div className="inline-error" role="alert">{error}</div>}
				</section>

				<section className="workflow-section" id="workflow">
					<div className="section-heading compact">
						<span>ONE FOCUSED WORKFLOW</span>
						<h2>エディタからPRまで、寄り道なし。</h2>
					</div>
					<div className="feature-grid">
						<div className="feature-card">
							<span className="feature-icon"><Users size={20} /></span>
							<small>01 · COLLABORATE</small>
							<h3>カーソルまでリアルタイム</h3>
							<p>YjsのCRDTで同時入力と再接続を処理。1セッションを1つのDurable Objectが調整します。</p>
						</div>
						<div className="feature-card">
							<span className="feature-icon"><ImagePlus size={20} /></span>
							<small>02 · STAGE ASSETS</small>
							<h3>画像もその場でプレビュー</h3>
							<p>画像はR2へ仮置き。最終的な相対パスを本文へ挿入するので、確定時の書き換えは不要です。</p>
						</div>
						<div className="feature-card">
							<span className="feature-icon"><GitBranch size={20} /></span>
							<small>03 · SHIP</small>
							<h3>全員の名前で1コミット</h3>
							<p>本文と画像から1つのGit treeを作成。Co-authored-by付きのDraft PRとしてレビューへ渡します。</p>
						</div>
					</div>
				</section>

				<section className="security-strip" id="security">
					<div>
						<span className="security-icon"><LockKeyhole size={21} /></span>
						<div><b>GitHub stays the source of truth.</b><p>アクセスはGitHub Appをインストールしたリポジトリに限定。非公開リポジトリは参加者ごとに権限を確認します。</p></div>
					</div>
					<a href="https://docs.github.com/en/apps" target="_blank" rel="noreferrer">
						GitHub Appについて <ArrowRight size={15} />
					</a>
				</section>
			</main>

			<footer className="site-footer">
				<Brand />
				<span>Built on Cloudflare&apos;s edge.</span>
				<span>Markdown in. Pull request out.</span>
			</footer>
		</div>
	)
}
