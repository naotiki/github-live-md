import { LoaderCircle } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import './App.css'
import { Brand } from './components/Brand'
import { CommitEmailDialog } from './components/CommitEmailDialog'
import { client } from './lib/api'
import { parseGitHubQuickTarget } from './lib/githubUrl'
import type { AuthStatus } from './lib/types'
import { HomePage } from './pages/HomePage'
import { QuickStartPage } from './pages/QuickStartPage'

const SessionPage = lazy(() =>
	import('./pages/SessionPage').then((module) => ({ default: module.SessionPage })),
)

const EMPTY_AUTH: AuthStatus = {
	configured: false,
	user: null,
	appSlug: null,
	commitEmail: null,
}

function App() {
	const [auth, setAuth] = useState<AuthStatus>(EMPTY_AUTH)
	const [loading, setLoading] = useState(true)
	const [emailPickerOpen, setEmailPickerOpen] = useState(false)

	const refreshAuth = useCallback(() => {
		setLoading(true)
		client
			.authStatus()
			.then(setAuth)
			.catch(() => setAuth(EMPTY_AUTH))
			.finally(() => setLoading(false))
	}, [])

	useEffect(() => refreshAuth(), [refreshAuth])

	let page
	if (loading) {
		page = (
			<div className="app-loading">
				<Brand />
				<LoaderCircle className="spin" size={24} />
			</div>
		)
	} else {
		const sessionMatch = window.location.pathname.match(
			/^\/session\/([0-9a-f-]+)\/?$/i,
		)
		if (sessionMatch) {
			page = (
				<Suspense
					fallback={
						<div className="session-loading">
							<Brand />
							<LoaderCircle className="spin" size={28} />
							<p>エディタを読み込んでいます…</p>
						</div>
					}
				>
					<SessionPage
						sessionId={sessionMatch[1]}
						auth={auth}
						onEmailSettings={() => setEmailPickerOpen(true)}
					/>
				</Suspense>
			)
		} else {
			const quickTarget = parseGitHubQuickTarget(window.location.pathname)
			page = (
				quickTarget ? (
					<QuickStartPage auth={auth} target={quickTarget} />
				) : (
					<HomePage
						auth={auth}
						onAuthChanged={refreshAuth}
						onEmailSettings={() => setEmailPickerOpen(true)}
					/>
				)
			)
		}
	}

	const mustChooseEmail = Boolean(auth.user && !auth.commitEmail)

	return (
		<>
			{page}
			{auth.user && (mustChooseEmail || emailPickerOpen) && (
				<CommitEmailDialog
					user={auth.user}
					currentEmail={auth.commitEmail}
					required={mustChooseEmail}
					onClose={() => setEmailPickerOpen(false)}
					onSelected={(commitEmail) => {
						setAuth((current) => ({ ...current, commitEmail }))
						setEmailPickerOpen(false)
					}}
				/>
			)}
		</>
	)
}

export default App
