import { GitPullRequestArrow } from 'lucide-react'

export function Brand() {
	return (
		<a className="brand" href="/" aria-label="GitHub Live MD home">
			<span className="brand-mark">
				<GitPullRequestArrow size={18} strokeWidth={2.4} />
			</span>
			<span>LiveMD</span>
			<span className="brand-beta">beta</span>
		</a>
	)
}
