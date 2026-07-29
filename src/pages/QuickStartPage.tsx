import {
	AlertTriangle,
	ArrowRight,
	FileCode2,
	LoaderCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Brand } from '../components/Brand'
import { GithubLogo } from '../components/GithubLogo'
import { client } from '../lib/api'
import type { GitHubQuickTarget } from '../lib/githubUrl'
import type { AuthStatus } from '../lib/types'

type QuickStartPageProps = {
	auth: AuthStatus
	target: GitHubQuickTarget
}

function loginUrl(): string {
	const returnTo = `${window.location.pathname}${window.location.search}`
	return `/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`
}

export function QuickStartPage({ auth, target }: QuickStartPageProps) {
	const started = useRef(false)
	const [stage, setStage] = useState('GitHubへの接続を確認しています…')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (auth.user || !auth.configured || started.current) return
		started.current = true
		window.location.assign(loginUrl())
	}, [auth.configured, auth.user])

	useEffect(() => {
		if (!auth.user || !auth.commitEmail || started.current) return
		started.current = true
		setError(null)
		setStage('ブランチとMarkdownを確認しています…')

		void client
			.branches(target.repository)
			.then(({ branches }) => {
				const branch = branches
					.map((item) => item.name)
					.sort((left, right) => right.length - left.length)
					.find(
						(name) =>
							target.refAndPath === name ||
							target.refAndPath.startsWith(`${name}/`),
					)
				if (!branch) {
					throw new Error('GitHub URLのブランチを解決できませんでした')
				}
				const path = target.refAndPath.slice(branch.length + 1)
				if (!path.toLowerCase().endsWith('.md')) {
					throw new Error('共同編集できるURLはMarkdownファイル（.md）のみです')
				}
				setStage(`${target.repository}/${path} を読み込んでいます…`)
				return client.createGitHubSession(target.repository, branch, path)
			})
			.then(({ session }) => window.location.replace(`/session/${session.id}`))
			.catch((caught: unknown) => {
				setError(
					caught instanceof Error
						? caught.message
						: '共同編集セッションを開始できませんでした',
				)
			})
	}, [auth.commitEmail, auth.user, target.refAndPath, target.repository])

	return (
		<div className="quick-start-page">
			<Brand />
			<div className="quick-start-card">
				<span className="quick-start-icon">
					{error ? <AlertTriangle size={26} /> : <GithubLogo size={26} />}
				</span>
				<small>OPEN FROM GITHUB URL</small>
				<h1>{error ? 'セッションを開始できません' : 'Markdownを共同編集で開く'}</h1>
				<div className="quick-target">
					<FileCode2 size={18} />
					<span>
						<b>{target.repository}</b>
						<code>{target.refAndPath}</code>
					</span>
				</div>
				{error ? (
					<>
						<p className="quick-start-error">{error}</p>
						<div className="quick-start-actions">
							<a className="button button-secondary" href="/">ホームへ戻る</a>
							<a
								className="button button-primary"
								href={`https://github.com/${target.repository}/blob/${target.refAndPath}`}
								target="_blank"
								rel="noreferrer"
							>
								GitHubで確認
								<ArrowRight size={16} />
							</a>
						</div>
					</>
				) : !auth.configured ? (
					<p className="quick-start-error">GitHub Appが設定されていません。</p>
				) : !auth.user ? (
					<>
						<LoaderCircle className="spin" size={22} />
						<p>GitHubログインへ移動しています…</p>
						<a className="button button-primary" href={loginUrl()}>
							GitHubでログイン
						</a>
					</>
				) : !auth.commitEmail ? (
					<>
						<LoaderCircle className="spin" size={22} />
						<p>コミット用メールを選択してください。</p>
					</>
				) : (
					<>
						<LoaderCircle className="spin" size={22} />
						<p>{stage}</p>
					</>
				)}
			</div>
		</div>
	)
}
