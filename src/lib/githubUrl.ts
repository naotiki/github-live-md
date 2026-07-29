export type GitHubQuickTarget = {
	repository: string
	refAndPath: string
}

export function parseGitHubQuickTarget(
	pathname: string,
): GitHubQuickTarget | null {
	const segments = pathname
		.split('/')
		.filter(Boolean)
		.map((part) => {
			try {
				return decodeURIComponent(part)
			} catch {
				return part
			}
		})
	if (segments.length < 5 || segments[2] !== 'blob') return null
	const [owner, repository, , ...refAndPath] = segments
	if (!owner || !repository || refAndPath.length < 2) return null
	return {
		repository: `${owner}/${repository}`,
		refAndPath: refAndPath.join('/'),
	}
}
