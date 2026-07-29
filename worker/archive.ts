import { App } from 'octokit'
import {
	ApiError,
	arrayBufferToBase64,
	encodeGitHubPath,
	githubNoReplyEmail,
	githubRequest,
} from './github.js'
import type { AppEnv, SessionExport } from './types.js'

type GitHubRef = {
	object: { sha: string }
}

type GitHubCommit = {
	sha: string
	tree: { sha: string }
}

function cleanText(value: string, fallback: string, maxLength: number): string {
	const cleaned = [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0
			return codePoint < 32 || codePoint === 127 ? ' ' : character
		})
		.join('')
		.trim()
	return cleaned.slice(0, maxLength) || fallback
}

function branchSlug(path: string): string {
	const file = path.split('/').pop()?.replace(/\.md$/i, '') ?? 'document'
	return (
		file
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 36) || 'document'
	)
}

export function isAutomaticArchiveConfigured(env: AppEnv): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY)
}

async function installationToken(
	env: AppEnv,
	repository: string,
): Promise<string> {
	if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
		throw new ApiError(
			'Automatic archive requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY',
			503,
		)
	}
	const [owner, repo] = repository.split('/')
	const app = new App({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
	})
	const installation = await app.octokit.request(
		'GET /repos/{owner}/{repo}/installation',
		{ owner, repo },
	)
	const token = await app.octokit.request(
		'POST /app/installations/{installation_id}/access_tokens',
		{
			installation_id: installation.data.id,
			repositories: [repo],
			permissions: { contents: 'write' },
		},
	)
	return token.data.token
}

async function branchTip(
	token: string,
	repository: string,
	branch: string,
): Promise<{ commitSha: string; treeSha: string }> {
	const gitRef = await githubRequest<GitHubRef>(
		token,
		`/repos/${repository}/git/ref/heads/${encodeGitHubPath(branch)}`,
	)
	const commit = await githubRequest<GitHubCommit>(
		token,
		`/repos/${repository}/git/commits/${gitRef.object.sha}`,
	)
	return { commitSha: gitRef.object.sha, treeSha: commit.tree.sha }
}

export async function archiveExpiredSession(
	env: AppEnv,
	session: SessionExport,
): Promise<{ branch: string; branchUrl: string; commitSha: string }> {
	const { meta } = session
	if (meta.demo || !meta.repository || !meta.baseBranch) {
		throw new ApiError('Demo sessions do not have a GitHub archive branch', 400)
	}
	const token = await installationToken(env, meta.repository)
	const continuePullRequest =
		meta.status === 'published' && Boolean(meta.pullRequestBranch)
	const branch = continuePullRequest
		? meta.pullRequestBranch!
		: `collab/archive-${branchSlug(meta.documentPath)}-${meta.id.slice(0, 8)}`
	const branchUrl = `https://github.com/${meta.repository}/tree/${encodeURIComponent(branch)}`

	if (!continuePullRequest) {
		try {
			const existing = await githubRequest<GitHubRef>(
				token,
				`/repos/${meta.repository}/git/ref/heads/${encodeGitHubPath(branch)}`,
			)
			return { branch, branchUrl, commitSha: existing.object.sha }
		} catch (error) {
			if (!(error instanceof ApiError && error.status === 404)) throw error
		}
	}

	const { commitSha: latestCommitSha, treeSha: latestTreeSha } = await branchTip(
		token,
		meta.repository,
		continuePullRequest ? branch : meta.baseBranch,
	)
	const markdownBlob = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/blobs`,
		{
			method: 'POST',
			body: JSON.stringify({ content: session.markdown, encoding: 'utf-8' }),
		},
	)
	const assetBlobs = await Promise.all(
		session.assets.map(async (asset) => {
			const object = await env.ASSET_BUCKET.get(asset.r2Key)
			if (!object) {
				throw new ApiError(`Missing staged image: ${asset.originalName}`, 500)
			}
			const blob = await githubRequest<{ sha: string }>(
				token,
				`/repos/${meta.repository}/git/blobs`,
				{
					method: 'POST',
					body: JSON.stringify({
						content: arrayBufferToBase64(await object.arrayBuffer()),
						encoding: 'base64',
					}),
				},
			)
			return { asset, sha: blob.sha }
		}),
	)
	const tree = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/trees`,
		{
			method: 'POST',
			body: JSON.stringify({
				base_tree: latestTreeSha,
				tree: [
					{
						path: meta.documentPath,
						mode: '100644',
						type: 'blob',
						sha: markdownBlob.sha,
					},
					...assetBlobs.map(({ asset, sha }) => ({
						path: asset.finalPath,
						mode: '100644',
						type: 'blob',
						sha,
					})),
					...meta.publishedAssetPaths
						.filter(
							(path) =>
								!session.assets.some((asset) => asset.finalPath === path),
						)
						.map((path) => ({
							path,
							mode: '100644',
							type: 'blob',
							sha: null,
						})),
				],
			}),
		},
	)
	if (continuePullRequest && tree.sha === latestTreeSha) {
		return { branch, branchUrl, commitSha: latestCommitSha }
	}
	const authorParticipant = session.participants.find(
		(participant) => participant.id === meta.createdBy.id,
	)
	const coAuthors = session.participants
		.filter(
			(participant) =>
				participant.id !== null &&
				participant.id !== meta.createdBy.id,
		)
		.map(
			(participant) =>
				`Co-authored-by: ${cleanText(participant.name, participant.login, 100)} <${participant.commitEmail ?? githubNoReplyEmail({ id: participant.id!, login: participant.login })}>`,
		)
	const commit = await githubRequest<{ sha: string }>(
		token,
		`/repos/${meta.repository}/git/commits`,
		{
			method: 'POST',
			body: JSON.stringify({
				message: [
					continuePullRequest
						? `docs: save final LiveMD changes for ${meta.documentPath}`
						: `chore: archive expired LiveMD session for ${meta.documentPath}`,
					'',
					`Session: ${meta.id}`,
					'The editing session reached its retention limit.',
					...(coAuthors.length ? ['', ...coAuthors] : []),
				].join('\n'),
				tree: tree.sha,
				parents: [latestCommitSha],
				author:
					meta.createdBy.id === null
						? undefined
						: {
								name: cleanText(
									meta.createdBy.name,
									meta.createdBy.login,
									100,
								),
								email:
									authorParticipant?.commitEmail ??
									githubNoReplyEmail({
										id: meta.createdBy.id,
										login: meta.createdBy.login,
									}),
								date: new Date().toISOString(),
							},
			}),
		},
	)
	if (continuePullRequest) {
		await githubRequest(
			token,
			`/repos/${meta.repository}/git/refs/heads/${encodeGitHubPath(branch)}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ sha: commit.sha, force: false }),
			},
		)
	} else {
		await githubRequest(token, `/repos/${meta.repository}/git/refs`, {
			method: 'POST',
			body: JSON.stringify({
				ref: `refs/heads/${branch}`,
				sha: commit.sha,
			}),
		})
	}
	return { branch, branchUrl, commitSha: commit.sha }
}
