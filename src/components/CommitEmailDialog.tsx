import {
	AlertTriangle,
	AtSign,
	Check,
	LoaderCircle,
	LockKeyhole,
	X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { client } from '../lib/api'
import type { CommitEmailOption, GitHubUser } from '../lib/types'

type CommitEmailDialogProps = {
	user: GitHubUser
	currentEmail: string | null
	required: boolean
	onClose: () => void
	onSelected: (email: string) => void
}

export function CommitEmailDialog({
	user,
	currentEmail,
	required,
	onClose,
	onSelected,
}: CommitEmailDialogProps) {
	const [emails, setEmails] = useState<CommitEmailOption[]>([])
	const [selected, setSelected] = useState(currentEmail ?? '')
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setLoading(true)
		setError(null)
		client
			.commitEmails()
			.then((result) => {
				setEmails(result.emails)
				const available = new Set(
					result.emails.map((option) => option.email.toLowerCase()),
				)
				const preferred =
					[result.selected, currentEmail].find(
						(value) => value && available.has(value.toLowerCase()),
					) ??
					result.emails.find((option) => option.recommended)?.email ??
					result.emails.find((option) => option.primary)?.email ??
					result.emails[0]?.email ??
					''
				setSelected(preferred)
			})
			.catch((caught: unknown) =>
				setError(
					caught instanceof Error
						? caught.message
						: 'メールアドレスを取得できませんでした',
				),
			)
			.finally(() => setLoading(false))
	}, [currentEmail])

	const save = async () => {
		if (!selected) return
		setSaving(true)
		setError(null)
		try {
			const result = await client.selectCommitEmail(selected)
			onSelected(result.selected)
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: 'メールアドレスを保存できませんでした',
			)
			setSaving(false)
		}
	}

	return (
		<div
			className="modal-backdrop"
			role="presentation"
			onMouseDown={required ? undefined : onClose}
		>
			<div
				className="publish-dialog email-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="commit-email-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="dialog-header">
					<div>
						<span className="dialog-icon"><AtSign size={20} /></span>
						<div>
							<small>{required ? 'FIRST-TIME SETUP' : 'COMMIT IDENTITY'}</small>
							<h2 id="commit-email-title">コミット用メールを選択</h2>
						</div>
					</div>
					{!required && (
						<button className="icon-button" onClick={onClose} aria-label="閉じる">
							<X size={18} />
						</button>
					)}
				</div>

				<div className="email-dialog-intro">
					<img src={user.avatar_url} alt="" />
					<div>
						<b>{user.name?.trim() || user.login}</b>
						<span>@{user.login}</span>
					</div>
					<p>
						このメールはコミット作者と
						<code>Co-authored-by</code>に使われます。
					</p>
				</div>

				{loading ? (
					<div className="email-dialog-loading">
						<LoaderCircle className="spin" size={22} />
						<span>GitHubから検証済みメールを取得中…</span>
					</div>
				) : (
					<div className="email-options" role="radiogroup" aria-label="コミット用メール">
						{emails.map((option) => (
							<label
								key={option.email}
								className={selected === option.email ? 'selected' : ''}
							>
								<input
									type="radio"
									name="commit-email"
									value={option.email}
									checked={selected === option.email}
									onChange={() => setSelected(option.email)}
								/>
								<span className="email-radio">
									{selected === option.email && <Check size={13} />}
								</span>
								<span className="email-option-copy">
									<b>{option.email}</b>
									<small>
										{option.kind === 'noreply'
											? 'GitHubの非公開用アドレス'
											: option.primary
												? 'GitHubのプライマリメール'
												: 'GitHubで検証済み'}
									</small>
								</span>
								<span className={`email-badge ${option.kind}`}>
									{option.recommended ? '推奨' : option.visibility ?? 'private'}
								</span>
							</label>
						))}
					</div>
				)}

				<div className="email-privacy-note">
					<LockKeyhole size={16} />
					<p>
						個人メールを選ぶと公開リポジトリのコミット履歴にも表示されます。
						迷う場合はGitHubのno-replyアドレスが安全です。
					</p>
				</div>

				{error && (
					<div className="dialog-error">
						<AlertTriangle size={17} />
						<span>{error}</span>
					</div>
				)}

				<div className="dialog-footer">
					<p>選択はこのブラウザに保存され、設定からいつでも変更できます。</p>
					<div>
						{!required && (
							<button className="button button-secondary" onClick={onClose} disabled={saving}>
								キャンセル
							</button>
						)}
						<button
							className="button button-primary"
							onClick={() => void save()}
							disabled={loading || saving || !selected}
						>
							{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
							{saving ? '保存中…' : 'このメールを使う'}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
